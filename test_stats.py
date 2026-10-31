import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class StatsTest(unittest.TestCase):
    def test_stats_for_a_week(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"TRACKER_DB": str(Path(directory) / "tracker.db")}):
                import app as tracker

            with patch.object(tracker, "DB_PATH", str(Path(directory) / "tracker.db")):
                tracker.init_db()
                client = tracker.app.test_client()
                # Mon 2025-03-03 … Fri 2025-03-07 (default goal: 8h Mon–Fri); Wednesday has no work.
                for start, end, note in (
                    ("2025-03-03T09:00", "2025-03-03T12:00", "Report"),
                    ("2025-03-03T13:00", "2025-03-03T18:00", "report"),     # same note, other case
                    ("2025-03-04T08:30", "2025-03-04T09:15", ""),
                    ("2025-03-06T22:00", "2025-03-07T02:00", "Late"),       # spans midnight
                ):
                    self.assertEqual(client.post("/api/sessions", json={
                        "start_time": start, "end_time": end, "note": note}).status_code, 201)

                st = client.get("/api/stats?from=2025-03-03&to=2025-03-09").get_json()
                self.assertEqual(st["total_seconds"], (3 + 5 + 0.75 + 4) * 3600)
                self.assertEqual(st["target_seconds"], 5 * 8 * 3600)
                self.assertEqual(st["active_days"], 4)
                self.assertEqual(st["goal_met_days"], 1)                # only Monday has 8h
                self.assertEqual((st["current_streak"], st["best_streak"]), (2, 2))  # Wednesday breaks it
                self.assertEqual(st["sessions"], 4)
                self.assertEqual(st["best_day"], ["2025-03-03", 8 * 3600])
                self.assertEqual(st["hours"][8], 30 * 60)
                self.assertEqual(st["hours"][23], 3600)
                self.assertEqual(st["hours"][1], 3600)
                self.assertEqual(st["notes"][0], {"note": "Report", "seconds": 8 * 3600})
                self.assertEqual(st["earliest_start"], ["2025-03-04", 8.5 * 60])
                self.assertEqual(st["latest_end"], ["2025-03-06", 26 * 60])  # 02:00 the next morning
                self.assertEqual([b["count"] for b in st["session_lengths"]], [0, 1, 0, 1, 2])
                self.assertEqual(len(st["weeks"]), 1)
                self.assertEqual(client.get("/api/stats?from=2025-03-09&to=2025-03-03").status_code, 400)


if __name__ == "__main__":
    unittest.main()
