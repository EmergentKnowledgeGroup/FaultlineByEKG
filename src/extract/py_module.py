"""Module-level facts for the Python reader: enums and constant groups, config switches, entry points."""
import ast
import re

from py_func import FnScan
from py_rules import LABEL_RE, const_str, dotted, is_label, lit_text, node_text, short, type_names

CONST_VOCAB = re.compile(r'(?:^|_)(?:MAX|MIN|LIMIT|LIMITS|TIMEOUT|RETRIES|RETRY|ATTEMPTS|BACKOFF|INTERVAL|TTL|THRESHOLD|'
                         r'ENABLE|ENABLED|DISABLE|DISABLED|DEBUG|DRY_RUN|FEATURE|FLAG|BATCH|CAP|LEASE|DELAY|PERIOD|'
                         r'WINDOW|QUOTA|BUDGET|DEADLINE|EXPERIMENTAL|BETA)(?:$|_)')
CONFIG_CLASS = re.compile(r'(?:Settings|Config|Configuration|Options|Params|Defaults)$')
WORKER_CLASS = re.compile(r'(?:Worker|Daemon|Consumer|Scheduler|Runner|Service|Listener|Poller|Processor|Dispatcher|Server|Watcher|Loop)$')
WORKER_METHODS = {'run', 'start', 'serve', 'serve_forever', 'run_forever', 'main', 'consume', 'work', 'loop', 'listen', 'poll'}
ROUTE_DECOS = {'route', 'get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'websocket', 'api_route', 'view'}
CLI_ROOTS = {'click', 'typer', 'cli', 'app', 'group', 'cmd', 'commands', 'main'}
HANDLER_DECOS = {'task', 'shared_task', 'periodic_task', 'on_event', 'event', 'listener', 'subscribe', 'consumer',
                 'receiver', 'scheduled_job', 'on', 'hook', 'handler', 'message_handler', 'callback_query_handler',
                 'command_handler', 'slash_command', 'listen', 'listens_for', 'cron', 'schedule', 'command', 'middleware'}
HTTP_DO = re.compile(r'^do_(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH)$')


def enum_rows(mi, tree, lines):
    """Enums, constant-only classes, Literal aliases and prefixed constant groups defined in one module."""
    rows = []
    cnodes = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.ClassDef):
            cnodes[(n.name, n.lineno)] = n
    for q, ci in mi.classes.items():
        node = cnodes.get((ci.name, ci.line))
        if node is None:
            continue
        members, values = [], []
        for st in node.body:
            if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
                nm = st.targets[0].id
                if nm.startswith('_'):
                    continue
                v = st.value
                if isinstance(v, ast.Constant):
                    val = str(v.value)
                elif isinstance(v, ast.Tuple) and v.elts and isinstance(v.elts[0], ast.Constant):
                    val = str(v.elts[0].value)
                else:
                    val = nm.lower()
                members.append(nm)
                values.append(val)
        if ci.is_enum and members:
            rows.append({'name': q, 'path': mi.path, 'line': ci.line, 'values': values, 'members': members, 'form': 'enum'})
        elif not ci.is_enum and not ci.methods and len(members) >= 3 and all(m.isupper() or m.replace('_', '').isupper() for m in members) \
                and all(is_label(v) for v in values) and not ci.bases:
            rows.append({'name': q, 'path': mi.path, 'line': ci.line, 'values': values, 'members': members, 'form': 'constants'})
    groups = {}
    for st in tree.body:
        if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
            nm, v = st.targets[0].id, st.value
            lit = _literal_values(v)
            if lit:
                rows.append({'name': nm, 'path': mi.path, 'line': st.lineno, 'values': lit, 'members': [], 'form': 'literal'})
            elif nm.isupper() and '_' in nm and isinstance(v, ast.Constant) and isinstance(v.value, str) and is_label(v.value):
                groups.setdefault(nm.split('_')[0], []).append((st.lineno, nm, v.value))
        elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name) and st.value is not None:
            lit = _literal_values(st.value)
            if lit:
                rows.append({'name': st.target.id, 'path': mi.path, 'line': st.lineno, 'values': lit, 'members': [], 'form': 'literal'})
    for pre, items in sorted(groups.items()):
        if len(items) >= 3 and len(pre) >= 3:
            rows.append({'name': pre + '_*', 'path': mi.path, 'line': items[0][0], 'values': [x[2] for x in items],
                         'members': [x[1] for x in items], 'form': 'prefix'})
    return rows


def _literal_values(v):
    if isinstance(v, ast.Subscript) and (dotted(v.value) or '').split('.')[-1] == 'Literal':
        sl = v.slice
        elts = sl.elts if isinstance(sl, ast.Tuple) else [sl]
        vals = [str(e.value) for e in elts if isinstance(e, ast.Constant)]
        if len(vals) == len(elts) and len(vals) >= 2:
            return vals
    return None


