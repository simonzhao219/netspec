"""NetSpec app telemetry — server-side event emitter.

Mirror of frontend/lib/telemetry-sink.ts. Both services carry their own copy,
matching this repo's existing choice to duplicate llm_client.py / cost.py per
service rather than stand up a shared package.

Two independent delivery paths:

  1. stdout — one compact JSON line per event. The Databricks Apps runtime
     exports every stdout/stderr line into the workspace's ``otel_logs`` Unity
     Catalog table over OpenTelemetry: no export code, no IAM setup, no token
     handling in the app. Always on.

  2. Delta — an optional direct write into a typed Unity Catalog table via the
     SQL Statement Execution API. Off unless TELEMETRY_TABLE and
     TELEMETRY_WAREHOUSE_ID are both set. It exists so telemetry still lands if
     App telemetry / OTel export has not been enabled on this app, and so the
     PoC owns a typed table outright.

Nothing here may raise into a request path or block it: the Delta write happens
on a daemon thread and every failure is swallowed after one report to stderr.

Event types
    ui_interaction — a click in the browser (relayed from the frontend)
    server_event   — something the service did (pipeline node, session created)
    app_output     — something the service produced (a specification version)
    llm_call       — one model call, with tokens and estimated cost
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

# ── Config ────────────────────────────────────────────────────────────────────

TELEMETRY_SCHEMA = "ep.app_event.v1"

APP_NAME = os.environ.get("TELEMETRY_APP_NAME", "netspec")
SERVICE_NAME = os.environ.get("TELEMETRY_SERVICE_NAME", "unknown-service")
TABLE = os.environ.get("TELEMETRY_TABLE", "").strip()
WAREHOUSE_ID = os.environ.get("TELEMETRY_WAREHOUSE_ID", "").strip()
FLUSH_ROWS = int(os.environ.get("TELEMETRY_FLUSH_ROWS", "50") or 50)
FLUSH_SECONDS = float(os.environ.get("TELEMETRY_FLUSH_MS", "10000") or 10000) / 1000.0

COLUMNS = [
    "event_id", "telemetry_schema", "app", "service", "event_type", "event_name",
    "event_time", "received_at", "page", "workflow", "session_id", "app_session_id",
    "user_email", "user_id", "request_id", "duration_ms", "properties",
]
_PAYLOAD_SCHEMA = "array<struct<" + ",".join(
    f"{c}:{'bigint' if c == 'duration_ms' else 'string'}" for c in COLUMNS
) + ">>"

# The table identifier cannot be passed as a bound parameter, so it is
# whitelisted rather than trusted.
_TABLE_RE = re.compile(r"^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")


def _delta_enabled() -> bool:
    return bool(TABLE and WAREHOUSE_ID and _TABLE_RE.match(TABLE))


# ── stdout logger ─────────────────────────────────────────────────────────────
# A dedicated logger with a bare formatter so each record is exactly one JSON
# line. propagate=False keeps it from being re-emitted (and reformatted) by the
# root/uvicorn handlers, which would produce duplicate rows in otel_logs.

logger = logging.getLogger("interaction_events")
logger.setLevel(logging.INFO)
logger.propagate = False
if not logger.handlers:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(_handler)


# ── Identity ──────────────────────────────────────────────────────────────────

# The frontend proxy relays the browser-resolved user under these PRIVATE header
# names rather than re-sending X-Forwarded-Email. That header belongs to the
# platform: the backend App sits behind its own auth proxy, which sets
# X-Forwarded-* for whichever principal authenticated THAT hop — the frontend's
# service principal whenever the frontend falls back to its M2M token. A private
# name nothing else writes is the only way the human's identity survives the hop.
RELAY_EMAIL_HEADER = "x-netspec-user-email"
RELAY_USER_HEADER = "x-netspec-user-id"


def identity_from(request: Any) -> dict:
    """The acting user, injected by the Databricks Apps platform — no auth code.

    ``X-Forwarded-Access-Token`` is deliberately not read: a bearer token has no
    business in a log line.

    The relayed private headers win over the platform ones. Only the frontend's
    /api/events handler sees the browser's request directly, so only it knows the
    real human; the platform headers on THIS hop describe whichever principal the
    proxy authenticated as. Trust model: these services are reachable only behind
    the workspace auth proxy, and the value is used for telemetry attribution
    only — never for authorization — so a spoofed header costs a wrong dashboard
    row and nothing else.
    """
    try:
        headers = request.headers
    except Exception:
        return {"user_email": None, "user_id": None, "request_id": None}
    return {
        "user_email": headers.get(RELAY_EMAIL_HEADER) or headers.get("x-forwarded-email"),
        "user_id": headers.get(RELAY_USER_HEADER) or headers.get("x-forwarded-user"),
        "request_id": headers.get("x-request-id"),
    }


def resolve_identity(request: Any, explicit: Optional[dict] = None) -> dict:
    """Merge a caller-supplied identity over the platform headers.

    The frontend relays the browser-resolved user on server-side events; that
    value wins because it was read from the request the human actually made.
    """
    ident = identity_from(request)
    for key in ("user_email", "user_id", "request_id"):
        value = (explicit or {}).get(key)
        if value:
            ident[key] = value
    return ident


# ── Ambient session context ───────────────────────────────────────────────────
# LLM calls happen deep inside the pipeline, far from any request or session
# object. A context variable carries the join keys down to them so token spend
# can be attributed to the session (and therefore the user and the feature) that
# caused it, without threading an extra argument through every call site.

_ctx: contextvars.ContextVar[dict] = contextvars.ContextVar("telemetry_ctx", default={})


class bind_context:
    """Bind join keys for the duration of a block.

    Used as a context manager so the previous context is always restored — FastAPI
    runs background tasks inside the response's context, and a bare set() would
    leak one session's ids into the next task that ran there.

        with telemetry.bind_context(app_session_id=session.id, workflow="text"):
            await run_the_pipeline()
    """

    def __init__(self, **fields: Any) -> None:
        self._fields = {k: v for k, v in fields.items() if v is not None}
        self._token: Any = None

    def __enter__(self) -> dict:
        merged = {**_ctx.get(), **self._fields}
        self._token = _ctx.set(merged)
        return merged

    def __exit__(self, *exc: Any) -> bool:
        if self._token is not None:
            _ctx.reset(self._token)
        return False


def current_context() -> dict:
    """The join keys bound by the innermost enclosing :class:`bind_context`."""
    return dict(_ctx.get())


# ── Core ──────────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_record(
    event_name: str,
    *,
    event_type: str = "server_event",
    event_time: Optional[str] = None,
    page: Optional[str] = None,
    workflow: Optional[str] = None,
    session_id: Optional[str] = None,
    app_session_id: Optional[str] = None,
    user_email: Optional[str] = None,
    user_id: Optional[str] = None,
    request_id: Optional[str] = None,
    duration_ms: Optional[int] = None,
    properties: Optional[dict] = None,
    service: Optional[str] = None,
) -> dict:
    now = _now_iso()
    return {
        "event_id": str(uuid.uuid4()),
        "telemetry_schema": TELEMETRY_SCHEMA,
        "app": APP_NAME,
        "service": service or SERVICE_NAME,
        "event_type": event_type,
        "event_name": event_name,
        "event_time": event_time or now,
        "received_at": now,
        "page": page,
        "workflow": workflow,
        "session_id": session_id,
        "app_session_id": app_session_id,
        "user_email": user_email,
        "user_id": user_id,
        "request_id": request_id,
        "duration_ms": int(duration_ms) if duration_ms is not None else None,
        "properties": _safe_json(properties or {}),
    }


def emit(record: dict) -> None:
    """Write one record to both sinks. Never raises."""
    try:
        logger.info(json.dumps(record, separators=(",", ":"), default=str, ensure_ascii=False))
    except Exception:
        pass
    if _delta_enabled():
        _enqueue(record)


def track(event_name: str, **kwargs: Any) -> None:
    """Record one server-side event. Fire-and-forget; never raises."""
    try:
        emit(build_record(event_name, **kwargs))
    except Exception:
        pass


def track_output(event_name: str, **kwargs: Any) -> None:
    """Record something the app *produced* (a spec version, a story, an RCA).

    Success criterion #2: what each app produced, not just how it was used —
    joinable to the interaction telemetry on ``app_session_id`` and ``user_email``.
    """
    kwargs.setdefault("event_type", "app_output")
    track(event_name, **kwargs)


def track_llm_call(
    *,
    tool: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
    step: str = "",
    app_session_id: Optional[str] = None,
    duration_ms: Optional[int] = None,
    **extra: Any,
) -> None:
    """Record one model call with tokens and estimated cost.

    Success criterion #10 wants cost attributable by SDLC stage. Once model
    calls route through the Databricks-hosted Anthropic endpoint the platform
    system tables carry the authoritative numbers; this event carries the piece
    the platform cannot know — which pipeline step the spend belongs to — and
    keeps the metric available before that migration happens.
    """
    props = {
        "tool": tool,
        "model": model,
        "step": step,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": (input_tokens or 0) + (output_tokens or 0),
        "cost_usd": round(float(cost_usd or 0.0), 6),
    }
    props.update(extra)
    ctx = current_context()
    track(
        "llm_call",
        event_type="llm_call",
        app_session_id=app_session_id or ctx.get("app_session_id"),
        user_email=ctx.get("user_email"),
        user_id=ctx.get("user_id"),
        workflow=ctx.get("workflow"),
        duration_ms=duration_ms,
        properties=props,
    )


# ── Property hygiene ──────────────────────────────────────────────────────────

_MAX_STRING = 200
_DENY = {
    "requirement", "spec", "spec_document", "answer", "answers", "content",
    "text", "token", "access_token", "secret", "password", "api_key", "prompt",
}


def scrub(props: dict) -> dict:
    """Telemetry describes behaviour, not content.

    Requirement text, spec bodies and Figma tokens must never reach a log line.
    Callers should pass lengths, ids and enums; this is the backstop for when
    they forget. Mirrors ``scrub`` in frontend/lib/track.ts.
    """
    out: dict = {}
    for key, value in (props or {}).items():
        if key.lower() in _DENY:
            if isinstance(value, str):
                out[f"{key}_chars"] = len(value)
            elif isinstance(value, (list, tuple, dict)):
                out[f"{key}_count"] = len(value)
            continue
        if isinstance(value, str):
            out[key] = value if len(value) <= _MAX_STRING else value[:_MAX_STRING] + "…"
        elif isinstance(value, bool) or value is None or isinstance(value, (int, float)):
            out[key] = value
        elif isinstance(value, (list, tuple)):
            out[key] = len(value) if len(value) > 20 else [
                (v[:_MAX_STRING] + "…") if isinstance(v, str) and len(v) > _MAX_STRING else v
                for v in value
            ]
        elif isinstance(value, dict):
            out[key] = scrub(value)
    return out


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(scrub(value) if isinstance(value, dict) else value,
                          separators=(",", ":"), default=str, ensure_ascii=False)
    except Exception:
        return '{"_error":"unserializable properties"}'


# ── Delta sink ────────────────────────────────────────────────────────────────

_buffer: list[dict] = []
_lock = threading.Lock()
_flusher: Optional[threading.Thread] = None
_reported_failure = False


def _enqueue(record: dict) -> None:
    global _flusher
    with _lock:
        _buffer.append(record)
        should_flush_now = len(_buffer) >= FLUSH_ROWS
        if _flusher is None or not _flusher.is_alive():
            _flusher = threading.Thread(target=_flush_loop, name="telemetry-flush", daemon=True)
            _flusher.start()
    if should_flush_now:
        threading.Thread(target=flush_delta, name="telemetry-flush-now", daemon=True).start()


def _flush_loop() -> None:
    while True:
        time.sleep(FLUSH_SECONDS)
        flush_delta()


def flush_delta() -> None:
    """Drain the buffer into Unity Catalog. Best-effort — a failed batch is
    dropped rather than retried forever, since stdout already carries it."""
    global _reported_failure
    if not _delta_enabled():
        return
    with _lock:
        if not _buffer:
            return
        batch = _buffer[:]
        _buffer.clear()

    try:
        from databricks.sdk import WorkspaceClient
        WorkspaceClient().api_client.do(
            "POST",
            "/api/2.0/sql/statements",
            body={
                "warehouse_id": WAREHOUSE_ID,
                "statement": _insert_statement(TABLE),
                # The whole batch travels as ONE bound parameter, so no event
                # field is ever interpolated into SQL text.
                "parameters": [{
                    "name": "payload",
                    "type": "STRING",
                    "value": json.dumps(batch, separators=(",", ":"), default=str, ensure_ascii=False),
                }],
                "wait_timeout": "30s",
                "on_wait_timeout": "CONTINUE",
            },
        )
    except Exception as exc:  # noqa: BLE001 — telemetry must never break the app
        if not _reported_failure:
            _reported_failure = True
            print(
                f"[telemetry] Delta sink error, further errors suppressed "
                f"({type(exc).__name__}: {str(exc)[:400]}). "
                f"stdout -> otel_logs is unaffected; see doc/SDCL_telemetry_deployment.md",
                file=sys.stderr,
                flush=True,
            )


def _insert_statement(table: str) -> str:
    """One INSERT that unpacks the whole batch from a single JSON parameter.

    ``try_to_timestamp`` is tried bare first (handles most ISO-8601) then with an
    explicit pattern, so a millisecond-and-Z timestamp is never silently NULLed.
    """
    def ts(col: str) -> str:
        return (f'coalesce(try_to_timestamp(e.{col}), '
                f'try_to_timestamp(e.{col}, "yyyy-MM-dd\'T\'HH:mm:ss.SSSXXX"))')

    return f"""
