#!/usr/bin/env bash
# ─── RONIN Development Startup ────────────────────────────────────────────────
# Boots the full RONIN development stack:
#   1. ronin-core chatServer   → http://localhost:8787
#   2. macos-shell Vite dev    → http://localhost:5173
#
# Usage:
#   ./start.sh               — starts both, logs to terminal
#   ./start.sh --engine-only — starts chatServer only
#   ./start.sh --ui-only     — starts Vite only
#   ./start.sh --test        — runs integration tests then exits
#
# Environment variables (optional, all have defaults):
#   ANTHROPIC_API_KEY  — Anthropic API key for real LLM calls
#   RONIN_PORT         — chatServer port (default: 8787)
#   RONIN_MODEL        — default model (default: claude-sonnet-4-6)
#   RONIN_FORGE_URL    — URL the Swift shell loads for Forge (default: http://localhost:5173)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$SCRIPT_DIR/ronin-core"
SHELL_DIR="$SCRIPT_DIR/macos-shell"

# ── Colour helpers ─────────────────────────────────────────────────────────────
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

log()    { echo -e "${BOLD}[RONIN]${RESET} $*"; }
ok()     { echo -e "${GREEN}✓${RESET} $*"; }
warn()   { echo -e "${YELLOW}⚠${RESET} $*"; }
fail()   { echo -e "${RED}✗${RESET} $*"; exit 1; }
dim()    { echo -e "${DIM}$*${RESET}"; }

# ── Flags ──────────────────────────────────────────────────────────────────────
ENGINE_ONLY=false
UI_ONLY=false
RUN_TESTS=false

for arg in "$@"; do
  case "$arg" in
    --engine-only) ENGINE_ONLY=true ;;
    --ui-only)     UI_ONLY=true ;;
    --test)        RUN_TESTS=true ;;
    *) warn "Unknown flag: $arg" ;;
  esac
done

# ── Pre-flight checks ──────────────────────────────────────────────────────────

check_node() {
  if ! command -v node &>/dev/null; then
    fail "Node.js not found. Install via: brew install node"
  fi
  local version
  version=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ "$version" -lt 20 ]]; then
    fail "Node.js >= 20 required (found v$version)"
  fi
  ok "Node.js $(node --version)"
}

check_api_key() {
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    warn "ANTHROPIC_API_KEY not set — LLM calls will fail gracefully"
    warn "  Set it:  export ANTHROPIC_API_KEY=sk-ant-..."
  else
    ok "ANTHROPIC_API_KEY configured"
  fi
}

check_engine_deps() {
  if [[ ! -d "$ENGINE_DIR/node_modules" ]]; then
    log "Installing ronin-core dependencies..."
    (cd "$ENGINE_DIR" && npm install --silent)
  fi
  ok "ronin-core dependencies ready"
}

check_ui_deps() {
  if [[ ! -d "$SHELL_DIR/node_modules" ]]; then
    log "Installing macos-shell dependencies..."
    (cd "$SHELL_DIR" && npm install --silent)
  fi
  ok "macos-shell dependencies ready"
}

# ── PIDs for cleanup ───────────────────────────────────────────────────────────
ENGINE_PID=""
UI_PID=""

cleanup() {
  echo ""
  log "Shutting down..."
  if [[ -n "$ENGINE_PID" ]] && kill -0 "$ENGINE_PID" 2>/dev/null; then
    kill "$ENGINE_PID" && ok "chatServer stopped"
  fi
  if [[ -n "$UI_PID" ]] && kill -0 "$UI_PID" 2>/dev/null; then
    kill "$UI_PID" && ok "Vite dev server stopped"
  fi
}

trap cleanup EXIT INT TERM

# ── Start engine ───────────────────────────────────────────────────────────────

start_engine() {
  log "Starting chatServer on :${RONIN_PORT:-8787}..."
  (
    cd "$ENGINE_DIR"
    node api/chatServer.mjs
  ) &
  ENGINE_PID=$!

  # Wait for health check
  local retries=20
  while [[ $retries -gt 0 ]]; do
    if curl -sf "http://localhost:${RONIN_PORT:-8787}/health" &>/dev/null; then
      ok "chatServer running → http://localhost:${RONIN_PORT:-8787}"
      return 0
    fi
    retries=$((retries - 1))
    sleep 0.3
  done
  fail "chatServer did not start within 6 seconds"
}

# ── Open cost dashboard in browser ─────────────────────────────────────────────

open_dashboard() {
  local url="http://localhost:${RONIN_PORT:-8787}/dashboard"
  sleep 0.5   # brief pause so the browser gets a fully-booted server
  if command -v open &>/dev/null; then
    open "$url"
    ok "Cost dashboard → $url"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$url"
    ok "Cost dashboard → $url"
  else
    warn "Could not auto-open browser. Visit: $url"
  fi
}

# ── Start UI ───────────────────────────────────────────────────────────────────

start_ui() {
  log "Starting Vite dev server on :5173..."
  (
    cd "$SHELL_DIR"
    npm run dev -- --port 5173 --strictPort
  ) &
  UI_PID=$!

  # Wait for Vite to be ready
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if curl -sf "http://localhost:5173" &>/dev/null; then
      ok "Vite dev server running → http://localhost:5173"
      return 0
    fi
    retries=$((retries - 1))
    sleep 0.5
  done
  fail "Vite dev server did not start within 15 seconds"
}

# ── Run integration tests ─────────────────────────────────────────────────────

run_tests() {
  log "Running Phase 11F integration tests..."
  (cd "$ENGINE_DIR" && node --test api/integration.test.mjs)
  ok "All integration tests passed"
}

# ── Main ───────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}╔═══════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  RONIN Orchestration Engine       ║${RESET}"
echo -e "${BOLD}║  Phase 11G — Cost Engine + Dash   ║${RESET}"
echo -e "${BOLD}╚═══════════════════════════════════╝${RESET}"
echo ""

check_node
check_api_key

if [[ "$RUN_TESTS" == true ]]; then
  check_engine_deps
  run_tests
  exit 0
fi

if [[ "$UI_ONLY" == false ]]; then
  check_engine_deps
  start_engine
  open_dashboard &   # open in background so startup isn't blocked
fi

if [[ "$ENGINE_ONLY" == false ]]; then
  check_ui_deps
  start_ui
fi

echo ""
log "Stack is live:"
if [[ "$UI_ONLY" == false ]]; then
  dim "  chatServer  → http://localhost:${RONIN_PORT:-8787}"
  dim "  SSE stream  → http://localhost:${RONIN_PORT:-8787}/api/events"
  dim "  Cost dash   → http://localhost:${RONIN_PORT:-8787}/dashboard"
  dim "  Metrics API → http://localhost:${RONIN_PORT:-8787}/api/cost-metrics"
fi
if [[ "$ENGINE_ONLY" == false ]]; then
  dim "  Forge UI    → http://localhost:5173"
  dim "  (Swift Build tab loads this URL via WKWebView)"
fi
echo ""
dim "Press Ctrl+C to stop all processes"
echo ""

# Keep running until killed
wait
