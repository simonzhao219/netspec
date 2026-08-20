"""Figma integration — parse file structure and generate functional spec."""

import re
import time
import difflib
import httpx
from collections import Counter
from config import get_settings

FIGMA_API = "https://api.figma.com/v1"

# Bump in sync with db.FIGMA_PREPROCESS_VER when preprocessing logic changes
_PREPROCESS_VER = 3

# In-memory cache: file_key → (parsed_result, expires_at)
_cache: dict[str, tuple[dict, float]] = {}
_CACHE_TTL = 300  # 5 minutes

_FRAME_TYPES = {"FRAME", "COMPONENT", "COMPONENT_SET", "GROUP"}
_SKIP_TYPES  = {"SLICE", "CONNECTOR", "STICKY", "EMBED"}

# Fields that carry no design signal — stripped before storing
_NOISY_KEYS = {
    "relativeTransform", "layoutGrids", "exportSettings",
    "transitionNodeID", "reactions", "locked", "isMask",
    "prototypeStartNodeID", "prototypeDevice",
    "flowStartingPoints", "overflowDirection",
}


def _cache_get(file_key: str) -> dict | None:
    entry = _cache.get(file_key)
    if entry and time.time() < entry[1]:
        return entry[0]
    _cache.pop(file_key, None)
    return None


def _cache_set(file_key: str, data: dict) -> None:
    _cache[file_key] = (data, time.time() + _CACHE_TTL)


def extract_file_key(figma_url: str) -> str:
    m = re.search(r"/(?:file|design)/([A-Za-z0-9_-]+)", figma_url)
    if not m:
        raise ValueError(f"無法從 URL 解析 file_key: {figma_url}")
    return m.group(1)


class FigmaRateLimitError(RuntimeError):
    """Distinct from a plain RuntimeError so callers (main.py's error
    classifier) can map this to 429, not the generic "no token" 401."""
    def __init__(self, message: str, retry_after_seconds: int | None = None):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


def _check_figma_response(resp: httpx.Response) -> None:
    """Raise a clear, actionable error for Figma API failures.

    429 gets special handling: Figma's rate limit is purely request-count
    based (not weighted by response size — confirmed via
    https://developers.figma.com/docs/rest-api/rate-limits/), and every 429
    carries a `Retry-After` header (seconds) telling us exactly when the
    limit clears. Surface that as a wall-clock time instead of the raw
    httpx exception text. Everything else falls through to raise_for_status().
    """
    if resp.status_code == 429:
        seconds = None
        try:
            seconds = int(resp.headers.get("Retry-After", ""))
        except ValueError:
            pass
        if seconds is not None:
            retry_at = time.strftime("%H:%M:%S", time.localtime(time.time() + seconds))
            raise FigmaRateLimitError(
                f"已達 Figma API 使用限制，請在 {seconds} 秒後（約 {retry_at}）再試一次。", seconds)
        raise FigmaRateLimitError("已達 Figma API 使用限制，請稍後再試。")
    resp.raise_for_status()


# ── Low-level extractors ──────────────────────────────────────────────────────

def rgba_to_hex(color: dict) -> str | None:
    if not color:
        return None
    r = round(color.get("r", 0) * 255)
    g = round(color.get("g", 0) * 255)
    b = round(color.get("b", 0) * 255)
    return f"#{r:02X}{g:02X}{b:02X}"


def extract_fill(fill: dict) -> dict:
    return {
        "type":    fill.get("type"),
        "opacity": fill.get("opacity", 1),
        "hex":     rgba_to_hex(fill.get("color", {})),
    }


