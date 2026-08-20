"""NetSpec LangGraph Multi-Agent Pipeline.

9 Steps:
  1. parse_requirement   – extract structured metadata from raw input
  2. score_clarity       – score 0-100, decide if Socratic needed
  3. socratic_loop       – generate clarifying questions (interrupt for human)
  4. plan_search         – generate research keyword plan (interrupt for human confirm)
  5. scrape_community    – parallel Reddit/GitHub/HN scraping
  6. analyze_disasters   – extract disaster patterns from scraped data
  7. detect_edge_cases   – enumerate ≥5 boundary scenarios with risk ratings
  8. generate_gherkin    – produce Given-When-Then acceptance test script
  9. validate_spec       – cross-validate for logical consistency
"""

from __future__ import annotations

import json
import operator
import time
from typing import Annotated, Any, Optional, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from config import get_settings
from llm_client import call_tool
from prompts import (
    ARCHITECT_VIEW_TOOL,
    CLARITY_SCORE_TOOL,
    DISASTER_ANALYSIS_TOOL,
    EDGE_CASE_TOOL,
    PARSE_AND_SCORE_TOOL,
    PARSE_REQUIREMENT_TOOL,
    QA_VIEW_TOOL,
    SEARCH_PLAN_TOOL,
    SOCRATIC_QUESTIONS_TOOL,
    SPEC_DOC_TOOL,
    SYSTEM_NETWORKING_EXPERT,
    VALIDATION_TOOL,
)
from scraper import scrape_all

# ── State ────────────────────────────────────────────────────────────────────

class LogEntry(TypedDict):
    timestamp: float
    step: int
    agent: str
    message: str


class NetSpecState(TypedDict):
    # ── Phase 1: Input & Clarity ──────────────────────────────────────────
    requirement: str
    req_type: str
    protocols: list[str]
    key_behaviors: list[str]
    constraints_mentioned: list[str]
    missing_dimensions: list[str]

    clarity_score: int
    clarity_analysis: str
    clarity_deductions: list[dict]
    socratic_round: int
    current_questions: list[dict]
    asked_questions: list[str]         # question texts (legacy, kept for reference)
    covered_dimensions: list[str]      # exact dimension strings used — reliable dedup
    all_answers: dict[str, str]
    user_wants_to_proceed: bool      # True when user explicitly clicks "進入下一步"
    user_wants_more_questions: bool  # True when user clicks "繼續追問" in InputConfirmCard

    # ── Phase 2: Community Intelligence ──────────────────────────────────
    search_plan: list[dict]
    search_plan_confirmed: bool
    scraped_data: list[dict]
    disaster_patterns: list[dict]

    # ── Phase 3: Spec Generation ──────────────────────────────────────────
    edge_cases: list[dict]
    edge_cases_en: list[dict]   # English version of edge cases
    spec_document: str          # Full PRD markdown (Traditional Chinese)
    spec_document_en: str       # Full PRD markdown (English) — generated alongside Chinese
    spec_sections: dict
    gherkin_spec: str
    gherkin_scenarios: list[dict]
    validation_issues: list[dict]
    validation_issues_en: list[dict]  # English version of validation issues
    validation_score: int
    validation_passed: bool
    validation_summary: str
    uncovered_high_edges: list[str]   # B2: HIGH edges not traced to any requirement
    detail_level: str                 # concise | standard | comprehensive (spec size/depth)

    # ── Meta ──────────────────────────────────────────────────────────────
    current_step: Annotated[int, lambda a, b: max(a, b)]
    log: Annotated[list[LogEntry], operator.add]
    _tool_calls: Annotated[list[dict], operator.add]   # per-node tool call records
    error: Optional[str]


def _log(step: int, agent: str, message: str) -> list[LogEntry]:
    return [LogEntry(timestamp=time.time(), step=step, agent=agent, message=message)]


# ── Node 1+2 (merged): Parse + Score in one LLM call ─────────────────────────

def node_parse_requirement(state: NetSpecState) -> dict:
    """Merged node: parses requirement AND scores clarity in a single LLM call."""
    answers_section = ""
    if state.get("all_answers"):
        answers_section = "\nUser clarifications: " + json.dumps(state["all_answers"], ensure_ascii=False)

    prompt = f"""Analyze this networking requirement. Do TWO things at once:
1. Extract metadata (type, protocols, behaviors, missing dimensions)
2. Score its clarity 0-100

Requirement: {state['requirement']}
{answers_section}

Clarity rubric:
- 0-39: vague, no protocols or constraints
- 40-69: partial, missing critical parameters
- 70-84: good, minor gaps
- 85-100: fully specified with quantified constraints"""

    result = call_tool(prompt, PARSE_AND_SCORE_TOOL, model=get_settings().llm_parse or get_settings().default_model)
    score = int(result.get("clarity_score") or result.get("score") or 0)
    protos = result.get("protocols", [])
    rtype  = result.get("req_type", "generic")
    return {
        "current_step": 2,
        "req_type": rtype,
        "protocols": protos,
        "key_behaviors": result.get("key_behaviors", []),
        "constraints_mentioned": result.get("constraints_mentioned", []),
        "missing_dimensions": result.get("missing_dimensions", []),
        "clarity_score": score,
        "clarity_analysis": result.get("clarity_analysis") or result.get("analysis", ""),
        "clarity_deductions": [],
        "log": (
            _log(1, "Claude", f"需求解析完成。類型：{rtype}，識別協定：{', '.join(protos[:3])}") +
            _log(2, "Claude", f"清晰度評分：{score}/100。{result.get('clarity_analysis','')[:80]}")
        ),
    }


# node_score_clarity kept as no-op for backward compatibility
def node_score_clarity(state: NetSpecState) -> dict:
    return {}


# ── Routing after clarity score ────────────────────────────────────────────────

def route_clarity(state: NetSpecState) -> str:
    """Route after parse or socratic.

    Rules:
    - Always at least 1 round
    - Max 5 rounds hard cap
    - If score >= 70: node_socratic shows "進入下一步" as primary — user decides
    - If score < 70: node_socratic shows "提交回答，繼續追問" — keeps going up to 5 rounds
    - User can always click "進入下一步" to exit early (sets user_wants_to_proceed)
    """
    settings = get_settings()
    rnd = state.get("socratic_round", 0)

    # First time: always ask
    if rnd == 0:
        return "socratic"

    # Hard cap at max rounds
    if rnd >= settings.max_socratic_rounds:
        return "plan_search"

    # User explicitly chose to proceed (clicked "進入下一步" or "跳過")
    if state.get("user_wants_to_proceed", False):
        return "plan_search"

    # Score reached threshold: interrupt showed "進入下一步" as primary.
    # If user submitted answers without clicking proceed, keep asking.
    # If user clicked proceed, user_wants_to_proceed is True (handled above).
    score = state.get("clarity_score", 0)
    if score >= settings.clarity_threshold:
        # User chose to continue despite reaching threshold → keep going
        return "socratic"

    # Score still below threshold → keep asking (up to max rounds)
    return "socratic"


# ── Translate structured list items to English ───────────────────────────────

def _translate_items_to_en(items: list[dict], text_fields: list[str]) -> list[dict]:
    """Translate specified text fields of a list of dicts to English.
    Uses a single LLM call with JSON output for efficiency.
    Falls back to original if translation fails.
    """
    if not items:
        return []
    try:
        import json as _json
        from openai import OpenAI as _OAI
        from config import get_settings as _cfg
        cfg = _cfg()
        client = _OAI(base_url=cfg.ollama_base_url, api_key="ollama")

        # Build compact input
        to_translate = [{str(i): {f: item.get(f, "") for f in text_fields}}
                        for i, item in enumerate(items)]
        prompt = (
            "Translate the following JSON values from Traditional Chinese to English. "
            "Return ONLY valid JSON with the same structure. Keep technical terms (IEEE, RFC, protocols). "
            "Input:\n" + _json.dumps(to_translate, ensure_ascii=False)
        )
        resp = client.chat.completions.create(
            model=cfg.ollama_model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1, max_tokens=3000,
            extra_body={"num_ctx": 8192},
        )
        raw = resp.choices[0].message.content or ""
        # Extract JSON
        import re as _re2
        m = _re2.search(r'\[[\s\S]*\]', raw)
        translated_list = _json.loads(m.group()) if m else []

        # Merge translated fields back
        result_items = []
        for i, item in enumerate(items):
            new_item = dict(item)
            for entry in translated_list:
                if str(i) in entry:
                    for f in text_fields:
                        if f in entry[str(i)] and entry[str(i)][f]:
                            new_item[f] = entry[str(i)][f]
            result_items.append(new_item)
        return result_items
    except Exception:
        return list(items)  # fallback: return originals


# ── SKILL question bank integration ──────────────────────────────────────────
# Load and parse the SKILL question-bank.md into sections.
# These pre-written professional questions are injected into the Socratic prompt
# so the LLM adapts them rather than generating from scratch.

import re as _re
from pathlib import Path as _Path
from functools import lru_cache as _lru_cache

_SKILL_DIR = _Path(__file__).parent.parent.parent / "skills" / "netspec-socratic" / "references"

# Map req_type → section title in question-bank.md
_QB_SECTION_MAP: dict[str, str] = {
    "bgp":       "路由協定",
    "ospf":      "路由協定",
    "vlan":      "VLAN",
    "stp":       "VLAN",
    "lacp":      "VLAN",
    "qos":       "QoS",
    "firewall":  "高可用性",   # closest match; firewall uses HA + general
    "generic":   "通用問題",
}


