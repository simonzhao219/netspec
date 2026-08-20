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
STEP_BY_TOOL: dict[str, str] = {
    "parse_and_score":             "1 · 需求解析＋清晰度",
    "parse_requirement":           "1 · 需求解析",
    "score_clarity":               "1 · 清晰度評分",
    "generate_socratic_questions": "2 · 蘇格拉底追問",
    "generate_search_plan":        "3 · 搜尋規劃",
    "analyze_disaster_patterns":   "5 · 社群災情分析",
    "detect_edge_cases":           "6 · 邊界情境偵測",
    "generate_spec_document":      "7 · PRD 規格生成",
    "validate_spec":               "8 · 品質校驗",
    "score_spec":                  "8 · 品質評分",
    "architect_view":              "＋ 架構師視圖",
    "qa_view":                     "＋ QA 視圖",
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
