"""Figma Story generation — multi-round AI questioning + per-role SSE streaming."""

import hashlib
from llm_client import call_tool
from config import get_settings

VALID_ROLES = {"PM", "FE", "BE", "QA"}

ROLE_LABELS = {
    "PM": "PM 功能 Story（User Story 格式）",
    "FE": "前端工程師建議 Task 列表",
    "BE": "後端工程師建議 Task 列表",
    "QA": "QA 測試案例列表",
}

ROLE_INSTRUCTIONS = {
    "PM": (
        "輸出正式的 User Story，格式：「As a <角色>, I want <功能>, So that <目的>」，"
        "每條 Story 附上驗收標準（AC）3-5 條，使用 Given/When/Then 格式。"
    ),
    "FE": (
        "輸出前端工程師可直接建立 Task 的清單，包含：元件實作、狀態管理（各狀態行為）、"
        "API 呼叫（endpoint、request/response 說明）、互動細節。每條以 [ ] 開頭。"
    ),
    "BE": (
        "輸出後端工程師可直接建立 Task 的清單，包含：API endpoint 設計（method、path、body）、"
        "資料庫 schema、業務邏輯、驗證規則、錯誤處理。每條以 [ ] 開頭。"
    ),
    "QA": (
        "輸出測試案例清單，涵蓋：正常流程（Happy Path）、異常流程、邊界條件、"
        "權限驗證。每條格式：【情境】→【操作】→【預期結果】。"
    ),
}

# ── Tool schemas ──────────────────────────────────────────────────────────────

_QUESTION_TOOL = {
    "name": "generate_figma_questions",
    "description": "根據 Figma 畫面資訊產生釐清需求的追問",
    "input_schema": {
        "type": "object",
        "required": ["questions"],
        "properties": {
            "questions": {
                "type": "array",
                "description": "2-3 個關鍵追問，不得與歷史問題重複",
                "items": {
                    "type": "object",
                    "required": ["key", "question"],
                    "properties": {
                        "key":      {"type": "string", "description": "問題唯一 key，如 q1"},
                        "question": {"type": "string", "description": "繁體中文問題內容"},
                    },
                },
            },
        },
    },
}

_TEXT_TOOL = {
    "name": "generate_markdown_content",
    "description": "輸出 markdown 格式的功能文件內容",
    "input_schema": {
        "type": "object",
        "required": ["content"],
        "properties": {
            "content": {
                "type": "string",
                "description": "完整的 markdown 格式內容，繁體中文",
            },
        },
    },
}

# ── Cache key ─────────────────────────────────────────────────────────────────

def story_cache_key(file_key: str, frame_ids: list[str]) -> str:
    raw = file_key + "|" + ",".join(sorted(frame_ids))
    return hashlib.sha256(raw.encode()).hexdigest()[:20]


# ── Frame helpers ─────────────────────────────────────────────────────────────

def collect_frames(all_frames: list[dict], frame_ids: list[str]) -> list[dict]:
    ids_set = set(frame_ids)
    return [f for f in all_frames if f["frame_id"] in ids_set]


def _node_children_summary(node: dict) -> str:
    lines = []
    for child in node.get("children", [])[:12]:
        ntype = child.get("type", "")
        name = child.get("name", "")
        variants = child.get("variants", [])
        if variants:
            states = ", ".join(
                "/".join(f"{k}={v}" for k, v in var["props"].items())
                for var in variants[:6]
            )
            lines.append(f"  - [{ntype}] {name} → 狀態: {states}")
        else:
            lines.append(f"  - [{ntype}] {name}")
    return "\n".join(lines)


def _frame_section(frame: dict, include_node: bool = False) -> str:
    texts = "\n".join(f"  · {t}" for t in frame.get("texts", [])[:15])
    section = f"### {frame['frame_name']} (Page: {frame['page']})\n文字內容:\n{texts}"
    if include_node:
        node_summary = _node_children_summary(frame.get("node", {}))
        if node_summary:
            section += f"\nUI 元件結構:\n{node_summary}"
    return section


def _frames_text(frames: list[dict], include_node: bool = False) -> str:
    return "\n\n".join(_frame_section(f, include_node) for f in frames)


def _history_text(history: list[dict]) -> str:
    if not history:
        return ""
    lines = ["## 已確認的問答（不要重複詢問）"]
    for i, h in enumerate(history, 1):
        lines.append(f"Q{i}: {h.get('question', '')}")
        lines.append(f"A{i}: {h.get('answer', '')}")
    return "\n".join(lines)


# ── AI 追問（多輪） ───────────────────────────────────────────────────────────

def generate_questions(
    frames: list[dict],
    user_description: str,
    history: list[dict] | None = None,
) -> list[dict]:
    """回傳 2-3 個追問。history 為前幾輪的 {question, answer} 列表。"""
    cfg = get_settings()
    model = cfg.llm_figma_questions or cfg.llm_socratic or cfg.default_model
    history = history or []

    history_section = _history_text(history) + "\n\n" if history else ""
    round_hint = (
        f"（這是第 {len(history) + 1} 輪追問，最多 3 輪，"
        "請根據已知答案聚焦在仍不清楚的部分）"
        if history else ""
    )

    prompt = f"""你是一位資深產品分析師，正在分析 Figma 設計稿來協助生成功能 Story。{round_hint}

## 設計稿畫面
{_frames_text(frames)}

## 使用者補充說明
{user_description or '（無）'}

{history_section}請提出 2-3 個最關鍵的追問，聚焦在：
- 功能邊界（哪些情境需要處理？）
- 業務規則（有哪些限制或條件？）
- 使用者目標（這個畫面要解決什麼核心問題？）

不要重複歷史問題，只問仍不清楚的部分。"""

    result = call_tool(prompt, _QUESTION_TOOL, system="你是資深產品分析師。", model=model)
    return result.get("questions", [])


# ── Story 生成（單角色，供 SSE 逐一推送） ────────────────────────────────────

def generate_story_for_role(
    frames: list[dict],
    role: str,
    user_description: str,
    history: list[dict],
    final_supplement: str = "",
) -> str:
    """生成單一角色的 Story，回傳 markdown 字串。"""
    cfg = get_settings()
    model = cfg.llm_figma_story or cfg.llm_prd or cfg.default_model

    include_node = role in ("FE", "BE")
    frames_text = _frames_text(frames, include_node=include_node)

    qa_section = ""
    if history:
        pairs = [
            f"**Q**: {h.get('question', '')}\n**A**: {h.get('answer', '（未回答）')}"
            for h in history
        ]
        qa_section = "\n## 需求確認問答\n" + "\n\n".join(pairs)

    supplement_section = f"\n## 最終補充說明\n{final_supplement}" if final_supplement.strip() else ""

    prompt = f"""你是一位資深產品規格工程師，根據 Figma 設計稿與需求說明，為【{ROLE_LABELS[role]}】生成可直接使用的內容。

## 設計稿畫面
{frames_text}

## 使用者補充說明
{user_description or '（無）'}
{qa_section}{supplement_section}

## 輸出要求
{ROLE_INSTRUCTIONS[role]}

請用繁體中文輸出，內容具體、可直接拿去建立任務。"""

    result = call_tool(prompt, _TEXT_TOOL, system="你是資深產品規格工程師。", model=model)
    return result.get("content", "")
