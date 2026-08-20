#!/usr/bin/env bash
# NetSpec Agentic AI — Quick Start
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Backend .env（兩個服務共用同一份，各自目錄下是 symlink）───────────────────────
cd "$ROOT/backend"

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo ""
  echo "=========================================="
  echo "  請編輯 backend/.env 並填入您的 API Key"
  echo "  API_KEY=<Azure AI Services Key>"
  echo "=========================================="
  echo ""
  exit 1
fi

# ── text-spec-service（需求輸入 → 蘇格拉底追問 → PRD）────────────────────────────
cd "$ROOT/backend/text-spec-service"

echo ">>> 安裝 text-spec-service Python 依賴..."
pip install -r requirements.txt -q

echo ">>> 啟動 text-spec-service (http://localhost:8000)..."
uvicorn main:app --host 0.0.0.0 --port 8000 --no-access-log &
TEXT_SPEC_PID=$!

# ── figma-service（Frame 分析 + Frame 監控 + Figma Story pipeline）──────────────
cd "$ROOT/backend/figma-service"

echo ">>> 安裝 figma-service Python 依賴..."
pip install -r requirements.txt -q

echo ">>> 啟動 figma-service (http://localhost:8001)..."
uvicorn main:app --host 0.0.0.0 --port 8001 --no-access-log &
FIGMA_PID=$!

# ── Frontend ───────────────────────────────────────────────────────────────────
cd "$ROOT/frontend"

if [ ! -d "node_modules" ]; then
  echo ">>> 安裝 Node 依賴..."
  npm install -q
fi

echo ">>> 啟動 Frontend (http://localhost:3000)..."
npm run dev &
FRONTEND_PID=$!

echo ""
echo "=========================================="
echo "  NetSpec 已啟動"
echo "  Frontend          : http://localhost:3000"
echo "  text-spec-service : http://localhost:8000（API Docs: /docs）"
echo "  figma-service     : http://localhost:8001（API Docs: /docs）"
echo "  停止請按 Ctrl+C"
echo "=========================================="
echo ""

trap "kill $TEXT_SPEC_PID $FIGMA_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
