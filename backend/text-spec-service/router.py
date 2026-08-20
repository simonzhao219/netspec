"""Text-spec service endpoints — 需求輸入 → 蘇格拉底追問 → PRD pipeline.

Covers /api/sessions/*, /api/translate, /api/history/*, plus this
service's own health/switch-mode/cost-report/rate-status/security-reload/
demo-mode (all genuinely text-spec-exclusive or per-service-independent
now that this runs as its own process — see the router-split memory).
Also owns the supporting bits only this domain needs: the custom rate
limiter, the durable daily-quota counter, the Session store (SESSIONS),
the LangGraph SSE streaming runner, and the pipeline-optimization
(iterate) logic.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import json
import os
import time
import uuid
from collections import defaultdict as _dd
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from langgraph.types import Command
from pydantic import BaseModel, Field, field_validator
from sse_starlette.sse import EventSourceResponse

import db as _db
import telemetry
from config import get_settings
from demo_replay import run_demo_pipeline, demo_resume as _demo_resume
from pipeline import PIPELINE, STEP_LABELS, NetSpecState
from security import check_requirement, checker as security_checker, reload_security_rules
from sse_session import Session
from db import (
    save_session, save_iteration, attach_iteration_result, list_sessions,
    get_session_iterations, get_iteration_result, delete_session,
    save_translation, get_translation, daily_get, daily_inc, daily_dec,
)

router = APIRouter(prefix="/api")


# ── Rate Limiter (custom, no third-party dependency) ──────────────────────────

_rate_buckets: dict = _dd(list)   # { "ip:endpoint" → [timestamps] }

# Fixed reset point for the daily counter. Asia/Taipei has no DST, so a fixed
# UTC+8 offset is exact and avoids depending on system tzdata.
_DAILY_TZ = _dt.timezone(_dt.timedelta(hours=8))


def _today() -> str:
    return _dt.datetime.now(_DAILY_TZ).date().isoformat()


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    return forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")


def _check_rate_limit(request: Request, endpoint: str, max_calls: int, window_sec: int) -> None:
    """Sliding-window rate check. Raises 429 if exceeded."""
    ip  = _get_client_ip(request)
    key = f"{ip}:{endpoint}"
    now = time.time()
    # Keep only timestamps within the window
    _rate_buckets[key] = [t for t in _rate_buckets[key] if now - t < window_sec]
    if len(_rate_buckets[key]) >= max_calls:
        wait = int(window_sec - (now - _rate_buckets[key][0])) + 1
        raise HTTPException(
            status_code=429,
            detail={
                "error":       "rate_limit_exceeded",
                "message":     f"請求太頻繁，請等待 {wait} 秒後再試（{endpoint} 限制：{max_calls} 次 / {window_sec//60} 分鐘）",
                "retry_after": wait,
                "limit":       max_calls,
                "window_sec":  window_sec,
            },
        )
    _rate_buckets[key].append(now)


def _rl(request: Request, endpoint: str) -> None:
    """Apply rate limit based on current mode (ollama/api)."""
    cfg = get_settings()
    limits = {
        # (max_calls, window_seconds)
        "ollama": {
            "start":     (5,  600),   # 5 次 / 10 分鐘
            "iterate":   (10, 600),   # 10 次 / 10 分鐘
            "translate": (30, 60),    # 30 次 / 分鐘
            "sessions":  (20, 60),    # 20 次 / 分鐘
        },
        "api": {
            "start":     (60, 3600),  # 60 次 / 小時
            "iterate":   (30, 3600),  # 30 次 / 小時
            "translate": (200, 3600), # 200 次 / 小時
            "sessions":  (60, 60),    # 60 次 / 分鐘
        },
    }
    mode_limits = limits.get(cfg.rate_limit_mode, limits["ollama"])
    max_calls, window_sec = mode_limits.get(endpoint, (20, 60))
    _check_rate_limit(request, endpoint, max_calls, window_sec)


# ── Daily call counter ────────────────────────────────────────────────────────
# Durable (SQLite-backed) + per-client (keyed by IP, matching the rate limiter)
# + Asia/Taipei reset. Survives backend restarts so the cap can't be bypassed.

def _daily_count(ip: str, key: str) -> int:
    return daily_get(_today(), ip, key)


def _daily_inc(ip: str, key: str) -> None:
    daily_inc(_today(), ip, key)


def _daily_dec(ip: str, key: str) -> None:
    """Refund a daily-counter increment (floored at 0) — used when a counted run
    consumed zero LLM spend (security-blocked / pre-LLM failure)."""
    daily_dec(_today(), ip, key)


def _check_daily_limit(ip: str, key: str, limit: int) -> None:
    """Hard daily cap (API mode only — cost protection)."""
    cfg = get_settings()
    if cfg.rate_limit_mode != "api":
        return
    used = _daily_count(ip, key)
    if used >= limit:
        raise HTTPException(
            status_code=429,
            detail={
                "error":   "daily_limit_exceeded",
                "message": f"今日 {key} 呼叫次數已達上限（{limit} 次），明日重置。",
                "used":    used,
                "limit":   limit,
            },
        )


# ── Session store ─────────────────────────────────────────────────────────────

SESSIONS: dict[str, Session] = {}


# ── Telemetry helpers ─────────────────────────────────────────────────────────
# One place that knows how to turn "something happened to this session" into a
# governed row. Everything session-scoped goes through _emit so the join keys
# (app_session_id, user_email) are attached the same way every time and no call
# site can forget them.

def _emit(session: Session, event_name: str, *, duration_ms: int | None = None,
          properties: dict | None = None, event_type: str = "server_event") -> None:
    telemetry.track(
        event_name,
        event_type=event_type,
        app_session_id=session.id,
        user_email=session.user_email,
        user_id=session.user_id,
        workflow="text",
        duration_ms=duration_ms,
        properties=properties or {},
    )


def _emit_spec_version(session: Session, result: dict, iteration: int, *, origin: str) -> None:
    """Success criterion #2 — what the app *produced*, as a governed row.

    One row per specification version, carrying the version's identity, quality
    and approval state, and joinable to the interaction telemetry on
    app_session_id / user_email. The spec body itself is deliberately absent:
    it lives in the SQLite database (and its Volume backup); what belongs in the
    lakehouse is the metadata every cross-system question actually needs.
    """
    sections = result.get("spec_sections") or {}
    role_views = result.get("role_views") or {}
    _emit(
        session, "spec_version",
        event_type="app_output",
        properties={
            "spec_id": f"{session.id}:v{iteration}",
            "iteration": iteration,
            "origin": origin,                      # pipeline | iterate
            "feature_name": sections.get("feature_name", ""),
            "req_type": result.get("req_type", ""),
            "detail_level": result.get("detail_level", ""),
            "protocols": result.get("protocols", []),
            "quality_score": result.get("validation_score", 0),
            "validation_passed": bool(result.get("validation_passed", False)),
            "validation_issue_count": len(result.get("validation_issues") or []),
            "edge_case_count": len(result.get("edge_cases") or []),
            "citation_count": len(result.get("citations") or []),
            "spec_chars": len(result.get("spec_document") or ""),
            "spec_chars_en": len(result.get("spec_document_en") or ""),
            "approval_state": _approval_state(result),
            "derived_role_views": sorted(role_views.keys()),
        },
    )


def _approval_state(result: dict) -> str:
    """NetSpec's approval gate, expressed as an enum.

    NetSpec has no explicit "Approve" button today. What it has is the PM-first
    gate described in the README: a PM confirms the PM spec, and only then are
    the architect / QA views derived from it. So a version that has derived role
    views has been accepted by a human in the only way the product currently
    expresses acceptance, and a version that passed validation without that
    step is a candidate awaiting one.

    Kept as a single function so that, when an explicit approval action is added
    to the product, only this mapping changes.
    """
    if result.get("role_views"):
        return "approved_derived"          # PM confirmed → role views derived
    if result.get("validation_passed"):
        return "pending_approval"          # passed validation, no human gate yet
    return "draft"


# ── Agent thought generator ────────────────────────────────────────────────────

def _get_step_model(node_name: str) -> str:
    """Return the configured model name for a pipeline step."""
    s = get_settings()
    if s.use_ollama:
        return s.ollama_model  # local model for all steps

    step_map = {
        "parse":        s.llm_parse,
        "socratic":     s.llm_socratic,
        "plan_search":  s.llm_plan,
        "analyze":      s.llm_analyze,
        "detect_edges": s.llm_edges,
        "gherkin":      s.llm_prd,
        "validate":     s.llm_validate,
    }
    configured = step_map.get(node_name, "")
    return configured or s.default_model or s.claude_model


def _make_thought(node_name: str, state: dict) -> str:
    protocols = state.get("protocols", [])
    req_type  = state.get("req_type", "generic").upper()
    scraped   = state.get("scraped_data", [])
    disasters = state.get("disaster_patterns", [])
    clarity   = state.get("clarity_score", 0)
    rnd       = state.get("socratic_round", 0)
    proto_str = "、".join(protocols[:3]) if protocols else req_type

    thoughts = {
        "parse":        f"解析需求文字，識別 {req_type} 協定類型與技術關鍵字…",
        "socratic":     f"清晰度評分 {clarity}/100，生成第 {rnd + 1} 輪針對性追問…",
        "plan_search":  f"識別到協定 {proto_str}，規劃社群搜尋關鍵字策略…",
        "scrape":       f"並行爬取 GitHub Issues、Hacker News、Reddit 社群案例…",
        "analyze":      f"分析 {len(scraped)} 筆社群資料，萃取高頻故障模式…",
        "detect_edges": f"已知 {len(disasters)} 個社群災情，枚舉 {proto_str} 邊界情境…",
        "gherkin":      f"整合需求與邊界條件，生成完整 PRD 規格書（繁體中文）…",
        "validate":     f"交叉校驗規格書完整性、SLA 合理性與邊界覆蓋率…",
    }
    return thoughts.get(node_name, "Agent 處理中…")


# ── Pipeline runner (background task) ─────────────────────────────────────────

async def _stream_pipeline(session: Session, input_val: Any, config: dict) -> None:
    """Shared helper: stream LangGraph events and handle interrupt() inside nodes.

    __done__ is ONLY sent for terminal states (complete / error).
    For interrupt(), the SSE connection stays open so the frontend can receive
    future events without re-opening the EventSource.
    """
    is_interrupt = False
    # Per-run, not module-level: two sessions can be in the same node at once.
    _step_started_at: dict[str, float] = {}
    try:
        session.status = "running"
        session.interrupt_type = None
        session.interrupt_data = None

        # ── Phase 0: SKILL security check ─────────────────────────────────────
        requirement = input_val.get("requirement", "") if isinstance(input_val, dict) else ""
        if requirement:
            sec = check_requirement(requirement)

            # Layer 2 — attack intent: BLOCK immediately
            if sec.blocked and sec.block_alert:
                a = sec.block_alert
                await session.queue.put({
                    "type":       "security_block",
                    "category":   a.category,
                    "message":    a.message,
                    "detected":   a.detected,
                    "suggestion": a.suggestion,
                })
                session.status = "error"
                session.error  = a.message
                _emit(session, "security_blocked", properties={
                    "category": a.category, "detected_count": len(a.detected or []),
                })
                _daily_dec(session.client_ip, "start")   # blocked before any LLM spend → refund the daily quota
                await session.queue.put({"type": "__done__"})
                return

            # Layer 1 + 3 — warnings (sensitive info masked, injection stripped)
            if sec.warnings:
                await session.queue.put({
                    "type":               "security_warning",
                    "warnings":           [
                        {"category": w.category, "message": w.message,
                         "detected": w.detected, "suggestion": w.suggestion}
                        for w in sec.warnings
                    ],
                    "masked_requirement": sec.clean_text,
                })
                _emit(session, "security_warned", properties={
                    "warning_count": len(sec.warnings),
                    "categories": [w.category for w in sec.warnings],
                })
                # Patch the requirement with the sanitised version
                if isinstance(input_val, dict):
                    input_val = {**input_val, "requirement": sec.clean_text}
        # ──────────────────────────────────────────────────────────────────────

        async for event in PIPELINE.astream_events(input_val, config=config, version="v2"):
            etype = event.get("event", "")
            name  = event.get("name", "")

            if etype == "on_chain_start" and name in STEP_LABELS:
                meta        = STEP_LABELS[name]
                state_input = event.get("data", {}).get("input", {}) or {}
                thought     = _make_thought(name, state_input)
                _step_started_at[name] = time.time()
                _emit(session, "pipeline_step_started", properties={
                    "node": name, "step": meta["step"], "title": meta["title"],
                    "phase": meta["phase"], "model": _get_step_model(name),
                })
                await session.queue.put({
                    "type":    "step_start",
                    "node":    name,
                    "step":    meta["step"],
                    "title":   meta["title"],
                    "agent":   _get_step_model(name),  # ← dynamic, reflects config
                    "phase":   meta["phase"],
                    "thought": thought,
                })

            elif etype == "on_chain_end" and name in STEP_LABELS:
                meta       = STEP_LABELS[name]
                output     = event.get("data", {}).get("output", {}) or {}
                logs       = output.get("log", [])
                last_log   = logs[-1]["message"] if logs else ""
                tool_calls = output.get("_tool_calls", [])
                started    = _step_started_at.pop(name, None)
                _emit(session, "pipeline_step_completed",
                      duration_ms=int((time.time() - started) * 1000) if started else None,
                      properties={
                          "node": name, "step": meta["step"], "title": meta["title"],
                          "phase": meta["phase"], "model": _get_step_model(name),
                          "tool_call_count": len(tool_calls),
                      })
                await session.queue.put({
                    "type":       "step_complete",
                    "node":       name,
                    "step":       meta["step"],
                    "title":      meta["title"],
                    "log_message": last_log,
                    "tool_calls": tool_calls,
                })

        # ── After stream ends: check for interrupt() or completion ──────────
        graph_state = PIPELINE.get_state(config)

        interrupt_value = None
        for task in (graph_state.tasks or []):
            ivs = getattr(task, "interrupts", None) or []
            if ivs:
                interrupt_value = ivs[0].value
                break

        if interrupt_value:
            itype = interrupt_value.get("type", "unknown")
            session.status = "interrupted"
            session.interrupt_type = itype
            session.interrupt_data = interrupt_value
            is_interrupt = True  # ← tell finally NOT to send __done__
            _emit(session, "pipeline_interrupted", properties={
                "interrupt_type": itype,
                "round": interrupt_value.get("round"),
                "question_count": len(interrupt_value.get("questions") or []),
                "clarity_score": interrupt_value.get("clarity_score"),
                "threshold_met": interrupt_value.get("threshold_met"),
            })
            await session.queue.put({
                "type": "interrupt",
                "interrupt_type": itype,
                "data": interrupt_value,
            })
        elif graph_state.next:
            await session.queue.put({
                "type": "error",
                "message": f"Pipeline paused unexpectedly at: {graph_state.next}",
            })
        else:
            result = _build_result(graph_state.values)
            session.status = "complete"
            session.result = result
            session.save_iteration()  # auto-save to in-memory list
            # ── Persist to SQLite ──────────────────────────────────────────
            try:
                req = graph_state.values.get("requirement", "")
                req_type = graph_state.values.get("req_type", "generic")
                save_session(session.id, req, req_type)
                iter_num = len(session.iterations)
                save_iteration(
                    session_id       = session.id,
                    iteration_num    = iter_num,
                    quality_score    = result.get("validation_score", 0),
                    validation_passed= result.get("validation_passed", False),
                    feature_name     = result.get("spec_sections", {}).get("feature_name", ""),
                    spec_document    = result.get("spec_document", ""),
                    result           = result,
                )
            except Exception as db_err:
                print(f"[DB] save failed (non-fatal): {db_err}")
            # ──────────────────────────────────────────────────────────────
            # Outside the try above on purpose: a SQLite failure must not also
            # cost us the governed row, which is the more durable record.
            _emit_spec_version(session, result, len(session.iterations), origin="pipeline")
            _emit(session, "pipeline_completed",
                  duration_ms=int((time.time() - session.created_at) * 1000),
                  properties={
                      "quality_score": result.get("validation_score", 0),
                      "validation_passed": result.get("validation_passed", False),
                      "detail_level": result.get("detail_level", ""),
                      "scraped_count": result.get("scraped_count", 0),
                      "edge_case_count": len(result.get("edge_cases") or []),
                  })
            await session.queue.put({"type": "complete", "result": result})

    except Exception as exc:
        print(f"[pipeline] session={session.id} failed: {type(exc).__name__}: {exc}")
        session.status = "error"
        session.error = str(exc)
        _emit(session, "pipeline_failed", properties={
            "error_type": type(exc).__name__, "error": str(exc)[:200],
        })
        await session.queue.put({"type": "error", "message": str(exc)})
    finally:
        # Only close the SSE connection for terminal states (complete / error).
        # For interrupt(), is_interrupt=True so we skip __done__ and keep the stream alive.
        if not is_interrupt:
            await session.queue.put({"type": "__done__"})


async def _run_pipeline(session: Session, initial_state: dict, config: dict) -> None:
    cfg = get_settings()
    # Bind once here, around everything the run does — the llm_call cost events
    # emitted from inside llm_client pick the session up from this context.
    with telemetry.bind_context(app_session_id=session.id, user_email=session.user_email,
                                user_id=session.user_id, workflow="text"):
        if cfg.demo_mode:
            await run_demo_pipeline(session, cfg)
            return
        await _stream_pipeline(session, initial_state, config)


async def _resume_pipeline(session: Session, resume_value: Any, config: dict) -> None:
    """Resume after interrupt() using Command(resume=value).

    IMPORTANT: Do NOT replace session.queue here.
    The SSE generator is already reading from session.queue via session.queue.get().
    Replacing it would cause a 30-second blind spot until the wait_for times out.
    The previous pipeline run already sent __done__ to close the old stream cleanly.
    """
    with telemetry.bind_context(app_session_id=session.id, user_email=session.user_email,
                                user_id=session.user_id, workflow="text"):
        await _stream_pipeline(session, Command(resume=resume_value), config)


def _build_result(state: dict) -> dict:
    """Assemble final spec output from pipeline state."""
    return {
        "requirement": state.get("requirement", ""),
        "req_type": state.get("req_type", "generic"),
        "detail_level": state.get("detail_level", "standard"),
        "protocols": state.get("protocols", []),
        "clarity_score": state.get("clarity_score", 0),
        "search_plan": state.get("search_plan", []),
        "scraped_count": len(state.get("scraped_data", [])),
        "disaster_patterns": state.get("disaster_patterns", []),
        "edge_cases":    state.get("edge_cases", []),
        "edge_cases_en": state.get("edge_cases_en", []),
        # PRD document fields (both languages generated during pipeline)
        "spec_document":    state.get("spec_document", ""),
        "spec_document_en": state.get("spec_document_en", ""),
        "spec_sections": state.get("spec_sections", {}),
        # Legacy compat
        "gherkin_spec": state.get("gherkin_spec", ""),
        "gherkin_scenarios": state.get("gherkin_scenarios", []),
        "validation_score": state.get("validation_score", 0),
        "validation_passed": state.get("validation_passed", False),
        "validation_issues":    state.get("validation_issues", []),
        "validation_issues_en": state.get("validation_issues_en", []),
        "validation_summary": state.get("validation_summary", ""),
        "uncovered_high_edges": state.get("uncovered_high_edges", []),
        # Derived role views (architect / qa) — generated on demand from this PM spec.
        "role_views": state.get("role_views", {}),
        "citations": [
            {
                "source": d.get("source", ""),
                "title":  d.get("title", ""),
                "url":    d.get("url", ""),
                **({"stars": d["stars"]} if d.get("stars") is not None else {}),
            }
            for d in state.get("scraped_data", [])[:8]
            if d.get("url") and d.get("title")
        ],
        "log": state.get("log", []),
    }


# ── Request models ────────────────────────────────────────────────────────────

class StartRequest(BaseModel):
    requirement: str = Field(..., min_length=10, max_length=500)
    initial_answers: Optional[dict] = None
    initial_covered_dimensions: Optional[list] = None
    detail_level: str = "standard"   # concise | standard | comprehensive — controls spec size/depth

    @field_validator("requirement")
    @classmethod
    def strip_requirement(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 10:
            raise ValueError("需求描述至少需要 10 個字元")
        if len(v) > 500:
            raise ValueError(f"需求描述不得超過 500 字元（目前 {len(v)} 字）")
        return v


class ResumeRequest(BaseModel):
    answers: Optional[dict] = None        # for socratic
    confirmed: Optional[bool] = True      # for plan_confirm
    modified_keywords: Optional[list[str]] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/sessions")
async def create_session(request: Request) -> dict:
    _rl(request, "sessions")
    session_id = str(uuid.uuid4())
    session = Session(session_id)
    # Bind the acting user to the session now, while the request headers still
    # exist — every later event on this session is attributed from here.
    ident = telemetry.identity_from(request)
    session.user_email = ident.get("user_email")
    session.user_id = ident.get("user_id")
    SESSIONS[session_id] = session
    _emit(session, "session_created")
    return {
        "session_id": session_id,
        "stream_url": f"/api/sessions/{session_id}/stream",
    }


@router.post("/sessions/{session_id}/start")
async def start_session(request: Request, session_id: str, body: StartRequest, background_tasks: BackgroundTasks) -> dict:
    _rl(request, "start")
    cfg = get_settings()
    ip = _get_client_ip(request)
    _check_daily_limit(ip, "start", cfg.daily_start_limit)
    _daily_inc(ip, "start")
    session = SESSIONS.get(session_id)
    if not session:
        _daily_dec(ip, "start")   # pre-LLM failure → refund
        raise HTTPException(404, "Session not found")
    if session.status not in ("idle",):
        _daily_dec(ip, "start")   # pre-LLM failure → refund
        raise HTTPException(400, f"Session is already {session.status}")
    session.client_ip = ip   # for per-IP refund inside the background pipeline (security block)

    detail_level = body.detail_level if body.detail_level in ("concise", "standard", "comprehensive") else "standard"
    initial_state: NetSpecState = {
        "requirement": body.requirement,
        "req_type": "generic",
        "detail_level": detail_level,
        "protocols": [],
        "key_behaviors": [],
        "constraints_mentioned": [],
        "missing_dimensions": [],
        "clarity_score": 0,
        "clarity_analysis": "",
        "clarity_deductions": [],
        "socratic_round": 0,
        "current_questions": [],
        "asked_questions": [],
        # Pre-load from previous session when user clicks "繼續追問"
        "covered_dimensions": body.initial_covered_dimensions or [],
        "all_answers": body.initial_answers or {},
        "user_wants_to_proceed": False,
        "user_wants_more_questions": False,
        "search_plan": [],
        "search_plan_confirmed": False,
        "scraped_data": [],
        "disaster_patterns": [],
        "edge_cases": [],
        "spec_document": "",
        "spec_document_en": "",
        "spec_sections": {},
        "gherkin_spec": "",
        "gherkin_scenarios": [],
        "validation_issues": [],
        "validation_issues_en": [],
        "edge_cases_en": [],
        "validation_score": 0,
        "validation_passed": False,
        "validation_summary": "",
        "current_step": 0,
        "log": [],
        "error": None,
    }

    _emit(session, "pipeline_started", properties={
        "detail_level": detail_level,
        "requirement_chars": len(body.requirement or ""),
        "preloaded_answer_count": len(body.initial_answers or {}),
        "preloaded_dimension_count": len(body.initial_covered_dimensions or []),
        "demo_mode": get_settings().demo_mode,
    })

    config = {"configurable": {"thread_id": session_id}}
    background_tasks.add_task(_run_pipeline, session, initial_state, config)
    return {"ok": True, "stream_url": f"/api/sessions/{session_id}/stream"}


@router.get("/sessions/{session_id}/stream")
async def stream_session(session_id: str):
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    async def event_generator():
        # Send current status first, enriched with the session's current state so a
        # RE-connecting client (after a transient network drop) can rehydrate the UI
        # — current interrupt to re-render, or the final result/error if it ended
        # while disconnected. (B1: self-healing SSE reconnect.)
        yield {"data": json.dumps({
            "type":           "connected",
            "session_id":     session_id,
            "status":         session.status,
            "interrupt_type": session.interrupt_type,
            "interrupt_data": session.interrupt_data,
            "result":         session.result,
            "error":          session.error,
        }, ensure_ascii=False)}

        while True:
            try:
                event = await asyncio.wait_for(session.queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                yield {"data": json.dumps({"type": "heartbeat"})}
                continue

            if event.get("type") == "__done__":
                break

            yield {"data": json.dumps(event, ensure_ascii=False)}

            if event.get("type") in ("complete", "error"):
                break

    # sep="\n": CRLF (the sse_starlette default) doesn't survive the
    # browser -> ngrok -> Next.js path intact in dev — some tunnels mishandle
    # bare \r during HTTP version translation, dropping the blank line that
    # separates SSE events. Plain \n is still spec-valid and tunnel-safe.
    return EventSourceResponse(event_generator(), sep="\n")


@router.post("/sessions/{session_id}/resume")
async def resume_session(session_id: str, body: ResumeRequest, background_tasks: BackgroundTasks) -> dict:
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    if session.status != "interrupted":
        raise HTTPException(400, f"Session is not interrupted (status: {session.status})")

    # ── Demo mode: forward resume to demo_replay instead of LangGraph ────────
    if get_settings().demo_mode:
        interrupt_type = session.interrupt_type
        answers = body.answers or {}
        resume_val = answers if answers else {"__skip__": True}
        if body.confirmed:
            resume_val = {"confirmed": True}
        session.status = "running"
        session.interrupt_type = None
        session.interrupt_data = None
        _demo_resume(session_id, resume_val)
        return {"ok": True, "demo": True}
    # ─────────────────────────────────────────────────────────────────────────

    interrupt_type = session.interrupt_type
    config = {"configurable": {"thread_id": session_id}}

    # resume_value is returned by interrupt() inside the node.
    # LangGraph rejects Command(resume={}) (empty dict), so use None for "skip".
    if interrupt_type == "socratic":
        answers = body.answers or {}
        if not answers:
            # No answers dict at all — should not happen, treat as skip
            resume_value = {"__skip__": True}
        elif answers.get("__proceed__"):
            resume_value = {"__proceed__": True}   # user clicked "進入下一步"
        elif answers.get("__skip__"):
            resume_value = {"__skip__": True}       # user clicked "直接跳過"
        else:
            resume_value = answers                  # normal answers submitted
    elif interrupt_type == "plan_confirm":
        resume_value = {
            "confirmed": body.confirmed,
            "modified_keywords": body.modified_keywords,
        }
    else:
        answers = body.answers or {}
        resume_value = answers if answers else {"__skip__": True}

    # _resume_pipeline resets the queue internally
    background_tasks.add_task(_resume_pipeline, session, resume_value, config)
    return {"ok": True, "stream_url": f"/api/sessions/{session_id}/stream"}


@router.post("/sessions/{session_id}/load-result")
async def load_result_into_session(session_id: str, body: dict) -> dict:
    """Pre-load a historical result into a new session so the user can run 優化迭代.

    Called when the user clicks a historical item in the sidebar.
    The session is set to 'complete' with the provided result, enabling iteration.
    """
    session = SESSIONS.get(session_id)
    if not session:
        # Create-if-missing: lets a history session be resumed IN PLACE (same id),
        # so 優化 continues numbering in the same session instead of forking a new card.
        session = Session(session_id)
        SESSIONS[session_id] = session

    result = body.get("result", {})
    session.result = result
    session.status = "complete"

    # Rehydrate iteration history so iterate numbering continues (no version split).
    iters_meta = body.get("iterations")
    if iters_meta:
        n = len(iters_meta)
        session.iterations = [{
            "iteration":         it.get("iteration", i + 1),
            "timestamp":         it.get("timestamp", time.time()),
            "quality_score":     it.get("quality_score", 0),
            "validation_passed": it.get("validation_passed", False),
            "feature_name":      it.get("feature_name", ""),
            # only the latest carries the full result (used by the iterate snapshot guard)
            "result":            result if i == n - 1 else {},
        } for i, it in enumerate(iters_meta)]
    elif not session.iterations:
        session.iterations = [{
            "iteration": 1,
            "timestamp": time.time(),
            "quality_score": result.get("validation_score", 0),
            "validation_passed": result.get("validation_passed", False),
            "feature_name": result.get("spec_sections", {}).get("feature_name", ""),
            "result": result,
        }]

    return {"ok": True}


@router.get("/sessions/{session_id}")
async def get_session(session_id: str) -> dict:
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return session.to_dict()


@router.get("/sessions/{session_id}/iterations/{iteration_num}")
async def get_iteration(session_id: str, iteration_num: int) -> dict:
    """Get a specific historical iteration's full result."""
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    for it in session.iterations:
        if it["iteration"] == iteration_num:
            return it
    raise HTTPException(404, f"Iteration {iteration_num} not found")


