#!/usr/bin/env bash
# ── Chat Room X: Run Dashboard + Cloud Inference Manager ───────
# Cloud-only variant — no local inference, all LLM calls go to cloud providers.
#
# Usage:
#   ./run_all.sh                  # Start both (cloud provider mode)
#   ./run_all.sh stop             # Stop everything
#   ./run_all.sh status           # Check service status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -f ".env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source ".env"
    set +a
fi

CMD="${1:-start}"
CONTROL_PORT="${CONTROL_PORT:-18247}"
DASHBOARD_PORT="${DASHBOARD_PORT:-7391}"

# ── Resolve JS runtime (bun preferred, node fallback) ──────────
[[ -d "$HOME/.bun/bin" ]] && export PATH="$HOME/.bun/bin:$PATH"
if command -v bun &>/dev/null; then
    JS_RUNTIME="bun"
else
    JS_RUNTIME="node"
fi

# ── Colors ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

stop_all() {
    echo -e "${YELLOW}Stopping all services...${NC}"
    pkill -f "bun.*inference/manager\.js" 2>/dev/null && echo "  Manager stopped." || true
    pkill -f "node.*inference/manager\.js" 2>/dev/null || true
    pkill -f "vite.*--port ${DASHBOARD_PORT}" 2>/dev/null || true
    lsof -ti:"${DASHBOARD_PORT}" 2>/dev/null | xargs kill 2>/dev/null || true
    echo -e "${GREEN}All services stopped.${NC}"
}

case "$CMD" in
    stop)
        stop_all
        exit 0
        ;;
    status)
        echo "═══ Chat Room X Status ═══"
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
        exit 0
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
if [[ ! -f "inference/manager.js" ]]; then
    echo -e "${RED}Error: inference/manager.js not found${NC}"
    exit 1
fi

if [[ -z "${ENOWXAI_BASE_URL:-}" ]]; then
    echo -e "${RED}Error: ENOWXAI_BASE_URL is not set in .env${NC}"
    echo "  Cloud mode requires a configured provider. See .env.example"
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
pkill -f "bun.*inference/manager\.js" 2>/dev/null || true
pkill -f "node.*inference/manager\.js" 2>/dev/null || true
lsof -ti:"${DASHBOARD_PORT}" 2>/dev/null | xargs kill 2>/dev/null || true

sleep 1

# ── Start Cloud Inference Manager ──────────────────────────────
echo -e "${CYAN}═══ Chat Room X ═══${NC}"
echo ""
echo -e "Starting cloud inference manager..."
echo -e "  Provider: ${GREEN}${ENOWXAI_BASE_URL}${NC}"
echo -e "  Runtime:  ${CYAN}${JS_RUNTIME}${NC}"
$JS_RUNTIME inference/manager.js enowxai &
MANAGER_PID=$!

# Wait for manager to be ready (max 10s — cloud mode starts instantly)
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
(cd dashboard && npx vite --port "${DASHBOARD_PORT}" --host) &
DASHBOARD_PID=$!

sleep 2

echo ""
echo -e "${GREEN}═══ All services running (cloud mode) ═══${NC}"
echo ""
echo -e "  Dashboard:  ${CYAN}http://localhost:${DASHBOARD_PORT}${NC}"
echo -e "  Manager:    http://localhost:${CONTROL_PORT}"
echo -e "  Provider:   ${ENOWXAI_BASE_URL}"
echo -e "  Mode:       ${GREEN}enowxai (cloud-only)${NC}"
echo ""
echo -e "  Press ${YELLOW}Ctrl+C${NC} to stop all services."
echo ""

# ── Trap Ctrl+C to clean shutdown ─────────────────────────────
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down...${NC}"
    kill $DASHBOARD_PID 2>/dev/null
    kill $MANAGER_PID 2>/dev/null
    wait $DASHBOARD_PID 2>/dev/null
    wait $MANAGER_PID 2>/dev/null
    echo -e "${GREEN}Done.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for either process to exit
wait -n $MANAGER_PID $DASHBOARD_PID 2>/dev/null
echo -e "${RED}A service exited unexpectedly. Stopping all...${NC}"
cleanup