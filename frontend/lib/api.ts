// Default to a RELATIVE '/api' so the browser talks to the same origin it loaded
// from (localhost in dev, the ngrok/tunnel host when exposed). Next.js rewrites
// (see next.config.ts) proxy '/api/*' to the backend server-side. Set
// NEXT_PUBLIC_API_URL to an absolute origin only if you want to bypass the proxy.
const API_URL = (process.env.NEXT_PUBLIC_API_URL || '') + '/api';

// ── Typed API errors ──────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  readonly retryAfter: number;
  readonly limit: number;
  readonly windowSec: number;
  constructor(message: string, retryAfter: number, limit: number, windowSec: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
    this.limit = limit;
    this.windowSec = windowSec;
  }
}

export class DailyLimitError extends Error {
  readonly used: number;
  readonly limit: number;
  constructor(message: string, used: number, limit: number) {
    super(message);
    this.name = 'DailyLimitError';
    this.used = used;
    this.limit = limit;
  }
}

export class ValidationError extends Error {
  readonly fields: { field: string; msg: string }[];
  constructor(message: string, fields: { field: string; msg: string }[]) {
    super(message);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

// ── Core response handler ─────────────────────────────────────────────────────

async function handleResponse(res: Response): Promise<any> {
  if (res.ok) {
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // Parse error body
  let body: any = null;
  try { body = await res.json(); } catch { body = { detail: res.statusText }; }
  const detail = body?.detail ?? body;

  // 429 — rate limit or daily limit
  if (res.status === 429) {
    if (typeof detail === 'object') {
      if (detail.error === 'daily_limit_exceeded') {
        throw new DailyLimitError(
          detail.message ?? '今日呼叫次數已達上限',
          detail.used ?? 0,
          detail.limit ?? 0,
        );
      }
      if (detail.error === 'rate_limit_exceeded') {
        throw new RateLimitError(
          detail.message ?? '請求太頻繁，請稍後再試',
          detail.retry_after ?? 60,
          detail.limit ?? 0,
          detail.window_sec ?? 60,
        );
      }
    }
    throw new RateLimitError(
      typeof detail === 'string' ? detail : '請求太頻繁，請稍後再試',
      60, 0, 60,
    );
  }

  // 422 — validation error
  if (res.status === 422 && Array.isArray(detail)) {
    const fields = detail.map((e: any) => ({
      field: Array.isArray(e.loc) ? e.loc[e.loc.length - 1] : 'field',
      msg: e.msg ?? '格式錯誤',
    }));
    const msg = fields.map(f => f.msg).join('；');
    throw new ValidationError(msg, fields);
  }

  // Generic error
  const msg = typeof detail === 'string'
    ? detail
    : (detail?.message ?? detail?.msg ?? `HTTP ${res.status} 錯誤`);
  throw new Error(msg);
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function createSession(): Promise<{ session_id: string; stream_url: string }> {
  const res = await fetch(`${API_URL}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  return handleResponse(res);
}

export async function startSession(sessionId: string, requirement: string, opts?: { initial_answers?: Record<string,string>; initial_covered_dimensions?: string[]; detail_level?: string }): Promise<void> {
  const res = await fetch(`${API_URL}/sessions/${sessionId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirement, ...opts }),
  });
  await handleResponse(res);
}

export async function resumeSession(sessionId: string, body: { answers?: Record<string,string>|null; confirmed?: boolean; modified_keywords?: string[] }): Promise<void> {
  const res = await fetch(`${API_URL}/sessions/${sessionId}/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await handleResponse(res);
}

export async function iterateSession(sessionId: string, feedback?: string): Promise<void> {
  const res = await fetch(`${API_URL}/sessions/${sessionId}/iterate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback: feedback ?? null }),
  });
  await handleResponse(res);
}

export async function generateRole(
  sessionId: string,
  role: 'architect' | 'qa',
  iteration: number,
): Promise<{ role: string; document: string; sections: any; based_on_iteration: number; generated_at: number }> {
  const res = await fetch(`${API_URL}/sessions/${sessionId}/generate-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, iteration }),
  });
  return handleResponse(res);
}

export async function getSession(sessionId: string): Promise<any> {
  const res = await fetch(`${API_URL}/sessions/${sessionId}`, { method: 'GET' });
  return handleResponse(res);
}

export async function getIteration(sessionId: string, iterNum: number): Promise<any> {
  const res = await fetch(`${API_URL}/sessions/${sessionId}/iterations/${iterNum}`, { method: 'GET' });
  return handleResponse(res);
}

export function openEventStream(sessionId: string): EventSource {
  return new EventSource(`${API_URL}/sessions/${sessionId}/stream`);
}

export interface FigmaFrame {
  page: string;
  frame_id: string;
  frame_name: string;
  text_count: number;
}

export interface FigmaFrameListResult {
  file_name: string;
  file_key: string;
  cached_at: number | null;
  comments_cached: boolean;
  comments_count: number | null;
  frames: FigmaFrame[];
}

export interface FigmaFrameSpec {
  page: string;
  frame_name: string;
  spec: string;
}

export interface FigmaParseResult {
  file_name: string;
  file_key: string;
  frames: FigmaFrameSpec[];
}

export async function getFigmaOAuthStatus(): Promise<{ connected: boolean; handle?: string; email?: string }> {
  const res = await fetch(`${API_URL}/figma/oauth/status`);
  return handleResponse(res);
}

export async function disconnectFigma(): Promise<void> {
  const res = await fetch(`${API_URL}/figma/oauth/disconnect`, { method: 'DELETE' });
  await handleResponse(res);
}

export async function listFigmaFrames(figmaUrl: string, forceRefresh = false): Promise<FigmaFrameListResult> {
  const res = await fetch(`${API_URL}/figma/list-frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ figma_url: figmaUrl, force_refresh: forceRefresh }),
  });
  return handleResponse(res);
}

