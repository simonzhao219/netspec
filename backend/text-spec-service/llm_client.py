"""Unified LLM client — supports both Anthropic Claude and Ollama (OpenAI-compatible).

Usage:
  result = call_tool(prompt, tool_schema, system=SYSTEM_NETWORKING_EXPERT)

Set USE_OLLAMA=true in .env to use local Ollama instead of Claude API.
"""

from __future__ import annotations

import json
import re
import httpx   # module-level: used by the reused client + the Anthropic error handler
from typing import Any

from config import get_settings
from prompts import SYSTEM_NETWORKING_EXPERT


# ── Token-usage accounting (cost measurement) ──────────────────────────────────
# Every LLM call appends (tool, model, input/output tokens) here. call_tool already
# passes tool["name"], which maps ~1:1 to a pipeline step → we get a per-step cost
# breakdown with ZERO changes at the call sites. Pricing + report live in cost.py.
_usage_records: list[dict] = []


def _record_usage(tool_name: str, model: str, in_tok, out_tok) -> None:
    _usage_records.append({
        "tool": tool_name, "model": model,
        "input_tokens": int(in_tok or 0), "output_tokens": int(out_tok or 0),
    })


def get_usage_records() -> list[dict]:
    return list(_usage_records)


def reset_usage() -> None:
    _usage_records.clear()


def _finish_openai(response, tool: dict, model: str) -> dict:
    """Record usage from an OpenAI-compatible response, then parse → tool dict."""
    usage = getattr(response, "usage", None)
    if usage is not None:
        _record_usage(tool["name"], model,
                      getattr(usage, "prompt_tokens", 0),
                      getattr(usage, "completion_tokens", 0))
    content = response.choices[0].message.content or ""
    return _normalise(_extract_json(content), tool["name"])


# ── Anthropic path ────────────────────────────────────────────────────────────

def _call_anthropic(prompt: str, tool: dict, system: str) -> dict:
    import anthropic
    cfg = get_settings()
    if not cfg.anthropic_api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set and USE_OLLAMA=false.\n"
            "Either set your Anthropic key in backend/.env, or set USE_OLLAMA=true."
        )
    client = anthropic.Anthropic(api_key=cfg.anthropic_api_key)
    response = client.messages.create(
        model=cfg.claude_model,
        max_tokens=4096,
        system=system,
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
        messages=[{"role": "user", "content": prompt}],
    )
    for block in response.content:
        if block.type == "tool_use":
            return block.input
    raise ValueError(f"Claude did not return tool_use for tool: {tool['name']}")


# ── Ollama path ───────────────────────────────────────────────────────────────

def _build_example_for_schema(schema: dict) -> str:
    """Build a concrete JSON example from the schema to guide the model."""

    def _val_for_prop(k: str, val: dict):
        ftype = val.get("type", "string")
        enum_vals = val.get("enum", [])
        sub_items = val.get("items", {})
        if enum_vals:
            return enum_vals[0]
        if ftype == "string":
            return f"<{k}>"
        if ftype == "integer":
            return 0
        if ftype == "boolean":
            return True
        if ftype == "array":
            if sub_items.get("type") == "object":
                sub_props = sub_items.get("properties", {})
                return [{sk: _val_for_prop(sk, sv) for sk, sv in sub_props.items()}]
            # array of primitives — show 2 concrete placeholders
            return [f"<{k}_1>", f"<{k}_2>"]
        return f"<{k}>"

    props = schema.get("properties", {})
    example: dict = {}
    for key, val in props.items():
        ftype = val.get("type", "string")
        items = val.get("items", {})
        if ftype == "array" and items.get("type") == "object":
            # Show min(minItems, 2) example objects so model knows it's a list
            min_items = val.get("minItems", 1)
            count = min(min_items, 2)
            sub_props = items.get("properties", {})
            row = {sk: _val_for_prop(sk, sv) for sk, sv in sub_props.items()}
            example[key] = [row] * count
        else:
            example[key] = _val_for_prop(key, val)
    return json.dumps(example, ensure_ascii=False, indent=2)


