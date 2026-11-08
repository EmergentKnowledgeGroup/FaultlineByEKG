"""Explorer adapter for Parcelworks: JSON lines on stdin/stdout, stdlib only (Python 3.9+).

It drives the real code (cli.cmd_submit, worker.Worker.process_one, cli.cmd_release over a real in-memory queue), so the
search runs the system, not a copy of it. A state is the job table plus the clock; the adapter rebuilds a queue from the
state for every call, so every op is pure.

  python -I -B explorer_adapter.py [--parcels zz,customs,ok,outage] [--horizon 600] [--broken all-stuck|none-stuck]

--broken exists only to prove the runner's controls catch a bad checker. `where` names a box id from the checked-in model
(the place the system rests at), which is how this adapter is tied to examples/toy/.faultline/model.
"""
import argparse
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # -I drops the script folder from sys.path
RUN_DIR = os.path.realpath(os.environ.get("FAULTLINE_RUN_DIR") or os.getcwd())


# ---- offline guard: no network, no child processes, writes only inside the run folder ----------------------------
def _inside_run_dir(p):
    if isinstance(p, int) or p is None:
        return True
    try:
        real = os.path.realpath(os.fsdecode(p))
    except (TypeError, ValueError):
        return False
    a, b = os.path.normcase(real), os.path.normcase(RUN_DIR)
    return a == b or a.startswith(b + os.sep)


_NET = {"socket.connect", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr", "socket.sendto"}
_PROC = {"subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty", "os.startfile"}
_WRITE_PATH = {"os.remove", "os.rmdir", "os.mkdir", "os.truncate", "os.chmod", "shutil.rmtree", "shutil.copyfile", "shutil.move"}


def _guard(event, args):
    if event in _NET:
        raise PermissionError("faultline guard: network is off")
    if event in _PROC:
        raise PermissionError("faultline guard: child processes are off")
    if event == "open":
        path, mode, flags = args[0], args[1], args[2]
        writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or \
                  (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC))
        if writing and not _inside_run_dir(path):
            raise PermissionError("faultline guard: writes outside the run folder are off")
    elif event in _WRITE_PATH or event == "os.rename":
        for p in args[:2] if event == "os.rename" else args[:1]:
            if not _inside_run_dir(p):
                raise PermissionError("faultline guard: writes outside the run folder are off")
    elif event == "sqlite3.connect":
        if args and args[0] not in (":memory:", "") and not _inside_run_dir(args[0]):
            raise PermissionError("faultline guard: database outside the run folder")


sys.addaudithook(_guard)

from parcelworks import cli, config, handlers, jobqueue  # noqa: E402  (after the guard is armed)
from parcelworks.worker import Worker  # noqa: E402

PARCELS = {
    "ok": {"id": "pw-ok", "sender": "A", "recipient": "B", "postcode": "10001", "weight_g": 500},
    "zz": {"id": "pw-zz", "sender": "A", "recipient": "B", "postcode": "ZZ123", "weight_g": 500},
    "customs": {"id": "pw-cu", "sender": "A", "recipient": "B", "postcode": "20002", "weight_g": 900, "declared_cents": 90000},
    "outage": {"id": "pw-out", "sender": "A", "recipient": "B", "postcode": "99001", "weight_g": 400},
}
COLS = ["id", "status", "attempts", "available_at", "hold_reason", "last_error", "result", "created_at"]
BOX = {("hold", "address"): "trouble.hold_address", ("hold", "customs"): "trouble.hold_customs", ("failed", ""): "trouble.failed",
       ("leased", ""): "queue.leased", ("pending", ""): "queue.pending", ("done", ""): "queue.done"}
PRIORITY = ["trouble.hold_address", "trouble.hold_customs", "trouble.failed", "trouble.backoff", "queue.leased", "queue.pending", "queue.done"]


class Cfg:
    parcels = ["zz", "customs", "ok", "outage"]
    horizon = 600.0
    broken = None


