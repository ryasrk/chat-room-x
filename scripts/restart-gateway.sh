#!/usr/bin/env bash
# ── EnowxAI Gateway Restart Script ─────────────────────────────
# Stops enowxai, kills port 1431, then starts enowxai again.
#
# Usage:
#   ./scripts/restart-gateway.sh          # Full restart (stop → kill → start)
#   ./scripts/restart-gateway.sh stop     # Stop only
#   ./scripts/restart-gateway.sh start    # Start only
#   ./scripts/restart-gateway.sh status   # Check status

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

GATEWAY_PORT=1431
CMD="${1:-restart}"

log_info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_err()   { echo -e "${RED}[ERR]${NC}   $*"; }

# ── Stop enowxai ───────────────────────────────────────────────
do_stop() {
    log_info "Stopping enowxai..."
    if command -v enowxai &>/dev/null; then
        enowxai stop && log_ok "enowxai stopped." || log_warn "enowxai stop returned non-zero."
    else
        log_warn "'enowxai' command not found — trying systemctl..."
        sudo systemctl stop enowxai 2>/dev/null && log_ok "enowxai service stopped." || log_warn "systemctl stop failed (may not be a systemd service)."
    fi
}

# ── Kill port 1431 PID ─────────────────────────────────────────
do_kill_port() {
    log_info "Killing any process on port ${GATEWAY_PORT}..."
    local pids
    pids=$(lsof -ti:"${GATEWAY_PORT}" 2>/dev/null || true)

    if [[ -z "$pids" ]]; then
        log_ok "No process found on port ${GATEWAY_PORT}."
        return
    fi

    echo "$pids" | while read -r pid; do
        log_info "Killing PID $pid (port ${GATEWAY_PORT})..."
        kill -9 "$pid" 2>/dev/null && log_ok "PID $pid killed." || log_warn "Failed to kill PID $pid."
    done

    # Verify port is free
    sleep 1
    if lsof -ti:"${GATEWAY_PORT}" &>/dev/null; then
        log_err "Port ${GATEWAY_PORT} still in use after kill!"
        return 1
    fi
    log_ok "Port ${GATEWAY_PORT} is free."
}

# ── Start enowxai ──────────────────────────────────────────────
do_start() {
    log_info "Starting enowxai..."
    if command -v enowxai &>/dev/null; then
        enowxai start && log_ok "enowxai started." || log_err "enowxai start failed!"
    else
        log_warn "'enowxai' command not found — trying systemctl..."
        sudo systemctl start enowxai 2>/dev/null && log_ok "enowxai service started." || log_err "systemctl start failed!"
    fi
}

# ── Status check ───────────────────────────────────────────────
do_status() {
    echo -e "${CYAN}═══ EnowxAI Gateway Status ═══${NC}"
    echo ""

    # Check port
    local pids
    pids=$(lsof -ti:"${GATEWAY_PORT}" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
        echo -e "  Port ${GATEWAY_PORT}: ${GREEN}in use${NC} (PID: ${pids//$'\n'/, })"
    else
        echo -e "  Port ${GATEWAY_PORT}: ${RED}free (not running)${NC}"
    fi

    # Check enowxai command/service
    if command -v enowxai &>/dev/null; then
        echo -e "  CLI:        ${GREEN}available${NC} ($(which enowxai))"
    else
        echo -e "  CLI:        ${YELLOW}not in PATH${NC}"
    fi

    # Check systemd service
    if systemctl is-active enowxai &>/dev/null 2>&1; then
        echo -e "  Service:    ${GREEN}active${NC}"
    else
        echo -e "  Service:    ${RED}inactive${NC}"
    fi
    echo ""
}

# ── Main ────────────────────────────────────────────────────────
case "$CMD" in
    stop)
        do_stop
        do_kill_port
        ;;
    start)
        do_start
        ;;
    status)
        do_status
        ;;
    restart)
        echo -e "${CYAN}═══ EnowxAI Gateway Restart ═══${NC}"
        echo ""
        do_stop
        do_kill_port
        do_start
        echo ""
        echo -e "${GREEN}═══ Restart complete ═══${NC}"
        ;;
    *)
        echo "Usage: $0 [restart|stop|start|status]"
        exit 1
        ;;
esac
