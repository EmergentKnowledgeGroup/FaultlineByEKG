"""Python expressions -> flat ops (calls, sets, awaits...), in evaluation order. Pure ast, no guessing."""
import ast
import re


def dotted(n):
    """a.b.c for Name/Attribute chains; '?.b' / 'super().b' when the base is a call or subscript."""
    parts = []
    while isinstance(n, ast.Attribute):
        parts.append(n.attr)
        n = n.value
    if isinstance(n, ast.Name):
        parts.append(n.id)
    elif isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'super':
        parts.append('super()')
    elif parts:
        parts.append('?')
    else:
        return None
    return '.'.join(reversed(parts))


def short(s, n=90):
    s = re.sub(r'\s+', ' ', s or '').strip()
    return s if len(s) <= n else s[:n - 3] + '...'


_LINES = []          # source lines of the file being read; set before each file is read


def set_source(lines):
    """Titles are sliced from the source text, never rebuilt with ast.unparse: unparse changes between Python
    minor versions (`lambda :` vs `lambda:`), the source does not."""
    global _LINES
    _LINES = lines


def u16col(line, byte_col):
    """ast columns are UTF-8 byte offsets; a language server counts UTF-16 code units."""
    try:
        return len(_LINES[line - 1].encode('utf-8')[:byte_col].decode('utf-8', 'replace').encode('utf-16-le')) // 2
    except Exception:
        return byte_col


def name_tok(func):
    """(line, UTF-16 column, both of the callee NAME token): where a resolver is asked "what does this call?". The name is the
    last token of a Name / Attribute, so its start is the node's end minus its length. Other callees (`f()()`, `(a or b)()`) -> None."""
    if isinstance(func, ast.Name):
        return func.lineno, u16col(func.lineno, func.col_offset)
    if isinstance(func, ast.Attribute):
        return func.end_lineno, u16col(func.end_lineno, func.end_col_offset - len(func.attr.encode('utf-8')))
    return None


def seg(n):
    """The exact source text of node `n`. ast columns are UTF-8 byte offsets, so slice the encoded line."""
    l1, l2 = n.lineno, n.end_lineno
    c1, c2 = n.col_offset, n.end_col_offset
    if l1 == l2:
        return _LINES[l1 - 1].encode('utf-8')[c1:c2].decode('utf-8', 'replace')
    first = _LINES[l1 - 1].encode('utf-8')[c1:].decode('utf-8', 'replace')
    last = _LINES[l2 - 1].encode('utf-8')[:c2].decode('utf-8', 'replace')
    return ' '.join([first] + _LINES[l1:l2 - 1] + [last])


def unp(n, w=90):
    """Short source text of an expression node (whitespace collapsed, cut to w characters)."""
    try:
        return short(seg(n), w)
    except Exception:
        return ''


def val_class(v):
    """Coarse description of an assigned/returned value."""
    if v is None:
        return 'const:None'
    if isinstance(v, ast.Constant):
        x = v.value
        if isinstance(x, str):
            return 'const:str:' + short(x, 40)
        return 'const:' + repr(x)
    if isinstance(v, ast.UnaryOp) and isinstance(v.operand, ast.Constant):
        return 'const:' + unp(v, 20)
    if isinstance(v, ast.Name):
        return 'name:' + v.id
    if isinstance(v, ast.Attribute):
        return 'attr:' + (dotted(v) or '?')
    if isinstance(v, ast.Call):
        return 'call:' + (dotted(v.func) or '?')
    if isinstance(v, ast.Await) and isinstance(v.value, ast.Call):
        return 'call:' + (dotted(v.value.func) or '?')
    if isinstance(v, ast.Dict):
        # the constant keys name the shape of a reply: {"ok", "result"} is not {"error"}
        keys = sorted({k.value for k in v.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)})
        return 'new:dict' + ('{' + ','.join(keys[:6]) + (',...' if len(keys) > 6 else '') + '}' if keys else '')
    if isinstance(v, ast.DictComp):
        return 'new:dict'
    if isinstance(v, (ast.List, ast.ListComp)):
        return 'new:list'
    if isinstance(v, (ast.Set, ast.SetComp)):
        return 'new:set'
    if isinstance(v, ast.Tuple):
        return 'tuple:' + ','.join(val_class(e) for e in v.elts[:4])
    if isinstance(v, ast.JoinedStr):
        return 'fstr'
    return 'expr'


def rv_of(v):
    """{'rv': [names the returned expression reads]} (empty dict when it reads none): whether a returned value carries a given variable."""
    if v is None:
        return {}
    names = sorted({w.id for w in ast.walk(v) if isinstance(w, ast.Name) and isinstance(w.ctx, ast.Load)})
    return {'rv': names[:12]} if names else {}


def ret_sig(v):
    """Signature of a returned value: what kind of ending is it."""
    c = val_class(v)
    return {'const:None': 'ret:none'}.get(c, 'ret:' + c)


