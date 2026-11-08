"""Pass 1 of the Python reader: a definition index over every file, plus the import and symbol resolver pass 2 uses."""
import ast
import os
import re

from py_rules import BUILTINS, dotted, type_names, const_str, is_label

ENUM_BASE = re.compile(r'(?:^|\.)(?:Int|Str)?(?:Enum|Flag)$|IntFlag$')
MAIN_NAMES = {'__main__'}


class ClassInfo:
    __slots__ = ('qual', 'name', 'line', 'end', 'bases', 'methods', 'attrs', 'is_enum', 'attr_funcs')

    def __init__(self, qual, name, node):
        self.qual, self.name, self.line, self.end = qual, name, node.lineno, node.end_lineno
        self.bases = [dotted(b) for b in node.bases if dotted(b)]
        self.methods, self.attrs, self.is_enum, self.attr_funcs = {}, {}, False, {}


class ModInfo:
    def __init__(self, path):
        self.path = path
        self.dir = os.path.dirname(path)
        self.is_init = os.path.basename(path) == '__init__.py'
        self.funcs = {}        # qual -> def line (methods and nested functions included)
        self.top_funcs = set()
        self.classes = {}      # qual -> ClassInfo
        self.top_classes = set()
        self.raw_imports = []  # ast nodes at module level
        self.binds = {}        # alias -> ('mod', path) | ('sym', path, name) | ('ext', top)
        self.stars = []
        self.vars = {}         # module-level NAME -> type expression text (NAME = Cls(...))
        self.all = None


class Def:
    __slots__ = ('kind', 'qual', 'node', 'cls', 'parent')

    def __init__(self, kind, qual, node, cls, parent):
        self.kind, self.qual, self.node, self.cls, self.parent = kind, qual, node, cls, parent


def collect_defs(tree):
    """Every function and class in source order with unique qualnames. `cls` is the class a `self` refers to."""
    out, seen = [], {}

    def uniq(q):
        n = seen.get(q, 0) + 1
        seen[q] = n
        return q if n == 1 else '%s~%d' % (q, n)

    def walk(stmts, prefix, cls, parent):
        for s in stmts:
            if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
                q = uniq(prefix + s.name)
                out.append(Def('func', q, s, cls, parent))
                walk(s.body, q + '.', cls, q)
            elif isinstance(s, ast.ClassDef):
                q = uniq(prefix + s.name)
                out.append(Def('class', q, s, cls, parent))
                walk(s.body, q + '.', q, parent)
            else:
                for field in ('body', 'orelse', 'finalbody'):
                    sub = getattr(s, field, None)
                    if isinstance(sub, list) and sub and isinstance(sub[0], ast.stmt):
                        walk(sub, prefix, cls, parent)
                for h in getattr(s, 'handlers', []) or []:
                    walk(h.body, prefix, cls, parent)
                for c in getattr(s, 'cases', []) or []:
                    walk(c.body, prefix, cls, parent)
    walk(tree.body, '', None, None)
    return out


def _import_nodes(stmts):
    """Module-level imports, including those under if/try (TYPE_CHECKING, optional deps)."""
    for s in stmts:
        if isinstance(s, (ast.Import, ast.ImportFrom)):
            yield s
        elif isinstance(s, (ast.If, ast.Try, ast.With)):
            for field in ('body', 'orelse', 'finalbody'):
                sub = getattr(s, field, None)
                if isinstance(sub, list):
                    yield from _import_nodes(sub)
            for h in getattr(s, 'handlers', []) or []:
                yield from _import_nodes(h.body)