def _build_json_prompt(prompt: str, tool: dict, system: str) -> str:
    """Convert a tool schema into a strict JSON-mode prompt for Ollama."""
    schema = tool.get("input_schema", {})
    props = schema.get("properties", {})
    required = schema.get("required", [])

    # Build strict field list with exact key names emphasised
    lines = []
    for key, val in props.items():
        ftype = val.get("type", "string")
        desc = val.get("description", "")
        enum_vals = val.get("enum", [])
        items_schema = val.get("items", {})
        item_props = items_schema.get("properties", {}) if isinstance(items_schema, dict) else {}

        req_mark = "REQUIRED" if key in required else "optional"
        if enum_vals:
            lines.append(f'  "{key}" [{req_mark}] ({ftype}, MUST be one of: {enum_vals}): {desc}')
        elif ftype == "array" and item_props:
            sub_keys = list(item_props.keys())
            lines.append(f'  "{key}" [{req_mark}] (array of objects, each with keys: {sub_keys}): {desc}')
        elif ftype == "array":
            lines.append(f'  "{key}" [{req_mark}] (array of {items_schema.get("type","string")}): {desc}')
        else:
            lines.append(f'  "{key}" [{req_mark}] ({ftype}): {desc}')

    schema_hint = "\n".join(lines)
    example_json = _build_example_for_schema(schema)

    return f"""{system}

{prompt}

---
IMPORTANT: Respond ONLY with a valid JSON object. No markdown, no explanation, no code fences.
Use EXACTLY these field names (case-sensitive):

{schema_hint}

Example structure (replace <...> with real values):
{example_json}

Your JSON response (starting with {{):"""


