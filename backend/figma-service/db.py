"""SQLite persistence for the Figma service (Frame 分析 + Frame 監控, merged).

Self-contained: connection helper, Databricks Volume backup/restore, schema,
and CRUD all in one file — this service owns its own db file end to end,
no coordination with another domain's schema needed.

Stores:
  - figma_cache / figma_tokens: parsed-file cache + encrypted OAuth token
  - figma_stories (v1, legacy) / figma_story_v2 + figma_story_sessions +
    figma_story_versions (v2, LangGraph pipeline): story generation and its
    versioned history
  - figma_monitors / figma_monitor_checks: Frame 監控 definitions + check history
  - teams_webhooks: reusable Teams notification targets

DB file: netspec_figma.db (next to this file, auto-created on first use)
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
_LOCAL = Path(__file__).parent / "netspec_figma.db"
VOLUME_TARGET = os.environ.get("DB_PATH", "")   # /Volumes/.../netspec_figma.db — backup blob
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


FIGMA_PREPROCESS_VER = 3  # bump this when preprocessing logic changes

# ── Schema ────────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS figma_cache (
    file_key        TEXT PRIMARY KEY,
    file_name       TEXT NOT NULL,
    frames_json     TEXT NOT NULL,
    cached_at       REAL NOT NULL,
    preprocess_ver  INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS figma_tokens (
    id           TEXT PRIMARY KEY DEFAULT 'default',
    access_token TEXT NOT NULL,
    handle       TEXT DEFAULT '',
    email        TEXT DEFAULT '',
    created_at   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS figma_stories (
    cache_key   TEXT NOT NULL,
    role        TEXT NOT NULL,
    story_text  TEXT NOT NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    PRIMARY KEY (cache_key, role)
);

CREATE TABLE IF NOT EXISTS figma_story_v2 (
    cache_key   TEXT NOT NULL,
    feature_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    story_text  TEXT NOT NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    PRIMARY KEY (cache_key, feature_id, role)
);

-- Figma story HISTORY (mirrors sessions → iterations).
-- figma_story_v2 stays the "latest working pointer"; these two tables hold the
-- versioned history shown in the unified history sidebar.
CREATE TABLE IF NOT EXISTS figma_story_sessions (
    id               TEXT PRIMARY KEY,        -- = cache_key (stable natural id)
    file_key         TEXT NOT NULL,
    file_name        TEXT NOT NULL DEFAULT '',
    frame_ids_json   TEXT NOT NULL DEFAULT '[]',
    frame_names_json TEXT NOT NULL DEFAULT '[]',
    roles_json       TEXT NOT NULL DEFAULT '[]',
    user_description TEXT DEFAULT '',
    status           TEXT DEFAULT 'complete',
    created_at       REAL NOT NULL,
    updated_at       REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS figma_story_versions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    version_num   INTEGER NOT NULL,
    label         TEXT DEFAULT '',
    quality_score INTEGER DEFAULT 0,          -- reserved (no story scorer yet)
    feature_count INTEGER DEFAULT 0,
    features_json TEXT NOT NULL DEFAULT '[]', -- [{id,name,description}]
    stories_json  TEXT NOT NULL DEFAULT '{}', -- {feature_id:{role:text}}
    created_at    REAL NOT NULL,
    FOREIGN KEY (session_id) REFERENCES figma_story_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_figma_sessions_created ON figma_story_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_figma_versions_session ON figma_story_versions(session_id);

-- Frame change monitors: a user-named watch on a fixed set of frames within a
-- Figma file. Mirrors figma_story_sessions/figma_story_versions — figma_monitors
-- is the definition/latest-pointer row, figma_monitor_checks is the full history
-- of every manual (or future cron) check, each holding its own snapshot so the
-- NEXT check has something to diff against (latest row per monitor_id).
CREATE TABLE IF NOT EXISTS figma_monitors (
    id                TEXT PRIMARY KEY,
    custom_name       TEXT NOT NULL,
    file_key          TEXT NOT NULL,
    file_name         TEXT NOT NULL DEFAULT '',
    frame_ids_json    TEXT NOT NULL DEFAULT '[]',
    frame_names_json  TEXT NOT NULL DEFAULT '[]',
    teams_webhook_url TEXT DEFAULT NULL,
    last_checked_at   REAL DEFAULT NULL,
    created_at        REAL NOT NULL,
    updated_at        REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS figma_monitor_checks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id    TEXT NOT NULL,
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    diff_json     TEXT DEFAULT NULL,
    checked_at    REAL NOT NULL,
    FOREIGN KEY (monitor_id) REFERENCES figma_monitors(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_figma_monitors_created ON figma_monitors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_figma_monitor_checks_monitor ON figma_monitor_checks(monitor_id);

-- Reusable Teams webhook targets — a small saved list, so a monitor picks one
-- instead of every monitor holding its own raw URL. figma_monitors.teams_webhook_id
-- is added via migration below (kept nullable/FK-less for SQLite ALTER simplicity).
CREATE TABLE IF NOT EXISTS teams_webhooks (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_teams_webhooks_created ON teams_webhooks(created_at DESC);
"""

