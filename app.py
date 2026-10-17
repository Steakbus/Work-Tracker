"""Work Tracker — Flask + SQLite backend.

Run:  python app.py   then open http://localhost:47474
"""
import html
import logging
import os
import sqlite3
import subprocess
import sys
import threading
import time as clock
from datetime import date, datetime, time, timedelta
from string import Template

from flask import Flask, g, jsonify, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("TRACKER_DB", os.path.join(BASE_DIR, "tracker.db"))

# Default work goal; it applies to all days before the first change made in Settings → Work goals.
DAILY_TARGET = 8 * 3600       # seconds per workday
WORKDAYS = {0, 1, 2, 3, 4}    # Monday..Friday

app = Flask(__name__, static_folder="static", static_url_path="")
logging.getLogger("werkzeug").setLevel(logging.WARNING)  # no per-request access log


# ---------------------------------------------------------------- database

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                start_time  TEXT NOT NULL,          -- local time, ISO 8601
                end_time    TEXT,                   -- NULL while the timer runs
                note        TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_time);
            -- Times the Mac was asleep / locked / display off (only kept for recent sessions).
            CREATE TABLE IF NOT EXISTS away (
                start_time  TEXT NOT NULL,          -- last keyboard/trackpad input before leaving
                end_time    TEXT NOT NULL,          -- when you were back
                reason      TEXT NOT NULL           -- sleep | lock | display-off
            );
            -- Work goal changes: from valid_from on, daily_seconds on each of the workdays.
            CREATE TABLE IF NOT EXISTS targets (
                valid_from    TEXT PRIMARY KEY,     -- YYYY-MM-DD
                daily_seconds INTEGER NOT NULL,
                workdays      TEXT NOT NULL         -- weekday digits, Monday = 0, e.g. "01234"
            );
            """
        )


# ---------------------------------------------------------------- helpers

def fmt(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat(timespec="seconds")


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value)


def parse_day(value: str) -> date:
    return date.fromisoformat(value)


def session_dict(row) -> dict:
    start = parse(row["start_time"])
    end = parse(row["end_time"]) if row["end_time"] else None
    return {
        "id": row["id"],
        "start_time": row["start_time"],
        "end_time": row["end_time"],
        "note": row["note"],
        "running": end is None,
        "seconds": int(((end or datetime.now()) - start).total_seconds()),
    }


def daily_totals(first: date, last: date) -> dict:
    """Seconds worked per day (YYYY-MM-DD -> int) in [first, last].

    Sessions spanning midnight are split across the days they cover.
    """
    lo = datetime.combine(first, time.min)
    hi = datetime.combine(last + timedelta(days=1), time.min)
    rows = get_db().execute(
        "SELECT start_time, end_time FROM sessions "
        "WHERE start_time < ? AND (end_time IS NULL OR end_time > ?)",
        (fmt(hi), fmt(lo)),
    ).fetchall()

    now = datetime.now()
    totals: dict = {}
    for r in rows:
        s = max(parse(r["start_time"]), lo)
        e = min(parse(r["end_time"]) if r["end_time"] else now, hi)
        while s < e:
            chunk_end = min(e, datetime.combine(s.date() + timedelta(days=1), time.min))
            key = s.date().isoformat()
            totals[key] = totals.get(key, 0) + int((chunk_end - s).total_seconds())
            s = chunk_end
    return totals


def goal_table() -> list:
    """[(valid_from, daily_seconds, workdays)], oldest first; the defaults apply before any change."""
    rows = get_db().execute("SELECT * FROM targets ORDER BY valid_from").fetchall()
    return [(date.min, DAILY_TARGET, WORKDAYS)] + [
        (parse_day(r["valid_from"]), r["daily_seconds"], {int(c) for c in r["workdays"]}) for r in rows
    ]


def day_target(day: date, table: list) -> int:
    """Target seconds for one day under the goal that was valid on that day."""
    _, daily, workdays = next(g for g in reversed(table) if g[0] <= day)
    return daily if day.weekday() in workdays else 0


def expected_seconds(first: date, last: date, table: list) -> int:
    """Target seconds for all days in [first, last]."""
    return sum(day_target(first + timedelta(days=i), table) for i in range((last - first).days + 1))


def running_session():
    return get_db().execute(
        "SELECT * FROM sessions WHERE end_time IS NULL ORDER BY id DESC LIMIT 1"
    ).fetchone()


def bad_request(msg: str):
    return jsonify({"error": msg}), 400


# ---------------------------------------------------------------- pages

@app.get("/")
def index():
    return app.send_static_file("index.html")


# ---------------------------------------------------------------- API

@app.get("/api/status")
def status():
    global tab_seen_at
    if request.args.get("notify"):
        tab_seen_at = clock.time()
    db = get_db()
    today = date.today()
    monday = today - timedelta(days=today.weekday())

    week = daily_totals(monday, monday + timedelta(days=6))
    today_s = week.get(today.isoformat(), 0)
    week_s = sum(week.values())
    goals = goal_table()
    today_target = day_target(today, goals)
    week_targets = [day_target(monday + timedelta(days=i), goals) for i in range(7)]
    weekly_target = sum(week_targets)

    # Overtime balance: everything worked before today vs. target before today.
    first_row = db.execute("SELECT MIN(start_time) FROM sessions").fetchone()[0]
    balance = 0
    first_year = today.year
    if first_row:
        first_day = parse(first_row).date()
        first_year = first_day.year
        yesterday = today - timedelta(days=1)
        if first_day <= yesterday:
            worked = sum(daily_totals(first_day, yesterday).values())
            balance = worked - expected_seconds(first_day, yesterday, goals)

    run = running_session()
    return jsonify({
        "now": fmt(datetime.now()),
        "today": today.isoformat(),
        "daily_target": today_target,
        "weekly_target": weekly_target,
        "today_seconds": today_s,
        "week_seconds": week_s,
        "today_remaining": max(0, today_target - today_s),
        "week_remaining": max(0, weekly_target - week_s),
        "balance_seconds": balance,
        "first_year": first_year,
        "week_days": [
            {
                "date": (monday + timedelta(days=i)).isoformat(),
                "seconds": week.get((monday + timedelta(days=i)).isoformat(), 0),
                "target": week_targets[i],
            }
            for i in range(7)
        ],
        "running": session_dict(run) if run else None,
        "last_reminder": last_reminder,
        "reminder_kind": reminder_kind,
        "watcher": watcher_running,
    })


@app.get("/api/goals")
def get_goals():
    """All goal periods: the defaults (valid_from null) and every change, oldest first."""
    return jsonify([
        {"valid_from": None if start == date.min else start.isoformat(), "daily_seconds": daily,
         "workdays": sorted(workdays)}
        for start, daily, workdays in goal_table()
    ])


@app.put("/api/goals")
def set_goal():
    """New goal from valid_from (today or later) on. Past days keep the goal they had."""
    data = request.get_json(silent=True) or {}
    try:
        start = parse_day(data["valid_from"])
        workdays = sorted({int(d) for d in data["workdays"]})
        weekly = float(data["weekly_hours"])
    except (KeyError, TypeError, ValueError):
        return bad_request("valid_from (YYYY-MM-DD), weekly_hours and workdays (0 = Monday) are required.")
    if start < date.today():
        return bad_request("Goals can only change from today on — past days keep the goal they had.")
    if not workdays or not all(0 <= d <= 6 for d in workdays):
        return bad_request("Pick at least one workday.")
    daily = round(weekly * 3600 / len(workdays))
    if not 0 < daily <= 24 * 3600:
        return bad_request("That's not a possible number of hours.")
    db = get_db()
    db.execute("INSERT OR REPLACE INTO targets VALUES (?, ?, ?)",
               (start.isoformat(), daily, "".join(map(str, workdays))))
    db.commit()
    return get_goals()


@app.delete("/api/goals/<valid_from>")
def delete_goal(valid_from):
    """Cancel a goal change that hasn't started yet."""
    try:
        start = parse_day(valid_from)
    except ValueError:
        return bad_request("Use YYYY-MM-DD.")
    if start <= date.today():
        return bad_request("Only changes that start in the future can be cancelled.")
    db = get_db()
    db.execute("DELETE FROM targets WHERE valid_from = ?", (valid_from,))
    db.commit()
    return get_goals()


