"""Pass 2 of the Python reader: one function's facts (calls, branches, returns, raises, excepts, loops, retry hints)."""
import ast
import hashlib
import re

from py_calls import CallMixin
from py_rules import (ATTEMPT_RE, EXC_BROAD, STDLIB_PARENTS, const_str, dotted, is_label, is_true_const, mentions_count,
                      node_text, short, slot_of, terminal_kind, test_kind, type_names)

TryStar = getattr(ast, 'TryStar', ast.Try)
MatchT = getattr(ast, 'Match', None)
LOGGY = re.compile(r'^(?:log|logger|logging|_log|print|warnings?)\b|\.(?:debug|info|warning|warn|error|exception|critical|log)$')


def body_range(stmts):
    return [stmts[0].lineno, stmts[-1].end_lineno] if stmts else None


def norm_hash(lines, a, b):
    keep = [ln.rstrip() for ln in lines[a - 1:b] if ln.strip() and not ln.lstrip().startswith('#')]
    return hashlib.sha256('\n'.join(keep).encode('utf-8', 'replace')).hexdigest()[:16]


class FnScan(CallMixin):
    def __init__(self, ix, mi, lines, d, acc, children, is_module=False):
        self.ix, self.mi, self.lines, self.acc = ix, mi, lines, acc
        self.d, self.node, self.is_module = d, d.node, is_module
        self.qual = d.qual
        self.fn_id = '%s::%s' % (mi.path, d.qual)
        self.cls_qual = d.cls
        self.binds, self.types, self.params, self.localnames = {}, {}, set(), set()
        self.param_funcs = {}
        self.self_name = None
        self.scopes = []
        q = d.qual
        while q:
            if q in children:
                self.scopes.append(children[q])
            q = q.rsplit('.', 1)[0] if '.' in q else None
        if d.parent and d.parent in children:
            self.scopes.append(children[d.parent])
        self.call_idx, self.call_at, self.unres, self.weak = {}, [], [], []
        self.branches, self.returns, self.raises, self.excepts, self.loop_rows = [], [], [], [], []
        self.hints, self.emits, self.exits, self.recursive = [], [], [], []
        self.loops, self.try_stack, self.in_handler = [], [], 0
        self.ctx_cmp, self.ctx_cast = {}, {}
        self.str_assigns, self.var_returns = {}, []
        self.ret_calls = set()
        if not is_module:
            self._params()

    def _params(self):
        a = self.node.args
        allargs = a.posonlyargs + a.args + a.kwonlyargs
        pos = a.posonlyargs + a.args
        defaults = list(zip(pos[len(pos) - len(a.defaults):], a.defaults)) + list(zip(a.kwonlyargs, a.kw_defaults))
        for x, dv in defaults:
            if dv is not None and dotted(dv):
                fid = self.ix.resolve_func(self.mi, dotted(dv))
                if fid:
                    self.param_funcs[x.arg] = fid
        for x in allargs + [y for y in (a.vararg, a.kwarg) if y]:
            self.params.add(x.arg)
            self.localnames.add(x.arg)
            for tn in type_names(x.annotation):
                t = self.ix.resolve_class(self.mi, tn)
                if t:
                    self.types[x.arg] = t
                    break
        if self.cls_qual and a.args and self.d.qual.rsplit('.', 1)[0] == self.cls_qual:
            self.self_name = a.args[0].arg
            self.types.pop(self.self_name, None)

    # ---- run ---------------------------------------------------------------
    def run(self):
        node = self.node
        if not self.is_module:
            for dec in node.decorator_list:
                t = (dotted(dec.func) if isinstance(dec, ast.Call) else dotted(dec)) or ''
                if re.search(r'retry|retries|backoff|tenacity', t, re.I):
                    self.hint(dec.lineno, 'decorated with @%s' % t.split('.')[-1])
        self.visit(node.body)
        for line, var in self.var_returns:
            for aline, val in self.str_assigns.get(var, []):
                self.add_emit(aline, 'return', None, val, via='var:' + var)
        return self.record()

    def record(self):
        n = self.node
        if self.is_module:
            line, end = 1, len(self.lines)
            sha = hashlib.sha256(self.mi.path.encode()).hexdigest()[:16]
            deco, doc, isasync = [], '', False
        else:
            first = min([n.lineno] + [x.lineno for x in n.decorator_list])
            line, end = n.lineno, n.end_lineno
            sha = norm_hash(self.lines, first, end)
            deco = [node_text(self.lines, x, 60) for x in n.decorator_list]
            doc = short((ast.get_docstring(n) or '').strip().split('\n')[0], 120)
            isasync = isinstance(n, ast.AsyncFunctionDef)
        calls = list(self.call_idx)
        if self.recursive and not self.is_module:
            self.loop_rows.append({'line': self.recursive[0], 'end': self.recursive[0], 'kind': 'recursion',
                                   'bounded': self.rec_bounded(), 'why': self.rec_why})
        rec = {'path': self.mi.path, 'qual': self.qual, 'line': line, 'end': end, 'sha256': sha, 'doc': doc,
               'async': isasync, 'decorators': deco, 'calls': [c for c in calls if c != self.fn_id],
               'unresolved': sorted({u for u in self.unres if u.split('.')[0] not in self.localnames or u.startswith('self.')})[:20],
               'branches': self.branches[:400], 'returns': self.returns[:300], 'raises': self.raises[:200],
               'excepts': self.excepts[:100], 'loops': self.loop_rows[:100], 'retryHints': self.hints}
        idx = {c: i for i, c in enumerate(rec['calls'])}
        if self.call_at:
            rec['callAt'] = [[idx[calls[r[0]]]] + r[1:] for r in self.call_at if calls[r[0]] in idx][:600]
        if self.weak:
            rec['weakCalls'] = [w for w in self.weak if w != self.fn_id][:30]
        if self.emits:
            rec['emits'] = self.emits[:200]
        if self.exits:
            rec['exits'] = self.exits[:20]
        return rec

    def rec_bounded(self):
        for b in self.branches:
            if b['kind'] in ('if', 'elif') and re.search(r'depth|level|limit|max|remaining|budget|hops', b['test'], re.I):
                self.rec_why = 'a test on depth, level or limit near line %d' % b['line']
                return True
        self.rec_why = 'calls itself; no depth or limit test seen'
        return False

    # ---- statements --------------------------------------------------------
    def visit(self, stmts):
        for s in stmts:
            m = getattr(self, 'v_' + type(s).__name__, None)
            if m:
                m(s)
            elif not isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Pass, ast.Break,
                                    ast.Continue, ast.Global, ast.Nonlocal)):
                self.scan_children(s)

    def scan_children(self, s):
        for c in ast.iter_child_nodes(s):
            if isinstance(c, ast.stmt):
                self.visit([c])
            else:
                self.expr(c)

    def v_Import(self, s):
        self.ix.bind_import(self.mi, s, self.binds, [])

    v_ImportFrom = v_Import

    def v_Expr(self, s):
        self.expr(s.value)

    def v_Return(self, s):
        v = s.value
        if len(self.returns) < 300:
            self.returns.append({'line': s.lineno, 'expr': node_text(self.lines, v, 80) if v is not None else ''})
        if v is not None:
            self.emit_value(v, s.lineno, 'return', None)
            self.expr(v)

    def v_Raise(self, s):
        exc = s.exc
        typ, msg = '(reraise)', ''
        if exc is not None:
            self.expr(exc)
            tgt = exc.func if isinstance(exc, ast.Call) else exc
            typ = (dotted(tgt) or node_text(self.lines, tgt, 40)).split('.')[-1] or '(dynamic)'
            if isinstance(exc, ast.Call) and exc.args:
                msg = const_str(exc.args[0]) or ''
                if not msg and isinstance(exc.args[0], ast.JoinedStr):
                    msg = node_text(self.lines, exc.args[0], 60)
        if typ == 'SystemExit':
            self.exits.append({'line': s.lineno, 'via': 'raise SystemExit', 'code': ''})
        if len(self.raises) < 200:
            row = {'line': s.lineno, 'type': typ, 'caught': self.is_caught(typ)}
            if msg:
                row['msg'] = short(msg, 60)
            self.raises.append(row)

    def is_caught(self, typ):
        if typ == '(reraise)':
            return False
        for fr in self.try_stack:
            if '*' in fr or typ in fr:
                return True
            p = STDLIB_PARENTS.get(typ)
            while p:
                if p in fr:
                    return True
                p = STDLIB_PARENTS.get(p)
        return False

    def v_Assign(self, s):
        self.expr(s.value)
        for t in s.targets:
            self.expr(t)
            self.after_assign(t, s.value, s.lineno)

    def v_AnnAssign(self, s):
        if s.value is not None:
            self.expr(s.value)
        self.expr(s.target)
        if isinstance(s.target, ast.Name):
            for tn in type_names(s.annotation):
                t = self.ix.resolve_class(self.mi, tn, binds=self.binds)
                if t:
                    self.types[s.target.id] = t
                    break
        if s.value is not None:
            self.after_assign(s.target, s.value, s.lineno)

    def v_AugAssign(self, s):
        self.expr(s.value)
        self.expr(s.target)
        nm = s.target.id if isinstance(s.target, ast.Name) else getattr(s.target, 'attr', '')
        if self.loops and nm and ATTEMPT_RE.search(nm):
            self.hint(s.lineno, "counter '%s' changes inside a loop" % nm)

    def after_assign(self, t, v, line):
        slot = slot_of(t)
        if slot:
            self.emit_value(v, line, 'assign', slot)
        nm = t.id if isinstance(t, ast.Name) else None
        if nm is None:
            return
        if self.loops and ATTEMPT_RE.search(nm) and not isinstance(v, ast.Constant):
            self.hint(line, "counter '%s' changes inside a loop" % nm)
        for arm in self.choices(v):
            if isinstance(arm, ast.Constant) and isinstance(arm.value, str) and is_label(arm.value):
                self.str_assigns.setdefault(nm, []).append((line, arm.value))
        if isinstance(v, ast.Call) and dotted(v.func):
            c = self.ix.resolve_class(self.mi, dotted(v.func), binds=self.binds)
            if c and self.ix.lookup(self.mi.path, dotted(v.func).split('.')[0], binds=self.binds):
                self.types[nm] = c
        elif isinstance(v, ast.Attribute) and isinstance(v.value, ast.Name) and v.value.id in ('self', 'cls') and self.cls_qual:
            c = self.ix.class_attr_type(self.mi.path, self.cls_qual, v.attr)
            if c:
                self.types[nm] = c

    def choices(self, v):
        if isinstance(v, ast.IfExp):
            return self.choices(v.body) + self.choices(v.orelse)
        return [v]

    def v_With(self, s):
        for it in s.items:
            self.expr(it.context_expr)
            ov = it.optional_vars
            if isinstance(ov, ast.Name):
                self.localnames.add(ov.id)
                if isinstance(it.context_expr, ast.Call) and dotted(it.context_expr.func):
                    c = self.ix.resolve_class(self.mi, dotted(it.context_expr.func), binds=self.binds)
                    if c:
                        self.types[ov.id] = c
        self.visit(s.body)

    v_AsyncWith = v_With

    def v_If(self, s, is_elif=False):
        if self.is_module and not is_elif and self.main_guard(s):
            return
        self.expr(s.test)
        els, ek = None, 'none'
        if s.orelse:
            if len(s.orelse) == 1 and isinstance(s.orelse[0], ast.If):
                els, ek = [s.orelse[0].lineno, s.orelse[0].end_lineno], 'elif'
            else:
                els, ek = body_range(s.orelse), terminal_kind(s.orelse)
        row = {'line': s.lineno, 'kind': 'elif' if is_elif else 'if', 'test': node_text(self.lines, s.test, 80),
               'end': s.end_lineno, 'then': body_range(s.body), 'tk': test_kind(s.test), 'tt': terminal_kind(s.body), 'et': ek}
        if els:
            row['else'] = els
        if len(self.branches) < 400:
            self.branches.append(row)
        self.visit(s.body)
        if ek == 'elif':
            self.v_If(s.orelse[0], True)
        else:
            self.visit(s.orelse)

    def main_guard(self, s):
        t = s.test
        if not (isinstance(t, ast.Compare) and isinstance(t.left, ast.Name) and t.left.id == '__name__'
                and t.comparators and const_str(t.comparators[0]) == '__main__'):
            return False
        found = False
        for n in ast.walk(ast.Module(body=s.body, type_ignores=[])):
            if isinstance(n, ast.Call):
                fid, st = self.resolve(n.func)
                if fid and st == 'ok':
                    self.acc.entries.append({'fn': fid, 'kind': 'main', 'why': 'if __name__ guard (line %d)' % s.lineno})
                    found = True
        if not found:
            self.acc.entries.append({'fn': self.fn_id, 'kind': 'main', 'why': 'if __name__ guard (line %d), inline code' % s.lineno})
        self.visit(s.body)
        return True

    def v_Try(self, s):
        types = []
        for h in s.handlers:
            types += self.handler_types(h)
        if s.handlers:
            hs = [s.handlers[0].lineno, s.handlers[-1].end_lineno]
            self.branches.append({'line': s.lineno, 'kind': 'try', 'test': short('except ' + ', '.join(types), 80),
                                  'end': s.end_lineno, 'then': body_range(s.body), 'else': hs, 'tk': 'try',
                                  'tt': terminal_kind(s.body), 'et': terminal_kind(s.handlers[-1].body)})
        self.try_stack.append(frozenset('*' if t in EXC_BROAD else t for t in types))
        self.visit(s.body)
        self.try_stack.pop()
        for h in s.handlers:
            self.v_handler(h, types)
        self.visit(s.orelse)
        self.visit(s.finalbody)

    v_TryStar = v_Try

    def handler_types(self, h):
        if h.type is None:
            return ['(bare)']
        elts = h.type.elts if isinstance(h.type, ast.Tuple) else [h.type]
        return [(dotted(e) or node_text(self.lines, e, 30)).split('.')[-1] for e in elts]

    def v_handler(self, h, _all):
        types = self.handler_types(h)
        body = h.body
        has_raise = any(isinstance(n, ast.Raise) for st in body for n in self.walk_no_defs(st))
        silent = all(isinstance(st, (ast.Pass, ast.Continue)) or
                     (isinstance(st, ast.Expr) and isinstance(st.value, ast.Call) and LOGGY.search(dotted(st.value.func) or ''))
                     or (isinstance(st, ast.Expr) and isinstance(st.value, ast.Constant)) or
                     (isinstance(st, ast.Return) and (st.value is None or isinstance(st.value, ast.Constant)))
                     for st in body)
        if len(self.excepts) < 100:
            self.excepts.append({'line': h.lineno, 'type': '|'.join(types), 'swallows': not has_raise,
                                 'broad': any(t in EXC_BROAD for t in types), 'silent': bool(silent and not has_raise),
                                 'end': h.end_lineno})
        if h.name:
            self.localnames.add(h.name)
        if self.loops and any(isinstance(n, ast.Continue) for st in body for n in self.walk_no_defs(st)):
            self.hint(h.lineno, 'except clause then continue inside a loop')
        self.in_handler += 1
        self.visit(body)
        self.in_handler -= 1

    def walk_no_defs(self, node):
        stack = [node]
        while stack:
            n = stack.pop()
            yield n
            for c in ast.iter_child_nodes(n):
                if not isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                    stack.append(c)

    def v_For(self, s):
        self.expr(s.iter)
        self.expr(s.target)
        bounded, why = True, 'for over a collection or range'
        it = s.iter
        d = dotted(it.func) if isinstance(it, ast.Call) else None
        if d in ('itertools.count', 'count', 'itertools.cycle', 'cycle'):
            bounded, why = False, 'for over an endless iterator (%s)' % d
        elif d == 'iter' and isinstance(it, ast.Call) and len(it.args) == 2:
            bounded, why = False, 'iter(callable, sentinel) runs until the sentinel appears'
        if isinstance(s.target, ast.Name) and ATTEMPT_RE.search(s.target.id):
            self.hint(s.lineno, "loop variable '%s' counts tries" % s.target.id)
        self.loop_rows.append({'line': s.lineno, 'end': s.end_lineno, 'kind': 'for', 'bounded': bounded, 'why': why,
                               'test': node_text(self.lines, it, 50)})
        self.loops.append(1)
        self.visit(s.body)
        self.loops.pop()
        self.visit(s.orelse)

    v_AsyncFor = v_For

    def v_While(self, s):
        self.expr(s.test)
        t = s.test
        if is_true_const(t):
            bounded, why = self.const_while(s)
        elif mentions_count(t):
            bounded, why = True, 'test compares against a count, limit or deadline'
        else:
            bounded, why = False, 'no count or limit in the loop test'
            exits = []
            self.loop_exits(s.body, [], 0, exits)
            for xl, guards in exits:
                if any(mentions_count(g) for g in guards):
                    bounded, why = True, 'exit at line %d is guarded by a count, limit or deadline' % xl
                    break
        self.loop_rows.append({'line': s.lineno, 'end': s.end_lineno, 'kind': 'while', 'bounded': bounded, 'why': why,
                               'test': node_text(self.lines, t, 50)})
        self.loops.append(1)
        self.visit(s.body)
        self.loops.pop()
        self.visit(s.orelse)

    def const_while(self, s):
        exits = []
        self.loop_exits(s.body, [], 0, exits)
        if not exits:
            return False, 'while True with no exit'
        for line, guards in exits:
            if any(mentions_count(g) for g in guards):
                return True, 'exit at line %d is guarded by a count, limit or deadline' % line
        line, guards = exits[0]
        cond = node_text(self.lines, guards[-1], 40) if guards else 'success'
        return False, 'while True; exits only on %s (line %d), no count or limit' % (cond, line)

    def loop_exits(self, stmts, guards, depth, out):
        for s in stmts:
            if isinstance(s, (ast.Return, ast.Raise)) or (isinstance(s, ast.Break) and depth == 0):
                out.append((s.lineno, list(guards)))
            elif isinstance(s, ast.If):
                self.loop_exits(s.body, guards + [s.test], depth, out)
                self.loop_exits(s.orelse, guards + [s.test], depth, out)
            elif isinstance(s, (ast.For, ast.AsyncFor, ast.While)):
                self.loop_exits(s.body, guards, depth + 1, out)
            elif isinstance(s, (ast.Try, TryStar)):
                for blk in (s.body, s.orelse, s.finalbody):
                    self.loop_exits(blk, guards, depth, out)
                for h in s.handlers:
                    self.loop_exits(h.body, guards, depth, out)
            elif isinstance(s, (ast.With, ast.AsyncWith)):
                self.loop_exits(s.body, guards, depth, out)
            elif isinstance(s, ast.Expr) and isinstance(s.value, ast.Call) and dotted(s.value.func) in ('sys.exit', 'exit', 'quit'):
                out.append((s.lineno, list(guards)))

    def v_Match(self, s):
        self.expr(s.subject)
        last = s.cases[-1].body if s.cases else []
        self.branches.append({'line': s.lineno, 'kind': 'match', 'test': node_text(self.lines, s.subject, 80),
                              'end': s.end_lineno, 'then': [s.cases[0].pattern.lineno, s.end_lineno] if s.cases else None,
                              'tk': 'match', 'tt': 'other', 'et': terminal_kind(last), 'cases': len(s.cases)})
        for c in s.cases:
            if c.guard is not None:
                self.expr(c.guard)
            self.visit(c.body)

    # ---- expressions -------------------------------------------------------
    def expr(self, node):
        stack = [node]
        while stack:
            n = stack.pop()
            t = type(n)
            if t is ast.Call:
                self.on_cast(n)
                self.on_call(n)
            elif t is ast.IfExp:
                self.on_ifexp(n)
            elif t is ast.Subscript:
                self.on_subscript(n)
            elif t is ast.Compare:
                self.on_compare(n)
            elif t is ast.Attribute:
                self.on_attr(n)
            elif t is ast.Name:
                if isinstance(n.ctx, ast.Store):
                    self.localnames.add(n.id)
            elif t is ast.arg:
                self.localnames.add(n.arg)
            elif t is ast.NamedExpr:
                self.localnames.add(n.target.id)
            kids = list(ast.iter_child_nodes(n))
            kids.reverse()
            stack.extend(kids)

    def on_ifexp(self, n):
        if len(self.branches) < 400:
            self.branches.append({'line': n.lineno, 'kind': 'ternary', 'test': node_text(self.lines, n.test, 80),
                                  'end': n.end_lineno, 'then': [n.body.lineno, n.body.end_lineno],
                                  'else': [n.orelse.lineno, n.orelse.end_lineno], 'tk': test_kind(n.test),
                                  'tt': 'other', 'et': 'other'})

    def on_attr(self, n):
        v = n.value
        base = v.id if isinstance(v, ast.Name) else (v.attr if isinstance(v, ast.Attribute) else None)
        if base in self.ix.enum_names:
            key = base + '.' + n.attr
            self.acc.enum_uses[key] = self.acc.enum_uses.get(key, 0) + 1

    # ---- emits -------------------------------------------------------------
    def enum_member(self, v):
        while isinstance(v, ast.Attribute) and v.attr in ('value', 'name') and isinstance(v.value, ast.Attribute):
            v = v.value
        d = dotted(v) if isinstance(v, ast.Attribute) else None
        if d:
            parts = d.split('.')
            if len(parts) >= 2 and parts[-2] in self.ix.enum_names:
                return parts[-2], parts[-1]
        return None

    def add_emit(self, line, kind, slot, value=None, enum=None, member=None, via=None):
        row = {'line': line, 'kind': kind}
        if slot:
            row['slot'] = slot
        if value is not None:
            row['value'] = value
        if enum:
            row['enum'], row['member'] = enum, member
        if via:
            row['via'] = via
        if row not in self.emits:
            self.emits.append(row)

    def emit_value(self, v, line, kind, slot):
        if v is None:
            return
        if isinstance(v, ast.Constant):
            if isinstance(v.value, str) and is_label(v.value):
                self.add_emit(line, kind, slot, v.value)
        elif isinstance(v, ast.IfExp):
            self.emit_value(v.body, line, kind, slot)
            self.emit_value(v.orelse, line, kind, slot)
        elif isinstance(v, ast.Tuple) and kind == 'return' and 2 <= len(v.elts) <= 3 and not all(isinstance(x, ast.Constant) and isinstance(x.value, str) for x in v.elts):
            self.emit_value(v.elts[0], line, 'tuple', slot)
        elif isinstance(v, ast.Dict) and kind in ('return', 'assign'):
            for k, val in zip(v.keys, v.values):
                ks = const_str(k)
                if ks and slot_of(ast.Name(id=ks)):
                    self.emit_value(val, val.lineno, 'dict', ks.lstrip('_'))
        elif isinstance(v, ast.Call) and kind == 'return':
            self.ret_calls.add(id(v))
        elif isinstance(v, ast.Attribute):
            m = self.enum_member(v)
            if m:
                self.add_emit(line, kind, slot, enum=m[0], member=m[1])
        elif isinstance(v, ast.Name) and kind == 'return':
            self.var_returns.append((line, v.id))
