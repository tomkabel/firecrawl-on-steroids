# Multi-stage build for chaser-service
# Build context: repository root
# Build: docker build -f apps/chaser-service/Dockerfile -t firecrawl/chaser-service:local .

# --- Stage 1: Build ---
FROM rust:1.95-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config=0.29.2-1.1 \
    libssl-dev=3.0.15-1~deb12u1 \
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
    chromium=122.0.6261.57-1~deb12u1 \
    chromium-common=122.0.6261.57-1~deb12u1 \
    ca-certificates=20230311 \
    fonts-liberation=1:2.1.5-3 \
    libasound2=1.2.8-1+b1 \
    libatk-bridge2.0-0=2.46.0-5 \
    libatk1.0-0=2.46.0-5 \
    libcups2=2.4.2-3+deb12u5 \
    libdbus-1-3=1.14.10-1~deb12u1 \
    libdrm2=2.4.114-1+b1 \
    libgbm1=22.3.6-1+deb12u1 \
    libgtk-3-0=3.24.38-2~deb12u1 \
    libnspr4=2:4.35-1 \
    libnss3=2:3.87.1-1 \
    libu2f-udev=1.1.10-3 \
    libvulkan1=1.3.239.0-1 \
    libxcomposite1=1:0.4.5-1 \
    libxdamage1=1:1.1.6-1 \
    libxfixes3=1:6.0.0-2 \
    libxkbcommon0=1.5.0-1 \
    libxrandr2=2:1.5.2-2 \
    xdg-utils=1.1.3-4.1 \
    curl=7.88.1-10+deb12u8 \
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
