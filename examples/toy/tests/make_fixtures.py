"""Regenerate fixtures/coverage.json and fixtures/address-hold.walk.jsonl. Run from examples/toy:
    python tests/make_fixtures.py        (needs Python 3.11+, and coverage.py for the coverage half)
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile

TOY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, TOY)

from parcelworks import cli, report  # noqa: E402
from parcelworks.jobqueue import Queue  # noqa: E402
from parcelworks.worker import Worker  # noqa: E402

PKG = os.path.join(TOY, "parcelworks")
SKIP = ("__init__", "close", "_job", "_set")


def rel(path):
    return os.path.relpath(path, TOY).replace("\\", "/")


class Tracer:
    """Records the first body line of every parcelworks function call, in call order."""

    def __init__(self):
        self.steps = []

    def __call__(self, frame, event, arg):
        code = frame.f_code
        if event != "call" or not os.path.abspath(code.co_filename).startswith(PKG):
            return None
        qual = code.co_qualname
        if qual.split(".")[-1] in SKIP or rel(code.co_filename).endswith("config.py"):
            return None
        path = rel(code.co_filename)

        seen = []

        def first_line(frame, event, arg):
            if event == "line" and not seen:
                seen.append(frame.f_lineno)
                self.steps.append({"ref": f"{path}:{frame.f_lineno}", "sym": f"{path}::{qual}"})
            return first_line

        return first_line

    def run(self, fn, *args, **kw):
        sys.settrace(self)
        try:
            return fn(*args, **kw)
        finally:
            sys.settrace(None)


def parcel(pid, **over):
    base = {"id": pid, "sender": "Ann", "recipient": "Bo", "postcode": "12345", "weight_g": 800}
    base.update(over)
    return base


def tree_pin():
    sums = []
    for base, _dirs, names in sorted(os.walk(PKG)):
        sums += [hashlib.sha256(open(os.path.join(base, n), "rb").read()).hexdigest()
                 for n in sorted(names) if n.endswith(".py")]
    return hashlib.sha256("".join(sums).encode()).hexdigest()


def make_walk(out):
    happy, stuck = Tracer(), Tracer()
    q = Queue(":memory:")
    happy.run(cli.cmd_submit, q, parcel("pw-1"))
    happy.run(Worker(q).run, stop_when_idle=True)
    with tempfile.TemporaryDirectory() as tmp:
        happy.run(report.publish, q, os.path.join(tmp, "report.txt"))
    q = Queue(":memory:")
    stuck.run(cli.cmd_submit, q, parcel("pw-3", postcode="ZZ100"))
    stuck.run(Worker(q).run, stop_when_idle=True)
    answers = [stuck.run(cli.cmd_release, q, "pw-3", customs_cleared=True) for _ in range(2)]
    stuck.run(Worker(q).run, stop_when_idle=True)
    explored = sorted({s["sym"] for s in happy.steps + stuck.steps})
    rows = [
        {"walk": 1, "tool": "trace.py@1", "kind": "run", "pin": tree_pin()},
        {"label": "SAMPLED", "controls_passed": False, "explored": explored, "unexplored": [
            {"at": "trouble.hold_customs", "why": "no customs-value parcel in this run"},
            {"at": "trouble.failed", "why": "no outage-zone parcel in this run"},
            {"at": "work.lease_lost", "why": "no lease expired in this run"},
            {"at": "intake.fast_done", "why": "FAST_LANE was off"}]},
        {"outcome": "end:report.saved", "strength": "observed", "reason": "parcel pw-1 labelled, completed, reported",
         "witness": None, "count": 1, "steps": happy.steps},
        {"outcome": "stuck:trouble.hold_address", "strength": "observed",
         "reason": f"parcel pw-3 still in hold after 2 release requests: {answers[-1]['message']}",
         "witness": None, "count": 1, "steps": stuck.steps},
    ]
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.writelines(json.dumps(r) + "\n" for r in rows)
    print(out, len(happy.steps), "happy steps,", len(stuck.steps), "stuck steps")


def make_coverage(out):
    env = dict(os.environ, COVERAGE_FILE=os.path.join(tempfile.gettempdir(), "toy.coverage"))
    run = [sys.executable, "-m", "coverage", "run", "-m", "unittest"]
    done = subprocess.run(run, cwd=TOY, env=env, capture_output=True, text=True)
    print(done.stderr.strip().splitlines()[-1])
    subprocess.run([sys.executable, "-m", "coverage", "json", "-o", out], cwd=TOY, env=env, check=True,
                   capture_output=True)
    with open(out, encoding="utf-8") as fh:
        data = json.load(fh)
    data["files"] = {k.replace("\\", "/"): v for k, v in sorted(data["files"].items())}
    data["meta"].pop("timestamp", None)
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=1)
        fh.write("\n")
    print(out, len(data["files"]), "files")


if __name__ == "__main__":
    make_walk(os.path.join(TOY, "fixtures", "address-hold.walk.jsonl"))
    make_coverage(os.path.join(TOY, "fixtures", "coverage.json"))
