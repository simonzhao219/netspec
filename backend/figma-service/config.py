"""Settings for the Figma service (Frame 分析 + Frame 監控 + Story pipeline).

Fields fall into three groups:
  - LLM provider credentials (duplicated with text-spec-service/config.py —
    see that module's docstring for why).
  - llm_socratic/llm_analyze/llm_edges/llm_prd/llm_iterate: NOT figma-only
    — figma_generate_one and figma_story_graph borrow these exact
    text-spec per-step fields as their own model-selection fallback chain
    (PM role → llm_prd; FE/BE/QA → llm_analyze/llm_edges/llm_iterate).
    Duplicated here unchanged (same env vars) to preserve that behavior
    across the split rather than redesigning Figma's own model config.
  - Figma-only: OAuth credentials, token encryption key, the two dedicated
    llm_figma_* fields (fallback to llm_socratic/llm_prd above when unset).
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

    api_base_url: str = ""
    api_key:      str = ""
    api_version:  str = "2025-04-01-preview"

    databricks_host:  str = ""
    databricks_token: str = ""

    openai_api_key: str = ""

    default_model: str = ""

    cors_origins: list[str] = ["*"]

    # ── Borrowed from text-spec's per-step routing (see module docstring) ────
    llm_socratic: str = ""
    llm_analyze:  str = ""
    llm_edges:    str = ""
    llm_prd:      str = ""
    llm_iterate:  str = ""

    # ── Figma-only ─────────────────────────────────────────────────────────────
    secret_key: str = ""   # Figma OAuth token encryption (falls back to api_key)
    figma_token: str = ""
    figma_client_id: str = ""
    figma_client_secret: str = ""
    figma_redirect_uri: str = "http://localhost:8000/api/figma/oauth/callback"
    # Where the OAuth callback redirects the browser back to after saving the token.
    frontend_url: str = "http://localhost:3000"

    # Figma-specific model overrides（留空則 fallback 到 llm_socratic / llm_prd）
    llm_figma_questions: str = ""  # Figma 追問
    llm_figma_story:     str = ""  # Figma Story / 功能清單生成

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"  # .env is shared (symlinked) with text-spec-service — its fields aren't an error here


@lru_cache
def get_settings() -> Settings:
    return Settings()
