"""Worker loop: reclaim expired leases, claim one job, route it, settle it."""
import time

from . import handlers
from .handlers import TransientError


class Worker:
    def __init__(self, queue, handler=handlers.route, worker_id="w1", idle_s=1.0, sleep=time.sleep):
        self.queue = queue
        self.handler = handler
        self.worker_id = worker_id
        self.idle_s = idle_s
        self.sleep = sleep

    def process_one(self):
        """Run one job. Returns its ending name, or None when nothing was ready."""
        self.queue.reclaim_expired()
        job = self.queue.claim(self.worker_id)
        if job is None:
            return None
        try:
            verdict = self.handler(job.parcel)
        except TransientError as exc:
            result = self.queue.fail(job.id, job.token, str(exc))
        else:
            if verdict.hold_reason:
                result = "held" if self.queue.hold(job.id, job.token, verdict.hold_reason) else "stale"
            else:
                result = "done" if self.queue.complete(job.id, job.token, verdict.label) else "stale"
        if result == "stale":
            return "lease_lost"
        return result

    def run(self, max_ticks=None, stop_when_idle=False):
        """The worker loop. Returns how many times each ending happened."""
        seen = {}
        ticks = 0
        while max_ticks is None or ticks < max_ticks:
            ticks += 1
            ending = self.process_one()
            if ending is None:
                if stop_when_idle:
                    break
                self.sleep(self.idle_s)
                continue
            seen[ending] = seen.get(ending, 0) + 1
        return seen
