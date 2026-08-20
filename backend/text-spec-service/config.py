"""Settings for the text-spec service (需求輸入 → 蘇格拉底追問 → PRD).

Fields fall into two groups:
  - LLM provider credentials + the model-routing fields pipeline.py/
    router.py actually read (llm_parse/socratic/plan/analyze/edges/prd/
    validate/translate/iterate).
  - Text-spec-only knobs: Socratic rounds/clarity threshold, rate limiting,
    daily quota, demo replay, request-length validation.

Duplicated (not shared) with figma-service/config.py per the Stage 2
decision to copy llm_client.py's config surface into each service rather
than stand up a shared settings package — see the router-split memory.
"""

from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # ── LLM provider credentials (duplicated across both services) ───────────
    anthropic_api_key: str = ""
    claude_model: str = "claude-sonnet-4-6"

    use_ollama: bool = False
    ollama_base_url: str = "http://localhost:11434/v1"
    ollama_model: str = "qwen2.5:7b"

    api_base_url: str = ""   # Azure: e.g. https://xxx.cognitiveservices.azure.com
    api_key:      str = ""
    api_version:  str = "2025-04-01-preview"

    databricks_host:  str = ""
    databricks_token: str = ""

    openai_api_key: str = ""

    default_model: str = ""  # fallback when no per-step model is set

    cors_origins: list[str] = ["*"]

    # ── Per-step model routing ────────────────────────────────────────────────
    llm_parse:      str = ""  # Step 1
    llm_socratic:   str = ""  # Step 2
    llm_plan:       str = ""  # Step 3
    llm_analyze:    str = ""  # Step 5
    llm_edges:      str = ""  # Step 6
    llm_prd:        str = ""  # Step 7
    llm_validate:   str = ""  # Step 8
    llm_translate:  str = ""  # Translation
    llm_iterate:    str = ""  # Iteration scoring (vestigial — re-validation now uses llm_analyze)

    # ── Text-spec only ─────────────────────────────────────────────────────────
    github_token: str = ""
    max_socratic_rounds: int = 5
    clarity_threshold: int = 70

    # Demo replay mode（比賽 Demo 錄影用，不打 API）
    demo_mode:        bool = False
    demo_session_id:  str  = ""
    demo_speed:       float = 1.0

    # 輸入長度驗證（顯示用；實際下限/上限寫死在 StartRequest 的 Field/validator）
    req_min_length: int = 10
    req_max_length: int = 500
    req_warn_length: int = 400

    # Rate limit 模式："ollama" 嚴格每分鐘限制 / "api" 寬鬆每分鐘+每日次數上限
    rate_limit_mode: str = "ollama"

    # API 模式：每日呼叫次數上限（防止燒光 token）
    daily_start_limit: int = 30
    daily_iterate_limit: int = 60

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"  # .env is shared (symlinked) with figma-service — its fields aren't an error here


@lru_cache
def get_settings() -> Settings:
    return Settings()
