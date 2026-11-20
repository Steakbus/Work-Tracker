import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class Stop(Exception):
    pass


class UpdateCheckTest(unittest.TestCase):
    def test_announces_each_new_version_once(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"TRACKER_DB": str(Path(directory) / "tracker.db")}):
                import app as tracker

            now = [1_000_000.0]
            upstream = [[]]  # commits on GitHub that this copy doesn't have, newest first

            def sleep(sec):  # the checker's 10-minute nap; stop after 3 days
                now[0] += sec
                if now[0] > 1_000_000 + 3 * 86400:
                    raise Stop

            def info():
                if now[0] > 1_000_000 + 36 * 3600:
                    upstream[0] = [{"commit": "b2"}, {"commit": "a1"}]
                elif now[0] > 1_000_000 + 6 * 3600:
                    upstream[0] = [{"commit": "a1"}]
                return {"behind": upstream[0], "changed": []}

            announced = []
            with patch.object(tracker.clock, "time", lambda: now[0]), \
                    patch.object(tracker.clock, "sleep", sleep), \
                    patch.object(tracker, "update_info", info), \
                    patch.object(tracker, "notify", lambda *a: announced.append((now[0], a)) or True), \
                    patch.object(tracker, "notified_update", None):
                with self.assertRaises(Stop):
                    tracker.update_checker()

            # Checks at 0 h, 12 h, 24 h, 36 h, 48 h, 60 h, 72 h: a1 is found at 12 h, b2 at 48 h; once each.
            self.assertEqual([round((t - 1_000_000) / 3600) for t, _ in announced], [12, 48])
            self.assertEqual(announced[0][1], ("update", "Update available", "1 new change — open Settings → Updates to install."))
            self.assertIn("2 new changes", announced[1][1][2])

    def test_macos_notification_without_a_tab(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"TRACKER_DB": str(Path(directory) / "tracker.db")}):
            import app as tracker
        with patch.object(tracker.clock, "sleep", lambda s: None), \
                patch.object(tracker, "bump", lambda: None), \
                patch.object(tracker.sys, "platform", "darwin"), \
                patch.object(tracker.subprocess, "run") as run:
            self.assertFalse(tracker.notify("update", "Update available", "1 new change"))
        script = run.call_args[0][0][2]
        self.assertEqual(script, 'display notification "1 new change" with title "Work Tracker" '
                                 'subtitle "Update available" sound name "Glass"')


if __name__ == "__main__":
    unittest.main()
