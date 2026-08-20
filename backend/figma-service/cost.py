"""Token cost estimation for the NetSpec pipeline.

Method:  cost = Σ over LLM calls ( input_tokens × input_price + output_tokens × output_price )
Data:    real usage captured per call in llm_client (_usage_records), keyed by the
         tool name → mapped to a pipeline step here.

PRICES are PUBLIC-LIST estimates in USD per 1,000,000 tokens, as (input, output).
競賽 / 實際費率請直接改 PRICES 再重新查 GET /api/cost-report —— 方法精確，只有單價是假設。
"""

# ── 單價（USD / 1M tokens）── 公開列表估價，可覆寫 ──────────────────────────────
# 依 model 名稱做「子字串比對」：只要模型名含下列 key 即套用該價。
PRICES: dict[str, tuple[float, float]] = {
    # (input_per_1M, output_per_1M)
    "claude-opus": (15.00, 75.00),   # Anthropic Claude Opus 公開價
    "claude":      (15.00, 75.00),   # 其他 Claude 一律以 Opus 估（保守）
    "gpt-5":       (2.50, 10.00),    # gpt-5.4 為競賽部署名；此處以 GPT-4o 級公開價估，請改成實際
    "gpt":         (2.50, 10.00),
    "kimi":        (0.60,  2.50),    # Moonshot Kimi 約略公開價，請改成實際
}
DEFAULT_PRICE = (2.50, 10.00)

# tool 名稱 → pipeline 步驟（顯示用）。tool 幾乎一對一對應步驟。
#
# 這份表原本是從 text-spec-service/cost.py 逐字複製過來的，裡面**一個 figma-service
# 的 tool 都沒有**——這個服務實際呼叫的是下面這四個。`STEP_BY_TOOL.get(tool, tool)`
# 查不到就 fallback 成原始 tool 名，所以整條 Figma 工作流在 v_ai_cost_by_stage 的
# sdlc_step 會顯示英文 tool 名而不是 SDLC 步驟（criterion #10 的「by SDLC stage」對
# 這半邊等於失效）。兩邊的 cost.py 依然是各自獨立的副本，但內容現在各自對應自己
# 真正會呼叫的 tool。
STEP_BY_TOOL: dict[str, str] = {
    # LangGraph story pipeline（figma_story_graph.py）
    "generate_figma_questions": "F1 · Figma 需求追問",
    "generate_feature_list":    "F2 · 功能清單生成",
    "generate_story_content":   "F3 · User Story 生成",
    # Legacy 逐角色 story 生成（figma_story.py，/api/figma/story/stream）
    "generate_markdown_content": "F4 · 角色 Story 文件生成",
}


def _price_for(model: str) -> tuple[float, float]:
    m = (model or "").lower()
    for key, price in PRICES.items():
        if key in m:
            return price
    return DEFAULT_PRICE


def compute_report(records: list[dict]) -> dict:
    """Aggregate raw usage records into a per-(step, model) cost breakdown."""
    rows: dict[tuple, dict] = {}
    for r in records:
        tool  = r.get("tool", "?")
        model = r.get("model", "?")
        step  = STEP_BY_TOOL.get(tool, tool)
        agg = rows.setdefault((step, model), {
            "step": step, "model": model, "calls": 0,
            "input_tokens": 0, "output_tokens": 0,
        })
        agg["calls"]         += 1
        agg["input_tokens"]  += r.get("input_tokens", 0)
        agg["output_tokens"] += r.get("output_tokens", 0)

    out_rows: list[dict] = []
    total_cost = total_in = total_out = 0.0
    for agg in rows.values():
        pin, pout = _price_for(agg["model"])
        cost = agg["input_tokens"] / 1_000_000 * pin + agg["output_tokens"] / 1_000_000 * pout
        agg["input_price_per_1M"]  = pin
        agg["output_price_per_1M"] = pout
        agg["cost_usd"] = round(cost, 4)
        total_cost += cost
        total_in   += agg["input_tokens"]
        total_out  += agg["output_tokens"]
        out_rows.append(agg)

    out_rows.sort(key=lambda a: a["cost_usd"], reverse=True)
    return {
        "rows": out_rows,
        "total_calls": sum(a["calls"] for a in out_rows),
        "total_input_tokens": int(total_in),
        "total_output_tokens": int(total_out),
        "total_cost_usd": round(total_cost, 4),
        "prices_used": {k: {"input_per_1M": v[0], "output_per_1M": v[1]} for k, v in PRICES.items()},
        "note": "單價為公開列表估價；改 cost.py 的 PRICES 再重查 /api/cost-report 即可換成實際費率。",
    }
