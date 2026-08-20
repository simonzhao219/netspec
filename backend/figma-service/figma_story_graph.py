"""
NetSpec — Figma Story Pipeline (LangGraph v2)

Flow:
  START → cache_check
    hit  → serve_cache → END
    miss → parse_frames
         → ask_questions  (interrupt: figma_questions, up to 3 rounds)
         → generate_feature_list (interrupt: figma_features)
         → [Send fan-out] → story_node × (features × roles) in parallel
         → save_cache → END
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import pathlib
from typing import Annotated, Literal, Optional, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send, interrupt

from config import get_settings
from llm_client import call_tool

# ─── SKILL 載入 ───────────────────────────────────────────────────────────────

_SKILL_PATH = pathlib.Path(__file__).parent.parent.parent / "skills" / "netspec-figma-story" / "SKILL.md"
try:
    _SKILL = _SKILL_PATH.read_text(encoding="utf-8")
except FileNotFoundError:
    _SKILL = ""

def _skill_section(start_marker: str, end_marker: str | None = None) -> str:
    """萃取 SKILL.md 中兩個標題之間的區塊。

    只比對 Markdown 標題行（以 # 開頭），避免誤命中 frontmatter 描述或內文中
    重複出現的同名字串。
    """
    lines = _SKILL.split("\n")

    def _is_header(line: str, marker: str) -> bool:
        return line.lstrip().startswith("#") and marker in line

    try:
        start = next(i for i, l in enumerate(lines) if _is_header(l, start_marker))
    except StopIteration:
        return ""
    if end_marker:
        try:
            end = next(i for i, l in enumerate(lines) if i > start and _is_header(l, end_marker))
        except StopIteration:
            end = len(lines)
    else:
        end = len(lines)
    return "\n".join(lines[start:end]).strip()

def _question_dimensions() -> str:
    return _skill_section("追問題庫", "功能粒度標準")

def _feature_standards() -> str:
    return _skill_section("功能粒度標準", "各角色輸出品質門檻")

def _comments_str(comments: list[dict], frames: list[dict] | None = None) -> str:
    """Format Figma comments for prompt injection. Cross-references node_id → frame name."""
    if not comments:
        return "（無）"
    node_name_map: dict[str, str] = {}
    for f in (frames or []):
        if f.get("frame_id"):
            node_name_map[f["frame_id"]] = f.get("frame_name", f["frame_id"])

    lines = []
    for c in comments[:40]:  # cap to avoid token bloat
        node_id = c.get("node_id", "")
        location = node_name_map.get(node_id, node_id) if node_id else "（畫布）"
        lines.append(f"- [{location}] {c['message']}（{c.get('user_name', '?')}）")
    return "\n".join(lines)


def _role_standard(role: str) -> str:
    markers = {"PM": "PM —", "QA": "QA —", "FE": "FE —", "BE": "BE —"}
    marker = markers.get(role, "")
    if not marker:
        return ""
    lines = _SKILL.split("\n")
    try:
        start = next(i for i, l in enumerate(lines) if marker in l)
    except StopIteration:
        return ""
    end = next(
        (i for i, l in enumerate(lines)
         if i > start and (l.startswith("### ") or l.startswith("## "))),
        len(lines),
    )
    return "\n".join(lines[start:end]).strip()


# ─── Reducer ──────────────────────────────────────────────────────────────────

def _merge_nested(a: dict, b: dict) -> dict:
    """Deep-merge {feature_id: {role: value}} dicts for parallel fan-in."""
    result = dict(a)
    for k, v in b.items():
        result[k] = {**result.get(k, {}), **v} if isinstance(v, dict) else v
    return result


# ─── State Schema ─────────────────────────────────────────────────────────────

class FigmaStoryState(TypedDict):
    # inputs
    file_key:            str
    frame_ids:           list[str]
    user_description:    str
    roles:               list[str]

    # parsed
    frames:              list[dict]
    cache_key:           str
    cache_hit:           bool
    figma_texts:         str
    figma_nodes:         list[dict]
    figma_comments:      list[dict]   # unresolved comments from DB cache

    # questioning
    history:             list[dict]   # [{round, questions:[str], answers:{key:str}}]
    question_round:      int
    proceed_to_features: bool
    pending_questions:   list[dict]  # [{key, question}] saved by gen_questions, read by wait_answers

    # feature list (human-confirmed)
    features:            list[dict]   # [{id, name, description}]
    confirmed_features:  list[dict]
    final_supplement:    str

    # story generation (reducers merge parallel Send outputs)
    stories:      Annotated[dict, _merge_nested]  # {feature_id: {role: text}}
    story_status: Annotated[dict, _merge_nested]  # {feature_id: {role: "done"}}

    # per-Send slot (populated by dispatch_stories)
    current_feature: Optional[dict]
    current_role:    Optional[str]

    error: Optional[str]


# ─── Tool Schemas ─────────────────────────────────────────────────────────────

_QUESTION_TOOL = {
    "name": "generate_figma_questions",
    "description": "根據 Figma 設計稿內容與已知資訊，產生 2-3 個功能釐清追問",
    "input_schema": {
        "type": "object",
        "required": ["questions"],
        "properties": {
            "questions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["key", "question"],
                    "properties": {
                        "key":      {"type": "string"},
                        "question": {"type": "string"},
                    },
                },
            },
        },
    },
}

_FEATURE_LIST_TOOL = {
    "name": "generate_feature_list",
    "description": "整理 Figma 畫面包含的獨立功能清單，每個功能代表一組 Story",
    "input_schema": {
        "type": "object",
        "required": ["features"],
        "properties": {
            "features": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["id", "name", "description"],
                    "properties": {
                        "id":          {"type": "string"},
                        "name":        {"type": "string"},
                        "description": {"type": "string"},
                    },
                },
            },
        },
    },
}

_STORY_TOOL = {
    "name": "generate_story_content",
    "description": "為指定角色產生功能 Story，使用繁體中文 Markdown",
    "input_schema": {
        "type": "object",
        "required": ["content"],
        "properties": {
            "content": {"type": "string"},
        },
    },
}


# ─── Role Instructions ────────────────────────────────────────────────────────

_ROLE_INSTRUCTIONS = {
    "PM": (
        "輸出正式 User Story：「As a <角色>, I want <功能>, So that <目的>」\n"
        "每條附 Acceptance Criteria 3-5 條，格式：Given/When/Then"
    ),
    "FE": (
        "輸出前端 Task 清單，每條以 [ ] 開頭，涵蓋：\n"
        "元件實作（各狀態行為）、API 呼叫（endpoint / request / response schema）、互動細節"
    ),
    "BE": (
        "輸出後端 Task 清單，每條以 [ ] 開頭，涵蓋：\n"
        "API endpoint（method / path / body / response）、DB schema、業務邏輯、驗證與錯誤處理"
    ),
    "QA": (
        "輸出測試案例，格式：【情境】→【操作步驟】→【預期結果】\n"
        "涵蓋：Happy Path、異常流程、邊界條件、權限驗證"
    ),
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def make_cache_key(file_key: str, frame_ids: list[str]) -> str:
    raw = file_key + "|" + "|".join(sorted(frame_ids))
    return hashlib.sha256(raw.encode()).hexdigest()[:20]


def _extract_texts(frames: list[dict]) -> str:
    parts = []
    for f in frames:
        texts = f.get("texts", [])
        if texts:
            lines = "\n".join(f"  · {t}" for t in texts[:20])
            parts.append(f"### {f.get('frame_name', f.get('page', '?'))}\n{lines}")
    return "\n\n".join(parts) or "（無文字內容）"


def _extract_nodes(frames: list[dict]) -> list[dict]:
    result = []
    for f in frames:
        for child in f.get("node", {}).get("children", [])[:12]:
            entry = {
                "frame": f.get("frame_name", ""),
                "name":  child.get("name", ""),
                "type":  child.get("type", ""),
            }
            variants = child.get("variants", [])
            if variants:
                entry["variants"] = [
                    "/".join(f"{k}={v}" for k, v in var.get("props", {}).items())
                    for var in variants[:6]
                ]
            result.append(entry)
    return result


def _history_str(history: list[dict]) -> str:
    if not history:
        return "（尚無）"
    lines = []
    for h in history:
        questions = h.get("questions", [])
        answers   = h.get("answers", {})
        for q in questions:
            # New form: question is {"key", "question"} → look up answer by key
            # (robust to partial / out-of-order answers). Legacy form: plain str.
            if isinstance(q, dict):
                q_text = q.get("question", "")
                ans    = answers.get(q.get("key"), "（未回答）")
            else:
                q_text = q
                ans    = "（未回答）"
            lines.append(f"Q: {q_text}\nA: {ans}")
    return "\n\n".join(lines)


# ─── Nodes ────────────────────────────────────────────────────────────────────

def cache_check(state: FigmaStoryState) -> dict:
    from db import get_figma_stories_v2
    ck     = make_cache_key(state["file_key"], state["frame_ids"])
    # force_regenerate → skip the story cache so the pipeline re-runs generation
    cached = {} if state.get("force_regenerate") else get_figma_stories_v2(ck)
    status = {
        fid: {role: "done" for role in roles}
        for fid, roles in cached.items()
    } if cached else {}
    return {"cache_key": ck, "cache_hit": bool(cached), "stories": cached, "story_status": status}


def serve_cache(state: FigmaStoryState) -> dict:
    # Cache hits skip the wizard entirely (no figma_features interrupt), so
    # confirmed_features is never set by wait_features. Reconstruct stubs from
    # the cached story keys so the final `complete` result carries a non-empty
    # feature list and the frontend can render the cached stories.
    # NOTE: feature name/description are not persisted in figma_story_v2, so the
    # feature id is used as the display name (cosmetic only — cards still render).
    feats = [
        {"id": fid, "name": fid, "description": ""}
        for fid in (state.get("stories") or {}).keys()
    ]
    return {"confirmed_features": feats}


def parse_frames(state: FigmaStoryState) -> dict:
    from db import get_figma_cache, get_figma_comments
    cached = get_figma_cache(state["file_key"])
    if not cached:
        return {"error": f"找不到 Figma 快取，file_key={state['file_key']}。請先載入 Frame 列表。"}
    all_frames = cached["frames"]
    ids_set    = set(state["frame_ids"])
    frames     = [f for f in all_frames if f.get("frame_id") in ids_set] if ids_set else all_frames
    comments   = get_figma_comments(state["file_key"]) or []
    return {
        "frames":              frames,
        "figma_texts":         _extract_texts(frames),
        "figma_nodes":         _extract_nodes(frames),
        "figma_comments":      comments,
        "history":             [],
        "question_round":      0,
        "proceed_to_features": False,
        "pending_questions":   [],
        "stories":             {},
        "story_status":        {},
        "error":               None,
    }


async def gen_questions(state: FigmaStoryState) -> dict:
    """LLM 生成追問清單，存入 state。不呼叫 interrupt()，避免 resume 時重複呼叫 LLM。"""
    cfg   = get_settings()
    model = cfg.llm_figma_questions or cfg.llm_socratic or cfg.default_model
    rnd   = state.get("question_round", 0)

    comments     = state.get("figma_comments") or []
    comments_ctx = (
        f"設計評論（未解決，可能已含線索，請勿重複追問已在評論中釐清的點）：\n"
        f"{_comments_str(comments, state.get('frames'))}\n\n"
    ) if comments else ""

    prompt = (
        f"你是資深產品經理，分析企業網通產品的 Figma 設計稿（第 {rnd + 1} 輪追問，最多 3 輪）。\n\n"
        f"{_question_dimensions()}\n\n"
        f"---\n\n"
        f"設計稿文字內容：\n{state['figma_texts']}\n\n"
        f"{comments_ctx}"
        f"使用者描述：{state.get('user_description') or '（無）'}\n\n"
        f"已問答歷史（請勿重複已釐清的維度）：\n{_history_str(state.get('history', []))}\n\n"
        f"從尚未釐清的維度中挑選 2-3 個最重要的問題。"
    )

    result = await asyncio.to_thread(call_tool, prompt, _QUESTION_TOOL,
                                     "你是資深產品經理，專注企業網通產品 UX 分析。", model)
    return {"pending_questions": result.get("questions", [])}


def wait_answers(state: FigmaStoryState) -> dict:
    """呼叫 interrupt() 等待使用者回答。Resume 時只重跑此節點（無 LLM 呼叫）。"""
    rnd       = state.get("question_round", 0)
    questions = state.get("pending_questions", [])

    user_input = interrupt({"type": "figma_questions", "round": rnd, "questions": questions})

    answers = user_input.get("answers", {})
    proceed = user_input.get("proceed", False)
    history = state.get("history", []) + [{
        "round":     rnd,
        # Store key + text so _history_str can align answers by key (robust to
        # partial / out-of-order answers from the UI).
        "questions": [{"key": q["key"], "question": q["question"]} for q in questions],
        "answers":   answers,
    }]
    return {
        "history":             history,
        "question_round":      rnd + 1,
        "proceed_to_features": proceed,
        "pending_questions":   [],
    }


async def gen_feature_list(state: FigmaStoryState) -> dict:
    """LLM 整理功能清單，存入 state。不呼叫 interrupt()。"""
    cfg   = get_settings()
    model = cfg.llm_figma_story or cfg.llm_prd or cfg.default_model

    comments     = state.get("figma_comments") or []
    comments_ctx = (
        f"設計評論（未解決）：\n{_comments_str(comments, state.get('frames'))}\n\n"
    ) if comments else ""

    prompt = (
        f"你是資深產品分析師，從 Figma 設計稿整理企業網通產品的獨立功能清單。\n\n"
        f"{_feature_standards()}\n\n"
        f"---\n\n"
        f"使用者描述：{state.get('user_description') or '（無）'}\n\n"
        f"設計稿文字內容：\n{state['figma_texts']}\n\n"
        f"{comments_ctx}"
        f"問答歷史：\n{_history_str(state.get('history', []))}\n\n"
        f"依照上述粒度標準與命名規則，輸出功能清單。"
    )

    result = await asyncio.to_thread(call_tool, prompt, _FEATURE_LIST_TOOL,
                                     "你是資深產品分析師，專注企業網通產品功能拆解。", model)
    return {"features": result.get("features", [])}


def wait_features(state: FigmaStoryState) -> dict:
    """呼叫 interrupt() 等待使用者確認功能清單。Resume 時只重跑此節點（無 LLM 呼叫）。"""
    features   = state.get("features", [])
    user_input = interrupt({"type": "figma_features", "features": features})

    confirmed_ids = set(user_input.get("confirmed_ids", [f["id"] for f in features]))
    confirmed     = [f for f in features if f["id"] in confirmed_ids]
    supplement    = user_input.get("supplement", "")
    return {"confirmed_features": confirmed, "final_supplement": supplement}


def dispatch_stories(state: FigmaStoryState) -> list[Send]:
    """Fan-out: one Send per (feature, role) combination."""
    confirmed = state.get("confirmed_features", [])
    roles     = state.get("roles", ["PM", "FE", "BE", "QA"])
    sends = [
        Send("story_node", {**state, "current_feature": feature, "current_role": role})
        for feature in confirmed
        for role in roles
    ]
    return sends or [Send("save_cache", state)]


def build_story_prompt(
    feature: dict, role: str,
    figma_texts: str, figma_nodes: list[dict],
    history: list[dict], supplement: str,
    pm_context: str = "",
    figma_comments: list[dict] | None = None,
    frames: list[dict] | None = None,
) -> str:
    """Shared story prompt builder. pm_context (the edited PM User Story + AC) is
    injected for downstream roles so FE/BE/QA align with the finalized PM spec."""
    # PM and QA need human-readable text; FE/BE need component/API structure
    figma_content = (
        figma_texts
        if role in ("PM", "QA")
        else json.dumps((figma_nodes or [])[:30], ensure_ascii=False)
    )
    role_standard = _role_standard(role) or _ROLE_INSTRUCTIONS[role]

    pm_section = ""
    if role != "PM" and pm_context.strip():
        pm_section = (
            f"## PM 版本（User Story + 驗收標準，請以此為準對齊你的任務）\n"
            f"{pm_context.strip()}\n\n"
        )

    # Comments are most valuable for PM (design rationale) and QA (edge cases noted by designers)
    comments_section = ""
    if role in ("PM", "QA") and figma_comments:
        comments_section = (
            f"## Figma 設計評論（未解決，含設計師 / PM 標注的意圖與待確認點）\n"
            f"{_comments_str(figma_comments, frames)}\n\n"
        )

    return (
        f"你是資深{role}，根據以下資訊為企業網通產品功能產生高品質輸出。\n\n"
        f"## 品質要求\n{role_standard}\n\n"
        f"---\n\n"
        f"## 功能資訊\n"
        f"功能名稱：{feature['name']}\n"
        f"功能說明：{feature['description']}\n\n"
        f"{pm_section}"
        f"## 設計稿內容\n{figma_content}\n\n"
        f"{comments_section}"
        f"## 問答歷史\n{_history_str(history)}\n\n"
        f"## 使用者補充\n{supplement or '（無）'}\n\n"
        f"請用繁體中文輸出，嚴格遵守品質要求，內容必須具體可直接建立任務。"
    )


def generate_one_story(
    feature: dict, role: str,
    figma_texts: str, figma_nodes: list[dict],
    history: list[dict] | None = None,
    supplement: str = "", pm_context: str = "",
    model: str | None = None,
    figma_comments: list[dict] | None = None,
    frames: list[dict] | None = None,
) -> str:
    """Synchronous single-story generator — used by the on-demand role endpoint."""
    cfg = get_settings()
    mdl = model or cfg.llm_figma_story or cfg.llm_prd or cfg.default_model
    prompt = build_story_prompt(feature, role, figma_texts, figma_nodes,
                                history or [], supplement, pm_context,
                                figma_comments=figma_comments, frames=frames)
    result = call_tool(prompt, _STORY_TOOL,
                       f"你是資深{role}，專注企業網通產品規格品質。", mdl)
    return result.get("content", "")


async def story_node(state: FigmaStoryState) -> dict:
    cfg     = get_settings()
    model   = cfg.llm_figma_story or cfg.llm_prd or cfg.default_model
    role    = state["current_role"]
    feature = state["current_feature"]
    fid     = feature["id"]

    prompt = build_story_prompt(
        feature, role,
        state["figma_texts"], state.get("figma_nodes", []),
        state.get("history", []), state.get("final_supplement") or "",
        figma_comments=state.get("figma_comments"),
        frames=state.get("frames"),
    )

    result = await asyncio.to_thread(call_tool, prompt, _STORY_TOOL,
                                     f"你是資深{role}，專注企業網通產品規格品質。", model)
    text = result.get("content", "")
    return {"stories": {fid: {role: text}}, "story_status": {fid: {role: "done"}}}


def save_cache(state: FigmaStoryState) -> dict:
    # No-op: do NOT auto-persist to figma_story_v2. Only an EXPLICIT user save
    # (save-version / batch save) writes the cache, so cache_check only short-
    # circuits the wizard for stories the user actually kept. Auto-writing here
    # created orphan cache rows (no history session) that silently skipped the
    # questioning / feature-confirm steps on a re-run of the same frame set.
    return {}


# ─── Routing ──────────────────────────────────────────────────────────────────

def route_cache(state: FigmaStoryState) -> Literal["serve_cache", "parse_frames"]:
    return "serve_cache" if state.get("cache_hit") else "parse_frames"


def route_after_answers(state: FigmaStoryState) -> Literal["gen_questions", "gen_feature_list"]:
    """After wait_answers: go to next question round OR proceed to feature list."""
    if state.get("question_round", 0) >= 3 or state.get("proceed_to_features"):
        return "gen_feature_list"
    return "gen_questions"


# ─── Build Graph ──────────────────────────────────────────────────────────────

def _build() -> StateGraph:
    b = StateGraph(FigmaStoryState)

    b.add_node("cache_check",    cache_check)
    b.add_node("serve_cache",    serve_cache)
    b.add_node("parse_frames",   parse_frames)
    b.add_node("gen_questions",  gen_questions)   # LLM only, no interrupt
    b.add_node("wait_answers",   wait_answers)    # interrupt only, no LLM
    b.add_node("gen_feature_list", gen_feature_list)  # LLM only, no interrupt
    b.add_node("wait_features",  wait_features)   # interrupt only, no LLM
    b.add_node("story_node",     story_node)
    b.add_node("save_cache",     save_cache)

    b.add_edge(START, "cache_check")
    b.add_conditional_edges("cache_check", route_cache, {
        "serve_cache":  "serve_cache",
        "parse_frames": "parse_frames",
    })
    b.add_edge("serve_cache",  END)
    # If parse_frames couldn't load the frame cache it returns {"error": ...}
    # without figma_texts; short-circuit to END so gen_questions doesn't KeyError
    # on state["figma_texts"]. _stream_figma_pipeline surfaces state["error"].
    b.add_conditional_edges(
        "parse_frames",
        lambda s: "error_end" if s.get("error") else "gen_questions",
        {"error_end": END, "gen_questions": "gen_questions"},
    )
    b.add_edge("gen_questions", "wait_answers")
    b.add_conditional_edges("wait_answers", route_after_answers, {
        "gen_questions":   "gen_questions",
        "gen_feature_list": "gen_feature_list",
    })
    b.add_edge("gen_feature_list", "wait_features")
    b.add_conditional_edges("wait_features", dispatch_stories)
    b.add_edge("story_node", "save_cache")
    b.add_edge("save_cache", END)

    return b.compile(checkpointer=MemorySaver())


FIGMA_PIPELINE = _build()
