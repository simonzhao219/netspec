"use client";

/**
 * NetSpec app telemetry — the single frontend telemetry surface.
 *
 * Every user interaction calls `track(eventName, properties)`. Nothing else.
 * There is deliberately no auth code here: the acting user is resolved
 * server-side from the `X-Forwarded-Email` header that the Databricks Apps
 * platform injects into the browser's request (see app/api/events/route.ts).
 *
 * Guarantees this module owes the rest of the app:
 *   - never throws (a telemetry failure must never disrupt the UI)
 *   - never blocks (fire-and-forget; batched off the interaction path)
 *   - never runs during SSR (every entry point guards on `window`)
 *
 * Events are batched over a short window and flushed as one POST, then
 * force-flushed with `sendBeacon` when the tab is hidden or unloaded so the
 * tail of a session (including `session_end`) is never lost.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const ENDPOINT = "/api/events";
const SESSION_KEY = "netspec_session_id";
/** Flush window. Long enough to coalesce a burst of clicks, short enough that
 *  a developer watching the app logs sees events land more or less live. */
const FLUSH_MS = 700;
/** Flush early when a burst fills the queue (keeps `sendBeacon` under its
 *  ~64KB payload ceiling and bounds what a hard tab-kill can lose). */
const MAX_BATCH = 20;

// ── Types ────────────────────────────────────────────────────────────────────

export type TrackProps = Record<string, unknown>;

interface TelemetryEvent {
  event_name: string;
  event_time: string;
  page: string | null;
  session_id: string | null;
  /** NetSpec backend session id — the join key between UI telemetry and the
   *  spec versions the pipeline produced. Null until a session is created. */
  app_session_id: string | null;
  workflow: string | null;
  properties: TrackProps;
}

// ── Module state ─────────────────────────────────────────────────────────────

let queue: TelemetryEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let appSessionId: string | null = null;
let workflow: string | null = null;
let sessionEnded = false;
let listenersBound = false;

// ── Session id ───────────────────────────────────────────────────────────────

/**
 * Stable per-tab id, held in sessionStorage so a reload keeps the same session
 * but a new tab starts a new one. Falls back to an in-memory id when storage is
 * unavailable (private mode, storage disabled) rather than failing.
 */
let memorySessionId: string | null = null;

function sessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    let id = window.sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = newId("sess");
      window.sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    if (!memorySessionId) memorySessionId = newId("sess");
    return memorySessionId;
  }
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Correlation setters ──────────────────────────────────────────────────────

/**
 * Bind subsequent events to a NetSpec backend session. Called once a session is
 * created (or a history session is loaded) so that every downstream click can be
 * joined to the specification versions that session produced.
 * Pass null when the session is cleared (reset to home).
 */
export function setAppSession(id: string | null): void {
  appSessionId = id;
}

/** Bind subsequent events to the active workflow ("text" | "figma"). */
export function setWorkflow(mode: string | null): void {
  workflow = mode;
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Record one user interaction. Fire-and-forget — callers never await this and
 * never need to handle failure.
 */
export function track(eventName: string, properties: TrackProps = {}): void {
  if (typeof window === "undefined") return;
  try {
    bindLifecycleListeners();
    queue.push({
      event_name: eventName,
      event_time: new Date().toISOString(),
      page: window.location.pathname,
      session_id: sessionId(),
      app_session_id: appSessionId,
      workflow,
      properties: scrub(properties),
    });
    if (queue.length >= MAX_BATCH) {
      flush();
    } else if (timer === null) {
      timer = setTimeout(flush, FLUSH_MS);
    }
  } catch {
    // Telemetry failure must never disrupt the UI.
  }
}

/** Record an interaction and send it immediately, skipping the batch window. */
export function trackNow(eventName: string, properties: TrackProps = {}): void {
  track(eventName, properties);
  flush();
}

/**
 * Send everything queued. `useBeacon` switches to navigator.sendBeacon, which
 * is the only transport the browser guarantees to deliver while the page is
 * being torn down.
 */
function flush(useBeacon = false): void {
  if (typeof window === "undefined") return;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;

  const batch = queue;
  queue = [];
  const body = JSON.stringify({ events: batch });

  try {
    if (useBeacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      // Blob (not a bare string) so the request carries application/json and the
      // route parses it the same way as the fetch path.
      const ok = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      if (ok) return;
      // sendBeacon refused (payload over the UA's queue limit) — fall through to
      // fetch+keepalive, which at least has a chance of surviving the unload.
    }
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body,
      keepalive: true, // survives page unload
    }).catch(() => {
      // Telemetry failure must never disrupt the UI.
    });
  } catch {
    // Telemetry failure must never disrupt the UI.
  }
}

// ── Session end ──────────────────────────────────────────────────────────────

const sessionStart = typeof window === "undefined" ? 0 : Date.now();

/**
 * Emit `session_end` and drain the queue. Bound to both `visibilitychange` and
 * `pagehide`: the first covers tab switches and is the only signal mobile
 * browsers reliably fire, the second covers real navigations away. `sessionEnded`
 * collapses the two into one event per departure — a user who tabs away and comes
 * back produces a second `session_end` when they leave again, which is what
 * dwell-time and abandonment analysis wants.
 */
function endSession(reason: string): void {
  if (sessionEnded) {
    flush(true);
    return;
  }
  sessionEnded = true;
  track("session_end", { reason, duration_ms: Date.now() - sessionStart });
  flush(true);
}

function bindLifecycleListeners(): void {
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      endSession("hidden");
    } else {
      // Tab came back into focus — this is a continuation, not a new session.
      // Re-arm so a later hide is recorded as a fresh end-of-session.
      sessionEnded = false;
    }
  });

  window.addEventListener("pagehide", () => endSession("pagehide"));
}

// ── Property hygiene ─────────────────────────────────────────────────────────

/**
 * Telemetry describes *behaviour*, not content. Requirement text, spec bodies
 * and Figma tokens must never reach a log line, so properties are capped and
 * obviously-sensitive keys are dropped outright. Callers should send lengths,
 * ids and enums — `scrub` is the backstop for when they forget.
 */
const MAX_STRING = 200;
const DENY = /^(requirement|spec|spec_document|answer|answers|content|text|token|access_token|secret|password|api_key|prompt)$/i;

function scrub(props: TrackProps): TrackProps {
  const out: TrackProps = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (DENY.test(k)) {
      // Keep the shape (how much did they type?) without the content.
      if (typeof v === "string") out[`${k}_chars`] = v.length;
      else if (Array.isArray(v)) out[`${k}_count`] = v.length;
      continue;
    }
    if (typeof v === "string") {
      out[k] = v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
    } else if (v === null || ["number", "boolean"].includes(typeof v)) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.length <= 20 ? v.map(item => (typeof item === "string" && item.length > MAX_STRING ? `${item.slice(0, MAX_STRING)}…` : item)) : v.length;
    } else if (typeof v === "object") {
      out[k] = scrub(v as TrackProps);
    }
    // functions / undefined / symbols are dropped
  }
  return out;
}