class Ops:
    """Collects ops from expression trees. `held` is the lock/with stack at the point of use."""

    def __init__(self):
        self.ops = []
        self.rd = set()

    def base(self, n, held):
        b = n
        while isinstance(b, ast.Attribute):
            b = b.value
        if b is not n and not isinstance(b, ast.Name):
            if isinstance(b, ast.Call) and isinstance(b.func, ast.Name) and b.func.id == 'super':
                return
            self.expr(b, held)

    def expr(self, n, held, aw=False):
        if n is None:
            return
        if isinstance(n, ast.Lambda):
            return
        if isinstance(n, ast.Await):
            before = len(self.ops)
            self.expr(n.value, held, True)
            if len(self.ops) == before or not isinstance(n.value, ast.Call):
                self.ops.append({'t': 'await', 'line': n.lineno, 'f': dotted(n.value) if not isinstance(n.value, ast.Call) else None, 'held': list(held)})
            return
        if isinstance(n, ast.GeneratorExp):
            before = len(self.ops)
            for c in ast.iter_child_nodes(n):
                self.expr(c, held)
            for o in self.ops[before:]:
                o['lazy'] = 1                      # a generator expression runs when it is consumed, not where it is written
            return
        if isinstance(n, (ast.Yield, ast.YieldFrom)):
            self.expr(n.value, held)
            self.ops.append({'t': 'yield', 'line': n.lineno, 'held': list(held)})
            return
        if isinstance(n, ast.Call):
            self.base(n.func, held)
            for a in n.args:
                self.expr(a, held)
            for k in n.keywords:
                self.expr(k.value, held)
            f = dotted(n.func)
            if f is None and isinstance(n.func, ast.Call):
                f = '?'
            a0 = None
            if n.args and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str):
                a0 = n.args[0].value[:80]
            a1 = n.args[1].value[:80] if len(n.args) > 1 and isinstance(n.args[1], ast.Constant) and isinstance(n.args[1].value, str) else None
            mode = None
            if f and f.rsplit('.', 1)[-1] == 'open':
                m = n.args[1] if len(n.args) > 1 else next((k.value for k in n.keywords if k.arg == 'mode'), None)
                if isinstance(m, ast.Constant) and isinstance(m.value, str):
                    mode = m.value
            cb = []
            for a in list(n.args) + [k.value for k in n.keywords]:
                d = dotted(a) if isinstance(a, (ast.Name, ast.Attribute)) else None
                if d:
                    cb.append(d)
            op = {'t': 'call', 'line': n.lineno, 'f': f, 'n': len(n.args), 'aw': aw, 'held': list(held)}
            nt = name_tok(n.func)
            if nt:
                op['nl'], op['nc'] = nt
            if n.keywords:
                op['kw'] = [k.arg for k in n.keywords if k.arg]
                fk = next((k.value for k in n.keywords if k.arg == 'file'), None)
                if fk is not None:
                    op['fl'] = dotted(fk) or '?'           # print(..., file=X): the text goes to X
            if a0 is not None:
                op['a0'] = a0
            if a1 is not None:
                op['a1'] = a1
            if mode is not None:
                op['mode'] = mode
            if cb:
                op['cb'] = cb[:6]
            ai = {}                          # the name handed over at each argument position (or keyword): which parameter of the callee it lands in
            for i, a in enumerate(n.args[:8]):
                d = dotted(a) if isinstance(a, (ast.Name, ast.Attribute)) else None
                if d:
                    ai[str(i)] = d
            for k in n.keywords:
                d = dotted(k.value) if k.arg and isinstance(k.value, (ast.Name, ast.Attribute)) else None
                if d:
                    ai['kw:' + k.arg] = d
            if ai:
                op['ai'] = ai
            self.ops.append(op)
            if f:
                self.rd.add(f)
            return
        if isinstance(n, ast.IfExp):
            self.expr(n.test, held)
            self.expr(n.body, held)
            self.expr(n.orelse, held)
            self.ops.append({'t': 'tern', 'line': n.lineno, 'test': unp(n.test, 60)})
            return
        if isinstance(n, (ast.Name, ast.Attribute)) and isinstance(getattr(n, 'ctx', None), ast.Load):
            d = dotted(n)
            if d:
                self.rd.add(d)
                # also the object chain: a.b.c reads a.b and a
                while '.' in d:
                    d = d.rsplit('.', 1)[0]
                    self.rd.add(d)
            self.base(n, held)
            return
        for c in ast.iter_child_nodes(n):
            self.expr(c, held)

    def target(self, t, value, held, aug=False):
        """A store target -> set ops."""
        if isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts:
                self.target(e, None, held)
            return
        if isinstance(t, ast.Starred):
            return self.target(t.value, None, held)
        vc = val_class(value) if value is not None else 'unpack'
        if isinstance(t, ast.Name):
            self.ops.append({'t': 'set', 'line': t.lineno, 'tgt': t.id, 'tk': 'name', 'v': vc, 'aug': aug})
        elif isinstance(t, ast.Attribute):
            self.base(t, held)
            self.ops.append({'t': 'set', 'line': t.lineno, 'tgt': dotted(t) or '?.' + t.attr, 'tk': 'attr', 'v': vc, 'aug': aug})
        elif isinstance(t, ast.Subscript):
            self.expr(t.value, held)
            self.expr(t.slice, held)
            self.ops.append({'t': 'set', 'line': t.lineno, 'tgt': (dotted(t.value) or '?') + '[]', 'tk': 'sub', 'v': vc, 'aug': aug})
