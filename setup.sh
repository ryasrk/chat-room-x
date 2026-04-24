#!/usr/bin/env bash
# ── Chat Room X: Setup ───────────────────────────────────────────────
# Cloud-only variant — installs Node/Bun dependencies only.
# No local inference engines, no model downloads, no CUDA builds.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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
