#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="$(dirname "$0")/.env"
NETWORK="firecrawl-net"

# Source .env file before setting defaults so env vars take priority
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi

# Defaults (all overridable via .env or environment)
REDIS_HOST_PORT="${REDIS_HOST_PORT:-6379}"
PG_HOST_PORT="${PG_HOST_PORT:-5432}"
RABBITMQ_AMQP_HOST_PORT="${RABBITMQ_AMQP_HOST_PORT:-5672}"
RABBITMQ_MGMT_HOST_PORT="${RABBITMQ_MGMT_HOST_PORT:-15672}"
PLAYWRIGHT_HOST_PORT="${PLAYWRIGHT_HOST_PORT:-3000}"
API_HOST_PORT="${PORT:-3002}"
INTERNAL_PORT="${INTERNAL_PORT:-3002}"
PG_USER="${POSTGRES_USER:-firecrawl}"
PG_PASS="${POSTGRES_PASSWORD:-firecrawl_password}"
PG_DB="${POSTGRES_DB:-postgres}"

PODMAN_GLOBAL_ARGS=()
PODMAN_CGROUP_MANAGER="${PODMAN_CGROUP_MANAGER:-auto}"
if [ "$PODMAN_CGROUP_MANAGER" = "auto" ]; then
  if [ "$(podman info --format '{{.Host.Security.Rootless}} {{.Host.CgroupManager}}' 2>/dev/null || true)" = "true systemd" ]; then
    PODMAN_GLOBAL_ARGS+=(--cgroup-manager=cgroupfs)
  fi
elif [ -n "$PODMAN_CGROUP_MANAGER" ] && [ "$PODMAN_CGROUP_MANAGER" != "default" ]; then
  PODMAN_GLOBAL_ARGS+=(--cgroup-manager="$PODMAN_CGROUP_MANAGER")
fi

podman_cmd() {
  command podman "${PODMAN_GLOBAL_ARGS[@]}" "$@"
}

if [ "${#PODMAN_GLOBAL_ARGS[@]}" -gt 0 ]; then
  echo "Using Podman ${PODMAN_GLOBAL_ARGS[*]}"
fi

cleanup() {
  echo "Shutting down Firecrawl..."
  podman_cmd rm -f firecrawl-api firecrawl-playwright firecrawl-rabbitmq firecrawl-postgres firecrawl-redis firecrawl-obscura firecrawl-flaresolverr firecrawl-crawl4ai firecrawl-nodriver firecrawl-chaser firecrawl-stealth-bridge 2>/dev/null || true
  podman_cmd network rm "$NETWORK" 2>/dev/null || true
}
trap cleanup INT TERM

echo "=== Starting Firecrawl (self-hosted) ==="

# Create shared network
if ! podman_cmd network create "$NETWORK" 2>/dev/null; then
  if ! podman_cmd network exists "$NETWORK" 2>/dev/null; then
    echo "ERROR: Failed to create network '$NETWORK'" >&2
    exit 1
  fi
  echo "  (Network '$NETWORK' already exists)"
fi

# 1. Redis
echo "[1/5] Starting Redis..."
podman_cmd run -d --name firecrawl-redis --network="$NETWORK" \
  -p "127.0.0.1:${REDIS_HOST_PORT}:6379" \
  redis:alpine redis-server --bind 0.0.0.0

# 2. PostgreSQL (nuq)
echo "[2/5] Building PostgreSQL (nuq) from source..."
podman_cmd build -t firecrawl-nuq-postgres:local ./apps/nuq-postgres
echo "[2/5] Starting PostgreSQL (nuq)..."
podman_cmd run -d --name firecrawl-postgres --network="$NETWORK" \
  -p "127.0.0.1:${PG_HOST_PORT}:5432" \
  --tmpfs /var/lib/postgresql/data:noexec,nosuid \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASS" \
  -e POSTGRES_DB=postgres \
  firecrawl-nuq-postgres:local

