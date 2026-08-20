"""
Demo Replay 模式 — 比賽錄影用

從 DB 取出已儲存的高品質結果，用假 SSE 事件完整模擬 Pipeline 執行流程。
視覺上和真實執行完全相同，但不消耗任何 API Token。

啟用方式（backend/.env）：
  DEMO_MODE=true
  DEMO_SESSION_ID=de4b4f6b-xxxx   # 留空 = 自動選最高分
  DEMO_SPEED=1.0                   # 0.5 = 2倍速，適合錄影

流程：
  Step 1 parse       → 假事件（2s）
  Step 2 socratic    → interrupt，等使用者回答
  Step 3 plan_search → 假事件（2s）→ interrupt，等確認
  Step 4 scrape      → 假事件（5s）
  Step 5 analyze     → 假事件（6s）
  Step 6 detect_edges→ 假事件（8s）
  Step 7 gherkin     → 假事件（10s）
  Step 8 validate    → 假事件（4s）
  → complete（使用 DB 真實結果）
"""

from __future__ import annotations
import asyncio
from typing import Any, Optional

from db import list_sessions, get_session_iterations, get_iteration_result


# ── 假 Step 事件的思考文字 ───────────────────────────────────────────────────

_THOUGHTS = {
    "parse":        "解析需求語意，識別協定類型與關鍵技術指標…",
    "socratic":     "評估清晰度，生成針對性技術追問問題…",
    "plan_search":  "依據識別到的協定，規劃社群搜尋關鍵字策略…",
    "scrape":       "並行爬取 GitHub Issues 與 Hacker News 社群案例…",
    "analyze":      "分析 11 筆社群資料，萃取高頻故障模式…",
    "detect_edges": "依據社群災情，枚舉協定邊界情境與風險等級…",
    "gherkin":      "整合需求與邊界條件，生成完整 PRD 規格書…",
    "validate":     "交叉校驗規格書完整性、SLA 合理性與邊界覆蓋率…",
}

_TOOL_CALLS = {
    "analyze": [{
        "tool": "analyze_disaster_patterns", "step": 5,
        "input_summary": "分析 11 筆社群資料",
        "output_summary": "萃取 4 個高頻災情模式",
        "duration_ms": 4823,
    }],
    "detect_edges": [{
        "tool": "detect_edge_cases", "step": 6,
        "input_summary": "協定 BGP，社群災情 4 個",
        "output_summary": "生成 8 個邊界情境（高風險 3 個）",
        "duration_ms": 7241,
    }],
    "gherkin": [{
        "tool": "generate_spec_document", "step": 7,
        "input_summary": "邊界情境 8 個，協定 BGP",
        "output_summary": "生成 PRD：BGP 雙線路由備援機制，4 條需求，4 條 SLA",
        "duration_ms": 11520,
    }],
    "validate": [{
        "tool": "validate_spec", "step": 8,
        "input_summary": "需求 4 條，高風險邊界 3 個",
        "output_summary": "品質評分 85/100，通過驗證",
        "duration_ms": 3890,
    }],
}

# ── Step 配置 ─────────────────────────────────────────────────────────────────

STEP_META = {
    "parse":         {"step": 1, "title": "需求解析 + 清晰度評分",  "agent": "Kimi-K2.5",          "phase": "Phase 1"},
    "socratic":      {"step": 2, "title": "需求引導追問",            "agent": "claude-opus-4-6-2026V2","phase": "Phase 1"},
    "plan_search":   {"step": 3, "title": "自主搜尋規劃器",          "agent": "Kimi-K2.5",          "phase": "Phase 2"},
    "scrape":        {"step": 4, "title": "社群情報爬蟲",            "agent": "httpx",              "phase": "Phase 2"},
    "analyze":       {"step": 5, "title": "長文本聚類分析",          "agent": "gpt-5.4",            "phase": "Phase 2"},
    "detect_edges":  {"step": 6, "title": "邊界情境偵測引擎",        "agent": "gpt-5.4",            "phase": "Phase 3"},
    "gherkin":       {"step": 7, "title": "PRD 規格書生成",          "agent": "claude-opus-4-6-2026V2","phase": "Phase 3"},
    "validate":      {"step": 8, "title": "品質交叉校驗",            "agent": "Kimi-K2.5",          "phase": "Phase 3"},
}

# ── Mock Socratic 問題（BGP 場景）────────────────────────────────────────────

