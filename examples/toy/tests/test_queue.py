import unittest

from parcelworks import intake
from parcelworks.jobqueue import backoff_delay
from parcelworks.schema import JobStatus

from .util import env, make_queue, raw


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.queue, self.clock = make_queue()
        self.addCleanup(self.queue.close)
        intake.accept(self.queue, raw())

    def test_claim_then_complete(self):
        job = self.queue.claim("w1")
        self.assertEqual((job.id, job.attempts, job.status), ("pw-1", 1, JobStatus.LEASED))
        self.assertTrue(self.queue.complete("pw-1", job.token, "LBL-pw-1"))
        self.assertIs(self.queue.get("pw-1").status, JobStatus.DONE)

    def test_claim_when_empty(self):
        self.queue.claim("w1")
        self.assertIsNone(self.queue.claim("w2"))

    def test_fail_retries_after_backoff(self):
        job = self.queue.claim("w1")
        self.assertEqual(self.queue.fail("pw-1", job.token, "boom"), "retry")
        self.assertIsNone(self.queue.claim("w1"))
        self.clock.advance(backoff_delay(1))
        self.assertEqual(self.queue.claim("w1").attempts, 2)

    def test_fail_gives_up_at_the_limit(self):
        with env(MAX_ATTEMPTS=1):
            job = self.queue.claim("w1")
            self.assertEqual(self.queue.fail("pw-1", job.token, "boom"), "failed")
        self.assertEqual(self.queue.get("pw-1").last_error, "boom")

    def test_backoff_doubles_and_caps(self):
        self.assertEqual([backoff_delay(n) for n in (1, 2, 3)], [2.0, 4.0, 8.0])
        self.assertEqual(backoff_delay(20), 300.0)

    def test_expired_lease_goes_back_in_line(self):
        self.queue.claim("w1")
        self.assertEqual(self.queue.reclaim_expired(), 0)
        self.clock.advance(31)
        self.assertEqual(self.queue.reclaim_expired(), 1)
        self.assertIs(self.queue.get("pw-1").status, JobStatus.PENDING)

    def test_expired_lease_on_last_attempt_fails(self):
        with env(MAX_ATTEMPTS=1):
            self.queue.claim("w1")
            self.clock.advance(31)
            self.queue.reclaim_expired()
        self.assertIs(self.queue.get("pw-1").status, JobStatus.FAILED)

    def test_hold_and_release(self):
        job = self.queue.claim("w1")
        self.assertTrue(self.queue.hold("pw-1", job.token, "customs"))
        self.assertIs(self.queue.get("pw-1").status, JobStatus.HOLD)
        self.assertTrue(self.queue.release_hold("pw-1"))
        released = self.queue.get("pw-1")
        self.assertEqual((released.status, released.attempts), (JobStatus.PENDING, 0))
        self.assertTrue(released.parcel["customs_cleared"])

    def test_release_without_customs_paperwork_flag(self):
        job = self.queue.claim("w1")
        self.queue.hold("pw-1", job.token, "address")
        self.assertTrue(self.queue.release_hold("pw-1"))
        self.assertNotIn("customs_cleared", self.queue.get("pw-1").parcel)

    def test_release_of_a_job_not_on_hold(self):
        self.assertFalse(self.queue.release_hold("pw-1"))
        self.assertFalse(self.queue.release_hold("nope"))


if __name__ == "__main__":
    unittest.main()
