"""Call-site rules for the Python reader: resolve what a call reaches, and spot switches, exits, retries and entries."""
import ast
import re

from py_rules import (BUILTINS, EXIT_CALLS, PLAIN_METHODS, SLEEPY, ATTEMPT_RE, SLOT_RE, chain, const_str, dotted,
                      is_label, lit_text, node_text, short)

EXT = ('ext',)
WRAPPER_ENV = re.compile(r'^_?(?:env|getenv|get_env|read_env|env_(?:str|int|float|bool|flag|list|path)|'
                         r'getenv_(?:str|int|float|bool))$')
UPPER = re.compile(r'^[A-Z][A-Z0-9_]{2,}$')
CONFIG_ROOT = re.compile(r'^_?(?:config|settings|cfg|conf|options|opts|flags|features)$', re.I)
FLAG_CALL = re.compile(r'^(?:is_|has_)?(?:feature|flag)\w*$|^(?:is_enabled|flag_enabled|feature_enabled|variation|'
                       r'get_flag|check_flag|is_on)$', re.I)
CTOR_OUT = re.compile(r'(?:Result|Outcome|Status|Verdict|Decision|Response)$')
ROUTE_ADD = {'add_get', 'add_post', 'add_put', 'add_delete', 'add_patch', 'add_route', 'add_view', 'add_url_rule',
             'add_api_route', 'add_api_websocket_route', 'add_websocket_route', 'add_head'}
SCHED_ADD = {'add_job', 'do', 'call_later', 'call_soon', 'call_at', 'register', 'run_repeating', 'run_daily',
             'run_once', 'add_signal_handler', 'signal'}