MIGRATIONS = [
    "ALTER TABLE figma_cache ADD COLUMN preprocess_ver INTEGER DEFAULT 1",
    "ALTER TABLE figma_cache ADD COLUMN comments_json TEXT DEFAULT NULL",
    "ALTER TABLE figma_cache ADD COLUMN comments_cached_at REAL DEFAULT NULL",
    "ALTER TABLE figma_monitors ADD COLUMN teams_webhook_id TEXT DEFAULT NULL",
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
    _migrate_monitor_webhook_urls()


def _migrate_monitor_webhook_urls() -> None:
    """One-time, idempotent: any figma_monitors row still holding a raw
    teams_webhook_url (pre-registry column) gets that URL promoted into
    teams_webhooks (named after the monitor) and teams_webhook_id repointed
    at it. Guarded by teams_webhook_id IS NULL, so already-migrated rows
    (or ones a user has since repicked) are left alone on every startup."""
    import uuid
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, custom_name, teams_webhook_url FROM figma_monitors
            WHERE teams_webhook_url IS NOT NULL AND teams_webhook_id IS NULL
        """).fetchall()
        now = time.time()
        for r in rows:
            webhook_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO teams_webhooks (id, name, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (webhook_id, f"{r['custom_name']}（自動搬移）", r["teams_webhook_url"], now, now),
            )
            conn.execute(
                "UPDATE figma_monitors SET teams_webhook_id = ? WHERE id = ?",
                (webhook_id, r["id"]),
            )


# ── Figma parse cache ─────────────────────────────────────────────────────────

def get_figma_cache(file_key: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            "SELECT file_name, frames_json, cached_at, preprocess_ver FROM figma_cache WHERE file_key = ?",
            (file_key,)
        ).fetchone()
    if not row:
        return None
    # Invalidate if preprocessed with older version
    if (row["preprocess_ver"] or 1) < FIGMA_PREPROCESS_VER:
        return None
    return {
        "file_key": file_key,
        "file_name": row["file_name"],
        "frames": json.loads(row["frames_json"]),
        "cached_at": row["cached_at"],
    }


def save_figma_cache(file_key: str, file_name: str, frames: list) -> float:
    now = time.time()
    with get_db() as conn:
        conn.execute("""
            INSERT INTO figma_cache (file_key, file_name, frames_json, cached_at, preprocess_ver)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(file_key) DO UPDATE SET
                file_name = excluded.file_name,
                frames_json = excluded.frames_json,
                cached_at = excluded.cached_at,
                preprocess_ver = excluded.preprocess_ver
        """, (file_key, file_name, json.dumps(frames, ensure_ascii=False), now, FIGMA_PREPROCESS_VER))
    return now


def clear_figma_cache(file_key: str) -> None:
    with get_db() as conn:
        conn.execute("DELETE FROM figma_cache WHERE file_key = ?", (file_key,))


def get_figma_comments(file_key: str) -> list[dict] | None:
    """Return cached comments or None if never fetched."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT comments_json, comments_cached_at FROM figma_cache WHERE file_key = ?",
            (file_key,)
        ).fetchone()
    if not row or row["comments_json"] is None:
        return None
    return json.loads(row["comments_json"])


def save_figma_comments(file_key: str, comments: list[dict]) -> float:
    now = time.time()
    with get_db() as conn:
        conn.execute("""
            UPDATE figma_cache
               SET comments_json = ?, comments_cached_at = ?
             WHERE file_key = ?
        """, (json.dumps(comments, ensure_ascii=False), now, file_key))
    return now


# ── Figma OAuth token (encrypted) ─────────────────────────────────────────────

