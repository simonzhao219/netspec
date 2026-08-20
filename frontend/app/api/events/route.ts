import type { NextRequest } from "next/server";
import { buildRecord, emit, flushDelta, type EventRecord } from "@/lib/telemetry-sink";

// Telemetry must never be cached, prerendered, or run on the edge — the sink
// writes to process.stdout and keeps an in-process batch buffer.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/events — the app-telemetry ingest endpoint.
 *
 * This is a STATIC route segment, so Next matches it ahead of the sibling
 * catch-all `app/api/[...path]/route.ts`; telemetry is handled here and is never
 * proxied to a backend service.
 *
 * It lives in the frontend app on purpose. The browser talks to the frontend
 * app directly, so this is the one place where the identity headers that the
 * Databricks Apps platform injects describe the actual logged-in human rather
 * than whichever principal a proxy hop authenticated as. There is no auth code
 * here — the platform has already done it by the time the request arrives.
 */

/** Bound on one request so a malformed or hostile client can't exhaust memory. */
const MAX_EVENTS_PER_REQUEST = 100;

interface IncomingEvent {
  event_name?: string;
  event_time?: string;
  page?: string | null;
  session_id?: string | null;
  app_session_id?: string | null;
  workflow?: string | null;
  properties?: Record<string, unknown>;
}

/**
 * The acting user, injected by the Databricks Apps auth proxy. No authentication
 * code needed — and note X-Forwarded-Access-Token is deliberately NOT read here:
 * a bearer token has no place in a log line.
 */
function identityFrom(req: NextRequest) {
  const h = req.headers;
  return {
    user_email: h.get("x-forwarded-email"),
    user_id: h.get("x-forwarded-user"),
    request_id: h.get("x-request-id"),
    username: h.get("x-forwarded-preferred-username"),
  };
}

function asEventList(payload: unknown): IncomingEvent[] {
  if (Array.isArray(payload)) return payload as IncomingEvent[];
  if (payload && typeof payload === "object") {
    const events = (payload as { events?: unknown }).events;
    // Batched shape from track.ts …
    if (Array.isArray(events)) return events as IncomingEvent[];
    // … or a single bare event, which is what a hand-rolled fetch would send.
    if ((payload as IncomingEvent).event_name) return [payload as IncomingEvent];
  }
  return [];
}

export async function POST(req: NextRequest) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ accepted: false, error: "invalid JSON" }, { status: 400 });
  }

  const identity = identityFrom(req);
  const incoming = asEventList(payload).slice(0, MAX_EVENTS_PER_REQUEST);
  const records: EventRecord[] = [];

  for (const ev of incoming) {
    if (!ev?.event_name || typeof ev.event_name !== "string") continue;
    const properties = { ...(ev.properties ?? {}) };
    if (identity.username) properties.username = identity.username;

    records.push(buildRecord({
      event_type: "ui_interaction",
      event_name: ev.event_name,
      event_time: typeof ev.event_time === "string" ? ev.event_time : undefined,
      page: ev.page ?? null,
      workflow: ev.workflow ?? null,
      session_id: ev.session_id ?? null,
      app_session_id: ev.app_session_id ?? null,
      user_email: identity.user_email,
      user_id: identity.user_id,
      request_id: identity.request_id,
      duration_ms: typeof properties.duration_ms === "number" ? properties.duration_ms : null,
      properties: safeStringify(properties),
    }));
  }

  for (const record of records) emit(record);

  // A `session_end` means the tab is going away, so drain the Delta buffer now
  // instead of waiting out the flush window on a page nobody is looking at.
  if (records.some(r => r.event_name === "session_end")) {
    void flushDelta();
  }

  return Response.json({ accepted: true, count: records.length });
}

/** GET is a liveness probe for the ingest path — handy when verifying a deploy. */
export async function GET() {
  return Response.json({
    ok: true,
    endpoint: "/api/events",
    method: "POST",
    delta_sink: Boolean(process.env.TELEMETRY_TABLE && process.env.TELEMETRY_WAREHOUSE_ID),
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    // Circular or otherwise unserialisable — keep the event, drop the payload.
    return JSON.stringify({ _error: "unserializable properties" });
  }
}