class CallMixin:
    # ---- resolution --------------------------------------------------------
    def resolve(self, f):
        """-> (fn id or None, status) where status is ok|ext|builtin|local|unres|weak."""
        base, attrs = chain(f)
        if isinstance(base, ast.Name):
            return self.resolve_name(base.id, attrs)
        if isinstance(base, ast.Call):
            inner = dotted(base.func)
            if inner == 'super' and attrs and self.cls_qual:
                ci = self.mi.classes.get(self.cls_qual)
                for b in (ci.bases if ci else []):
                    bc = self.ix.resolve_class(self.mi, b)
                    r = bc and self.walk_type(bc, attrs)
                    if r:
                        return r, 'ok'
                return None, 'local'
            if inner and attrs:
                t = self.ix.resolve_class(self.mi, inner, binds=self.binds)
                if t:
                    r = self.walk_type(t, attrs)
                    return (r, 'ok') if r else (None, 'local')
        return None, 'local'

    def walk_type(self, t, attrs):
        """Follow attribute types along attrs[:-1], then find method attrs[-1]."""
        if not attrs:
            return None
        for a in attrs[:-1]:
            t = self.ix.class_attr_type(t[0], t[1], a)
            if t is None:
                return None
        return self.ix.find_method(t[0], t[1], attrs[-1])

    def ctor(self, path, cq):
        return self.ix.find_method(path, cq, '__init__')

    def resolve_name(self, r, attrs):
        ix, mi = self.ix, self.mi
        if not attrs:
            for sc in self.scopes:
                if r in sc:
                    return '%s::%s' % (mi.path, sc[r]), 'ok'
            if r in self.params and r not in self.binds:
                return (self.param_funcs[r], 'ok') if r in self.param_funcs else (None, 'local')
            res = ix.lookup(mi.path, r, binds=self.binds)
            if res is None:
                return (None, 'builtin') if r in BUILTINS else (None, 'unres')
            if res[0] == 'func':
                return res[1], 'ok'
            if res[0] == 'class':
                c = self.ctor(res[1], res[2])
                return (c, 'ok') if c else (None, 'local')
            if res[0] == 'inst':
                return ix.find_method(res[1], res[2], '__call__'), 'ok'
            return (None, 'ext') if res[0] == 'ext' else (None, 'local')
        if r in ('self', 'cls') or r == self.self_name:
            if not self.cls_qual:
                return None, 'local'
            t = (mi.path, self.cls_qual)
            if len(attrs) == 1:
                m = ix.find_method(t[0], t[1], attrs[0])
                if m:
                    return m, 'ok'
                m = ix.class_attr_func(t[0], t[1], attrs[0])
                if m:
                    return m, 'ok'
                return (None, 'unres_self') if not ix.class_has_open_bases(*t) else (None, 'local')
            m = self.walk_type(t, attrs) or ix.guess_method(attrs[-2], attrs[-1])
            return (m, 'ok') if m else (None, 'weak')
        if r in self.types:
            m = self.walk_type(self.types[r], attrs)
            return (m, 'ok') if m else (None, 'weak')
        if r in self.params and r not in self.binds:
            m = ix.guess_method(r, attrs[-1]) if len(attrs) == 1 else None
            return (m, 'ok') if m else (None, 'weak')
        res = ix.lookup(mi.path, r, binds=self.binds)
        if res is None:
            if r in BUILTINS:
                return None, 'builtin'
            m = ix.guess_method(r, attrs[-1]) if len(attrs) == 1 else None
            return (m, 'ok') if m else (None, 'weak')
        return self.walk_symbol(res, attrs)

    def walk_symbol(self, res, attrs):
        ix = self.ix
        for i, a in enumerate(attrs):
            last = i == len(attrs) - 1
            if res[0] == 'mod':
                nxt = ix.lookup(res[1], a)
                if nxt is None:
                    sub = ix.by_dotted.get(self._mod_dotted(res[1]) + '.' + a)
                    nxt = ('mod', sub) if sub else None
                if nxt is None:
                    return None, 'unres_mod'
                res = nxt
                if last:
                    return self._final(res)
            elif res[0] in ('class', 'inst'):
                m = self.walk_type((res[1], res[2]), attrs[i:])
                return (m, 'ok') if m else (None, 'weak')
            elif res[0] == 'func':
                return None, 'local'
            else:
                return None, 'ext'
        return None, 'local'

    def _mod_dotted(self, path):
        d = path[:-3]
        if d.endswith('/__init__'):
            d = d[:-9]
        return d.replace('/', '.')

    def _final(self, res):
        if res[0] == 'func':
            return res[1], 'ok'
        if res[0] == 'class':
            c = self.ctor(res[1], res[2])
            return (c, 'ok') if c else (None, 'local')
        if res[0] == 'inst':
            return self.ix.find_method(res[1], res[2], '__call__'), 'ok'
        return None, 'local'

    def weak_target(self, name):
        if len(name) < 4 or name in PLAIN_METHODS or name.startswith('__'):
            return None
        c = self.ix.method_index.get(name)
        return c[0] if c and len(c) == 1 else None

    # ---- bookkeeping -------------------------------------------------------
    def add_call(self, fid, line, caught=''):
        if fid is None:
            return
        if fid not in self.call_idx:
            self.call_idx[fid] = len(self.call_idx)
        row = [self.call_idx[fid], line] + ([caught] if caught else [])
        if row not in self.call_at:
            self.call_at.append(row)

    def caught_now(self):
        if not self.try_stack:
            return ''
        names = set()
        for fr in self.try_stack:
            names |= fr
        return '*' if '*' in names else '|'.join(sorted(names))

    # ---- calls -------------------------------------------------------------
    def on_call(self, n):
        f, line = n.func, n.lineno
        d = dotted(f)
        last = f.attr if isinstance(f, ast.Attribute) else (f.id if isinstance(f, ast.Name) else None)
        self.switch_from_call(n, d, last)
        if d in EXIT_CALLS:
            self.exits.append({'line': line, 'via': d, 'code': node_text(self.lines, n.args[0], 30) if n.args else ''})
        self.call_kind_rules(n, d, last)
        fid, st = self.resolve(f)
        if st == 'builtin' and last in ('super', 'isinstance'):
            st = 'builtin'
        if fid:
            self.add_call(fid, line, self.caught_now())
            if fid == self.fn_id:
                self.recursive.append(line)
        elif st == 'weak' and last:
            w = self.weak_target(last)
            if w and w not in self.weak:
                self.weak.append(w)
        elif st in ('unres', 'unres_self', 'unres_mod') and d and len(self.unres) < 40:
            self.unres.append(d)
        for a in list(n.args) + [k.value for k in n.keywords]:
            self.callback_ref(a, line)
        ctor_like = bool(last) and last[:1].isupper()
        for k in n.keywords:
            self.kw_emit(k, n, ctor_like)
        if last and CTOR_OUT.search(last) and n.args:
            self.emit_value(n.args[0], n.args[0].lineno, 'ctor', None)

    def callback_ref(self, a, line):
        """A project function passed as a value (thread target, handler, callback) counts as a call edge."""
        if isinstance(a, ast.Name) and a.id not in self.params:
            fid, st = self.resolve_name(a.id, [])
            if st == 'ok' and fid and not self._is_class_name(a.id):
                self.add_call(fid, line, self.caught_now())
        elif isinstance(a, ast.Attribute):
            base, attrs = chain(a)
            if isinstance(base, ast.Name):
                fid, st = self.resolve_name(base.id, attrs)
                if st == 'ok' and fid:
                    self.add_call(fid, line, self.caught_now())

    def _is_class_name(self, name):
        r = self.ix.lookup(self.mi.path, name, binds=self.binds)
        return bool(r) and r[0] == 'class'

    def kw_emit(self, k, call, ctor_like):
        """status=... in a constructor call or a returned call is an outcome; in a logging call it is not."""
        if k.arg and SLOT_RE.match(k.arg.lstrip('_')) and (ctor_like or id(call) in self.ret_calls or not isinstance(k.value, ast.Constant)):
            self.emit_value(k.value, k.value.lineno, 'kw', k.arg.lstrip('_'))

    def call_kind_rules(self, n, d, last):
        line, hint_ok = n.lineno, bool(self.loops)
        if last and hint_ok:
            if last in SLEEPY or 'backoff' in last.lower():
                self.hint(line, 'sleep call %s' % (d or last))
            elif 'retry' in last.lower() or 'retries' in last.lower():
                self.hint(line, 'retry call %s' % (d or last))
        if last in ('Thread', 'Process', 'Timer') or (d or '').endswith(('.Thread', '.Process', '.Timer')):
            tgt = next((k.value for k in n.keywords if k.arg in ('target', 'function')), None)
            if tgt is None and last == 'Timer' and len(n.args) > 1:
                tgt = n.args[1]
            self.entry_from_ref(tgt, line, 'worker', 'thread or timer target')
        elif last in ROUTE_ADD and len(n.args) >= 2:
            ref = n.args[1] if last != 'add_url_rule' else next((k.value for k in n.keywords if k.arg == 'view_func'), None)
            pth = const_str(n.args[0]) or ''
            self.entry_from_ref(ref or (n.args[2] if len(n.args) > 2 else None), line, 'route',
                                '%s %s' % (last.replace('add_', '').upper(), pth))
        elif last in ('add_job', 'do', 'register', 'run_repeating', 'run_daily', 'run_once') and n.args:
            if last == 'register' and not (d or '').startswith('atexit'):
                return
            self.entry_from_ref(n.args[0], line, 'worker', 'scheduled or registered callback')

    def entry_from_ref(self, ref, line, kind, why):
        if ref is None:
            return
        if isinstance(ref, ast.Call):
            ref = ref.func
        base, attrs = chain(ref)
        if isinstance(base, ast.Name):
            fid, st = self.resolve_name(base.id, attrs)
            if st == 'ok' and fid:
                self.acc.entries.append({'fn': fid, 'kind': kind, 'why': '%s (line %d)' % (why, line)})

    def hint(self, line, why):
        if len(self.hints) < 8 and not any(h['line'] == line for h in self.hints):
            self.hints.append({'line': line, 'why': why})

    # ---- switches ----------------------------------------------------------
    def switch_from_call(self, n, d, last):
        name = kind = None
        default = None
        args = n.args
        a0 = const_str(args[0]) if args else None
        if d in ('os.environ.get', 'environ.get', 'os.getenv', 'getenv', 'os.environ.setdefault', 'environ.setdefault') and a0:
            name, kind = a0, 'env'
            default = args[1] if len(args) > 1 else next((k.value for k in n.keywords if k.arg == 'default'), None)
        elif last and WRAPPER_ENV.match(last) and a0 and UPPER.match(a0):
            name, kind = a0, 'env'
            default = args[1] if len(args) > 1 else next((k.value for k in n.keywords if k.arg == 'default'), None)
        elif last == 'get' and isinstance(n.func, ast.Attribute) and a0 and len(args) == 2:
            root = dotted(n.func.value) or ''
            if CONFIG_ROOT.match(root.split('.')[-1]):
                name, kind, default = a0, 'config', args[1]
        elif last and a0 and FLAG_CALL.match(last):
            name, kind = a0, 'flag'
            default = args[1] if len(args) > 1 else None
        if not name:
            return
        row = {'name': name, 'path': self.mi.path, 'line': n.lineno,
               'default': lit_text(default, self.lines) if default is not None else None, 'kind': kind, 'fn': self.fn_id}
        if id(n) in self.ctx_cmp:
            row['cmp'] = self.ctx_cmp[id(n)]
        if id(n) in self.ctx_cast:
            row['cast'] = self.ctx_cast[id(n)]
        self.acc.switches.append(row)

    def on_subscript(self, n):
        if dotted(n.value) in ('os.environ', 'environ'):
            key = const_str(getattr(n, 'slice', None))
            if key:
                self.acc.switches.append({'name': key, 'path': self.mi.path, 'line': n.lineno, 'default': None,
                                          'kind': 'env', 'fn': self.fn_id})

    def on_compare(self, n):
        """`os.environ.get('X', '0') == '1'` tells us how the switch is switched on (parent is seen before the call)."""
        if isinstance(n.left, ast.Call) and n.comparators:
            c = n.comparators[0]
            op = {ast.Eq: '==', ast.NotEq: '!=', ast.In: 'in', ast.NotIn: 'not in'}.get(type(n.ops[0]))
            if op and isinstance(c, (ast.Constant, ast.Tuple, ast.List, ast.Set)):
                self.ctx_cmp[id(n.left)] = short('%s %s' % (op, node_text(self.lines, c, 40)), 50)

    def on_cast(self, n):
        if isinstance(n.func, ast.Name) and n.func.id in ('int', 'float', 'bool', 'str') and n.args:
            self.ctx_cast[id(n.args[0])] = n.func.id
