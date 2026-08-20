#!/usr/bin/env bash
# NetSpec — Start with ngrok tunnel
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
NGROK_BIN="${HOME}/.local/bin/ngrok"

# ── Check ngrok ────────────────────────────────────────────────────────────────
if ! command -v "$NGROK_BIN" &>/dev/null && ! command -v ngrok &>/dev/null; then
  echo "❌ ngrok 未安裝，請先執行 install-ngrok.sh"
  exit 1
fi
NGROK_BIN=$(command -v ngrok)

# ── Check authtoken ────────────────────────────────────────────────────────────
if ! ngrok config check &>/dev/null 2>&1; then
  echo ""
  echo "⚠️  尚未設定 ngrok authtoken"
  echo "   1. 登入 https://dashboard.ngrok.com"
  echo "   2. 複製 Your Authtoken"
  echo "   3. 執行：ngrok config add-authtoken <YOUR_TOKEN>"
  echo ""
  exit 1
fi

# ── Start backend (two independent services) ────────────────────────────────────
echo ">>> 啟動 text-spec-service (port 8000)..."
fuser -k 8000/tcp 2>/dev/null || true
cd "$ROOT/backend/text-spec-service"
source /tmp/netspec-venv/bin/activate 2>/dev/null || true
uvicorn main:app --host 0.0.0.0 --port 8000 --reload --no-access-log >> /tmp/text-spec-service.log 2>&1 &
TEXT_SPEC_PID=$!

echo ">>> 啟動 figma-service (port 8001)..."
fuser -k 8001/tcp 2>/dev/null || true
cd "$ROOT/backend/figma-service"
uvicorn main:app --host 0.0.0.0 --port 8001 --reload --no-access-log >> /tmp/figma-service.log 2>&1 &
FIGMA_PID=$!
sleep 2

# ── Start frontend ─────────────────────────────────────────────────────────────
echo ">>> 啟動 Frontend (port 3000)..."
fuser -k 3000/tcp 2>/dev/null || true
cd "$ROOT/frontend"
npm run dev >> /tmp/netspec-frontend.log 2>&1 &
FRONTEND_PID=$!
sleep 3

# ── Start ngrok ────────────────────────────────────────────────────────────────
echo ">>> 啟動 ngrok tunnel (port 3000)..."
# ngrok http 只 tunnel 前端；前端的 /api rewrite 會 server-side proxy 到 localhost:8000
"$NGROK_BIN" http 3000 --log=stdout &
NGROK_PID=$!
sleep 2

# ── Get public URL ─────────────────────────────────────────────────────────────
PUBLIC_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tunnels'][0]['public_url'])" 2>/dev/null || echo "取得中...")

echo ""
echo "=========================================="
echo "  NetSpec 已啟動（含對外 tunnel）"
echo ""
echo "  本機 Frontend : http://localhost:3000"
echo "  text-spec-service : http://localhost:8000"
echo "  figma-service     : http://localhost:8001"
echo "  對外公開 URL  : ${PUBLIC_URL}"
echo ""
echo "  ngrok Dashboard : http://localhost:4040"
echo "  停止請按 Ctrl+C"
echo "=========================================="
echo ""

trap "kill $TEXT_SPEC_PID $FIGMA_PID $FRONTEND_PID $NGROK_PID 2>/dev/null" EXIT
wait
