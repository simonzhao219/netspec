"""Figma service — Frame 分析 + Frame 監控 + Figma Story (v1 + v2 pipeline).

Everything under /api/figma/* and /api/teams-webhooks/* lives here, plus
this service's own health/switch-mode/cost-report (folded in from the old
routers/admin.py — each service gets its own copy now that it runs as an
independent process/port; see the router-split memory).
"""

import asyncio
import base64
import json
import os
import secrets
import time
import uuid
from typing import Any, Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import RedirectResponse
from langgraph.types import Command
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

import db as _db
import figma as _figma
import figma_story as _figma_story
import figma_story_graph as _fsg
import telemetry
from config import get_settings
from sse_session import Session
from db import (
    save_figma_token, load_figma_token, clear_figma_token,
    get_figma_comments, save_figma_comments,
    get_figma_stories, save_figma_story,
    save_figma_story_v2, save_figma_story_session, next_figma_version_num,
    save_figma_story_version, update_figma_story_version,
    list_figma_story_sessions, list_figma_story_sessions_by_file,
    get_figma_story_versions, get_figma_story_version, delete_figma_story_session,
    create_teams_webhook, list_teams_webhooks, get_teams_webhook,
    update_teams_webhook, delete_teams_webhook,
    create_figma_monitor, list_figma_monitors, get_figma_monitor,
    update_figma_monitor_webhook, update_figma_monitor_name, delete_figma_monitor,
    add_figma_monitor_check, get_latest_figma_monitor_check, list_figma_monitor_checks,
    get_figma_cache,
)

router = APIRouter(prefix="/api")

FIGMA_SESSIONS: dict[str, Session] = {}


# ── Telemetry helpers ─────────────────────────────────────────────────────────
# Mirrors text-spec-service/router.py: one place that attaches the join keys
# (app_session_id, user_email) so no call site can forget them.

def _emit(session: Optional[Session], event_name: str, *, duration_ms: int | None = None,
          properties: dict | None = None, event_type: str = "server_event") -> None:
    telemetry.track(
        event_name,
        event_type=event_type,
        app_session_id=session.id if session else None,
        user_email=session.user_email if session else None,
        user_id=session.user_id if session else None,
        workflow="figma",
        duration_ms=duration_ms,
        properties=properties or {},
    )


def _emit_request(request: Request, event_name: str, *, duration_ms: int | None = None,
                  properties: dict | None = None, event_type: str = "server_event") -> None:
    """For endpoints with no pipeline session — attribute straight from the request."""
    ident = telemetry.identity_from(request)
    telemetry.track(
        event_name,
        event_type=event_type,
        workflow="figma",
        user_email=ident.get("user_email"),
        user_id=ident.get("user_id"),
        request_id=ident.get("request_id"),
        duration_ms=duration_ms,
        properties=properties or {},
    )


def _get_cached_frames(file_key: str) -> list[dict]:
    cached = get_figma_cache(file_key)
    if not cached:
        raise HTTPException(422, "Figma 快取不存在，請先取得 Frame 列表。")
    return cached["frames"]


# ── Figma OAuth ───────────────────────────────────────────────────────────────

_oauth_states: dict = {}  # state -> True（CSRF 防護）


@router.get("/figma/oauth/start")
async def figma_oauth_start():
    from urllib.parse import urlencode
    cfg = get_settings()
    if not cfg.figma_client_id:
        raise HTTPException(400, "FIGMA_CLIENT_ID 未設定")
    state = secrets.token_urlsafe(16)
    _oauth_states[state] = True
    params = {
        "client_id": cfg.figma_client_id,
        "redirect_uri": cfg.figma_redirect_uri,
        "scope": "file_content:read file_comments:read",
        "state": state,
        "response_type": "code",
    }
    auth_url = "https://www.figma.com/oauth?" + urlencode(params)
    print(f"[Figma OAuth] redirect to: {auth_url}")
    return RedirectResponse(auth_url)