@app.post("/api/start")
def start():
    db = get_db()
    if running_session():
        return bad_request("Timer is already running.")
    note = (request.get_json(silent=True) or {}).get("note", "").strip()
    db.execute("INSERT INTO sessions (start_time, note) VALUES (?, ?)", (fmt(datetime.now()), note))
    db.commit()
    return jsonify(session_dict(running_session()))


@app.post("/api/stop")
def stop():
    db = get_db()
    run = running_session()
    if not run:
        return bad_request("Timer is not running.")
    note = (request.get_json(silent=True) or {}).get("note", run["note"]).strip()
    db.execute(
        "UPDATE sessions SET end_time = ?, note = ? WHERE id = ?", (fmt(datetime.now()), note, run["id"])
    )
    db.commit()
    row = db.execute("SELECT * FROM sessions WHERE id = ?", (run["id"],)).fetchone()
    return jsonify(session_dict(row))


@app.get("/api/days")
def days():
    """Per-day totals for the heatmap: /api/days?from=YYYY-MM-DD&to=YYYY-MM-DD"""
    try:
        first = parse_day(request.args["from"])
        last = parse_day(request.args["to"])
    except (KeyError, ValueError):
        return bad_request("Use ?from=YYYY-MM-DD&to=YYYY-MM-DD")
    if (last - first).days > 800:
        return bad_request("Range too large.")
    return jsonify(daily_totals(first, last))


