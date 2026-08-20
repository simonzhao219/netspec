"""SQLite persistence for the text-spec service (需求輸入 → 蘇格拉底追問 → PRD).

Self-contained: connection helper, Databricks Volume backup/restore, schema,
and CRUD all in one file — unlike Stage 1's split (a shared db/ package plus
this domain's db.py), this service owns its own db file end to end with no
coordination with another domain's schema needed.

Stores:
  - sessions: basic session metadata
  - iterations: each PRD iteration with full result JSON
  - daily_usage: per-(date, ip, key) call counters (cost-protection cap)

DB file: netspec_text_spec.db (next to this file, auto-created on first use)
"""

import json
import os
import sqlite3
import time
from pathlib import Path
from contextlib import contextmanager

# SQLite always runs on LOCAL disk. Unity Catalog Volumes are S3-backed FUSE
# mounts that don't support the POSIX file locking / random writes SQLite needs,
# so we can't point SQLite at /Volumes/... directly. Instead we treat the Volume
# as durable blob storage: RESTORE the db file from it on startup, and BACK UP
# the live file to it periodically via the Databricks Files API (no FUSE needed).
_LOCAL = Path(__file__).parent / "netspec_text_spec.db"
VOLUME_TARGET = os.environ.get("DB_PATH", "")   # /Volumes/.../netspec_text_spec.db — backup blob
DB_PATH = _LOCAL                                # what every _conn() connects to

# Diagnostics surfaced via /api/health → "volume_sync"
sync_diag: dict = {
    "volume_target": VOLUME_TARGET or None,
    "restored": None,       # "ok (N bytes)" | "empty" | "none (...)" | "no_target"
    "last_backup": None,    # "ok" | "error: ..."
    "backup_count": 0,
}
_last_backup_mtime = 0.0


def _wc():
    """WorkspaceClient via the App's M2M credential chain (auto-detected)."""
    from databricks.sdk import WorkspaceClient
    return WorkspaceClient()


def restore_from_volume() -> None:
    """Download the db backup from the Volume to local disk (call once at startup).
    No-op when VOLUME_TARGET is unset or no backup exists yet (genuine first run)."""
    if not VOLUME_TARGET:
        sync_diag["restored"] = "no_target"
        return
    try:
        resp = _wc().files.download(VOLUME_TARGET)
        data = resp.contents.read()
        if data:
            _LOCAL.write_bytes(data)
            for sfx in ("-wal", "-shm"):        # drop stale sidecars → clean open
                sc = Path(str(_LOCAL) + sfx)
                if sc.exists():
                    sc.unlink()
            sync_diag["restored"] = f"ok ({len(data)} bytes)"
        else:
            sync_diag["restored"] = "empty"
    except Exception as e:
        sync_diag["restored"] = f"none ({type(e).__name__})"


def backup_to_volume() -> bool:
    """Upload a WAL-consistent snapshot of the live db to the Volume (Files API).
    Uses SQLite's online-backup so the uploaded file is a single self-contained db."""
    if not VOLUME_TARGET:
        return False
    snap = _LOCAL.with_suffix(".snapshot.db")
    src = None
    try:
        src = sqlite3.connect(str(_LOCAL))
        dst = sqlite3.connect(str(snap))
        with dst:
            src.backup(dst)                     # consistent copy incl. WAL data
        dst.close()
        with open(snap, "rb") as f:
            _wc().files.upload(VOLUME_TARGET, f, overwrite=True)
        sync_diag["last_backup"] = "ok"
        sync_diag["backup_count"] += 1
        return True
    except Exception as e:
        sync_diag["last_backup"] = f"error: {type(e).__name__}: {e}"
        return False
    finally:
        if src is not None:
            src.close()
        try:
            snap.unlink(missing_ok=True)
        except OSError:
            pass


def _dirty_mtime() -> float:
    m = 0.0
    for p in (_LOCAL, Path(str(_LOCAL) + "-wal")):
        try:
            m = max(m, p.stat().st_mtime)
        except OSError:
            pass
    return m