def save_figma_token(access_token: str, handle: str, email: str, secret_key: str) -> None:
    from crypto import encrypt
    encrypted = encrypt(access_token, secret_key)
    with get_db() as conn:
        conn.execute("""
            INSERT INTO figma_tokens (id, access_token, handle, email, created_at)
            VALUES ('default', ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                access_token = excluded.access_token,
                handle = excluded.handle,
                email = excluded.email,
                created_at = excluded.created_at
        """, (encrypted, handle, email, time.time()))


def load_figma_token(secret_key: str) -> dict | None:
    from crypto import decrypt
    with get_db() as conn:
        row = conn.execute(
            "SELECT access_token, handle, email FROM figma_tokens WHERE id = 'default'"
        ).fetchone()
    if not row:
        return None
    try:
        return {
            "access_token": decrypt(row["access_token"], secret_key),
            "handle": row["handle"],
            "email": row["email"],
        }
    except Exception:
        return None


def clear_figma_token() -> None:
    with get_db() as conn:
        conn.execute("DELETE FROM figma_tokens WHERE id = 'default'")


# ── Figma Story cache ─────────────────────────────────────────────────────────

def get_figma_stories(cache_key: str) -> dict[str, str]:
    """Return all cached stories for a frame set. Keys are role names."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT role, story_text FROM figma_stories WHERE cache_key = ?",
            (cache_key,)
        ).fetchall()
    return {row["role"]: row["story_text"] for row in rows}


def save_figma_story(cache_key: str, role: str, story_text: str) -> float:
    now = time.time()
    with get_db() as conn:
        conn.execute("""
            INSERT INTO figma_stories (cache_key, role, story_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(cache_key, role) DO UPDATE SET
                story_text = excluded.story_text,
                updated_at = excluded.updated_at
        """, (cache_key, role, story_text, now, now))
    return now


# ── Figma Story v2 (feature-level, LangGraph pipeline) ────────────────────────

def get_figma_stories_v2(cache_key: str) -> dict:
    """Return cached stories keyed by {feature_id: {role: text}}."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT feature_id, role, story_text FROM figma_story_v2 WHERE cache_key = ?",
            (cache_key,)
        ).fetchall()
    result: dict = {}
    for row in rows:
        fid  = row["feature_id"]
        role = row["role"]
        result.setdefault(fid, {})[role] = row["story_text"]
    return result


def save_figma_story_v2(cache_key: str, feature_id: str, role: str, story_text: str) -> None:
    now = time.time()
    with get_db() as conn:
        conn.execute("""
            INSERT INTO figma_story_v2 (cache_key, feature_id, role, story_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key, feature_id, role) DO UPDATE SET
                story_text = excluded.story_text,
                updated_at = excluded.updated_at
        """, (cache_key, feature_id, role, story_text, now, now))


# ── Figma Story HISTORY (sessions → versions, mirrors sessions → iterations) ──

def save_figma_story_session(
    session_id: str,
    file_key: str,
    file_name: str,
    frame_ids: list[str],
    frame_names: list[str],
    roles: list[str],
    user_description: str = "",
) -> None:
    """Insert or update a figma story session (parent). Mirrors save_session."""
    now = time.time()
    with get_db() as conn:
        conn.execute("""
            INSERT INTO figma_story_sessions
                (id, file_key, file_name, frame_ids_json, frame_names_json,
                 roles_json, user_description, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                file_name        = excluded.file_name,
                frame_ids_json   = excluded.frame_ids_json,
                frame_names_json = excluded.frame_names_json,
                roles_json       = excluded.roles_json,
                user_description = excluded.user_description,
                updated_at       = excluded.updated_at
        """, (
            session_id, file_key, file_name or "",
            json.dumps(frame_ids or [], ensure_ascii=False),
            json.dumps(frame_names or [], ensure_ascii=False),
            json.dumps(roles or [], ensure_ascii=False),
            user_description or "", now, now,
        ))