class IterateRequest(BaseModel):
    feedback: Optional[str] = None   # User's optional improvement note


async def _run_iteration(session: Session, feedback: Optional[str]) -> None:
    """Bind this session's telemetry context, then run the iteration.

    Same shape as _run_pipeline: everything the run emits — including the
    llm_call cost events from inside llm_client — picks the session up from here.
    """
    with telemetry.bind_context(app_session_id=session.id, user_email=session.user_email,
                                user_id=session.user_id, workflow="text"):
        await _run_iteration_inner(session, feedback)


async def _run_iteration_inner(session: Session, feedback: Optional[str]) -> None:
    """Re-generate PRD + Validate using validation issues as improvement context.
    Does NOT re-run scraping or edge case detection — only Steps 7+8.
    """
    try:
        session.status = "running"
        prev_result = session.result or {}

        # Build improvement context from previous validation
        issues = prev_result.get("validation_issues", [])
        issue_text = "\n".join(
            f"  [{i.get('severity','?').upper()}] {i.get('location','')}: {i.get('description','')} → Fix: {i.get('fix','')}"
            for i in issues[:5]
        ) or "  No specific issues — improve detail and measurability."

        # Default auto-optimization strategy (used when user provides no direction)
        # Mirrors SKILL Phase 6 quality criteria — keep in sync with SKILL.md
        _AUTO_STRATEGY = (
            "① 強化驗收標準可量測性（加入具體數字/閾值/逾時值，禁用「應能」「需支援」等模糊描述）"
            "② 高風險邊界情境必須有對應的 Must Have 需求條目"
            "③ 業務目標加入可量測指標，避免空泛描述"
            "④ SLA 指標補充實際數值基準與測試方法"
        )

        if feedback:
            user_note = f"\n使用者指定優化方向：{feedback}\n同時修正上列驗證問題。"
        elif issues:
            # Has validation issues → focus on fixing them with auto strategy as supplement
            user_note = f"\n（未指定優化方向）依交叉驗證問題自動優化，同時執行：{_AUTO_STRATEGY}"
        else:
            # No issues, no feedback → general improvement
            user_note = (
                f"\n前版本已通過驗證，本次側重提升整體品質：{_AUTO_STRATEGY}"
                "\n另：可提升需求描述的技術深度，使 QA 可直接用於測試計畫。"
            )

        await session.queue.put({"type": "iterate_start", "iteration": len(session.iterations) + 1})

        # Import here to avoid circular deps at module level
        from pipeline import node_generate_gherkin, node_validate_spec, _build_prd_markdown
        from pipeline import SPEC_DOC_TOOL, VALIDATION_TOOL
        from pipeline import _edge_label, _label_to_title, _uncovered_high_edges, _detail   # B2 + detail level
        from llm_client import call_tool
        from prompts import SYSTEM_NETWORKING_EXPERT, VALIDATION_SCORE_TOOL

        # Build a fake state dict for the nodes
        state = {
            **prev_result,
            "requirement":      prev_result.get("requirement", ""),
            "req_type":         prev_result.get("req_type", "generic"),
            "detail_level":     prev_result.get("detail_level", "standard"),
            "protocols":        prev_result.get("protocols", []),
            "all_answers":      prev_result.get("collected_answers", {}),
            "edge_cases":       prev_result.get("edge_cases", []),
            "disaster_patterns":prev_result.get("disaster_patterns", []),
            "spec_sections":    prev_result.get("spec_sections", {}),
        }
        d = _detail(state["detail_level"])

        # B2: labelled edges + which HIGH edges the previous version failed to cover
        ec_labeled = "\n".join(
            f"  {_edge_label(i)} [{(e.get('risk') or '').upper()}] {e.get('title','')}"
            for i, e in enumerate(state["edge_cases"][:8])
        ) or "（無）"
        high_labels  = [_edge_label(i) for i, e in enumerate(state["edge_cases"]) if e.get("risk") == "high"]
        prev_uncovered = prev_result.get("uncovered_high_edges", []) or []
        answers_text = "\n".join(f"  {k}: {v}" for k, v in state.get("all_answers", {}).items()) or "（無補充）"
        disaster_text = "\n".join(
            f"  - {p.get('title')}: {p.get('description','')[:60]}"
            for p in state["disaster_patterns"][:3]
        )

        # Step 7: Re-generate PRD with improvement context
        await session.queue.put({"type": "step_start", "node": "gherkin", "step": 7,
                                 "title": "PRD 優化生成", "agent": _get_step_model("gherkin"), "phase": "Phase 3",
                                 "thought": f"整合前版 {len(issues)} 個問題，重新生成更完善的 PRD 規格書…"})

        prompt = f"""請優化此網通功能 PRD，修正前版問題並產出更完善的版本。所有輸出請使用繁體中文。

功能需求：{state['requirement'][:200]}
類型：{state.get('req_type','generic')} | 協定：{', '.join(state.get('protocols',[])[:4])}
使用者補充說明：{answers_text[:200]}
社群災情參考：{disaster_text[:150] if disaster_text else '無'}

邊界情境清單（請在對應需求的 covers_edge_cases 標註 EC 編號）：
{ec_labeled}
⚠️ 高風險（每個都必須被至少一條 Must Have 涵蓋）：{', '.join(high_labels) or '無'}
{('🔧 前版未涵蓋、本次務必補上：' + ', '.join(prev_uncovered)) if prev_uncovered else ''}

前版驗證問題（必須修正）：
{issue_text}
{user_note}

必須輸出 JSON 欄位（全部繁體中文，選填欄位在沒有充分資訊時可省略）：
- feature_name: 10字以內功能名稱
- business_objective: 2句業務目標（比前版更具體，包含可量測指標）
- scope: 1句功能範圍說明
- out_of_scope: 2項不在範圍內的事項
- target_platform: 目標平台（選填）如 "Broadcom SONiC 4.x"，不確定則省略
- requirements: {d['req']}，每個物件：
    {{id:"REQ-001", title:"繁中標題", description:"{d['verbosity']}",
      priority:"Must Have"|"Should Have"|"Nice to Have",
      priority_rationale:"此優先級的依據，1-2 句（Must Have 必填）",
      related_standard:"僅在有明確 RFC/IEEE 對應時填寫，否則省略",
      acceptance_criteria:[{d['ac']}，含具體數字],
      covers_edge_cases:["EC-1","EC-3"]（此需求涵蓋的邊界 EC 編號；每個高風險 EC 都要被某條 Must Have 涵蓋）}}
- performance_sla: 4 項含實際數值的效能指標，**每條須含量測條件**（如『≤ 1ms（線速 10Gbps、64-byte）』）
- reliability_requirements: 可靠性指標（選填）如 "MTTR ≤ 30s"
- dependencies: 2-3 項協定或子系統依賴
- open_questions: 仍未確認的技術決策（選填），若已完整則省略

驗收標準必須可量測：包含具體數字、閾值、逾時時間等，禁止使用「應能」「需支援」等模糊描述。

🔒 自我一致性檢查（輸出前務必自我檢查，違反就改掉再輸出）：
1. 數值彼此相容：所有計時器、週期、逾時、SLA、RTO/MTTR、狀態同步週期、容量／並發上限之間不得邏輯矛盾——例如「狀態同步週期」不得長於「故障恢復時間目標」；單一終端上限不得與全系統並發 SLA 衝突。
2. 每條驗收標準可量測：含具體數字、單位、量測條件與判定門檻。
3. 跨需求一致：REQ 之間、REQ 與 SLA 之間引用的數字必須一致。
⚠️ 修補前版缺口（如補上 HA／故障轉移）時，新增需求的數值務必與既有 SLA／計時器自洽——補洞不要補出新的自相矛盾（會被校驗判為 critical、反而扣分）。"""

        spec_result = call_tool(prompt, SPEC_DOC_TOOL, model=get_settings().llm_prd or get_settings().default_model)
        # iteration number = current in-memory count + 1 (before appending new)
        iter_num = len(session.iterations) + 1
        md = _build_prd_markdown(spec_result, state, iteration=iter_num)

        await session.queue.put({"type": "step_complete", "node": "gherkin", "step": 7,
                                 "title": "PRD 優化生成",
                                 "log_message": f"PRD 優化完成：{spec_result.get('feature_name','')}，{len(spec_result.get('requirements',[]))} 條需求"})

        # Step 8: Re-validate
        await session.queue.put({"type": "step_start", "node": "validate", "step": 8,
                                 "title": "交叉校驗", "agent": _get_step_model("validate"), "phase": "Phase 3",
                                 "thought": f"交叉校驗優化後的規格書，確認需求完整性與 SLA 合理性…"})

        reqs = spec_result.get("requirements", [])
        sla  = spec_result.get("performance_sla", [])
        ec   = state["edge_cases"]
        high_ec = [e.get("title") for e in ec if e.get("risk") == "high"]

        # Re-validate the NEW version with the FULL validator so issues reflect the
        # ACTUAL new content — fixed problems disappear instead of being carried forward
        # stale (the old lightweight scorer returned no issues → previous issues stuck,
        # making optimization look like it changed nothing). Routed to gpt-5.4 (fast +
        # reliable tool calls) to avoid the Kimi-stuck reason the lightweight tool existed.
        req_detail = "\n".join(
            f"{r.get('id','REQ-?')} [{r.get('priority','')}] {r.get('title','')}"
            f" | 驗收：{' ; '.join((r.get('acceptance_criteria') or [])[:3])}"
            for r in reqs[:8]
        ) or "（無）"
        val_prompt = f"""交叉校驗此「優化後」的網通 PRD，只列出『仍然存在』的問題；前版已修正的問題不要再列。所有輸出繁體中文。

功能需求：{state['requirement'][:150]}
需求與驗收標準（{len(reqs)} 條）：
{req_detail}
效能 SLA：{sla[:4]}
高風險邊界情境：{high_ec[:4]}

評估面向：① 驗收標準是否可量測（具體數字/閾值/逾時）② SLA 是否有合理數值與量測條件 ③ 高風險邊界是否都有對應 Must Have 需求 ④ 需求間是否矛盾。
每個仍存在的問題輸出 {{severity(critical/high/warning/info), location, description, fix}}；給 quality_score 0-100；無 critical 問題則 passed=true。"""
        try:
            val_result = call_tool(val_prompt, VALIDATION_TOOL,
                                   model=get_settings().llm_analyze or get_settings().llm_validate or get_settings().default_model)
        except Exception as exc:
            print(f"[iterate] re-validate degraded: {exc}")
            val_result = {"passed": False, "quality_score": prev_result.get("validation_score", 0),
                          "issues": [], "summary": f"[降級] 校驗未完成（{exc}）"}
        score  = val_result.get("quality_score", val_result.get("score", 0))
        passed = val_result.get("passed", False)

        # FRESH issues from re-validation (drop the LLM's own edge-coverage guess; B2 below is authoritative)
        carried_issues = [i for i in (val_result.get("issues") or []) if i.get("location") != "邊界覆蓋率"]

        # B2: deterministic edge-coverage audit on the NEW version (authoritative)
        new_uncovered = _uncovered_high_edges(ec, reqs)
        if new_uncovered:
            lbl2title = _label_to_title(ec)
            detail = "、".join(f"{lab}（{lbl2title.get(lab, '')}）" for lab in new_uncovered)
            carried_issues = list(carried_issues) + [{
                "severity": "high", "location": "邊界覆蓋率",
                "description": f"以下高風險邊界仍未被 Must Have 需求涵蓋：{detail}",
                "fix": "新增/調整 Must Have 需求並於 covers_edge_cases 標註對應 EC 編號。",
            }]
        cov_log = f"，高風險覆蓋 {len(high_labels) - len(new_uncovered)}/{len(high_labels)}" if high_labels else ""

        await session.queue.put({"type": "step_complete", "node": "validate", "step": 8,
                                 "title": "交叉校驗",
                                 "log_message": f"校驗完成：{score}/100，{'通過' if passed else '有待改進'}{cov_log}"})

        # ── Score-transparency diff (why did the score move?) ──────────────────
        # Each version is RE-JUDGED from scratch, so "fixed warnings" ≠ "higher score":
        # fixing a gap (e.g. adding HA) can introduce a NEW, more severe issue and drop
        # the score. Diff prev vs new issues so the UI can show ✅已解決 / ⚠️新出現.
        def _ikey(it: dict):
            return ((it.get("location") or "").strip(),
                    (it.get("description") or it.get("issue") or "")[:30].strip())
        prev_issues = [i for i in (prev_result.get("validation_issues") or []) if isinstance(i, dict)]
        prev_keys   = {_ikey(i) for i in prev_issues}
        new_keys    = {_ikey(i) for i in carried_issues if isinstance(i, dict)}
        resolved    = [i for i in prev_issues if _ikey(i) not in new_keys]
        introduced  = [i for i in carried_issues if isinstance(i, dict) and _ikey(i) not in prev_keys]
        prev_score  = prev_result.get("validation_score", prev_result.get("quality_score"))
        issue_delta = {
            "prev_score":   prev_score,
            "score":        score,
            "score_change": (score - prev_score) if isinstance(prev_score, (int, float)) else None,
            "resolved":     resolved,
            "introduced":   introduced,
        }

        # Build new result.
        new_result = {
            **prev_result,
            "spec_document":     md,
            "spec_sections":     spec_result,
            "validation_score":  score,
            "validation_passed": passed,
            "validation_issues": carried_issues,
            "validation_summary":val_result.get("summary", ""),
            "uncovered_high_edges": new_uncovered,
            "issue_delta":       issue_delta,
            "gherkin_spec":      "",
            "gherkin_scenarios": [],
        }

        # Append the NEW iteration (v_n) to in-memory list so version-switching works
        session.iterations.append({
            "iteration":        iter_num,
            "timestamp":        time.time(),
            "quality_score":    score,
            "validation_passed": passed,
            "feature_name":     spec_result.get("feature_name", ""),
            "result":           new_result,
        })
        session.result = new_result
        session.status = "complete"

        # ── Persist iteration to SQLite ────────────────────────────────────
        try:
            req      = prev_result.get("requirement", "")
            req_type = prev_result.get("req_type", "generic")
            # Ensure session row exists (history-loaded sessions use a fresh ID never in DB)
            save_session(session.id, req, req_type)
            save_iteration(
                session_id        = session.id,
                iteration_num     = iter_num,
                quality_score     = score,
                validation_passed = passed,
                feature_name      = spec_result.get("feature_name", ""),
                spec_document     = md,
                result            = new_result,
            )
        except Exception as db_err:
            print(f"[DB] iterate save failed (non-fatal): {db_err}")
        # ──────────────────────────────────────────────────────────────────

        # Outside the try above on purpose — see the note in _stream_pipeline.
        _emit_spec_version(session, new_result, iter_num, origin="iterate")
        _emit(session, "spec_iterated", properties={
            "iteration": iter_num,
            "quality_score": score,
            "validation_passed": passed,
            "had_user_direction": bool(feedback),
            "issue_count": len(carried_issues),
        })
        await session.queue.put({
            "type": "iterate_complete",
            "iteration": iter_num,
            "quality_score": score,
            "validation_passed": passed,
            "result": new_result,
        })

    except Exception as exc:
        print(f"[iterate] session={session.id} failed: {type(exc).__name__}: {exc}")
        session.status = "error"
        session.error = str(exc)
        _emit(session, "spec_iterate_failed", properties={
            "error_type": type(exc).__name__, "error": str(exc)[:200],
        })
        await session.queue.put({"type": "error", "message": str(exc)})
    finally:
        await session.queue.put({"type": "__done__"})


