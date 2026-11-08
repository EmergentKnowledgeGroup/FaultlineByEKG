"""Shared rules for the Python reader: text helpers and the small vocabularies behind the heuristics."""
import ast
import builtins
import re

BUILTINS = set(dir(builtins))
LABEL_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:\-]{1,39}$')
# names a value is stored under when it records how something ended
SLOT_RE = re.compile(r'^(?:status|state|result|outcome|verdict|reason|disposition|resolution|ending|decision'
                     r'|[a-z0-9_]+_(?:status|state|result|outcome|reason|verdict|decision|disposition))$', re.I)
COUNT_RE = re.compile(r'attempt|tries|retry|retries|count|limit|max|remaining|left|budget|deadline|timeout|elapsed|'
                      r'ticks?|iter|depth|level|num|total|size|len|idx|index|^[ijkn]$', re.I)
ATTEMPT_RE = re.compile(r'attempt|tries|retry|retries|backoff|delay', re.I)
SLEEPY = {'sleep', 'asleep', 'backoff', 'delay'}
EXIT_CALLS = {'sys.exit', 'os._exit', 'exit', 'quit', 'sys.exit_', '_exit'}
EXC_BROAD = {'Exception', 'BaseException', '(bare)'}
STDLIB_PARENTS = {'KeyError': 'LookupError', 'IndexError': 'LookupError', 'FileNotFoundError': 'OSError',
                  'PermissionError': 'OSError', 'TimeoutError': 'OSError', 'ConnectionError': 'OSError',
                  'IOError': 'OSError', 'JSONDecodeError': 'ValueError', 'UnicodeDecodeError': 'ValueError',
                  'LookupError': 'Exception', 'OSError': 'Exception', 'ValueError': 'Exception',
                  'TypeError': 'Exception', 'RuntimeError': 'Exception', 'AttributeError': 'Exception'}
PLAIN_METHODS = set('''get set add run start stop close open read write send recv append extend items keys values update
pop remove clear copy join split strip format encode decode load dump loads dumps lower upper replace find count index
sort reverse insert flush seek tell connect commit execute fetch cursor info debug warning error exception critical log
put post delete patch head wait notify acquire release submit result cancel done create gather sleep next iter emit
fetchone fetchall rollback shutdown terminate kill reset init setup teardown render save call apply handle process
cleanup validate parse dispatch'''.split())


def short(text, n=80):
    text = re.sub(r'\s+', ' ', text or '').strip()
    return text if len(text) <= n else text[:n - 3].rstrip() + '...'


def node_text(lines, node, n=80):
    """Source text of a node as written, first line only when it spans several."""
    try:
        ln, end, c0, c1 = node.lineno, node.end_lineno, node.col_offset, node.end_col_offset
        raw = lines[ln - 1].encode('utf-8', 'replace')
        if end == ln:
            return short(raw[c0:c1].decode('utf-8', 'replace'), n)
        return short(raw[c0:].decode('utf-8', 'replace') + ' ...', n)
    except Exception:
        return ''


