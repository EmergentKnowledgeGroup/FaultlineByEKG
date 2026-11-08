"""Durable job queue on SQLite: enqueue, claim with a lease, complete, fail with backoff, hold."""
import json
import sqlite3
import time
import uuid
from dataclasses import dataclass

from . import config
from .schema import JobStatus

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, available_at REAL NOT NULL,
  lease_token TEXT, lease_owner TEXT, lease_until REAL, hold_reason TEXT,
  last_error TEXT, result TEXT, created_at REAL NOT NULL
)"""


@dataclass
class Job:
    id: str
    parcel: dict
    status: JobStatus
    attempts: int
    token: str
    hold_reason: str
    last_error: str
    result: str


def backoff_delay(attempts):
    """Seconds to wait after the Nth failed attempt: base * 2^(N-1), capped at 5 minutes."""
    return min(config.backoff_base_s() * 2 ** (attempts - 1), 300.0)


class Queue:
    def __init__(self, path=":memory:", clock=time.time):
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.clock = clock
        self.db.execute(SCHEMA)

    def close(self):
        self.db.close()

    def _job(self, row):
        if row is None:
            return None
        return Job(row["id"], json.loads(row["payload"]), JobStatus(row["status"]), row["attempts"],
                   row["lease_token"] or "", row["hold_reason"] or "", row["last_error"] or "",
                   row["result"] or "")

    def _set(self, job_id, **cols):
        names = ", ".join(f"{k}=?" for k in cols)
        self.db.execute(f"UPDATE jobs SET {names} WHERE id=?", (*cols.values(), job_id))

    def exists(self, job_id):
        return self.db.execute("SELECT 1 FROM jobs WHERE id=?", (job_id,)).fetchone() is not None

    def get(self, job_id):
        return self._job(self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())

    def all_jobs(self):
        rows = self.db.execute("SELECT * FROM jobs ORDER BY created_at, rowid").fetchall()
        return [self._job(r) for r in rows]

    def enqueue(self, parcel, status=JobStatus.PENDING):
        now = self.clock()
        self.db.execute("INSERT INTO jobs (id, payload, status, available_at, created_at) VALUES (?,?,?,?,?)",
                        (parcel.id, json.dumps(parcel.to_dict()), status.value, now, now))
        return parcel.id

    def claim(self, worker_id):
        """Lease the oldest ready job to one worker. Returns None when nothing is ready."""
        now = self.clock()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute(
                "SELECT id FROM jobs WHERE status=? AND available_at<=? ORDER BY created_at, rowid LIMIT 1",
                (JobStatus.PENDING.value, now)).fetchone()
            if row is None:
                self.db.execute("COMMIT")
                return None
            token = uuid.uuid4().hex
            self.db.execute("UPDATE jobs SET status=?, attempts=attempts+1, lease_token=?, "
                            "lease_owner=?, lease_until=? WHERE id=?",
                            (JobStatus.LEASED.value, token, worker_id, now + config.lease_seconds(), row["id"]))
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return self.get(row["id"])

    def reclaim_expired(self):
        """Put jobs whose lease ran out back in line, or fail them if they are out of attempts."""
        now = self.clock()
        rows = self.db.execute("SELECT id, attempts FROM jobs WHERE status=? AND lease_until<?",
                               (JobStatus.LEASED.value, now)).fetchall()
        for row in rows:
            if row["attempts"] >= config.max_attempts():
                self._set(row["id"], status=JobStatus.FAILED.value, last_error="lease expired on final attempt",
                          lease_token=None)
            else:
                self._set(row["id"], status=JobStatus.PENDING.value, available_at=now, lease_token=None)
        return len(rows)

    def complete(self, job_id, token, result=""):
        """Mark a leased job done. False means the lease is no longer ours."""
        cur = self.db.execute("UPDATE jobs SET status=?, result=?, lease_token=NULL "
                              "WHERE id=? AND lease_token=? AND status=?",
                              (JobStatus.DONE.value, result, job_id, token, JobStatus.LEASED.value))
        return cur.rowcount == 1

    def fail(self, job_id, token, error):
        """Record a failed attempt. Returns 'retry' (backoff set), 'failed' (out of attempts) or 'stale'."""
        row = self.db.execute("SELECT attempts FROM jobs WHERE id=? AND lease_token=? AND status=?",
                              (job_id, token, JobStatus.LEASED.value)).fetchone()
        if row is None:
            return "stale"
        if row["attempts"] >= config.max_attempts():
            self._set(job_id, status=JobStatus.FAILED.value, last_error=error, lease_token=None)
            return "failed"
        self._set(job_id, status=JobStatus.PENDING.value, last_error=error, lease_token=None,
                  available_at=self.clock() + backoff_delay(row["attempts"]))
        return "retry"

    def hold(self, job_id, token, reason):
        """Park a leased job until someone releases it. Returns False if the lease is gone."""
        cur = self.db.execute("UPDATE jobs SET status=?, hold_reason=?, lease_token=NULL "
                              "WHERE id=? AND lease_token=? AND status=?",
                              (JobStatus.HOLD.value, reason, job_id, token, JobStatus.LEASED.value))
        return cur.rowcount == 1

    def release_hold(self, job_id):
        """Move a held job back into line. Customs holds are marked cleared so routing lets them through."""
        job = self.get(job_id)
        if job is None or job.status is not JobStatus.HOLD:
            return False
        parcel = dict(job.parcel)
        if job.hold_reason == "customs":
            parcel["customs_cleared"] = True
        self._set(job_id, status=JobStatus.PENDING.value, hold_reason=None, attempts=0,
                  payload=json.dumps(parcel), available_at=self.clock())
        return True