# ---- state <-> real queue -------------------------------------------------------------------------------------
def build_queue(state):
    clock = {"now": float(state["clock"])}
    q = jobqueue.Queue(":memory:", clock=lambda: clock["now"])
    for j in state["jobs"]:
        q.db.execute("INSERT INTO jobs (id, payload, status, attempts, available_at, hold_reason, last_error, result, created_at) "
                     "VALUES (?,?,?,?,?,?,?,?,?)",
                     (j["id"], json.dumps(j["parcel"]), j["status"], j["attempts"], j["available_at"], j["hold_reason"] or None,
                      j["last_error"] or None, j["result"] or None, j["created_at"]))
    return q, clock


def dump(q, clock, sub):
    jobs = []
    for r in q.db.execute("SELECT * FROM jobs ORDER BY created_at, rowid").fetchall():
        d = {k: r[k] for k in COLS}
        d["parcel"] = json.loads(r["payload"])
        d["hold_reason"] = d["hold_reason"] or ""
        d["last_error"] = d["last_error"] or ""
        d["result"] = d["result"] or ""
        jobs.append(d)
    return {"clock": clock["now"], "sub": sorted(sub), "jobs": jobs}


def job(kind, status, clock=0.0, hold_reason="", attempts=0):
    p = dict(PARCELS[kind])
    p.update({"declared_cents": p.get("declared_cents", 0), "service": "standard"})
    return {"id": p["id"], "status": status, "attempts": attempts, "available_at": clock, "hold_reason": hold_reason, "last_error": "",
            "result": "", "created_at": clock, "parcel": p}


# ---- the contract ops ---------------------------------------------------------------------------------------------
def ready(state):
    return [j for j in state["jobs"] if j["status"] == "pending" and j["available_at"] <= state["clock"]]


def actions(state):
    out = []
    out += ["submit:" + k for k in Cfg.parcels if k not in state["sub"]]
    if ready(state):
        out.append("tick")
    future = [j["available_at"] for j in state["jobs"] if j["status"] == "pending" and j["available_at"] > state["clock"]]
    if future:
        out.append("wait")
    for j in state["jobs"]:
        if j["status"] == "hold":
            out += ["release:" + j["id"], "release_cleared:" + j["id"]]
    return sorted(out)


def apply(state, action):
    if action not in actions(state):
        return {"rejected": "not legal here"}
    q, clock = build_queue(state)
    sub = set(state["sub"])
    try:
        if action.startswith("submit:"):
            kind = action.split(":", 1)[1]
            cli.cmd_submit(q, dict(PARCELS[kind]))
            sub.add(kind)
        elif action == "tick":
            Worker(q, handler=handlers.route, worker_id="w1").process_one()
        elif action == "wait":
            clock["now"] = min(j["available_at"] for j in state["jobs"] if j["status"] == "pending" and j["available_at"] > state["clock"])
        else:
            name, job_id = action.split(":", 1)
            cli.cmd_release(q, job_id, customs_cleared=(name == "release_cleared"))
        return {"state": dump(q, clock, sub)}
    finally:
        q.close()


def _stuck_holds(state):
    """A held job is stuck when every operator action the model offers for it, run through the real cmd_release, leaves it held."""
    out = []
    for j in state["jobs"]:
        if j["status"] != "hold":
            continue
        still = True
        for cleared in (False, True):
            q, _ = build_queue(state)
            try:
                cli.cmd_release(q, j["id"], customs_cleared=cleared)
                if q.get(j["id"]).status.value != "hold":
                    still = False
            finally:
                q.close()
        if still:
            out.append(j)
    return out


def classify(state):
    if Cfg.broken == "all-stuck":
        return {"class": "stuck", "reason": "broken_checker"}
    if Cfg.broken == "none-stuck":
        return {"class": "ok", "reason": "broken_checker"}
    if any(j["status"] == "leased" for j in state["jobs"]):
        return {"class": "invalid", "reason": "leased_at_rest"}
    stuck = _stuck_holds(state)
    if stuck:
        return {"class": "stuck", "reason": "no_exit:hold_" + stuck[0]["hold_reason"]}
    if state["clock"] > Cfg.horizon:
        return {"class": "cut", "reason": "past_horizon"}
    active = [j for j in state["jobs"] if j["status"] in ("pending", "hold")]
    if not active:
        return {"class": "end", "reason": "all_settled"} if state["jobs"] and set(Cfg.parcels) <= set(state["sub"]) else {"class": "ok", "reason": "idle"}
    if not ready(state) and all(j["status"] == "hold" for j in active):
        return {"class": "wait", "reason": "waiting_for_operator"}
    return {"class": "ok", "reason": "working"}


