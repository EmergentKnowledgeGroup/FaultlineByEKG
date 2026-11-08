"""Reads Python files into the project tables: functions with their graphs, modules with their imports, classes, and the project-wide name facts."""
import ast
import os

import refs
from pycfg import build_function, def_name_col
from pyops import set_source, seg, short


class Loaded:
    def __init__(self, root):
        self.root = root
        self.fns = {}            # id -> function record
        self.mods = {}           # path -> {name, imports, lang, lines}
        self.modname = {}        # dotted module name -> path
        self.classes = {}        # class key -> {name, mod, bases, methods, attrs, line, ncol}
        self.cls_by_name = {}
        self.modfn = {}          # (path, qualified name) -> function id
        self.methods_by_name = {}
        self.errors = []
        self.lines = {}
        self.strs, self.rebound, self.patched, self.newcls = set(), set(), set(), set()
        self.names, self.hidden = set(), set()

    def load_python(self, rels):
        for rel in rels:
            full = os.path.join(self.root, rel)
            try:
                src = open(full, encoding='utf-8-sig', errors='replace').read()
                tree = ast.parse(src, filename=rel)
            except (SyntaxError, ValueError, RecursionError) as e:
                self.errors.append((rel, str(e)[:80]))
                continue
            lines = src.split('\n')
            set_source(lines)
            try:
                nm, hd = refs.py_names(tree)
            except RecursionError:
                nm, hd = {x.id for x in ast.walk(tree) if isinstance(x, ast.Name)} | {x.attr for x in ast.walk(tree) if isinstance(x, ast.Attribute)}, set()
            self.names |= nm
            self.hidden |= hd
            try:
                st, rb, pt, nc = refs.py_facts(tree)
            except RecursionError:
                st, rb, pt, nc = set(), set(), set(), set()
            self.strs |= st
            self.rebound |= {(rel, x) for x in rb}
            self.patched |= pt
            self.newcls |= nc
            self.lines[rel] = len(lines)
            mname = self.pymodname(rel)
            self.modname[mname] = rel
            self.mods[rel] = {'name': mname, 'imports': {}, 'lang': 'py', 'lines': len(lines)}
            self.collect_imports(rel, mname, tree)
            rec, nested = build_function(tree, rel, '<module>', None, lines)
            rec['line'] = 1
            self.add_fn(rec)
            self.walk_scope(rel, mname, tree.body, '', None, lines)

    def pymodname(self, rel):
        d = os.path.dirname(rel)
        parts = [os.path.splitext(os.path.basename(rel))[0]]
        if parts[0] == '__init__':
            parts = []
        while d and os.path.exists(os.path.join(self.root, d, '__init__.py')):
            parts.insert(0, os.path.basename(d))
            d = os.path.dirname(d)
        return '.'.join(parts) or os.path.basename(os.path.dirname(rel))

    def collect_imports(self, rel, mname, tree):
        imp = self.mods[rel]['imports']
        pkg = mname if rel.endswith('__init__.py') else mname.rsplit('.', 1)[0] if '.' in mname else ''

        def module_level(node):
            # every node outside function bodies: module statements, if / try / with / for / while bodies, class bodies.
            # A function-local import belongs to that function, never to the module.
            stack = [node]
            while stack:
                x = stack.pop()
                yield x
                for c in ast.iter_child_nodes(x):
                    if not isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                        stack.append(c)
        for n in module_level(tree):
            if isinstance(n, ast.Import):
                for a in n.names:
                    imp[a.asname or a.name.split('.')[0]] = ('mod', a.name if a.asname else a.name.split('.')[0])
            elif isinstance(n, ast.ImportFrom):
                base = n.module or ''
                if n.level:
                    p = pkg.split('.') if pkg else []
                    p = p[:len(p) - (n.level - 1)] if n.level > 1 else p
                    base = '.'.join(p + ([n.module] if n.module else []))
                for a in n.names:
                    if a.name != '*':
                        imp[a.asname or a.name] = ('name', base, a.name)

    def add_fn(self, rec):
        self.fns[rec['id']] = rec

    def walk_scope(self, rel, mname, body, prefix, cls, lines, selfcls=None):
        for s in body:
            if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qual = prefix + s.name
                rec, nested = build_function(s, rel, qual, cls, lines, selfcls=selfcls)
                if rec['id'] in self.fns:                  # a second definition of the same name in one scope (a property setter, an overload, a conditional def)
                    k = 2
                    while f"{rec['id']}~{k}" in self.fns:
                        k += 1
                    rec['id'], rec['qual'] = f"{rec['id']}~{k}", f"{rec['qual']}~{k}"
                    qual = rec['qual']
                self.add_fn(rec)
                if cls:
                    self.classes[cls]['methods'].setdefault(s.name, rec['id'])
                    self.methods_by_name.setdefault(s.name, []).append(rec['id'])
                else:
                    self.modfn.setdefault((rel, qual), rec['id'])
                self.walk_scope(rel, mname, nested, qual + '.', None, lines, selfcls=cls or selfcls)
            elif isinstance(s, ast.ClassDef):
                key = f'{mname}:{prefix}{s.name}'
                bases = [short(seg(b), 120) for b in s.bases]
                attrs = {}
                for t in s.body:
                    if isinstance(t, ast.Assign) and len(t.targets) == 1 and isinstance(t.targets[0], ast.Name):
                        attrs[t.targets[0].id] = short(seg(t.value), 60)
                self.classes[key] = {'name': s.name, 'mod': rel, 'bases': bases, 'methods': {}, 'attrs': attrs, 'line': s.lineno, 'ncol': def_name_col(s, lines)}
                self.cls_by_name.setdefault(s.name, []).append(key)
                self.walk_scope(rel, mname, s.body, prefix + s.name + '.', key, lines)
            elif isinstance(s, (ast.If, ast.Try, ast.With, ast.For, ast.While)):
                for fld in ('body', 'orelse', 'finalbody'):
                    sub = getattr(s, fld, None)
                    if sub:
                        self.walk_scope(rel, mname, sub, prefix, cls, lines)
                for h in getattr(s, 'handlers', []):
                    self.walk_scope(rel, mname, h.body, prefix, cls, lines)


def to_ir(P, rels):
    """The document the reader writes: for each file its functions with their graphs, classes and imports; then the project-wide name facts."""
    files = []
    for rel in sorted(rels):
        m = P.mods.get(rel)
        if m is None:
            continue
        files.append({'path': rel, 'module': m['name'], 'lang': 'py', 'lines': m['lines'], 'imports': {k: list(v) for k, v in sorted(m['imports'].items())},
                      'classes': [dict(key=k, **c) for k, c in sorted(P.classes.items()) if c['mod'] == rel],
                      'fns': [P.fns[f] for f in sorted(P.fns) if P.fns[f]['path'] == rel]})
    return {'schema': 'fldet.pyir/1', 'files': files, 'errors': sorted(P.errors),
            'facts': {'names': sorted(P.names), 'hidden': sorted(P.hidden), 'strs': sorted(P.strs), 'rebound': sorted(P.rebound), 'patched': sorted(P.patched), 'newcls': sorted(P.newcls)}}


def definition_order(P):
    """What the document's sorted lists lose: the order things were found in. First match wins in several lookups, so the order is part of the result."""
    return {'classes': list(P.classes), 'fns': list(P.fns), 'clsByName': P.cls_by_name, 'methodsByName': P.methods_by_name}
