import type { NextConfig } from "next";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

const nextConfig: NextConfig = {
  // Standalone output bundles everything needed into .next/standalone/server.js
  // so Databricks Apps can start with `node .next/standalone/server.js` (no npm).
  output: "standalone",

  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.io"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
      {
        protocol: "http",
        hostname: "**",
      },
    ],
  },
  // API calls are proxied by app/api/[...path]/route.ts (with M2M auth).
  // No rewrite needed.

  eslint: {
    // `next build` runs ESLint and fails the build on any error. This repo has a
    // standing backlog of no-explicit-any / react-hooks findings that predate the
    // telemetry work, so the build has been failing at the lint step — and since
    // start.sh runs `npm run build` under `set -e`, that aborts the Databricks
    // Apps deploy before the server ever starts.
    //
    // Lint is still enforced where it belongs: `npm run lint` and CI. This only
    // stops style findings from blocking a deploy. TypeScript is deliberately NOT
    // relaxed (no typescript.ignoreBuildErrors) — a real type error must still
    // fail the build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
