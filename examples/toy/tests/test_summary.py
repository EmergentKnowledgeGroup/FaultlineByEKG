import contextlib
import io
import json
import os
import tempfile
import unittest

from parcelworks import cli, intake, report
from parcelworks.worker import Worker

from .util import env, make_queue, raw


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.queue, self.clock = make_queue()
        self.addCleanup(self.queue.close)
        for payload in (raw("pw-1"), raw("pw-2", declared_cents=90000), raw("pw-3", postcode="ZZ100")):
            intake.accept(self.queue, payload)
        Worker(self.queue).run(stop_when_idle=True)

    def test_summary_counts_every_outcome_name(self):
        summary = report.summarize(self.queue)
        self.assertEqual(summary["counts"], {"delivered": 1, "dead_letter": 0, "held": 2,
                                             "returned_to_sender": 0})
        self.assertEqual(summary["held"], [("pw-2", "customs"), ("pw-3", "address")])
        self.assertEqual(summary["labels"], [("pw-1", "LBL-pw-1")])

    def test_render_lists_what_is_held(self):
        text = report.render(report.summarize(self.queue))
        self.assertIn("On hold:", text)
        self.assertIn("pw-2  customs", text)
        self.assertNotIn("Dead letters:", text)

    def test_render_lists_dead_letters(self):
        intake.accept(self.queue, raw("pw-4", postcode="99001"))
        with env(MAX_ATTEMPTS=1):
            Worker(self.queue).run(stop_when_idle=True)
        text = report.render(report.summarize(self.queue))
        self.assertIn("Dead letters:", text)
        self.assertIn("pw-4  carrier unreachable for 99001", text)

    def test_publish_writes_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = report.publish(self.queue, os.path.join(tmp, "r.txt"))
            with open(path, encoding="utf-8") as fh:
                self.assertTrue(fh.read().startswith("Parcelworks report"))


class CliTests(unittest.TestCase):
    def test_main_runs_the_whole_flow(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "report.txt")
            with env(PARCELWORKS_DB=os.path.join(tmp, "q.db")), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(["submit", json.dumps(raw())]), 0)
                self.assertEqual(cli.main(["submit", json.dumps(raw())]), 1)
                self.assertEqual(cli.main(["work"]), 0)
                self.assertEqual(cli.main(["release", "pw-1"]), 1)
                self.assertEqual(cli.main(["report", "--out", out]), 0)
            self.assertTrue(os.path.exists(out))

    def test_submit_reports_the_refusal_code(self):
        queue, _ = make_queue()
        self.addCleanup(queue.close)
        self.assertEqual(cli.cmd_submit(queue, raw(weight_g=-1))["refused"], "bad_weight")


if __name__ == "__main__":
    unittest.main()
