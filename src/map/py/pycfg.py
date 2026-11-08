"""Python source -> per-function control-flow graph (the IR every later stage reads).

Node kinds: entry exit xexit block branch loop disp handler final return raise jump
Edge labels: seq T F done loop exc unmatched ret fin-ret fin-exc brk cont case nomatch
Exceptions: a node holding a call/await gets an `exc` edge to the innermost handler dispatch (disp).
Which exception type lands on which handler is decided later (excflow), not here.
"""
import ast
from pyops import Ops, dotted, unp, short, ret_sig, val_class, name_tok, rv_of

def const_truth(t):
    """True / False when a test is a constant (`if False:`, `while 0:`, `if not None:`), else None. Dead arms get no edge."""
    if isinstance(t, ast.Constant) and not isinstance(t.value, (str, bytes)) and t.value is not Ellipsis:
        return bool(t.value)
    if isinstance(t, ast.UnaryOp) and isinstance(t.op, ast.Not):
        v = const_truth(t.operand)
        return None if v is None else not v
    return None


RAISING = ('call', 'await', 'yield')     # a generator can be sent an exception at its yield (contextmanager bodies)
SUPPRESS = ('suppress', 'contextlib.suppress')


class FnBuilder:
    def __init__(self, node, path, qual, cls, lines):
        self.fn, self.path, self.qual, self.cls, self.lines = node, path, qual, cls, lines
        self.nodes, self.edges, self.nested = [], [], []
        self.xs, self.fin, self.loops, self.held, self.hstack = [], [], [], [], []
        self.rd = set()
        self.nheld = None                           # while the head of a `with` is built: the contexts outside it
        self.pend = {}                              # finally node -> [(jump kind, loop record)] break / continue passing through it
        self.entry = self.new('entry', getattr(node, 'lineno', 1), '')
        self.exit = self.new('exit', getattr(node, 'end_lineno', 1), '')
        self.xexit = self.new('xexit', getattr(node, 'lineno', 1), '')

    # ---- plumbing --------------------------------------------------------------------------
    def new(self, k, line, syn, eline=None, **kw):
        n = {'i': len(self.nodes), 'k': k, 'line': line, 'syn': syn}
        if eline and eline != line:
            n['eline'] = eline
        if self.hstack:
            n['h'] = self.hstack[-1]
        wh = self.nheld if self.nheld is not None else self.held
        if wh:
            n['w'] = list(wh)                    # the `with` contexts this node is inside: a context manager may swallow what is raised in its block
        if k == 'block' and self.cur_x() is not None:
            n['xc'] = self.cur_x()               # the exception context the block was made in: a block is only ever extended inside the same one
        n.update(kw)
        self.nodes.append(n)
        return n['i']

    def edge(self, a, b, lab):
        self.edges.append([a, b, lab])

    def conn(self, tails, n):
        for a, l in tails:
            self.edge(a, n, l)

    def cur_x(self):
        return self.xs[-1] if self.xs else None

    def ret_target(self):
        return self.fin[-1] if self.fin else self.exit

    def add_ops(self, n, ops):
        if not ops:
            return
        self.nodes[n].setdefault('ops', []).extend(ops)
        if any(o['t'] in RAISING for o in ops):
            x = self.cur_x()
            if x is not None:
                if not any(e[0] == n and e[1] == x and e[2] == 'exc' for e in self.edges[-6:]):
                    self.edge(n, x, 'exc')
            else:
                self.nodes[n]['esc'] = 1

    def ops_for(self, exprs, extra=None):
        o = Ops()
        for e in exprs:
            o.expr(e, self.held)
        self.rd |= o.rd
        return o

    # ---- statements ------------------------------------------------------------------------
    def seq(self, stmts, tails, path, elif_ctx=False):
        for i, s in enumerate(stmts):
            if not tails:
                break
            tails = self.stmt(s, tails, f'{path}{i}', 'elif' if (elif_ctx and i == 0 and isinstance(s, ast.If)) else 'if')
        return tails

    def simple(self, s, tails, path, ops):
        if len(tails) == 1 and tails[0][1] == 'seq' and self.nodes[tails[0][0]]['k'] == 'block' \
                and not self.nodes[tails[0][0]].get('seal') and self.nodes[tails[0][0]].get('h') == (self.hstack[-1] if self.hstack else None) \
                and self.nodes[tails[0][0]].get('xc') == self.cur_x() and (self.nodes[tails[0][0]].get('w') or []) == list(self.nheld if self.nheld is not None else self.held):
            n = tails[0][0]
            nd = self.nodes[n]
            nd['eline'] = getattr(s, 'end_lineno', s.lineno)
        else:
            n = self.new('block', s.lineno, path, getattr(s, 'end_lineno', None))
            self.conn(tails, n)
        self.add_ops(n, ops)
        return [(n, 'seq')]

    def stmt(self, s, tails, path, tk='if'):
        m = getattr(self, 's_' + type(s).__name__, None)
        if m:
            return m(s, tails, path, tk) if m.__code__.co_argcount == 5 else m(s, tails, path)
        return self.simple(s, tails, path, [])

    def s_Expr(self, s, tails, path):
        return self.simple(s, tails, path, self.ops_for([s.value]).ops)

    def s_Assign(self, s, tails, path):
        o = Ops()
        o.expr(s.value, self.held)
        for t in s.targets:
            o.target(t, s.value, self.held)
        self.rd |= o.rd
        return self.simple(s, tails, path, o.ops)

    def s_AnnAssign(self, s, tails, path):
        o = Ops()
        o.expr(s.value, self.held)
        if s.value is not None:
            o.target(s.target, s.value, self.held)
        self.rd |= o.rd
        return self.simple(s, tails, path, o.ops)

    def s_AugAssign(self, s, tails, path):
        o = Ops()
        o.expr(s.value, self.held)
        o.expr(s.target, self.held)
        o.target(s.target, s.value, self.held, aug=True)
        self.rd |= o.rd
        return self.simple(s, tails, path, o.ops)

    def s_Delete(self, s, tails, path):
        ops = [{'t': 'del', 'line': s.lineno, 'tgt': unp(t, 40)} for t in s.targets]
        return self.simple(s, tails, path, ops)

    def s_FunctionDef(self, s, tails, path):
        self.nested.append(s)
        return tails

    s_AsyncFunctionDef = s_FunctionDef

    def s_ClassDef(self, s, tails, path):
        self.nested.append(s)
        return tails

    def s_Return(self, s, tails, path):
        v = s.value
        if isinstance(v, ast.IfExp):
            b = self.new('branch', s.lineno, path, tk='ternary', test=unp(v.test, 70))
            self.conn(tails, b)
            self.add_ops(b, self.ops_for([v.test]).ops)
            for lab, arm in (('T', v.body), ('F', v.orelse)):
                r = self.new('return', s.lineno, path + lab, sig=ret_sig(arm), **rv_of(arm))
                self.edge(b, r, lab)
                self.add_ops(r, self.ops_for([arm]).ops)
                self.edge(r, self.ret_target(), 'ret')
            return []
        r = self.new('return', s.lineno, path, getattr(s, 'end_lineno', None), sig=ret_sig(v), **rv_of(v))
        self.conn(tails, r)
        if v is not None:
            self.add_ops(r, self.ops_for([v]).ops)
        t = self.ret_target()
        self.edge(r, t, 'ret' if t == self.exit else 'ret')
        return []

    def s_Raise(self, s, tails, path):
        exc, cause, ek = None, None, None
        if s.exc is not None:
            e = s.exc.func if isinstance(s.exc, ast.Call) else s.exc
            exc = dotted(e) or unp(e, 40)
            # what was raised, as written: a call `raise T(...)`, a bare name, an attribute, anything else. Whether the
            # text names a class (type) or a variable (rethrow, unknown type) is decided later, once classes are known.
            ek = 'call' if isinstance(s.exc, ast.Call) else 'name' if isinstance(e, ast.Name) else 'attr' if isinstance(e, ast.Attribute) else 'other'
        r = self.new('raise', s.lineno, path, getattr(s, 'end_lineno', None), exc=exc, ek=ek, sig='raise:' + (exc.split('.')[-1] if exc else 'reraise'))
        if s.cause is not None:
            self.nodes[r]['cause'] = unp(s.cause, 40)
        if s.exc is not None and isinstance(s.exc, ast.Call) and s.exc.args:
            a = s.exc.args[0]
            if isinstance(a, ast.Constant) and isinstance(a.value, str):
                self.nodes[r]['msg'] = short(a.value, 70)
        self.conn(tails, r)
        self.add_ops(r, self.ops_for([x for x in (s.exc, s.cause) if x is not None]).ops)
        x = self.cur_x()
        self.edge(r, x if x is not None else self.xexit, 'exc')
        return []

    def s_Assert(self, s, tails, path):
        b = self.new('branch', s.lineno, path, tk='assert', test=unp(s.test, 70))
        self.conn(tails, b)
        self.add_ops(b, self.ops_for([s.test]).ops)
        r = self.new('raise', s.lineno, path + 'F', exc='AssertionError', ek='name', sig='raise:AssertionError')
        self.edge(b, r, 'F')
        x = self.cur_x()
        self.edge(r, x if x is not None else self.xexit, 'exc')
        return [(b, 'T')]

    def jump_out(self, j, kind):
        """break / continue: straight to the loop, or, when a try-finally sits between the jump and the loop, through that finally first."""
        lp = self.loops[-1]
        if len(self.fin) > lp['fd']:
            fe = self.fin[-1]
            self.edge(j, fe, 'jmp')
            self.pend.setdefault(fe, []).append((kind, lp))
        elif kind == 'break':
            lp['brk'].append((j, 'brk'))
        else:
            self.edge(j, lp['head'], 'cont')

    def s_Break(self, s, tails, path):
        j = self.new('jump', s.lineno, path, jt='break')
        self.conn(tails, j)
        if self.loops:
            self.jump_out(j, 'break')
        return []

    def s_Continue(self, s, tails, path):
        j = self.new('jump', s.lineno, path, jt='continue')
        self.conn(tails, j)
        if self.loops:
            self.jump_out(j, 'continue')
        return []

    def s_If(self, s, tails, path, tk='if'):
        b = self.new('branch', s.lineno, path, tk=tk, test=unp(s.test, 90))
        if isinstance(s.test, ast.BoolOp):
            self.nodes[b]['terms'] = len(s.test.values)
        self.conn(tails, b)
        self.add_ops(b, self.ops_for([s.test]).ops)
        ct = const_truth(s.test)
        t = self.seq(s.body, [(b, 'T')], path + '/b') if ct is not False else []
        f = ([] if ct is True else self.seq(s.orelse, [(b, 'F')], path + '/e', elif_ctx=len(s.orelse) == 1)) if s.orelse else ([] if ct is True else [(b, 'F')])
        return t + f

    def loop(self, s, tails, path, tk, test, exprs):
        h = self.new('loop', s.lineno, path, tk=tk, test=test)
        self.conn(tails, h)
        self.add_ops(h, self.ops_for(exprs).ops)
        inf = tk == 'while' and isinstance(s.test, ast.Constant) and bool(s.test.value)
        if inf:
            self.nodes[h]['inf'] = 1
        self.loops.append({'head': h, 'brk': [], 'fd': len(self.fin)})
        dead = tk == 'while' and const_truth(s.test) is False
        bt = self.seq(s.body, [(h, 'T')], path + '/b') if not dead else []
        for a, l in bt:
            self.edge(a, h, l if l != 'seq' else 'loop')
        lp = self.loops.pop()
        done = [] if inf else self.seq(s.orelse, [(h, 'done')], path + '/e') if s.orelse else [(h, 'done')]
        return done + lp['brk']

    def s_While(self, s, tails, path):
        return self.loop(s, tails, path, 'while', unp(s.test, 80), [s.test])

    def s_For(self, s, tails, path):
        return self.loop(s, tails, path, 'for', f'{unp(s.target, 30)} in {unp(s.iter, 60)}', [s.iter])

    s_AsyncFor = s_For

    def s_With(self, s, tails, path):
        ops, pushed, supp = [], 0, None
        for it in s.items:
            ce = it.context_expr
            o = self.ops_for([ce]).ops
            f = dotted(ce.func) if isinstance(ce, ast.Call) else dotted(ce)
            ops += o
            wop = {'t': 'with', 'line': ce.lineno, 'ctx': unp(ce, 60), 'f': f, 'held': list(self.held), 'aw': isinstance(s, ast.AsyncWith), 'jp': path}
            if isinstance(it.optional_vars, ast.Name):
                wop['as'] = it.optional_vars.id
                if isinstance(ce, ast.Call) and f and f.rsplit('.', 1)[-1] == 'open':
                    m = ce.args[1] if len(ce.args) > 1 else next((k.value for k in ce.keywords if k.arg == 'mode'), None)
                    if isinstance(m, ast.Constant) and isinstance(m.value, str):
                        wop['mode'] = m.value
            nt = name_tok(ce.func) if isinstance(ce, ast.Call) else None
            if nt:
                wop['nl'], wop['nc'] = nt
            ops.append(wop)
            if f in SUPPRESS and isinstance(ce, ast.Call):
                supp = [dotted(a) or '?' for a in ce.args]
            self.held.append(unp(ce, 60))
            pushed += 1
        self.nheld = list(self.held[:len(self.held) - pushed])
        t = self.simple(s, tails, path, ops)
        self.nheld = None
        if supp is not None:
            return self.suppressed(s, t, path, supp)
        r = self.seq(s.body, t, path + '/b')
        del self.held[len(self.held) - pushed:]
        # the join: where control is when the block is left. It exists even when every path through the body returns or raises, because a manager
        # that swallows the exception makes the code after the `with` run; the rules add that edge once they know the manager (swallow.mjs)
        j = self.new('block', getattr(s, 'end_lineno', s.lineno), path + '/j', seal=1)
        self.conn(r, j)
        return [(j, 'seq')]

    s_AsyncWith = s_With

    def suppressed(self, s, tails, path, types):
        outer = self.cur_x()
        d = self.new('disp', s.lineno, path + '/d')
        self.xs.append(d)
        tb = self.new('block', s.lineno, path + '/tb')
        self.conn(tails, tb)
        bt = self.seq(s.body, [(tb, 'seq')], path + '/b')
        self.xs.pop()
        h = self.new('handler', s.lineno, path + '/h', types=types, var=None, synth='suppress')
        self.edge(d, h, 'exc')
        self.edge(d, outer if outer is not None else self.xexit, 'unmatched')
        for _ in range(len(s.items)):
            self.held.pop()
        return bt + [(h, 'seq')]

    def s_Match(self, s, tails, path):
        b = self.new('branch', s.lineno, path, tk='match', test=unp(s.subject, 70))
        self.conn(tails, b)
        self.add_ops(b, self.ops_for([s.subject]).ops)
        out, wild = [], False
        for j, c in enumerate(s.cases):
            if isinstance(c.pattern, ast.MatchAs) and c.pattern.pattern is None and c.guard is None:
                wild = True
            out += self.seq(c.body, [(b, f'c{j}')], f'{path}/c{j}')
        return out + ([] if wild else [(b, 'nomatch')])

    def s_Try(self, s, tails, path):
        outer = self.cur_x()
        has_fin = bool(s.finalbody)
        fe = self.new('final', s.finalbody[0].lineno if has_fin else s.lineno, path + '/f') if has_fin else None
        if has_fin:
            self.xs.append(fe)
            self.fin.append(fe)
        d = None
        if s.handlers:
            d = self.new('disp', s.lineno, path + '/d')
            self.xs.append(d)
        tb = self.new('block', s.lineno, path + '/tb')
        self.conn(tails, tb)
        bt = self.seq(s.body, [(tb, 'seq')], path + '/b')
        if d is not None:
            self.xs.pop()
        et = self.seq(s.orelse, bt, path + '/o') if s.orelse else bt
        ht = []
        for j, hd in enumerate(s.handlers):
            if hd.type is None:
                types = ['*']
            elif isinstance(hd.type, ast.Tuple):
                types = [dotted(e) or unp(e, 30) for e in hd.type.elts]
            else:
                types = [dotted(hd.type) or unp(hd.type, 30)]
            hn = self.new('handler', hd.lineno, f'{path}/h{j}', getattr(hd, 'end_lineno', None), types=types, var=hd.name,
                          **({'star': 1} if type(s).__name__ == 'TryStar' else {}),
                          **({'uses': 1} if hd.name and any(isinstance(w, ast.Name) and w.id == hd.name and isinstance(w.ctx, ast.Load) for b in hd.body for w in ast.walk(b)) else {}))
            self.edge(d, hn, 'exc')
            self.hstack.append(hn)
            ht += self.seq(hd.body, [(hn, 'seq')], f'{path}/h{j}/b')
            self.hstack.pop()
        if d is not None:
            tgt = fe if has_fin else outer
            self.edge(d, tgt if tgt is not None else self.xexit, 'unmatched')
        normal = et + ht
        if not has_fin:
            return normal
        self.xs.pop()
        self.fin.pop()
        self.conn(normal, fe)
        ft = self.seq(s.finalbody, [(fe, 'seq')], path + '/f')
        into = [e for e in self.edges if e[1] == fe]
        if any(e[2] in ('ret', 'fin-ret') for e in into):          # a return that came out of an inner finally reaches this one by `fin-ret`
            for a, l in ft:
                self.edge(a, self.ret_target(), 'fin-ret')
        if any(e[2] in ('exc', 'unmatched') for e in into):
            for a, l in ft:
                self.edge(a, outer if outer is not None else self.xexit, 'fin-exc')
        for kind, lp in self.pend.pop(fe, []):            # a break / continue that went through this finally leaves it by the same door
            for a, l in ft:
                if len(self.fin) > lp['fd']:
                    self.edge(a, self.fin[-1], 'jmp')
                elif kind == 'break':
                    lp['brk'].append((a, 'brk'))
                else:
                    self.edge(a, lp['head'], 'cont')
            if len(self.fin) > lp['fd']:
                self.pend.setdefault(self.fin[-1], []).append((kind, lp))
        for a, l in ft:                                   # the statement after a try must never be folded into the finally's last block
            if self.nodes[a]['k'] == 'block':
                self.nodes[a]['seal'] = 1
        return ft if normal else []

    s_TryStar = s_Try


