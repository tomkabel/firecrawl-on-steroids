#!/usr/bin/env bash
set -euo pipefail
echo "Stopping Firecrawl..."
podman rm -f firecrawl-api firecrawl-playwright firecrawl-rabbitmq firecrawl-postgres firecrawl-redis 2>/dev/null || true
echo "Firecrawl stopped."
