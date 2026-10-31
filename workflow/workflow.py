"""Workflow — a kanban board module for Work Tracker.

Registers its API and static files on the tracker's Flask app (see run.py). Board data lives in its
own SQLite file; cards are linked to tracker sessions by id, so time tracked on a card is ordinary
tracker time (today, week, overtime, heatmap) and the card shows the sum of its sessions.
"""
import html
import json
import os
import sqlite3
from datetime import datetime
from string import Template

from flask import Blueprint, g, jsonify, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("WORKFLOW_DB", os.path.join(BASE_DIR, "workflow.db"))

PRIORITIES = ("", "low", "medium", "high")
TYPES = ("task", "bug", "issue")
COLORS = ("", "gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink")  # column accents
DEFAULT_COLUMNS = [("To do", 0), ("In progress", 0), ("Done", 1)]
SWITCH_GRACE = 120  # seconds: a card started this soon after the running session began takes that session over

bp = Blueprint("workflow", __name__, static_folder="static", static_url_path="/workflow/static")
T = None  # the tracker module (Tracker/app.py), set by register()


# ---------------------------------------------------------------- database

def wdb():
    if "wf_db" not in g:
        g.wf_db = sqlite3.connect(DB_PATH)
        g.wf_db.row_factory = sqlite3.Row
        g.wf_db.execute("PRAGMA foreign_keys = ON")
    return g.wf_db


