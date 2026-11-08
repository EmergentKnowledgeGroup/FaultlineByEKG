"""Route facts from Python sources, for the HTTP link rule (links_http.mjs). Standard library only.

    python -I routefacts.py <root> <paths.json> <out.json>

<paths.json> is a JSON list of project-relative paths (forward slashes) of the Python files to look at. The output is

    {"schema": "fl.routefacts/1", "files": [{"path", "tables": [[key, strings, line, verb]], "fns": [{"line", "dverb", "deco": [{"path", "verb"}], "arms": [{"v", "line"}]}]}]}

in the order of the input. A file that cannot be read or parsed, or that holds no string starting with a slash, is left out.
  tables  a dict literal (possibly wrapped in calls) with at least three keys that are strings starting with '/', all other keys being computed:
          one row per string key, with every string constant inside its value, the line of the key, and GET / POST when the name it is assigned to says so
  fns     one entry per function that carries a route decorator (@x.route("/p"), @x.get("/p") ...) or compares a name taken from the request path with
          a string starting with '/': the line of its def, the verb its own name implies (do_GET ...), the decorators, and the comparisons
"""
import ast
import json
import re
import sys

REQ_PATH = re.compile(r'(urlparse|urlsplit)\(.*\)\.path\b|\bself\.path\b|\brequest\.path\b|\.path_info\b|\bscope\[.path.\]')
VERBS = {'get': 'GET', 'post': 'POST', 'put': 'PUT', 'delete': 'DELETE', 'patch': 'PATCH', 'head': 'HEAD', 'options': 'OPTIONS'}
DO_VERBS = {'do_GET': 'GET', 'do_POST': 'POST', 'do_PUT': 'PUT', 'do_DELETE': 'DELETE', 'do_PATCH': 'PATCH', 'do_HEAD': 'HEAD'}
SNIPPET = 300          # characters of the assigned expression that are searched for a request path


def str_consts(node):
    return [n.value for n in ast.walk(node) if isinstance(n, ast.Constant) and isinstance(n.value, str)]


def own_nodes(fnode):
    """the nodes of one function, not those of the functions and classes nested in it (each of those is walked on its own)"""
    stack = list(ast.iter_child_nodes(fnode))
    while stack:
        n = stack.pop()
        yield n
        if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            stack.extend(ast.iter_child_nodes(n))


def tables_of(tree):
    rows = []
    for node in ast.walk(tree):
        tgt = None
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            tgt, val = node.targets[0], node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            tgt, val = node.target, node.value
        if tgt is None:
            continue
        tname = (tgt.id if isinstance(tgt, ast.Name) else getattr(tgt, 'attr', '')).upper()
        tverb = 'GET' if 'GET' in tname else 'POST' if 'POST' in tname else None
        d = val
        while isinstance(d, ast.Call) and d.args and not isinstance(d, ast.Dict):
            d = d.args[0]
        if not isinstance(d, ast.Dict):
            continue
        keys = [k.value if isinstance(k, ast.Constant) and isinstance(k.value, str) else None for k in d.keys]
        if sum(1 for k in keys if k and k.startswith('/')) < 3 or not all(k is None or k.startswith('/') for k in keys):
            continue
        for k, v in zip(keys, d.values):
            if k:
                rows.append([k, str_consts(v), d.keys[keys.index(k)].lineno, tverb])
    return rows


def fns_of(tree, lines):
    out = []
    for fnode in ast.walk(tree):
        if not isinstance(fnode, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        deco = []
        for dec in fnode.decorator_list:
            if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.args and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str) \
                    and dec.args[0].value.startswith('/') and dec.func.attr in ('route', *VERBS):
                verb = VERBS.get(dec.func.attr)
                for kw in dec.keywords:
                    if kw.arg == 'methods':
                        vs = [x.upper() for x in str_consts(kw.value)]
                        verb = vs[0] if len(vs) == 1 else None
                deco.append({'path': dec.args[0].value, 'verb': verb})
        arms = []
        names = set()
        for n in own_nodes(fnode):
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                seg = '\n'.join(lines[n.value.lineno - 1:n.value.end_lineno])[:SNIPPET]
                if REQ_PATH.search(seg):
                    names.add(n.targets[0].id)
        if names:
            for n in sorted(own_nodes(fnode), key=lambda x: (getattr(x, 'lineno', 0), getattr(x, 'col_offset', 0))):
                if not isinstance(n, ast.Compare) or len(n.ops) != 1:
                    continue
                a, b, op = n.left, n.comparators[0], n.ops[0]
                if isinstance(a, ast.Constant) and isinstance(b, ast.Name):
                    a, b = b, a
                if not (isinstance(a, ast.Name) and a.id in names):
                    continue
                lits = []
                if isinstance(op, ast.Eq) and isinstance(b, ast.Constant) and isinstance(b.value, str):
                    lits = [b.value]
                elif isinstance(op, ast.In) and isinstance(b, (ast.Tuple, ast.List, ast.Set)):
                    lits = [e.value for e in b.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
                arms.extend({'v': v, 'line': n.lineno} for v in lits if v.startswith('/'))
        if deco or arms:
            out.append({'line': fnode.lineno, 'dverb': DO_VERBS.get(fnode.name), 'deco': deco, 'arms': arms})
    return out


def main():
    root, paths_file, out_file = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(paths_file, encoding='utf-8') as f:
        paths = json.load(f)
    files = []
    for rel in paths:
        try:
            with open(root.rstrip('/') + '/' + rel, encoding='utf-8-sig', errors='replace') as f:
                src = f.read()
            tree = ast.parse(src)
        except (OSError, SyntaxError, ValueError, RecursionError):
            continue
        if "'/" not in src and '"/' not in src:
            continue
        files.append({'path': rel, 'tables': tables_of(tree), 'fns': fns_of(tree, src.split('\n'))})
    with open(out_file, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'schema': 'fl.routefacts/1', 'files': files}, f, sort_keys=True, ensure_ascii=False)


if __name__ == '__main__':
    main()
