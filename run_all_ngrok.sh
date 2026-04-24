#!/usr/bin/env bash
# ── Chat Room X: Run Dashboard + Cloud Manager + Ngrok Tunnel ─────
# Cloud-only variant — starts cloud inference manager, dashboard, and ngrok tunnel.
#
# Usage:
#   ./run_all_ngrok.sh                  # Start all + ngrok (cloud mode)
#   ./run_all_ngrok.sh stop             # Stop everything including ngrok
#
# Environment (.env):
#   NGROK_AUTHTOKEN=xxx                 # Required: ngrok auth token
#   NGROK_DOMAIN=xxx.ngrok-free.dev     # Required: ngrok static domain
#   DASHBOARD_PORT=3000                 # Dashboard port (default: 3000)
#   CONTROL_PORT=3002                   # Manager API port

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Load .env ───────────────────────────────────────────────────
if [[ -f ".env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source ".env"
    set +a
fi

CMD="${1:-start}"
CONTROL_PORT="${CONTROL_PORT:-3002}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
export CONTROL_PORT DASHBOARD_PORT

# ── Colors ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
MAGENTA='\033[0;35m'
NC='\033[0m'

# ── Validate ngrok config ──────────────────────────────────────
validate_ngrok() {
    if ! command -v ngrok &>/dev/null; then
        echo -e "${RED}Error: ngrok is not installed.${NC}"
        echo "  Install: https://ngrok.com/download"
        exit 1
    fi

    if [[ -z "${NGROK_AUTHTOKEN:-}" ]]; then
        echo -e "${RED}Error: NGROK_AUTHTOKEN not set in .env${NC}"
        echo "  Add: NGROK_AUTHTOKEN=your_token_here"
        exit 1
    fi

    if [[ -z "${NGROK_DOMAIN:-}" ]]; then
        echo -e "${RED}Error: NGROK_DOMAIN not set in .env${NC}"
        echo "  Add: NGROK_DOMAIN=your-domain.ngrok-free.dev"
        exit 1
    fi
}

# ── Stop all services ──────────────────────────────────────────
stop_all() {
    echo -e "${YELLOW}Stopping all services...${NC}"
    pkill -f "ngrok http" 2>/dev/null && echo "  Ngrok stopped." || true
    pkill -f "bun.*inference/manager\.js" 2>/dev/null && echo "  Manager stopped." || true
    pkill -f "node.*inference/manager\.js" 2>/dev/null || true
    pkill -f "vite.*--port ${DASHBOARD_PORT}" 2>/dev/null || true
    lsof -ti:"$DASHBOARD_PORT" 2>/dev/null | xargs kill 2>/dev/null || true
    echo -e "${GREEN}All services stopped.${NC}"
}

# ── Status check ───────────────────────────────────────────────
show_status() {
    echo "═══ Chat Room X + Ngrok Status ═══"
    echo ""
    if pgrep -f "(bun|node).*manager.js" > /dev/null 2>&1; then
        echo -e "  Manager:   ${GREEN}running${NC}"
        python3 -c "import urllib.request,json; r=urllib.request.urlopen('http://localhost:${CONTROL_PORT}/status'); d=json.loads(r.read()); print(f'  Mode:      {d[\"mode\"]} ({d[\"label\"]})')" 2>/dev/null || true
    else
        echo -e "  Manager:   ${RED}stopped${NC}"
    fi
    if pgrep -f "vite" > /dev/null 2>&1; then
        echo -e "  Dashboard: ${GREEN}running${NC} → http://localhost:${DASHBOARD_PORT}"
    else
        echo -e "  Dashboard: ${RED}stopped${NC}"
    fi
    if pgrep -f "ngrok http" > /dev/null 2>&1; then
        echo -e "  Ngrok:     ${GREEN}running${NC} → https://${NGROK_DOMAIN:-unknown}"
    else
        echo -e "  Ngrok:     ${RED}stopped${NC}"
    fi
    exit 0
}

case "$CMD" in
    stop)
        stop_all
        exit 0
        ;;
    status)
        show_status
        ;;
    start)
        # continue below
        ;;
    *)
        echo "Usage: $0 [start|stop|status]"
        exit 1
        ;;
esac

# ── Pre-flight checks ──────────────────────────────────────────
validate_ngrok

if [[ ! -f "inference/manager.js" ]]; then
    echo -e "${RED}Error: inference/manager.js not found${NC}"
    exit 1
fi

if [[ ! -f "dashboard/package.json" ]]; then
    echo -e "${RED}Error: dashboard/package.json not found${NC}"
    exit 1
fi

# Check node_modules
if [[ ! -d "dashboard/node_modules" ]]; then
    echo -e "${YELLOW}Installing dashboard dependencies...${NC}"
    (cd dashboard && npm install)