@router.get("/figma/oauth/callback")
async def figma_oauth_callback(code: str, state: str):
    if state not in _oauth_states:
        raise HTTPException(400, "Invalid OAuth state")
    _oauth_states.pop(state)
    cfg = get_settings()
    auth = base64.b64encode(
        f"{cfg.figma_client_id}:{cfg.figma_client_secret}".encode()
    ).decode()
    import httpx as _httpx
    resp = _httpx.post(
        "https://api.figma.com/v1/oauth/token",
        headers={"Authorization": f"Basic {auth}"},
        data={
            "redirect_uri": cfg.figma_redirect_uri,
            "code": code,
            "grant_type": "authorization_code",
        },
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    cfg = get_settings()
    save_figma_token(
        access_token=data.get("access_token", ""),
        handle=data.get("handle", ""),
        email=data.get("email", ""),
        secret_key=cfg.secret_key or cfg.api_key,
    )
    return RedirectResponse(f"{cfg.frontend_url.rstrip('/')}/?figma_connected=1")


@router.get("/figma/oauth/status")
async def figma_oauth_status():
    cfg = get_settings()
    token = load_figma_token(cfg.secret_key or cfg.api_key)
    if not token:
        return {"connected": False}
    return {"connected": True, "handle": token.get("handle"), "email": token.get("email")}


@router.delete("/figma/oauth/disconnect")
async def figma_oauth_disconnect():
    clear_figma_token()
    return {"disconnected": True}


def _figma_token() -> str | None:
    cfg = get_settings()
    token = load_figma_token(cfg.secret_key or cfg.api_key)
    return token["access_token"] if token else None


# ── Teams Webhooks (reusable notification targets) ────────────────────────────
# A small saved list of named webhook URLs — a monitor picks one instead of
# every monitor holding its own raw URL. Deleting a webhook unlinks (doesn't
# 404) any monitor pointing at it; see db.delete_teams_webhook.

class TeamsWebhookRequest(BaseModel):
    name: str
    url:  str


@router.post("/teams-webhooks")
async def create_teams_webhook_endpoint(body: TeamsWebhookRequest) -> dict:
    name = body.name.strip()
    url = body.url.strip()
    if not name:
        raise HTTPException(400, "請輸入 Webhook 名稱")
    if not url:
        raise HTTPException(400, "請輸入 Webhook URL")
    try:
        return create_teams_webhook(str(uuid.uuid4()), name, url)
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.get("/teams-webhooks")
async def list_teams_webhooks_endpoint() -> list:
    try:
        return list_teams_webhooks()
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.put("/teams-webhooks/{webhook_id}")
async def update_teams_webhook_endpoint(webhook_id: str, body: TeamsWebhookRequest) -> dict:
    if not get_teams_webhook(webhook_id):
        raise HTTPException(404, "找不到此 Webhook")
    name = body.name.strip()
    url = body.url.strip()
    if not name:
        raise HTTPException(400, "請輸入 Webhook 名稱")
    if not url:
        raise HTTPException(400, "請輸入 Webhook URL")
    try:
        update_teams_webhook(webhook_id, name, url)
        return get_teams_webhook(webhook_id)
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.delete("/teams-webhooks/{webhook_id}")
async def delete_teams_webhook_endpoint(webhook_id: str) -> dict:
    if not get_teams_webhook(webhook_id):
        raise HTTPException(404, "找不到此 Webhook")
    try:
        delete_teams_webhook(webhook_id)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


# ── Figma Frame Monitors ──────────────────────────────────────────────────────
# User-named watch on a fixed set of frames within a Figma file. Manual trigger
# only for now (no cron) — POST .../check fetches the current state via the
# lightweight fetch_frames_by_ids (not the full-file ids=0:0 pull), diffs it
# against the last recorded check, and stores the result as new history.

class FigmaMonitorCreateRequest(BaseModel):
    custom_name:      str
    file_key:         str
    file_name:        str = ""
    frame_ids:        list[str]
    frame_names:      list[str] = []
    teams_webhook_id: str | None = None


@router.post("/figma/monitors")
async def create_figma_monitor_endpoint(request: Request, body: FigmaMonitorCreateRequest) -> dict:
    name = body.custom_name.strip()
    if not name:
        raise HTTPException(400, "請輸入監控名稱")
    if not body.frame_ids:
        raise HTTPException(400, "請至少選擇一個 Frame")
    webhook_id = (body.teams_webhook_id or "").strip() or None
    if webhook_id and not get_teams_webhook(webhook_id):
        raise HTTPException(400, "指定的 Teams Webhook 不存在")
    monitor_id = str(uuid.uuid4())
    try:
        monitor = create_figma_monitor(
            monitor_id, name, body.file_key, body.file_name,
            body.frame_ids, body.frame_names,
            teams_webhook_id=webhook_id,
        )
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")

    # Establish the baseline check right away from data already fetched during
    # the "list frames" step (figma_cache) — avoids an immediate second Figma
    # API call for frames the user just looked at seconds ago. Falls back to a
    # live fetch if the cache missed (e.g. expired), and is non-fatal either
    # way: the monitor is created regardless, it just won't have a baseline
    # yet if both paths fail (first "手動比對" click will establish one).
    snapshot = None
    cached = get_figma_cache(body.file_key)
    if cached:
        snapshot = _figma.frames_dict_from_cache(cached["frames"], body.frame_ids)
        if len(snapshot) < len(body.frame_ids):
            snapshot = None  # cache didn't have all selected frames — treat as a miss
    if not snapshot:
        try:
            snapshot = await asyncio.to_thread(
                _figma.fetch_frames_by_ids, body.file_key, body.frame_ids, _figma_token(),
            )
        except Exception:
            snapshot = None
    if snapshot:
        add_figma_monitor_check(monitor_id, snapshot, None)
        monitor = get_figma_monitor(monitor_id) or monitor

    _emit_request(request, "figma_monitor_created", properties={
        "monitor_id": monitor_id,
        "file_key": body.file_key,
        "frame_count": len(body.frame_ids or []),
        "has_teams_webhook": bool(webhook_id),
        "baseline_established": bool(snapshot),
    })
    return monitor


@router.get("/figma/monitors")
async def list_figma_monitors_endpoint(limit: int = 50) -> list:
    try:
        return list_figma_monitors(limit=limit)
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.get("/figma/monitors/{monitor_id}")
async def get_figma_monitor_endpoint(monitor_id: str) -> dict:
    monitor = get_figma_monitor(monitor_id)
    if not monitor:
        raise HTTPException(404, "找不到此監控項目")
    return monitor


class FigmaMonitorWebhookRequest(BaseModel):
    teams_webhook_id: str | None = None  # null/omitted → unlink (no webhook)


@router.put("/figma/monitors/{monitor_id}/webhook")
async def update_figma_monitor_webhook_endpoint(monitor_id: str, body: FigmaMonitorWebhookRequest) -> dict:
    if not get_figma_monitor(monitor_id):
        raise HTTPException(404, "找不到此監控項目")
    webhook_id = (body.teams_webhook_id or "").strip() or None
    if webhook_id and not get_teams_webhook(webhook_id):
        raise HTTPException(400, "指定的 Teams Webhook 不存在")
    try:
        update_figma_monitor_webhook(monitor_id, webhook_id)
        return get_figma_monitor(monitor_id)
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


class FigmaMonitorNameRequest(BaseModel):
    custom_name: str


@router.put("/figma/monitors/{monitor_id}/name")
async def update_figma_monitor_name_endpoint(monitor_id: str, body: FigmaMonitorNameRequest) -> dict:
    if not get_figma_monitor(monitor_id):
        raise HTTPException(404, "找不到此監控項目")
    name = body.custom_name.strip()
    if not name:
        raise HTTPException(400, "請輸入監控名稱")
    try:
        update_figma_monitor_name(monitor_id, name)
        return get_figma_monitor(monitor_id)
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.get("/figma/monitors/{monitor_id}/checks")
async def list_figma_monitor_checks_endpoint(monitor_id: str) -> list:
    if not get_figma_monitor(monitor_id):
        raise HTTPException(404, "找不到此監控項目")
    try:
        return list_figma_monitor_checks(monitor_id)
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.post("/figma/monitors/{monitor_id}/check")
async def check_figma_monitor_endpoint(request: Request, monitor_id: str) -> dict:
    """Manual trigger: fetch current frame state, diff vs the last check,
    record it as new history. First-ever check just establishes the baseline
    (no diff to show yet)."""
    monitor = get_figma_monitor(monitor_id)
    if not monitor:
        raise HTTPException(404, "找不到此監控項目")

    try:
        new_snapshot = await asyncio.to_thread(
            _figma.fetch_frames_by_ids, monitor["file_key"], monitor["frame_ids"], _figma_token(),
        )
    except Exception as e:
        raise _figma_exception_to_http(e, file_key=monitor["file_key"])

    prev = get_latest_figma_monitor_check(monitor_id)
    is_first_check = prev is None
    diff = None if is_first_check else _figma.diff_frame_snapshots(prev["snapshot"], new_snapshot)

    check = add_figma_monitor_check(monitor_id, new_snapshot, diff)
    # A design change detected here is the upstream signal for "why did this
    # spec need re-work?" — recorded as app output, not just a click.
    _emit_request(request, "figma_monitor_checked", event_type="app_output", properties={
        "monitor_id": monitor_id,
        "file_key": monitor["file_key"],
        "frame_count": len(monitor.get("frame_ids") or []),
        "is_first_check": is_first_check,
        "changed": bool(diff and (diff.get("added") or diff.get("removed") or diff.get("modified"))),
        "added_count": len((diff or {}).get("added") or []),
        "removed_count": len((diff or {}).get("removed") or []),
        "modified_count": len((diff or {}).get("modified") or []),
    })
    return {
        "checked_at":     check["checked_at"],
        "is_first_check": is_first_check,
        "diff":           diff,
    }


@router.post("/figma/monitors/check-all")
async def check_all_figma_monitors_endpoint() -> list:
    """Batch manual trigger: group every monitor by file_key, fetch each
    file's union of frame_ids in ONE Figma API call (fetch_frames_by_ids
    already accepts an arbitrary comma-separated id list — deduped here so a
    frame two monitors both watch isn't fetched twice), then diff each
    monitor against its own history using its slice of that combined result.

    Cuts N Figma API calls (one per monitor, the /check endpoint's behavior)
    down to one call per DISTINCT file — the actual lever on Figma's
    per-request Tier 1 rate limit, since it's counted by request, not by
    response size (https://developers.figma.com/docs/rest-api/rate-limits/).

    One file's fetch failing (e.g. that specific 429) doesn't block others —
    each file_key group is isolated so a rate-limited file just reports an
    error for its monitors while the rest still get checked.
    """
    monitors = list_figma_monitors(limit=1000)
    if not monitors:
        return []

    by_file: dict[str, list[str]] = {}
    for m in monitors:
        by_file.setdefault(m["file_key"], []).append(m["id"])

    results: list[dict] = []
    for file_key, monitor_ids in by_file.items():
        details = {mid: get_figma_monitor(mid) for mid in monitor_ids}
        union_ids: list[str] = []
        seen: set[str] = set()
        for mid in monitor_ids:
            for fid in details[mid]["frame_ids"]:
                if fid not in seen:
                    seen.add(fid)
                    union_ids.append(fid)

        try:
            combined = await asyncio.to_thread(
                _figma.fetch_frames_by_ids, file_key, union_ids, _figma_token(),
            )
        except Exception as e:
            retry_after = getattr(e, "retry_after_seconds", None)
            for mid in monitor_ids:
                results.append({
                    "monitor_id":         mid,
                    "error":              f"Figma API 錯誤: {e}",
                    "retry_after_seconds": retry_after,
                })
            continue

        for mid in monitor_ids:
            monitor = details[mid]
            snapshot = {fid: combined[fid] for fid in monitor["frame_ids"] if fid in combined}
            prev = get_latest_figma_monitor_check(mid)
            is_first_check = prev is None
            diff = None if is_first_check else _figma.diff_frame_snapshots(prev["snapshot"], snapshot)
            check = add_figma_monitor_check(mid, snapshot, diff)
            results.append({
                "monitor_id":     mid,
                "checked_at":     check["checked_at"],
                "is_first_check": is_first_check,
                "diff":           diff,
            })

    return results


@router.post("/figma/monitors/{monitor_id}/notify")
async def notify_figma_monitor_endpoint(monitor_id: str) -> dict:
    """Manual trigger: post the most recent check's diff to this monitor's
    Teams webhook. Independent of /check — lets the user re-send or send on
    their own schedule rather than every check auto-posting."""
    monitor = get_figma_monitor(monitor_id)
    if not monitor:
        raise HTTPException(404, "找不到此監控項目")
    webhook_url = monitor.get("webhook_url")
    if not webhook_url:
        raise HTTPException(400, "此監控尚未選擇 Teams Webhook")

    latest = get_latest_figma_monitor_check(monitor_id)
    if not latest:
        raise HTTPException(400, "尚未執行過任何比對，請先手動比對")

    diff = latest["diff"] if latest["diff"] is not None else {"added": [], "removed": [], "modified": []}
    card = _figma.build_teams_card(monitor["custom_name"], monitor["file_name"], monitor["file_key"], diff, latest["checked_at"])

    try:
        resp = await asyncio.to_thread(
            httpx.post, webhook_url, json=card, timeout=15.0,
        )
        resp.raise_for_status()
    except Exception as e:
        raise HTTPException(502, f"發送到 Teams 失敗：{e}")

    return {"ok": True, "sent_at": latest["checked_at"]}


@router.delete("/figma/monitors/{monitor_id}")
async def delete_figma_monitor_endpoint(monitor_id: str) -> dict:
    if not get_figma_monitor(monitor_id):
        raise HTTPException(404, "找不到此監控項目")
    try:
        delete_figma_monitor(monitor_id)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


# ── Figma (Frame 分析) ────────────────────────────────────────────────────────

class FigmaListRequest(BaseModel):
    figma_url: str
    force_refresh: bool = False

class FigmaParseRequest(BaseModel):
    figma_url: str
    frame_ids: list[str] | None = None

def _figma_url_context(figma_url: str) -> str:
    """Resolve a Figma URL to its file_key for logging; falls back to the raw
    URL if extraction itself fails (e.g. malformed URL)."""
    try:
        return _figma.extract_file_key(figma_url)
    except Exception:
        return figma_url

def _log_figma_failure(endpoint: str, figma_url: str, file_key: str, elapsed: float, e: Exception) -> None:
    """Full server-side dump of a Figma-fetch failure — everything needed to
    debug it without having to reproduce it blind."""
    lines = [
        f"[figma] {endpoint} failed after {elapsed:.1f}s",
        f"  url={figma_url} file_key={file_key}",
        f"  exception={type(e).__name__}: {e}",
    ]
    if isinstance(e, httpx.HTTPStatusError):
        resp = e.response
        lines.append(f"  upstream_status={resp.status_code}")
        lines.append(f"  upstream_headers={dict(resp.headers)}")
        lines.append(f"  upstream_body={resp.text[:500]!r}")
    print("\n".join(lines))

def _figma_exception_to_http(e: Exception, file_key: str | None = None) -> HTTPException:
    """Classify a Figma-fetch failure into the status code that matches it,
    instead of collapsing auth/rate-limit/timeout/network errors into a
    generic 502."""
    tag = f" (file_key={file_key})" if file_key else ""
    if isinstance(e, ValueError):
        return HTTPException(400, str(e))
    if isinstance(e, _figma.FigmaRateLimitError):
        headers = {"Retry-After": str(e.retry_after_seconds)} if e.retry_after_seconds is not None else None
        return HTTPException(429, f"{e}{tag}", headers=headers)
    if isinstance(e, RuntimeError):
        # figma.py raises RuntimeError specifically for "no token connected"
        return HTTPException(401, str(e))
    if isinstance(e, httpx.HTTPStatusError):
        status = e.response.status_code
        if status == 429:
            retry_after = e.response.headers.get("Retry-After")
            detail = f"Figma API 已達速率限制，請稍後再試{tag}"
            headers = None
            if retry_after:
                detail += f"（約 {retry_after} 秒後）"
                headers = {"Retry-After": retry_after}
            return HTTPException(429, detail, headers=headers)
        if status in (401, 403):
            return HTTPException(status, f"Figma 授權失敗（{status}），請重新連接 Figma 帳號{tag}")
        return HTTPException(502, f"Figma API 錯誤{tag}: {e}")
    if isinstance(e, httpx.TimeoutException):
        return HTTPException(504, f"連線 Figma 逾時（30 秒）{tag}，請稍後再試")
    return HTTPException(502, f"Figma API 錯誤{tag}: {e}")

@router.post("/figma/raw")
async def figma_raw(body: FigmaListRequest):
    """Debug: 回傳 Figma API 的原始解析結果（不生成 spec）"""
    start = time.time()
    try:
        return _figma.fetch_and_parse(body.figma_url, access_token=_figma_token())
    except Exception as e:
        file_key = _figma_url_context(body.figma_url)
        _log_figma_failure("raw", body.figma_url, file_key, time.time() - start, e)
        raise _figma_exception_to_http(e, file_key=file_key)

@router.post("/figma/list-frames")
async def figma_list_frames(request: Request, body: FigmaListRequest):
    start = time.time()
    try:
        parsed = _figma.fetch_and_parse(
            body.figma_url,
            access_token=_figma_token(),
            force_refresh=body.force_refresh,
        )
    except Exception as e:
        file_key = _figma_url_context(body.figma_url)
        _log_figma_failure("list-frames", body.figma_url, file_key, time.time() - start, e)
        raise _figma_exception_to_http(e, file_key=file_key)

    if not parsed["frames"]:
        _emit_request(request, "figma_file_loaded", properties={
            "file_key": parsed.get("file_key", ""), "frame_count": 0, "empty": True,
        })
        raise HTTPException(422, "此 Figma 檔案沒有找到任何 Frame，請確認分享連結正確且含有設計內容。")

    # Fetch comments on first load (synchronous, paid once per file_key).
    # Subsequent calls read from DB — no Figma API call.
    file_key = parsed["file_key"]
    cached_comments = get_figma_comments(file_key)
    if cached_comments is None:
        token = _figma_token()
        try:
            cached_comments = await asyncio.to_thread(_figma.fetch_comments, file_key, token)
            save_figma_comments(file_key, cached_comments)
        except Exception:
            cached_comments = None  # non-critical; pipeline still works without comments
    _emit_request(request, "figma_file_loaded",
                  duration_ms=int((time.time() - start) * 1000),
                  properties={
                      "file_key": file_key,
                      "frame_count": len(parsed["frames"]),
                      "force_refresh": body.force_refresh,
                      "comment_count": len(cached_comments) if cached_comments is not None else None,
                  })
    return {
        "file_name": parsed["file_name"],
        "file_key": file_key,
        "cached_at": parsed.get("cached_at"),
        "comments_cached": cached_comments is not None,
        "comments_count": len(cached_comments) if cached_comments is not None else None,
        "frames": [
            {
                "page": f["page"],
                "frame_id": f["frame_id"],
                "frame_name": f["frame_name"],
                "text_count": len(f["texts"]),
            }
            for f in parsed["frames"]
        ],
    }

class FigmaCommentsRefreshRequest(BaseModel):
    file_key: str

@router.post("/figma/comments/refresh")
async def figma_comments_refresh(body: FigmaCommentsRefreshRequest):
    """Force re-fetch Figma comments from API and update DB cache."""
    token = _figma_token()
    start = time.time()
    try:
        comments = await asyncio.to_thread(_figma.fetch_comments, body.file_key, token)
        cached_at = save_figma_comments(body.file_key, comments)
    except Exception as e:
        _log_figma_failure("comments/refresh", body.file_key, body.file_key, time.time() - start, e)
        raise _figma_exception_to_http(e, file_key=body.file_key)
    return {"file_key": body.file_key, "count": len(comments), "cached_at": cached_at}


@router.post("/figma/parse")
async def figma_parse(body: FigmaParseRequest):
    start = time.time()
    try:
        parsed = _figma.fetch_and_parse(body.figma_url, access_token=_figma_token())
    except Exception as e:
        file_key = _figma_url_context(body.figma_url)
        _log_figma_failure("parse", body.figma_url, file_key, time.time() - start, e)
        raise _figma_exception_to_http(e, file_key=file_key)

    frames = parsed["frames"]
    if body.frame_ids:
        frames = [f for f in frames if f["frame_id"] in body.frame_ids]

    if not frames:
        raise HTTPException(422, "沒有找到符合的 Frame，請重新選擇。")

    def _llm(prompt: str) -> str:
        from llm_client import call_tool
        cfg = get_settings()
        model = cfg.llm_prd or cfg.default_model
        # Routed through the shared LLM client (same dispatch _run_iteration and
        # figma_generate_one use) so it follows LLM_PRD's actual provider —
        # previously hardcoded a direct Azure Anthropic URL that 404s now that
        # LLM_PRD points at a databricks: model. _STORY_TOOL is figma_story_graph's
        # existing single-field {"content": str} schema for plain-text generation.
        result = call_tool(prompt, _fsg._STORY_TOOL, model=model)
        return result.get("content", "")

    specs = []
    for frame in frames:
        try:
            spec_text = _figma.generate_spec(frame, _llm)
        except Exception as e:
            spec_text = f"（Spec 生成失敗：{e}）"
        specs.append({
            "page": frame["page"],
            "frame_name": frame["frame_name"],
            "spec": spec_text,
        })

    return {
        "file_name": parsed["file_name"],
        "file_key": parsed["file_key"],
        "frames": specs,
    }


# ── Figma Story (legacy v1) ────────────────────────────────────────────────────

class FigmaStoryQuestionRequest(BaseModel):
    file_key: str
    frame_ids: list[str]
    user_description: str = ""
    history: list[dict] = Field(default_factory=list)  # [{question, answer}, ...]

class FigmaStoryStreamRequest(BaseModel):
    file_key: str
    frame_ids: list[str]
    roles: list[str]
    user_description: str = ""
    history: list[dict] = Field(default_factory=list)  # 所有輪次的問答
    final_supplement: str = ""

class FigmaStoryEditRequest(BaseModel):
    story_text: str


@router.post("/figma/story/question")
async def figma_story_question(body: FigmaStoryQuestionRequest):
    """AI 追問（多輪）：根據 Frame、使用者說明、歷史問答，生成 2-3 個追問。最多 3 輪。"""
    if len(body.history) >= 3:
        raise HTTPException(400, "已達追問上限（3 輪），請直接進行生成。")
    try:
        all_frames = _get_cached_frames(body.file_key)
        frames = _figma_story.collect_frames(all_frames, body.frame_ids)
        if not frames:
            raise HTTPException(422, "找不到選取的 Frame，請重新選擇。")
        questions = _figma_story.generate_questions(
            frames=frames,
            user_description=body.user_description,
            history=body.history,
        )
        return {"questions": questions, "round": len(body.history) + 1}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"AI 追問失敗：{e}")