def next_figma_version_num(session_id: str) -> int:
    """Return MAX(version_num)+1 for a session, or 1 if none."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT MAX(version_num) AS m FROM figma_story_versions WHERE session_id = ?",
            (session_id,)
        ).fetchone()
    return (row["m"] or 0) + 1 if row else 1


def save_figma_story_version(
    session_id: str,
    version_num: int,
    features: list[dict],
    stories: dict,
    label: str = "",
    quality_score: int = 0,
) -> None:
    """Insert one figma story version (snapshot). Mirrors save_iteration."""
    now = time.time()
    with get_db() as conn:
        conn.execute("""
            INSERT INTO figma_story_versions
                (session_id, version_num, label, quality_score, feature_count,
                 features_json, stories_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            session_id, version_num, label or "", quality_score,
            len(features or []),
            json.dumps(features or [], ensure_ascii=False),
            json.dumps(stories or {}, ensure_ascii=False),
            now,
        ))


def update_figma_story_version(
    session_id: str,
    version_num: int,
    features: list[dict] | None,
    stories: dict,
    label: str | None = None,
) -> bool:
    """Overwrite an existing version in place (不進版/edit). Returns True if a row matched."""
    sets = ["stories_json = ?"]
    args: list = [json.dumps(stories or {}, ensure_ascii=False)]
    if features is not None:
        sets.append("features_json = ?")
        args.append(json.dumps(features, ensure_ascii=False))
        sets.append("feature_count = ?")
        args.append(len(features))
    if label is not None:
        sets.append("label = ?")
        args.append(label)
    args.extend([session_id, version_num])
    with get_db() as conn:
        cur = conn.execute(
            f"UPDATE figma_story_versions SET {', '.join(sets)} "
            f"WHERE session_id = ? AND version_num = ?",
            args,
        )
        return cur.rowcount > 0


