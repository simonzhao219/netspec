"""
Figma Spec Generator (測試版)
從 figma_output.json 讀取 Frame 資料，呼叫 LLM 產生功能規格。
用法: python figma_spec_gen.py
"""

import json
import os
import httpx
from dotenv import load_dotenv

load_dotenv()

API_BASE_URL = os.getenv("API_BASE_URL", "")
API_KEY      = os.getenv("API_KEY", "")
API_VERSION  = os.getenv("API_VERSION", "2025-04-01-preview")
MODEL        = os.getenv("LLM_PRD", os.getenv("DEFAULT_MODEL", "claude-opus-4-6-2026V2"))

FIGMA_OUTPUT = "figma_output.json"


def load_figma() -> list[dict]:
    with open(FIGMA_OUTPUT, encoding="utf-8") as f:
        data = json.load(f)
    frames = []
    for page in data.get("pages", []):
        for frame in page.get("frames", []):
            frames.append({
                "page": page["name"],
                "frame": frame["name"],
                "texts": frame["texts"],
            })
    return frames


def build_prompt(frame: dict) -> str:
    texts = "\n".join(f"- {t}" for t in frame["texts"])
    return f"""你是一位資深產品規格工程師（Spec Engineer）。

以下是從 Figma 設計稿的一個畫面（Frame: {frame['frame']}，Page: {frame['page']}）中擷取的 UI 文字元素：

{texts}

請根據這些 UI 文字，產生一份結構化的功能規格（Functional Spec），包含：

1. **畫面名稱與用途** — 這個畫面是什麼、給誰用
2. **UI 元件列表** — 每個元件的名稱、類型（按鈕/輸入框/標籤等）、行為描述
3. **使用者流程** — 使用者在這個畫面可以做哪些操作、觸發什麼結果
4. **功能需求（FR）** — 條列式，每條以 FR-001 格式編號
5. **驗收標準（AC）** — 每條 FR 對應的 Given/When/Then 格式

請用繁體中文輸出。"""


def call_llm(prompt: str) -> str:
    url = f"{API_BASE_URL.rstrip('/')}/anthropic/v1/messages"
    headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "Authorization": f"Bearer {API_KEY}",
    }
    body = {
        "model": MODEL,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": prompt}],
    }
    resp = httpx.post(url, headers=headers, json=body, timeout=60)
    resp.raise_for_status()
    content = resp.json().get("content", [])
    for block in content:
        if block.get("type") == "text":
            return block["text"]
    return ""


if __name__ == "__main__":
    frames = load_figma()
    if not frames:
        print("ERROR: 找不到 Frame 資料，請先執行 figma_parser.py")
        exit(1)

    for frame in frames:
        print(f"\n{'='*60}")
        print(f"產生 Spec：[{frame['page']}] Frame: {frame['frame']}")
        print(f"{'='*60}\n")

        prompt = build_prompt(frame)
        spec = call_llm(prompt)
        print(spec)

        out_file = f"spec_{frame['frame'].replace(' ', '_')}.md"
        with open(out_file, "w", encoding="utf-8") as f:
            f.write(f"# Spec — {frame['frame']}\n\n")
            f.write(spec)
        print(f"\n已儲存至 {out_file}")