@_lru_cache(maxsize=1)
def _load_question_bank() -> dict[str, str]:
    """Parse question-bank.md into a dict {section_name: section_text}."""
    path = _SKILL_DIR / "question-bank.md"
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    sections: dict[str, str] = {}
    current_section = "通用問題"
    current_lines: list[str] = []
    for line in text.splitlines():
        m = _re.match(r"^## (.+)", line)
        if m:
            if current_lines:
                sections[current_section] = "\n".join(current_lines).strip()
            current_section = m.group(1).strip()
            current_lines = []
        else:
            current_lines.append(line)
    if current_lines:
        sections[current_section] = "\n".join(current_lines).strip()
    return sections


@_lru_cache(maxsize=1)
def _load_question_dimensions() -> str:
    """Load the 10-dimension Spec framework for text-pipeline Socratic questioning."""
    path = _SKILL_DIR / "question-dimensions.md"
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def _find_section(bank: dict[str, str], keyword: str) -> str:
    """Find a bank section by partial keyword match (case-insensitive)."""
    kw = keyword.lower()
    for name, text in bank.items():
        if kw in name.lower():
            return text
    return ""


def _parse_skill_question_blocks(section_text: str) -> list[dict]:
    """Parse a question bank section into structured question dicts.

    Each dict has: question, options (list), closing, type (🔍/⚠️/📏), version (PM/技術)
    """
    blocks: list[dict] = []
    lines = section_text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        # Detect question start (emoji prefix line)
        q_type = None
        version = "PM"
        if "🔍" in line: q_type = "explore"
        elif "⚠️" in line: q_type = "edge"
        elif "📏" in line: q_type = "accept"
        if q_type:
            version = "技術" if "技術版" in line else "PM"
            i += 1
            question = ""
            options: list[str] = []
            closing = ""
            in_options = False
            while i < len(lines):
                l = lines[i]
                if l.strip() == "---" or (l.startswith("## ") or l.startswith("### ")):
                    break
                if l.startswith("> ") and not question and "💡" not in l:
                    question = l[2:].strip()
                elif "💡" in l:
                    in_options = True
                elif in_options and l.startswith("> - **"):
                    # Extract option text (strip markdown bold)
                    opt = l[2:].strip().lstrip("- ")
                    opt = _re.sub(r"\*\*(.+?)\*\*", r"\1", opt)
                    opt = opt.split("**")[0].split("：")[0].strip()
                    if opt: options.append(opt)
                elif l.startswith("> 您的設計") or l.startswith("> 您的需求") or l.startswith("> 您的目標"):
                    closing = l[2:].strip()
                    i += 1
                    break
                i += 1
            if question:
                blocks.append({
                    "question": question,
                    "options": options[:4],
                    "closing": closing or "您的設計是哪一種？或者有其他考量？",
                    "type": q_type,
                    "version": version,
                })
            continue
        i += 1
    return blocks


def _get_skill_questions_structured(req_type: str, rnd: int, already_covered: int = 0) -> list[dict]:
    """Return up to 3 structured questions from the SKILL question bank.

    Round 1 → 1 general (🔍 explore) + 2 domain
    Round 2+ → 1 general (⚠️ edge) + 2 domain (different ones)
    Returns [] if bank unavailable.
    """
    bank = _load_question_bank()
    if not bank:
        return []

    domain_keyword = _QB_SECTION_MAP.get(req_type, "通用問題")
    general_text   = _find_section(bank, "通用問題")
    domain_text    = _find_section(bank, domain_keyword)

    general_blocks = _parse_skill_question_blocks(general_text)
    domain_blocks  = _parse_skill_question_blocks(domain_text)

    # Rotate through blocks based on round to avoid repeats
    offset = (rnd - 1) * 2

    if rnd == 1:
        picks  = [b for b in general_blocks if b["type"] == "explore"][:1]
        picks += [b for b in domain_blocks if b["type"] == "explore"][:2]
    else:
        picks  = [b for b in general_blocks if b["type"] in ("edge", "accept")][offset:offset+1]
        picks += (domain_blocks + [b for b in general_blocks])[offset:offset+2]

    # Deduplicate by question text
    seen: set[str] = set()
    result: list[dict] = []
    for b in picks:
        if b["question"] not in seen:
            seen.add(b["question"])
            result.append(b)
    return result[:3]


def _get_skill_questions(req_type: str, rnd: int) -> str:
    """Return SKILL questions as a plain-text hint for the LLM prompt (fallback only)."""
    blocks = _get_skill_questions_structured(req_type, rnd)
    if not blocks:
        return ""
    lines = ["\n\n以下是 SKILL 題庫的參考問題格式（請參考這個風格提問）：\n"]
    for b in blocks[:2]:
        lines.append(f"> {b['question']}")
        if b["options"]:
            lines.append("> 💡 選項：" + " / ".join(b["options"]))
        lines.append(f"> {b['closing']}\n")
    return "\n".join(lines)


# ── Method A: Re-score enriched requirement after Socratic answers ────────────

def _rescore_with_answers(
    requirement: str,
    req_type: str,
    protocols: list[str],
    all_answers: dict[str, str],
    fallback_score: int,
) -> int:
    """Re-score requirement clarity after Socratic answers — DETERMINISTIC.

    The clarity score is informational only: it sets `threshold_met` (which UI
    button is primary), but `route_clarity` routes purely on round-cap / user
    choice, never on the score. So we use a cheap deterministic boost instead of
    a separate blocking LLM call each round (up to 5 serial roundtrips removed
    from the interactive critical path). Score only ever increases (≥ parse score).
    """
    if not all_answers:
        return fallback_score  # no answers yet → keep parse score

    meaningful = sum(
        1 for k, v in all_answers.items()
        if isinstance(v, str) and len(v.strip()) > 5
        and k not in ("__proceed__", "__skip__", "__continue__")
    )
    return max(fallback_score, min(100, fallback_score + meaningful * 8))


# ── Dimension pools per req_type ──────────────────────────────────────────────
# Each pool lists distinct technical dimensions to cover across Socratic rounds.
# The model is instructed to pick 3 uncovered dimensions each round.

_DIMENSION_POOLS: dict[str, list[str]] = {
    "vlan": [
        "VLAN ID 範圍（1–4094, IEEE 802.1Q）",
        "端口模式：Access / Trunk / Hybrid，PVID 設定",
        "Native VLAN 與 802.1Q 標籤（tagged/untagged）行為",
        "Trunk 端口 Allowed VLAN 清單（permit/prune）",
        "Inter-VLAN Routing：L3 交換或路由器-on-a-stick",
        "VLAN 數量上限與硬體 TCAM 限制",
        "管理 VLAN（OOB 帶外管理）隔離需求",
        "DHCP Snooping / Dynamic ARP Inspection（DAI）",
        "STP / RSTP / MSTP 相容性（802.1D/802.1w/802.1s）",
        "VLAN 存取控制（VACL / ACL）策略",
    ],
    "bgp": [
        "本地 AS 號碼與 BGP 類型（iBGP/eBGP，RFC 4271）",
        "Peer IP 位址與 MD5 TCP 認證（RFC 2385）",
        "Hold Timer / Keepalive Timer 設定（預設 90s/30s）",
        "BFD 雙向轉送偵測最小計時器（RFC 5880）",
        "ECMP 等價多路徑數量上限（max-paths）",
        "Route Policy：Prefix-list / Route-map / Community 屬性",
        "BGP Graceful Restart（RFC 4724）與 NSR",
        "Route Flap Damping（RFC 2439）參數設定",
        "MED 屬性跨 AS 比較策略（always-compare-med）",
        "Next-Hop 遞迴解析深度與 IGP 整合",
    ],
    "firewall": [
        "安全區域（Zone）定義：Untrust / DMZ / Trust 拓墣",
        "規則匹配語義：First-Match vs Best-Match",
        "Stateful Inspection 連線追蹤表大小上限",
        "L4 5-tuple 過濾 + L7 DPI 應用識別深度",
        "NAT 類型：SNAT / DNAT / PAT 轉換規則",
        "ACL 規則數量上限（硬體 TCAM 容量）",
        "防火牆日誌：Syslog / SNMP Trap / Flow 稽核",
        "IPS / IDS 整合與 Fail-open vs Fail-close",
        "高可用性：Active-Active / Active-Standby + 狀態同步",
        "QoS 優先級標記（DSCP/CoS）與頻寬限速",
    ],
    "ospf": [
        "OSPF Area 設計：Backbone Area 0 / Stub / NSSA（RFC 2328）",
        "Router ID 選擇策略",
        "Hello / Dead Interval 計時器（預設 10s/40s）",
        "認證機制：Simple / MD5（RFC 2154）",
        "OSPF Cost 計算基準（reference-bandwidth）",
        "LSA 類型與 ABR / ASBR 角色規劃",
        "路由摘要（Summarization）策略",
        "Passive Interface 防止非預期 Neighbor 建立",
        "Default Route 注入（default-information originate）",
        "Fast Convergence：BFD 整合 + SPF 計算間隔",
    ],
    "generic": [
        "目標硬體平台或晶片架構（Broadcom / Marvell / Intel）",
        "預期最大吞吐量（Gbps / MPPS）",
        "故障切換時間 SLA（RTO / RPO）",
        "高可用性部署模式（主備 / 叢集）",
        "管理協議：CLI / NETCONF / RESTCONF / SNMP",
        "日誌與監控整合（Syslog / SNMP / Telemetry）",
        "認證與存取控制（TACACS+ / RADIUS / 802.1X）",
        "QoS 優先級需求（語音 / 視訊 / 資料分級）",
        "版本相容性與韌體升級策略",
        "合規要求（ISO 27001 / PCI-DSS / 等級保護）",
    ],
}