_MOCK_SOCRATIC = {
    "type": "socratic",
    "round": 1,
    "max_rounds": 5,
    "is_last_round": False,
    "clarity_score": 62,
    "threshold_met": False,
    "clarity_analysis": "需求已說明主要目標，但 BFD 啟用策略、AS-PATH 過濾細節、故障切換閾值尚未明確。",
    "questions": [
        {
            "key": "bfd_config",
            "question": "BFD（Bidirectional Forwarding Detection）是否要啟用？若是，偵測間隔與倍數如何設定？",
            "why_critical": "",
            "example_answer": "啟用，間隔 300ms，倍數 3",
            "options": ["啟用 BFD，300ms × 3", "啟用 BFD，500ms × 3", "不使用 BFD，依 BGP holdtime"],
            "closing": "您的 BFD 設計是哪一種？",
        },
        {
            "key": "failover_threshold",
            "question": "主線路故障後，切換至備援路由的最大容許時間是多少？",
            "why_critical": "",
            "example_answer": "500ms 以內",
            "options": ["≤ 500ms（快速切換）", "≤ 1 秒（一般需求）", "≤ 3 秒（允許短暫中斷）"],
            "closing": "您的 SLA 目標是哪一個？",
        },
        {
            "key": "as_path_policy",
            "question": "AS-PATH 過濾策略：哪些 AS 需要被拒絕？是否需要設定 route-map 標記優先級？",
            "why_critical": "",
            "example_answer": "過濾特定 AS，並設定 MED 值區分主備",
            "options": ["設定 route-map 標記 local-pref", "使用 AS-PATH prepending", "兩者都需要"],
            "closing": "",
        },
    ],
}

# ── Mock 搜尋計畫 ────────────────────────────────────────────────────────────

_MOCK_PLAN = {
    "type": "plan_confirm",
    "plan": [
        {"keyword": "FRRouting BGP BFD fast convergence timeout",    "source": "github", "rationale": "尋找 FRR 中 BGP+BFD 收斂超時的已知 Bug", "category": "known_bug"},
        {"keyword": "FRRouting route-map AS-PATH filter crash",       "source": "github", "rationale": "route-map 過濾器崩潰相關 Issue",         "category": "known_bug"},
        {"keyword": "BGP route flap dampening production failure",    "source": "hn",     "rationale": "生產環境路由抖動導致的事故",              "category": "production_failure"},
        {"keyword": "BGP failover 500ms convergence RFC 4271",        "source": "github", "rationale": "RFC 4271 收斂時間標準與實作差距",         "category": "rfc_interop"},
        {"keyword": "FRR BGP dual-homed redundancy configuration",   "source": "github", "rationale": "雙線路備援設定的最佳實踐",                "category": "known_bug"},
    ],
    "research_summary": "以 FRRouting 為主要分析對象，搜尋 BGP+BFD 快速收斂的已知問題與 RFC 標準差距，並搜集生產環境路由抖動的真實案例。",
    "collected_answers": {},
    "clarity_score": 82,
    "req_type": "bgp",
    "protocols": ["BGP", "BFD"],
}


# ── 主要函式 ─────────────────────────────────────────────────────────────────

def _get_demo_result(session_id: str = "") -> Optional[dict]:
    """從 DB 取得最高品質的 iteration 結果。"""
    sessions = list_sessions(limit=50)
    if not sessions:
        return None

    target = None
    if session_id:
        target = next((s for s in sessions if s["id"] == session_id), None)
    if not target:
        # 自動選最高分
        target = max(sessions, key=lambda x: x.get("best_score", 0))

    if not target:
        return None

    iters = get_session_iterations(target["id"])
    if not iters:
        return None

    # 取最高分的 iteration
    best = max(iters, key=lambda x: x.get("quality_score", 0))
    result = get_iteration_result(target["id"], best["iteration_num"])
    return result


