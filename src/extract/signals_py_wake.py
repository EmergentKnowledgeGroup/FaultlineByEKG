"""Python half of the lost-wakeup signal (see signals_ts_wake.mjs for the TypeScript half and the node shapes). For one method:
  sk  a path skeleton: self.method() calls, wake-like calls and returns, in order, with branches kept as branches
  lp  loops that read a field in a condition or a guard and can park (await or block)
  gt  the fields a one-line getter returns
Raw facts only. Stdlib ast."""
import ast
import re

WAKE_WORDS = {'wake', 'wakeup', 'notify', 'signal', 'resolve', 'unblock', 'unpark', 'awaken', 'notify_all'}
NOT_WAKE_RECV = {'Promise', 'path', 'os.path', 'asyncio', 'json', 'math', 'signal'}
SLEEP_WORDS = {'sleep', 'delay', 'timeout', 'nap'}
BLOCK_NAMES = {'wait', 'join', 'acquire', 'wait_for'}
FETCHY = re.compile(r'^(?:fetch|take|dequeue|recv|receive|blocking|brpop|blpop)', re.I)
TIMEY = re.compile(r'timeout|millis|\bms\b|seconds|delay|interval|duration', re.I)


def words(s):
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', s or '')
    return [w for w in re.sub(r'[^A-Za-z0-9]+', ' ', s).lower().split() if w]