def backup_if_dirty() -> bool:
    """Back up only when the db changed since the last successful backup."""
    global _last_backup_mtime
    m = _dirty_mtime()
    if m <= _last_backup_mtime:
        return False
    if backup_to_volume():
        _last_backup_mtime = m
        return True
    return False


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row   # rows accessible as dicts
    conn.execute("PRAGMA journal_mode=WAL")   # safe for concurrent reads
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def get_db():
    """Context manager that yields a connection and auto-commits on success."""
    conn = _conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ── Schema ────────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    requirement TEXT NOT NULL,
    req_type    TEXT DEFAULT 'generic',
    status      TEXT DEFAULT 'complete',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS iterations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT NOT NULL,
    iteration_num    INTEGER NOT NULL,
    quality_score    INTEGER DEFAULT 0,
    validation_passed INTEGER DEFAULT 0,
    feature_name     TEXT DEFAULT '',
    spec_document    TEXT DEFAULT '',
    result_json      TEXT DEFAULT '{}',
    translation_json TEXT DEFAULT NULL,
    created_at       REAL NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_iterations_session ON iterations(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created   ON sessions(created_at DESC);

-- Daily call counter (cost-protection cap). Durable across restarts so the cap
-- can't be reset by bouncing the backend. Keyed by (date, ip, key) → per-client,
-- matching the in-memory rate-limiter's scope. `date` is an Asia/Taipei ISO date.
CREATE TABLE IF NOT EXISTS daily_usage (
    date  TEXT NOT NULL,
    ip    TEXT NOT NULL,
    key   TEXT NOT NULL,            -- 'start' | 'iterate'
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, ip, key)
);
"""

MIGRATIONS = [
    "ALTER TABLE iterations ADD COLUMN translation_json TEXT DEFAULT NULL",
]


def init_db() -> None:
    """Create tables if they don't exist. Safe to call multiple times."""
    with get_db() as conn:
        conn.executescript(SCHEMA)
        for sql in MIGRATIONS:
            try:
                conn.execute(sql)
                conn.commit()
            except Exception:
                pass


# ── Daily usage counter ───────────────────────────────────────────────────────

def daily_get(date: str, ip: str, key: str) -> int:
    """Current count for (date, ip, key). 0 if no row."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT count FROM daily_usage WHERE date=? AND ip=? AND key=?",
            (date, ip, key),
        ).fetchone()
        return row["count"] if row else 0


def daily_inc(date: str, ip: str, key: str) -> int:
    """Atomically increment and return the new count. Opportunistically prunes
    rows from previous days so the table can't grow unbounded across IPs/dates."""
    with get_db() as conn:
        conn.execute("DELETE FROM daily_usage WHERE date < ?", (date,))
        row = conn.execute(
            """INSERT INTO daily_usage (date, ip, key, count) VALUES (?, ?, ?, 1)
               ON CONFLICT(date, ip, key) DO UPDATE SET count = count + 1
               RETURNING count""",
            (date, ip, key),
        ).fetchone()
        return row["count"] if row else 1


def daily_dec(date: str, ip: str, key: str) -> int:
    """Refund one increment (floored at 0). Returns the new count."""
    with get_db() as conn:
        row = conn.execute(
            """UPDATE daily_usage SET count = MAX(0, count - 1)
               WHERE date=? AND ip=? AND key=? RETURNING count""",
            (date, ip, key),
        ).fetchone()
        return row["count"] if row else 0


# ── Write helpers ─────────────────────────────────────────────────────────────

def save_session(session_id: str, requirement: str, req_type: str = "generic") -> None:
    """Insert or update a session record."""
    now = time.time()
    with get_db() as conn:
        conn.execute("""
            INSERT INTO sessions (id, requirement, req_type, status, created_at, updated_at)
            VALUES (?, ?, ?, 'complete', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                req_type   = excluded.req_type,
                status     = excluded.status,
                updated_at = excluded.updated_at
        """, (session_id, requirement, req_type, now, now))