def _get_dimensions(req_type: str, covered: list[str]) -> tuple[list[str], list[str]]:
    """Return (remaining_dimensions, all_dimensions) for this req_type.

    Uses exact string match against covered_dimensions — reliable dedup.
    """
    pool = _DIMENSION_POOLS.get(req_type, _DIMENSION_POOLS["generic"])
    covered_set = set(covered)
    remaining = [d for d in pool if d not in covered_set]
    return remaining, pool


# ── Node 3: Socratic Questions ────────────────────────────────────────────────

def node_socratic(state: NetSpecState) -> dict:
    settings = get_settings()
    rnd = state.get("socratic_round", 0) + 1
    answered_keys = set(state.get("all_answers", {}).keys())
    current_score = state.get("clarity_score", 0)
    is_last_round = (rnd >= settings.max_socratic_rounds)
    threshold_met = (current_score >= settings.clarity_threshold)

    prev_questions: list[str]    = state.get("asked_questions", [])
    covered_dims:  list[str]    = state.get("covered_dimensions", [])
    req_type = state.get("req_type", "generic")

    # Use exact-string dimension tracking for reliable dedup
    remaining_dims, all_dims = _get_dimensions(req_type, covered_dims)
    # Pick 3 uncovered dimensions; wrap around if pool exhausted
    if len(remaining_dims) >= 3:
        target_dims = remaining_dims[:3]
    else:
        # Wrap around: restart from pool beginning (skip only most-recently-covered)
        recently_covered = set(covered_dims[-3:])
        wrap_pool = [d for d in all_dims if d not in recently_covered]
        target_dims = (remaining_dims + wrap_pool)[:3]

    # Build structured question specs from the target dimensions
    # example_answer comes from the dimension pool (pre-defined, not model-generated)
    # This prevents the model from writing overly long example answers.
    def _dim_to_answer(dim: str) -> str:
        """Extract example value from parentheses, or derive from label."""
        import re
        m = re.search(r'（([^）]{3,30})）', dim)
        return m.group(1) if m else dim.split("：")[-1].split("/")[0][:20]

    q_specs = []
    for i, dim in enumerate(target_dims[:3], 1):
        short = dim.split("（")[0].split("，")[0][:18]
        ans   = _dim_to_answer(dim)[:22]
        q_specs.append((i, short, ans))

    # ── LLM generates questions from 10-dimension framework (always dynamic) ──────
    dimensions_guide = _load_question_dimensions()
    domain_hint = _get_skill_questions(req_type, rnd)   # protocol examples as style reference only
    covered_str = "、".join(covered_dims[-6:]) if covered_dims else "無"
    prev_short  = "、".join(q[:15] for q in prev_questions[:5]) if prev_questions else "無"
    specs_block = "\n".join(f"  {i}. {s}（建議答案格式：{a}）" for i, s, a in q_specs)

    prompt = f"""你是資深企業網通架構師，正在為一份網通規格書補充關鍵技術細節。
根據以下需求，從「Spec 追問維度框架」中挑選 3 個最關鍵的尚未釐清維度，各產生一個精確的澄清問題。

## 用戶需求
{state['requirement'][:400]}
需求類型：{req_type.upper()}

## 本輪建議聚焦維度（依需求類型選定）
{specs_block}

## Spec 追問維度框架
{dimensions_guide}

## 已釐清維度（勿重複）：{covered_str}
## 已問過問題（勿重複）：{prev_short}
{domain_hint}
## 選項品質範例（options 欄位必須達到這個水準）

範例 1 — HA 策略問題：
  question: 這個功能需要哪種高可用性機制？
  options: ["Active-Standby 主備切換", "ECMP 負載分擔", "VRRP 虛擬路由器冗餘", "無 HA 需求（單點接受）"]
  closing: 您的部署是哪一種？或者有其他考量？

範例 2 — 收斂時間問題：
  question: 鏈路故障後路由收斂時間要求為何？
  options: ["< 1 秒（需 BFD 搭配）", "1-3 秒（Timer 調小）", "< 30 秒（預設 Timer）", "無嚴格要求"]
  closing: 您的 SLA 是哪一級？或者有其他考量？

範例 3 — 錯誤處理問題：
  question: Config 套用失敗時，系統應如何處理？
  options: ["立即停止並告警，人工介入", "自動回滾至上一個穩定版本", "略過失敗項目繼續套用其他"]
  closing: 您的設計是哪一種？或者有其他考量？

## 輸出規則
- question：繁體中文直接問句，≤ 30 字
- options：2-4 個具體技術選項，每項 ≤ 20 字，必須是真實的技術架構決策值
- closing：引導收尾句，固定格式「您的設計是哪一種？或者有其他考量？」
- example_answer：對應 options[0] 的值
- 優先問 SLA 數字、HA 策略、錯誤處理、邊界條件等高影響力維度"""

    try:
        result = call_tool(prompt, SOCRATIC_QUESTIONS_TOOL, model=get_settings().llm_socratic or get_settings().default_model)
        questions = result.get("questions", [])
    except Exception as exc:
        print(f"[node_socratic] LLM call failed, using fallback questions: {type(exc).__name__}: {exc}")
        questions = []

    if not questions:
        questions = [
            {
                "key": f"dim{i}",
                "question": f"{short}？",
                "options": [ans, "不適用"],
                "closing": "您的設計是哪一種？或者有其他考量？",
                "example_answer": ans,
            }
            for i, short, ans in q_specs
        ]

    # Patch example_answer from q_specs if LLM output is missing or too long
    spec_answers = {str(i): a for i, _, a in q_specs}
    for idx, q in enumerate(questions):
        ea = q.get("example_answer", "")
        if not ea or len(ea) > 30:
            q["example_answer"] = spec_answers.get(str(idx + 1), "")

    # ── Human-in-the-loop ─────────────────────────────────────────────────────
    # Frontend shows different UI based on threshold_met:
    #   threshold_met  → primary: "進入下一步", secondary: "繼續追問"
    #   !threshold_met → primary: "提交回答", secondary: "直接跳過"
    #   is_last_round  → only "提交回答（最後一輪）", auto-proceeds after submit
    answers = interrupt({
        "type":           "socratic",
        "round":          rnd,
        "max_rounds":     settings.max_socratic_rounds,
        "is_last_round":  is_last_round,
        "questions":      questions,
        "clarity_score":  current_score,
        "threshold_met":  threshold_met,
        "clarity_analysis": (state.get("clarity_analysis", "") or "")[:150],  # truncate to prevent balloon payloads
    })
    # ─────────────────────────────────────────────────────────────────────────

    # Parse what user sent back:
    #   {"__proceed__": True}   → user clicked "進入下一步" (proceed without more answers)
    #   {"__skip__":    True}   → user clicked "直接跳過"   (proceed, no more input)
    #   {key: value, ...}       → user submitted answers
    # If every submitted answer is "不適用" (all N/A), treat as skip — don't loop back
    _all_na = bool(answers) and all(
        str(v).strip() in ("不適用", "") for k, v in (answers or {}).items()
        if k not in ("__proceed__", "__skip__", "__continue__")
    ) and not answers.get("__proceed__") and not answers.get("__skip__")
    if _all_na:
        answers = {"__skip__": True}

    user_proceeds = not answers or answers.get("__proceed__") or answers.get("__skip__") or is_last_round

    if user_proceeds and (not answers or answers.get("__proceed__") or answers.get("__skip__")):
        # Keep existing answers, don't add new ones
        merged = state.get("all_answers", {})
    else:
        # Merge new answers
        filtered = {k: v for k, v in (answers or {}).items()
                    if k not in ("__proceed__", "__skip__") and v}
        merged = {**state.get("all_answers", {}), **filtered}

    action_label = "進入下一步" if (answers or {}).get("__proceed__") else \
                   "跳過" if (answers or {}).get("__skip__") else \
                   f"提交 {len(merged)} 個答案"

    # ── Method A: Re-score the enriched requirement with LLM ─────────────────
    # Build an enriched requirement combining the original text + all collected answers.
    # This gives the LLM the full picture of what the user actually wants.
    boosted = _rescore_with_answers(
        requirement=state["requirement"],
        req_type=req_type,
        protocols=state.get("protocols", []),
        all_answers=merged,
        fallback_score=current_score,  # never go below parse score
    )

    new_asked = list(dict.fromkeys(
        prev_questions + [q.get("question", "") for q in questions if q.get("question")]
    ))
    # Accumulate covered dimensions (exact strings) for next-round dedup
    new_covered = list(dict.fromkeys(covered_dims + target_dims))
    wants_more = bool(answers and answers.get("__continue__"))

    return {
        "current_step":               3,
        "socratic_round":             rnd,
        "current_questions":          questions,
        "asked_questions":            new_asked,
        "covered_dimensions":         new_covered,
        "all_answers":                merged,
        "clarity_score":              boosted,
        "user_wants_to_proceed":      bool(user_proceeds),
        "user_wants_more_questions":  wants_more,
        "log": _log(3, "qwen2.5",
                    f"第 {rnd}/{settings.max_socratic_rounds} 輪追問，{action_label}，重新評分 {boosted}/100（語意重算）。"),
    }