def dotted(node):
    """a.b.c for Name/Attribute chains, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return '.'.join(reversed(parts))
    return None


def chain(node):
    """(base_node, [attrs outermost last]) for a.b.c -> (Name a, ['b','c'])."""
    attrs = []
    while isinstance(node, ast.Attribute):
        attrs.append(node.attr)
        node = node.value
    return node, list(reversed(attrs))


def is_label(s):
    """Short machine-style word (pending, lease_lost, not_found); a Capitalized display word is not one."""
    return (isinstance(s, str) and bool(LABEL_RE.match(s)) and not s.isdigit()
            and not re.match(r'^[A-Z][a-z]+$', s))


def const_str(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def lit_text(node, lines):
    """Default value text: literal value for constants, else short source."""
    if isinstance(node, ast.Constant):
        return str(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.operand, ast.Constant):
        return node_text(lines, node, 40)
    return node_text(lines, node, 40)


def slot_of(target):
    """Slot name when an assignment target is status-like (x.status, status, d['status'])."""
    name = None
    if isinstance(target, ast.Name):
        name = target.id
    elif isinstance(target, ast.Attribute):
        name = target.attr
    elif isinstance(target, ast.Subscript):
        name = const_str(getattr(target, 'slice', None))
    if name and SLOT_RE.match(name.lstrip('_')):
        return name.lstrip('_')
    return None


def terminal_kind(stmts):
    """How a block ends: return/raise/continue/break/exit, or other."""
    if not stmts:
        return 'none'
    last = stmts[-1]
    if isinstance(last, ast.Return):
        return 'return'
    if isinstance(last, ast.Raise):
        return 'raise'
    if isinstance(last, ast.Continue):
        return 'continue'
    if isinstance(last, ast.Break):
        return 'break'
    if isinstance(last, ast.Pass):
        return 'pass'
    if isinstance(last, ast.Expr) and isinstance(last.value, ast.Call) and dotted(last.value.func) in EXIT_CALLS:
        return 'exit'
    return 'other'


def test_kind(test):
    """Coarse shape of an if-test, used for guard-versus-decision weights."""
    t = test
    if isinstance(t, ast.UnaryOp) and isinstance(t.op, ast.Not):
        return 'none' if not isinstance(t.operand, (ast.Call, ast.Compare)) else test_kind(t.operand)
    if isinstance(t, (ast.Name, ast.Attribute, ast.Subscript)):
        return 'none'
    if isinstance(t, ast.Compare):
        if any(isinstance(c, ast.Constant) and c.value is None for c in t.comparators):
            return 'none'
        return 'cmp'
    if isinstance(t, ast.Call):
        fn = dotted(t.func) or ''
        if fn in ('isinstance', 'issubclass', 'callable', 'hasattr'):
            return 'type'
        return 'call'
    if isinstance(t, ast.BoolOp):
        kinds = {test_kind(v) for v in t.values}
        return kinds.pop() if len(kinds) == 1 else 'bool'
    if isinstance(t, ast.Constant):
        return 'const'
    return 'other'


def mentions_count(test):
    """True when the test compares something against a counter, limit or deadline."""
    for n in ast.walk(test):
        if isinstance(n, ast.Compare) and any(isinstance(o, (ast.Lt, ast.LtE, ast.Gt, ast.GtE)) for o in n.ops):
            for side in [n.left] + list(n.comparators):
                for m in ast.walk(side):
                    if isinstance(m, ast.Name) and COUNT_RE.search(m.id):
                        return True
                    if isinstance(m, ast.Attribute) and COUNT_RE.search(m.attr):
                        return True
                    if isinstance(m, ast.Constant) and isinstance(m.value, (int, float)) and not isinstance(m.value, bool):
                        return True
            if any(isinstance(x, ast.Call) and (dotted(x.func) or '').endswith(('time', 'monotonic', 'perf_counter'))
                   for side in [n.left] + list(n.comparators) for x in ast.walk(side)):
                return True
    return False


def is_true_const(test):
    return isinstance(test, ast.Constant) and bool(test.value) is True


def type_names(ann, depth=0):
    """Candidate class names inside an annotation, in reading order (Optional[X], 'X', X | None, list[X])."""
    out = []
    if ann is None or depth > 6:
        return out
    if isinstance(ann, ast.Constant) and isinstance(ann.value, str):
        try:
            return type_names(ast.parse(ann.value.strip(), mode='eval').body, depth + 1)
        except Exception:
            return out
    if isinstance(ann, (ast.Name, ast.Attribute)):
        d = dotted(ann)
        if d and d not in BUILTINS and d.split('.')[-1] not in TYPING_NOISE:
            out.append(d)
    elif isinstance(ann, ast.Subscript):
        out += type_names(ann.value, depth + 1)
        sl = ann.slice
        elts = sl.elts if isinstance(sl, ast.Tuple) else [sl]
        for e in elts:
            out += type_names(e, depth + 1)
    elif isinstance(ann, ast.BinOp):
        out += type_names(ann.left, depth + 1) + type_names(ann.right, depth + 1)
    return out


TYPING_NOISE = {'Optional', 'Union', 'List', 'Dict', 'Set', 'Tuple', 'Any', 'Callable', 'Type', 'Iterable', 'Iterator',
                'Sequence', 'Mapping', 'MutableMapping', 'Awaitable', 'Coroutine', 'Literal', 'ClassVar', 'Final',
                'Annotated', 'TYPE_CHECKING', 'Generator', 'AsyncIterator', 'AsyncIterable', 'Deque', 'FrozenSet',
                'NoReturn', 'Self', 'Path', 'datetime', 'date', 'time', 'timedelta', 'Enum', 'Exception'}