@router.post("/sessions/{session_id}/iterate")
async def iterate_session(request: Request, session_id: str, body: IterateRequest, background_tasks: BackgroundTasks) -> dict:
    """Trigger a PRD optimization iteration (re-runs Node 7+8 only)."""
    _rl(request, "iterate")
    cfg = get_settings()
    ip = _get_client_ip(request)
    _check_daily_limit(ip, "iterate", cfg.daily_iterate_limit)
    _daily_inc(ip, "iterate")
    session = SESSIONS.get(session_id)
    if not session:
        _daily_dec(ip, "iterate")   # pre-LLM failure → refund
        raise HTTPException(404, "Session not found")
    if session.status != "complete":
        _daily_dec(ip, "iterate")   # pre-LLM failure → refund
        raise HTTPException(400, f"Session must be complete to iterate (status: {session.status})")
    if not session.result:
        _daily_dec(ip, "iterate")   # pre-LLM failure → refund
        raise HTTPException(400, "No result to iterate on")

    # Snapshot current result as iteration v1 (in-memory + DB) before generating v2
    if not session.iterations or session.iterations[-1].get("result") != session.result:
        session.save_iteration()
        # Persist v1 to DB — also ensures session row exists for history-loaded sessions
        try:
            prev = session.result or {}
            save_session(session.id, prev.get("requirement", ""), prev.get("req_type", "generic"))
            save_iteration(
                session_id        = session.id,
                iteration_num     = len(session.iterations),
                quality_score     = prev.get("validation_score", 0),
                validation_passed = prev.get("validation_passed", False),
                feature_name      = prev.get("spec_sections", {}).get("feature_name", ""),
                spec_document     = prev.get("spec_document", ""),
                result            = prev,
            )
        except Exception as db_err:
            print(f"[DB] v1 snapshot save failed (non-fatal): {db_err}")

    background_tasks.add_task(_run_iteration, session, body.feedback)
    return {"ok": True, "stream_url": f"/api/sessions/{session_id}/stream",
            "iteration": len(session.iterations) + 1}


