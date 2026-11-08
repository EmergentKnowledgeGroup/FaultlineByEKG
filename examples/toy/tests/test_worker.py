import unittest

from parcelworks import cli, intake
from parcelworks.handlers import TransientError, route
from parcelworks.jobqueue import backoff_delay
from parcelworks.schema import JobStatus
from parcelworks.worker import Worker

from .util import env, make_queue, raw


def drain(worker, clock, rounds=20):
    """Run the worker, jumping the clock past each backoff, until nothing is left to do."""
    seen = []
    for _ in range(rounds):
        ending = worker.process_one()
        if ending is None:
            clock.advance(backoff_delay(10))
            ending = worker.process_one()
        if ending is None:
            break
        seen.append(ending)
    return seen


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.queue, self.clock = make_queue()
        self.addCleanup(self.queue.close)
        self.worker = Worker(self.queue, sleep=lambda s: None)

    def test_happy_path(self):
        intake.accept(self.queue, raw())
        self.assertEqual(self.worker.process_one(), "done")
        job = self.queue.get("pw-1")
        self.assertEqual((job.status, job.result), (JobStatus.DONE, "LBL-pw-1"))

    def test_idle_worker_gets_nothing(self):
        self.assertIsNone(self.worker.process_one())

    def test_outage_retries_then_fails_for_good(self):
        intake.accept(self.queue, raw(postcode="99001"))
        self.assertEqual(drain(self.worker, self.clock), ["retry", "retry", "retry", "failed"])
        job = self.queue.get("pw-1")
        self.assertEqual((job.status, job.attempts), (JobStatus.FAILED, 4))
        self.assertIn("carrier unreachable", job.last_error)

    def test_flaky_carrier_recovers(self):
        calls = []

        def flaky(parcel):
            calls.append(1)
            return route(parcel, book=lambda p: self._flaky_book(calls))

        intake.accept(self.queue, raw())
        worker = Worker(self.queue, handler=flaky)
        self.assertEqual(drain(worker, self.clock), ["retry", "retry", "done"])

    @staticmethod
    def _flaky_book(calls):
        if len(calls) < 3:
            raise TransientError("busy")
        return "LBL-OK"

    def test_customs_hold_waits_then_clears_on_release(self):
        intake.accept(self.queue, raw(declared_cents=90000))
        self.assertEqual(self.worker.process_one(), "held")
        self.assertIsNone(self.worker.process_one())
        self.assertEqual(self.queue.get("pw-1").hold_reason, "customs")
        self.assertFalse(cli.cmd_release(self.queue, "pw-1")["ok"])
        self.assertTrue(cli.cmd_release(self.queue, "pw-1", customs_cleared=True)["ok"])
        self.assertEqual(self.worker.process_one(), "done")

    def test_address_hold_stays_held(self):
        intake.accept(self.queue, raw(postcode="ZZ100"))
        self.assertEqual(self.worker.process_one(), "held")
        answer = cli.cmd_release(self.queue, "pw-1", customs_cleared=True)
        self.assertEqual(answer, {"ok": False, "message": "still on hold (address)"})
        self.assertIsNone(self.worker.process_one())
        self.assertIs(self.queue.get("pw-1").status, JobStatus.HOLD)

    def test_release_of_unknown_job(self):
        self.assertFalse(cli.cmd_release(self.queue, "nope")["ok"])

    def test_run_stops_when_idle(self):
        intake.accept(self.queue, raw())
        intake.accept(self.queue, raw("pw-2", declared_cents=90000))
        self.assertEqual(self.worker.run(stop_when_idle=True), {"done": 1, "held": 1})

    def test_run_respects_max_ticks_and_sleeps_when_idle(self):
        naps = []
        worker = Worker(self.queue, sleep=naps.append, idle_s=0.5)
        self.assertEqual(worker.run(max_ticks=3), {})
        self.assertEqual(naps, [0.5, 0.5, 0.5])

    def test_retry_limit_comes_from_env(self):
        intake.accept(self.queue, raw(postcode="99001"))
        with env(MAX_ATTEMPTS=2):
            self.assertEqual(drain(self.worker, self.clock), ["retry", "failed"])


if __name__ == "__main__":
    unittest.main()