@router.post("/figma/story/stream")
async def figma_story_stream(body: FigmaStoryStreamRequest):
    """Story 生成 SSE：逐角色生成，每完成一個立即推送，同時存入 DB。"""
    invalid = [r for r in body.roles if r not in _figma_story.VALID_ROLES]
    if invalid:
        raise HTTPException(400, f"不支援的角色：{invalid}，可選：PM, FE, BE, QA")

    all_frames = _get_cached_frames(body.file_key)
    frames = _figma_story.collect_frames(all_frames, body.frame_ids)
    if not frames:
        raise HTTPException(422, "找不到選取的 Frame，請重新選擇。")

    cache_key = _figma_story.story_cache_key(body.file_key, body.frame_ids)

    async def event_generator():
        yield {"event": "progress", "data": json.dumps({"step": "start", "roles": body.roles}, ensure_ascii=False)}
        for role in body.roles:
            yield {"event": "progress", "data": json.dumps({"step": "generating", "role": role}, ensure_ascii=False)}
            try:
                story_text = await asyncio.to_thread(
                    _figma_story.generate_story_for_role,
                    frames,
                    role,
                    body.user_description,
                    body.history,
                    body.final_supplement,
                )
                save_figma_story(cache_key, role, story_text)
                yield {
                    "event": "story",
                    "data": json.dumps({"role": role, "text": story_text}, ensure_ascii=False),
                }
            except Exception as e:
                yield {
                    "event": "error",
                    "data": json.dumps({"role": role, "message": str(e)}, ensure_ascii=False),
                }
        yield {"event": "done", "data": json.dumps({"cache_key": cache_key}, ensure_ascii=False)}

    # sep="\n": see comment on the other EventSourceResponse call sites —
    # CRLF doesn't survive the browser -> ngrok -> Next.js path intact in dev.
    return EventSourceResponse(event_generator(), sep="\n")