def list_figma_story_sessions(limit: int = 50) -> list[dict]:
    """Recent figma story sessions with version summary. Mirrors list_sessions."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                s.id,
                s.file_key,
                s.file_name,
                s.frame_names_json,
                s.roles_json,
                s.created_at,
                COUNT(v.id)          AS version_count,
                MAX(v.feature_count) AS feature_count,
                MAX(v.quality_score) AS best_score
            FROM figma_story_sessions s
            LEFT JOIN figma_story_versions v ON v.session_id = s.id
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT ?
        """, (limit,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["frame_names"] = json.loads(d.pop("frame_names_json") or "[]")
        d["roles"]       = json.loads(d.pop("roles_json") or "[]")
        out.append(d)
    return out


def list_figma_story_sessions_by_file(file_key: str) -> list[dict]:
    """All figma story sessions for a file_key, with frame_ids — used to flag
    which frames have already been generated in the frame picker."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                s.id,
                s.frame_ids_json,
                s.frame_names_json,
                s.roles_json,
                s.updated_at,
                COUNT(v.id)          AS version_count,
                MAX(v.feature_count) AS feature_count
            FROM figma_story_sessions s
            LEFT JOIN figma_story_versions v ON v.session_id = s.id
            WHERE s.file_key = ?
            GROUP BY s.id
            ORDER BY s.updated_at DESC
        """, (file_key,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["frame_ids"]   = json.loads(d.pop("frame_ids_json") or "[]")
        d["frame_names"] = json.loads(d.pop("frame_names_json") or "[]")
        d["roles"]       = json.loads(d.pop("roles_json") or "[]")
        out.append(d)
    return out


def get_figma_story_versions(session_id: str) -> list[dict]:
    """All versions for a session (light fields). Mirrors get_session_iterations."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, session_id, version_num, label, quality_score,
                   feature_count, created_at
            FROM figma_story_versions
            WHERE session_id = ?
            ORDER BY version_num ASC
        """, (session_id,)).fetchall()
    return [dict(r) for r in rows]


def get_figma_story_version(session_id: str, version_num: int) -> dict | None:
    """Full snapshot (features + stories) for one version, with session meta."""
    with get_db() as conn:
        row = conn.execute("""
            SELECT v.features_json, v.stories_json, v.label, v.version_num,
                   s.file_key, s.file_name, s.frame_ids_json, s.frame_names_json, s.roles_json
            FROM figma_story_versions v
            JOIN figma_story_sessions s ON s.id = v.session_id
            WHERE v.session_id = ? AND v.version_num = ?
        """, (session_id, version_num)).fetchone()
    if not row:
        return None
    try:
        return {
            "version_num": row["version_num"],
            "label":       row["label"],
            "file_key":    row["file_key"],
            "file_name":   row["file_name"],
            "frame_ids":   json.loads(row["frame_ids_json"] or "[]"),
            "frame_names": json.loads(row["frame_names_json"] or "[]"),
            "roles":       json.loads(row["roles_json"] or "[]"),
            "features":    json.loads(row["features_json"] or "[]"),
            "stories":     json.loads(row["stories_json"] or "{}"),
        }
    except Exception:
        return None


def delete_figma_story_session(session_id: str) -> None:
    """Delete a figma story session, its versions (cascade), AND the latest-pointer
    cache. session_id == cache_key, so clearing figma_story_v2 ensures a re-run of
    the same frame set is a clean cache miss (goes through the full wizard) rather
    than serving the deleted stories."""
    with get_db() as conn:
        conn.execute("DELETE FROM figma_story_sessions WHERE id = ?", (session_id,))
        conn.execute("DELETE FROM figma_story_v2 WHERE cache_key = ?", (session_id,))


# ── Figma frame monitors ────────────────────────────────────────────────────

def _summarise_diff(diff: dict) -> dict:
    """Collapse a full diff_frame_snapshots() result into just the counts a
    collapsed monitor card needs (avoids shipping full diff bodies — frame
    names, changed text — to the list endpoint just to render a badge)."""
    modified = diff.get("modified", [])
    changed_lines = sum(
        len(f.get("changed_texts", [])) + len(f.get("added_texts", [])) + len(f.get("removed_texts", []))
        for f in modified
    )
    return {
        "added":    len(diff.get("added", [])),
        "removed":  len(diff.get("removed", [])),
        "modified": len(modified),
        "changed_lines": changed_lines,
    }


def create_figma_monitor(
    monitor_id: str, custom_name: str, file_key: str, file_name: str,
    frame_ids: list[str], frame_names: list[str], teams_webhook_id: str | None = None,
) -> dict:
    now = time.time()
    with get_db() as conn:
        conn.execute("""
            INSERT INTO figma_monitors
                (id, custom_name, file_key, file_name, frame_ids_json, frame_names_json,
                 teams_webhook_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (monitor_id, custom_name, file_key, file_name,
              json.dumps(frame_ids, ensure_ascii=False), json.dumps(frame_names, ensure_ascii=False),
              teams_webhook_id, now, now))
    return {
        "id": monitor_id, "custom_name": custom_name, "file_key": file_key,
        "file_name": file_name, "frame_ids": frame_ids, "frame_names": frame_names,
        "teams_webhook_id": teams_webhook_id,
        "last_checked_at": None, "created_at": now, "updated_at": now,
    }


def list_figma_monitors(limit: int = 50) -> list[dict]:
    """Timeline list for the monitor sidebar.

    Ordered by created_at (not updated_at) — updated_at bumps on every check
    or webhook-selection change, which would otherwise reshuffle the list on
    routine actions and make a specific monitor hard to find again.
    """
    with get_db() as conn:
        rows = conn.execute("""
            SELECT m.id, m.custom_name, m.file_key, m.file_name, m.frame_ids_json,
                   m.teams_webhook_id, w.name AS webhook_name,
                   m.last_checked_at, m.created_at, m.updated_at,
                   (SELECT diff_json FROM figma_monitor_checks c
                    WHERE c.monitor_id = m.id ORDER BY c.checked_at DESC LIMIT 1) AS latest_diff_json
            FROM figma_monitors m
            LEFT JOIN teams_webhooks w ON w.id = m.teams_webhook_id
            ORDER BY m.created_at DESC
            LIMIT ?
        """, (limit,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["frame_count"] = len(json.loads(d.pop("frame_ids_json") or "[]"))
        d["has_webhook"] = d.get("teams_webhook_id") is not None
        raw_diff = d.pop("latest_diff_json")
        d["latest_diff_summary"] = _summarise_diff(json.loads(raw_diff)) if raw_diff else None
        out.append(d)
    return out


def get_figma_monitor(monitor_id: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute("""
            SELECT m.id, m.custom_name, m.file_key, m.file_name, m.frame_ids_json, m.frame_names_json,
                   m.teams_webhook_id, w.name AS webhook_name, w.url AS webhook_url,
                   m.last_checked_at, m.created_at, m.updated_at
            FROM figma_monitors m
            LEFT JOIN teams_webhooks w ON w.id = m.teams_webhook_id
            WHERE m.id = ?
        """, (monitor_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["frame_ids"]   = json.loads(d.pop("frame_ids_json") or "[]")
    d["frame_names"] = json.loads(d.pop("frame_names_json") or "[]")
    return d


def update_figma_monitor_webhook(monitor_id: str, teams_webhook_id: str | None) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE figma_monitors SET teams_webhook_id = ?, updated_at = ? WHERE id = ?",
            (teams_webhook_id, time.time(), monitor_id),
        )


def update_figma_monitor_name(monitor_id: str, custom_name: str) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE figma_monitors SET custom_name = ?, updated_at = ? WHERE id = ?",
            (custom_name, time.time(), monitor_id),
        )


def delete_figma_monitor(monitor_id: str) -> None:
    """Delete a monitor and its check history (cascade). Does NOT touch
    teams_webhooks — a webhook may be shared by other monitors."""
    with get_db() as conn:
        conn.execute("DELETE FROM figma_monitors WHERE id = ?", (monitor_id,))


# ── Teams webhooks (reusable notification targets) ──────────────────────────

def create_teams_webhook(webhook_id: str, name: str, url: str) -> dict:
    now = time.time()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO teams_webhooks (id, name, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (webhook_id, name, url, now, now),
        )
    return {"id": webhook_id, "name": name, "url": url, "created_at": now, "updated_at": now}


def list_teams_webhooks() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, url, created_at, updated_at FROM teams_webhooks ORDER BY created_at ASC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_teams_webhook(webhook_id: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, name, url, created_at, updated_at FROM teams_webhooks WHERE id = ?", (webhook_id,)
        ).fetchone()
    return dict(row) if row else None


def update_teams_webhook(webhook_id: str, name: str, url: str) -> None:
    with get_db() as conn:
        conn.execute(
            "UPDATE teams_webhooks SET name = ?, url = ?, updated_at = ? WHERE id = ?",
            (name, url, time.time(), webhook_id),
        )


def delete_teams_webhook(webhook_id: str) -> None:
    """Delete a webhook. Any monitor pointing at it falls back to no webhook
    (explicit unlink, not a dangling id) rather than a foreign-key error —
    SQLite's ALTER-TABLE-added column has no real FK constraint to enforce this."""
    with get_db() as conn:
        conn.execute(
            "UPDATE figma_monitors SET teams_webhook_id = NULL, updated_at = ? WHERE teams_webhook_id = ?",
            (time.time(), webhook_id),
        )
        conn.execute("DELETE FROM teams_webhooks WHERE id = ?", (webhook_id,))


def get_latest_figma_monitor_check(monitor_id: str) -> dict | None:
    """Most recent check's snapshot — the diff baseline for the NEXT check."""
    with get_db() as conn:
        row = conn.execute("""
            SELECT id, snapshot_json, diff_json, checked_at
            FROM figma_monitor_checks
            WHERE monitor_id = ?
            ORDER BY checked_at DESC LIMIT 1
        """, (monitor_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["snapshot"] = json.loads(d.pop("snapshot_json") or "{}")
    raw_diff = d.pop("diff_json")
    d["diff"] = json.loads(raw_diff) if raw_diff else None
    return d


def add_figma_monitor_check(monitor_id: str, snapshot: dict, diff: dict | None) -> dict:
    """Record one check as a new history row, and bump the monitor's
    last_checked_at/updated_at pointers."""
    now = time.time()
    with get_db() as conn:
        cur = conn.execute("""
            INSERT INTO figma_monitor_checks (monitor_id, snapshot_json, diff_json, checked_at)
            VALUES (?, ?, ?, ?)
        """, (monitor_id, json.dumps(snapshot, ensure_ascii=False),
              json.dumps(diff, ensure_ascii=False) if diff is not None else None, now))
        conn.execute("""
            UPDATE figma_monitors SET last_checked_at = ?, updated_at = ? WHERE id = ?
        """, (now, now, monitor_id))
    return {"id": cur.lastrowid, "monitor_id": monitor_id, "snapshot": snapshot,
            "diff": diff, "checked_at": now}


def list_figma_monitor_checks(monitor_id: str) -> list[dict]:
    """Full check-history timeline for one monitor (newest first). Snapshot
    omitted here (can be large) — only the diff + timestamp, matching what a
    timeline view needs; fetch the single check row for the full snapshot."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, diff_json, checked_at
            FROM figma_monitor_checks
            WHERE monitor_id = ?
            ORDER BY checked_at DESC
        """, (monitor_id,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        raw_diff = d.pop("diff_json")
        d["diff"] = json.loads(raw_diff) if raw_diff else None
        out.append(d)
    return out