# ── Node 4: Plan Search (with human interrupt for confirmation) ───────────────

def node_plan_search(state: NetSpecState) -> dict:

    # ── Context assembly ──────────────────────────────────────────────────────
    req_type  = state.get("req_type", "generic")
    protocols = state.get("protocols", [])
    answers   = state.get("all_answers", {})

    # Socratic answers give the most specific technical context
    answers_text = ""
    if answers:
        filtered = {k: v for k, v in answers.items()
                    if v and v not in ("不適用", "__skip__", "__proceed__")}
        if filtered:
            answers_text = "Technical details from user:\n" + "\n".join(
                f"  - {k}: {v}" for k, v in list(filtered.items())[:6]
            )

    # Map protocol/req_type to known authoritative open-source repos
    _REPO_MAP = {
        "bgp":       ["FRRouting/frr", "BIRD-Protocol/bird", "openbgpd-portable/openbgpd-portable"],
        "ospf":      ["FRRouting/frr", "BIRD-Protocol/bird"],
        "vlan":      ["sonic-net/sonic-buildimage", "openvswitch/ovs", "FRRouting/frr"],
        "stp":       ["sonic-net/sonic-buildimage", "openvswitch/ovs"],
        "firewall":  ["netfilter/nftables", "pfsense/pfsense", "vyos/vyos-1x"],
        "qos":       ["FRRouting/frr", "torvalds/linux"],
        "nat":       ["netfilter/nftables", "vyos/vyos-1x"],
        "dhcp":      ["isc-projects/kea", "isc-projects/dhcp"],
        "lacp":      ["torvalds/linux", "sonic-net/sonic-buildimage"],
        "mpls":      ["FRRouting/frr", "openvswitch/ovs"],
        "vxlan":     ["FRRouting/frr", "openvswitch/ovs"],
        "multicast": ["FRRouting/frr"],
        "generic":   ["FRRouting/frr", "sonic-net/sonic-buildimage", "openvswitch/ovs"],
    }
    repos = _REPO_MAP.get(req_type, _REPO_MAP["generic"])
    repo_hint = ", ".join(f"github.com/{r}" for r in repos[:2])

    proto_str = ', '.join(protocols[:3]) or req_type
    prompt = f"""Generate 5 search queries to find production failures and known bugs for this networking feature.

Feature: {state['requirement'][:150]}
Domain: {req_type.upper()}, Protocols: {proto_str}
Key GitHub repos: {repo_hint}
{answers_text}

For each query provide: keyword (English, 3-8 words), source (github/hn/reddit), rationale (one sentence).
Include: 2-3 GitHub bug queries, 1 production failure (hn), 1 security/CVE query.
Keep output concise."""

    try:
        result = call_tool(prompt, SEARCH_PLAN_TOOL, model=get_settings().llm_plan or get_settings().default_model)
        plan = result.get("queries", [])
    except Exception:
        result = {}
        plan = []

    # Fallback: if LLM failed or returned empty plan, generate minimal default queries
    if not plan:
        plan = [
            {"keyword": f"{proto_str} bug issue", "source": "github", "rationale": "Search for known bugs"},
            {"keyword": f"{proto_str} production failure", "source": "hn", "rationale": "Real-world failures"},
            {"keyword": f"{proto_str} CVE vulnerability", "source": "github", "rationale": "Security issues"},
        ]

    # Interrupt for human confirmation — also sends back collected answers so UI can show review
    confirmed_plan = interrupt({
        "type": "plan_confirm",
        "plan": plan,
        "research_summary": result.get("research_summary", ""),
        "collected_answers": state.get("all_answers", {}),
        "covered_dimensions": state.get("covered_dimensions", []),  # for "繼續追問" restart
        "clarity_score": state.get("clarity_score", 0),
        "req_type": state.get("req_type", "generic"),
        "protocols": state.get("protocols", []),
    })

    # If user modified keywords, update the plan
    if isinstance(confirmed_plan, dict) and confirmed_plan.get("modified_keywords"):
        for i, kw in enumerate(confirmed_plan["modified_keywords"]):
            if i < len(plan):
                plan[i]["keyword"] = kw

    return {
        "current_step": 4,
        "search_plan": plan,
        "search_plan_confirmed": True,
        "log": _log(4, "Claude", f"搜尋計畫生成，共 {len(plan)} 組關鍵字。{result.get('research_summary', '')[:80]}"),
    }


# ── Node 5: Scrape Community ──────────────────────────────────────────────────

async def node_scrape_community(state: NetSpecState) -> dict:
    settings = get_settings()
    plan = state.get("search_plan", [])

    if not plan:
        return {
            "current_step": 5,
            "scraped_data": [],
            "log": _log(5, "Playwright", "搜尋計畫為空，跳過爬蟲。"),
        }

    try:
        items = await scrape_all(plan, github_token=settings.github_token)
    except Exception as exc:
        # Scraping is network-dependent and supplementary — never let it kill the
        # pipeline. Degrade to no community data; analyze/PRD continue without it.
        return {
            "current_step": 5,
            "scraped_data": [],
            "log": _log(5, "Playwright",
                        f"爬蟲失敗（{type(exc).__name__}: {str(exc)[:80]}），跳過社群情報，不影響後續規格生成。"),
        }
    sources = {"reddit": 0, "github": 0, "hn": 0}
    for item in items:
        s = item.get("source", "")
        if s in sources:
            sources[s] += 1

    return {
        "current_step": 5,
        "scraped_data": items,
        "log": _log(5, "Playwright",
                    f"爬蟲完成：共 {len(items)} 條。Reddit={sources['reddit']}, GitHub={sources['github']}, HN={sources['hn']}"),
    }


# ── Node 6: Analyze Disasters ─────────────────────────────────────────────────

def node_analyze_disasters(state: NetSpecState) -> dict:
    scraped = state.get("scraped_data", [])

    if not scraped:
        return {
            "current_step": 6,
            "disaster_patterns": [],
            "log": _log(6, "Claude", "無爬蟲資料，跳過災情分析。"),
        }

    # Build indexed source list so the LLM can reference URLs by number
    indexed_sources: list[dict] = []
    for i, item in enumerate(scraped[:15], 1):
        indexed_sources.append({
            "index": i,
            "source": item.get("source", ""),
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "content": item.get("content", "")[:300],
        })

    content_text = "\n\n".join(
        f"[{s['index']}] [{s['source'].upper()}] {s['title']}\nURL: {s['url']}\n{s['content']}"
        for s in indexed_sources
    )

    prompt = f"""你是資深網路工程師，正在分析社群真實事故報告以萃取災情模式。
請將所有輸出（title、description、root_cause、mitigation、source_evidence）全部使用繁體中文撰寫。
即使社群資料來源為英文，仍需翻譯為繁體中文後輸出。

正在開發的功能：{state['requirement']}
協定：{', '.join(state.get('protocols', []))}

社群資料（每筆資料有索引編號和 URL）：
{content_text}

請萃取 3-6 個在正式環境中頻繁出現的災情模式（故障模式）。
每個模式需包含：
- 故障描述
- 根本原因與緩解建議
- 在 source_evidence 中標注哪些索引（如 [1]、[3]）支持此模式，以便追溯原始 URL"""

    _t0 = time.time()
    try:
        result = call_tool(prompt, DISASTER_ANALYSIS_TOOL, model=get_settings().llm_analyze or get_settings().default_model)
        patterns = result.get("patterns", [])
    except Exception:
        result = {}
        patterns = []   # graceful fallback — pipeline continues without disaster patterns
    # malformed LLM output → keep only well-formed dict entries (never raise downstream)
    patterns = [p for p in patterns if isinstance(p, dict)] if isinstance(patterns, list) else []

    _tc_analyze = [{"tool": "analyze_disaster_patterns", "step": 6,
                    "input_summary": f"分析 {len(indexed_sources)} 筆社群資料",
                    "output_summary": f"萃取 {len(patterns)} 個災情模式" if patterns else "分析失敗，跳過（不影響規格書生成）",
                    "duration_ms": int((time.time() - _t0) * 1000)}]

    # Attach source URLs to each pattern by matching index references in source_evidence
    import re as _re
    for pattern in patterns:
        if not isinstance(pattern, dict):
            continue   # skip malformed entries instead of raising
        evidence = pattern.get("source_evidence", "")
        # Find all [N] references in the evidence text
        indices = [int(m) for m in _re.findall(r'\[(\d+)\]', evidence)]
        source_urls = []
        for idx in indices:
            matching = [s for s in indexed_sources if s["index"] == idx]
            if matching and matching[0]["url"]:
                source_urls.append({
                    "source": matching[0]["source"],
                    "title": matching[0]["title"],
                    "url": matching[0]["url"],
                })
        # Also try fallback: attach top-scored URLs if no index refs found
        if not source_urls and indexed_sources:
            top = indexed_sources[0]
            if top["url"]:
                source_urls.append({"source": top["source"], "title": top["title"], "url": top["url"]})
        pattern["source_urls"] = source_urls

    return {
        "current_step": 6,
        "disaster_patterns": patterns,
        "_tool_calls": _tc_analyze,
        "log": _log(6, "Claude (Kimi 角色)",
                    f"長文本聚類分析完成，提取 {len(patterns)} 個災情模式。代表災情：{patterns[0]['title'] if patterns else '無'}"),
    }


