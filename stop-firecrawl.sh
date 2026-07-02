#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="$(dirname "$0")/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi

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

echo "Stopping Firecrawl..."
podman_cmd rm -f firecrawl-api firecrawl-playwright firecrawl-rabbitmq firecrawl-postgres firecrawl-redis firecrawl-obscura firecrawl-flaresolverr firecrawl-crawl4ai firecrawl-nodriver firecrawl-chaser firecrawl-stealth-bridge 2>/dev/null || true
echo "Firecrawl stopped."