@router.get("/figma/story/cache")
async def figma_story_cache(file_key: str, frame_ids: str):
    """查詢已快取的 Story。frame_ids 為逗號分隔的 frame ID 字串。"""
    ids = [i.strip() for i in frame_ids.split(",") if i.strip()]
    if not ids:
        raise HTTPException(400, "frame_ids 不能為空")
    cache_key = _figma_story.story_cache_key(file_key, ids)
    stories = get_figma_stories(cache_key)
    return {"cache_key": cache_key, "stories": stories}


@router.put("/figma/story/{cache_key}/{role}")
async def figma_story_edit(cache_key: str, role: str, body: FigmaStoryEditRequest):
    """使用者編輯 Story 後覆蓋 DB。"""
    if role not in _figma_story.VALID_ROLES:
        raise HTTPException(400, f"不支援的角色：{role}")
    if not body.story_text.strip():
        raise HTTPException(400, "story_text 不能為空")
    save_figma_story(cache_key, role, body.story_text)
    return {"ok": True, "cache_key": cache_key, "role": role}


# ── Figma Story (v2, feature-level) ──────────────────────────────────────────

class FigmaStoryBatchSaveItem(BaseModel):
    feature_id: str
    role: str
    text: str


class FigmaStoryBatchSaveRequest(BaseModel):
    cache_key: str
    stories: list[FigmaStoryBatchSaveItem]


