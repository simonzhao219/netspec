/**
 * Server-side telemetry sink for the NetSpec frontend app (Node runtime only).
 *
 * Two independent delivery paths, by design:
 *
 *   1. stdout  — one compact JSON line per event. Databricks Apps exports every
 *      stdout/stderr line into the workspace's `otel_logs` Unity Catalog table
 *      over OpenTelemetry, with no export code, IAM setup or token handling in
 *      the app. This is the primary path and it is always on.
 *
 *   2. Delta   — an optional direct write into a typed Unity Catalog table via
 *      the SQL Statement Execution API. Off unless TELEMETRY_TABLE and
 *      TELEMETRY_WAREHOUSE_ID are both set. This exists so telemetry still
 *      lands if the workspace has not enabled App telemetry / OTel export on
 *      this app, and so the PoC has a typed table it fully controls.
 *
 * Neither path is allowed to fail a request: everything is best-effort and every
 * error is swallowed after being reported once to stderr.
 *
 * The Python services carry a mirror of this module — telemetry.py inside each
 * of the two backend service directories.
 * The two are deliberately duplicated rather than shared — same call as the rest
 * of this repo, where llm_client.py/cost.py are copied per service.
 */

// ── Event record ─────────────────────────────────────────────────────────────

/** Marker on every line so SQL can separate telemetry from ordinary app logs. */
export const TELEMETRY_SCHEMA = "ep.app_event.v1";

export interface EventRecord {
  event_id: string;
  telemetry_schema: string;
  /** Which EP app produced this — lets NetSpec, BugZapper and Polaris share one table. */
  app: string;
  /** Which process inside the app: frontend | text-spec-service | figma-service. */
  service: string;
  /** ui_interaction | server_event | app_output | llm_call */
  event_type: string;
  event_name: string;
  event_time: string;
  received_at: string;
  page: string | null;
  workflow: string | null;
  session_id: string | null;
  app_session_id: string | null;
  user_email: string | null;
  user_id: string | null;
  request_id: string | null;
  duration_ms: number | null;
  /** JSON-encoded free-form payload. Kept as a string so the table schema is
   *  stable while event authors stay free; query it with `properties:key`. */
  properties: string;
}

/** Column order used by both the INSERT and the from_json struct below. */
export const EVENT_COLUMNS = [
  "event_id", "telemetry_schema", "app", "service", "event_type", "event_name",
  "event_time", "received_at", "page", "workflow", "session_id", "app_session_id",
  "user_email", "user_id", "request_id", "duration_ms", "properties",
] as const;

const PAYLOAD_SCHEMA =
  "array<struct<" +
  EVENT_COLUMNS.map(c => `${c}:${c === "duration_ms" ? "bigint" : "string"}`).join(",") +
  ">>";

// ── Config ───────────────────────────────────────────────────────────────────

const APP_NAME = process.env.TELEMETRY_APP_NAME || "netspec";
const SERVICE_NAME = process.env.TELEMETRY_SERVICE_NAME || "frontend";
/** Fully-qualified catalog.schema.table, e.g. ep_dev.netspec.app_events. */
const TABLE = (process.env.TELEMETRY_TABLE || "").trim();
const WAREHOUSE_ID = (process.env.TELEMETRY_WAREHOUSE_ID || "").trim();
const FLUSH_ROWS = Number(process.env.TELEMETRY_FLUSH_ROWS || 50);
const FLUSH_MS = Number(process.env.TELEMETRY_FLUSH_MS || 10_000);

/** Only ever interpolated after passing this — the identifier can't be quoted
 *  as a parameter, so it is whitelisted instead of trusted. */
const TABLE_RE = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

