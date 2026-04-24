#!/usr/bin/env bash
# ── Chat Room X: Setup ───────────────────────────────────────────────
# Cloud-only variant — installs Node/Bun dependencies only.
# No local inference engines, no model downloads, no CUDA builds.
#
# Usage:
#   ./setup.sh                    # Full setup (deps + env)
#   ./setup.sh service install    # Install systemd service
#   ./setup.sh service uninstall  # Remove systemd service
#   ./setup.sh service status     # Check service status
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SERVICE_NAME="chatroom-x"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# ── Service management ──────────────────────────────────────────────
service_install() {
    echo "═══════════════════════════════════════════════════════════"
    echo "  Chat Room X: Install Service"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "  Project path: ${SCRIPT_DIR}"
    echo "  Service file: ${SERVICE_FILE}"
    echo ""

    if [[ ! -f "${SCRIPT_DIR}/chatroom-x.service" ]]; then
        echo "  ✗ chatroom-x.service template not found in ${SCRIPT_DIR}"
        exit 1
    fi

    # Detect the user who owns the project directory (not root)
    RUN_USER="$(stat -c '%U' "${SCRIPT_DIR}")"
    USER_HOME="$(eval echo "~${RUN_USER}")"

    echo "  Run as user: ${RUN_USER}"
    echo "  User home:   ${USER_HOME}"
    echo ""

    # Generate service file with actual values substituted
    sed -e "s|__WORKING_DIR__|${SCRIPT_DIR}|g" \
        -e "s|__RUN_USER__|${RUN_USER}|g" \
        -e "s|__USER_HOME__|${USER_HOME}|g" \
        "${SCRIPT_DIR}/chatroom-x.service" | sudo tee "${SERVICE_FILE}" > /dev/null

    sudo systemctl daemon-reload
    sudo systemctl enable "${SERVICE_NAME}"
    echo ""
    echo "  ✓ Service installed and enabled"
    echo ""
    echo "  Commands:"
    echo "    sudo systemctl start  ${SERVICE_NAME}   # Start"
    echo "    sudo systemctl stop   ${SERVICE_NAME}   # Stop"
    echo "    sudo systemctl status ${SERVICE_NAME}   # Status"
    echo "    journalctl -u ${SERVICE_NAME} -f        # Logs"
    echo ""
}

service_uninstall() {
    echo "═══════════════════════════════════════════════════════════"
    echo "  Chat Room X: Uninstall Service"
    echo "═══════════════════════════════════════════════════════════"
    echo ""

    if [[ -f "${SERVICE_FILE}" ]]; then
        sudo systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
        sudo systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
        sudo rm -f "${SERVICE_FILE}"
        sudo systemctl daemon-reload
        echo "  ✓ Service removed"
    else
        echo "  ⚠ Service not installed (${SERVICE_FILE} not found)"
    fi
    echo ""
}

service_status() {
    if [[ -f "${SERVICE_FILE}" ]]; then
        echo "  Service file: ${SERVICE_FILE}"
        echo "  Working dir:  $(grep 'WorkingDirectory=' "${SERVICE_FILE}" | cut -d= -f2)"
        echo ""
        sudo systemctl status "${SERVICE_NAME}" --no-pager 2>/dev/null || true
    else
        echo "  ⚠ Service not installed"
    fi
}

# ── Handle "service" subcommand ─────────────────────────────────────
if [[ "${1:-}" == "service" ]]; then
    case "${2:-}" in
        install)   service_install   ;;
        uninstall) service_uninstall ;;
        status)    service_status    ;;
        *)
            echo "Usage: $0 service [install|uninstall|status]"
            exit 1
            ;;
    esac
    exit 0
fi

echo "═══════════════════════════════════════════════════════════"
echo "  Chat Room X: Setup"
echo "═══════════════════════════════════════════════════════════"

# ── 1. Check prerequisites ──────────────────────────────────────────
echo "[1/3] Checking prerequisites..."

if ! command -v bun &>/dev/null; then
    echo "  ⚠ Bun not found. Installing..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi
echo "  ✓ Bun: $(bun --version)"

if ! command -v node &>/dev/null; then
    echo "  ⚠ Node.js not found — Bun will be used as runtime."
else
    echo "  ✓ Node: $(node --version)"
fi

# Python3 + venv required for Agent Room workspace sandboxing
if command -v python3 &>/dev/null; then
    echo "  ✓ Python: $(python3 --version 2>&1)"
    if ! python3 -m venv --help &>/dev/null; then
        echo "  ⚠ python3-venv not found. Installing..."
        sudo apt-get install -y python3-venv 2>/dev/null || echo "  ⚠ Could not install python3-venv. Agent Room may fail. Run: sudo apt install python3-venv"
    fi
else
    echo "  ⚠ python3 not found. Agent Room requires Python 3. Run: sudo apt install python3 python3-venv"
fi

# ── 2. Install dependencies ────────────────────────────────────────
echo "[2/3] Installing dependencies..."

echo "  Installing inference manager deps..."
(cd inference && bun install)

echo "  Installing dashboard deps..."
(cd dashboard && npm install)

# ── 3. Environment config ──────────────────────────────────────────
echo "[3/3] Checking environment config..."

if [[ ! -f ".env" ]]; then
    if [[ -f ".env.example" ]]; then
        cp .env.example .env
        echo "  Created .env from .env.example"
        echo "  ⚠ Please edit .env and set your ENOWXAI_API_KEY"
    else
        echo "  ⚠ No .env file found. Create one with your cloud provider keys."
    fi
else
    echo "  ✓ .env exists"
fi

# Validate required env vars
if [[ -f ".env" ]]; then
    set -a; source .env; set +a
    if [[ -z "${ENOWXAI_BASE_URL:-}" ]]; then
        echo "  ⚠ ENOWXAI_BASE_URL not set in .env"
    else
        echo "  ✓ Provider: ${ENOWXAI_BASE_URL}"
    fi
fi

# Create data directories
mkdir -p results docs

echo ""
echo "✅ Setup complete!"
echo ""
echo "Cloud provider configured — no local engines needed."
echo ""
echo "Next steps:"
echo "  1. Edit .env with your cloud API keys"
echo "  2. Run: ./run_all.sh"
echo ""
echo "Optional — install as systemd service:"
echo "  ./setup.sh service install    # Auto-detects this directory"
echo "  sudo systemctl start ${SERVICE_NAME}"
echo ""