# Wait for postgres to be ready
echo "  Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
  if podman_cmd exec firecrawl-postgres pg_isready -U "$PG_USER" -d postgres &>/dev/null; then
    echo "  PostgreSQL ready."
    break
  fi
  sleep 2
done

# 3. RabbitMQ
echo "[3/5] Starting RabbitMQ..."
podman_cmd run -d --name firecrawl-rabbitmq --network="$NETWORK" \
  -p "127.0.0.1:${RABBITMQ_AMQP_HOST_PORT}:5672" \
  -p "127.0.0.1:${RABBITMQ_MGMT_HOST_PORT}:15672" \
  -v firecrawl-rabbitmq-data:/var/lib/rabbitmq \
  -e RABBITMQ_ERLANG_COOKIE=firecrawl-cookie-secret \
  rabbitmq:3-management

# Wait for rabbitmq to be ready
echo "  Waiting for RabbitMQ to be ready..."
for i in {1..30}; do
  if podman_cmd exec firecrawl-rabbitmq rabbitmq-diagnostics -q check_running &>/dev/null; then
    echo "  RabbitMQ ready."
    break
  fi
  sleep 3
done

# 4. Playwright Service
echo "[4/5] Building Playwright service from source (first build ~2-3 min, cached on restart)..."
podman_cmd build -t firecrawl-playwright-service:local --build-arg PORT="${PLAYWRIGHT_HOST_PORT:-3000}" -f ./apps/playwright-service-ts/Dockerfile ./apps
echo "[4/5] Starting Playwright service..."
podman_cmd run -d --name firecrawl-playwright --network="$NETWORK" \
  -p "127.0.0.1:${PLAYWRIGHT_HOST_PORT}:3000" \
  --tmpfs /tmp/.cache:noexec,nosuid,size=1g \
  --cpus 2 --memory 4g --memory-swap 4g \
  -e PORT=3000 \
  -e PROXY_SERVER="${PROXY_SERVER:-}" \
  -e PROXY_USERNAME="${PROXY_USERNAME:-}" \
  -e PROXY_PASSWORD="${PROXY_PASSWORD:-}" \
  -e BLOCK_MEDIA="${BLOCK_MEDIA:-}" \
  -e MAX_CONCURRENT_PAGES="${CRAWL_CONCURRENT_REQUESTS:-10}" \
  -e OBSCURA_CDP_URL="${OBSCURA_CDP_URL:-}" \
  -e OBSCURA_CDP_SECRET="${OBSCURA_CDP_SECRET:-}" \
  -e RENDER_BACKEND_ORDER="${RENDER_BACKEND_ORDER:-chromium}" \
  firecrawl-playwright-service:local

# 4b. FlareSolverr (Cloudflare bypass proxy) — optional, enable with START_FLARESOLVERR=true
# WARNING: FlareSolverr adds ~2GB memory for its own headless Chrome instance.
# Only enable if you need Cloudflare bypass. Without it, total stack is <1GB.
if [ "${START_FLARESOLVERR:-false}" = "true" ]; then
  echo "[4b/6] Starting FlareSolverr..."
  podman_cmd run -d --name firecrawl-flaresolverr --network="$NETWORK" \
    --cpus 2 --memory 2g --memory-swap 2g \
    --security-opt no-new-privileges \
    -e LOG_LEVEL="${FLARESOLVERR_LOG_LEVEL:-info}" \
    ghcr.io/flaresolverr/flaresolverr@sha256:7962759d99d7e125e108e0f5e7f3cdbcd36161776d058d1d9b7153b92ef1af9e  # v3.4.6
fi