def chain(node, sn):
    """a.b.c as text, with the self name written '@'; '' when the expression is not a plain attribute chain."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append('@' if node.id == sn else node.id)
        return '.'.join(reversed(parts))
    return ''


def is_wake(name):
    return name in ('add', 'put', 'set') or any(w in WAKE_WORDS for w in words(name))


def num_or_timey(a):
    return (isinstance(a, ast.Constant) and isinstance(a.value, (int, float)) and not isinstance(a.value, bool)) or bool(TIMEY.search(ast.unparse(a)))


def make(sn):
    def callname(call):
        f = call.func
        if isinstance(f, ast.Attribute): return f.attr
        if isinstance(f, ast.Name): return f.id
        return ''

    def is_self(n):
        return isinstance(n, ast.Name) and n.id == sn

    # ---- skeleton -------------------------------------------------------------------------------------------------
    def expr(n, out):
        if n is None or isinstance(n, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): return
        if isinstance(n, ast.Call):
            f = n.func
            if isinstance(f, ast.Attribute): expr(f.value, out)
            elif not isinstance(f, ast.Name): expr(f, out)
            for a in n.args: expr(a, out)
            for k in n.keywords: expr(k.value, out)
            name = callname(n)
            if isinstance(f, ast.Attribute) and is_self(f.value): out.append({'t': 'c', 'n': f.attr, 'l': n.lineno})
            if name and is_wake(name):
                recv = chain(f.value, sn) if isinstance(f, ast.Attribute) else ''
                if recv not in NOT_WAKE_RECV and (name != 'set' or not n.args):
                    out.append({'t': 'w', 'n': name, 'r': recv, 'a': len(n.args) + len(n.keywords), 'l': n.lineno})
            return
        if isinstance(n, ast.BoolOp):
            expr(n.values[0], out)
            r = []
            for v in n.values[1:]: expr(v, r)
            if r: out.append({'t': 'if', 'a': r, 'b': []})
            return
        if isinstance(n, ast.IfExp):
            expr(n.test, out)
            a, b = [], []
            expr(n.body, a); expr(n.orelse, b)
            if a or b: out.append({'t': 'if', 'a': a, 'b': b})
            return
        for ch in ast.iter_child_nodes(n): expr(ch, out)

    def stmt(s, out):
        if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): return
        if isinstance(s, ast.If):
            expr(s.test, out)
            a, b = [], []
            stmts(s.body, a); stmts(s.orelse, b)
            out.append({'t': 'if', 'a': a, 'b': b})
        elif isinstance(s, ast.Return):
            expr(s.value, out); out.append({'t': 'r'})
        elif isinstance(s, ast.Raise):
            expr(s.exc, out); out.append({'t': 'x'})
        elif isinstance(s, (ast.For, ast.AsyncFor)):
            expr(s.iter, out)
            b = []
            stmts(s.body, b); stmts(s.orelse, b)
            out.append({'t': 'l', 'b': b})
        elif isinstance(s, ast.While):
            expr(s.test, out)
            b = []
            stmts(s.body, b)
            out.append({'t': 'l', 'b': b})
        elif isinstance(s, ast.Try) or s.__class__.__name__ == 'TryStar':
            b, c, f = [], [], []
            stmts(s.body, b); stmts(s.orelse, b); stmts(s.finalbody, f)
            for h in s.handlers:
                hb = []
                stmts(h.body, hb); c.append(hb)
            out.append({'t': 't', 'b': b, 'c': c, 'f': f})
        elif isinstance(s, (ast.With, ast.AsyncWith)):
            for it in s.items: expr(it.context_expr, out)
            stmts(s.body, out)
        elif s.__class__.__name__ == 'Match':
            expr(s.subject, out)
            cs, d = [], False
            for cse in s.cases:
                if isinstance(cse.pattern, ast.MatchAs) and cse.pattern.pattern is None: d = True
                x = []
                stmts(cse.body, x); cs.append(x)
            out.append({'t': 's', 'cs': cs, 'd': d})
        elif isinstance(s, (ast.Expr, ast.Assign, ast.AugAssign, ast.AnnAssign)):
            expr(s.value, out)
        elif isinstance(s, ast.Assert):
            expr(s.test, out)

    def stmts(lst, out):
        for s in lst: stmt(s, out)

    def meaningful(nodes):
        for x in nodes:
            t = x['t']
            if t in ('c', 'w', 'r'): return True
            if t == 'if' and (meaningful(x['a']) or meaningful(x['b'])): return True
            if t == 'l' and meaningful(x['b']): return True
            if t == 't' and (meaningful(x['b']) or any(meaningful(c) for c in x['c']) or meaningful(x['f'])): return True
            if t == 's' and any(meaningful(c) for c in x['cs']): return True
        return False

    # ---- loops ----------------------------------------------------------------------------------------------------
    def reads_in(n, how, out):
        if n is None: return
        stack = [n]
        while stack:
            c = stack.pop()
            if isinstance(c, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): continue
            if isinstance(c, ast.Attribute) and is_self(c.value): out.append({'name': c.attr, 'line': c.lineno, 'how': how})
            stack.extend(ast.iter_child_nodes(c))

    def sleepy(call):
        return isinstance(call, ast.Call) and (call.args or call.keywords) and any(w in SLEEP_WORDS for w in words(callname(call)))

    def block_of(c):
        if isinstance(c, ast.Await):
            e = c.value
            if isinstance(e, ast.Call):
                name = callname(e)
                recv = chain(e.func.value, sn) if isinstance(e.func, ast.Attribute) else ''
                timed_arg = any(num_or_timey(a) for a in e.args) or any(k.arg == 'timeout' for k in e.keywords)
                return {'kind': 'await', 'name': name, 'recv': recv, 'line': c.lineno, 'timed': bool(sleepy(e)) or ((name in BLOCK_NAMES or bool(FETCHY.match(name))) and timed_arg)}
            return {'kind': 'await', 'name': '', 'recv': chain(e, sn), 'line': c.lineno, 'timed': False}
        if isinstance(c, ast.AsyncFor):
            return {'kind': 'for await', 'name': '', 'recv': chain(c.iter, sn), 'line': c.lineno, 'timed': False}
        if isinstance(c, ast.Call):
            name = callname(c)
            if sleepy(c):
                return {'kind': 'call', 'name': name, 'recv': '', 'line': c.lineno, 'timed': True}
            if isinstance(c.func, ast.Attribute):
                timed_arg = any(num_or_timey(a) for a in c.args) or any(k.arg == 'timeout' for k in c.keywords)
                if name in BLOCK_NAMES or (name == 'get' and not c.args) or FETCHY.match(name):
                    return {'kind': 'call', 'name': name, 'recv': chain(c.func.value, sn), 'line': c.lineno, 'timed': timed_arg}
        return None

    def blocks_in(body):
        out, awaited = [], set()
        stack = list(reversed(body))
        while stack:
            c = stack.pop()
            if isinstance(c, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): continue
            if id(c) not in awaited:
                b = block_of(c)
                if b:
                    out.append(b)
                    if isinstance(c, ast.Await): awaited.add(id(c.value))
            stack.extend(reversed(list(ast.iter_child_nodes(c))))
        return out

    def skips(body):
        return bool(body) and isinstance(body[-1], (ast.Continue, ast.Break, ast.Return))

    def loops(fn):
        out = []

        def visit(n):
            if isinstance(n, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n is not fn: return
            if isinstance(n, (ast.While, ast.For, ast.AsyncFor)):
                reads = []
                reads_in(n.test if isinstance(n, ast.While) else n.iter, 'condition', reads)
                for s in n.body:
                    if isinstance(s, ast.If) and skips(s.body): reads_in(s.test, 'guard', reads)
                blocks = blocks_in(n.body)
                if isinstance(n, ast.AsyncFor): blocks.append({'kind': 'for await', 'name': '', 'recv': chain(n.iter, sn), 'line': n.lineno, 'timed': False})
                seen, rr = set(), []
                for r in reads:
                    k = (r['name'], r['line'], r['how'])
                    if k not in seen: seen.add(k); rr.append(r)
                if rr and blocks: out.append({'line': n.lineno, 'end': n.end_lineno, 'kind': 'while' if isinstance(n, ast.While) else 'for', 'reads': rr, 'blocks': blocks[:8]})
            for ch in ast.iter_child_nodes(n): visit(ch)
        for s in fn.body: visit(s)
        return out

    def getter(fn):
        body = [s for s in fn.body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))]
        if len(body) == 1 and isinstance(body[0], ast.Return) and body[0].value is not None:
            r = []
            reads_in(body[0].value, 'getter', r)
            names = []
            for x in r:
                if x['name'] not in names: names.append(x['name'])
            return names[:4] or None
        return None

    def run(fn):
        out = {}
        sk = []
        stmts(fn.body, sk)
        if meaningful(sk): out['sk'] = sk
        lp = loops(fn)
        if lp: out['lp'] = lp
        gt = getter(fn)
        if gt: out['gt'] = gt
        return out
    return run


def analyze_method(fn, sn):
    if not sn: return {}
    return make(sn)(fn)