@app.get("/api/sessions")
def list_sessions():
    """Sessions overlapping a given day: /api/sessions?date=YYYY-MM-DD"""
    try:
        day = parse_day(request.args["date"])
    except (KeyError, ValueError):
        return bad_request("Use ?date=YYYY-MM-DD")
    lo = fmt(datetime.combine(day, time.min))
    hi = fmt(datetime.combine(day + timedelta(days=1), time.min))
    rows = get_db().execute(
        "SELECT * FROM sessions WHERE start_time < ? AND (end_time IS NULL OR end_time > ?) "
        "ORDER BY start_time",
        (hi, lo),
    ).fetchall()
    db = get_db()
    out = []
    for r in rows:
        s = session_dict(r)
        s["away"] = [dict(a) for a in db.execute(
            "SELECT start_time, end_time, reason FROM away WHERE start_time < ? AND end_time > ? "
            "ORDER BY start_time",
            (r["end_time"] or fmt(datetime.now()), r["start_time"]),
        )]
        out.append(s)
    return jsonify(out)


def read_session_body(end_optional=False):
    """(start, end, note) from the JSON body; with end_optional an empty end_time gives end None."""
    data = request.get_json(silent=True) or {}
    try:
        start_dt = parse(data["start_time"])
        end_dt = None if end_optional and not data.get("end_time") else parse(data["end_time"])
    except (KeyError, TypeError, ValueError):
        return None, bad_request("start_time and end_time are required (YYYY-MM-DDTHH:MM).")
    if end_dt is None:
        if start_dt > datetime.now():
            return None, bad_request("Start cannot be in the future.")
        return (fmt(start_dt), None, str(data.get("note", "")).strip()), None
    if end_dt <= start_dt:
        return None, bad_request("End must be after start.")
    if end_dt > datetime.now() + timedelta(minutes=1):
        return None, bad_request("End cannot be in the future.")
    return (fmt(start_dt), fmt(end_dt), str(data.get("note", "")).strip()), None


@app.post("/api/sessions")
def add_session():
    values, err = read_session_body()
    if err:
        return err
    db = get_db()
    cur = db.execute("INSERT INTO sessions (start_time, end_time, note) VALUES (?, ?, ?)", values)
    db.commit()
    row = db.execute("SELECT * FROM sessions WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(session_dict(row)), 201


@app.put("/api/sessions/<int:sid>")
def edit_session(sid):
    """Edit a session; on the running one, an empty end_time keeps it running (otherwise it stops)."""
    values, err = read_session_body(end_optional=True)
    if err:
        return err
    db = get_db()
    if values[1] is None:
        cur = db.execute(
            "UPDATE sessions SET start_time = ?, note = ? WHERE id = ? AND end_time IS NULL",
            (values[0], values[2], sid),
        )
    else:
        cur = db.execute(
            "UPDATE sessions SET start_time = ?, end_time = ?, note = ? WHERE id = ?", (*values, sid)
        )
    db.commit()
    if cur.rowcount == 0:
        if values[1] is None and db.execute("SELECT 1 FROM sessions WHERE id = ?", (sid,)).fetchone():
            return bad_request("End is required for a finished session.")
        return jsonify({"error": "Not found"}), 404
    row = db.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
    return jsonify(session_dict(row))


@app.patch("/api/sessions/<int:sid>")
def edit_note(sid):
    """Update only the note — works on the running session too."""
    note = str((request.get_json(silent=True) or {}).get("note", "")).strip()
    db = get_db()
    cur = db.execute("UPDATE sessions SET note = ? WHERE id = ?", (note, sid))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "Not found"}), 404
    row = db.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
    return jsonify(session_dict(row))