def identity(state):
    return {"bytes": json.dumps(state, sort_keys=True, separators=(",", ":"))}


def where(state):
    boxes = set()
    for j in state["jobs"]:
        key = (j["status"], j["hold_reason"] if j["status"] == "hold" else "")
        box = BOX.get(key, "")
        if box == "queue.pending" and j["last_error"]:
            box = "trouble.backoff"
        if box:
            boxes.add(box)
    for b in PRIORITY:
        if b in boxes:
            return b
    return ""


def controls():
    n = {"clock": 0.0, "sub": [], "jobs": []}
    allsub = sorted(Cfg.parcels)
    return {"controls": [
        {"name": "empty_queue", "state": n, "expect": "ok"},
        {"name": "address_hold_has_no_exit", "state": {"clock": 1.0, "sub": ["zz"], "jobs": [job("zz", "hold", 1.0, "address")]}, "expect": "stuck"},
        {"name": "customs_hold_can_be_released", "state": {"clock": 1.0, "sub": ["customs"], "jobs": [job("customs", "hold", 1.0, "customs")]}, "expect": "wait"},
        {"name": "pending_parcel_is_working", "state": {"clock": 0.0, "sub": ["ok"], "jobs": [job("ok", "pending")]}, "expect": "ok"},
        {"name": "everything_delivered", "state": {"clock": 0.0, "sub": allsub, "jobs": [job(k, "done") for k in allsub]}, "expect": "end"},
    ]}


def code_hash():
    """Same scheme as the checked-in walk pin: sha256 over the per-file hashes of parcelworks/*.py, in file-name order."""
    d = os.path.join(HERE, "parcelworks")
    hs = [hashlib.sha256(open(os.path.join(d, f), "rb").read()).hexdigest() for f in sorted(os.listdir(d)) if f.endswith(".py")]
    return hashlib.sha256("".join(hs).encode()).hexdigest()


def manifest():
    cfg = {"parcels": Cfg.parcels, "horizon": Cfg.horizon, "broken": Cfg.broken,
           "limits": [config.max_attempts(), config.lease_seconds(), config.backoff_base_s(), config.customs_limit_cents()]}
    return {"protocol": "faultline.explorer/1", "adapter": "parcelworks-explorer", "version": "1", "code": code_hash(),
            "input": hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest(), "guard": {"selftest": True}}


def selftest():
    """Try each forbidden thing for real; true means it was refused."""
    import socket
    import subprocess

    def refused(fn):
        try:
            fn()
        except PermissionError:
            return True
        except Exception:
            return False
        return False
    return {"network": refused(lambda: socket.create_connection(("127.0.0.1", 9), timeout=0.2)),
            "subprocess": refused(lambda: subprocess.run([sys.executable, "-c", "pass"])),
            "writes": refused(lambda: open(os.path.join(HERE, "_faultline_probe.txt"), "w"))}


OPS = {
    "manifest": lambda r: manifest(),
    "selftest": lambda r: selftest(),
    "initial": lambda r: {"states": [{"clock": 0.0, "sub": [], "jobs": []}]},
    "actions": lambda r: {"actions": [{"id": a} for a in actions(r["state"])]},
    "apply": lambda r: apply(r["state"], r["action"]),
    "classify": lambda r: classify(r["state"]),
    "identity": lambda r: identity(r["state"]),
    "where": lambda r: where(r["state"]),
    "controls": lambda r: controls(),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parcels", default=",".join(Cfg.parcels))
    ap.add_argument("--horizon", type=float, default=Cfg.horizon)
    ap.add_argument("--broken", choices=["all-stuck", "none-stuck"])
    a = ap.parse_args()
    Cfg.parcels, Cfg.horizon, Cfg.broken = [p for p in a.parcels.split(",") if p], a.horizon, a.broken
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        try:
            res = OPS[req["op"]](req)
            out = {"id": req["id"], "ok": True, "result": res}
        except Exception as exc:  # report, keep serving
            out = {"id": req.get("id"), "ok": False, "error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
