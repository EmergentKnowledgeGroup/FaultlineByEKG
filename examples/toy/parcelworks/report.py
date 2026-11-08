"""Report step: count parcels by outcome and write a text summary to disk."""
import os
import time

from .schema import JobStatus, Outcome


def summarize(queue):
    """Count every settled parcel under its Outcome; in-flight jobs are not outcomes yet."""
    counts = {o.value: 0 for o in Outcome}
    held, failed, labels = [], [], []
    for job in queue.all_jobs():
        if job.status is JobStatus.DONE:
            counts[Outcome.DELIVERED.value] += 1
            labels.append((job.id, job.result or "-"))
        elif job.status is JobStatus.FAILED:
            counts[Outcome.DEAD_LETTER.value] += 1
            failed.append((job.id, job.last_error))
        elif job.status is JobStatus.HOLD:
            counts[Outcome.HELD.value] += 1
            held.append((job.id, job.hold_reason))
    return {"counts": counts, "held": held, "failed": failed, "labels": labels}


def render(summary):
    lines = ["Parcelworks report", ""]
    lines += [f"{name:<20}{n}" for name, n in summary["counts"].items()]
    for title, rows in (("On hold", summary["held"]), ("Dead letters", summary["failed"]),
                        ("Delivered", summary["labels"])):
        if rows:
            lines += ["", title + ":"] + [f"  {a}  {b}" for a, b in rows]
    return "\n".join(lines) + "\n"


def write_report(path, text):
    """Write the report atomically, trying again whenever the destination is busy."""
    attempt = 0
    while True:
        try:
            with open(path + ".tmp", "w", encoding="utf-8") as fh:
                fh.write(text)
            os.replace(path + ".tmp", path)
            return path
        except OSError:
            attempt += 1
            time.sleep(min(2 ** attempt, 30))


def publish(queue, path):
    return write_report(path, render(summarize(queue)))
