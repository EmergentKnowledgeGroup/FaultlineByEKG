import unittest

from parcelworks import intake
from parcelworks.jobqueue import Queue
from parcelworks.schema import JobStatus, Refusal

from .util import env, raw


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.queue = Queue(":memory:")
        self.addCleanup(self.queue.close)

    def refusal(self, payload):
        with self.assertRaises(Refusal) as ctx:
            intake.accept(self.queue, payload)
        return ctx.exception.code

    def test_good_parcel_is_queued(self):
        receipt = intake.accept(self.queue, raw())
        self.assertEqual(receipt, {"id": "pw-1", "lane": "normal", "status": "pending"})
        self.assertIs(self.queue.get("pw-1").status, JobStatus.PENDING)

    def test_missing_field(self):
        self.assertEqual(self.refusal(raw(recipient="")), "missing_field")

    def test_bad_weight(self):
        self.assertEqual(self.refusal(raw(weight_g=-5)), "bad_weight")
        self.assertEqual(self.refusal(raw(pid="pw-2", weight_g="heavy")), "bad_weight")

    def test_overweight_uses_env_limit(self):
        self.assertEqual(self.refusal(raw(weight_g=40000)), "overweight")
        with env(MAX_WEIGHT_G=100):
            self.assertEqual(self.refusal(raw(pid="pw-2", weight_g=800)), "overweight")

    def test_bad_postcode(self):
        self.assertEqual(self.refusal(raw(postcode="ab-1")), "bad_postcode")

    def test_bad_service(self):
        self.assertEqual(self.refusal(raw(service="drone")), "bad_service")

    def test_duplicate(self):
        intake.accept(self.queue, raw())
        self.assertEqual(self.refusal(raw()), "duplicate")
        self.assertEqual(len(self.queue.all_jobs()), 1)

    def test_fast_lane_is_off_by_default(self):
        receipt = intake.accept(self.queue, raw(service="express", weight_g=200))
        self.assertEqual(receipt["lane"], "normal")

    def test_fast_lane_when_switched_on(self):
        with env(FAST_LANE=1):
            fast = intake.accept(self.queue, raw(service="express", weight_g=200))
            slow = intake.accept(self.queue, raw(pid="pw-2", service="express", weight_g=900))
        self.assertEqual(fast["lane"], "fast")
        self.assertIs(self.queue.get("pw-1").status, JobStatus.DONE)
        self.assertEqual(slow["lane"], "normal")


if __name__ == "__main__":
    unittest.main()
