from pydantic import BaseModel, Field
from typing import Optional


class AnalyzeRequest(BaseModel):
    requirement: str = Field(..., min_length=10)


class SocraticAnswersRequest(BaseModel):
    answers: dict[str, str]


class ResumePlanRequest(BaseModel):
    confirmed: bool = True
    modified_keywords: Optional[list[str]] = None


# ── Response models ──────────────────────────────────────────────

class ClarityResponse(BaseModel):
    score: int
    analysis: str
    req_type: str
    needs_clarification: bool
    questions: list[dict]
    round: int


class SearchPlanResponse(BaseModel):
    plan: list[dict]
    summary: str


class TaskCreatedResponse(BaseModel):
    task_id: str
    stream_url: str


class TaskStatusResponse(BaseModel):
    task_id: str
    status: str
    step: int
    total_steps: int
    result: Optional[dict] = None
    error: Optional[str] = None