def scope_names(node):
    """Names bound in a function's own scope (parameters, assignments, loop and with targets, except-as, walrus, local imports, nested defs)
    minus global / nonlocal declarations; and the function-local imports as {name: entry}. Nested function scopes are not entered, but their
    names (def / class) are bound here. Lambdas and comprehensions: a walrus inside a comprehension binds here, nothing else does."""
    bound, imps, decl = set(), {}, set()

    def tgt(t):
        for n in ast.walk(t):
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
                bound.add(n.id)

    def walk(n, top=False):
        for c in ast.iter_child_nodes(n):
            if isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue                      # a nested def / class is found by scope (the module-level function table), it does not shadow
            if isinstance(c, ast.Lambda):
                for w in ast.walk(c):
                    if isinstance(w, ast.NamedExpr) and isinstance(w.target, ast.Name):
                        pass
                continue
            if isinstance(c, (ast.Global, ast.Nonlocal)):
                decl.update(c.names)
            elif isinstance(c, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
                for t in (c.targets if isinstance(c, ast.Assign) else [c.target]):
                    tgt(t)
            elif isinstance(c, (ast.For, ast.AsyncFor)):
                tgt(c.target)
            elif isinstance(c, (ast.With, ast.AsyncWith)):
                for it in c.items:
                    if it.optional_vars is not None:
                        tgt(it.optional_vars)
            elif isinstance(c, ast.ExceptHandler) and c.name:
                bound.add(c.name)
            elif isinstance(c, ast.NamedExpr) and isinstance(c.target, ast.Name):
                bound.add(c.target.id)
            elif isinstance(c, ast.Import):
                for a in c.names:
                    nm = a.asname or a.name.split('.')[0]
                    imps[nm] = ('mod', a.name if a.asname else a.name.split('.')[0])
            elif isinstance(c, ast.ImportFrom):
                for a in c.names:
                    if a.name != '*':
                        imps[a.asname or a.name] = ('name', c.module or '', a.name, c.level)
            walk(c)
    walk(node, True)
    return sorted(bound - decl), imps


def def_name_col(node, lines):
    """UTF-16 column of the NAME token of a def / class statement, from the source line (a language server answers at that token)."""
    try:
        import re
        txt = lines[node.lineno - 1]
        m = re.search(r'(?:\bdef|\bclass)\s+(\w+)', txt)
        if not m:
            return None
        return len(txt[:m.start(1)].encode('utf-16-le')) // 2
    except Exception:
        return None


def local_classes(fn):
    """Names of the classes defined inside this function's own scope: an `except` type of that name is the local class, not a module-level one."""
    out, stack = set(), list(fn.body)
    while stack:
        n = stack.pop()
        if isinstance(n, ast.ClassDef):
            out.add(n.name)
            continue
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        stack.extend(ast.iter_child_nodes(n))
    return sorted(out)


def has_yield(fn):
    """Does the body of this function (not of a function nested in it) contain a yield?"""
    stack = list(fn.body)
    while stack:
        n = stack.pop()
        if isinstance(n, (ast.Yield, ast.YieldFrom)):
            return True
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue
        stack.extend(ast.iter_child_nodes(n))
    return False


def build_function(node, path, qual, cls, lines, mod_level=False, selfcls=None):
    b = FnBuilder(node, path, qual, cls, lines)
    body = node.body if hasattr(node, 'body') else []
    if isinstance(node, ast.Module):
        body = node.body
    tails = b.seq(body, [(b.entry, 'seq')], '')
    b.conn(tails, b.exit)
    args = getattr(node, 'args', None)
    params = []
    if args is not None:
        for a in args.posonlyargs + args.args + args.kwonlyargs:
            params.append([a.arg, unp(a.annotation, 50) if a.annotation is not None else ''])
        if args.vararg:
            params.append(['*' + args.vararg.arg, ''])
        if args.kwarg:
            params.append(['**' + args.kwarg.arg, ''])
    rec = {'id': f'{path}::{qual}', 'path': path, 'qual': qual, 'cls': cls, 'lang': 'py',
           'line': getattr(node, 'lineno', 1), 'end': getattr(node, 'end_lineno', len(lines)),
           'async': isinstance(node, ast.AsyncFunctionDef), 'params': params,
           'decos': [unp(d, 40) for d in getattr(node, 'decorator_list', [])],
           'nodes': b.nodes, 'edges': b.edges, 'rd': sorted(b.rd), 'entry': b.entry, 'exit': b.exit, 'xexit': b.xexit}
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and local_classes(node):
        rec['lcls'] = local_classes(node)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and has_yield(node):
        rec['gen'] = True                              # a generator function: calling it runs none of its body (a yield after a raise is not in the graph, so the tree says)
    if hasattr(node, 'lineno') and not isinstance(node, ast.Module):
        rec['ncol'] = def_name_col(node, lines)
        loc, limp = scope_names(node)
        pn = {p[0].lstrip('*') for p in params}
        rec['locs'] = sorted(set(loc) | pn)
        if limp:
            rec['limp'] = {k: list(v) for k, v in sorted(limp.items())}
    elif isinstance(node, ast.Module):
        rec['locs'] = []
    if cls is None and selfcls:
        rec['selfcls'] = selfcls                       # a function nested in a method: `self.x = ...` in it belongs to the method's class
    return rec, b.nested