@app.delete("/api/sessions/<int:sid>")
def delete_session(sid):
    db = get_db()
    cur = db.execute("DELETE FROM sessions WHERE id = ?", (sid,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "Not found"}), 404
    return "", 204


@app.post("/api/sessions/<int:sid>/break")
def add_break(sid):
    """Cut a break (e.g. lunch) out of a session: it becomes two sessions, before and after."""
    data = request.get_json(silent=True) or {}
    try:
        b0, b1 = parse(data["start_time"]), parse(data["end_time"])
    except (KeyError, TypeError, ValueError):
        return bad_request("start_time and end_time are required (YYYY-MM-DDTHH:MM).")
    db = get_db()
    row = db.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
    if row is None:
        return jsonify({"error": "Not found"}), 404
    end = parse(row["end_time"]) if row["end_time"] else datetime.now()
    if not parse(row["start_time"]) < b0 < b1 < end:
        return bad_request("The break must lie within the session (and be over already).")
    db.execute("UPDATE sessions SET end_time = ? WHERE id = ?", (fmt(b0), sid))
    db.execute(  # end_time NULL → the running timer continues in the second part
        "INSERT INTO sessions (start_time, end_time, note) VALUES (?, ?, ?)", (fmt(b1), row["end_time"], row["note"])
    )
    db.commit()
    return "", 204


# ---------------------------------------------------------------- phone snapshot

SNAPSHOT_DIR = os.environ.get("SNAPSHOT_DIR")  # e.g. a OneDrive/iCloud folder; unset = no snapshot


def fmt_dur(sec: int) -> str:
    sign = "−" if sec < 0 else ""
    sec = abs(sec)
    return f"{sign}{sec // 3600}h {sec % 3600 // 60:02d}m"


