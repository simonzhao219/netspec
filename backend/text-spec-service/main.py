"""NetSpec Text-Spec Service — 需求輸入 → 蘇格拉底追問 → PRD.

App setup only (lifespan, CORS, router registration). All endpoints live
in router.py. Runs standalone on its own port — see figma-service/main.py
for the sibling Figma service; the two don't call each other.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager


def _load_databricks_secrets() -> None:
    """On Databricks Apps, fetch secrets via SDK (M2M OAuth credential chain).

    Databricks Apps injects DATABRICKS_HOST + DATABRICKS_CLIENT_ID +
    DATABRICKS_CLIENT_SECRET; the SDK picks these up automatically.
    The GetSecretResponse.value field is base64-encoded.
    """
    import base64 as _b64

    host = os.environ.get("DATABRICKS_HOST", "")
    client_id = os.environ.get("DATABRICKS_CLIENT_ID", "")
    client_secret = os.environ.get("DATABRICKS_CLIENT_SECRET", "")
    if not host or not (client_id and client_secret):
        return

    try:
        from databricks.sdk import WorkspaceClient
        w = WorkspaceClient()
        secret_map = {
            "API_BASE_URL": "api_base_url",
            "API_KEY": "api_key",
        }
        for env_var, key in secret_map.items():
            if os.environ.get(env_var):
                continue
            try:
                secret = w.secrets.get_secret(scope="netspec", key=key)
                if secret and secret.value:
                    value = _b64.b64decode(secret.value).decode("utf-8")
                    if value:
                        os.environ[env_var] = value
            except Exception:
                pass
    except Exception:
        pass


_load_databricks_secrets()

def _load_telemetry_env() -> None:
    """Make TELEMETRY_* work the same locally as it does on Databricks Apps.

    On Databricks these come from app.yaml and are real process environment
    variables. Locally they live in backend/.env — but that file is read by
    pydantic-settings into the Settings object, which never touches os.environ,
    and telemetry.py reads os.environ (deliberately: it has no dependency on the
    app's config). Bridging just these keys keeps a developer from setting them
    in .env and watching nothing happen.

    Real environment variables always win, so app.yaml is never overridden.
    """
    try:
        from dotenv import dotenv_values
        for key, value in dotenv_values(".env").items():
            if key.startswith("TELEMETRY_") and value and not os.environ.get(key):
                os.environ[key] = value
    except Exception:
        pass


_load_telemetry_env()

# Label every telemetry row with which process emitted it. app.yaml (or .env)
# normally sets this; defaulting here means a local run, or a forgotten env var,
# still produces correctly-attributed rows rather than "unknown-service".
os.environ.setdefault("TELEMETRY_SERVICE_NAME", "text-spec-service")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import get_settings
from db import init_db

# ── FastAPI App ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup — restore the db from the Volume backup (if any), THEN init tables.
    from db import restore_from_volume, backup_if_dirty, backup_to_volume
    await asyncio.to_thread(restore_from_volume)
    init_db()
    print("✅ text-spec-service SQLite DB ready (netspec_text_spec.db)")
    import telemetry
    telemetry.track("service_started", properties=telemetry.diagnostics())
    settings = get_settings()
    if not settings.anthropic_api_key:
        print("⚠️  WARNING: ANTHROPIC_API_KEY not set. Set it in text-spec-service/.env")
    # Pre-warm the LLM client (TLS + model) in the background so the first real
    # request isn't a ~20s cold start. Non-blocking; failures are ignored.
    try:
        from llm_client import prewarm
        asyncio.create_task(asyncio.to_thread(prewarm))
    except Exception:
        pass

    # Periodic durable backup: coalesces bursts of writes into one Volume upload
    # every 30s (only when the db actually changed). Keeps SQLite on fast local
    # disk while surviving container restarts. Decoupled from write paths so no
    # save site can forget to persist.
    async def _flush_loop():
        while True:
            await asyncio.sleep(30)
            try:
                await asyncio.to_thread(backup_if_dirty)
            except Exception:
                pass
    flush_task = asyncio.create_task(_flush_loop())

    yield

    # Shutdown — stop the loop and do one final flush so nothing is lost.
    flush_task.cancel()
    try:
        await asyncio.to_thread(backup_to_volume)
    except Exception:
        pass
    # Drain any telemetry still buffered for the Delta sink. stdout already has
    # every event; this is only about the optional direct-write path.
    try:
        telemetry.track("service_stopping")
        await asyncio.to_thread(telemetry.shutdown)
    except Exception:
        pass


app = FastAPI(
    title="NetSpec Text-Spec Service",
    description="需求輸入 → 蘇格拉底追問 → PRD pipeline",
    version="1.0.0",
    lifespan=lifespan,
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from router import router as _router
app.include_router(_router)


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