# ── Node 7: Detect Edge Cases ─────────────────────────────────────────────────

def node_detect_edge_cases(state: NetSpecState) -> dict:

    disaster_text = ""
    if state.get("disaster_patterns"):
        disaster_text = "\n\nKnown disaster patterns from community:\n" + "\n".join(
            f"- {p['title']}: {p['description']}"
            for p in state["disaster_patterns"][:5]
        )

    answers_text = ""
    if state.get("all_answers"):
        answers_text = "\n\nSpecific parameters from user:\n" + json.dumps(state["all_answers"], ensure_ascii=False)

    prompt = f"""請列舉此網通功能的所有關鍵邊界條件與異常情境。
所有輸出（title、description、trigger_condition、impact、detection）請使用繁體中文撰寫。

功能：{state['requirement']}
類型：{state.get('req_type', 'generic')}
協定：{', '.join(state.get('protocols', []))}
關鍵行為：{', '.join(state.get('key_behaviors', []))}
{disaster_text}
{answers_text}

請生成至少 7 個邊界情境，涵蓋：
1. 極端封包大小 / 速率
2. 硬體資源上限（TCAM、記憶體、CPU）
3. 協定計時器競爭 / 順序問題
4. 多廠商互通性
5. 斷電 / 重啟情境
6. 並發操作 / 競態條件
7. 降級 / 優雅回退路徑

每個情境需標明：
- **風險等級 risk（high/mid/low）**，依下列準則判定（讓等級可稽核，不要憑感覺）：
    · high＝會造成服務中斷、違反 SLA，或使安全策略失效（如短暫越權）。
    · mid＝功能降級但可自行恢復、效能明顯下降。
    · low＝邊角體驗或極罕見、影響有限。
- **trigger_condition**：明確的觸發條件。
- **impact**：影響範圍，**務必量化**（受影響流量/使用者比例、SLA 違約程度、安全暴露窗口長度…擇一具體描述，不要只寫『可能異常』）。
- **detection**：QA 如何偵測（具體指令／計數器／封包擷取作法）。"""

    _t0 = time.time()
    try:
        result = call_tool(prompt, EDGE_CASE_TOOL, model=get_settings().llm_edges or get_settings().default_model)
    except Exception as exc:
        # Degrade gracefully — edge detection runs in parallel with analyze and feeds
        # PRD gen; a failure here should not abort the run (PRD node degrades too).
        print(f"[detect_edges] degraded: {exc}")
        result = {"edge_cases": []}
    edge_cases = result.get("edge_cases", [])

    high_count = sum(1 for e in edge_cases if e.get("risk") == "high")
    mid_count = sum(1 for e in edge_cases if e.get("risk") == "mid")
    low_count = sum(1 for e in edge_cases if e.get("risk") == "low")

    _tc_edges = [{"tool": "detect_edge_cases", "step": 7,
                  "input_summary": f"協定：{', '.join(state.get('protocols', [])[:3]) or state.get('req_type', '')}，社群災情：{len(state.get('disaster_patterns', []))} 個",
                  "output_summary": f"生成 {len(edge_cases)} 個邊界情境（高風險 {high_count} 個）",
                  "duration_ms": int((time.time() - _t0) * 1000)}]

    return {
        "current_step": 7,
        "edge_cases":    edge_cases,
        "edge_cases_en": [],
        "_tool_calls": _tc_edges,
        "log": _log(7, "Claude",
                    f"邊界偵測完成：{len(edge_cases)} 個情境（High={high_count}, Mid={mid_count}, Low={low_count}）"),
    }


# ── Edge-case → requirement traceability (B2) ────────────────────────────────
# Edge cases get stable EC-N labels by list order (state["edge_cases"] order is
# identical in the PRD-gen and validate nodes), so requirements can reference them
# in `covers_edge_cases` and we can deterministically audit HIGH-risk coverage.

def _edge_label(i: int) -> str:
    return f"EC-{i + 1}"

def _label_to_title(edge_cases: list[dict]) -> dict[str, str]:
    return {_edge_label(i): (e.get("title") or "") for i, e in enumerate(edge_cases)}

def _uncovered_high_edges(edge_cases: list[dict], reqs: list[dict]) -> list[str]:
    """Deterministically return the HIGH-risk edge labels not referenced by any
    requirement's covers_edge_cases. Matches by the integer in the label so
    'EC-1' / 'EC1' / '1' all count."""
    high_nums = {i + 1 for i, e in enumerate(edge_cases) if e.get("risk") == "high"}
    if not high_nums:
        return []
    covered: set[int] = set()
    for r in reqs:
        for c in (r.get("covers_edge_cases") or []):
            m = _re.search(r"(\d+)", str(c))
            if m:
                covered.add(int(m.group(1)))
    return [f"EC-{n}" for n in sorted(high_nums - covered)]


# ── Spec detail-level presets (controls size/depth) ──────────────────────────
_DETAIL_PRESETS = {
    "concise": {
        "req": "3 條以內（精簡，只保留最核心的 Must Have）",
        "ac": "每條 1–2 條最關鍵驗收標準",
        "verbosity": "描述精簡，每條 1–2 句",
        "edge_risk": {"high"},          # §4 只顯示 High
        "include_disaster": False,       # 省略 §5 社群災情
        "include_open_q": False,         # 省略 §7 開放問題
    },
    "standard": {
        "req": "3–5 條（依功能複雜度決定，不必硬湊）",
        "ac": "每條 2–3 條",
        "verbosity": "描述適中",
        "edge_risk": {"high", "mid"},
        "include_disaster": True,
        "include_open_q": True,
    },
    "comprehensive": {
        "req": "5–8 條（完整涵蓋各面向）",
        "ac": "每條 3–4 條",
        "verbosity": "描述詳細、含技術深度（QA 可直接套用為測試計畫）",
        "edge_risk": {"high", "mid", "low"},
        "include_disaster": True,
        "include_open_q": True,
    },
}

def _detail(level: str | None) -> dict:
    return _DETAIL_PRESETS.get(level or "standard", _DETAIL_PRESETS["standard"])


# ── Node 8: Generate PRD Spec Document ───────────────────────────────────────
# Target readers: PM (business objective), Architect (technical reqs),
#                 QA Engineer (acceptance criteria)