def _parse_pct(val) -> int:
    """Parse a frequency percentage from various model output formats.
    Handles: 50, "75%", "10-50%", "~40%", "low", "medium", "high", None.
    """
    if val is None:
        return 50
    s = str(val).strip().lower()
    # Text keywords
    if s in ("low", "rarely", "rare"):     return 20
    if s in ("medium", "moderate"):        return 50
    if s in ("high", "often", "frequent"): return 75
    # Strip %, ~, spaces
    s = s.replace('%', '').replace('~', '').strip()
    # Range like "10-50" → take the average
    if '-' in s:
        parts = s.split('-')
        try:
            nums = [int(p.strip()) for p in parts if p.strip().isdigit() or p.strip().lstrip('-').isdigit()]
            return max(10, min(100, sum(nums) // len(nums))) if nums else 50
        except Exception:
            return 50
    try:
        return max(10, min(100, int(float(s))))
    except Exception:
        return 50


def _to_list(val) -> list:
    """Coerce string or None into a list."""
    if val is None:
        return []
    if isinstance(val, list):
        return val
    return [str(val)]


def _extract_json(text: str) -> dict:
    """Extract JSON from model response, handling various formats.

    Handles:
    - Plain JSON
    - Markdown ```json ... ``` fences
    - deepseek-r1 <think>...</think> preamble
    - Prose text before/after the JSON block
    """
    text = text.strip()

    # Strip deepseek-r1 thinking tags (may or may not be present)
    text = re.sub(r'<think>[\s\S]*?</think>', '', text, flags=re.IGNORECASE).strip()

    # Strip markdown fences
    text = re.sub(r'^```(?:json)?\s*\n?', '', text, flags=re.MULTILINE)
    text = re.sub(r'\n?```\s*$', '', text, flags=re.MULTILINE)
    text = text.strip()

    # Direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Find first { ... } block
    start = text.find('{')
    if start == -1:
        raise ValueError(f"No JSON object found:\n{text[:300]}")

    snippet = text[start:]

    # Try as-is
    try:
        return json.loads(snippet)
    except json.JSONDecodeError:
        pass

    # Repair truncated JSON: close any open arrays/objects
    repaired = _repair_truncated_json(snippet)
    if repaired:
        try:
            return json.loads(repaired)
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not extract valid JSON:\n{text[:400]}")


def _repair_truncated_json(s: str) -> str:
    """Best-effort repair of truncated JSON: close an unterminated string
    (the common case when a response is cut off mid-value) and any open
    brackets/braces. String-aware throughout so characters inside string
    values are never mistaken for structural boundaries — a raw comma/brace
    search would, for a schema with one big string field, chop the content
    at a random comma inside the text instead of at the real truncation point."""
    stack = []
    in_str = False
    escape = False
    for ch in s:
        if escape:
            escape = False
            continue
        if in_str:
            if ch == '\\':
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in '{[':
            stack.append(ch)
        elif ch in '}]':
            if stack:
                stack.pop()

    if in_str:
        s += '"'
    closing = {'[': ']', '{': '}'}
    for opener in reversed(stack):
        s += closing[opener]

    return s


def _normalise(data: dict, tool_name: str) -> dict:
    """Normalise common key name variations from smaller models."""
    if tool_name == "detect_edge_cases":
        cases = data.get("edge_cases", [])
        normalised = []
        for c in cases:
            normalised.append({
                "risk":              c.get("risk") or c.get("risk_level") or c.get("severity") or "mid",
                "title":             c.get("title") or c.get("name") or c.get("case") or "Unknown",
                "description":       c.get("description") or c.get("details") or "",
                "trigger_condition": c.get("trigger_condition") or c.get("trigger") or c.get("cause") or "",
                "impact":            c.get("impact") or c.get("effect") or "",
                "detection":         c.get("detection") or c.get("how_to_detect") or "",
            })
        data["edge_cases"] = normalised

    elif tool_name == "analyze_disaster_patterns":
        patterns = data.get("patterns", [])
        normalised = []
        for p in patterns:
            normalised.append({
                "title":              p.get("title") or p.get("name") or p.get("pattern") or "Unknown",
                "description":        p.get("description") or p.get("details") or "",
                # frequency_percent removed (A10): was an LLM estimate with no statistical
                # basis; do NOT re-introduce a default here — show real source links instead.
                "root_cause":         p.get("root_cause") or p.get("cause") or "",
                "mitigation":         p.get("mitigation") or p.get("fix") or p.get("solution") or "",
                "source_evidence":    p.get("source_evidence") or "",
            })
        data["patterns"] = normalised

    elif tool_name == "generate_gherkin_spec":
        scenarios = data.get("scenarios", [])
        normalised = []
        valid_categories = {"happy_path", "edge_case", "disaster_recovery", "performance"}
        for s in scenarios:
            cat = (s.get("category") or s.get("type") or "happy_path").lower().replace(" ", "_")
            if cat not in valid_categories:
                cat = "happy_path"
            normalised.append({
                "title":     s.get("title") or s.get("name") or s.get("scenario") or "Scenario",
                "category":  cat,
                "given":     _to_list(s.get("given") or s.get("givens")),
                "when":      _to_list(s.get("when") or s.get("whens")),
                "then":      _to_list(s.get("then") or s.get("thens")),
                "and_steps": _to_list(s.get("and_steps") or s.get("and")),
            })
        data["scenarios"] = normalised
        # Ensure full_gherkin_text exists
        if not data.get("full_gherkin_text") and normalised:
            lines = [f"Feature: {data.get('feature_name','Networking Feature')}\n"]
            for sc in normalised:
                lines.append(f"  Scenario: {sc['title']}")
                for g in sc["given"]:
                    lines.append(f"    Given {g}")
                for w in sc["when"]:
                    lines.append(f"    When {w}")
                for t in sc["then"]:
                    lines.append(f"    Then {t}")
                lines.append("")
            data["full_gherkin_text"] = "\n".join(lines)

    elif tool_name == "generate_socratic_questions":
        questions = data.get("questions", [])
        normalised = []
        for q in questions:
            opts = q.get("options") or []
            if isinstance(opts, str):
                opts = [o.strip() for o in opts.split("、") if o.strip()]
            normalised.append({
                "key":            q.get("key") or q.get("id") or f"q{len(normalised)}",
                "question":       q.get("question") or q.get("text") or q.get("q") or "",
                "why_critical":   q.get("why_critical") or q.get("reason") or "",
                "example_answer": q.get("example_answer") or q.get("example") or "",
                "options":        [str(o) for o in opts if o][:4],
                "closing":        q.get("closing") or q.get("follow_up") or "",
            })
        data["questions"] = normalised

    elif tool_name == "generate_search_plan":
        queries = data.get("queries", [])
        normalised = []
        sources = ["reddit", "github", "hn"]
        VALID_SOURCES = {"reddit", "github", "hn"}
        for i, q in enumerate(queries):
            # Validate source is a valid enum value (model sometimes puts descriptions)
            raw_source = str(q.get("source", "")).lower().strip()
            if raw_source not in VALID_SOURCES:
                raw_source = sources[i % 3]
            normalised.append({
                "keyword":   q.get("keyword") or q.get("query") or q.get("search") or "",
                "source":    raw_source,
                "rationale": (q.get("rationale") or q.get("reason") or "")[:100],
            })
        data["queries"] = normalised

    elif tool_name == "score_clarity":
        if "score" not in data and "clarity_score" in data:
            data["score"] = data["clarity_score"]
        if "score" in data:
            data["score"] = max(0, min(100, int(data["score"])))
        data.setdefault("analysis", "")
        data.setdefault("deductions", [])

    elif tool_name == "generate_spec_document":
        # Normalise priority field (model may return Chinese or other variants)
        _PRIORITY_MAP = {
            "must have": "Must Have", "must": "Must Have",
            "高": "Must Have", "high": "Must Have", "必須": "Must Have",
            "should have": "Should Have", "should": "Should Have",
            "中": "Should Have", "medium": "Should Have",
            "nice to have": "Nice to Have", "nice": "Nice to Have",
            "low": "Nice to Have", "低": "Nice to Have",
        }
        reqs = data.get("requirements", [])
        normalised_reqs = []
        for i, r in enumerate(reqs):
            raw_pri = str(r.get("priority", "")).strip().lower()
            pri = _PRIORITY_MAP.get(raw_pri, "Should Have")
            normalised_reqs.append({
                "id":                   r.get("id") or f"REQ-{i+1:03d}",
                "title":                r.get("title") or r.get("name") or "",
                "description":          r.get("description") or r.get("detail") or "",
                "priority":             pri,
                "acceptance_criteria":  _to_list(r.get("acceptance_criteria") or r.get("criteria") or r.get("ac")),
            })
        data["requirements"] = normalised_reqs
        data.setdefault("feature_name", "功能需求規格書")
        data.setdefault("business_objective", "")
        data.setdefault("scope", "")
        data.setdefault("out_of_scope", [])
        data.setdefault("performance_sla", [])
        data.setdefault("dependencies", [])

    return data


def _call_ollama(prompt: str, tool: dict, system: str, max_tokens: int = 3072, num_ctx: int = 8192) -> dict:
    from openai import OpenAI
    cfg = get_settings()

    # 90-second timeout — prevents indefinite hang if Ollama is overloaded
    client = OpenAI(base_url=cfg.ollama_base_url, api_key="ollama", timeout=90.0)
    full_prompt = _build_json_prompt(prompt, tool, system)

    response = client.chat.completions.create(
        model=cfg.ollama_model,
        messages=[{"role": "user", "content": full_prompt}],
        temperature=0.1,
        max_tokens=max_tokens,
        extra_body={"num_ctx": num_ctx},
    )

    return _finish_openai(response, tool, cfg.ollama_model)


# ── Direct few-shot call (bypasses schema description for simple structured output) ──

def _call_ollama_direct(prompt: str, tool_name: str, json_template: str) -> dict:
    """Use a few-shot JSON template instead of schema description.

    Much more reliable for small models — the model just fills in the template
    rather than re-inventing the structure from a schema description.
    """
    from openai import OpenAI
    cfg = get_settings()
    # 60-second timeout — output is short (max_tokens=1200), fail fast rather than
    # hanging on the SDK's much longer default if the local model stalls.
    client = OpenAI(base_url=cfg.ollama_base_url, api_key="ollama", timeout=60.0)

    full_prompt = f"""{prompt}

請輸出完整的 JSON，格式如下（替換 ... 為實際內容）：
{json_template}

只輸出 JSON，不要任何說明文字。"""

    response = client.chat.completions.create(
        model=cfg.ollama_model,
        messages=[{"role": "user", "content": full_prompt}],
        temperature=0.1,
        max_tokens=1200,   # a little more headroom than 800 for later rounds' longer history
        extra_body={"num_ctx": 65536},   # prompt embeds full figma_texts + growing Q&A history
    )
    content = response.choices[0].message.content or ""
    # Ensure the JSON is properly closed (model sometimes omits final braces)
    content = _ensure_json_closed(content)
    raw = _extract_json(content)
    return _normalise(raw, tool_name)


def _ensure_json_closed(text: str) -> str:
    """Add missing closing brackets/braces to truncated JSON output."""
    text = text.strip()
    # Count open vs closed
    opens  = text.count('{') - text.count('}')
    arrays = text.count('[') - text.count(']')
    if opens > 0 or arrays > 0:
        text += ']' * max(0, arrays) + '}' * max(0, opens)
    return text


# ── Provider routing ──────────────────────────────────────────────────────────

# Claude model names hosted on Azure (use Anthropic /messages format)
_AZURE_ANTHROPIC_PREFIXES = ("claude",)

_KNOWN_PROVIDERS = ("azure_anthropic", "azure_openai", "databricks", "openai", "ollama")


def _is_claude_model(model: str) -> bool:
    return model.lower().startswith(_AZURE_ANTHROPIC_PREFIXES)


def _parse_model_spec(model_spec: str) -> tuple[str, str]:
    """Parse 'provider:model' → (provider, model).

    If no provider prefix is given, infer from model name for backward compatibility:
      - claude* → azure_anthropic
      - everything else → azure_openai
    """
    for provider in _KNOWN_PROVIDERS:
        if model_spec.startswith(provider + ":"):
            return provider, model_spec[len(provider) + 1:]
    # No prefix: legacy behaviour
    if _is_claude_model(model_spec):
        return "azure_anthropic", model_spec
    return "azure_openai", model_spec


# ── Reused clients (avoid per-call import + TLS handshake on every LLM round-trip) ──
_azure_oai = None
_azure_oai_key = None          # (base_url, api_version, api_key) the cached client was built for
_httpx_client = None


def _get_azure_openai():
    """Return a cached AzureOpenAI client, rebuilding only if endpoint/key changed."""
    global _azure_oai, _azure_oai_key
    cfg = get_settings()
    key = (cfg.api_base_url, cfg.api_version, cfg.api_key)
    if _azure_oai is None or _azure_oai_key != key:
        from openai import AzureOpenAI
        _azure_oai = AzureOpenAI(azure_endpoint=cfg.api_base_url, api_key=cfg.api_key,
                                 api_version=cfg.api_version, timeout=180.0)
        _azure_oai_key = key
    return _azure_oai


def _get_httpx_client():
    """Persistent httpx.Client (connection pool) reused across Anthropic calls."""
    global _httpx_client
    if _httpx_client is None:
        import httpx
        _httpx_client = httpx.Client(timeout=180.0)
    return _httpx_client


def prewarm() -> None:
    """Warm the client + TLS + model so the first real request isn't a ~20s cold start.
    Cheap (≈5 output tokens); safe to call in a background thread at startup."""
    try:
        cfg = get_settings()
        if cfg.use_ollama:
            return
        _get_azure_openai().chat.completions.create(
            model=cfg.llm_parse or cfg.default_model,
            messages=[{"role": "user", "content": "ping"}],
            max_completion_tokens=5,
        )
    except Exception:
        pass


def _call_azure_openai(prompt: str, tool: dict, system: str, model: str) -> dict:
    """GPT-5.4 and Kimi-K2.5 via Azure OpenAI-compatible endpoint."""
    client = _get_azure_openai()
    full_prompt = _build_json_prompt(prompt, tool, system)
    # GPT-5.x uses max_completion_tokens; older models use max_tokens
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": full_prompt}],
            temperature=0.1,
            max_completion_tokens=8192,
        )
    except Exception:
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": full_prompt}],
            temperature=0.1,
            max_tokens=4096,
        )
    return _finish_openai(response, tool, model)


