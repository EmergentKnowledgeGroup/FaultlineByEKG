"""Faultline signal reader for Python: stdlib ast only. Usage: python -B -I signals_py.py --list files.json --out signals_raw.json

files.json is {"root": dir, "files": [{"path": "pkg/mod.py", "role": "src"}]}: the same list the fact reader gets, so function ids match
facts.json. Output is raw per-function facts, enum and constant uses, empty handlers and swallowed errors. This is a second, separate
read of the source: it never touches facts.json or census.json."""
import sys

sys.dont_write_bytecode = True
import argparse
import ast
import json
import os
import re
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from signals_py_walk import Walker, dotted, lit_text  # noqa: E402

NOT_MSG = re.compile(r'(?:SECONDS|MS|MILLIS|TIMEOUT|DEADLINE|LIMIT|MAX|MIN|SIZE|COUNT|DELAY|INTERVAL|FILE|PATH|URL|DIR|ATTEMPTS|RETRIES|TTL)(?:_|$)')
MSGY = re.compile(r'^(?:MSG|MESSAGE|CMD|COMMAND|EVT|EVENT|OPCODE|ACTION|SIGNAL|REQ|REQUEST|PKT|PACKET|OP)_[A-Z0-9_]+$|^[A-Z0-9_]+_(?:MSG|MESSAGE|CMD|COMMAND|EVENT|OPCODE|ACTION|SIGNAL)$')
ENUM_BASE = re.compile(r'(?:^|\.)(?:Enum|IntEnum|StrEnum|Flag|IntFlag|ReprEnum)$')


def read(root, rel):
    data = open(os.path.join(root, rel), 'rb').read()
    return data.decode('utf-8-sig', errors='replace')


def value_of(node):
    t = lit_text(node)
    if t is None: return None
    if t.startswith('"'): return t[1:-1]
    return t


def pass_one(rel, tree, out, ctx):
    """Enum classes (members as class-level names) and message-ish module constants."""
    for s in ast.walk(tree):
        if isinstance(s, ast.ClassDef) and any(ENUM_BASE.search('.'.join(dotted(b) or [])) for b in s.bases):
            members = []
            for m in s.body:
                if isinstance(m, ast.Assign) and len(m.targets) == 1 and isinstance(m.targets[0], ast.Name) and not m.targets[0].id.startswith('_'):
                    members.append({'name': m.targets[0].id, 'value': value_of(m.value), 'line': m.lineno})
                    ctx['def_pos'].add((rel, m.value.lineno, m.value.col_offset))
            if len(members) >= 2:
                out['enums'].append({'name': s.name, 'path': rel, 'line': s.lineno, 'form': 'enum', 'members': members})
                ctx['enum_names'].add(s.name)
                ctx['enum_members'].setdefault(s.name, set()).update(m['name'] for m in members)
                for m in members:
                    if isinstance(m['value'], str) and len(m['value']) >= 3 and not m['value'][0].isdigit(): ctx['str_vals'].add(m['value'])
    for s in tree.body:
        if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name) and MSGY.match(s.targets[0].id) and not NOT_MSG.search(s.targets[0].id):
            v = value_of(s.value)
            if v is not None:
                out['consts'].append({'name': s.targets[0].id, 'path': rel, 'line': s.lineno, 'value': v})
                ctx['const_names'].add(s.targets[0].id)
                ctx['def_pos'].add((rel, s.value.lineno, s.value.col_offset))
                if isinstance(v, str) and len(v) >= 3 and not v[0].isdigit(): ctx['str_vals'].add(v)


def run(spec, out_path):
    t0 = time.time()
    root, files = spec['root'], spec['files']
    out = {'fns': [], 'inits': [], 'classes': [], 'enums': [], 'consts': [], 'uses': [], 'rawStrings': [], 'emptyHandlers': [], 'swallowed': [], 'skipped': []}
    ctx = {'enum_names': set(), 'enum_members': {}, 'const_names': set(), 'str_vals': set(), 'def_pos': set()}
    trees = []
    for f in files:                       # pass 1: definitions only
        rel = f['path']
        try:
            text = read(root, rel)
            if '\x00' in text: raise ValueError('null bytes in source')
            tree = ast.parse(text, filename=rel)
        except (SyntaxError, ValueError, RecursionError, MemoryError, OSError) as e:
            out['skipped'].append({'path': rel, 'why': '%s: %s' % (type(e).__name__, str(e)[:100])})
            continue
        pass_one(rel, tree, out, ctx)
        trees.append((rel, text, tree))
    for rel, text, tree in trees:         # pass 2: the walk
        try:
            Walker(rel, text, tree, ctx, out).run()
        except RecursionError:
            out['skipped'].append({'path': rel, 'why': 'RecursionError while reading signals'})
    out['stats'] = {'seconds': round(time.time() - t0, 2), 'files': len(files)}
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, separators=(',', ':'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    with open(a.list, encoding='utf-8') as fh:
        spec = json.load(fh)
    sys.setrecursionlimit(40000)                      # deep source needs a deep stack: same as the fact reader
    for mb in (256, 128, 64, 16):
        try:
            threading.stack_size(mb * 1024 * 1024 - 4096)
            break
        except (ValueError, RuntimeError):
            continue
    err = []

    def target():
        try:
            run(spec, a.out)
        except BaseException:  # noqa: BLE001
            import traceback
            err.append(traceback.format_exc())
    t = threading.Thread(target=target)
    t.start()
    t.join()
    if err:
        sys.stderr.write(err[0])
        sys.exit(1)


if __name__ == '__main__':
    main()
