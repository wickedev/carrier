#!/usr/bin/env bash
# Local all-in-one dev stack for Carrier: the Go runtime, the BFF, and the web app.
# Ports are "3"-prefixed to dodge common defaults, and any process already holding
# one is killed before (re)starting. Ctrl-C tears the whole stack down.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Ports (override via env) ─────────────────────────────────────────────────
WEB_PORT="${WEB_PORT:-35173}"      # vite dev server (default 5173 → 35173)
BFF_PORT="${BFF_PORT:-38787}"      # Hono BFF        (default 8787  → 38787)
CARRIER_PORT="${CARRIER_PORT:-39099}" # Carrier runtime (BFF default 9099 → 39099)
CARRIER_TOKEN="${CARRIER_TOKEN:-dev-carrier-token}"

# Seeded dev login (email/password) so you can sign in immediately.
DEV_USER_EMAIL="${DEV_USER_EMAIL:-dev@carrier.local}"
DEV_USER_PASSWORD="${DEV_USER_PASSWORD:-carrierdev}"

# Persistent dev state (PGlite data, workspaces, plugin artifacts). PGlite is
# embedded — there is NO separate database port.
DEV_DIR="$ROOT/.carrier-dev"
PG_DATA="$DEV_DIR/pgdata"
WORKSPACE_ROOT="$DEV_DIR/workspace"
PLUGINS_DIR="$DEV_DIR/plugins" # shared: BFF writes artifacts, Carrier reads them
mkdir -p "$PG_DATA" "$WORKSPACE_ROOT" "$PLUGINS_DIR" "$DEV_DIR/bin"

# Optional: source a root .env (e.g. real GitHub App creds) if present.
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "▸ freeing port ${port} (killing: ${pids})"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
}

echo "▸ freeing ports ${WEB_PORT} ${BFF_PORT} ${CARRIER_PORT}"
kill_port "$WEB_PORT"
kill_port "$BFF_PORT"
kill_port "$CARRIER_PORT"

PIDS=()
cleanup() {
  echo
  echo "▸ shutting down dev stack"
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
  done
  # Belt and suspenders: free the ports too (kills any orphaned children).
  kill_port "$WEB_PORT"; kill_port "$BFF_PORT"; kill_port "$CARRIER_PORT"
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# ── Carrier runtime (Go) ─────────────────────────────────────────────────────
# Build to a binary first so we own a single killable PID (go run leaves a child).
echo "▸ building carrier runtime"
go build -o "$DEV_DIR/bin/carrier" ./cmd/carrier
echo "▸ carrier  → http://localhost:${CARRIER_PORT}"
# LLM auth: with no ANTHROPIC_API_KEY the runtime auto-selects the Codex BYOS
# engine (the local ChatGPT subscription token from `codex login`) — LOCAL DEV
# ONLY. Force it with CARRIER_AUTH=codex, or use the API key with
# CARRIER_AUTH=anthropic + ANTHROPIC_API_KEY.
CARRIER_ADDR=":${CARRIER_PORT}" \
CARRIER_TOKEN="$CARRIER_TOKEN" \
CARRIER_PLUGIN_CACHE="$PLUGINS_DIR" \
CARRIER_AUTH="${CARRIER_AUTH:-}" \
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  "$DEV_DIR/bin/carrier" serve &
PIDS+=("$!")

# ── BFF (Hono + PGlite) ──────────────────────────────────────────────────────
echo "▸ bff      → http://localhost:${BFF_PORT}"
( cd "$ROOT/web" && \
  PORT="$BFF_PORT" \
  DATABASE_URL="$PG_DATA" \
  CARRIER_BASE_URL="http://localhost:${CARRIER_PORT}" \
  CARRIER_TOKEN="$CARRIER_TOKEN" \
  WORKSPACE_ROOT="$WORKSPACE_ROOT" \
  PLUGIN_ARTIFACTS_ROOT="$PLUGINS_DIR" \
  DEV_USER_EMAIL="$DEV_USER_EMAIL" \
  DEV_USER_PASSWORD="$DEV_USER_PASSWORD" \
  pnpm --filter @carrier/bff dev ) &
PIDS+=("$!")

# ── Web (Vite) ───────────────────────────────────────────────────────────────
echo "▸ web      → http://localhost:${WEB_PORT}  (proxies /bff → ${BFF_PORT})"
( cd "$ROOT/web" && \
  WEB_PORT="$WEB_PORT" \
  BFF_PROXY_TARGET="http://localhost:${BFF_PORT}" \
  VITE_DEV_EMAIL="$DEV_USER_EMAIL" \
  VITE_DEV_PASSWORD="$DEV_USER_PASSWORD" \
  pnpm --filter @carrier/web dev ) &
PIDS+=("$!")

echo
echo "▸ stack up. open  →  http://localhost:${WEB_PORT}   (Ctrl-C to stop everything)"
echo "▸ dev login       →  ${DEV_USER_EMAIL} / ${DEV_USER_PASSWORD}"
wait