INSERT INTO {table} (
  event_id, telemetry_schema, app, service, event_type, event_name,
  event_time, received_at, event_date, page, workflow, session_id,
  app_session_id, user_email, user_id, request_id, duration_ms, properties
)
SELECT
  e.event_id, e.telemetry_schema, e.app, e.service, e.event_type, e.event_name,
  {ts('event_time')}, {ts('received_at')}, to_date({ts('received_at')}),
  e.page, e.workflow, e.session_id, e.app_session_id,
  e.user_email, e.user_id, e.request_id, e.duration_ms, e.properties
FROM (SELECT explode(from_json(:payload, '{_PAYLOAD_SCHEMA}')) AS e)
""".strip()


def shutdown() -> None:
    """Final drain on service shutdown so the last events aren't lost."""
    try:
        flush_delta()
    except Exception:
        pass


def diagnostics() -> dict:
    """Surfaced via /api/health so a deploy can be verified without a SQL query."""
    with _lock:
        pending = len(_buffer)
    return {
        "app": APP_NAME,
        "service": SERVICE_NAME,
        "stdout_sink": True,
        "delta_sink": _delta_enabled(),
        "delta_table": TABLE or None,
        "delta_warehouse_id": WAREHOUSE_ID or None,
        "delta_pending_rows": pending,
        "delta_failed": _reported_failure,
    }