fi

# ── Stop existing services ─────────────────────────────────────
pkill -f "ngrok http" 2>/dev/null || true
pkill -f "bun.*inference/manager\.js" 2>/dev/null || true
pkill -f "node.*inference/manager\.js" 2>/dev/null || true
lsof -ti:"$DASHBOARD_PORT" 2>/dev/null | xargs kill 2>/dev/null || true

sleep 1

# ── Start Cloud Inference Manager ──────────────────────────────
echo -e "${CYAN}═══ Chat Room X + Ngrok ═══${NC}"
echo ""
echo -e "Starting cloud inference manager..."
echo -e "  Provider: ${GREEN}${ENOWXAI_BASE_URL:-not set}${NC}"
bun inference/manager.js enowxai &
MANAGER_PID=$!

# Wait for manager to be ready (max 10s — cloud starts instantly)
echo -n "  Waiting for manager"
for i in $(seq 1 10); do
    if python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:${CONTROL_PORT}/health')" 2>/dev/null; then
        echo -e " ${GREEN}ready!${NC}"
        break
    fi
    echo -n "."
    sleep 1
done

if ! kill -0 $MANAGER_PID 2>/dev/null; then
    echo -e " ${RED}FAILED${NC}"
    echo "Manager process died. Check logs above."
    exit 1
fi

# ── Start Dashboard ────────────────────────────────────────────
echo ""
echo "Starting dashboard..."
(cd dashboard && npx vite --port "$DASHBOARD_PORT" --host) &
DASHBOARD_PID=$!

# Wait for dashboard to be ready
echo -n "  Waiting for dashboard"
for i in $(seq 1 15); do
    if curl -s "http://localhost:${DASHBOARD_PORT}" >/dev/null 2>&1; then
        echo -e " ${GREEN}ready!${NC}"
        break
    fi
    echo -n "."
    sleep 1
done

# ── Start Ngrok Tunnel ─────────────────────────────────────────
echo ""
echo -e "Starting ngrok tunnel → ${MAGENTA}${NGROK_DOMAIN}${NC}..."

# Set ngrok authtoken
ngrok config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null 2>&1

# Start ngrok tunneling to the dashboard (which proxies to manager)
ngrok http "$DASHBOARD_PORT" \
    --domain="$NGROK_DOMAIN" \
    --log=stdout \
    --log-level=warn &
NGROK_PID=$!

# Wait for ngrok to establish tunnel
echo -n "  Waiting for ngrok"
for i in $(seq 1 15); do
    if curl -s "http://localhost:4040/api/tunnels" >/dev/null 2>&1; then
        echo -e " ${GREEN}ready!${NC}"
        break
    fi
    echo -n "."
    sleep 1
done

# Verify ngrok is running
if ! kill -0 $NGROK_PID 2>/dev/null; then
    echo -e " ${RED}FAILED${NC}"
    echo "Ngrok process died. Check your NGROK_AUTHTOKEN and NGROK_DOMAIN."
    echo "Continuing without ngrok..."
    NGROK_PID=""
fi

# ── Print summary ──────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══ All services running ═══${NC}"
echo ""
echo -e "  ${CYAN}Local:${NC}"
echo -e "    Dashboard:  http://localhost:${DASHBOARD_PORT}"
echo -e "    Manager:    http://localhost:${CONTROL_PORT}"
echo -e "    Mode:       ${GREEN}enowxai (cloud-only)${NC}"
echo ""
echo -e "  ${MAGENTA}Remote (ngrok):${NC}"
echo -e "    Dashboard:  ${MAGENTA}https://${NGROK_DOMAIN}${NC}"
echo -e "    Ngrok UI:   http://localhost:4040"
echo ""
echo -e "  Press ${YELLOW}Ctrl+C${NC} to stop all services."
echo ""

# ── Trap Ctrl+C to clean shutdown ─────────────────────────────
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down...${NC}"
    [[ -n "${NGROK_PID:-}" ]] && kill $NGROK_PID 2>/dev/null
    kill $DASHBOARD_PID 2>/dev/null
    kill $MANAGER_PID 2>/dev/null
    [[ -n "${NGROK_PID:-}" ]] && wait $NGROK_PID 2>/dev/null
    wait $DASHBOARD_PID 2>/dev/null
    wait $MANAGER_PID 2>/dev/null
    echo -e "${GREEN}Done.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for any process to exit
if [[ -n "${NGROK_PID:-}" ]]; then
    wait -n $MANAGER_PID $DASHBOARD_PID $NGROK_PID 2>/dev/null
else
    wait -n $MANAGER_PID $DASHBOARD_PID 2>/dev/null
fi
echo -e "${RED}A service exited unexpectedly. Stopping all...${NC}"
cleanup