def _call_azure_anthropic(prompt: str, tool: dict, system: str, model: str) -> dict:
    """Claude Opus via Azure /anthropic/v1/messages endpoint.
    Tries both Azure auth header formats: api-key and Authorization Bearer.
    """
    cfg = get_settings()
    url = cfg.api_base_url.rstrip("/") + "/anthropic/v1/messages"
    body = {
        "model": model,
        "max_tokens": 8192,
        "system": system,
        "tools": [tool],
        "tool_choice": {"type": "tool", "name": tool["name"]},
        "messages": [{"role": "user", "content": prompt}],
    }

    base_headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",   # required by Anthropic API spec
    }

    # Try both Azure auth formats
    for auth_header in [
        {"api-key": cfg.api_key},
        {"Authorization": f"Bearer {cfg.api_key}"},
    ]:
        headers = {**base_headers, **auth_header}
        try:
            # Claude/Opus on long story/PRD generations can exceed 90s — allow more headroom.
            resp = _get_httpx_client().post(url, headers=headers, json=body)
            if resp.status_code == 401:
                continue
            resp.raise_for_status()
            result = resp.json()
            _u = result.get("usage", {}) or {}
            _record_usage(tool["name"], model, _u.get("input_tokens", 0), _u.get("output_tokens", 0))
            for block in result.get("content", []):
                if block.get("type") == "tool_use":
                    return block.get("input", {})
            # Fallback: if no tool_use block, try to extract JSON from text
            for block in result.get("content", []):
                if block.get("type") == "text":
                    return _normalise(_extract_json(block.get("text", "")), tool["name"])
            return {}
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                continue
            # Log response for debugging
            try:
                err_detail = e.response.json()
            except Exception:
                err_detail = e.response.text
            raise RuntimeError(f"Azure Anthropic {e.response.status_code}: {err_detail}") from e
    raise RuntimeError(f"Azure Anthropic 401: both auth formats failed")