class FigmaFeatureMeta(BaseModel):
    id: str
    name: str = ""
    description: str = ""


class FigmaSaveVersionRequest(BaseModel):
    """進版 — snapshot the current edited story set as a new version."""
    cache_key:        str
    file_key:         str = ""
    file_name:        str = ""
    frame_ids:        list[str] = []
    frame_names:      list[str] = []
    roles:            list[str] = []
    user_description: str = ""
    label:            str = ""
    features:         list[FigmaFeatureMeta] = []
    stories:          list[FigmaStoryBatchSaveItem] = []


class FigmaUpdateVersionRequest(BaseModel):
    """不進版 — overwrite an existing version in place (edit)."""
    features: Optional[list[FigmaFeatureMeta]] = None
    label:    Optional[str] = None
    stories:  list[FigmaStoryBatchSaveItem] = []


class FigmaGenerateOneRequest(BaseModel):
    """Generate ONE (feature, role) story on demand — used for PM-first sequential flow."""
    file_key:   str
    frame_ids:  list[str] = []
    feature:    FigmaFeatureMeta
    role:       str
    pm_context: str = ""    # the edited PM story for this feature (drives FE/BE/QA alignment)
    supplement: str = ""


def _stories_items_to_nested(items: list[FigmaStoryBatchSaveItem]) -> dict:
    nested: dict = {}
    for it in items:
        if it.feature_id and it.role:
            nested.setdefault(it.feature_id, {})[it.role] = it.text
    return nested


@router.post("/figma/stories/save")
async def figma_stories_batch_save(body: FigmaStoryBatchSaveRequest):
    """批次儲存所有 Story（包含使用者編輯後的版本）。"""
    if not body.cache_key:
        raise HTTPException(400, "cache_key 不能為空")
    count = 0
    for item in body.stories:
        if item.feature_id and item.role and item.text.strip():
            save_figma_story_v2(body.cache_key, item.feature_id, item.role, item.text)
            count += 1
    return {"ok": True, "saved": count}