def write_snapshot():
    """Fill snapshot.html with the current stats and days; readable in the phone's file viewer (no JS)."""
    st = status().get_json()
    today = date.today()
    goals = goal_table()

    def signed(sec):
        return ("+" if sec >= 0 else "") + fmt_dur(sec)

    def tone(sec):
        return "pos" if sec >= 0 else "neg"

    def pct(part, whole):
        return min(100, round(100 * part / whole)) if whole else 0

    def level(sec):
        return 0 if sec <= 0 else 1 if sec < 2 * 3600 else 2 if sec < 5 * 3600 else 3 if sec < 8 * 3600 else 4

    # Heatmap: 26 weeks, Monday-first columns.
    first = today - timedelta(days=today.weekday() + 25 * 7)
    totals = daily_totals(first, today)
    heat = "".join(
        f'<span class="l{level(totals.get(d.isoformat(), 0))}"></span>' if d <= today else '<span class="none"></span>'
        for d in (first + timedelta(days=i) for i in range(26 * 7))
    )

    week_rows = "".join(
        f'<span class="{"today" if d["date"] == st["today"] else ""}">{parse_day(d["date"]):%a}</span>'
        f'<div class="bar"><div style="width: {pct(d["seconds"], d["target"] or 8 * 3600)}%"></div></div>'
        f'<span class="small">{fmt_dur(d["seconds"])} <span class="muted">/ {fmt_dur(d["target"])}</span></span>'
        for d in st["week_days"]
    )

    # Days: every day with work or a target, newest first, grouped by month (last 12 months).
    first_row = get_db().execute("SELECT MIN(start_time) FROM sessions").fetchone()[0]
    since = max(today - timedelta(days=365), parse(first_row).date() if first_row else today)  # no "missed" days before you started
    totals = daily_totals(since, today)
    sessions: dict = {}
    for r in get_db().execute(
        "SELECT * FROM sessions WHERE end_time IS NOT NULL AND start_time >= ? ORDER BY start_time",
        (fmt(datetime.combine(since, time.min)),),
    ):
        sessions.setdefault(r["start_time"][:10], []).append(
            f'<li>{r["start_time"][11:16]}–{r["end_time"][11:16]} · {fmt_dur(session_dict(r)["seconds"])}'
            + (f'<span class="note">{html.escape(r["note"])}</span>' if r["note"] else "") + "</li>"
        )
    months: dict = {}
    for i in range((today - since).days + 1):
        d = today - timedelta(days=i)
        worked, target = totals.get(d.isoformat(), 0), day_target(d, goals)
        if worked or target:
            months.setdefault(f"{d:%B %Y}", []).append(
                f'<details class="day"><summary><span>{d:%a %d.%m.}</span><span>{fmt_dur(worked)}</span>'
                f'<span class="delta {tone(worked - target)}">{signed(worked - target)}</span></summary>'
                f'<ul class="sessions">{"".join(sessions.get(d.isoformat(), [])) or "<li class=muted>No sessions</li>"}</ul>'
                "</details>"
            )
    month_html = "".join(
        f'<details class="month"{" open" if n == 0 else ""}><summary>{name}</summary>{"".join(days)}</details>'
        for n, (name, days) in enumerate(months.items())
    )

    balance_today = st["balance_seconds"] + st["today_seconds"] - st["daily_target"]
    with open(os.path.join(BASE_DIR, "snapshot.html"), encoding="utf-8") as f:
        page = Template(f.read()).substitute(
            updated=f"{datetime.now():%a %d.%m. %H:%M}",
            today=fmt_dur(st["today_seconds"]), today_target=fmt_dur(st["daily_target"]),
            today_pct=pct(st["today_seconds"], st["daily_target"]),
            week=fmt_dur(st["week_seconds"]), week_target=fmt_dur(st["weekly_target"]),
            week_pct=pct(st["week_seconds"], st["weekly_target"]),
            balance=signed(st["balance_seconds"]), balance_class=tone(st["balance_seconds"]),
            balance_today=signed(balance_today), balance_today_class=tone(balance_today),
            week_rows=week_rows, heat=heat, months=month_html or '<p class="muted">No days yet.</p>',
        )
    tmp = os.path.join(SNAPSHOT_DIR, ".worktracker.html.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(page)
    os.replace(tmp, os.path.join(SNAPSHOT_DIR, "worktracker.html"))  # sync never sees a half-written file


@app.after_request
def snapshot_after_change(response):
    if SNAPSHOT_DIR and request.method != "GET" and response.status_code < 400:
        try:
            write_snapshot()
        except Exception as e:  # never fail the user's action because the sync folder is unavailable
            app.logger.warning("snapshot failed: %s", e)
    return response


# ---------------------------------------------------------------- change feed

# Nothing polls: tabs hold a request open (/api/wait) that answers as soon as `version` moves — any
# change, a reminder, coming back to the Mac — and the menu bar is refreshed from here (menubar_pusher).
changed = threading.Condition()
version = 0


def bump():
    global version
    with changed:
        version += 1
        changed.notify_all()


@app.after_request
def bump_after_change(response):
    if request.method != "GET" and response.status_code < 400:
        bump()
    return response


def wait_change(since: int, timeout: float) -> int:
    """Block until `version` differs from `since` (at most `timeout` s); the current version."""
    with changed:
        changed.wait_for(lambda: version != since, max(0, timeout))
        return version


@app.get("/api/wait")
def wait():
    """Long poll for open tabs; v=-1 answers at once. After 5 min it answers anyway (the tab asks again)."""
    return jsonify({"version": wait_change(request.args.get("v", -1, type=int), 300)})


def menubar_wait() -> float:
    """Seconds until the menu bar text would change by itself: the shown minute flips (timer running)
    or the day changes (Today in the menu)."""
    with sqlite3.connect(DB_PATH) as db:
        start = db.execute("SELECT start_time FROM sessions WHERE end_time IS NULL").fetchone()
    now = datetime.now()
    if start:
        return 60 - (now - parse(start[0])).total_seconds() % 60
    return (datetime.combine(now.date() + timedelta(days=1), time.min) - now).total_seconds()


def menubar_pusher():
    """Have SwiftBar re-run menubar/worktracker.sh when its text changes, instead of it running the
    plugin on an interval. (A plugin that stays alive to wait costs more: SwiftBar polls it.)"""
    seen = -1
    while True:
        seen = wait_change(seen, menubar_wait() + 0.2)
        subprocess.run(["open", "-g", "swiftbar://refreshplugin?name=worktracker"], capture_output=True)  # no SwiftBar: no-op


@app.get("/api/menubar")
def menubar():
    """The SwiftBar plugin's output; @ME@ stands for the plugin's path (for the Start/Stop items)."""
    st = status().get_json()
    run = st["running"]
    dur = lambda sec, sign=False: (("+" if sec > 0 else "−" if sec < 0 else "±") if sign else "") + fmt_dur(abs(sec))
    if run:
        lines = ["%d:%02d | sfimage=timer" % (run["seconds"] // 3600, run["seconds"] % 3600 // 60), "---",
                 "Running since %s%s" % (run["start_time"][11:16], " · " + run["note"] if run["note"] else ""),
                 "Stop | bash=@ME@ param1=stop terminal=false sfimage=stop.fill"]
    else:
        lines = ["| sfimage=timer", "---",
                 "Start | bash=@ME@ param1=start terminal=false sfimage=play.fill",
                 "Start with note… | bash=@ME@ param1=start-note terminal=false sfimage=square.and.pencil"]
    lines += ["---",
              "Today: %s / %s" % (dur(st["today_seconds"]), dur(st["daily_target"])),
              "Week: %s / %s" % (dur(st["week_seconds"]), dur(st["weekly_target"])),
              "Overtime incl. today: %s" % dur(st["balance_seconds"] + st["today_seconds"] - st["daily_target"], sign=True),
              "---", "Open tracker | href=%s sfimage=safari" % URL]
    return "\n".join(lines) + "\n", 200, {"Content-Type": "text/plain; charset=utf-8"}


# ---------------------------------------------------------------- wake reminder (macOS)

URL = f"http://localhost:{os.environ.get('PORT', 47474)}"
last_reminder = 0.0  # time of the last reminder; open tracker tabs show a notification when it changes
reminder_kind = "comeback"  # or "test" (Settings → Send test notification)
watcher_running = False
tab_seen_at = 0.0   # last /api/status?notify=1 from a tab that is allowed to notify


def log(msg):
    print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg, file=sys.stderr, flush=True)


def remind():
    global last_reminder, reminder_kind
    with sqlite3.connect(DB_PATH) as db:
        running = db.execute("SELECT 1 FROM sessions WHERE end_time IS NULL").fetchone()
    if running:
        log("reminder skipped: timer running")
        return
    last_reminder, reminder_kind = clock.time(), "comeback"
    bump()  # wakes the tabs; one that may notify fetches /api/status?notify=1 and shows it
    for _ in range(15):  # after a wake, the tab may need a moment to reconnect
        if tab_seen_at >= last_reminder:
            break
        clock.sleep(1)
    if tab_seen_at >= last_reminder:
        log("reminder → browser tab")
    else:  # no tab open → macOS notification (click opens Script Editor)
        log("reminder → no tab with notifications enabled, macOS notification")
        subprocess.run(["osascript", "-e", 'display notification "No timer running — open '
                        f'{URL} to start it." with title "Work Tracker" subtitle "Working?" sound name "Glass"'])


@app.post("/api/test-notification")
def test_notification():
    """Settings → Send test notification: goes the same way as a real reminder (server → open tabs)."""
    global last_reminder, reminder_kind
    last_reminder, reminder_kind = clock.time(), "test"
    log("test notification → browser tabs")
    return jsonify({"ok": True})


if sys.platform == "darwin":
    # Read the two IOKit properties directly instead of spawning `ioreg` every 10s.
    import ctypes
    import ctypes.util

    _iokit = ctypes.CDLL(ctypes.util.find_library("IOKit"))
    _cg = ctypes.CDLL(ctypes.util.find_library("CoreGraphics"))
    _cg.CGMainDisplayID.restype = ctypes.c_uint32
    _cg.CGDisplayIsAsleep.argtypes = [ctypes.c_uint32]
    _cg.CGDisplayIsAsleep.restype = ctypes.c_uint32
    _cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))
    _iokit.IORegistryGetRootEntry.argtypes = [ctypes.c_uint32]
    _iokit.IORegistryGetRootEntry.restype = ctypes.c_uint32
    _iokit.IOServiceMatching.argtypes = [ctypes.c_char_p]
    _iokit.IOServiceMatching.restype = ctypes.c_void_p
    _iokit.IOServiceGetMatchingService.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
    _iokit.IOServiceGetMatchingService.restype = ctypes.c_uint32
    _iokit.IORegistryEntryCreateCFProperty.argtypes = [ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32]
    _iokit.IORegistryEntryCreateCFProperty.restype = ctypes.c_void_p
    _cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    _cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    _cf.CFBooleanGetValue.argtypes = [ctypes.c_void_p]
    _cf.CFBooleanGetValue.restype = ctypes.c_bool
    _cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    _cf.CFRelease.argtypes = [ctypes.c_void_p]

    _ROOT = _iokit.IORegistryGetRootEntry(0)
    _HID = _iokit.IOServiceGetMatchingService(0, _iokit.IOServiceMatching(b"IOHIDSystem"))
    _LOCKED = _cf.CFStringCreateWithCString(None, b"IOConsoleLocked", 0x08000100)  # UTF-8
    _IDLE = _cf.CFStringCreateWithCString(None, b"HIDIdleTime", 0x08000100)

    def _prop(entry, key):
        return _iokit.IORegistryEntryCreateCFProperty(entry, key, None, 0)