# ── Databricks Model Serving ──────────────────────────────────────────────────

_databricks_client = None
_databricks_client_key = None   # (host, token) the cached client was built for


def _get_databricks_client():
    global _databricks_client, _databricks_client_key
    cfg = get_settings()
    key = (cfg.databricks_host, cfg.databricks_token)
    if _databricks_client is None or _databricks_client_key != key:
        from openai import OpenAI
        _databricks_client = OpenAI(
            base_url=cfg.databricks_host.rstrip("/") + "/serving-endpoints",
            api_key=cfg.databricks_token,
            timeout=180.0,
        )
        _databricks_client_key = key
    return _databricks_client


def _call_databricks(prompt: str, tool: dict, system: str, model: str) -> dict:
    """Any model via Databricks Model Serving (OpenAI-compatible, single client)."""
    client = _get_databricks_client()
    full_prompt = _build_json_prompt(prompt, tool, system)
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": full_prompt}],
        temperature=0.1,
        max_tokens=8192,
    )
    return _finish_openai(response, tool, model)


# ── OpenAI direct ─────────────────────────────────────────────────────────────

_openai_client = None
_openai_client_key = None


def _get_openai_client():
    global _openai_client, _openai_client_key
    cfg = get_settings()
    key = cfg.openai_api_key
    if _openai_client is None or _openai_client_key != key:
        from openai import OpenAI
        _openai_client = OpenAI(api_key=cfg.openai_api_key, timeout=180.0)
        _openai_client_key = key
    return _openai_client


