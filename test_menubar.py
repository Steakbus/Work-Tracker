import os
import shlex
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class MenubarTest(unittest.TestCase):
    def test_action_paths_with_spaces(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"TRACKER_DB": str(Path(directory) / "tracker.db")}):
                import app as tracker

            with patch.object(tracker, "DB_PATH", str(Path(directory) / "tracker.db")):
                tracker.init_db()
                client = tracker.app.test_client()
                plugin = "/Users/test/projects/git repos/Work-Tracker/menubar/worktracker.sh"
                for running, actions in ((False, {"start", "start-note"}), (True, {"stop"})):
                    if running:
                        self.assertEqual(client.post("/api/start").status_code, 200)
                    response = client.get("/api/menubar")
                    self.assertEqual(response.status_code, 200)
                    found = set()
                    for line in response.get_data(as_text=True).replace("@ME@", plugin).splitlines():
                        if "bash=" not in line:
                            continue
                        params = dict(token.split("=", 1) for token in shlex.split(line.split("|", 1)[1]) if "=" in token)
                        found.add(params["param1"])
                        with self.subTest(action=params["param1"]):
                            self.assertEqual(params["bash"], plugin)
                    self.assertEqual(found, actions)
                self.assertEqual(client.post("/api/stop").status_code, 200)
                self.assertIsNone(client.get("/api/status").get_json()["running"])


if __name__ == "__main__":
    unittest.main()