async def run_demo_pipeline(session, cfg) -> None:
    """完整模擬 Pipeline 執行，使用 DB 真實結果，不打 API。"""
    speed = cfg.demo_speed
    demo_sid = cfg.demo_session_id

    # 取得要 replay 的結果
    result = _get_demo_result(demo_sid)
    if not result:
        await session.queue.put({"type": "error", "message": "Demo mode: 找不到可用的 DB 結果，請先生成 Demo 資料"})
        await session.queue.put({"type": "__done__"})
        return

    session.status = "running"

    async def step_start(node: str, extra_sleep: float = 0):
        meta = STEP_META[node]
        await session.queue.put({
            "type":    "step_start",
            "node":    node,
            "step":    meta["step"],
            "title":   meta["title"],
            "agent":   meta["agent"],
            "phase":   meta["phase"],
            "thought": _THOUGHTS.get(node, ""),
        })
        if extra_sleep > 0:
            await asyncio.sleep(extra_sleep / speed)

    async def step_complete(node: str, log_msg: str = ""):
        meta = STEP_META[node]
        tc = _TOOL_CALLS.get(node, [])
        await session.queue.put({
            "type":       "step_complete",
            "node":       node,
            "step":       meta["step"],
            "title":      meta["title"],
            "log_message": log_msg,
            "tool_calls": tc,
        })

    # ── Step 1: Parse ─────────────────────────────────────────────────────────
    await step_start("parse", 2.5)
    await step_complete("parse", f"需求解析完成。類型：{result.get('req_type','bgp').upper()}，識別協定：{', '.join(result.get('protocols',[])[:3])}")

    # ── Step 2: Socratic（interrupt）─────────────────────────────────────────
    await step_start("socratic", 1.5)

    # 準備 socratic interrupt 資料（更新已收集的答案為空，等使用者填）
    socratic_payload = dict(_MOCK_SOCRATIC)
    socratic_payload["collected_answers"] = {}

    session.status = "interrupted"
    session.interrupt_type = "socratic"
    session.interrupt_data = socratic_payload
    await session.queue.put({
        "type":          "interrupt",
        "interrupt_type": "socratic",
        "data":          socratic_payload,
    })

    # 等待 resume
    resume_event = asyncio.Event()
    _demo_resume_store[session.id] = {"event": resume_event, "value": None}
    await resume_event.wait()
    resume_val = _demo_resume_store.pop(session.id, {}).get("value", {})

    session.status = "running"
    session.interrupt_type = None
    session.interrupt_data = None

    # 更新 clarity score（模擬追問後提升）
    collected = {}
    if isinstance(resume_val, dict) and not resume_val.get("__skip__") and not resume_val.get("__proceed__"):
        collected = resume_val

    boosted_score = 84 if collected else 76
    await step_complete("socratic", f"第 1 輪追問，提交 {len(collected)} 個答案，重新評分 {boosted_score}/100")

    await asyncio.sleep(0.5 / speed)

    # ── Step 3: Plan Search（interrupt）──────────────────────────────────────
    await step_start("plan_search", 2.0)

    plan_payload = dict(_MOCK_PLAN)
    plan_payload["collected_answers"] = collected

    session.status = "interrupted"
    session.interrupt_type = "plan_confirm"
    session.interrupt_data = plan_payload
    await session.queue.put({
        "type":          "interrupt",
        "interrupt_type": "plan_confirm",
        "data":          plan_payload,
    })

    resume_event2 = asyncio.Event()
    _demo_resume_store[session.id] = {"event": resume_event2, "value": None}
    await resume_event2.wait()
    _demo_resume_store.pop(session.id, None)

    session.status = "running"
    session.interrupt_type = None
    session.interrupt_data = None

    await step_complete("plan_search", "搜尋計畫確認，共 5 組關鍵字")

    # ── Step 4-8：自動執行 ────────────────────────────────────────────────────
    remaining = [
        ("scrape",       5.0, "爬蟲完成：共 11 條。GitHub=8, HN=3"),
        ("analyze",      7.0, "長文本聚類分析完成，提取 4 個災情模式"),
        ("detect_edges", 9.0, "邊界偵測完成：8 個情境（High=3, Mid=3, Low=2）"),
        ("gherkin",     12.0, f"PRD 規格書生成完畢：{result.get('spec_sections',{}).get('feature_name','BGP 備援')}，4 條需求，4 條 SLA"),
        ("validate",     4.0, f"交叉校驗完成：品質評分 {result.get('validation_score',85)}/100，通過驗證"),
    ]
    for node, sleep_sec, log in remaining:
        await step_start(node, sleep_sec)
        await step_complete(node, log)
        await asyncio.sleep(0.3 / speed)

    # ── Complete ───────────────────────────────────────────────────────────────
    session.result = result
    session.status = "complete"
    session.save_iteration()

    await session.queue.put({"type": "complete", "result": result})
    await session.queue.put({"type": "__done__"})


# ── Resume 橋接（demo 模式下接收前端 resume）──────────────────────────────────

_demo_resume_store: dict = {}  # session_id → {"event": asyncio.Event, "value": Any}


def demo_resume(session_id: str, value: Any) -> bool:
    """被 resume_session 端點呼叫，喚醒等待中的 demo pipeline。"""
    entry = _demo_resume_store.get(session_id)
    if not entry:
        return False
    entry["value"] = value
    entry["event"].set()
    return True