@router.post("/figma/stories/generate-one")
async def figma_generate_one(body: FigmaGenerateOneRequest) -> dict:
    """Generate a single (feature, role) story on demand. FE/BE/QA receive the
    edited PM story as context so downstream tasks align with the finalized spec."""
    if body.role not in _fsg._ROLE_INSTRUCTIONS:
        raise HTTPException(400, f"不支援的角色：{body.role}")
    frames = _get_cached_frames(body.file_key)   # raises 422 if cache missing
    ids    = set(body.frame_ids)
    sel    = [f for f in frames if f.get("frame_id") in ids] if ids else frames
    figma_texts = _fsg._extract_texts(sel)
    figma_nodes = _fsg._extract_nodes(sel)
    # Downstream roles (FE/BE/QA) are mechanical task-lists with the PM spec as
    # context → use a FASTER model than Opus. Opus on a large figma_nodes prompt
    # is slow and times out; gpt/Kimi generate the task list far quicker.
    cfg   = get_settings()
    model = (cfg.llm_prd if body.role == "PM"
             else (cfg.llm_analyze or cfg.llm_edges or cfg.llm_iterate or cfg.default_model))
    comments = get_figma_comments(body.file_key) or []
    text = await asyncio.to_thread(
        _fsg.generate_one_story,
        body.feature.model_dump(), body.role,
        figma_texts, figma_nodes, [], body.supplement, body.pm_context,
        model,
        comments, sel,
    )
    return {"feature_id": body.feature.id, "role": body.role, "text": text}


# ── Figma Story History (sessions → versions; mirrors /api/history*) ─────────

