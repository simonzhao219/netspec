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
};

export default nextConfig;
