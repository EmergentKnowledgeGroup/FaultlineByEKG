"""One-file walker for the Python signal reader. See signals_py.py. Reports raw per-function facts, enum and constant uses, empty
handlers and swallowed errors; src/extract/signals.mjs turns them into pairs, sticky flags and so on."""
import ast
import re

from py_index import collect_defs  # noqa: E402
from signals_py_wake import analyze_method  # noqa: E402

TEARDOWN = re.compile(r'\b(?:close|stop|dispose|destroy|cleanup|clean|shutdown|disconnect|terminate|kill|abort|cancel|release|remove|unlink|rm|delete|end|quit|unref|teardown|finalize|exit|aclose)\b')
LIFECYCLE = {'stop', 'close', 'cancel', 'abort', 'shutdown', 'drain'}
HANDLER_NAME = re.compile(r'^(?:_*on|_*handle)(?:[A-Z_0-9]|$)|(?:Handler|Callback|Listener|_handler|_callback|_listener)$')
HANDLING_EXACT = re.compile(r'^(?:console|logger|logging|log|debug|warn|warning|error|info|trace|fatal|emit|callback|cb|done|next|reject|print|exception|exit|abort|kill|publish|dispatch|traceback)$', re.I)
HANDLING_PREFIX = re.compile(r'^(?:log|report|record|notify|fail|capture|track|send|handle|raise|emit|sentry|dispatch|publish|print|throw|set_?exception|set_?error)', re.I)
BROAD = {'Exception', 'BaseException'}
EXIT_CALLS = {'exit', 'quit', '_exit'}


def words_of(s):
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', s or '')
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', s)
    return [w for w in re.sub(r'[^A-Za-z0-9]+', ' ', s).lower().split() if w]


def handling_seg(seg):
    return bool(HANDLING_EXACT.match(seg) or HANDLING_PREFIX.match(seg) or re.match(r'^on[A-Z_]', seg) or seg.startswith('on_') or seg.endswith('Error') or seg.endswith('_error'))


def short(text, n=80):
    text = re.sub(r'\s+', ' ', text or '').strip()
    return text if len(text) <= n else text[:n - 3].rstrip() + '...'


def dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return list(reversed(parts))
    return None


def lit_text(n):
    """The value as text when it is a plain literal (same spelling the TS reader uses), else None."""
    if isinstance(n, ast.Constant):
        v = n.value
        if v is True: return 'true'
        if v is False: return 'false'
        if v is None: return 'null'
        if isinstance(v, (int, float)): return str(v)
        if isinstance(v, str): return '"%s"' % (v if len(v) <= 30 else v[:29] + '…')
        return None
    if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub) and isinstance(n.operand, ast.Constant) and isinstance(n.operand.value, (int, float)):
        return '-%s' % n.operand.value
    if isinstance(n, ast.List) and not n.elts: return '[]'
    if isinstance(n, ast.Dict) and not n.keys: return '{}'
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in ('set', 'dict', 'list') and not n.args and not n.keywords: return '[]' if n.func.id != 'dict' else '{}'
    return None


def body_empty(body):
    for s in body:
        if isinstance(s, ast.Pass): continue
        if isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and (isinstance(s.value.value, str) or s.value.value is Ellipsis): continue
        return False
    return True


def self_name(node):
    a = node.args
    pos = list(getattr(a, 'posonlyargs', [])) + list(a.args)
    return pos[0].arg if pos else None


