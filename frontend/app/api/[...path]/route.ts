import type { NextRequest } from "next/server";

// This route proxies a streaming (SSE) backend response byte-for-byte —
// it must never be cached, statically analyzed, or buffered by Next.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Stage 2: text-spec and Figma now run as two independent backend processes.
// Route by the first path segment — /api/figma/* and /api/teams-webhooks/*
// go to the Figma service, everything else (sessions/translate/history/
// health/switch-mode/...) goes to the text-spec service. BACKEND_URL is kept
// as a fallback alias for TEXT_SPEC_BACKEND_URL for backward compatibility.
const TEXT_SPEC_BACKEND = (process.env.TEXT_SPEC_BACKEND_URL || process.env.BACKEND_URL || "http://localhost:8000").replace(/\/$/, "");
const FIGMA_BACKEND = (process.env.FIGMA_BACKEND_URL || "http://localhost:8001").replace(/\/$/, "");

function backendFor(path: string[]): string {
  const first = path[0] || "";
  return first === "figma" || first === "teams-webhooks" ? FIGMA_BACKEND : TEXT_SPEC_BACKEND;
}

let _cached: { token: string; exp: number } | null = null;

async function getM2MToken(): Promise<string> {
  const now = Date.now();
  if (_cached && _cached.exp > now + 30_000) return _cached.token;

  const rawHost = (process.env.DATABRICKS_HOST || "").replace(/\/$/, "");
  const host = rawHost.startsWith("http") ? rawHost : `https://${rawHost}`;
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
  const data = await res.json();
  _cached = { token: data.access_token, exp: now + (data.expires_in ?? 3600) * 1000 };
  return _cached.token;
}

async function proxy(req: NextRequest, path: string[]) {
  const search = req.nextUrl.search;
  const target = `${backendFor(path)}/api/${path.join("/")}${search}`;

  // Databricks Apps injects the logged-in user's token into X-Forwarded-Access-Token.
  // Use that first (user-level auth), fall back to M2M service principal token.
  const userToken = req.headers.get("x-forwarded-access-token");
  const token = userToken || await getM2MToken();

  const headers = new Headers();
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  if (token) headers.set("authorization", `Bearer ${token}`);

  // Relay the platform-injected identity so backend telemetry can attribute
  // server-side events (pipeline steps, spec versions, token cost) to the human
  // who triggered them. Without this the backends would only ever see whichever
  // principal THIS hop authenticated as, not the logged-in user.
  for (const h of ["x-forwarded-email", "x-forwarded-user", "x-forwarded-preferred-username", "x-request-id"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  const hasBody = !["GET", "HEAD"].includes(req.method);
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: "manual",   // don't follow — pass 3xx back so the BROWSER navigates
    // @ts-ignore
    duplex: "half",
  });

  // Redirects (e.g. Figma OAuth start → figma.com, callback → frontend) must reach
  // the browser as a real 3xx + Location, not be transparently followed by fetch.
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("location");
    if (location) {
      return new Response(null, { status: upstream.status, headers: { location } });
    }
  }

  const upstreamCt = upstream.headers.get("content-type") || "";
  if (upstreamCt.includes("text/event-stream")) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstreamCt || "application/json" },
  });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path);
}
export async function POST(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path);
}
export async function PUT(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path);
}
export async function DELETE(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path);
}
export async function PATCH(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path);
}