class GenerateRoleRequest(BaseModel):
    role: str            # "architect" | "qa"
    iteration: int = 1   # PM iteration this view is derived from (frontend's currentIteration)


@router.post("/sessions/{session_id}/generate-role")
async def generate_role(request: Request, session_id: str, body: GenerateRoleRequest) -> dict:
    """Generate an architect / QA view from the session's confirmed PM spec (synchronous).

    Mirrors /api/figma/stories/generate-one: PM spec → role view via a fast model, on demand.
    The view is derived from the CURRENT PM iteration and persisted onto it."""
    _rl(request, "iterate")
    role = (body.role or "").strip().lower()
    if role not in ("architect", "qa"):
        raise HTTPException(400, "role must be 'architect' or 'qa'")
    session = SESSIONS.get(session_id)
    if not session or not session.result:
        raise HTTPException(404, "Session has no completed spec to derive from")

    result = session.result
    spec_sections = result.get("spec_sections") or {}
    if not spec_sections.get("requirements"):
        raise HTTPException(400, "PM spec has no requirements to derive a role view from")

    from pipeline import generate_role_view
    cfg = get_settings()
    based_on = max(1, body.iteration)
    try:
        view = await asyncio.to_thread(
            generate_role_view, role, spec_sections,
            result.get("spec_document", ""), result.get("edge_cases", []),
            cfg.llm_analyze or cfg.default_model,
        )
    except Exception as exc:
        raise HTTPException(500, f"角色視圖生成失敗：{exc}")

    role_views = dict(result.get("role_views") or {})
    role_views[role] = {
        "document": view.get("document", ""),
        "sections": view.get("sections", {}),
        "based_on_iteration": based_on,
        "generated_at": time.time(),
    }
    result["role_views"] = role_views

    # Persist onto the current PM iteration (create the row if it doesn't exist yet).
    try:
        save_session(session.id, result.get("requirement", ""), result.get("req_type", "generic"))
        attach_iteration_result(
            session_id        = session.id,
            iteration_num     = based_on,
            feature_name      = spec_sections.get("feature_name", ""),
            quality_score     = result.get("validation_score", 0),
            validation_passed = result.get("validation_passed", False),
            spec_document     = result.get("spec_document", ""),
            result            = result,
        )
    except Exception as db_err:
        print(f"[DB] role view persist failed (non-fatal): {db_err}")

    # Deriving a role view is NetSpec's PM-confirmation gate (see _approval_state),
    # so this is both a usage event and a change in the spec's approval state.
    _emit(session, "role_view_generated", event_type="app_output", properties={
        "spec_id": f"{session.id}:v{based_on}",
        "role": role,
        "based_on_iteration": based_on,
        "feature_name": spec_sections.get("feature_name", ""),
        "document_chars": len(view.get("document", "") or ""),
    })
    _emit_spec_version(session, result, based_on, origin="role_view")

    return {"role": role, **role_views[role]}