function deltaEnabled(): boolean {
  return TABLE !== "" && WAREHOUSE_ID !== "" && TABLE_RE.test(TABLE);
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Build a complete event record from the parts a caller knows. */
export function buildRecord(partial: Partial<EventRecord> & { event_name: string }): EventRecord {
  const now = new Date().toISOString();
  return {
    event_id: partial.event_id ?? randomId(),
    telemetry_schema: TELEMETRY_SCHEMA,
    app: partial.app ?? APP_NAME,
    service: partial.service ?? SERVICE_NAME,
    event_type: partial.event_type ?? "ui_interaction",
    event_name: partial.event_name,
    event_time: partial.event_time ?? now,
    received_at: now,
    page: partial.page ?? null,
    workflow: partial.workflow ?? null,
    session_id: partial.session_id ?? null,
    app_session_id: partial.app_session_id ?? null,
    user_email: partial.user_email ?? null,
    user_id: partial.user_id ?? null,
    request_id: partial.request_id ?? null,
    duration_ms: partial.duration_ms ?? null,
    properties: partial.properties ?? "{}",
  };
}

/** Write one record to both sinks. Never throws. */
export function emit(record: EventRecord): void {
  try {
    process.stdout.write(JSON.stringify(record) + "\n");
  } catch {
    // A broken stdout must not fail the request.
  }
  if (deltaEnabled()) enqueue(record);
}

// ── Delta buffer ─────────────────────────────────────────────────────────────

let buffer: EventRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let reportedFailure = false;

function enqueue(record: EventRecord): void {
  buffer.push(record);
  if (buffer.length >= FLUSH_ROWS) {
    void flushDelta();
  } else if (flushTimer === null) {
    flushTimer = setTimeout(() => void flushDelta(), FLUSH_MS);
    // Don't hold the process open just to flush telemetry.
    if (typeof flushTimer === "object" && flushTimer && "unref" in flushTimer) {
      (flushTimer as { unref: () => void }).unref();
    }
  }
}

/** Drain the buffer into Unity Catalog. Best-effort: a failed batch is dropped
 *  (stdout already has it) rather than retried forever into an OOM. */
export async function flushDelta(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0 || !deltaEnabled()) return;

  const batch = buffer;
  buffer = [];

  try {
    const token = await getM2MToken();
    if (!token) return;
    const host = normalizedHost();
    if (!host) return;

    const res = await fetch(`${host}/api/2.0/sql/statements`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        warehouse_id: WAREHOUSE_ID,
        statement: insertStatement(TABLE),
        // The whole batch travels as ONE bound parameter, so no event field is
        // ever interpolated into SQL text.
        parameters: [{ name: "payload", type: "STRING", value: JSON.stringify(batch) }],
        wait_timeout: "30s",
        on_wait_timeout: "CONTINUE",
      }),
    });

    if (!res.ok && !reportedFailure) {
      reportedFailure = true;
      const detail = await res.text().catch(() => "");
      process.stderr.write(
        `[telemetry] Delta sink disabled after first failure (HTTP ${res.status}): ${detail.slice(0, 400)}\n` +
        `[telemetry] stdout -> otel_logs is unaffected; see doc/SDCL_telemetry_deployment.md\n`
      );
    }
  } catch (err) {
    if (!reportedFailure) {
      reportedFailure = true;
      process.stderr.write(`[telemetry] Delta sink error (stdout path unaffected): ${String(err).slice(0, 400)}\n`);
    }
  }
}

/**
 * One INSERT that unpacks the whole batch from a single JSON parameter.
 * `try_to_timestamp` is tried bare first (handles most ISO-8601) then with an
 * explicit pattern, so a millisecond-and-Z timestamp is never silently NULLed.
 */
function insertStatement(table: string): string {
  const ts = (col: string) =>
    `coalesce(try_to_timestamp(e.${col}), try_to_timestamp(e.${col}, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"))`;
  return `
INSERT INTO ${table} (
  event_id, telemetry_schema, app, service, event_type, event_name,
  event_time, received_at, event_date, page, workflow, session_id,
  app_session_id, user_email, user_id, request_id, duration_ms, properties
)
SELECT
  e.event_id, e.telemetry_schema, e.app, e.service, e.event_type, e.event_name,
  ${ts("event_time")}, ${ts("received_at")}, to_date(${ts("received_at")}),
  e.page, e.workflow, e.session_id, e.app_session_id,
  e.user_email, e.user_id, e.request_id, e.duration_ms, e.properties
FROM (SELECT explode(from_json(:payload, '${PAYLOAD_SCHEMA}')) AS e)`.trim();
}

// ── Databricks M2M auth ──────────────────────────────────────────────────────
// Databricks Apps injects DATABRICKS_HOST / CLIENT_ID / CLIENT_SECRET into every
// app container; the app's own service principal is what writes the table.

let cachedToken: { token: string; exp: number } | null = null;

function normalizedHost(): string {
  const raw = (process.env.DATABRICKS_HOST || "").replace(/\/$/, "");
  if (!raw) return "";
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

async function getM2MToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.exp > now + 30_000) return cachedToken.token;

  const host = normalizedHost();
  const clientId = process.env.DATABRICKS_CLIENT_ID || "";
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET || "";
  if (!host || !clientId || !clientSecret) return "";

  const res = await fetch(`${host}/oidc/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "all-apis",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) return "";
  const data = await res.json();
  if (!data?.access_token) return "";
  cachedToken = { token: data.access_token, exp: now + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

// ── Misc ─────────────────────────────────────────────────────────────────────

function randomId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
