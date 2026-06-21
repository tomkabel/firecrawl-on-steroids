# Multi-stage build for chaser-service
# Build context: repository root
# Build: docker build -f apps/chaser-service/Dockerfile -t firecrawl/chaser-service:local .

# --- Stage 1: Build ---
FROM rust:1.95-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy the entire chaser-oxide workspace (path dependency)
COPY chaser-oxide/ chaser-oxide/

# Copy the chaser-service source
COPY apps/chaser-service/ apps/chaser-service/

WORKDIR /build/apps/chaser-service

RUN cargo build --release

# --- Stage 2: Runtime ---
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-common \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libu2f-udev \
    libvulkan1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r -g 10001 app && useradd -r -u 10001 -g app -m -d /app app

WORKDIR /app

COPY --from=builder /build/apps/chaser-service/target/release/chaser-service /app/chaser-service

RUN chown -R app:app /app \
    && chmod 755 /app/chaser-service \
    && mkdir -p /tmp/.chrome \
    && chown app:app /tmp/.chrome

USER app

ENV PORT=3000
ENV MAX_CONCURRENT_PAGES=10
ENV CHROME_EXECUTABLE=/usr/bin/chromium

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=30s \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["/app/chaser-service"]