@router.get("/figma/history")
async def figma_history_list(limit: int = 50) -> list:
    """Recent figma story sessions for the unified history sidebar."""
    try:
        return list_figma_story_sessions(limit=limit)
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.get("/figma/history/by-file/{file_key}")
async def figma_history_by_file(file_key: str) -> list:
    """All story sessions for a file_key (with frame_ids) — lets the frame picker
    flag already-generated frames and detect an exact-set match."""
    try:
        return list_figma_story_sessions_by_file(file_key)
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.get("/figma/history/{session_id}/versions")
async def figma_history_versions(session_id: str) -> list:
    """All versions for a historical figma story session."""
    try:
        rows = get_figma_story_versions(session_id)
        if not rows:
            raise HTTPException(404, "Figma story session not found in history")
        return rows
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.get("/figma/history/{session_id}/versions/{version_num}")
async def figma_history_version(session_id: str, version_num: int) -> dict:
    """Full snapshot (features + stories + session meta) for one version."""
    try:
        result = get_figma_story_version(session_id, version_num)
        if result is None:
            raise HTTPException(404, "Version not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.post("/figma/history/{session_id}/save-version")
async def figma_history_save_version(session_id: str, body: FigmaSaveVersionRequest) -> dict:
    """進版 — snapshot the current edited story set as a NEW version, and update
    the figma_story_v2 latest pointer."""
    if not session_id:
        raise HTTPException(400, "session_id 不能為空")
    try:
        save_figma_story_session(
            session_id      = session_id,
            file_key        = body.file_key,
            file_name       = body.file_name,
            frame_ids       = body.frame_ids,
            frame_names     = body.frame_names,
            roles           = body.roles,
            user_description= body.user_description,
        )
        version_num = next_figma_version_num(session_id)
        features    = [f.model_dump() for f in body.features]
        nested      = _stories_items_to_nested(body.stories)
        save_figma_story_version(session_id, version_num, features, nested, label=body.label)
        # Update the latest working pointer so a re-run hits this exact set.
        for it in body.stories:
            if it.feature_id and it.role and it.text.strip():
                save_figma_story_v2(session_id, it.feature_id, it.role, it.text)
        return {"ok": True, "version_num": version_num}
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.put("/figma/history/{session_id}/versions/{version_num}")
async def figma_history_update_version(
    session_id: str, version_num: int, body: FigmaUpdateVersionRequest
) -> dict:
    """不進版 — overwrite an existing version in place (edit), and refresh the
    figma_story_v2 latest pointer."""
    try:
        features = [f.model_dump() for f in body.features] if body.features is not None else None
        nested   = _stories_items_to_nested(body.stories)
        ok = update_figma_story_version(session_id, version_num, features, nested, label=body.label)
        if not ok:
            raise HTTPException(404, "Version not found")
        for it in body.stories:
            if it.feature_id and it.role and it.text.strip():
                save_figma_story_v2(session_id, it.feature_id, it.role, it.text)
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.delete("/figma/history/{session_id}")
async def figma_history_delete(session_id: str) -> dict:
    """Delete a figma story session and all its versions."""
    try:
        delete_figma_story_session(session_id)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


# ── Figma Pipeline v2 (LangGraph Human-in-the-loop) ──────────────────────────

async def _stream_figma_pipeline(session: Session, input_val: Any, config: dict) -> None:
    """Bind this session's telemetry context, then stream the pipeline."""
    with telemetry.bind_context(app_session_id=session.id, user_email=session.user_email,
                                user_id=session.user_id, workflow="figma"):
        await _stream_figma_pipeline_inner(session, input_val, config)


async def _stream_figma_pipeline_inner(session: Session, input_val: Any, config: dict) -> None:
    """Stream FIGMA_PIPELINE events → session.queue. Mirrors _stream_pipeline."""
    is_interrupt = False
    _node_started_at: dict[str, float] = {}
    try:
        async for event in _fsg.FIGMA_PIPELINE.astream_events(input_val, config=config, version="v2"):
            etype = event.get("event", "")
            name  = event.get("name", "")

            if etype == "on_chain_start" and name == "story_node":
                data_input = event.get("data", {}).get("input", {}) or {}
                cf = data_input.get("current_feature") or {}
                cr = data_input.get("current_role") or ""
                _node_started_at[f"{name}:{cf.get('id', '')}:{cr}"] = time.time()
                _emit(session, "figma_pipeline_step_started", properties={
                    "node": name, "feature_id": cf.get("id", ""), "role": cr,
                })
                await session.queue.put({
                    "type":       "step_start",
                    "node":       name,
                    "feature_id": cf.get("id", ""),
                    "role":       cr,
                })
            elif etype == "on_chain_start" and name in (
                "cache_check", "parse_frames",
                "gen_questions", "wait_answers", "gen_feature_list", "wait_features", "save_cache"
            ):
                _node_started_at[name] = time.time()
                _emit(session, "figma_pipeline_step_started", properties={"node": name})
                await session.queue.put({"type": "step_start", "node": name})

            elif etype == "on_chain_end" and name in (
                "cache_check", "parse_frames", "gen_questions", "gen_feature_list", "save_cache"
            ):
                _started = _node_started_at.pop(name, None)
                _emit(session, "figma_pipeline_step_completed",
                      duration_ms=int((time.time() - _started) * 1000) if _started else None,
                      properties={"node": name})
                await session.queue.put({"type": "step_end", "node": name})

            elif etype == "on_chain_end" and name == "story_node":
                output  = event.get("data", {}).get("output", {}) or {}
                stories = output.get("stories", {})
                for fid, roles in stories.items():
                    for role, text in roles.items():
                        if text:
                            _started = _node_started_at.pop(f"{name}:{fid}:{role}", None)
                            # Success criterion #2 — a story is app output, not just usage.
                            _emit(session, "figma_story_generated", event_type="app_output",
                                  duration_ms=int((time.time() - _started) * 1000) if _started else None,
                                  properties={
                                      "feature_id": fid, "role": role,
                                      "story_chars": len(text),
                                  })
                            await session.queue.put({
                                "type":       "story",
                                "feature_id": fid,
                                "role":       role,
                                "text":       text,
                            })

        # ── After stream: check for interrupt or completion ────────────────
        graph_state = _fsg.FIGMA_PIPELINE.get_state(config)

        interrupt_value = None
        for task in (graph_state.tasks or []):
            ivs = getattr(task, "interrupts", None) or []
            if ivs:
                interrupt_value = ivs[0].value
                break

        if interrupt_value:
            itype = interrupt_value.get("type", "unknown")
            session.status         = "interrupted"
            session.interrupt_type = itype
            session.interrupt_data = interrupt_value
            is_interrupt = True
            _emit(session, "figma_pipeline_interrupted", properties={
                "interrupt_type": itype,
                "question_count": len(interrupt_value.get("questions") or []),
                "feature_count": len(interrupt_value.get("features") or []),
            })
            await session.queue.put({
                "type":           "interrupt",
                "interrupt_type": itype,
                "data":           interrupt_value,
            })
        elif graph_state.next:
            # Unexpected pause (no recognized interrupt). Use the event type the
            # frontend actually listens for ("pipeline_error", not "error" — a
            # raw "error" event is delivered to EventSource.onerror, which drops
            # the message and shows a generic "連線中斷"). Also record the error.
            session.status = "error"
            session.error  = f"Pipeline paused unexpectedly at: {graph_state.next}"
            await session.queue.put({
                "type":    "pipeline_error",
                "message": session.error,
            })
        else:
            final_state = graph_state.values
            # A node may have short-circuited to END with an error in state
            # (e.g. parse_frames couldn't find the Figma frame cache). Surface
            # that friendly message instead of emitting a misleading "complete".
            if final_state.get("error"):
                session.status = "error"
                session.error  = final_state["error"]
                await session.queue.put({"type": "pipeline_error", "message": final_state["error"]})
            else:
                session.status = "complete"
                session.result = {
                    "stories":           final_state.get("stories", {}),
                    "story_status":      final_state.get("story_status", {}),
                    "confirmed_features": final_state.get("confirmed_features", []),
                    "cache_key":         final_state.get("cache_key", ""),
                }
                _emit(session, "figma_pipeline_completed",
                      duration_ms=int((time.time() - session.created_at) * 1000),
                      properties={
                          "cache_key": final_state.get("cache_key", ""),
                          "feature_count": len(final_state.get("confirmed_features") or []),
                          "story_count": sum(
                              1 for roles in (final_state.get("stories") or {}).values()
                              for text in roles.values() if text
                          ),
                      })
                await session.queue.put({"type": "complete", "result": session.result})

    except Exception as exc:
        session.status = "error"
        session.error  = str(exc)
        _emit(session, "figma_pipeline_failed", properties={
            "error_type": type(exc).__name__, "error": str(exc)[:200],
        })
        await session.queue.put({"type": "pipeline_error", "message": str(exc)})
    finally:
        if not is_interrupt:
            await session.queue.put({"type": "__done__"})


class FigmaPipelineStartRequest(BaseModel):
    file_key:         str
    frame_ids:        list[str]
    user_description: str = ""
    roles:            list[str] = ["PM", "FE", "BE", "QA"]
    force_regenerate: bool = False   # skip the story cache → truly re-run generation


class FigmaPipelineAnswerRequest(BaseModel):
    answers: dict           # {question_key: answer_text}
    proceed: bool = False   # True → skip remaining question rounds


class FigmaPipelineConfirmRequest(BaseModel):
    confirmed_ids: list[str]    # feature IDs the user kept
    supplement:    str = ""     # optional extra instructions


@router.post("/figma/pipeline/start")
async def figma_pipeline_start(
    request: Request,
    body: FigmaPipelineStartRequest,
    background_tasks: BackgroundTasks,
) -> dict:
    """Create a figma-pipeline session and start the LangGraph flow."""
    thread_id = str(uuid.uuid4())
    session   = Session(thread_id)
    session.status = "running"
    # Bind the acting user now, while the request headers still exist — the
    # pipeline runs as a background task and every later event is attributed
    # from here.
    _ident = telemetry.identity_from(request)
    session.user_email = _ident.get("user_email")
    session.user_id = _ident.get("user_id")
    FIGMA_SESSIONS[thread_id] = session
    _emit(session, "figma_pipeline_started", properties={
        "file_key": body.file_key,
        "frame_count": len(body.frame_ids or []),
        "roles": body.roles,
        "force_regenerate": body.force_regenerate,
        "description_chars": len(body.user_description or ""),
    })

    initial_state = {
        "file_key":         body.file_key,
        "frame_ids":        body.frame_ids,
        "user_description": body.user_description,
        "roles":            body.roles,
        "force_regenerate": body.force_regenerate,
    }
    config = {"configurable": {"thread_id": thread_id}}

    background_tasks.add_task(_stream_figma_pipeline, session, initial_state, config)
    return {"thread_id": thread_id, "stream_url": f"/api/figma/pipeline/{thread_id}/stream"}


@router.get("/figma/pipeline/{thread_id}/stream")
async def figma_pipeline_stream(thread_id: str):
    """SSE: forward all pipeline events to the client."""
    session = FIGMA_SESSIONS.get(thread_id)
    if not session:
        raise HTTPException(404, "Figma pipeline session not found")

    async def event_generator():
        while True:
            try:
                item = await asyncio.wait_for(session.queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                yield {"event": "ping", "data": ""}
                continue
            if item.get("type") == "__done__":
                break
            yield {"event": item.get("type", "event"), "data": json.dumps(item, ensure_ascii=False)}

    # sse_starlette's built-in auto-ping (default: every 15s) runs as a second
    # concurrent task whose send() isn't guarded by the same lock as the main
    # loop's send() (see sse_starlette/sse.py — stream_response() vs _ping(),
    # a hazard the library itself documents via sysid/sse-starlette#55).
    # event_generator() above already emits its own ping on a 30s idle
    # timeout, so disable the redundant one by pushing its interval far
    # beyond any real session's lifetime.
    # sep="\n": CRLF (the sse_starlette default) doesn't survive the
    # browser -> ngrok -> Next.js path intact in dev — some tunnels mishandle
    # bare \r during HTTP version translation, dropping the blank line that
    # separates SSE events. Plain \n is still spec-valid and tunnel-safe.
    return EventSourceResponse(event_generator(), ping=24 * 60 * 60, sep="\n")


@router.post("/figma/pipeline/{thread_id}/answer")
async def figma_pipeline_answer(
    thread_id: str,
    body: FigmaPipelineAnswerRequest,
    background_tasks: BackgroundTasks,
) -> dict:
    """Resume after a figma_questions interrupt with user answers."""
    session = FIGMA_SESSIONS.get(thread_id)
    if not session:
        raise HTTPException(404, "Figma pipeline session not found")
    if session.interrupt_type != "figma_questions":
        raise HTTPException(409, f"Session is not waiting for answers (state: {session.status}, interrupt: {session.interrupt_type})")

    session.status = "running"
    _emit(session, "figma_questions_answered", properties={
        "answer_count": len(body.answers or {}),
        "proceed": body.proceed,
    })
    resume_value   = {"answers": body.answers, "proceed": body.proceed}
    config         = {"configurable": {"thread_id": thread_id}}
    background_tasks.add_task(_stream_figma_pipeline, session, Command(resume=resume_value), config)
    return {"ok": True}


@router.post("/figma/pipeline/{thread_id}/confirm")
async def figma_pipeline_confirm(
    thread_id: str,
    body: FigmaPipelineConfirmRequest,
    background_tasks: BackgroundTasks,
) -> dict:
    """Resume after a figma_features interrupt with confirmed feature list."""
    session = FIGMA_SESSIONS.get(thread_id)
    if not session:
        raise HTTPException(404, "Figma pipeline session not found")
    if session.interrupt_type != "figma_features":
        raise HTTPException(409, f"Session is not waiting for feature confirmation (state: {session.status}, interrupt: {session.interrupt_type})")

    session.status = "running"
    _emit(session, "figma_features_confirmed", properties={
        "confirmed_count": len(body.confirmed_ids or []),
        "supplement_chars": len(body.supplement or ""),
    })
    resume_value   = {"confirmed_ids": body.confirmed_ids, "supplement": body.supplement}
    config         = {"configurable": {"thread_id": thread_id}}
    background_tasks.add_task(_stream_figma_pipeline, session, Command(resume=resume_value), config)
    return {"ok": True}


# ── Admin (this service's own health/switch-mode/cost-report — folded in
#    from the old routers/admin.py now that this runs as its own process) ────

# ── App telemetry ─────────────────────────────────────────────────────────────

class TelemetryEvent(BaseModel):
    """One semantic interaction. Mirrors the payload track.ts sends."""
    event_name: str
    event_time: Optional[str] = None
    page: Optional[str] = None
    session_id: Optional[str] = None        # browser session (sessionStorage)
    app_session_id: Optional[str] = None    # pipeline session — the join key
    workflow: Optional[str] = None
    properties: dict = {}


class TelemetryBatch(BaseModel):
    events: list[TelemetryEvent] = []


@router.post("/events")
async def receive_events(batch: TelemetryBatch, request: Request) -> dict:
    """Accept interaction events and write them to the governed telemetry stream.

    Twin of the text-spec service's endpoint — see that one for why the frontend
    app owns the authoritative /api/events and this exists alongside it.
    """
    ident = telemetry.resolve_identity(request)
    for event in batch.events[:100]:   # bound one request
        telemetry.track(
            event.event_name,
            event_type="ui_interaction",
            event_time=event.event_time,
            page=event.page,
            workflow=event.workflow or "figma",
            session_id=event.session_id,
            app_session_id=event.app_session_id,
            user_email=ident.get("user_email"),
            user_id=ident.get("user_id"),
            request_id=ident.get("request_id"),
            properties=event.properties or {},
        )
    return {"accepted": True, "count": len(batch.events[:100])}


@router.get("/health")
@router.get("/figma/health")
async def health():
    s = get_settings()
    default = s.ollama_model if s.use_ollama else (s.default_model or s.claude_model)
    return {
        "status": "ok",
        "service": "figma",
        "model": default,
        "use_ollama": s.use_ollama,
        "api_key_set": bool(s.api_key or s.anthropic_api_key or os.environ.get("API_KEY")),
        "api_key_hint": ("*****" + (s.api_key or s.anthropic_api_key or os.environ.get("API_KEY", ""))[-4:]) if len(s.api_key or s.anthropic_api_key or os.environ.get("API_KEY", "")) > 4 else "(not set)",
        "active_pipeline_sessions": len(FIGMA_SESSIONS),
        "db_path": str(_db.DB_PATH),
        "volume_sync": _db.sync_diag,
        "telemetry": telemetry.diagnostics(),
    }


@router.get("/cost-report")
async def cost_report() -> dict:
    """Per-step / per-model token totals + estimated cost from real usage.
    Call POST /api/cost-report/reset first, run ONE full pipeline, then read this."""
    from llm_client import get_usage_records
    from cost import compute_report
    return compute_report(get_usage_records())


@router.post("/cost-report/reset")
async def cost_report_reset() -> dict:
    """Clear the token-usage accumulator so the next run is measured cleanly."""
    from llm_client import reset_usage
    reset_usage()
    return {"reset": True}


@router.post("/switch-mode")
@router.post("/figma/switch-mode")
async def switch_mode(body: dict) -> dict:
    """Hot-switch between 'ollama' (local) and 'api' (Azure) without restart."""
    mode = body.get("mode", "")
    if mode not in ("ollama", "api"):
        raise HTTPException(400, "mode must be 'ollama' or 'api'")

    os.environ["USE_OLLAMA"] = "true" if mode == "ollama" else "false"
    get_settings.cache_clear()   # force re-read from env

    s = get_settings()
    return {
        "ok": True,
        "mode": mode,
        "use_ollama": s.use_ollama,
        "active_model": s.ollama_model if s.use_ollama else (s.default_model or s.claude_model),
    }