# ── Translation endpoint ────────────────────────────────────────────────────

class TranslateRequest(BaseModel):
    spec_document: str   # current Markdown spec to translate
    target_lang: str = "en"  # "en" or "zh"


@router.post("/translate")
async def translate_spec(request: Request, body: TranslateRequest) -> dict:
    _rl(request, "translate")
    """Translate a spec document by splitting into sections and translating each.

    Section-by-section translation avoids garbled output from long documents.
    Each ## section is translated independently then reassembled.
    """
    import re as _re
    from openai import OpenAI
    from config import get_settings

    cfg = get_settings()
    text = (body.spec_document or "").strip()
    if not text:
        return {"translated": "", "lang": body.target_lang}

    is_to_en = body.target_lang == "en"

    def translate_chunk(chunk: str) -> str:
        if not chunk.strip():
            return chunk
        if is_to_en:
            instruction = (
                "Translate to English ONLY. Keep ALL Markdown formatting (##, ###, -, **, _). "
                "Keep technical terms (IEEE, RFC numbers, protocol names) as-is. "
                "Output ONLY the translated text, nothing else."
            )
        else:
            instruction = (
                "翻譯成繁體中文。保留所有 Markdown 格式（##, ###, -, **, _）。"
                "保留技術術語（IEEE, RFC 編號, 協定名稱）不翻譯。只輸出翻譯結果。"
            )
        try:
            if cfg.use_ollama:
                client = OpenAI(base_url=cfg.ollama_base_url, api_key="ollama")
                resp = client.chat.completions.create(
                    model=cfg.ollama_model,
                    messages=[{"role": "user", "content": f"{instruction}\n\n{chunk}"}],
                    temperature=0.1, max_tokens=1200,
                    extra_body={"num_ctx": 4096},
                )
            else:
                from openai import AzureOpenAI
                client = AzureOpenAI(
                    azure_endpoint=cfg.api_base_url,
                    api_key=cfg.api_key,
                    api_version=cfg.api_version,
                    timeout=90.0,
                )
                model = cfg.llm_translate or cfg.default_model
                msgs = [{"role": "user", "content": f"{instruction}\n\n{chunk}"}]
                # GPT-5.x rejects max_tokens (needs max_completion_tokens); older models
                # reject max_completion_tokens. Try the new param first, fall back.
                try:
                    resp = client.chat.completions.create(
                        model=model, messages=msgs, temperature=0.1, max_completion_tokens=4096,
                    )
                except Exception:
                    resp = client.chat.completions.create(
                        model=model, messages=msgs, temperature=0.1, max_tokens=1200,
                    )
            result = resp.choices[0].message.content or chunk
            # Verify translation quality — if >30% is still source language, return original
            zh_chars = sum(1 for c in result if '一' <= c <= '鿿')
            if is_to_en and zh_chars > len(result) * 0.3:
                return chunk  # garbled — return original
            return result
        except Exception:
            return chunk

    # Split by ## sections and translate them concurrently (each section is an
    # independent LLM call). Run the whole batch in a worker thread so the blocking
    # SDK calls don't stall the event loop / other SSE streams.
    import concurrent.futures as _cf
    sections = _re.split(r'(?=\n## )', '\n' + text)
    chunks = [s.strip() for s in sections if s.strip()]

    def _translate_all() -> list[str]:
        if not chunks:
            return []
        with _cf.ThreadPoolExecutor(max_workers=min(8, len(chunks))) as ex:
            return list(ex.map(translate_chunk, chunks))

    translated_sections = await asyncio.to_thread(_translate_all)
    translated = '\n\n'.join(translated_sections)

    return {"translated": translated, "lang": body.target_lang}