def build_modinfo(path, tree):
    mi = ModInfo(path)
    defs = collect_defs(tree)
    for d in defs:
        if d.kind == 'func':
            mi.funcs[d.qual] = d.node.lineno
            if '.' not in d.qual:
                mi.top_funcs.add(d.qual)
        else:
            ci = ClassInfo(d.qual, d.node.name, d.node)
            ci.is_enum = any(ENUM_BASE.search(b or '') for b in ci.bases)
            mi.classes[d.qual] = ci
            if '.' not in d.qual:
                mi.top_classes.add(d.qual)
    for d in defs:
        if d.kind == 'func' and d.cls and d.cls in mi.classes and d.qual.rsplit('.', 1)[0] == d.cls:
            mi.classes[d.cls].methods[d.node.name] = d.qual
    for d in defs:
        if d.kind == 'class':
            _class_attrs(mi.classes[d.qual], d.node, defs)
    mi.raw_imports = list(_import_nodes(tree.body))
    for s in tree.body:
        if isinstance(s, ast.Assign) and isinstance(s.value, ast.Call) and dotted(s.value.func):
            for t in s.targets:
                if isinstance(t, ast.Name):
                    mi.vars[t.id] = dotted(s.value.func)
        elif isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name):
            names = type_names(s.annotation)
            if names:
                mi.vars[s.target.id] = names[0]
        elif isinstance(s, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '__all__' for t in s.targets):
            if isinstance(s.value, (ast.List, ast.Tuple)):
                mi.all = [const_str(e) for e in s.value.elts if const_str(e)]
    return mi


def _class_attrs(ci, cnode, defs):
    """Types of self attributes: class-body annotations, self.x = Cls(...), self.x = param (annotated)."""
    for s in cnode.body:
        if isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name):
            _add(ci, s.target.id, type_names(s.annotation))
    for d in defs:
        if d.kind != 'func' or d.cls != ci.qual or d.qual.rsplit('.', 1)[0] != ci.qual:
            continue
        ann, pdef = {}, {}
        for a in d.node.args.args + d.node.args.kwonlyargs:
            if a.annotation is not None:
                ann[a.arg] = type_names(a.annotation)
        pos = d.node.args.posonlyargs + d.node.args.args
        for a, dv in zip(pos[len(pos) - len(d.node.args.defaults):], d.node.args.defaults):
            if dotted(dv):
                pdef[a.arg] = dotted(dv)
        for a, dv in zip(d.node.args.kwonlyargs, d.node.args.kw_defaults):
            if dv is not None and dotted(dv):
                pdef[a.arg] = dotted(dv)
        for n in ast.walk(d.node):
            tgt, val, annot = None, None, None
            if isinstance(n, ast.Assign) and len(n.targets) == 1:
                tgt, val = n.targets[0], n.value
            elif isinstance(n, ast.AnnAssign):
                tgt, val, annot = n.target, n.value, n.annotation
            if not (isinstance(tgt, ast.Attribute) and isinstance(tgt.value, ast.Name) and tgt.value.id == 'self'):
                continue
            if annot is not None:
                _add(ci, tgt.attr, type_names(annot))
            for v in _value_choices(val):
                if isinstance(v, ast.Call) and dotted(v.func):
                    _add(ci, tgt.attr, [dotted(v.func)])
                elif isinstance(v, ast.Name) and v.id in ann:
                    _add(ci, tgt.attr, ann[v.id])
                if isinstance(v, ast.Name) and v.id in pdef:
                    ci.attr_funcs.setdefault(tgt.attr, pdef[v.id])


def _value_choices(v):
    if isinstance(v, ast.IfExp):
        return _value_choices(v.body) + _value_choices(v.orelse)
    if isinstance(v, ast.BoolOp):
        return [x for e in v.values for x in _value_choices(e)]
    return [v] if v is not None else []


def _add(ci, attr, names):
    cur = ci.attrs.setdefault(attr, [])
    for n in names:
        if n not in cur and len(cur) < 3:
            cur.append(n)