def node_generate_gherkin(state: NetSpecState) -> dict:  # name kept for graph compat
    edge_cases = state.get("edge_cases", [])
    protocols  = state.get("protocols", [])
    answers    = state.get("all_answers", {})

    # Label every edge case EC-N (by list order) for traceability (B2).
    ec_labeled = "\n".join(
        f"  {_edge_label(i)} [{(e.get('risk') or '').upper()}] {e.get('title','')}: {(e.get('description') or '')[:90]}"
        for i, e in enumerate(edge_cases[:8])
    ) or "（無）"
    high_labels = [_edge_label(i) for i, e in enumerate(edge_cases) if e.get("risk") == "high"]

    disaster_text = "\n".join(
        f"  - {p['title']}: {p['description'][:80]}"
        for p in state.get("disaster_patterns", [])[:3]
    )

    answers_text = "\n".join(f"  {k}: {v}" for k, v in answers.items()) if answers else "（無補充說明）"
    d = _detail(state.get("detail_level"))   # 詳細度：concise / standard / comprehensive

    prompt = f"""請為以下企業網通功能撰寫 PRD 規格書，輸出有效的 JSON，所有文字欄位請使用繁體中文。

詳細度：{state.get('detail_level','standard')}（{d['verbosity']}）
功能需求：{state['requirement'][:200]}
類型：{state.get('req_type','generic')} | 協定：{', '.join(protocols[:4])}
使用者補充說明：{answers_text[:200]}
社群災情參考：{disaster_text[:200] if disaster_text else '無'}

邊界情境清單（每條有 EC 編號，請在對應需求的 covers_edge_cases 標註涵蓋哪些 EC）：
{ec_labeled}
⚠️ 高風險（必須各自被至少一條 Must Have 需求涵蓋）：{', '.join(high_labels) or '無'}

必要 JSON 欄位（全部繁體中文，選填欄位在沒有充分資訊時可省略）：
- feature_name: 10 字以內功能名稱
- business_objective: 2 句業務目標
- scope: 1 句功能範圍說明
- out_of_scope: 2 項不在範圍內的事項
- target_platform: 目標平台（選填）如 "Broadcom SONiC 4.x" 或 "FRRouting 9.x"，不確定則省略
- requirements: {d['req']}，每個物件：
    {{id:"REQ-001", title:"繁中標題", description:"{d['verbosity']}",
      priority:"Must Have"|"Should Have"|"Nice to Have",
      priority_rationale:"此優先級的依據，1-2 句：為何此等級、不做的代價、對應哪條業務目標（Must Have 必填）",
      related_standard:"僅在有明確 RFC/IEEE 對應時填寫，否則省略",
      acceptance_criteria:[{d['ac']}，含具體數字],
      covers_edge_cases:["EC-1","EC-3"]（此需求涵蓋的邊界 EC 編號；務必讓每個高風險 EC 都被某條 Must Have 涵蓋）}}
- performance_sla: 量化效能指標，**每條須含量測條件**如 "轉發延遲 ≤ 1ms（線速 10Gbps、64-byte）"、"VLAN 設定完成 ≤ 3s（冷啟動）"（{('精簡：2-3 條' if state.get('detail_level')=='concise' else '3-5 條')}）
- reliability_requirements: 可靠性指標（選填）如 "MTTR ≤ 30s"、"Failover ≤ 500ms"，若為純業務邏輯則省略
- dependencies: 2-3 項協定或子系統
- open_questions: 開放問題（選填）：追問中未確認的技術決策，如 "[待確認] 斷電後 VLAN 設定是否持久化"；若資訊已完整則省略

priority 必須使用英文字串。需求數量請依「詳細度」與功能複雜度決定，不要硬湊或硬砍。

🔒 自我一致性檢查（輸出前務必自我檢查，違反就改掉再輸出）：
1. 數值彼此相容：所有計時器、週期、逾時、SLA、RTO/MTTR、狀態同步週期、容量／並發上限之間不得邏輯矛盾——例如「狀態同步週期」不得長於「故障恢復時間目標」；單一終端上限不得與全系統並發 SLA 衝突。
2. 每條驗收標準可量測：含具體數字、單位、量測條件與判定門檻，禁用「應能」「需支援」等模糊詞。
3. 跨需求一致：REQ 之間、REQ 與 SLA 之間引用的數字必須一致。
寧可把目標訂得保守且自洽，也不要訂出漂亮卻自相矛盾的數字（自相矛盾會被校驗判為 critical）。"""

    _t0 = time.time()
    try:
        result = call_tool(prompt, SPEC_DOC_TOOL, model=get_settings().llm_prd or get_settings().default_model)
    except Exception as exc:
        # Degrade gracefully — the most expensive node must not throw away the whole
        # paid run. Build a deliverable PRD skeleton from already-computed edge cases.
        degraded_reqs = [
            {"id": f"REQ-{i+1:03d}", "title": e.get("title") or "邊界情境",
             "description": (e.get("description") or "")[:200],
             "priority": "Must Have" if e.get("risk") == "high" else "Should Have",
             "acceptance_criteria": [e.get("detection") or "（待補：可量測驗收標準）"],
             "covers_edge_cases": [_edge_label(i)]}
            for i, e in enumerate(edge_cases[:4])
        ] or [{"id": "REQ-001", "title": "核心功能",
               "description": state["requirement"][:160], "priority": "Must Have",
               "acceptance_criteria": ["（待補：可量測驗收標準）"]}]
        result = {
            "feature_name": (state["requirement"][:20] or "網通功能規格"),
            "business_objective": "（降級輸出）PRD 生成未完成，以下為依現有分析整理的初步結構，請重新執行優化迭代以取得完整規格。",
            "scope": state["requirement"][:80],
            "out_of_scope": [],
            "requirements": degraded_reqs,
            "performance_sla": [],
            "dependencies": protocols[:3],
            "open_questions": [f"[降級] PRD 自動生成未完成（{exc}）；本版本依邊界情境降級整理，建議優化迭代重新生成。"],
        }
    # A4: a missing hard constraint must not vanish silently — surface target_platform
    # as an open question so PM/架構師 see the decision is still pending (don't fabricate one).
    if not (result.get("target_platform") or "").strip():
        oqs2 = result.get("open_questions") or []
        if not any("目標平台" in str(q) for q in oqs2):
            oqs2.append("[待確認] 目標平台未指定（硬體 / OS / 版本）——影響可行性評估與測試基線，請補充。")
        result["open_questions"] = oqs2

    _tc_prd = [{"tool": "generate_spec_document", "step": 8,
                "input_summary": f"邊界情境 {len(state.get('edge_cases',[]))} 個，協定 {', '.join(state.get('protocols',[])[:3]) or state.get('req_type','')}",
                "output_summary": f"生成 PRD：{result.get('feature_name','')}，{len(result.get('requirements',[]))} 條需求，{len(result.get('performance_sla',[]))} 條 SLA",
                "duration_ms": int((time.time() - _t0) * 1000)}]

    # ── Assemble Chinese Markdown PRD ───────────────────────────────────────
    md_zh = _build_prd_markdown(result, state)

    return {
        "current_step": 8,
        "spec_document":    md_zh,
        "spec_document_en": "",
        "spec_sections": result,
        "gherkin_spec": "",
        "gherkin_scenarios": [],
        "_tool_calls": _tc_prd,
        "log": _log(8, "qwen2.5",
                    f"PRD 規格書生成完畢：{result.get('feature_name','')}，"
                    f"{len(result.get('requirements',[]))} 條需求，"
                    f"{len(result.get('performance_sla',[]))} 條 SLA。"),
    }


def _build_prd_markdown(data: dict, state: dict, iteration: int = 1) -> str:
    """Assemble a Markdown PRD from the structured spec_sections data."""
    lines: list[str] = []
    fn       = data.get("feature_name", "功能需求規格書")
    reqs     = data.get("requirements", [])
    sla      = data.get("performance_sla", [])
    deps     = data.get("dependencies", [])
    oos      = data.get("out_of_scope", [])
    platform = data.get("target_platform", "").strip()
    rel_nfr  = data.get("reliability_requirements", [])
    oqs      = data.get("open_questions", [])
    ec       = state.get("edge_cases", [])
    dis      = state.get("disaster_patterns", [])
    lbl2title = _label_to_title(ec)   # EC-N → title, for traceability rendering (B2)
    dl       = _detail(state.get("detail_level"))   # 詳細度：控制 §4 風險篩選 + §5/§7 是否輸出
    ver          = f"{iteration}.0"
    status_label = "AI 草稿" if iteration == 1 else f"v{iteration} 優化版"

    # Contiguous section numbering — only sections actually emitted get a number,
    # so optional sections (NFR / 災情 / 開放問題) never leave gaps like 1,2,3,4,6.
    _secn = [0]
    def _h(title: str) -> str:
        _secn[0] += 1
        return f"## {_secn[0]}. {title}"

    lines += [
        f"# {fn}",
        "",
        f"**文件版本：** {ver}  |  **文件狀態：** {status_label}  |  **需審閱者：** PM / 架構師 / QA",
        "",
        "---",
        "",
        _h("功能概述"),
        "",
        f"**業務目標**",
        f"{data.get('business_objective', '')}",
        "",
        f"**功能範圍**",
        f"{data.get('scope', '')}",
        "",
    ]

    # 目標平台（來自 SKILL Phase 6 §2 適用範圍）
    if platform:
        lines += [f"**目標平台：** `{platform}`", ""]

    if oos:
        lines.append("**不在範圍（Out of Scope）**")
        for item in oos:
            lines.append(f"- {item}")
        lines.append("")

    lines += ["---", "", _h("功能需求"), ""]
    for req in reqs:
        pri_emoji = {"Must Have": "🔴", "Should Have": "🟡", "Nice to Have": "🟢"}.get(req.get("priority",""), "⚪")
        std = req.get("related_standard", "").strip()
        lines += [
            f"### {req.get('id','REQ-?')}  {req.get('title','')}",
            f"**優先級：** {pri_emoji} {req.get('priority','')}",
        ]
        # 優先級理由（PM 排期/辯護依據，A2）
        rationale = (req.get("priority_rationale") or "").strip()
        if rationale:
            lines.append(f"**優先級理由：** {rationale}")
        # 只有 LLM 明確提供標準時才顯示，不強制
        if std:
            lines.append(f"**相關標準：** `{std}`")
        lines += [
            "",
            req.get("description", ""),
            "",
            "**驗收標準**",
        ]
        for ac in req.get("acceptance_criteria", []):
            lines.append(f"- ✅ {ac}")
        covers = req.get("covers_edge_cases") or []
        if covers:
            shown = []
            for c in covers:
                m = _re.search(r"(\d+)", str(c))
                lab = f"EC-{m.group(1)}" if m else str(c)
                t = lbl2title.get(lab, "")
                shown.append(f"{lab}{(' ' + t) if t else ''}")
            lines.append(f"**對應邊界：** {' / '.join(shown)}")
        lines.append("")

    if sla or rel_nfr:
        lines += ["---", "", _h("非功能需求（NFR）"), ""]
        if sla:
            lines.append("**效能 SLA**")
            for s in sla:
                lines.append(f"- 📊 {s}")
            lines.append("")
        # 可靠性指標（來自 SKILL Phase 6 §4 NFR-002）
        if rel_nfr:
            lines.append("**可靠性指標**")
            for r in rel_nfr:
                lines.append(f"- 🛡 {r}")
            lines.append("")

    if ec:
        h = sum(1 for e in ec if e.get("risk") == "high")
        m = sum(1 for e in ec if e.get("risk") == "mid")
        l = sum(1 for e in ec if e.get("risk") == "low")
        lines += [
            "---", "",
            f"{_h('邊界條件與風險評估')}  （{len(ec)} 個情境：{h} High / {m} Mid / {l} Low）", ""
        ]
        # Coverage summary — deterministic HIGH-risk → requirement traceability (B2)
        if h > 0:
            uncovered = _uncovered_high_edges(ec, reqs)
            if uncovered:
                lines += [f"> ⚠️ **高風險覆蓋：{h - len(uncovered)}/{h}** — 尚未被任何 Must Have 需求涵蓋：{', '.join(uncovered)}", ""]
            else:
                lines += [f"> ✅ **高風險覆蓋：{h}/{h}** — 所有高風險邊界都有對應需求", ""]
        shown_n = sum(1 for e in ec if e.get("risk", "") in dl["edge_risk"])
        if shown_n < len(ec):
            lines += [f"_（{state.get('detail_level','standard')} 模式：僅顯示 {' / '.join(sorted(dl['edge_risk']))} 風險，其餘 {len(ec) - shown_n} 條已略過）_", ""]
        for idx, e in enumerate(ec):
            if e.get("risk", "") not in dl["edge_risk"]:
                continue   # detail-level risk filter
            badge = {"high": "🔴 HIGH", "mid": "🟡 MID", "low": "🟢 LOW"}.get(e.get("risk",""), "⚪")
            lines.append(f"### {_edge_label(idx)} · {badge} — {e.get('title','')}")
            lines.append(e.get("description", ""))
            if e.get("trigger_condition"):
                lines.append(f"- **觸發條件：** {e['trigger_condition']}")
            if e.get("impact"):
                lines.append(f"- **影響：** {e['impact']}")
            if e.get("detection"):
                lines.append(f"- **偵測方式：** {e['detection']}")
            lines.append("")

    if dis and dl["include_disaster"]:
        lines += ["---", "", _h("社群情報：災情摘要"), ""]
        for d in dis:
            srcs = d.get("source_urls", []) or []
            lines.append(f"### ⚠️  {d.get('title','')}")
            lines.append(d.get("description", ""))
            if d.get("root_cause"):
                lines.append(f"- **根因：** {d['root_cause']}")
            if d.get("mitigation"):
                lines.append(f"- **緩解措施：** {d['mitigation']}")
            if srcs:
                links = " ・ ".join(f"[{s.get('source','來源')}]({s['url']})" for s in srcs if s.get("url"))
                if links:
                    lines.append(f"- **社群來源（{len(srcs)} 筆）：** {links}")
            lines.append("")

    if deps:
        lines += ["---", "", _h("依賴關係"), ""]
        for dep in deps:
            lines.append(f"- {dep}")
        lines.append("")

    # 開放問題（來自 SKILL Phase 6 §8 — 跳過追問時特別重要）
    if oqs and dl["include_open_q"]:
        lines += ["---", "", _h("開放問題 _(需人工確認)_"), ""]
        for q in oqs:
            lines.append(f"- [ ] {q}")
        lines.append("")

    lines += [
        "---",
        "",
        "_此文件由 NetSpec Agentic AI 自動生成，請人工審閱後納入正式文件管理。_",
    ]
    return "\n".join(lines)