def extract_node(node: dict) -> dict:
    """Recursively extract design-relevant fields; strip noisy keys."""
    result: dict = {
        "id":   node.get("id"),
        "name": node.get("name"),
        "type": node.get("type"),
    }

    # Size
    bbox = node.get("absoluteBoundingBox")
    if bbox:
        result["size"] = {
            "width":  round(bbox["width"]),
            "height": round(bbox["height"]),
        }

    # Padding
    padding = {k: node[k] for k in
               ("paddingLeft", "paddingRight", "paddingTop", "paddingBottom")
               if k in node}
    if padding:
        result["padding"] = padding

    # Border radius
    if "cornerRadius" in node:
        result["border_radius"] = node["cornerRadius"]

    # Fills (visible only)
    fills = [extract_fill(f) for f in node.get("fills", []) if f.get("visible", True)]
    if fills:
        result["fills"] = fills

    # Typography (TEXT nodes only)
    if node.get("type") == "TEXT":
        style = node.get("style", {})
        result["typography"] = {
            "font_family": style.get("fontFamily"),
            "font_size":   style.get("fontSize"),
            "font_weight": style.get("fontWeight"),
            "line_height": style.get("lineHeightPx"),
            "text":        node.get("characters"),
        }

    # Strokes
    strokes = node.get("strokes", [])
    if strokes:
        result["strokes"]       = [extract_fill(s) for s in strokes]
        result["stroke_weight"] = node.get("strokeWeight")

    # Shadow presence
    has_shadow = any(
        e.get("type") == "DROP_SHADOW" and e.get("visible", True)
        for e in node.get("effects", [])
    )
    if has_shadow:
        result["has_shadow"] = True

    # Children (recurse, skip invisible / noisy)
    children = [
        extract_node(c) for c in node.get("children", [])
        if c.get("visible", True) and c.get("type") not in _SKIP_TYPES
    ]
    if children:
        result["children"] = children

    return result


def extract_component_set(node: dict) -> dict:
    """Extract a COMPONENT_SET with fully parsed variants."""
    result = extract_node(node)
    variants = []
    for child in node.get("children", []):
        if child.get("type") != "COMPONENT":
            continue
        if not child.get("visible", True):
            continue
        # Parse "State=Hover, Size=MD" variant name format
        props: dict[str, str] = {}
        for part in child.get("name", "").split(","):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                props[k.strip()] = v.strip()
        variants.append({
            "props": props,
            "node":  extract_node(child),
        })
    result["variants"] = variants
    return result


# ── Text extraction (for spec generation prompt) ──────────────────────────────

def _collect_texts(node: dict) -> list[str]:
    """Collect all visible TEXT characters from a node tree."""
    texts = []
    if not node.get("visible", True):
        return texts
    if node.get("type") == "TEXT":
        chars = (node.get("characters") or "").strip()
        if chars:
            texts.append(chars)
    for child in node.get("children", []):
        texts.extend(_collect_texts(child))
    return texts


# ── Top-level preprocessor ────────────────────────────────────────────────────

def _is_frame_candidate(node: dict) -> bool:
    """Cheap check usable on a depth-limited (shallow) node — no subtree needed."""
    if not node.get("visible", True):
        return False
    name = node.get("name", "")
    if name.startswith(("_", ".")) or node.get("type") in _SKIP_TYPES:
        return False
    return node.get("type") == "COMPONENT_SET" or node.get("type") in _FRAME_TYPES


def _build_frame_record(node: dict, page_name: str) -> dict | None:
    """Build the full frame record. `node` must be the full subtree of a
    node that already passed `_is_frame_candidate`."""
    name = node.get("name", "")
    node_type = node.get("type", "")

    if node_type == "COMPONENT_SET":
        cs = extract_component_set(node)
        # Collect texts from all variants for spec generation
        texts = _collect_texts(node)
        if not texts and not cs.get("variants"):
            return None
        return {
            "page":          page_name,
            "frame_id":      node.get("id", ""),
            "frame_name":    name,
            "node_type":     "COMPONENT_SET",
            "component_set": None,
            "node":          cs,
            "texts":         texts,
        }

    texts = _collect_texts(node)
    if not texts:
        return None
    return {
        "page":          page_name,
        "frame_id":      node.get("id", ""),
        "frame_name":    name,
        "node_type":     node_type,
        "component_set": None,
        "node":          extract_node(node),
        "texts":         texts,
    }


# ── Figma REST calls ──────────────────────────────────────────────────────────

_FRAME_BATCH_SIZE = 30  # ids per nodes-batch request; keeps each request's payload bounded

