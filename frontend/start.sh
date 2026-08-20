#!/bin/bash
set -e

export PORT="${DATABRICKS_APP_PORT:-3000}"
export HOSTNAME="0.0.0.0"

echo "[start.sh] Installing dependencies..."
npm ci

echo "[start.sh] Cleaning previous build..."
rm -rf .next

echo "[start.sh] Building Next.js..."
npm run build

echo "[start.sh] Copying static assets for standalone mode..."
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public

echo "[start.sh] Starting server on port $PORT..."
exec node .next/standalone/server.js