def save_iteration(
    session_id: str,
    iteration_num: int,
    quality_score: int,
    validation_passed: bool,
    feature_name: str,
    spec_document: str,
    result: dict,
) -> None:
    """Upsert one iteration row by (session_id, iteration_num).

    The iterations table has no UNIQUE(session_id, iteration_num) constraint, so a
    plain INSERT … ON CONFLICT DO NOTHING never matches and would create DUPLICATE
    version rows (→ garbled v1/v2 lists). Do an explicit UPDATE-else-INSERT instead."""
    now = time.time()
    payload = json.dumps(result, ensure_ascii=False)
    doc = (spec_document or "")[:50_000]
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE iterations SET quality_score=?, validation_passed=?, feature_name=?, "
            "spec_document=?, result_json=? WHERE session_id=? AND iteration_num=?",
            (quality_score, 1 if validation_passed else 0, feature_name or "", doc, payload,
             session_id, iteration_num),
        )
        if cur.rowcount == 0:
            conn.execute(
                "INSERT INTO iterations (session_id, iteration_num, quality_score, "
                "validation_passed, feature_name, spec_document, result_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (session_id, iteration_num, quality_score, 1 if validation_passed else 0,
                 feature_name or "", doc, payload, now),
            )


def attach_iteration_result(session_id: str, iteration_num: int, feature_name: str,
                            quality_score: int, validation_passed: bool,
                            spec_document: str, result: dict) -> None:
    """Overwrite an iteration's result_json (creating the row if it doesn't exist yet).

    Used to persist derived artifacts (e.g. role views) onto the current PM iteration.
    Unlike save_iteration (insert-or-ignore), this updates an existing row in place."""
    now = time.time()
    payload = json.dumps(result, ensure_ascii=False)
    doc = (spec_document or "")[:50_000]
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE iterations SET result_json=?, spec_document=?, feature_name=?, "
            "quality_score=?, validation_passed=? WHERE session_id=? AND iteration_num=?",
            (payload, doc, feature_name or "", quality_score,
             1 if validation_passed else 0, session_id, iteration_num),
        )
        if cur.rowcount == 0:
            conn.execute(
                "INSERT INTO iterations (session_id, iteration_num, quality_score, "
                "validation_passed, feature_name, spec_document, result_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (session_id, iteration_num, quality_score, 1 if validation_passed else 0,
                 feature_name or "", doc, payload, now),
            )


# ── Read helpers ──────────────────────────────────────────────────────────────

def list_sessions(limit: int = 50) -> list[dict]:
    """Return recent sessions with their latest iteration summary."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                s.id,
                s.requirement,
                s.req_type,
                s.created_at,
                COUNT(i.id)            AS iteration_count,
                MAX(i.quality_score)   AS best_score,
                MAX(i.feature_name)    AS feature_name
            FROM sessions s
            LEFT JOIN iterations i ON i.session_id = s.id
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT ?
        """, (limit,)).fetchall()
    return [dict(r) for r in rows]


def get_session_iterations(session_id: str) -> list[dict]:
    """Return all iterations for a session, newest first."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, session_id, iteration_num, quality_score,
                   validation_passed, feature_name, spec_document, created_at
            FROM iterations
            WHERE session_id = ?
            ORDER BY iteration_num ASC
        """, (session_id,)).fetchall()
    return [dict(r) for r in rows]


def get_iteration_result(session_id: str, iteration_num: int) -> dict | None:
    """Return the full result JSON for a specific iteration."""
    with get_db() as conn:
        row = conn.execute("""
            SELECT result_json FROM iterations
            WHERE session_id = ? AND iteration_num = ?
        """, (session_id, iteration_num)).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["result_json"])
    except Exception:
        return {}


def save_translation(session_id: str, iteration_num: int, translation: dict) -> None:
    """Persist EN translation cache for an iteration."""
    with get_db() as conn:
        conn.execute("""
            UPDATE iterations
            SET translation_json = ?
            WHERE session_id = ? AND iteration_num = ?
        """, (json.dumps(translation, ensure_ascii=False), session_id, iteration_num))


def get_translation(session_id: str, iteration_num: int) -> dict | None:
    """Return cached EN translation for an iteration, or None."""
    with get_db() as conn:
        row = conn.execute("""
            SELECT translation_json FROM iterations
            WHERE session_id = ? AND iteration_num = ?
        """, (session_id, iteration_num)).fetchone()
    if not row or not row["translation_json"]:
        return None
    try:
        return json.loads(row["translation_json"])
    except Exception:
        return None


def delete_session(session_id: str) -> None:
    """Delete a session and all its iterations (cascade)."""
    with get_db() as conn:
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