def _call_openai(prompt: str, tool: dict, system: str, model: str) -> dict:
    """Any model via OpenAI direct API."""
    client = _get_openai_client()
    full_prompt = _build_json_prompt(prompt, tool, system)
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": full_prompt}],
        temperature=0.1,
        max_tokens=8192,
    )
    return _finish_openai(response, tool, model)


# ── Public API ────────────────────────────────────────────────────────────────

_PROVIDER_DISPATCH = {
    "azure_anthropic": _call_azure_anthropic,
    "azure_openai":    _call_azure_openai,
    "databricks":      _call_databricks,
    "openai":          _call_openai,
}


def call_tool(prompt: str, tool: dict, system: str = SYSTEM_NETWORKING_EXPERT,
              model: str = "") -> dict:
    """Call the configured LLM with 429-aware retry backoff.

    model may be:
      - "provider:model_name"  e.g. "databricks:databricks-claude-3-7-sonnet"
      - plain model name       e.g. "gpt-5.4"  (backward-compatible, auto-detects provider)
      - empty string           → falls back to default_model / claude_model
    """
    import time as _time
    cfg = get_settings()

    # Ollama shortcut (legacy flag)
    if cfg.use_ollama:
        if tool["name"] == "generate_socratic_questions":
            template = ('{"questions":['
                '{"key":"dim1_key","question":"問題一？","options":["選項1","選項2","選項3"],'
                '"closing":"您的設計是哪一種？或者有其他考量？","example_answer":"推薦答案1"},'
                '{"key":"dim2_key","question":"問題二？","options":["選項1","選項2","選項3"],'
                '"closing":"您的設計是哪一種？或者有其他考量？","example_answer":"推薦答案2"},'
                '{"key":"dim3_key","question":"問題三？","options":["選項1","選項2","選項3"],'
                '"closing":"您的設計是哪一種？或者有其他考量？","example_answer":"推薦答案3"}]}')
            _local_call = lambda: _call_ollama_direct(prompt, tool["name"], template)
        elif tool["name"] == "generate_story_content":
            # The one schema whose entire payload is a single long markdown
            # string (User Story + several detailed ACs) — needs a bigger
            # output budget than the default 3072, and a matching num_ctx
            # since prompt + completion share the same context window.
            _local_call = lambda: _call_ollama(prompt, tool, system, max_tokens=6144, num_ctx=16384)
        elif tool["name"] == "generate_feature_list":
            # Largest prompt in the pipeline (full figma_texts + all Q&A
            # history + comments); output itself is short. DGX Spark has
            # plenty of free unified memory, so size generously.
            _local_call = lambda: _call_ollama(prompt, tool, system, max_tokens=4096, num_ctx=65536)
        else:
            _local_call = lambda: _call_ollama(prompt, tool, system)

        for attempt in range(3):
            try:
                return _local_call()
            except Exception as exc:
                msg = str(exc).lower()
                is_timeout    = "timeout" in msg or "timed out" in msg
                is_connection = "connection error" in msg or "connect" in msg or "econnrefused" in msg
                if (is_timeout or is_connection) and attempt < 2:
                    # A connection failure after a crash needs enough time for the
                    # container to actually finish reloading the model into VRAM
                    # before a retry has any chance of succeeding — a plain timeout
                    # is usually just one slow request, so back off less for that.
                    wait = 2 if is_timeout else 10 * (attempt + 1)
                    kind = "timeout" if is_timeout else "connection error"
                    print(f"[call_tool] local model {kind}, retrying in {wait}s (attempt {attempt+1}/3)…")
                    _time.sleep(wait)
                    continue
                raise

    effective_spec = model or cfg.default_model or cfg.claude_model
    provider, model_name = _parse_model_spec(effective_spec)

    # Ollama via provider prefix
    if provider == "ollama":
        return _call_ollama(prompt, tool, system)

    _call = _PROVIDER_DISPATCH.get(provider)
    if _call is None:
        raise ValueError(f"Unknown LLM provider: '{provider}'. "
                         f"Valid: {list(_PROVIDER_DISPATCH)}")

    for attempt in range(4):
        try:
            return _call(prompt, tool, system, model_name)
        except Exception as exc:
            msg = str(exc)
            if ("429" in msg or "RateLimitReached" in msg or "rate_limit" in msg.lower()) and attempt < 3:
                import re as _re
                m = _re.search(r"wait (\d+) second", msg)
                wait = int(m.group(1)) + 5 if m else 45
                print(f"[call_tool] 429 rate limit, waiting {wait}s (attempt {attempt+1}/4)…")
                _time.sleep(wait)
                continue
            if ("timeout" in msg.lower() or "timed out" in msg.lower()) and attempt < 2:
                print(f"[call_tool] LLM timeout, retrying (attempt {attempt+1}/3)…")
                _time.sleep(2)
                continue
            raise
