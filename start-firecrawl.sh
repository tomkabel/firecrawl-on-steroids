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

cleanup() {
  echo "Shutting down Firecrawl..."
  podman rm -f firecrawl-api firecrawl-playwright firecrawl-rabbitmq firecrawl-postgres firecrawl-redis 2>/dev/null || true
  podman network rm "$NETWORK" 2>/dev/null || true
}
trap cleanup INT TERM

echo "=== Starting Firecrawl (self-hosted) ==="

# Create shared network
if ! podman network create "$NETWORK" 2>/dev/null; then
  if ! podman network exists "$NETWORK" 2>/dev/null; then
    echo "ERROR: Failed to create network '$NETWORK'" >&2
    exit 1
  fi
  echo "  (Network '$NETWORK' already exists)"
fi

# 1. Redis
echo "[1/5] Starting Redis..."
podman run -d --name firecrawl-redis --network="$NETWORK" \
  -p "127.0.0.1:${REDIS_HOST_PORT}:6379" \
  redis:alpine redis-server --bind 0.0.0.0

# 2. PostgreSQL (nuq)
echo "[2/5] Starting PostgreSQL (nuq)..."
podman run -d --name firecrawl-postgres --network="$NETWORK" \
  -p "127.0.0.1:${PG_HOST_PORT}:5432" \
  --tmpfs /var/lib/postgresql/data:noexec,nosuid \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASS" \
  -e POSTGRES_DB=postgres \
  ghcr.io/firecrawl/nuq-postgres:latest

# Wait for postgres to be ready
echo "  Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
  if podman exec firecrawl-postgres pg_isready -U "$PG_USER" -d postgres &>/dev/null; then
    echo "  PostgreSQL ready."
    break
  fi
  sleep 2
done

# 3. RabbitMQ
echo "[3/5] Starting RabbitMQ..."
podman run -d --name firecrawl-rabbitmq --network="$NETWORK" \
  -p "127.0.0.1:${RABBITMQ_AMQP_HOST_PORT}:5672" \
  -p "127.0.0.1:${RABBITMQ_MGMT_HOST_PORT}:15672" \
  -v firecrawl-rabbitmq-data:/var/lib/rabbitmq \
  -e RABBITMQ_ERLANG_COOKIE=firecrawl-cookie-secret \
  rabbitmq:3-management

# Wait for rabbitmq to be ready
echo "  Waiting for RabbitMQ to be ready..."
for i in {1..30}; do
  if podman exec firecrawl-rabbitmq rabbitmq-diagnostics -q check_running &>/dev/null; then
    echo "  RabbitMQ ready."
    break
  fi
  sleep 3
done

# 4. Playwright Service
echo "[4/5] Starting Playwright service..."
podman run -d --name firecrawl-playwright --network="$NETWORK" \
  -p "127.0.0.1:${PLAYWRIGHT_HOST_PORT}:3000" \
  --tmpfs /tmp/.cache:noexec,nosuid,size=1g \
  --cpus 2 --memory 4g --memory-swap 4g \
  -e PORT=3000 \
  -e PROXY_SERVER="${PROXY_SERVER:-}" \
  -e PROXY_USERNAME="${PROXY_USERNAME:-}" \
  -e PROXY_PASSWORD="${PROXY_PASSWORD:-}" \
  -e BLOCK_MEDIA="${BLOCK_MEDIA:-}" \
  -e MAX_CONCURRENT_PAGES="${CRAWL_CONCURRENT_REQUESTS:-10}" \
  ghcr.io/firecrawl/playwright-service:latest

# 5. Firecrawl API + Worker
echo "[5/5] Starting Firecrawl API..."

NUQ_DB_URL="${NUQ_DATABASE_URL:-postgresql://${PG_USER}:${PG_PASS}@firecrawl-postgres:5432/${PG_DB}}"
NUQ_DB_URL_LISTEN="${NUQ_DATABASE_URL_LISTEN:-postgresql://${PG_USER}:${PG_PASS}@firecrawl-postgres:5432/${PG_DB}}"

podman run -d --name firecrawl-api --network="$NETWORK" \
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
  ghcr.io/firecrawl/firecrawl:latest \
  node dist/src/harness.js --start-docker

echo ""
echo "=== Firecrawl is starting up ==="
echo "API will be available at: http://localhost:${API_HOST_PORT}"
echo "Admin UI: http://localhost:${API_HOST_PORT}/admin/${BULL_AUTH_KEY:-CHANGEME}/queues"
echo ""
echo "Checking API status..."
sleep 5
podman logs firecrawl-api 2>&1 | tail -10

echo ""
echo "Container status:"
podman ps --filter "name=firecrawl" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