def _fetch_structure(file_key: str, token: str) -> dict:
    """Shallow fetch (depth=2: document → page → top-level node) — enough to
    enumerate candidate frames without pulling any frame's contents."""
    resp = httpx.get(
        f"{FIGMA_API}/files/{file_key}",
        params={"depth": 2},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    _check_figma_response(resp)
    return resp.json()


def _fetch_nodes_batch(file_key: str, ids: list[str], token: str) -> dict:
    """Full-subtree fetch for a bounded set of node ids."""
    resp = httpx.get(
        f"{FIGMA_API}/files/{file_key}/nodes",
        params={"ids": ",".join(ids)},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    _check_figma_response(resp)
    return resp.json().get("nodes", {})


# ── Main entry point ──────────────────────────────────────────────────────────

def fetch_and_parse(figma_url: str, access_token: str | None = None, force_refresh: bool = False) -> dict:
    from db import get_figma_cache, save_figma_cache
    cfg = get_settings()
    token = access_token or cfg.figma_token
    if not token:
        raise RuntimeError("尚未連接 Figma 帳號，請先點擊「Connect Figma」授權。")

    file_key = extract_file_key(figma_url)

    # L1: in-memory cache
    if not force_refresh:
        cached = _cache_get(file_key)
        if cached:
            return cached

    # L2: SQLite cache (version-aware — auto-invalidated when _PREPROCESS_VER bumps)
    if not force_refresh:
        db_cached = get_figma_cache(file_key)
        if db_cached:
            _cache_set(file_key, db_cached)
            return db_cached

    # Phase 1: shallow structure — find candidate frames without pulling their contents.
    structure = _fetch_structure(file_key, token)
    file_name = structure.get("name", "Untitled")
    pages = structure.get("document", {}).get("children", [])

    candidates: list[tuple[str, str]] = []  # (node_id, page_name)
    for page in pages:
        if not page.get("visible", True):
            continue
        for node in page.get("children", []):
            if _is_frame_candidate(node):
                candidates.append((node["id"], page.get("name", "")))

    # Phase 2: fetch each candidate's full subtree in bounded batches.
    frames: list[dict] = []
    for i in range(0, len(candidates), _FRAME_BATCH_SIZE):
        batch = candidates[i:i + _FRAME_BATCH_SIZE]
        nodes_data = _fetch_nodes_batch(file_key, [node_id for node_id, _ in batch], token)
        for node_id, page_name in batch:
            full_node = (nodes_data.get(node_id) or {}).get("document")
            if not full_node:
                continue
            record = _build_frame_record(full_node, page_name)
            if record:
                frames.append(record)

    cached_at = save_figma_cache(file_key, file_name, frames)
    result = {"file_key": file_key, "file_name": file_name, "frames": frames, "cached_at": cached_at}
    _cache_set(file_key, result)
    return result


def fetch_frames_by_ids(file_key: str, frame_ids: list[str], access_token: str | None = None) -> dict[str, dict]:
    """Fetch specific frames by node ID — for repeated diff-checks on a known
    set of frames, not the initial "list everything" pass.

    fetch_and_parse() always pulls ids=0:0 (the whole document tree), which is
    slow/timeout-prone on large files and wasteful once the target frames are
    already known. Passing the exact frame IDs (comma-separated — Figma
    accepts multiple in one call) keeps this to a single request whose size
    scales with the frames requested, not the whole file.

    Returns {frame_id: {frame_id, frame_name, node_type, node, texts}},
    skipping any id Figma didn't return (deleted / no access).
    """
    cfg = get_settings()
    token = access_token or cfg.figma_token
    if not token:
        raise RuntimeError("尚未連接 Figma 帳號，請先點擊「Connect Figma」授權。")
    if not frame_ids:
        return {}

    resp = httpx.get(
        f"{FIGMA_API}/files/{file_key}/nodes?ids={','.join(frame_ids)}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    _check_figma_response(resp)
    data = resp.json()

    frames: dict[str, dict] = {}
    for node_id, entry in data.get("nodes", {}).items():
        doc = (entry or {}).get("document")
        if not doc:
            continue  # id not found / no access — silently skip
        frames[node_id] = {
            "frame_id":   doc.get("id", node_id),
            "frame_name": doc.get("name", ""),
            "node_type":  doc.get("type", ""),
            "node":       extract_node(doc),
            "texts":      _collect_texts(doc),
        }
    return frames


def frames_dict_from_cache(cached_frames: list[dict], frame_ids: list[str]) -> dict[str, dict]:
    """Reshape fetch_and_parse()'s frame list (already fetched during the
    "list frames" picker step) into fetch_frames_by_ids()'s {frame_id: {...}}
    shape, filtered to the requested ids.

    Lets monitor creation establish its baseline check from data already in
    hand (figma_cache) instead of an immediate second Figma API call for
    frames the caller just looked at seconds ago.
    """
    wanted = set(frame_ids)
    out: dict[str, dict] = {}
    for f in cached_frames:
        fid = f.get("frame_id", "")
        if fid in wanted:
            out[fid] = {
                "frame_id":   fid,
                "frame_name": f.get("frame_name", ""),
                "node_type":  f.get("node_type", ""),
                "node":       f.get("node"),
                "texts":      f.get("texts", []),
            }
    return out


def fetch_comments(file_key: str, access_token: str | None = None) -> list[dict]:
    """Fetch unresolved comments for a Figma file.

    Requires file_comment:read OAuth scope.
    Returns a list of dicts: {id, node_id, node_name, message, user_name, created_at}.
    """
    cfg = get_settings()
    token = access_token or cfg.figma_token
    if not token:
        raise RuntimeError("尚未連接 Figma 帳號，請先授權。")

    resp = httpx.get(
        f"{FIGMA_API}/files/{file_key}/comments",
        headers={"Authorization": f"Bearer {token}"},
        timeout=20,
    )
    _check_figma_response(resp)
    raw = resp.json().get("comments", [])

    comments = []
    for c in raw:
        if c.get("resolved_at"):  # skip resolved
            continue
        node_meta = c.get("client_meta") or {}
        comments.append({
            "id":         c.get("id", ""),
            "node_id":    node_meta.get("node_id", ""),  # empty = canvas-level comment
            "message":    c.get("message", "").strip(),
            "user_name":  (c.get("user") or {}).get("handle", ""),
            "created_at": c.get("created_at", ""),
        })
    return comments


def generate_spec(frame: dict, llm_fn) -> str:
    texts = "\n".join(f"- {t}" for t in frame["texts"])
    prompt = f"""你是一位資深產品規格工程師（Spec Engineer）。

以下是從 Figma 設計稿的畫面「{frame['frame_name']}」（Page: {frame['page']}）中擷取的 UI 文字元素：

{texts}

請根據這些 UI 文字，產生一份結構化的功能規格（Functional Spec），包含：

1. **畫面名稱與用途** — 這個畫面是什麼、給誰用
2. **UI 元件列表** — 每個元件的名稱、類型（按鈕/輸入框/標籤等）、行為描述（表格呈現）
3. **使用者流程** — 使用者在這個畫面可以做哪些操作、觸發什麼結果
4. **功能需求（FR）** — 條列式，每條以 FR-001 格式編號，含優先級 P0/P1/P2
5. **驗收標準（AC）** — 每條 FR 對應的 Given/When/Then 格式

請用繁體中文輸出。"""

    return llm_fn(prompt)


_SIMILARITY_THRESHOLD = 0.55  # below this, treat as unrelated add+remove rather than an edit


def _pair_similar_texts(removed: list[str], added: list[str]) -> tuple[list[dict], list[str], list[str]]:
    """Greedily pair removed/added strings that are similar enough to be the
    same line edited (e.g. "請輸入密碼" → "請輸入您的密碼"), instead of always
    reporting them as two unrelated changes.

    O(n*m) SequenceMatcher comparisons — fine at per-frame text-line counts.
    Returns (changed[{from,to}], leftover_removed, leftover_added).
    """
    removed = list(removed)
    added = list(added)
    changed = []
    i = 0
    while i < len(removed):
        best_j, best_ratio = -1, 0.0
        for j, a in enumerate(added):
            ratio = difflib.SequenceMatcher(None, removed[i], a).ratio()
            if ratio > best_ratio:
                best_ratio, best_j = ratio, j
        if best_j >= 0 and best_ratio >= _SIMILARITY_THRESHOLD:
            changed.append({"from": removed[i], "to": added.pop(best_j)})
            removed.pop(i)
        else:
            i += 1
    return changed, removed, added


def _flatten_visual_nodes(node: dict | None) -> dict[str, dict]:
    """Flatten a frame's node tree (as captured by extract_node) into
    {node_id: {name, type, size, fills}} for structural comparison —
    independent of the text-only diff below, which can't see purely-visual
    elements (icons, dividers, images) that carry no TEXT content."""
    flat: dict[str, dict] = {}
    if not node:
        return flat

    def walk(n: dict) -> None:
        nid = n.get("id")
        if nid:
            flat[nid] = {
                "name":  n.get("name", ""),
                "type":  n.get("type", ""),
                "size":  n.get("size"),
                "fills": n.get("fills"),
            }
        for child in n.get("children", []):
            walk(child)

    walk(node)
    return flat


def _diff_visual_nodes(old_node: dict | None, new_node: dict | None) -> dict:
    """Structural/visual diff between two frame node-trees: node add/remove
    (by id — catches purely-visual elements with no text) and size/fill
    changes on nodes present in both.

    Figma isn't guaranteed to keep a node's id stable across edits (observed
    directly on this project's own test file — the same frame reappeared
    under a different id between fetches with no visible change). A pure
    id diff reads that as "removed X" + "added X" every single check, on
    repeat, for an element that never actually changed. Before reporting
    add/remove, pair up removed/added nodes that share the same (name, type)
    — same element, id just moved — the way _pair_similar_texts already does
    for text. Only genuinely unmatched ids are reported as added/removed;
    matched pairs still get checked for a real resize/recolor.

    Position (x/y) is intentionally excluded — Figma absoluteBoundingBox
    shifts on routine nudges/relayout, which would otherwise flood every
    check with noise unrelated to an actual design change.
    """
    old_flat = _flatten_visual_nodes(old_node)
    new_flat = _flatten_visual_nodes(new_node)
    old_ids, new_ids = set(old_flat), set(new_flat)
    removed_ids = old_ids - new_ids
    added_ids   = new_ids - old_ids

    removed_by_key: dict[tuple[str, str], list[str]] = {}
    for nid in removed_ids:
        key = (old_flat[nid]["name"], old_flat[nid]["type"])
        removed_by_key.setdefault(key, []).append(nid)

    resized, recolored = [], []
    matched_added: set[str] = set()
    matched_removed: set[str] = set()

    for nid in sorted(added_ids):
        key = (new_flat[nid]["name"], new_flat[nid]["type"])
        candidates = removed_by_key.get(key)
        if not candidates:
            continue
        old_nid = candidates.pop()
        if not candidates:
            del removed_by_key[key]
        matched_added.add(nid)
        matched_removed.add(old_nid)
        o, n = old_flat[old_nid], new_flat[nid]
        name = n["name"] or o["name"] or nid
        if o.get("size") != n.get("size"):
            resized.append({"name": name, "from": o.get("size"), "to": n.get("size")})
        if o.get("fills") != n.get("fills"):
            recolored.append({"name": name, "from": o.get("fills"), "to": n.get("fills")})

    added = [
        {"name": new_flat[nid]["name"] or nid, "type": new_flat[nid]["type"]}
        for nid in sorted(added_ids - matched_added)
    ]
    removed = [
        {"name": old_flat[nid]["name"] or nid, "type": old_flat[nid]["type"]}
        for nid in sorted(removed_ids - matched_removed)
    ]

    for nid in sorted(old_ids & new_ids):
        o, n = old_flat[nid], new_flat[nid]
        name = n["name"] or o["name"] or nid
        if o.get("size") != n.get("size"):
            resized.append({"name": name, "from": o.get("size"), "to": n.get("size")})
        if o.get("fills") != n.get("fills"):
            recolored.append({"name": name, "from": o.get("fills"), "to": n.get("fills")})

    return {"added": added, "removed": removed, "resized": resized, "recolored": recolored}


def diff_frame_snapshots(old: dict | None, new: dict | None) -> dict:
    """Structured diff between two fetch_frames_by_ids() results.

    Per-frame text comparison via Counter (a multiset, not a set) so a
    duplicate line being removed is still detected even though an identical
    copy remains elsewhere in the frame — a plain set diff would hide that.
    Leftover adds/removes are then similarity-paired (see
    _pair_similar_texts) so a tweaked line reads as one edit, not an
    unrelated delete+insert. Frames present in both snapshots also get a
    visual/structural pass (see _diff_visual_nodes) so a resized or
    recolored element — or one added/removed with no text at all — surfaces
    even when no text changed.
    """
    old = old or {}
    new = new or {}
    old_ids, new_ids = set(old.keys()), set(new.keys())

    added = [
        {"frame_id": fid, "frame_name": new[fid].get("frame_name", "")}
        for fid in sorted(new_ids - old_ids)
    ]
    removed = [
        {"frame_id": fid, "frame_name": old[fid].get("frame_name", "")}
        for fid in sorted(old_ids - new_ids)
    ]

    modified = []
    for fid in sorted(old_ids & new_ids):
        old_texts = old[fid].get("texts") or []
        new_texts = new[fid].get("texts") or []
        old_counter, new_counter = Counter(old_texts), Counter(new_texts)
        removed_raw = list((old_counter - new_counter).elements())
        added_raw   = list((new_counter - old_counter).elements())
        changed_texts, removed_texts, added_texts = _pair_similar_texts(removed_raw, added_raw)

        visual = _diff_visual_nodes(old[fid].get("node"), new[fid].get("node"))
        has_visual_changes = any(visual[k] for k in ("added", "removed", "resized", "recolored"))

        if not changed_texts and not added_texts and not removed_texts and not has_visual_changes:
            continue

        modified.append({
            "frame_id":       fid,
            "frame_name":     new[fid].get("frame_name") or old[fid].get("frame_name", ""),
            "changed_texts":  changed_texts,
            "added_texts":    added_texts,
            "removed_texts":  removed_texts,
            "visual_added":   visual["added"],
            "visual_removed": visual["removed"],
            "resized":        visual["resized"],
            "recolored":      visual["recolored"],
        })

    return {"added": added, "removed": removed, "modified": modified}


_MAX_FRAMES_PER_CARD = 10   # cap how many "modified" frame blocks appear in one card
_MAX_LINES_PER_FRAME = 8    # cap how many change-lines shown per frame block
_MAX_TEXT_LENGTH     = 200  # cap each individual text value's length


def _card_safe(s: str, limit: int = _MAX_TEXT_LENGTH) -> str:
    """Truncate and Markdown-escape raw Figma text before it goes into an
    Adaptive Card TextBlock. Design copy can contain *, _, [, ], ` or run to
    thousands of characters (a full paragraph layer) — any of that can break
    the card's Markdown rendering or blow past Teams' size limits, and the
    failure is invisible to us: the webhook still returns 2xx even when the
    downstream Flow silently drops an oversized/malformed card."""
    s = s or ""
    if len(s) > limit:
        s = s[:limit] + "…"
    for ch in ("\\", "*", "_", "[", "]", "`"):
        s = s.replace(ch, "\\" + ch)
    return s


def _figma_file_url(file_key: str) -> str:
    """Link to the Figma file itself. One link per notification (on the
    file name in the header), not one per frame — a wall of per-line links
    added noise without much payoff, since they all open the same file
    anyway."""
    return f"https://www.figma.com/file/{file_key}/"


def _change_tags(f: dict) -> list[str]:
    """One-word-ish tags summarizing which kinds of change a modified frame
    had, without repeating the actual before/after content."""
    tags = []
    if f.get("changed_texts") or f.get("added_texts") or f.get("removed_texts"):
        tags.append("文字修改")
    if f.get("visual_added"):
        tags.append("新增元件")
    if f.get("visual_removed"):
        tags.append("移除元件")
    if f.get("resized"):
        tags.append("尺寸變更")
    if f.get("recolored"):
        tags.append("顏色變更")
    return tags


def build_teams_card(monitor_name: str, file_name: str, file_key: str, diff: dict, checked_at: float) -> dict:
    """Wrap a diff_frame_snapshots() result into a Teams-postable summary.

    Wrapped as an Adaptive Card via the "attachments" envelope — the format
    Teams' Workflows webhook (the current Incoming Webhook replacement) and
    Power Automate both expect, rather than the deprecated plain
    MessageCard/O365-connector format.

    Deliberately a SUMMARY, not the full diff: counts + one line per frame
    (name linked straight to that node in Figma, plus which kinds of change
    it had) — not the actual before/after text or size/color values. Full
    detail stays in the app's 檢查歷史. This keeps every card roughly the
    same, small size regardless of how big a diff is, rather than trying to
    fit arbitrarily much content under Teams' per-message limits (POST-only,
    256KB) where an oversized/malformed card fails silently — the webhook
    still returns 2xx even when the downstream Flow drops the post.
    """
    import datetime

    tz = datetime.timezone(datetime.timedelta(hours=8))  # Asia/Taipei, fixed offset (no DST)
    when = datetime.datetime.fromtimestamp(checked_at, tz).strftime("%Y-%m-%d %H:%M")

    body: list[dict] = [
        {"type": "TextBlock", "text": f"🔍 {_card_safe(monitor_name)}", "weight": "Bolder", "size": "Medium", "wrap": True},
        {"type": "TextBlock", "text": f"[{_card_safe(file_name)}]({_figma_file_url(file_key)}) · {when}",
         "isSubtle": True, "size": "Small", "wrap": True, "spacing": "None"},
    ]

    added, removed, modified = diff.get("added", []), diff.get("removed", []), diff.get("modified", [])
    total = len(added) + len(removed) + len(modified)
    if total == 0:
        body.append({"type": "TextBlock", "text": "✅ 沒有偵測到變化。", "wrap": True, "spacing": "Medium"})
        return _wrap_adaptive_card(body)

    body.append({"type": "TextBlock", "wrap": True, "spacing": "Medium",
                 "text": f"共 {total} 個 Frame 有變化：🟢 新增 {len(added)} 個　🔴 移除 {len(removed)} 個　✏️ 修改 {len(modified)} 個"})

    lines: list[str] = []
    for f in added:
        name = _card_safe(f.get("frame_name") or f.get("frame_id", ""))
        lines.append(f"🟢 {name}")

    for f in modified[:_MAX_FRAMES_PER_CARD]:
        name = _card_safe(f.get("frame_name") or f.get("frame_id", ""))
        tags = _change_tags(f)
        tag_str = f"（{'、'.join(tags)}）" if tags else ""
        lines.append(f"✏️ {name}{tag_str}")
    if len(modified) > _MAX_FRAMES_PER_CARD:
        lines.append(f"…另外還有 {len(modified) - _MAX_FRAMES_PER_CARD} 個 Frame 也有修改")

    for f in removed:
        # No link — the node no longer exists in the file to link to.
        name = _card_safe(f.get("frame_name") or f.get("frame_id", ""))
        lines.append(f"🔴 {name}（Figma 上已找不到，可能已刪除）")

    body.append({"type": "TextBlock", "text": "\n\n".join(lines), "wrap": True, "spacing": "Medium"})
    body.append({"type": "TextBlock", "text": "完整內容請至系統的「檢查歷史」查看。",
                 "isSubtle": True, "size": "Small", "wrap": True, "spacing": "Medium"})

    return _wrap_adaptive_card(body)


def _wrap_adaptive_card(body: list[dict]) -> dict:
    return {
        "type": "message",
        "attachments": [{
            "contentType": "application/vnd.microsoft.card.adaptive",
            "content": {
                "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                "type": "AdaptiveCard",
                "version": "1.4",
                "body": body,
            },
        }],
    }