def display_asleep() -> bool:
    """True when the lid is closed or the display went to sleep (no sleep/lock needed)."""
    return bool(_cg.CGDisplayIsAsleep(_cg.CGMainDisplayID()))


def screen_locked() -> bool:
    v = _prop(_ROOT, _LOCKED)
    if not v:
        return False
    locked = _cf.CFBooleanGetValue(v)
    _cf.CFRelease(v)
    return locked


def idle_seconds() -> float:
    """Seconds since the last keyboard/trackpad input."""
    v = _prop(_HID, _IDLE)
    if not v:
        return float("inf")
    ns = ctypes.c_int64()
    _cf.CFNumberGetValue(v, 4, ctypes.byref(ns))  # kCFNumberSInt64Type
    _cf.CFRelease(v)
    return ns.value / 1e9


def recently_active() -> bool:
    """Keyboard/trackpad used in the last minute (rules out dark wakes)."""
    return idle_seconds() < 60


def record_away(start: float, end: float, reason: str):
    """Store an away period; only periods overlapping the last 3 sessions are kept."""
    if end - start < 60:
        return
    with sqlite3.connect(DB_PATH) as db:
        db.execute("INSERT INTO away VALUES (?, ?, ?)",
                   (fmt(datetime.fromtimestamp(start)), fmt(datetime.fromtimestamp(end)), reason))
        db.execute(
            "DELETE FROM away WHERE NOT EXISTS (SELECT 1 FROM "
            "(SELECT start_time, end_time FROM sessions ORDER BY start_time DESC LIMIT 3) AS s "
            "WHERE away.start_time < COALESCE(s.end_time, '9999') AND away.end_time > s.start_time)"
        )