class Index:
    def __init__(self, root, paths):
        self.root = root
        self.mods = {}
        self.paths = set(paths)
        self.by_dotted = {}
        self.method_index = {}   # method name -> [fn ids]
        self.enum_names = {}     # class name -> [(path, qual)]
        self.cls_tokens = {}     # name suffix (snake case) -> [(path, class qual)] over source classes
        self.dirs_with_init = {os.path.dirname(p) for p in paths if os.path.basename(p) == '__init__.py'}
        self.root_pkg = os.path.basename(os.path.abspath(root)) if '' in self.dirs_with_init else None
        self._build_dotted()

    def _build_dotted(self):
        for p in sorted(self.paths):
            parts = p[:-3].split('/')
            is_init = parts[-1] == '__init__'
            if is_init:
                parts = parts[:-1]
            if not parts and not self.root_pkg:
                continue
            cands, start = [], 0
            while True:
                cands.append(parts[start:])
                if start >= len(parts) - 1:
                    break
                d = '/'.join(parts[:start + 1])
                if d in self.dirs_with_init:
                    break
                start += 1
            if self.root_pkg:
                cands.append([self.root_pkg] + parts)
            for c in cands:
                if c:
                    self.by_dotted.setdefault('.'.join(c), p)

    def add(self, mi):
        self.mods[mi.path] = mi
        for q, ci in mi.classes.items():
            if ci.is_enum:
                self.enum_names.setdefault(ci.name, []).append((mi.path, q))
            for mname, mq in ci.methods.items():
                self.method_index.setdefault(mname, []).append('%s::%s' % (mi.path, mq))
            if not ci.is_enum:
                low = [w.lower() for w in re.findall(r'[A-Z][a-z0-9]*|[a-z0-9]+', ci.name)]
                for i in range(len(low)):
                    self.cls_tokens.setdefault('_'.join(low[i:]), []).append((mi.path, q))

    def link(self):
        """Resolve module-level imports, then fold enum-derived classes to a fixpoint."""
        for mi in self.mods.values():
            for node in mi.raw_imports:
                self.bind_import(mi, node, mi.binds, mi.stars)
        changed = True
        while changed:
            changed = False
            for mi in self.mods.values():
                for q, ci in mi.classes.items():
                    if not ci.is_enum and any(b and b.split('.')[-1] in self.enum_names for b in ci.bases):
                        ci.is_enum = True
                        self.enum_names.setdefault(ci.name, []).append((mi.path, q))
                        changed = True

    def find_mod(self, mi, name, level):
        if level:
            d = mi.dir
            for _ in range(level - 1):
                if not d:
                    return None
                d = os.path.dirname(d)
            if not name:
                return self._init_of(d)
            return self._try((d + '/' if d else '') + name.replace('.', '/'))
        p = self.by_dotted.get(name)
        if p:
            return p
        return self._try((mi.dir + '/' if mi.dir else '') + name.replace('.', '/'))

    def _init_of(self, d):
        p = (d + '/' if d else '') + '__init__.py'
        return p if p in self.paths else None

    def _try(self, rel):
        for cand in (rel + '.py', rel + '/__init__.py'):
            if cand in self.paths:
                return cand
        return None

    def bind_import(self, mi, node, binds, stars):
        if isinstance(node, ast.Import):
            for a in node.names:
                top = a.name.split('.')[0]
                if a.asname:
                    t = self.find_mod(mi, a.name, 0)
                    binds[a.asname] = ('mod', t) if t else ('ext', top)
                else:
                    t = self.find_mod(mi, top, 0)
                    binds[top] = ('mod', t) if t else ('ext', top)
            return
        mod = node.module or ''
        base = self.find_mod(mi, mod, node.level)
        top = mod.split('.')[0] if mod else ''
        for a in node.names:
            if a.name == '*':
                if base:
                    stars.append(base)
                continue
            alias = a.asname or a.name
            sub = self.find_mod(mi, (mod + '.' if mod else '') + a.name, node.level)
            bmi = self.mods.get(base) if base else None
            has_sym = bool(bmi) and (a.name in bmi.top_funcs or a.name in bmi.top_classes or a.name in bmi.vars)
            if base and (has_sym or not sub):
                binds[alias] = ('sym', base, a.name)
            elif sub:
                binds[alias] = ('mod', sub)
            else:
                binds[alias] = ('ext', top or a.name)

    # ---- symbol resolution -------------------------------------------------
    def lookup(self, path, name, depth=0, binds=None):
        """What `name` means at the top level of module `path`."""
        mi = self.mods.get(path)
        if mi is None or depth > 6:
            return None
        if binds and name in binds:
            return self._follow(binds[name], depth)
        if name in mi.top_funcs:
            return ('func', '%s::%s' % (path, name))
        if name in mi.top_classes:
            return ('class', path, name)
        if name in mi.vars:
            ci = self.resolve_class(mi, mi.vars[name], depth + 1)
            if ci:
                return ('inst', ci[0], ci[1])
        if name in mi.binds:
            return self._follow(mi.binds[name], depth)
        for s in mi.stars:
            r = self.lookup(s, name, depth + 1)
            if r:
                return r
        return None

    def _follow(self, b, depth):
        if b[0] == 'mod':
            return ('mod', b[1])
        if b[0] == 'sym':
            r = self.lookup(b[1], b[2], depth + 1)
            if r is None:
                sub = b[1][:-3] if not b[1].endswith('__init__.py') else b[1][:-11]
                m = self._try((sub + '/' if sub else '') + b[2])
                return ('mod', m) if m else None
            return r
        return ('ext', b[1])

    def resolve_class(self, mi, dotted_name, depth=0, binds=None):
        """(path, class qual) for a dotted type name seen in module `mi`, or None."""
        if not dotted_name:
            return None
        parts = dotted_name.split('.')
        r = self.lookup(mi.path, parts[0], depth, binds)
        for i, part in enumerate(parts[1:], 1):
            if r is None:
                return None
            if r[0] == 'mod':
                r = self.lookup(r[1], part, depth + 1)
            elif r[0] == 'class':
                q = r[2] + '.' + part
                r = ('class', r[1], q) if q in self.mods[r[1]].classes else None
            else:
                return None
        return (r[1], r[2]) if r and r[0] in ('class', 'inst') else None

    def find_method(self, path, cqual, mname, seen=None, skip_self=False):
        seen = seen if seen is not None else set()
        key = (path, cqual)
        if key in seen:
            return None
        seen.add(key)
        mi = self.mods.get(path)
        ci = mi.classes.get(cqual) if mi else None
        if ci is None:
            return None
        if not skip_self and mname in ci.methods:
            return '%s::%s' % (path, ci.methods[mname])
        for b in ci.bases:
            bc = self.resolve_class(mi, b)
            if bc:
                r = self.find_method(bc[0], bc[1], mname, seen)
                if r:
                    return r
        return None

    def class_attr_type(self, path, cqual, attr, seen=None):
        seen = seen if seen is not None else set()
        if (path, cqual) in seen:
            return None
        seen.add((path, cqual))
        mi = self.mods.get(path)
        ci = mi.classes.get(cqual) if mi else None
        if ci is None:
            return None
        for tname in ci.attrs.get(attr, []):
            r = self.resolve_class(mi, tname)
            if r:
                return r
        for b in ci.bases:
            bc = self.resolve_class(mi, b)
            if bc:
                r = self.class_attr_type(bc[0], bc[1], attr, seen)
                if r:
                    return r
        return None

    def class_has_open_bases(self, path, cqual):
        """True when some base class is outside the project (so a missing method may live there)."""
        mi = self.mods.get(path)
        ci = mi.classes.get(cqual) if mi else None
        if ci is None:
            return True
        return any(b != 'object' and self.resolve_class(mi, b) is None for b in ci.bases)

    def resolve_func(self, mi, dotted_name, binds=None):
        """Function (or class constructor) a dotted name points at in module `mi`, or None."""
        parts = dotted_name.split('.')
        r = self.lookup(mi.path, parts[0], binds=binds)
        i = 1
        while r is not None and i < len(parts):
            if r[0] == 'mod':
                r = self.lookup(r[1], parts[i])
                i += 1
            elif r[0] in ('class', 'inst') and i == len(parts) - 1:
                return self.find_method(r[1], r[2], parts[i])
            else:
                return None
        if r and r[0] == 'func':
            return r[1]
        if r and r[0] == 'class':
            return self.find_method(r[1], r[2], '__init__')
        return None

    def class_attr_func(self, path, cqual, attr, seen=None):
        """Function a class stores under `attr` when it came in as a defaulted constructor parameter."""
        seen = seen if seen is not None else set()
        if (path, cqual) in seen:
            return None
        seen.add((path, cqual))
        mi = self.mods.get(path)
        ci = mi.classes.get(cqual) if mi else None
        if ci is None:
            return None
        if attr in ci.attr_funcs:
            return self.resolve_func(mi, ci.attr_funcs[attr])
        for b in ci.bases:
            bc = self.resolve_class(mi, b)
            if bc:
                r = self.class_attr_func(bc[0], bc[1], attr, seen)
                if r:
                    return r
        return None

    def guess_method(self, recv, mname):
        """`self.queue.fail()`: a receiver named like exactly one source class that has the method."""
        key = recv.lstrip('_').lower()
        found = []
        for path, q in self.cls_tokens.get(key, []):
            m = self.find_method(path, q, mname)
            if m and m not in found:
                found.append(m)
        return found[0] if len(found) == 1 else None