# 4c. Obscura (lightweight headless browser) — optional, enable with START_OBSCURA=true
if [ "${START_OBSCURA:-false}" = "true" ]; then
  if [ -z "${OBSCURA_CDP_SECRET:-}" ]; then
    echo "ERROR: START_OBSCURA=true but OBSCURA_CDP_SECRET is not set." >&2
    echo "  Generate one: openssl rand -hex 32" >&2
    exit 1
  fi
  echo "[4c/6] Building and starting Obscura..."
  podman_cmd build -t firecrawl-obscura:local ./obscura
  podman_cmd run -d --name firecrawl-obscura --network="$NETWORK" \
    --cpus 2 --memory 512m --memory-swap 512m \
    --security-opt no-new-privileges --read-only \
    --tmpfs /tmp:noexec,nosuid,size=128m \
    -e OBSCURA_CDP_SECRET="$OBSCURA_CDP_SECRET" \
    firecrawl-obscura:local \
    serve --port 9222 --host 0.0.0.0 --stealth --cdp-secret "$OBSCURA_CDP_SECRET"
  OBSCURA_CDP_URL="ws://firecrawl-obscura:9222"
  : "${RENDER_BACKEND_ORDER:=obscura,chromium}"
else
  OBSCURA_CDP_URL=""
fi

# 4d. Crawl4AI (server-side markdown post-processing) — optional, enable with START_CRAWL4AI=true
if [ "${START_CRAWL4AI:-false}" = "true" ]; then
  echo "[4d/6] Starting Crawl4AI..."
  podman_cmd run -d --name firecrawl-crawl4ai --network="$NETWORK" \
    --cpus 2 --memory 2g --memory-swap 2g \
    --security-opt no-new-privileges \
    -e CRAWL4AI_HOOKS_ENABLED=false \
    unclecode/crawl4ai@sha256:af229711cb673001cfdfdb148e1b1a0303d460efff890d0712cf2ca9da0838e8
  CRAWL4AI_SERVICE_URL="http://firecrawl-crawl4ai:11235"
else
  CRAWL4AI_SERVICE_URL=""
fi

# 4e. Nodriver Adapter (anti-bot Turnstile bypass) — optional, enable with START_NODRIVER=true
# WARNING: nodriver adapter adds ~2GB memory for its internal Chrome pool.
# Only enable if you need Cloudflare Turnstile / CAPTCHA bypass on aggressive sites.
if [ "${START_NODRIVER:-false}" = "true" ]; then
  echo "[4e/6] Building and starting Nodriver Adapter..."
  podman_cmd build -t firecrawl-nodriver:local ./apps/nodriver-adapter
  podman_cmd run -d --name firecrawl-nodriver --network="$NETWORK" \
    --cpus 2 --memory 2g --memory-swap 2g \
    --security-opt no-new-privileges \
    --tmpfs /tmp:noexec,nosuid,size=512m \
    -e PORT=3000 \
    -e BROWSER_POOL_SIZE="${NODRIVER_POOL_SIZE:-3}" \
    firecrawl-nodriver:local
  NODRIVER_ADAPTER_URL="http://firecrawl-nodriver:3000/scrape"
else
  NODRIVER_ADAPTER_URL=""
fi

# 4f. Chaser Service (hardened Chrome with fingerprint randomization) — optional, enable with START_CHASER=true
# WARNING: chaser-service adds ~2GB memory for its own Chromium instance.
# This is a protocol-level stealth service with 13,000+ V8 patches and per-session
# fingerprint randomization (Bezier mouse, human-like typing, GPU spoofing).
# Activation criteria: only enable when Phase 3 anti-bot fallbacks fail to bypass
# aggressive sites (Cloudflare WAF, DataDome, Akamai) after 30 days of production monitoring.
if [ "${START_CHASER:-false}" = "true" ]; then
  echo "[4f/6] Building and starting Chaser Service (hardened fingerprint-randomizing browser)..."
  podman_cmd build -t firecrawl-chaser-service:local -f apps/chaser-service/Dockerfile .
  podman_cmd run -d --name firecrawl-chaser --network="$NETWORK" \
    -p "127.0.0.1:${CHASER_HOST_PORT:-3100}:3000" \
    --cpus 2 --memory 2g --memory-swap 2g \
    --security-opt no-new-privileges \
    --tmpfs /tmp:noexec,nosuid,size=512m \
    -e PORT=3000 \
    -e MAX_CONCURRENT_PAGES="${CHASER_CONCURRENT_PAGES:-10}" \
    -e ALLOW_LOCAL_WEBHOOKS="${ALLOW_LOCAL_WEBHOOKS:-}" \
    -e DNS_CACHE_TTL_MS="${DNS_CACHE_TTL_MS:-30000}" \
    firecrawl-chaser-service:local
  CHASER_SERVICE_URL="http://firecrawl-chaser:3000/scrape"