def wake_watcher():
    """Remind at login and whenever you come back: after sleep, lock or display off (e.g. lid closed).
    A running timer is left alone."""
    remind()
    prev = last_input = clock.time()
    pending = False
    while True:
        clock.sleep(10)
        now = clock.time()
        locked = screen_locked()
        slept = now - prev > 30  # wall clock jumped
        if not slept and not pending:
            last_input = now - idle_seconds()  # after a sleep, keep the value from before it
        # ponytail: 10s polling, so an away shorter than that can slip through
        away = "sleep" if slept else "lock" if locked else "display-off" if display_asleep() else None
        if away and not pending:
            pending, away_since, away_reason = True, last_input, away
            log("away (%s) since %s" % (away, datetime.fromtimestamp(away_since).strftime("%H:%M:%S")))
        if pending and not locked and recently_active():
            log("back")
            record_away(away_since, now, away_reason)
            bump()
            remind()
            pending = False
        prev = now


def serve(wsgi_app):
    """Like app.run(), but the accept loop sleeps until a request comes: werkzeug's default wakes
    every 0.5 s to check for a shutdown that never comes (it runs until the Mac shuts down)."""
    from werkzeug.serving import make_server
    port = int(os.environ.get("PORT", 47474))
    print(f" * Running on http://localhost:{port}", file=sys.stderr, flush=True)
    make_server("localhost", port, wsgi_app, threaded=True).serve_forever(poll_interval=None)


init_db()

if __name__ == "__main__":
    if sys.platform == "darwin" and os.environ.get("WAKE_PROMPT", "1") == "1":
        watcher_running = True
        threading.Thread(target=wake_watcher, daemon=True).start()
    if sys.platform == "darwin":
        threading.Thread(target=menubar_pusher, daemon=True).start()
    serve(app)
