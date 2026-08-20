"""SSE pipeline-session state holder (SESSIONS, this service's own 需求→PRD
pipeline). Duplicated as-is in figma-service/sse_session.py (FIGMA_SESSIONS,
the Figma story LangGraph pipeline) — same generic async
interrupt/complete/error state machine, kept independent per the Stage 2
decision not to share code between the two services yet.
"""

import asyncio
import time
from typing import Optional


class Session:
    def __init__(self, session_id: str):
        self.id = session_id
        self.status: str = "idle"          # idle | running | interrupted | complete | error
        self.interrupt_type: Optional[str] = None
        self.interrupt_data: Optional[dict] = None
        self.result: Optional[dict] = None
        self.error: Optional[str] = None
        self.queue: asyncio.Queue = asyncio.Queue()
        self.created_at: float = time.time()
        self.client_ip: str = "unknown"   # set on /start — used for per-IP daily refunds
        # Acting user, captured from the platform-injected identity headers on the
        # request that created this session. Held here because the pipeline runs as
        # a background task: by the time a step emits telemetry the HTTP request
        # (and its headers) is long gone, but the events still have to be
        # attributable to the human who started the run.
        self.user_email: Optional[str] = None
        self.user_id: Optional[str] = None
        # Iteration history — each entry is a snapshot of result at that iteration
        self.iterations: list[dict] = []  # [{iteration, timestamp, result}, ...]

    def save_iteration(self) -> None:
        """Snapshot the current result into iteration history."""
        if self.result:
            self.iterations.append({
                "iteration": len(self.iterations) + 1,
                "timestamp": time.time(),
                "quality_score": self.result.get("validation_score", 0),
                "validation_passed": self.result.get("validation_passed", False),
                "feature_name": self.result.get("spec_sections", {}).get("feature_name", ""),
                "result": self.result,
            })

    def to_dict(self) -> dict:
        return {
            "session_id": self.id,
            "status": self.status,
            "interrupt_type": self.interrupt_type,
            "interrupt_data": self.interrupt_data,
            "result": self.result,
            "error": self.error,
            "iterations": [
                {k: v for k, v in it.items() if k != "result"}  # lightweight index
                for it in self.iterations
            ],
        }