# ── History endpoints (SQLite-backed) ────────────────────────────────────────

@router.get("/history")
async def list_history(limit: int = 50) -> list:
    """Return recent sessions with summary (from SQLite, survives restarts)."""
    try:
        return list_sessions(limit=limit)
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.get("/history/{session_id}/iterations")
async def history_iterations(session_id: str) -> list:
    """Return all iterations for a historical session."""
    try:
        rows = get_session_iterations(session_id)
        if not rows:
            raise HTTPException(404, "Session not found in history")
        return rows
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.get("/history/{session_id}/iterations/{iteration_num}")
async def history_iteration_result(session_id: str, iteration_num: int) -> dict:
    """Return the full result JSON for a specific historical iteration, including cached EN translation."""
    try:
        result = get_iteration_result(session_id, iteration_num)
        if result is None:
            raise HTTPException(404, "Iteration not found")
        translation = get_translation(session_id, iteration_num)
        if translation:
            result["_translation"] = translation
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


class TranslationCacheBody(BaseModel):
    spec_document: Optional[str] = None
    edge_cases: Optional[list] = None
    validation_issues: Optional[list] = None


@router.put("/history/{session_id}/iterations/{iteration_num}/translation")
async def save_iteration_translation(session_id: str, iteration_num: int, body: TranslationCacheBody) -> dict:
    """Persist the EN translation of a spec iteration so it survives page reload."""
    try:
        save_translation(session_id, iteration_num, body.model_dump(exclude_none=True))
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