else
  CHASER_SERVICE_URL=""
fi

# 4g. Stealth Bridge (MCP→HTTP bridge for stealth-browser-mcp) — optional, enable with START_STEALTH_BRIDGE=true
# Requires STEALTH_BROWSER_URL pointing to a running stealth-browser-mcp instance (--transport http).
if [ "${START_STEALTH_BRIDGE:-false}" = "true" ]; then
  echo "[4g/6] Building and starting Stealth Bridge..."
  podman_cmd build -t firecrawl-stealth-bridge:local -f apps/stealth-bridge/Dockerfile apps/stealth-bridge
  podman_cmd run -d --name firecrawl-stealth-bridge --network="$NETWORK" \
    --cpus 1 --memory 256m --memory-swap 256m \
    --security-opt no-new-privileges --read-only \
    --tmpfs /tmp:noexec,nosuid,size=64m \
    -e PORT=3001 \
    -e STEALTH_BROWSER_URL="${STEALTH_BROWSER_MCP_URL:-}" \
    firecrawl-stealth-bridge:local
  STEALTH_BROWSER_SERVICE_URL="http://firecrawl-stealth-bridge:3001/scrape"
else
  STEALTH_BROWSER_SERVICE_URL="${STEALTH_BROWSER_URL:-}"
fi

# Pre-flight validation: block startup if RENDER_BACKEND_ORDER includes obscura but START_OBSCURA is not set
if echo "${RENDER_BACKEND_ORDER:-}" | grep -q 'obscura'; then
  if [ "${START_OBSCURA:-false}" != "true" ]; then
    echo "ERROR: RENDER_BACKEND_ORDER='${RENDER_BACKEND_ORDER}' includes 'obscura' but START_OBSCURA is not true." >&2
    echo "  Set START_OBSCURA=true or remove 'obscura' from RENDER_BACKEND_ORDER." >&2
    exit 1
  fi
fi

# 5. Firecrawl API + Worker
echo "[5/5] Building Firecrawl API from source (first build ~3-5 min, cached on restart)..."
podman_cmd build -t firecrawl-api:local ./apps/api
echo "[5/5] Starting Firecrawl API with Workers..."

NUQ_DB_URL="${NUQ_DATABASE_URL:-postgresql://${PG_USER}:${PG_PASS}@firecrawl-postgres:5432/${PG_DB}}"
NUQ_DB_URL_LISTEN="${NUQ_DATABASE_URL_LISTEN:-postgresql://${PG_USER}:${PG_PASS}@firecrawl-postgres:5432/${PG_DB}}"