# ── Role views (架構師 / QA) — derived on demand from a confirmed PM spec ──────

_ROLE_VIEW_TOOLS = {"architect": ARCHITECT_VIEW_TOOL, "qa": QA_VIEW_TOOL}


def _pm_context(spec_sections: dict, spec_markdown: str) -> str:
    """Compact PM-spec context injected into role-view generation."""
    reqs = spec_sections.get("requirements", []) if isinstance(spec_sections, dict) else []
    req_lines = "\n".join(
        f"  {r.get('id','REQ-?')} [{r.get('priority','')}] {r.get('title','')}：{(r.get('description') or '')[:120]}"
        f"  | AC: {' ; '.join((r.get('acceptance_criteria') or [])[:3])}"
        for r in reqs
    ) or "（無）"
    return (
        f"功能：{spec_sections.get('feature_name','')}\n"
        f"業務目標：{spec_sections.get('business_objective','')}\n"
        f"需求清單（請對齊並引用這些 REQ-id）：\n{req_lines}\n"
    )


def generate_role_view(role: str, spec_sections: dict, spec_markdown: str,
                       edge_cases: list, model: str) -> dict:
    """Generate an architect / QA view from a confirmed PM spec. Returns {document, sections}.

    Mirrors the Figma generate-one pattern: PM spec is injected as context; role-specific
    structure lives here (not in the PM SPEC_DOC_TOOL). Degrades gracefully on failure."""
    tool = _ROLE_VIEW_TOOLS.get(role)
    if tool is None:
        return {"document": "", "sections": {}}

    ec_labeled = "\n".join(
        f"  {_edge_label(i)} [{(e.get('risk') or '').upper()}] {e.get('title','')}"
        for i, e in enumerate(edge_cases[:10])
    ) or "（無）"

    if role == "architect":
        ask = ("產生系統架構師視圖：設計決策（ADR：決策/考慮過的替代方案/理由/取捨/對應 REQ-id）、"
               "介面契約（與哪個子系統、協定、方向、認證、關鍵度）、PM 層之外的架構級 NFR（安全/擴充性/相容性/容量）、架構假設。")
    else:  # qa
        ask = ("產生 QA 測試視圖：把每條 Must Have 需求的驗收標準轉成可執行的 Given/When/Then 場景"
               "（標註 related_req_id 與 related_edge_cases、type=positive/negative/boundary、then 含可量測門檻），"
               "並輸出結構化 AC（req_id/metric/operator/target/unit/量測方法）與測試環境（拓樸/受測設備/流量產生器/測資/前置）。")

    prompt = f"""你是資深{'系統架構師' if role == 'architect' else 'QA 工程師'}。以下是已確認的 PM 規格，請據此產生你的角色視圖，輸出有效 JSON，所有文字使用繁體中文。
務必對齊 PM 規格、引用其 REQ-id；涉及邊界時引用 EC 編號。{ask}

===== PM 規格（須對齊） =====
{_pm_context(spec_sections, spec_markdown)}
邊界情境（每條有 EC 編號）：
{ec_labeled}
"""
    try:
        data = call_tool(prompt, tool, model=model or get_settings().llm_analyze or get_settings().default_model)
    except Exception as exc:
        print(f"[role_view:{role}] degraded: {exc}")
        return {"document": f"## 生成失敗\n\n[降級] {role} 視圖自動生成未完成（{exc}）；請重新生成。", "sections": {}}

    md = _build_architect_markdown(data) if role == "architect" else _build_qa_markdown(data, edge_cases)
    return {"document": md, "sections": data}


def _build_architect_markdown(data: dict) -> str:
    lines: list[str] = ["# 架構師視圖", ""]
    _n = [0]
    def _h(t): _n[0] += 1; return f"## {_n[0]}. {t}"
    if data.get("summary"):
        lines += [_h("架構取向"), "", data["summary"], ""]
    dd = data.get("design_decisions") or []
    if dd:
        lines += ["---", "", _h("設計決策（ADR）"), ""]
        for d in dd:
            if not isinstance(d, dict):
                continue
            lines.append(f"### {d.get('id','ADR-?')} · {d.get('decision','')}")
            if d.get("rationale"):  lines.append(f"- **理由：** {d['rationale']}")
            alts = d.get("alternatives_considered") or []
            if alts:                lines.append(f"- **考慮過的替代方案：** {' / '.join(alts)}")
            if d.get("tradeoff"):   lines.append(f"- **取捨：** {d['tradeoff']}")
            rel = d.get("related_reqs") or []
            if rel:                 lines.append(f"- **對應需求：** {' / '.join(rel)}")
            lines.append("")
    ifs = data.get("interfaces") or []
    if ifs:
        lines += ["---", "", _h("介面契約"), "", "| 介面 | 對接 | 協定 | 方向 | 認證 | 關鍵度 |", "|---|---|---|---|---|---|"]
        for it in ifs:
            if not isinstance(it, dict):
                continue
            lines.append(f"| {it.get('name','')} | {it.get('counterpart','')} | {it.get('protocol','')} | "
                         f"{it.get('direction','')} | {it.get('auth','') or '—'} | {it.get('criticality','') or '—'} |")
        lines.append("")
    nfr = data.get("nfr_deepening") or []
    if nfr:
        lines += ["---", "", _h("架構級 NFR（PM 層之外）"), ""]
        lines += [f"- {x}" for x in nfr] + [""]
    asm = data.get("assumptions") or []
    if asm:
        lines += ["---", "", _h("架構假設"), ""]
        lines += [f"- {x}" for x in asm] + [""]
    lines += ["---", "", "_架構師視圖由 NetSpec 依 PM 規格自動推導，請人工審閱。_"]
    return "\n".join(lines)