@router.delete("/history/{session_id}")
async def delete_history_session(session_id: str) -> dict:
    """Delete a historical session and all its iterations."""
    try:
        delete_session(session_id)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, f"DB error: {e}")


# ── Admin (this service's own health/switch-mode/cost-report/rate-status/
#    security-reload/demo-mode — all genuinely text-spec-exclusive or
#    naturally per-service now that this runs standalone) ────────────────────

# ── App telemetry ─────────────────────────────────────────────────────────────

class TelemetryEvent(BaseModel):
    """One semantic interaction. Mirrors the payload track.ts sends."""
    event_name: str
    event_time: Optional[str] = None
    page: Optional[str] = None
    session_id: Optional[str] = None        # browser session (sessionStorage)
    app_session_id: Optional[str] = None    # NetSpec pipeline session — the join key
    workflow: Optional[str] = None
    properties: dict = {}


class TelemetryBatch(BaseModel):
    events: list[TelemetryEvent] = []


@router.post("/events")
async def receive_events(batch: TelemetryBatch, request: Request) -> dict:
    """Accept interaction events and write them to the governed telemetry stream.

    The frontend app owns the authoritative /api/events (it sees the browser's
    request directly, so its X-Forwarded-Email is the real human). This endpoint
    is the service-side twin: it exists so the backend has the same single
    telemetry surface, so events can be posted straight at a service when
    debugging a deploy, and so identity relayed by the frontend proxy is honoured
    ahead of whatever principal this hop authenticated as.

    There is no authentication code here — the platform has already identified
    the caller by the time the request arrives.
    """
    ident = telemetry.resolve_identity(request)
    for event in batch.events[:100]:   # bound one request
        telemetry.track(
            event.event_name,
            event_type="ui_interaction",
            event_time=event.event_time,
            page=event.page,
            workflow=event.workflow,
            session_id=event.session_id,
            app_session_id=event.app_session_id,
            user_email=ident.get("user_email"),
            user_id=ident.get("user_id"),
            request_id=ident.get("request_id"),
            properties=event.properties or {},
        )
    return {"accepted": True, "count": len(batch.events[:100])}


