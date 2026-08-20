"""
Figma Parser — 解析 Figma 檔案結構，提取 Pages / Frames / 文字內容
用法: python figma_parser.py
"""

import httpx
import json
import os
from dotenv import load_dotenv

load_dotenv()

FIGMA_TOKEN = os.getenv("FIGMA_TOKEN", "")
FILE_KEY = os.getenv("FIGMA_FILE_KEY", "")
API_BASE = "https://api.figma.com/v1"


def fetch_file(file_key: str) -> dict:
    resp = httpx.get(
        f"{API_BASE}/files/{file_key}",
        headers={"X-Figma-Token": FIGMA_TOKEN},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def extract_text(node: dict) -> list[str]:
    """遞迴抽取節點內所有文字。"""
    texts = []
    if node.get("type") == "TEXT":
        chars = node.get("characters", "").strip()
        if chars:
            texts.append(chars)
    for child in node.get("children", []):
        texts.extend(extract_text(child))
    return texts


def extract_frames(page: dict) -> list[dict]:
    """抽取 Page 下的所有頂層 Frame。"""
    frames = []
    for node in page.get("children", []):
        if node.get("type") in ("FRAME", "COMPONENT", "GROUP"):
            texts = extract_text(node)
            frames.append({
                "id": node.get("id"),
                "name": node.get("name"),
                "type": node.get("type"),
                "texts": texts,
            })
    return frames


def parse(file_key: str) -> dict:
    print(f"Fetching Figma file: {file_key} ...")
    data = fetch_file(file_key)

    file_name = data.get("name", "Untitled")
    pages = data.get("document", {}).get("children", [])

    result = {
        "file_key": file_key,
        "file_name": file_name,
        "pages": [],
    }

    for page in pages:
        frames = extract_frames(page)
        result["pages"].append({
            "id": page.get("id"),
            "name": page.get("name"),
            "frames": frames,
        })

    return result


def print_summary(parsed: dict):
    print(f"\n{'='*50}")
    print(f"檔案：{parsed['file_name']} ({parsed['file_key']})")
    print(f"{'='*50}")
    for page in parsed["pages"]:
        print(f"\n[Page] {page['name']}")
        if not page["frames"]:
            print("  （無 Frame）")
        for frame in page["frames"]:
            print(f"  [Frame] {frame['name']} ({frame['type']})")
            for text in frame["texts"][:5]:  # 只顯示前 5 筆文字
                print(f"    → {text}")
            if len(frame["texts"]) > 5:
                print(f"    ... 共 {len(frame['texts'])} 筆文字")


if __name__ == "__main__":
    if not FIGMA_TOKEN:
        print("ERROR: FIGMA_TOKEN 未設定，請確認 backend/.env")
        exit(1)
    if not FILE_KEY:
        print("ERROR: FIGMA_FILE_KEY 未設定，請在 backend/.env 加入 FIGMA_FILE_KEY=<your-file-key>")
        exit(1)

    parsed = parse(FILE_KEY)
    print_summary(parsed)

    # 輸出完整 JSON 供後續使用
    out_path = "figma_output.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(parsed, f, ensure_ascii=False, indent=2)
    print(f"\n完整結構已儲存至 {out_path}")