podman_cmd run -d --name firecrawl-api --network="$NETWORK" \
  --ulimit nofile=65535:65535 \
  --cpus 4 --memory 8g --memory-swap 8g \
  -p "${API_HOST_PORT}:${INTERNAL_PORT}" \
  -e HOST=0.0.0.0 \
  -e PORT="$INTERNAL_PORT" \
  -e EXTRACT_WORKER_PORT="${EXTRACT_WORKER_PORT:-3004}" \
  -e WORKER_PORT="${WORKER_PORT:-3005}" \
  -e ENV=local \
  -e REDIS_URL="${REDIS_URL:-redis://firecrawl-redis:6379}" \
  -e REDIS_RATE_LIMIT_URL="${REDIS_RATE_LIMIT_URL:-redis://firecrawl-redis:6379}" \
  -e PLAYWRIGHT_MICROSERVICE_URL="${PLAYWRIGHT_MICROSERVICE_URL:-http://firecrawl-playwright:3000/scrape}" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASS" \
  -e POSTGRES_DB="$PG_DB" \
  -e POSTGRES_HOST="${POSTGRES_HOST:-firecrawl-postgres}" \
  -e POSTGRES_PORT="${POSTGRES_PORT:-5432}" \
  -e NUQ_DATABASE_URL="$NUQ_DB_URL" \
  -e NUQ_DATABASE_URL_LISTEN="$NUQ_DB_URL_LISTEN" \
  -e NUQ_RABBITMQ_URL="${NUQ_RABBITMQ_URL:-amqp://firecrawl-rabbitmq:5672}" \
  -e USE_DB_AUTHENTICATION="${USE_DB_AUTHENTICATION:-false}" \
  -e NUM_WORKERS_PER_QUEUE="${NUM_WORKERS_PER_QUEUE:-8}" \
  -e CRAWL_CONCURRENT_REQUESTS="${CRAWL_CONCURRENT_REQUESTS:-10}" \
  -e MAX_CONCURRENT_JOBS="${MAX_CONCURRENT_JOBS:-5}" \
  -e BROWSER_POOL_SIZE="${BROWSER_POOL_SIZE:-5}" \
  -e BULL_AUTH_KEY="${BULL_AUTH_KEY:-CHANGEME}" \
  -e HARNESS_STARTUP_TIMEOUT_MS="${HARNESS_STARTUP_TIMEOUT_MS:-60000}" \
  -e OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  -e OPENAI_BASE_URL="${OPENAI_BASE_URL:-}" \
  -e MODEL_NAME="${MODEL_NAME:-}" \
  -e MODEL_EMBEDDING_NAME="${MODEL_EMBEDDING_NAME:-}" \
  -e OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-}" \
  -e PROXY_SERVER="${PROXY_SERVER:-}" \
  -e PROXY_USERNAME="${PROXY_USERNAME:-}" \
  -e PROXY_PASSWORD="${PROXY_PASSWORD:-}" \
  -e SEARXNG_ENDPOINT="${SEARXNG_ENDPOINT:-}" \
  -e TEST_API_KEY="${TEST_API_KEY:-}" \
  -e SUPABASE_ANON_TOKEN="${SUPABASE_ANON_TOKEN:-}" \
  -e SUPABASE_URL="${SUPABASE_URL:-}" \
  -e SUPABASE_SERVICE_TOKEN="${SUPABASE_SERVICE_TOKEN:-}" \
  -e SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}" \
  -e SELF_HOSTED_WEBHOOK_URL="${SELF_HOSTED_WEBHOOK_URL:-}" \
  -e LOGGING_LEVEL="${LOGGING_LEVEL:-}" \
  -e CRAWL4AI_URL="${CRAWL4AI_SERVICE_URL:-}" \
  -e NODRIVER_ADAPTER_URL="${NODRIVER_ADAPTER_URL:-}" \
  -e CHASER_SERVICE_URL="${CHASER_SERVICE_URL:-}" \
  -e STEALTH_BROWSER_URL="${STEALTH_BROWSER_SERVICE_URL:-}" \
  -e STEALTH_AUTH_TOKEN="${STEALTH_AUTH_TOKEN:-}" \
  firecrawl-api:local \
  node dist/src/harness.js --start-docker

echo ""
echo "=== Firecrawl is starting up ==="
echo "API will be available at: http://localhost:${API_HOST_PORT}"
echo "Admin UI: http://localhost:${API_HOST_PORT}/admin/${BULL_AUTH_KEY:-CHANGEME}/queues"
echo ""
echo "Checking API status..."
sleep 5
podman_cmd logs firecrawl-api 2>&1 | tail -10

echo ""
echo "Container status:"
podman_cmd ps --filter "name=firecrawl" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