class Walker:
    def __init__(self, rel, text, tree, ctx, out):
        self.rel, self.lines, self.tree, self.ctx, self.out = rel, text.split('\n'), tree, ctx, out
        self.anc, self.cur, self.in_cond, self.self_stack, self.cls_stack = [], None, 0, [], []
        defs = collect_defs(tree)
        self.fn_def = {id(d.node): d for d in defs if d.kind == 'func'}
        self.cls_def = {id(d.node): d for d in defs if d.kind != 'func'}
        self.recs = {}
        self.mod = {'id': '%s::<module>' % rel, 'path': rel, 'name': '<module>', 'owner': '', 'method': False, 'line': 1, 'end': len(self.lines), 'writes': [], 'calls': [], 'supers': 0, 'reads': []}

    # ---- helpers ------------------------------------------------------------------------------------------------------
    def rec_for(self, d):
        r = self.recs.get(id(d.node))
        if r is None:
            n = d.node
            r = {'id': '%s::%s' % (self.rel, d.qual), 'path': self.rel, 'name': n.name, 'owner': d.qual.rsplit('.', 1)[0] if '.' in d.qual else '', 'method': d.cls is not None,
                 'line': n.lineno, 'end': n.end_lineno, 'writes': [], 'calls': [], 'supers': 0, 'reads': []}
            self.recs[id(d.node)] = r
            self.out['fns'].append(r)
            if d.cls is not None and r['owner'] == d.cls and not any(isinstance(x, ast.Name) and x.id == 'staticmethod' for x in n.decorator_list):
                r.update(analyze_method(n, self_name(n)))        # sk (path skeleton), lp (parking loops), gt (getter): lost-wakeup facts
        return r

    def has_comment(self, a, b):
        for ln in self.lines[a - 1:b]:
            if '#' in ln and not re.search(r'''['"].*#.*['"]''', ln): return True
        return False

    def comment_text(self, a, b):
        for ln in self.lines[a - 1:b]:
            m = re.search(r'#\s*(.*)$', ln)
            if m and not re.search(r'''['"].*#.*['"]''', ln): return short(m.group(1), 90)
        return ''

    def ctx_of(self, n):
        """Where does this Enum.MEMBER / constant sit: a case label, a comparison, a dispatch-table key, or produced (assigned, passed, sent)?"""
        child = n
        for p in reversed(self.anc[:-1]):
            if isinstance(p, ast.MatchValue): return 'case', p
            if isinstance(p, ast.Compare): return 'cmp', p
            if isinstance(p, (ast.Tuple, ast.List, ast.Set)): child = p; continue
            if isinstance(p, ast.Dict):                                   # {Cmd.A: self.on_a} is a dispatch table; {Key.A: 'text'} builds a mapping
                for k, v in zip(p.keys, p.values):
                    if k is child: return ('key', None) if isinstance(v, ast.Lambda) or (isinstance(v, ast.Attribute) and isinstance(v.value, ast.Name) and v.value.id in ('self', 'cls')) or (isinstance(v, ast.Name) and not v.id.isupper()) else ('produce', None)
                return 'produce', None
            if isinstance(p, ast.Subscript) and p.slice is child: return 'key', None
            if isinstance(p, ast.Call) and any(a is child for a in p.args) and isinstance(p.func, ast.Attribute) and p.func.attr in ('get', 'pop', 'index', 'count', '__contains__'): return 'cmp', None
            return 'produce', None
        return 'produce', None

    def handler_body(self, n):
        """(empty?, line) of the branch that handles this case/comparison."""
        for p in reversed(self.anc[:-1]):
            if isinstance(p, ast.match_case): return body_empty(p.body), p.pattern.lineno if hasattr(p.pattern, 'lineno') else n.lineno
            if isinstance(p, ast.If) and any(n is x for x in ast.walk(p.test)): return body_empty(p.body), p.lineno
            if isinstance(p, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): break
        return False, n.lineno

    # ---- walk ---------------------------------------------------------------------------------------------------------
    def run(self):
        self.cur = self.mod
        self.walk(self.tree)
        self.out['fns'].append(self.mod)

    def walk(self, n):
        self.anc.append(n)
        saved, saved_cond = self.cur, self.in_cond
        d = self.fn_def.get(id(n)); cd = self.cls_def.get(id(n))
        pushed = False
        if d is not None:
            self.cur = self.rec_for(d); self.in_cond = 0
            owner = d.qual.rsplit('.', 1)[0] if '.' in d.qual else ''
            if d.cls is not None and owner == d.cls: sn = None if any(isinstance(x, ast.Name) and x.id == 'staticmethod' for x in n.decorator_list) else self_name(n)
            else: sn = self.self_stack[-1] if self.self_stack else None      # a closure keeps the outer self
            self.self_stack.append(sn); pushed = True
            self.on_def(d, n)
        if cd is not None:
            self.cls_stack.append(cd)
            self.out['classes'].append({'qual': cd.qual, 'path': self.rel, 'bases': len([b for b in n.bases if not (isinstance(b, ast.Name) and b.id == 'object')]), 'protocol': any((dotted(b) or [''])[-1] in ('Protocol', 'ABC') for b in n.bases)})
        try:
            self.visit(n)
        finally:
            if cd is not None: self.cls_stack.pop()
            if pushed: self.self_stack.pop()
            self.cur, self.in_cond = saved, saved_cond
            self.anc.pop()

    def kids(self, n):
        for ch in ast.iter_child_nodes(n): self.walk(ch)

    def cond(self, e):
        if e is None: return
        self.in_cond += 1; self.walk(e); self.in_cond -= 1

    def is_self(self, node):
        sn = self.self_stack[-1] if self.self_stack else None
        return sn is not None and isinstance(node, ast.Name) and node.id == sn

    def visit(self, n):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            for dd in getattr(n.args, 'defaults', []): self.walk(dd)
            if isinstance(n, ast.Lambda): self.walk(n.body)
            else:
                for s in n.body: self.walk(s)
            return
        if isinstance(n, (ast.If, ast.While)):
            self.on_if(n); self.cond(n.test)
            for s in n.body + n.orelse: self.walk(s)
            return
        if isinstance(n, ast.IfExp): self.cond(n.test); self.walk(n.body); self.walk(n.orelse); return
        if isinstance(n, ast.Assert): self.cond(n.test); return
        if isinstance(n, ast.BoolOp):
            for v in n.values[:-1]: self.cond(v)
            self.walk(n.values[-1]); return
        if isinstance(n, ast.ClassDef):
            for s in n.body:
                if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name) and self.cls_stack:
                    self.out['inits'].append({'owner': self.cls_stack[-1].qual, 'path': self.rel, 'field': s.targets[0].id, 'value': lit_text(s.value), 'line': s.lineno})
                elif isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name) and s.value is not None and self.cls_stack:
                    self.out['inits'].append({'owner': self.cls_stack[-1].qual, 'path': self.rel, 'field': s.target.id, 'value': lit_text(s.value), 'line': s.lineno})
            for b in n.bases: self.walk(b)
            for s in n.body: self.walk(s)
            return
        if isinstance(n, ast.Assign):
            for t in n.targets: self.on_target(t, lit_text(n.value), n.lineno)
            self.walk(n.value); return
        if isinstance(n, ast.AnnAssign):
            if n.value is not None:
                self.on_target(n.target, lit_text(n.value), n.lineno); self.walk(n.value)
            return
        if isinstance(n, ast.AugAssign): self.on_target(n.target, None, n.lineno); self.walk(n.value); return
        if isinstance(n, ast.Delete):
            for t in n.targets: self.on_target(t, 'delete', n.lineno)
            return
        if isinstance(n, ast.arg): return
        if isinstance(n, ast.ExceptHandler): self.on_except(n); self.kids(n); return
        if isinstance(n, ast.Call): self.on_call(n)
        elif isinstance(n, ast.Attribute): return self.on_attr(n)
        elif isinstance(n, ast.Name): return self.on_name(n)
        elif isinstance(n, ast.Constant): return self.on_const(n)
        elif isinstance(n, ast.match_case): self.on_match_case(n)
        self.kids(n)

    # ---- facts ------------------------------------------------------------------------------------------------------
    def on_target(self, t, value, line):
        if isinstance(t, ast.Attribute) and self.is_self(t.value): self.cur['writes'].append([t.attr, value, line])
        elif isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts: self.on_target(e, None, line)

    def on_call(self, n):
        f = n.func
        if isinstance(f, ast.Attribute):
            if self.is_self(f.value): self.cur['calls'].append(f.attr)
            elif isinstance(f.value, ast.Call) and isinstance(f.value.func, ast.Name) and f.value.func.id == 'super': self.cur['supers'] += 1
            elif isinstance(f.value, ast.Attribute) and self.is_self(f.value.value):
                if f.attr in ('set', 'clear') and not n.args and not n.keywords: self.cur['writes'].append([f.value.attr, f.attr + '()', n.lineno])
                elif f.attr in ('is_set', 'wait', 'locked'): self.cur['reads'].append([f.value.attr, n.lineno])

    def on_attr(self, n):
        v = n.value
        if self.is_self(v):
            if self.in_cond > 0 and isinstance(n.ctx, ast.Load): self.cur['reads'].append([n.attr, n.lineno])
            return
        if isinstance(v, ast.Name) and v.id in self.ctx['enum_names']:
            if n.attr in self.ctx['enum_members'].get(v.id, ()): self.on_use(n, v.id, n.attr)
            else: self.out['uses'].append({'name': v.id, 'member': None, 'ctx': 'dyn', 'fn': self.cur['id'], 'path': self.rel, 'line': n.lineno})
            return
        self.kids(n)

    def on_name(self, n):
        if not isinstance(n.ctx, ast.Load): return
        p = self.anc[-2] if len(self.anc) > 1 else None
        if n.id in self.ctx['enum_names']:
            if isinstance(p, ast.Call) and p.func is not n and getattr(p.func, 'id', '') == 'isinstance': return
            if isinstance(p, ast.ClassDef): return
            self.out['uses'].append({'name': n.id, 'member': None, 'ctx': 'dyn', 'fn': self.cur['id'], 'path': self.rel, 'line': n.lineno})
        elif n.id in self.ctx['const_names']:
            self.on_use(n, n.id, '')

    def on_use(self, n, name, member):
        ctx, p = self.ctx_of(n)
        row = {'name': name, 'member': member, 'ctx': ctx, 'fn': self.cur['id'], 'path': self.rel, 'line': n.lineno}
        if ctx in ('case', 'cmp'): row['empty'], row['handlerLine'] = self.handler_body(n)
        self.out['uses'].append(row)

    def on_const(self, n):
        if isinstance(n.value, str) and n.value in self.ctx['str_vals'] and (self.rel, n.lineno, n.col_offset) not in self.ctx['def_pos']:
            p = self.anc[-2] if len(self.anc) > 1 else None
            if isinstance(p, ast.Expr): return
            if self.ctx_of(n)[0] == 'produce': self.out['rawStrings'].append({'value': n.value, 'path': self.rel, 'line': n.lineno})

    # ---- empty handlers -----------------------------------------------------------------------------------------------
    def on_def(self, d, n):
        deco = set()
        for x in n.decorator_list:
            dd = dotted(x.func if isinstance(x, ast.Call) else x)
            if dd: deco.add(dd[-1])
        if deco & {'abstractmethod', 'overload', 'abstractproperty'} or not body_empty(n.body): return
        cls = self.cls_stack[-1] if self.cls_stack else None
        in_cls = cls is not None and d.cls == cls.qual
        has_bases = bool(in_cls and any(not (isinstance(b, ast.Name) and b.id == 'object') for b in cls.node.bases))
        proto = bool(in_cls and any((dotted(b) or [''])[-1] in ('Protocol',) for b in cls.node.bases))
        if proto: return
        base = {'fn': self.rec_for(d)['id'], 'path': self.rel, 'line': n.lineno, 'end': n.end_lineno, 'name': n.name, 'commented': self.has_comment(n.lineno + 1, n.end_lineno), 'owner': d.cls or ''}
        if any(w in LIFECYCLE for w in words_of(n.name)) and has_bases: self.out['emptyHandlers'].append({'kind': 'lifecycle', **base})
        elif HANDLER_NAME.search(n.name): self.out['emptyHandlers'].append({'kind': 'handler', **base})

    def on_if(self, n):
        t = n.test
        if body_empty(n.body) and n.body and all(isinstance(s, ast.Pass) for s in n.body) and isinstance(t, ast.Compare) and len(t.ops) == 1 and isinstance(t.ops[0], (ast.Eq, ast.Is, ast.In)):
            other = t.comparators[0]
            if isinstance(other, ast.Constant) or (dotted(other) and dotted(other)[-1].isupper()):
                self.out['emptyHandlers'].append({'kind': 'case', 'fn': self.cur['id'], 'path': self.rel, 'line': n.lineno, 'end': n.end_lineno, 'name': short(ast.unparse(t), 50), 'label': short(ast.unparse(t), 50), 'commented': self.has_comment(n.lineno, n.body[-1].end_lineno)})

    def on_match_case(self, n):
        if isinstance(n.pattern, ast.MatchAs) and n.pattern.pattern is None: return
        if body_empty(n.body) and all(isinstance(s, ast.Pass) for s in n.body):
            ln = n.pattern.lineno if hasattr(n.pattern, 'lineno') else self.cur['line']
            self.out['emptyHandlers'].append({'kind': 'case', 'fn': self.cur['id'], 'path': self.rel, 'line': ln, 'end': n.body[-1].end_lineno, 'name': short(ast.unparse(n.pattern), 50), 'label': short(ast.unparse(n.pattern), 50), 'commented': self.has_comment(ln, n.body[-1].end_lineno)})

    # ---- swallowed errors ---------------------------------------------------------------------------------------------
    def on_except(self, h):
        types = []
        if h.type is not None:
            for t in (h.type.elts if isinstance(h.type, ast.Tuple) else [h.type]):
                dd = dotted(t); types.append(dd[-1] if dd else '?')
        broad = h.type is None or any(t in BROAD for t in types)
        throws = used = handled = False
        for s in h.body:
            for x in ast.walk(s):
                if isinstance(x, ast.Raise): throws = True
                elif isinstance(x, ast.Name) and h.name and x.id == h.name: used = True
                elif isinstance(x, ast.Call):
                    dd = dotted(x.func)
                    if dd and (any(handling_seg(seg) for seg in dd) or (len(dd) == 1 and dd[0] in EXIT_CALLS) or dd[-1] in ('exit', '_exit')): handled = True
                elif isinstance(x, (ast.Assign, ast.AugAssign)):
                    tg = x.targets[0] if isinstance(x, ast.Assign) else x.target
                    if re.search(r'err|fail', ast.unparse(tg), re.I): handled = True
        if throws or used or handled: return
        t = self.anc[-2] if len(self.anc) > 1 and isinstance(self.anc[-2], ast.Try) else None
        cleanup = False
        if t is not None and len(t.body) == 1 and isinstance(t.body[0], ast.Expr):
            v = t.body[0].value
            if isinstance(v, ast.Await): v = v.value
            if isinstance(v, ast.Call) and dotted(v.func): cleanup = bool(TEARDOWN.search(' '.join(words_of(dotted(v.func)[-1]))))
        end = h.end_lineno
        self.out['swallowed'].append({'fn': self.cur['id'], 'path': self.rel, 'line': h.lineno, 'end': end, 'kind': 'except', 'broad': broad, 'types': types[:3],
                                      'empty': body_empty(h.body), 'only': (type(h.body[0]).__name__.lower() if len(h.body) == 1 and isinstance(h.body[0], (ast.Break, ast.Continue, ast.Return, ast.Pass)) else ''), 'comment': self.comment_text(h.lineno, end), 'cleanup': cleanup, 'teardown': bool(TEARDOWN.search(' '.join(words_of(self.cur['name']))))})