@router.get("/health")
async def health():
    s = get_settings()
    default = s.ollama_model if s.use_ollama else (s.default_model or s.claude_model)
    def m(field: str) -> str:
        return (getattr(s, field, "") or default) if not s.use_ollama else default
    return {
        "status": "ok",
        "service": "text-spec",
        "model": default,
        "use_ollama": s.use_ollama,
        "step_models": {
            "1": m("llm_parse"),
            "2": m("llm_socratic"),
            "3": m("llm_plan"),
            "4": "httpx",
            "5": m("llm_analyze"),
            "6": m("llm_edges"),
            "7": m("llm_prd"),
            "8": m("llm_validate"),
        },
        "api_key_set": bool(s.api_key or s.anthropic_api_key or os.environ.get("API_KEY")),
        "api_key_hint": ("*****" + (s.api_key or s.anthropic_api_key or os.environ.get("API_KEY", ""))[-4:]) if len(s.api_key or s.anthropic_api_key or os.environ.get("API_KEY", "")) > 4 else "(not set)",
        "active_sessions": len(SESSIONS),
        "rate_limit_mode": s.rate_limit_mode,
        "security_rules_source": security_checker.source,
        "demo_mode": s.demo_mode,
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


@router.post("/demo-mode")
async def toggle_demo_mode(body: dict) -> dict:
    """Toggle demo replay mode on/off without restart."""
    enabled = body.get("enabled", False)
    session_id = body.get("session_id", "")  # optional: specific session to replay
    os.environ["DEMO_MODE"] = "true" if enabled else "false"
    if session_id:
        os.environ["DEMO_SESSION_ID"] = session_id
    get_settings.cache_clear()
    s = get_settings()
    return {
        "ok": True,
        "demo_mode": s.demo_mode,
        "demo_session_id": s.demo_session_id,
        "message": "🎬 Demo 錄影模式已啟用，不消耗 API Token" if enabled else "✅ 已切換回真實 API 模式",
    }


@router.post("/switch-mode")
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


@router.get("/rate-status")
async def rate_status(request: Request) -> dict:
    """Daily usage stats for the calling client — shown in frontend when in API mode."""
    s = get_settings()
    ip = _get_client_ip(request)
    return {
        "mode":          s.rate_limit_mode,
        "start_used":    _daily_count(ip, "start"),
        "start_limit":   s.daily_start_limit,
        "iterate_used":  _daily_count(ip, "iterate"),
        "iterate_limit": s.daily_iterate_limit,
        "req_min":       s.req_min_length,
        "req_max":       s.req_max_length,
        "req_warn":      s.req_warn_length,
    }


@router.post("/security/reload")
async def reload_security() -> dict:
    """Hot-reload security rules from SKILL.md without restarting backend."""
    msg = reload_security_rules()
    return {"ok": True, "message": msg, "source": security_checker.source}
