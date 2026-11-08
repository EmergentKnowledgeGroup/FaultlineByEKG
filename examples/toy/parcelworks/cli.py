"""Command line: submit, work, release, report. Each command is also callable as a function."""
import argparse
import json
import sys

from . import config, intake, report
from .jobqueue import Queue
from .schema import JobStatus, Refusal
from .worker import Worker


def cmd_submit(queue, raw):
    try:
        return {"ok": True, **intake.accept(queue, raw)}
    except Refusal as err:
        return {"ok": False, "refused": err.code, "message": err.message}


def cmd_work(queue, forever=False):
    return Worker(queue).run(stop_when_idle=not forever)


def cmd_release(queue, job_id, customs_cleared=False):
    """A later request from an operator. Only customs holds with paperwork can leave HOLD."""
    job = queue.get(job_id)
    if job is None or job.status is not JobStatus.HOLD:
        return {"ok": False, "message": "not on hold"}
    if job.hold_reason == "customs" and customs_cleared:
        queue.release_hold(job_id)
        return {"ok": True, "message": "released"}
    return {"ok": False, "message": f"still on hold ({job.hold_reason})"}


def cmd_report(queue, out):
    return report.publish(queue, out)


def build_parser():
    parser = argparse.ArgumentParser(prog="parcelworks")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("submit").add_argument("json", help="parcel as a JSON object")
    work = sub.add_parser("work")
    work.add_argument("--forever", action="store_true")
    release = sub.add_parser("release")
    release.add_argument("id")
    release.add_argument("--customs-cleared", action="store_true")
    sub.add_parser("report").add_argument("--out", default="report.txt")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    queue = Queue(config.db_path())
    try:
        if args.command == "submit":
            out = cmd_submit(queue, json.loads(args.json))
        elif args.command == "work":
            out = cmd_work(queue, args.forever)
        elif args.command == "release":
            out = cmd_release(queue, args.id, args.customs_cleared)
        else:
            out = {"report": cmd_report(queue, args.out)}
        print(json.dumps(out))
        return 0 if out.get("ok", True) else 1
    finally:
        queue.close()


if __name__ == "__main__":
    sys.exit(main())
