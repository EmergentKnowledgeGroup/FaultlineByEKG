"""Faultline Python reader: stdlib ast only. Usage: python -B python_facts.py --list files.json --out facts.json

files.json is {"root": dir, "files": [{"path": "pkg/mod.py", "role": "src" | "test"}]}. Output is the Python half of
facts.json (modules, functions, entries, switches, enums, skipped). Two passes: a cheap definition index over every
file, then a full read of each file against that index. Parse errors are recorded and skipped."""
import sys

sys.dont_write_bytecode = True
import ast
import hashlib
import json
import os
import re
import threading
import time
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from py_func import FnScan  # noqa: E402
from py_index import Def, Index, build_modinfo, collect_defs  # noqa: E402
from py_module import const_switches, def_entries, enum_rows, module_exports, test_entries  # noqa: E402
from py_rules import short  # noqa: E402

SPLIT = re.compile(r'\r\n|\r|\n')


class Acc:
    def __init__(self):
        self.entries, self.switches, self.enum_uses = [], [], {}

    def scratch(self):
        return Acc()


def peak_mb():
    try:
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD), ('PeakWorkingSetSize', ctypes.c_size_t),
                            ('WorkingSetSize', ctypes.c_size_t), ('a', ctypes.c_size_t), ('b', ctypes.c_size_t),
                            ('c', ctypes.c_size_t), ('d', ctypes.c_size_t), ('PagefileUsage', ctypes.c_size_t),
                            ('PeakPagefileUsage', ctypes.c_size_t)]
            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            k32 = ctypes.windll.kernel32
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
            ctypes.windll.psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
            return round(pmc.PeakWorkingSetSize / 1048576, 1)
        import resource
        v = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return round(v / (1048576 if sys.platform == 'darwin' else 1024), 1)
    except Exception:
        return None


def load(root, rel):
    data = open(os.path.join(root, rel), 'rb').read()
    text = data.decode('utf-8-sig', errors='replace')
    return data, text


def module_row(rel, data, text, lines, ix, mi, tree):
    imps, ext = set(), set()
    for n in ast.walk(tree):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            binds = {}
            ix.bind_import(mi, n, binds, [])
            for b in binds.values():
                if b[0] in ('mod', 'sym') and b[1] != rel:
                    imps.add(b[1])
                elif b[0] == 'ext':
                    ext.add(b[1])
            if isinstance(n, ast.ImportFrom) and n.level == 0 and n.module and not any(b[0] != 'ext' for b in binds.values()):
                ext.add(n.module.split('.')[0])
    return {'path': rel, 'lang': 'py', 'lines': len(lines), 'sha256': hashlib.sha256(data).hexdigest(),
            'imports': sorted(imps), 'externalImports': sorted(ext),
            'doc': short((ast.get_docstring(tree) or '').strip().split('\n')[0], 120)}


def module_body(tree):
    """Top-level statements plus the non-def statements inside class bodies: what runs at import time."""
    out = []

    def add(stmts):
        for s in stmts:
            if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if isinstance(s, ast.ClassDef):
                add(s.body)
            else:
                out.append(s)
    add(tree.body)
    return out


def run(spec, out_path):
    t0 = time.time()
    root = spec['root']
    files = spec['files']
    roles = {f['path']: f.get('role', 'src') for f in files}
    ix = Index(root, [f['path'] for f in files])
    skipped, trees_ok = [], {}
    for f in files:                       # pass 1: definitions only
        rel = f['path']
        try:
            data, text = load(root, rel)
            if '\x00' in text:
                raise ValueError('null bytes in source')
            tree = ast.parse(text, filename=rel)
            mi = build_modinfo(rel, tree)
        except (SyntaxError, ValueError, RecursionError, MemoryError, OSError) as e:
            skipped.append({'path': rel, 'why': short('%s: %s' % (type(e).__name__, e), 160)})
            continue
        trees_ok[rel] = True
        ix.mods[rel] = mi
        if roles[rel] == 'src':
            ix.add(mi)
        del tree
    ix.link()
    acc = Acc()
    modules, functions, enums = [], {}, []
    for f in files:                       # pass 2: full read
        rel = f['path']
        if rel not in trees_ok:
            continue
        try:
            data, text = load(root, rel)
            lines = SPLIT.split(text)
            tree = ast.parse(text, filename=rel)
            mi = ix.mods[rel]
            defs = collect_defs(tree)
            children = {}
            for d in defs:
                if d.kind == 'func' and d.parent:
                    children.setdefault(d.parent, {})[d.node.name] = d.qual
            if roles[rel] == 'test':
                acc.entries += test_entries(ix, mi, tree, lines, acc, children, defs)
                continue
            has_cli = any(b[0] == 'ext' and b[1] in ('argparse', 'click', 'typer', 'fire') for b in mi.binds.values())
            local = {}
            for d in defs:
                if d.kind != 'func':
                    continue
                rec = FnScan(ix, mi, lines, d, acc, children).run()
                local['%s::%s' % (rel, d.qual)] = rec
                def_entries(ix, mi, d, acc, has_cli)
            fake = types.SimpleNamespace(body=module_body(tree))
            mrec = FnScan(ix, mi, lines, Def('func', '<module>', fake, None, None), acc, children, is_module=True).run()
            if mrec['calls'] or mrec['branches'] or any(e['fn'].endswith('::<module>') and e['fn'].startswith(rel) for e in acc.entries):
                local['%s::<module>' % rel] = mrec
            functions.update(local)
            const_switches(mi, tree, lines, acc)
            enums += enum_rows(mi, tree, lines)
            module_exports(ix, mi, acc)
            modules.append(module_row(rel, data, text, lines, ix, mi, tree))
        except (RecursionError, MemoryError, ValueError) as e:
            skipped.append({'path': rel, 'why': short('%s while reading: %s' % (type(e).__name__, e), 160)})
    for e in enums:
        if e['form'] in ('enum', 'constants'):
            nm = e['name'].split('.')[-1]
            e['uses'] = {m: acc.enum_uses.get('%s.%s' % (nm, m), 0) for m in e['members']}
    class_bases = {}
    for mi in ix.mods.values():
        if roles.get(mi.path) == 'src':
            for ci in mi.classes.values():
                if ci.bases:
                    class_bases.setdefault(ci.name, [b.split('.')[-1] for b in ci.bases])
    seen, entries = set(), []
    for e in acc.entries:
        k = (e['fn'], e['kind'])
        if k not in seen:
            seen.add(k)
            entries.append(e)
    out = {'modules': modules, 'functions': functions, 'entries': entries, 'switches': acc.switches, 'enums': enums,
           'classBases': class_bases, 'skipped': skipped, 'stats': {'seconds': round(time.time() - t0, 2), 'peakRssMb': peak_mb(), 'files': len(files)}}
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))


def main():
    args = sys.argv[1:]
    try:
        spec = json.load(open(args[args.index('--list') + 1], encoding='utf-8'))
        out_path = args[args.index('--out') + 1]
    except (ValueError, IndexError):
        sys.stderr.write('usage: python -B python_facts.py --list files.json --out facts.json\n')
        sys.exit(2)
    sys.setrecursionlimit(40000)
    for mb in (256, 128, 64, 16):
        try:
            threading.stack_size(mb * 1024 * 1024 - 4096)
            break
        except (ValueError, RuntimeError):
            continue
    err = []

    def target():
        try:
            run(spec, out_path)
        except BaseException as e:  # noqa: BLE001
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