export async function parseFigmaUrl(figmaUrl: string, frameIds?: string[]): Promise<FigmaParseResult> {
  const res = await fetch(`${API_URL}/figma/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ figma_url: figmaUrl, frame_ids: frameIds ?? null }),
  });
  return handleResponse(res);
}

// ── Figma Frame Monitors ──────────────────────────────────────────────────────

export interface FigmaMonitorDiffSummary {
  added: number;
  removed: number;
  modified: number;
  changed_lines: number;
}

export interface FigmaMonitor {
  id: string;
  custom_name: string;
  file_key: string;
  file_name: string;
  teams_webhook_id: string | null;
  webhook_name: string | null;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
  frame_count: number;
  has_webhook: boolean;
  latest_diff_summary: FigmaMonitorDiffSummary | null;
}

export interface FigmaMonitorDetail {
  id: string;
  custom_name: string;
  file_key: string;
  file_name: string;
  frame_ids: string[];
  frame_names: string[];
  teams_webhook_id: string | null;
  webhook_name: string | null;
  webhook_url: string | null;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TeamsWebhook {
  id: string;
  name: string;
  url: string;
  created_at: number;
  updated_at: number;
}

export interface FigmaMonitorDiff {
  added: { frame_id: string; frame_name: string }[];
  removed: { frame_id: string; frame_name: string }[];
  modified: {
    frame_id: string; frame_name: string;
    changed_texts: { from: string; to: string }[];
    added_texts: string[]; removed_texts: string[];
    visual_added: { name: string; type: string }[];
    visual_removed: { name: string; type: string }[];
    resized: { name: string; from: { width: number; height: number } | null; to: { width: number; height: number } | null }[];
    recolored: { name: string; from: unknown; to: unknown }[];
  }[];
}

export interface FigmaMonitorCheckResult {
  checked_at: number;
  is_first_check: boolean;
  diff: FigmaMonitorDiff | null;
}

export interface FigmaMonitorCheckHistoryItem {
  id: number;
  checked_at: number;
  diff: FigmaMonitorDiff | null;
}

export async function listFigmaMonitors(limit = 50): Promise<FigmaMonitor[]> {
  const res = await fetch(`${API_URL}/figma/monitors?limit=${limit}`);
  return handleResponse(res);
}

export async function createFigmaMonitor(body: {
  custom_name: string; file_key: string; file_name: string;
  frame_ids: string[]; frame_names: string[]; teams_webhook_id?: string;
}): Promise<FigmaMonitorDetail> {
  const res = await fetch(`${API_URL}/figma/monitors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res);
}

export async function checkFigmaMonitor(id: string): Promise<FigmaMonitorCheckResult> {
  const res = await fetch(`${API_URL}/figma/monitors/${id}/check`, { method: 'POST' });
  return handleResponse(res);
}

export interface FigmaMonitorBatchCheckResult {
  monitor_id: string;
  error?: string;
  checked_at?: number;
  is_first_check?: boolean;
  diff?: FigmaMonitorDiff | null;
}

export async function checkAllFigmaMonitors(): Promise<FigmaMonitorBatchCheckResult[]> {
  const res = await fetch(`${API_URL}/figma/monitors/check-all`, { method: 'POST' });
  return handleResponse(res);
}

export async function notifyFigmaMonitor(id: string): Promise<{ ok: boolean; sent_at: number }> {
  const res = await fetch(`${API_URL}/figma/monitors/${id}/notify`, { method: 'POST' });
  return handleResponse(res);
}

export async function updateFigmaMonitorWebhook(id: string, teamsWebhookId: string | null): Promise<FigmaMonitorDetail> {
  const res = await fetch(`${API_URL}/figma/monitors/${id}/webhook`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teams_webhook_id: teamsWebhookId }),
  });
  return handleResponse(res);
}

export async function updateFigmaMonitorName(id: string, customName: string): Promise<FigmaMonitorDetail> {
  const res = await fetch(`${API_URL}/figma/monitors/${id}/name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom_name: customName }),
  });
  return handleResponse(res);
}

export async function listFigmaMonitorChecks(id: string): Promise<FigmaMonitorCheckHistoryItem[]> {
  const res = await fetch(`${API_URL}/figma/monitors/${id}/checks`);
  return handleResponse(res);
}

// ── Teams Webhooks (reusable notification targets) ────────────────────────────

export async function listTeamsWebhooks(): Promise<TeamsWebhook[]> {
  const res = await fetch(`${API_URL}/teams-webhooks`);
  return handleResponse(res);
}

export async function createTeamsWebhook(name: string, url: string): Promise<TeamsWebhook> {
  const res = await fetch(`${API_URL}/teams-webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url }),
  });
  return handleResponse(res);
}

export async function updateTeamsWebhook(id: string, name: string, url: string): Promise<TeamsWebhook> {
  const res = await fetch(`${API_URL}/teams-webhooks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url }),
  });
  return handleResponse(res);
}

export async function deleteTeamsWebhook(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_URL}/teams-webhooks/${id}`, { method: 'DELETE' });
  return handleResponse(res);
}

export async function deleteFigmaMonitor(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_URL}/figma/monitors/${id}`, { method: 'DELETE' });
  return handleResponse(res);
}