@bp.teardown_app_request
def close_wdb(_exc):
    db = g.pop("wf_db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS columns (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                position   INTEGER NOT NULL,
                wip_limit  INTEGER NOT NULL DEFAULT 0,   -- 0 = no limit
                is_done    INTEGER NOT NULL DEFAULT 0,   -- cards here count as finished
                color      TEXT NOT NULL DEFAULT ''      -- one of COLORS, '' = none
            );
            CREATE TABLE IF NOT EXISTS cards (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                column_id   INTEGER NOT NULL REFERENCES columns(id),
                position    INTEGER NOT NULL,
                title       TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                priority    TEXT NOT NULL DEFAULT '',    -- '' | low | medium | high
                due_date    TEXT,                        -- YYYY-MM-DD
                estimate    INTEGER NOT NULL DEFAULT 0,  -- seconds, 0 = none
                labels      TEXT NOT NULL DEFAULT '[]',  -- JSON list of strings
                checklist   TEXT NOT NULL DEFAULT '[]',  -- JSON list of {text, done}
                created_at  TEXT NOT NULL,
                done_at     TEXT,                        -- set while in a done column
                archived    INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id, position);
            -- Phases until a release (milestones), in order; cards can belong to one.
            CREATE TABLE IF NOT EXISTS phases (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                name         TEXT NOT NULL,
                position     INTEGER NOT NULL,
                target_date  TEXT,                       -- YYYY-MM-DD
                released_at  TEXT                        -- set once the phase is released
            );
            -- Tracker sessions worked on a card (sessions live in tracker.db).
            CREATE TABLE IF NOT EXISTS card_sessions (
                session_id  INTEGER PRIMARY KEY,
                card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE
            );
            """
        )
        # Boards created before column colours, card types and phases.
        if "color" not in {r[1] for r in db.execute("PRAGMA table_info(columns)")}:
            db.execute("ALTER TABLE columns ADD COLUMN color TEXT NOT NULL DEFAULT ''")
        card_cols = {r[1] for r in db.execute("PRAGMA table_info(cards)")}
        if "type" not in card_cols:
            db.execute("ALTER TABLE cards ADD COLUMN type TEXT NOT NULL DEFAULT 'task'")  # one of TYPES
        if "phase_id" not in card_cols:
            db.execute("ALTER TABLE cards ADD COLUMN phase_id INTEGER REFERENCES phases(id)")
        if not db.execute("SELECT 1 FROM columns").fetchone():
            db.executemany("INSERT INTO columns (name, position, is_done) VALUES (?, ?, ?)",
                           [(n, i, d) for i, (n, d) in enumerate(DEFAULT_COLUMNS)])


# ---------------------------------------------------------------- helpers

def now() -> str:
    return T.fmt(datetime.now())


def bad_request(msg: str):
    return jsonify({"error": msg}), 400


def not_found():
    return jsonify({"error": "Not found"}), 404


def column_dict(row) -> dict:
    return {"id": row["id"], "name": row["name"], "position": row["position"],
            "wip_limit": row["wip_limit"], "is_done": bool(row["is_done"]),
            "color": row["color"]}


def card_dict(row, tracked=0, running=False) -> dict:
    return {
        "id": row["id"], "column_id": row["column_id"], "position": row["position"],
        "title": row["title"], "description": row["description"], "priority": row["priority"],
        "due_date": row["due_date"], "estimate": row["estimate"],
        "labels": json.loads(row["labels"]), "checklist": json.loads(row["checklist"]),
        "created_at": row["created_at"], "done_at": row["done_at"], "archived": bool(row["archived"]),
        "type": row["type"], "phase_id": row["phase_id"],
        "tracked_seconds": tracked, "running": running,
    }


def phases_with_progress() -> list:
    """Phases in order, each with {total, done}: active cards plus archived finished ones
    (an archived card that was never done doesn't count)."""
    db = wdb()
    counts = {r["phase_id"]: (r["total"], r["done"]) for r in db.execute(
        """SELECT phase_id, COUNT(*) AS total, COUNT(done_at) AS done FROM cards
           WHERE phase_id IS NOT NULL AND (archived = 0 OR done_at IS NOT NULL) GROUP BY phase_id""")}
    return [{"id": r["id"], "name": r["name"], "position": r["position"], "target_date": r["target_date"],
             "released_at": r["released_at"], "total": counts.get(r["id"], (0, 0))[0],
             "done": counts.get(r["id"], (0, 0))[1]}
            for r in db.execute("SELECT * FROM phases ORDER BY position")]


def time_per_card() -> tuple:
    """({card_id: tracked seconds}, card id of the running tracker session or None)."""
    links = dict(wdb().execute("SELECT session_id, card_id FROM card_sessions").fetchall())
    totals, running_card = {}, None
    if links:
        ids = list(links)
        rows = T.get_db().execute(
            f"SELECT * FROM sessions WHERE id IN ({','.join('?' * len(ids))})", ids).fetchall()
        for r in rows:
            s = T.session_dict(r)
            cid = links[r["id"]]
            totals[cid] = totals.get(cid, 0) + s["seconds"]
            if s["running"]:
                running_card = cid
    return totals, running_card


def running_card_id():
    run = T.running_session()
    if not run:
        return None
    row = wdb().execute("SELECT card_id FROM card_sessions WHERE session_id = ?", (run["id"],)).fetchone()
    return row["card_id"] if row else None


def get_card(cid):
    return wdb().execute("SELECT * FROM cards WHERE id = ?", (cid,)).fetchone()


def card_response(cid):
    totals, running = time_per_card()
    return jsonify(card_dict(get_card(cid), totals.get(cid, 0), running == cid))


def renumber(column_id, ordered_ids):
    wdb().executemany("UPDATE cards SET position = ?, column_id = ? WHERE id = ?",
                      [(i, column_id, cid) for i, cid in enumerate(ordered_ids)])


def stop_tracker():
    """Stop the tracker timer (same as the tracker's Stop button)."""
    run = T.running_session()
    if run:
        T.get_db().execute("UPDATE sessions SET end_time = ? WHERE id = ?", (now(), run["id"]))
        T.get_db().commit()


def split_off_card():
    """The running card is finished but work goes on: end its session now and keep the timer
    running in a new session without a note (not linked to any card)."""
    run = T.running_session()
    if run:
        t = now()
        tdb = T.get_db()
        tdb.execute("UPDATE sessions SET end_time = ? WHERE id = ?", (t, run["id"]))
        tdb.execute("INSERT INTO sessions (start_time, note) VALUES (?, '')", (t,))
        tdb.commit()


# ---------------------------------------------------------------- board

@bp.get("/api/workflow/board")
def board():
    """Columns and all non-archived cards with their tracked time; the running tracker session."""
    db = wdb()
    totals, running = time_per_card()
    run = T.running_session()
    return jsonify({
        "now": now(),
        "today": datetime.now().date().isoformat(),
        "columns": [column_dict(r) for r in db.execute("SELECT * FROM columns ORDER BY position")],
        "cards": [card_dict(r, totals.get(r["id"], 0), running == r["id"])
                  for r in db.execute("SELECT * FROM cards WHERE archived = 0 ORDER BY column_id, position")],
        "archived_count": db.execute("SELECT COUNT(*) FROM cards WHERE archived = 1").fetchone()[0],
        "phases": phases_with_progress(),
        "running": T.session_dict(run) if run else None,
        "running_card_id": running,
    })


@bp.get("/api/workflow/running")
def running():
    """Just the card the timer runs on (for the tab's dot while the board isn't loaded)."""
    return jsonify({"card_id": running_card_id()})


@bp.get("/api/workflow/archive")
def archive():
    totals, _ = time_per_card()
    rows = wdb().execute("SELECT * FROM cards WHERE archived = 1 ORDER BY COALESCE(done_at, created_at) DESC")
    return jsonify([card_dict(r, totals.get(r["id"], 0)) for r in rows])


# ---------------------------------------------------------------- columns

@bp.post("/api/workflow/columns")
def add_column():
    name = str((request.get_json(silent=True) or {}).get("name", "")).strip()
    if not name:
        return bad_request("Give the column a name.")
    db = wdb()
    pos = db.execute("SELECT COALESCE(MAX(position) + 1, 0) FROM columns").fetchone()[0]
    cur = db.execute("INSERT INTO columns (name, position) VALUES (?, ?)", (name, pos))
    db.commit()
    return jsonify(column_dict(db.execute("SELECT * FROM columns WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@bp.patch("/api/workflow/columns/<int:col_id>")
def edit_column(col_id):
    data = request.get_json(silent=True) or {}
    db = wdb()
    col = db.execute("SELECT * FROM columns WHERE id = ?", (col_id,)).fetchone()
    if col is None:
        return not_found()
    name = str(data.get("name", col["name"])).strip()
    try:
        wip = int(data.get("wip_limit", col["wip_limit"]))
    except (TypeError, ValueError):
        return bad_request("The WIP limit must be a number (0 = no limit).")
    is_done = int(bool(data.get("is_done", col["is_done"])))
    color = data.get("color", col["color"])
    if not name or wip < 0:
        return bad_request("Name required; WIP limit 0 or more.")
    if color not in COLORS:
        return bad_request("Unknown colour.")
    db.execute("UPDATE columns SET name = ?, wip_limit = ?, is_done = ?, color = ? WHERE id = ?",
               (name[:100], wip, is_done, color, col_id))
    if is_done != col["is_done"]:  # cards already in it become done / not done now
        db.execute("UPDATE cards SET done_at = ? WHERE column_id = ?", (now() if is_done else None, col_id))
        running = running_card_id()
        if is_done and running and get_card(running)["column_id"] == col_id:
            split_off_card()
    db.commit()
    return jsonify(column_dict(db.execute("SELECT * FROM columns WHERE id = ?", (col_id,)).fetchone()))


@bp.post("/api/workflow/columns/order")
def order_columns():
    ids = (request.get_json(silent=True) or {}).get("ids", [])
    db = wdb()
    if sorted(ids) != sorted(r[0] for r in db.execute("SELECT id FROM columns")):
        return bad_request("Send all column ids in the new order.")
    db.executemany("UPDATE columns SET position = ? WHERE id = ?", [(i, cid) for i, cid in enumerate(ids)])
    db.commit()
    return "", 204


@bp.delete("/api/workflow/columns/<int:col_id>")
def delete_column(col_id):
    db = wdb()
    if db.execute("SELECT 1 FROM cards WHERE column_id = ? AND archived = 0", (col_id,)).fetchone():
        return bad_request("Move or archive the cards in this column first.")
    if db.execute("SELECT COUNT(*) FROM columns").fetchone()[0] <= 1:
        return bad_request("The board needs at least one column.")
    # Archived cards keep their history; park them in the first remaining column.
    first = db.execute("SELECT id FROM columns WHERE id != ? ORDER BY position LIMIT 1", (col_id,)).fetchone()[0]
    db.execute("UPDATE cards SET column_id = ? WHERE column_id = ?", (first, col_id))
    cur = db.execute("DELETE FROM columns WHERE id = ?", (col_id,))
    db.commit()
    return ("", 204) if cur.rowcount else not_found()


# ---------------------------------------------------------------- phases

def read_phase_fields(data: dict, partial: bool) -> dict:
    out = {}
    if "name" in data or not partial:
        name = str(data.get("name", "")).strip()
        if not name:
            raise ValueError("The phase needs a name.")
        out["name"] = name[:100]
    if "target_date" in data:
        target = data["target_date"] or None
        if target:
            T.parse_day(target)  # ValueError if malformed
        out["target_date"] = target
    if "released" in data:
        out["released_at"] = now() if data["released"] else None
    return out


@bp.post("/api/workflow/phases")
def add_phase():
    db = wdb()
    try:
        fields = read_phase_fields(request.get_json(silent=True) or {}, partial=False)
    except (TypeError, ValueError) as e:
        return bad_request(str(e) or "Invalid phase.")
    fields["position"] = db.execute("SELECT COALESCE(MAX(position) + 1, 0) FROM phases").fetchone()[0]
    cur = db.execute(f"INSERT INTO phases ({', '.join(fields)}) VALUES ({', '.join('?' * len(fields))})",
                     list(fields.values()))
    db.commit()
    return jsonify({"id": cur.lastrowid}), 201


@bp.patch("/api/workflow/phases/<int:pid>")
def edit_phase(pid):
    db = wdb()
    phase = db.execute("SELECT * FROM phases WHERE id = ?", (pid,)).fetchone()
    if phase is None:
        return not_found()
    data = request.get_json(silent=True) or {}
    try:
        fields = read_phase_fields(data, partial=True)
    except (TypeError, ValueError) as e:
        return bad_request(str(e) or "Invalid phase.")
    if "released_at" in fields and data["released"] and phase["released_at"]:
        del fields["released_at"]  # keep the original release date
    if fields:
        db.execute(f"UPDATE phases SET {', '.join(k + ' = ?' for k in fields)} WHERE id = ?", [*fields.values(), pid])
        db.commit()
    return jsonify({"id": pid})


@bp.post("/api/workflow/phases/order")
def order_phases():
    ids = (request.get_json(silent=True) or {}).get("ids", [])
    db = wdb()
    if sorted(ids) != sorted(r[0] for r in db.execute("SELECT id FROM phases")):
        return bad_request("Send all phase ids in the new order.")
    db.executemany("UPDATE phases SET position = ? WHERE id = ?", [(i, p) for i, p in enumerate(ids)])
    db.commit()
    return "", 204


@bp.delete("/api/workflow/phases/<int:pid>")
def delete_phase(pid):
    """Delete a phase; its cards stay, without a phase."""
    db = wdb()
    db.execute("UPDATE cards SET phase_id = NULL WHERE phase_id = ?", (pid,))
    cur = db.execute("DELETE FROM phases WHERE id = ?", (pid,))
    db.commit()
    return ("", 204) if cur.rowcount else not_found()


# ---------------------------------------------------------------- cards

def read_card_fields(data: dict, partial: bool):
    """Validated column values from a JSON body; only the keys present when partial."""
    out = {}
    if "title" in data or not partial:
        title = str(data.get("title", "")).strip()
        if not title:
            raise ValueError("The card needs a title.")
        out["title"] = title[:300]
    if "description" in data:
        out["description"] = str(data["description"])[:20000]
    if "priority" in data:
        if data["priority"] not in PRIORITIES:
            raise ValueError("Priority is low, medium, high or empty.")
        out["priority"] = data["priority"]
    if "due_date" in data:
        due = data["due_date"] or None
        if due:
            T.parse_day(due)  # ValueError if malformed
        out["due_date"] = due
    if "estimate" in data:
        est = int(data["estimate"] or 0)
        if est < 0:
            raise ValueError("The estimate can't be negative.")
        out["estimate"] = est
    if "labels" in data:
        labels = [str(l).strip()[:40] for l in data["labels"] if str(l).strip()]
        out["labels"] = json.dumps(list(dict.fromkeys(labels)))  # unique, order kept
    if "type" in data:
        if data["type"] not in TYPES:
            raise ValueError("Type is task, bug or issue.")
        out["type"] = data["type"]
    if "phase_id" in data:
        pid = data["phase_id"] or None
        if pid is not None and not wdb().execute("SELECT 1 FROM phases WHERE id = ?", (pid,)).fetchone():
            raise ValueError("Unknown phase.")
        out["phase_id"] = pid
    if "checklist" in data:
        out["checklist"] = json.dumps([{"text": str(i["text"]).strip()[:300], "done": bool(i.get("done"))}
                                       for i in data["checklist"] if str(i.get("text", "")).strip()])
    return out


@bp.post("/api/workflow/cards")
def add_card():
    data = request.get_json(silent=True) or {}
    db = wdb()
    col = db.execute("SELECT * FROM columns WHERE id = ?", (data.get("column_id"),)).fetchone()
    if col is None:
        return bad_request("Unknown column.")
    try:
        fields = read_card_fields(data, partial=False)
    except (TypeError, ValueError, KeyError) as e:
        return bad_request(str(e) or "Invalid card.")
    # New cards go on top of the column.
    db.execute("UPDATE cards SET position = position + 1 WHERE column_id = ?", (col["id"],))
    fields.update(column_id=col["id"], position=0, created_at=now(), done_at=now() if col["is_done"] else None)
    cur = db.execute(f"INSERT INTO cards ({', '.join(fields)}) VALUES ({', '.join('?' * len(fields))})",
                     list(fields.values()))
    db.commit()
    return card_response(cur.lastrowid), 201


@bp.patch("/api/workflow/cards/<int:cid>")
def edit_card(cid):
    if get_card(cid) is None:
        return not_found()
    data = request.get_json(silent=True) or {}
    try:
        fields = read_card_fields(data, partial=True)
    except (TypeError, ValueError, KeyError) as e:
        return bad_request(str(e) or "Invalid card.")
    if "archived" in data:
        fields["archived"] = int(bool(data["archived"]))
        if fields["archived"] and running_card_id() == cid:
            stop_tracker()
    if fields:
        db = wdb()
        db.execute(f"UPDATE cards SET {', '.join(k + ' = ?' for k in fields)} WHERE id = ?", [*fields.values(), cid])
        db.commit()
        if "title" in fields and running_card_id() == cid:  # keep the tracker note in step
            T.get_db().execute("UPDATE sessions SET note = ? WHERE end_time IS NULL", (fields["title"],))
            T.get_db().commit()
    return card_response(cid)


@bp.post("/api/workflow/cards/<int:cid>/move")
def move_card(cid):
    """Move a card to {column_id, position}. Into a done column: it's finished; if its timer runs,
    the timer keeps going without it (see split_off_card)."""
    data = request.get_json(silent=True) or {}
    db = wdb()
    card = get_card(cid)
    if card is None:
        return not_found()
    col = db.execute("SELECT * FROM columns WHERE id = ?", (data.get("column_id"),)).fetchone()
    if col is None:
        return bad_request("Unknown column.")
    ids = [r[0] for r in db.execute(
        "SELECT id FROM cards WHERE column_id = ? AND archived = 0 AND id != ? ORDER BY position", (col["id"], cid))]
    pos = max(0, min(int(data.get("position", len(ids))), len(ids)))
    ids.insert(pos, cid)
    renumber(col["id"], ids)
    if card["column_id"] != col["id"]:
        rest = [r[0] for r in db.execute(
            "SELECT id FROM cards WHERE column_id = ? AND archived = 0 ORDER BY position", (card["column_id"],))]
        renumber(card["column_id"], rest)
        db.execute("UPDATE cards SET done_at = ? WHERE id = ?", (now() if col["is_done"] else None, cid))
        if col["is_done"] and running_card_id() == cid:
            split_off_card()
    db.commit()
    return card_response(cid)


@bp.post("/api/workflow/cards/<int:cid>/restore")
def restore_card(cid):
    """Bring an archived card back: on top of its column, or at {column_id, position} (Undo)."""
    data = request.get_json(silent=True) or {}
    db = wdb()
    card = get_card(cid)
    if card is None:
        return not_found()
    col = db.execute("SELECT * FROM columns WHERE id = ?", (data.get("column_id") or card["column_id"],)).fetchone()
    if col is None:
        return bad_request("Unknown column.")
    ids = [r[0] for r in db.execute(
        "SELECT id FROM cards WHERE column_id = ? AND archived = 0 AND id != ? ORDER BY position", (col["id"], cid))]
    db.execute("UPDATE cards SET archived = 0, done_at = ? WHERE id = ?",
               ((card["done_at"] or now()) if col["is_done"] else None, cid))
    pos = max(0, min(int(data.get("position") or 0), len(ids)))
    ids.insert(pos, cid)
    renumber(col["id"], ids)
    db.commit()
    return card_response(cid)


@bp.delete("/api/workflow/cards/<int:cid>")
def delete_card(cid):
    """Delete a card. Its tracked sessions stay in the tracker (only the link goes)."""
    db = wdb()
    cur = db.execute("DELETE FROM cards WHERE id = ?", (cid,))
    db.commit()
    return ("", 204) if cur.rowcount else not_found()


# ---------------------------------------------------------------- timer (tracker connection)

@bp.post("/api/workflow/cards/<int:cid>/start")
def start_card(cid):
    """Start the tracker timer for a card (note = card title). A timer for something else is stopped
    first, unless it began less than SWITCH_GRACE ago (e.g. the note-less session after a card was
    done, or a card started by mistake): then this card takes that session over, so switching cards
    doesn't leave a trail of short sessions."""
    card = get_card(cid)
    if card is None:
        return not_found()
    if running_card_id() == cid:
        return bad_request("The timer already runs for this card.")
    tdb = T.get_db()
    run = T.running_session()
    if run and (datetime.now() - T.parse(run["start_time"])).total_seconds() <= SWITCH_GRACE:
        session_id = run["id"]
        tdb.execute("UPDATE sessions SET note = ? WHERE id = ?", (card["title"], session_id))
    else:
        stop_tracker()
        session_id = tdb.execute("INSERT INTO sessions (start_time, note) VALUES (?, ?)", (now(), card["title"])).lastrowid
    tdb.commit()
    db = wdb()
    db.execute("INSERT OR REPLACE INTO card_sessions VALUES (?, ?)", (session_id, cid))  # replaces another card's link
    db.commit()
    return card_response(cid)


@bp.post("/api/workflow/cards/<int:cid>/link")
def link_running(cid):
    """Count the timer that is already running (started on the tracker page) towards this card;
    its note becomes the card title, as when the timer is started from the card."""
    card = get_card(cid)
    if card is None:
        return not_found()
    run = T.running_session()
    if not run:
        return bad_request("No timer is running.")
    db = wdb()
    db.execute("INSERT OR REPLACE INTO card_sessions VALUES (?, ?)", (run["id"], cid))
    db.commit()
    T.get_db().execute("UPDATE sessions SET note = ? WHERE id = ?", (card["title"], run["id"]))
    T.get_db().commit()
    return card_response(cid)


@bp.get("/api/workflow/cards/<int:cid>/sessions")
def card_sessions(cid):
    ids = [r[0] for r in wdb().execute("SELECT session_id FROM card_sessions WHERE card_id = ?", (cid,))]
    if not ids:
        return jsonify([])
    rows = T.get_db().execute(
        f"SELECT * FROM sessions WHERE id IN ({','.join('?' * len(ids))}) ORDER BY start_time DESC", ids).fetchall()
    return jsonify([T.session_dict(r) for r in rows])


@bp.delete("/api/workflow/sessions/<int:sid>")
def unlink_session(sid):
    """Stop counting a session towards its card (the session itself stays in the tracker)."""
    db = wdb()
    db.execute("DELETE FROM card_sessions WHERE session_id = ?", (sid,))
    db.commit()
    return "", 204


# ---------------------------------------------------------------- phone snapshot

HEX = {"gray": "#8b949e", "red": "#e5534b", "orange": "#e0823d", "yellow": "#d4a72c", "green": "#3fa35b",
       "teal": "#1f9e95", "blue": "#4184e4", "purple": "#9a6dd7", "pink": "#d95e9b"}  # as COLORS in workflow.js


def write_snapshot():
    """Fill snapshot.html with phases and the board; written as workflow.html next to the tracker's
    worktracker.html in SNAPSHOT_DIR."""
    esc = html.escape
    db = wdb()
    totals, running = time_per_card()
    today = datetime.now().date().isoformat()

    phases = "".join(
        f'<div class="phase"><span>{esc(p["name"])}'
        + (f' <span class="muted small">· {p["target_date"]}</span>' if p["target_date"] else "")
        + f'</span><span class="small">{"Released" if p["released_at"] else "%d/%d" % (p["done"], p["total"])}</span>'
        f'<div class="bar"><div style="width: {round(100 * p["done"] / p["total"]) if p["total"] else 0}%"></div></div></div>'
        for p in phases_with_progress())
    phase_names = {p["id"]: p["name"] for p in phases_with_progress()}

    def card_html(r):
        c = card_dict(r, totals.get(r["id"], 0), running == r["id"])
        tags = [c["type"]] if c["type"] != "task" else []
        tags += [c["priority"]] if c["priority"] else []
        meta = "".join(f'<span class="tag {t}">{esc(t)}</span>' for t in tags + c["labels"])
        if c["due_date"]:
            late = not c["done_at"] and c["due_date"] < today
            meta += f'<span class="small{" neg" if late else " muted"}">due {c["due_date"]}</span> '
        if c["phase_id"] in phase_names:
            meta += f'<span class="small muted">· {esc(phase_names[c["phase_id"]])}</span>'
        time_ = T.fmt_dur(c["tracked_seconds"]) if c["tracked_seconds"] else ""
        if c["estimate"]:
            time_ += f' <span class="muted">/ {T.fmt_dur(c["estimate"])}</span>'
        checks = "".join(f'<li>{"☑" if i["done"] else "☐"} {esc(i["text"])}</li>' for i in c["checklist"])
        body = (f'<p>{esc(c["description"])}</p>' if c["description"] else "") + (
            f'<ul>{checks}</ul>' if checks else "")
        return (f'<details class="item"><summary><span>{"<span class=dot>● </span>" if c["running"] else ""}'
                f'{esc(c["title"])}</span><span class="small">{time_}</span>'
                + (f'<span class="meta">{meta}</span>' if meta else "")
                + f'</summary><div class="body">{body or "<p class=muted>No details</p>"}</div></details>')

    cards: dict = {}
    for r in db.execute("SELECT * FROM cards WHERE archived = 0 ORDER BY position"):
        cards.setdefault(r["column_id"], []).append(r)
    columns = "".join(
        f'<details class="card column{" running" if any(r["id"] == running for r in cards.get(col["id"], [])) else ""}"'
        + (f' style="--c: {HEX[col["color"]]}"' if col["color"] else "") + ("" if col["is_done"] else " open")
        + f'><summary><h2><span>{esc(col["name"])}</span><span>{len(cards.get(col["id"], []))}'
        + (f' / {col["wip_limit"]}' if col["wip_limit"] else "") + "</span></h2></summary>"
        + ("".join(card_html(r) for r in cards.get(col["id"], [])) or '<p class="muted small">No cards</p>')
        + "</details>"
        for col in db.execute("SELECT * FROM columns ORDER BY position"))

    with open(os.path.join(BASE_DIR, "snapshot.html"), encoding="utf-8") as f:
        page = Template(f.read()).substitute(
            updated=f"{datetime.now():%a %d.%m. %H:%M}",
            phases=f'<section class="card"><h2>Phases</h2>{phases}</section>' if phases else "",
            columns=columns,
        )
    tmp = os.path.join(T.SNAPSHOT_DIR, ".workflow.html.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(page)
    os.replace(tmp, os.path.join(T.SNAPSHOT_DIR, "workflow.html"))  # sync never sees a half-written file


@bp.after_app_request
def snapshot_after_change(response):
    """Board changes and tracker changes (the timer moves card time) both refresh it."""
    if T.SNAPSHOT_DIR and request.method != "GET" and response.status_code < 400:
        try:
            write_snapshot()
        except Exception as e:  # never fail the user's action because the sync folder is unavailable
            T.app.logger.warning("workflow snapshot failed: %s", e)
    return response


# ---------------------------------------------------------------- hook into the tracker

# Only the small loader comes with the page; it loads workflow.js when the board is first used.
TAGS = ('<link rel="stylesheet" href="/workflow/static/workflow.css">\n'
        '<script src="/workflow/static/workflow-boot.js" defer></script>\n')


def register(tracker):
    """Attach the module to the tracker's Flask app; its page gets the Workflow panel."""
    global T
    T = tracker
    init_db()
    tracker.app.register_blueprint(bp)

    def index():
        with open(os.path.join(tracker.app.static_folder, "index.html"), encoding="utf-8") as f:
            html = f.read()
        return html.replace("</head>", TAGS + "</head>", 1), 200, {"Content-Type": "text/html; charset=utf-8"}

    tracker.app.view_functions["index"] = index