def _build_qa_markdown(data: dict, edge_cases: list) -> str:
    lbl2title = _label_to_title(edge_cases)
    lines: list[str] = ["# QA 測試視圖", ""]
    _n = [0]
    def _h(t): _n[0] += 1; return f"## {_n[0]}. {t}"
    if data.get("summary"):
        lines += [_h("測試策略"), "", data["summary"], ""]
    scs = data.get("scenarios") or []
    if scs:
        lines += ["---", "", _h("測試場景（Given / When / Then）"), ""]
        for i, s in enumerate(scs, 1):
            if not isinstance(s, dict):
                continue
            tag = {"positive": "正向", "negative": "異常", "boundary": "邊界"}.get(s.get("type",""), "")
            refs = []
            if s.get("related_req_id"): refs.append(s["related_req_id"])
            for ec in (s.get("related_edge_cases") or []):
                t = lbl2title.get(ec, "")
                refs.append(f"{ec}{(' ' + t) if t else ''}")
            lines.append(f"### S-{i} · {tag} — {s.get('title','')}")
            if refs: lines.append(f"_對應：{' / '.join(refs)}_")
            for g in (s.get("given") or []): lines.append(f"- **Given** {g}")
            for w in (s.get("when") or []):  lines.append(f"- **When** {w}")
            for t in (s.get("then") or []):  lines.append(f"- **Then** {t}")
            lines.append("")
    acs = data.get("structured_ac") or []
    if acs:
        lines += ["---", "", _h("結構化驗收標準"), "",
                  "| 需求 | 量測對象 | 比較 | 目標 | 單位 | 量測方法 | 條件 |",
                  "|---|---|---|---|---|---|---|"]
        for a in acs:
            if not isinstance(a, dict):
                continue
            lines.append(f"| {a.get('req_id','')} | {a.get('metric','')} | {a.get('operator','')} | "
                         f"{a.get('target','')} | {a.get('unit','') or '—'} | {a.get('measurement_method','') or '—'} | "
                         f"{a.get('applies_under','') or '—'} |")
        lines.append("")
    te = data.get("test_environment") or {}
    if isinstance(te, dict) and any(te.values()):
        lines += ["---", "", _h("測試環境與測資"), ""]
        if te.get("topology"):          lines.append(f"- **拓樸：** {te['topology']}")
        if te.get("duts"):              lines.append(f"- **受測設備：** {' / '.join(te['duts'])}")
        if te.get("traffic_generator"): lines.append(f"- **流量產生器：** {te['traffic_generator']}")
        if te.get("fixtures"):          lines.append(f"- **測資：** {' / '.join(te['fixtures'])}")
        if te.get("preconditions"):     lines.append(f"- **前置條件：** {' / '.join(te['preconditions'])}")
        lines.append("")
    lines += ["---", "", "_QA 視圖由 NetSpec 依 PM 規格自動推導，請人工審閱。_"]
    return "\n".join(lines)


# ── Node 9: Validate Spec ─────────────────────────────────────────────────────

def node_validate_spec(state: NetSpecState) -> dict:
    """Cross-validate the PRD against the original requirement and edge cases."""
    spec = state.get("spec_sections", {})
    reqs = spec.get("requirements", [])
    sla  = spec.get("performance_sla", [])
    ec   = state.get("edge_cases", [])

    req_titles   = [f"{r.get('id')}: {r.get('title')}" for r in reqs]
    high_ec      = [e.get("title") for e in ec if e.get("risk") == "high"]

    # Render full requirement detail (id + title + desc + AC) for the first reqs so
    # the validator actually grades the acceptance-criteria text it scores, not titles.
    def _req_block(r: dict) -> str:
        acs = r.get("acceptance_criteria", []) or []
        ac_txt = "\n".join(f"    • {a}" for a in acs) if acs else "    •（無驗收標準）"
        return (f"- {r.get('id')} {r.get('title')}（{r.get('priority','')}）\n"
                f"  說明：{(r.get('description') or '')[:120]}\n"
                f"  驗收標準：\n{ac_txt}")
    req_detail = "\n".join(_req_block(r) for r in reqs[:4]) or "（無需求項目）"

    prompt = f"""你是資深系統架構師，正在交叉驗證一份網通功能 PRD 規格書。
所有輸出（location、description、fix、summary）請使用繁體中文撰寫。

原始需求：{state['requirement'][:200]}
協定：{', '.join(state.get('protocols', []))}

PRD 摘要：
- 功能名稱：{spec.get('feature_name', '')}
- 效能 SLA：{', '.join(sla[:3])}
- 邊界情境（{len(ec)} 筆）：高風險 = {high_ec[:3]}

需求項目與驗收標準（前 {min(len(reqs),4)}／{len(reqs)} 筆）：
{req_detail}

請驗證以下項目：
1. 需求項目是否涵蓋所有高風險邊界情境
2. 效能 SLA 數值是否符合該協定的現實範圍
3. 需求項目之間是否有矛盾
4. 是否缺少關鍵情境（如故障轉移、超時、恢復）
5. 驗收標準是否可量測（依上方實際 AC 文字判斷：是否含具體數字／閾值／觸發條件，而非模糊描述）

評分 0-100，若無 critical 問題則 passed=true。"""

    _t0 = time.time()
    try:
        result = call_tool(prompt, VALIDATION_TOOL, model=get_settings().llm_validate or get_settings().default_model)
    except Exception as exc:
        # Degrade gracefully — never abort a paid run because the (cheap) validator failed.
        result = {
            "passed": False, "quality_score": 0,
            "issues": [{"severity": "critical", "location": "驗證流程",
                        "description": f"[降級] 品質校驗未完成（{exc}）；規格書已產出，建議重試或進行優化迭代。", "fix": "重新執行優化迭代"}],
            "summary": f"[降級] 品質校驗未完成：{exc}",
        }
    passed = result.get("passed", False)
    score = result.get("quality_score", 0)
    issues = list(result.get("issues", []))

    # ── Deterministic edge-coverage audit (B2) ──────────────────────────────
    # Authoritative (not LLM-judged): which HIGH-risk edges are not referenced by
    # any requirement's covers_edge_cases. Surfaced as an issue + stored so the
    # optimize/iterate loop can target the gap.
    uncovered_high = _uncovered_high_edges(ec, reqs)
    if uncovered_high:
        lbl2title = _label_to_title(ec)
        detail = "、".join(f"{lab}（{lbl2title.get(lab, '')}）" for lab in uncovered_high)
        issues.append({
            "severity": "high",
            "location": "邊界覆蓋率",
            "description": f"以下高風險邊界尚未被任何 Must Have 需求涵蓋（covers_edge_cases 未標註）：{detail}",
            "fix": "新增或調整 Must Have 需求覆蓋這些邊界，並於該需求 covers_edge_cases 標註對應 EC 編號。",
        })

    critical = [i for i in issues if i.get("severity") == "critical"]
    high_n   = len([e for e in ec if e.get("risk") == "high"])
    cov_txt  = f"，高風險覆蓋 {high_n - len(uncovered_high)}/{high_n}" if high_n else ""

    _tc_val = [{"tool": "validate_spec", "step": 9,
                "input_summary": f"需求 {len(req_titles)} 條，高風險邊界 {high_n} 個",
                "output_summary": f"品質評分 {score}/100，{'通過驗證' if passed else f'發現 {len(critical)} 個 Critical 問題'}{cov_txt}",
                "duration_ms": int((time.time() - _t0) * 1000)}]

    return {
        "current_step": 9,
        "validation_issues":    issues,
        "validation_issues_en": [],
        "validation_score": score,
        "validation_passed": passed,
        "validation_summary": result.get("summary", ""),
        "uncovered_high_edges": uncovered_high,
        "_tool_calls": _tc_val,
        "log": _log(9, "Claude (GPT-5 角色)",
                    f"交叉校驗完成：品質評分 {score}/100，{'通過' if passed else '發現問題'}{cov_txt}。"),
    }


# ── Graph Assembly ────────────────────────────────────────────────────────────

def build_pipeline() -> Any:
    graph = StateGraph(NetSpecState)

    # "parse" now does both parse + score in one LLM call
    graph.add_node("parse", node_parse_requirement)
    graph.add_node("socratic", node_socratic)
    graph.add_node("plan_search", node_plan_search)
    graph.add_node("scrape", node_scrape_community)
    graph.add_node("analyze", node_analyze_disasters)
    graph.add_node("detect_edges", node_detect_edge_cases)
    graph.add_node("gherkin", node_generate_gherkin)
    graph.add_node("validate", node_validate_spec)

    graph.add_edge(START, "parse")
    graph.add_conditional_edges("parse",    route_clarity, {"socratic": "socratic", "plan_search": "plan_search"})
    graph.add_conditional_edges("socratic", route_clarity, {"socratic": "socratic", "plan_search": "plan_search"})
    graph.add_edge("plan_search", "scrape")
    graph.add_edge("scrape", "analyze")
    graph.add_edge("scrape", "detect_edges")   # parallel with analyze
    graph.add_edge("analyze", "gherkin")        # fan-in: gherkin waits for both
    graph.add_edge("detect_edges", "gherkin")
    graph.add_edge("gherkin", "validate")
    graph.add_edge("validate", END)

    checkpointer = MemorySaver()
    # No interrupt_before — interrupts are handled by interrupt() calls inside nodes.
    # This avoids the double-pause bug that occurs when both mechanisms are active.
    return graph.compile(checkpointer=checkpointer)


PIPELINE = build_pipeline()

STEP_LABELS: dict[str, dict] = {
    "parse":        {"step": 1, "title": "需求解析 + 清晰度評分",  "agent": "qwen2.5",   "phase": "Phase 1"},
    "socratic":     {"step": 2, "title": "需求引導追問",       "agent": "qwen2.5",   "phase": "Phase 1"},
    "plan_search":  {"step": 3, "title": "自主搜尋規劃器",         "agent": "qwen2.5",   "phase": "Phase 2"},
    "scrape":       {"step": 4, "title": "社群情報爬蟲",           "agent": "httpx",      "phase": "Phase 2"},
    "analyze":      {"step": 5, "title": "長文本聚類分析",         "agent": "qwen2.5",   "phase": "Phase 2"},
    "detect_edges": {"step": 6, "title": "邊界情境偵測引擎",       "agent": "qwen2.5",   "phase": "Phase 3"},
    "gherkin":      {"step": 7, "title": "PRD 規格書生成",         "agent": "qwen2.5",   "phase": "Phase 3"},
    "validate":     {"step": 8, "title": "交叉校驗邏輯衝突",       "agent": "qwen2.5",   "phase": "Phase 3"},
}