def const_switches(mi, tree, lines, acc):
    """Module-level limit and toggle constants, and defaults on settings-style classes."""
    for st in tree.body:
        tgt, val = None, None
        if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
            tgt, val = st.targets[0], st.value
        elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name) and st.value is not None:
            tgt, val = st.target, st.value
        if tgt is not None and tgt.id.isupper() and CONST_VOCAB.search(tgt.id) and _simple(val):
            acc.switches.append({'name': tgt.id, 'path': mi.path, 'line': st.lineno, 'default': lit_text(val, lines),
                                 'kind': 'const', 'fn': None})
    for n in ast.walk(tree):
        if isinstance(n, ast.ClassDef) and (CONFIG_CLASS.search(n.name) or any((dotted(b) or '').endswith('BaseSettings') for b in n.bases)):
            for st in n.body:
                if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name) and st.value is not None:
                    v = st.value
                    if isinstance(v, ast.Call) and (dotted(v.func) or '').endswith('Field'):
                        v = next((k.value for k in v.keywords if k.arg == 'default'), v.args[0] if v.args else None)
                    if v is not None and _simple(v):
                        acc.switches.append({'name': st.target.id, 'path': mi.path, 'line': st.lineno,
                                             'default': lit_text(v, lines), 'kind': 'config', 'fn': None})
                elif isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name) and _simple(st.value) \
                        and not st.targets[0].id.startswith('_'):
                    acc.switches.append({'name': st.targets[0].id, 'path': mi.path, 'line': st.lineno,
                                         'default': lit_text(st.value, lines), 'kind': 'config', 'fn': None})


def _simple(v):
    if isinstance(v, ast.Constant):
        return not isinstance(v.value, (bytes,)) and len(str(v.value)) <= 40
    return isinstance(v, ast.UnaryOp) and isinstance(v.operand, ast.Constant)


def deco_info(dec):
    """(root, last, first string arg) of a decorator expression."""
    call = dec if isinstance(dec, ast.Call) else None
    target = dec.func if call else dec
    d = dotted(target) or ''
    parts = d.split('.')
    arg = const_str(call.args[0]) if call and call.args else None
    return parts[0], parts[-1], arg, d


def def_entries(ix, mi, d, acc, has_cli):
    """Entries from decorators, worker classes, HTTP handler methods and command naming."""
    node, fid = d.node, '%s::%s' % (mi.path, d.qual)
    for dec in node.decorator_list:
        root, last, arg, full = deco_info(dec)
        if last in ROUTE_DECOS and root not in ('functools', 'abc') and (arg is not None and ('/' in arg or arg == '')):
            acc.entries.append({'fn': fid, 'kind': 'route', 'why': '@%s %s' % (last, arg)})
        elif last == 'websocket' and root not in ('functools',):
            acc.entries.append({'fn': fid, 'kind': 'route', 'why': '@%s' % full})
        elif last in ('command', 'group', 'callback') and root in CLI_ROOTS:
            acc.entries.append({'fn': fid, 'kind': 'cli', 'why': '@%s' % full})
        elif last in HANDLER_DECOS and root not in ('functools', 'abc', 'pytest', 'unittest'):
            acc.entries.append({'fn': fid, 'kind': 'handler', 'why': '@%s' % full})
    if d.cls and d.qual.rsplit('.', 1)[0] == d.cls:
        ci = mi.classes[d.cls]
        name = node.name
        if HTTP_DO.match(name):
            acc.entries.append({'fn': fid, 'kind': 'route', 'why': 'HTTP %s handler method' % name[3:]})
        elif name in WORKER_METHODS and (WORKER_CLASS.search(ci.name) or any(b.split('.')[-1] in ('Thread', 'Process') for b in ci.bases if b)):
            acc.entries.append({'fn': fid, 'kind': 'worker', 'why': 'worker class %s.%s' % (ci.name, name)})
    elif '.' not in d.qual and has_cli and re.match(r'^(?:cmd|command)_\w+$', node.name):
        acc.entries.append({'fn': fid, 'kind': 'cli', 'why': 'command function in a module that builds a command line'})


def module_exports(ix, mi, acc):
    """Names listed in __all__ of a package root count as the public surface."""
    if mi.all is None or mi.path.count('/') > 1:
        return
    for name in mi.all:
        r = ix.lookup(mi.path, name)
        if r and r[0] == 'func':
            acc.entries.append({'fn': r[1], 'kind': 'export', 'why': '__all__ in %s' % mi.path})


def test_entries(ix, mi, tree, lines, acc, children, defs):
    """One entry per test function, with the project functions it calls (so analysis can say what tests reach)."""
    out = []
    for d in defs:
        if d.kind != 'func' or not d.node.name.startswith('test'):
            continue
        parent = d.qual.rsplit('.', 1)[0] if '.' in d.qual else None
        if parent and parent in mi.classes:
            ci = mi.classes[parent]
            if not (ci.name.startswith('Test') or any((b or '').endswith('TestCase') for b in ci.bases)):
                continue
        elif parent:
            continue
        sc = FnScan(ix, mi, lines, d, acc.scratch(), children)
        rec = sc.run()
        out.append({'fn': '%s::%s' % (mi.path, d.qual), 'kind': 'test', 'why': 'test function', 'line': d.node.lineno,
                    'calls': rec['calls']})
    return out
