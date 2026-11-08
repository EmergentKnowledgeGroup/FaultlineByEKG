"""Python reader: reads the files named on stdin and prints {"ir": the reader document, "order": the order things were found in} as JSON.

    python -I pyread.py < request.json        request: {"root": "<absolute folder>", "files": ["rel/path.py", ...]}

Standard library only. Python 3.10 or newer. The document lists, for every file, its functions with their control-flow graphs, its classes and
its imports, then the facts about names that hold across the project. Nothing is resolved here: that is the type checker's job.
"""
import json
import os
import sys

MIN = (3, 10)


def main():
    if sys.version_info < MIN:
        sys.stdout.write(json.dumps({'refused': f'Python {MIN[0]}.{MIN[1]} or newer is needed to read Python files; this is {sys.version.split()[0]} ({sys.executable})'}))
        return 3
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.setrecursionlimit(100000)
    from pyload import Loaded, to_ir, definition_order
    req = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    P = Loaded(req['root'])
    P.load_python(req['files'])
    sys.stdout.write(json.dumps({'ir': to_ir(P, req['files']), 'order': definition_order(P)}, ensure_ascii=True, default=str, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
