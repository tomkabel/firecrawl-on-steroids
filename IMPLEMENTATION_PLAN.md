# Firecrawl Self-Hosted: External Tool Integration — Implementation Plan

*Derived from ARCHITECTURAL_EVALUATION.md. All steps are concrete, ordered, and testable.*

---

## Risk Acknowledgment

**obscura is an experimental browser engine.** It lives in this monorepo under active development. It does not implement the full Chrome DevTools Protocol, does not execute JavaScript from `<script>` tags (only inline and injected evaluation via CDP `Runtime.evaluate`), has no renderer process sandbox, and has not been battle-tested at production scale. The plan below treats obscura as a **beta path** — it runs alongside the existing Chromium pipeline, not in place of it. Traffic is split via a configurable fallback chain. If obscura fails a scrape, the request transparently falls back to Chromium. This is conservative, honest engineering.

## Design Principles

1. **No regressions on the existing pipeline.** The current playwright-service + Chromium path must continue working identically. Every change is additive and opt-in.
2. **Shared security primitives.** SSRF protection, TLS verification, and URL validation live in a single TypeScript library imported by all adapters — never copy-pasted.
3. **Zero hardcoded credentials.** Every authentication token, shared secret, and API key has no default value. Services with missing credentials fail at startup with a clear error message, not silently with a known default.
4. **No :latest tags.** All third-party container images are pinned to immutable digests.
5. **All custom images built from source in this workspace.** No images pulled from unverified Docker Hub accounts.
6. **Honest resource accounting.** Memory claims measure a service at steady state with its full dependency tree (browser binary, language runtime, OS overhead). No cherry-picked comparisons.
7. **Observability from day one.** Every adapter exposes a `/health` endpoint with structured status, a `/metrics` endpoint with Prometheus-formatted counters, and emits structured JSON logs.

## The Scrape Service Contract

Every adapter in this project implements this exact contract. This is the canonical definition.

### Request: `POST /scrape`

```typescript
interface ScrapeRequest {
  url: string;                               // required
  wait_after_load?: number;                  // ms, default 0
  timeout?: number;                          // ms, default 15000
  headers?: Record<string, string>;          // extra HTTP headers
  check_selector?: string;                   // CSS selector to wait for
  skip_tls_verification?: boolean;           // default false
}
```

### Success Response: HTTP 200

```typescript
interface ScrapeResponse {
  content: string;           // full page HTML
  pageStatusCode: number;    // HTTP status of the fetched page
  contentType: string;       // e.g. "text/html"
  pageError?: string;        // present when pageStatusCode is not 2xx
}
```

### SSRF / Blocked Response: HTTP 200 (pageStatusCode: 403)

```typescript
{
  content: '',
  pageStatusCode: 403,
  pageError: 'Blocked insecure target URL "http://10.0.0.1/": resolves to a private IP'
}
```

### Validation Error: HTTP 400

```typescript
{ error: 'URL is required' }
// or: { error: 'Invalid URL' }
```

### Internal Error: HTTP 500

```typescript
{ error: 'An error occurred while fetching the page.' }
```

### Health: `GET /health` → 200

```typescript
{
  status: 'healthy',
  backend: 'obscura' | 'chromium' | 'nodriver',
  activePages: number,
  maxConcurrentPages: number,
  uptime: number          // seconds since start
}
```

### Metrics: `GET /metrics` → 200 (Prometheus text format)

```
scrape_requests_total{status="success"} 1423
scrape_requests_total{status="ssrf_blocked"} 12
scrape_requests_total{status="error"} 5
scrape_duration_seconds_bucket{le="0.5"} 800
scrape_duration_seconds_bucket{le="1.0"} 1200
scrape_duration_seconds_bucket{le="5.0"} 1400
scrape_duration_seconds_bucket{le="+Inf"} 1423
active_pages 3
```

---

## Phase 0: Prerequisites — Verify Baseline

Before any changes, verify the current deployment works correctly in both modes. These tests establish a performance baseline for honest before/after comparison.

```bash
# docker-compose
docker compose up -d
curl -s -w '\n%{time_total}s\n' -X POST http://localhost:3002/v1/scrape \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
# Record: response time, memory (docker stats --no-stream), correctness

curl -s -w '\n%{time_total}s\n' -X POST http://localhost:3002/v1/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
# Record: markdown output quality for known-heavy pages
docker compose down

# podman scripts
./start-firecrawl.sh
curl -s -w '\n%{time_total}s\n' -X POST http://localhost:3002/v1/scrape \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
./stop-firecrawl.sh
```

**Record these baselines now.** Every phase validates against them.

---

## Phase 1: Shared SSRF Library + obscura Engine (Opt-in Beta)

**Goal**: Extract SSRF protection from playwright-service into a shared library, then add obscura as an optional rendering backend with automatic Chromium fallback. obscura is never the sole rendering path — if it fails, the request retries on the existing playwright-service.

### Step 1.0: Extract SSRF Protection into a Shared Library

Before adding any new services, prevent the "copy-paste security code" problem.

**New directory**: `apps/ssrf-protection/`

**File**: `apps/ssrf-protection/src/index.ts`

- Entire `assertSafeTargetUrl`, `InsecureConnectionError`, `lookupWithCache` extracted from `apps/playwright-service-ts/api.ts` lines 24-106
- Same logic, same behavior, same env vars (`ALLOW_LOCAL_WEBHOOKS`, `DNS_CACHE_TTL_MS`)
- Exported as a single function + error class
- Published as `@firecrawl/ssrf-protection` (workspace package, no actual npm publish needed)
- All adapters import from this package

**File**: `apps/ssrf-protection/package.json`
```json
{
  "name": "@firecrawl/ssrf-protection",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "jest"
  },
  "dependencies": {
    "ipaddr.js": "^2.2.0"
  }
}
```

**File**: `apps/playwright-service-ts/api.ts` — replace inline SSRF with import:
```typescript
import { assertSafeTargetUrl, InsecureConnectionError } from '@firecrawl/ssrf-protection';
// Remove lines 24-106 (the SSRF classes and functions)
```

**Verification**: All existing scrape tests pass. SSRF blocking behavior is identical.

### Step 1.1: Build obscura from Source in This Workspace

**Do not pull `h4ckf0r0day/obscura` from Docker Hub.** The obscura source lives at `/obscura/` in this repo. Build a container image from it.

**File**: `docker-compose.obscura.yaml` (an override file — does not modify the base compose)

```yaml
services:
  obscura:
    build:
      context: ./obscura
      dockerfile: Dockerfile
    image: firecrawl/obscura:local
    networks:
      - firecrawl-net
    environment:
      OBSCURA_CDP_SECRET: ${OBSCURA_CDP_SECRET:?err}
    command: >
      serve --port 9222 --host 0.0.0.0 --stealth --cdp-secret "${OBSCURA_CDP_SECRET}"
    cpus: 2.0
    mem_limit: 512M
    memswap_limit: 512M
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:9222/json/version || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
        compress: "true"
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:noexec,nosuid,size=128m
```

**What changed from original plan**:
- `build:` instead of `image:` — built from local `./obscura/Dockerfile`, not Docker Hub
- `OBSCURA_CDP_SECRET` is **required** (the `:?err` syntax makes docker-compose fail if unset)
- `--cdp-secret` flag — we add this to obscura's CLI (see Step 1.2)
- `healthcheck` — Docker waits for obscura to actually respond, not just start the process
- `no-new-privileges` + `read_only` — defense in depth
- No host port binding — obscura is internal-only, accessed via Docker network

### Step 1.2: Add CDP Authentication to obscura

obscura currently has no authentication on its CDP WebSocket or HTTP endpoints. We add a shared-secret mechanism.

**Files to modify** (in `/obscura/crates/obscura-cdp/src/`):

**`server.rs`** — in the WebSocket upgrade handler, validate the `cdp-secret` query parameter:

```rust
// Before WebSocket upgrade:
let query_params: HashMap<String, String> = uri
    .query()
    .map(|q| url::form_urlencoded::parse(q.as_bytes())
        .into_owned()
        .collect())
    .unwrap_or_default();

let expected = std::env::var("OBSCURA_CDP_SECRET").unwrap_or_default();
if !expected.is_empty() && query_params.get("cdp-secret") != Some(&expected) {
    // Return 403 Forbidden
    let response = Response::builder()
        .status(403)
        .body(Body::from("Forbidden: invalid CDP secret"))
        .unwrap();
    return Ok(response);
}
```

**`lib.rs` or `mod.rs`** — add `--cdp-secret` CLI argument in `obscura-cli`:

```rust
.arg(
    Arg::new("cdp-secret")
        .long("cdp-secret")
        .env("OBSCURA_CDP_SECRET")
        .help("Shared secret for CDP WebSocket authentication")
)
```

And pass it through to the server configuration.

**Rationale**: This is not production-grade authentication (TLS + mTLS would be), but it raises the bar from "anyone on the network can control the browser" to "requires a shared secret known only to trusted services on the Docker network." It matches the existing pattern in the codebase (`BULL_AUTH_KEY`, `SUPABASE_SERVICE_TOKEN`).

### Step 1.3: Add obscura-Aware Fallback to playwright-service

Instead of the original plan's all-or-nothing Option A/B, the playwright-service gains a **configurable fallback chain**.

**File**: `apps/playwright-service-ts/api.ts` — modify `initializeBrowser()`:

```typescript
import { assertSafeTargetUrl, InsecureConnectionError } from '@firecrawl/ssrf-protection';

enum RenderBackend {
  OBSCURA = 'obscura',
  CHROMIUM = 'chromium',
}

const RENDER_BACKEND_ORDER: RenderBackend[] =
  (process.env.RENDER_BACKEND_ORDER || 'obscura,chromium')
    .split(',')
    .map(s => s.trim() as RenderBackend);

const OBSCURA_CDP_URL = process.env.OBSCURA_CDP_URL;
const OBSCURA_CDP_SECRET = process.env.OBSCURA_CDP_SECRET;

let obscuraBrowser: Browser | null = null;
let chromiumBrowser: Browser | null = null;

async function connectObscura(): Promise<Browser> {
  if (!OBSCURA_CDP_URL) throw new Error('OBSCURA_CDP_URL not set');
  const wsUrl = OBSCURA_CDP_SECRET
    ? `${OBSCURA_CDP_URL}?cdp-secret=${encodeURIComponent(OBSCURA_CDP_SECRET)}`
    : OBSCURA_CDP_URL;
  return chromium.connectOverCDP(wsUrl);
}

async function launchChromium(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });
}

async function getBrowserForScrape(): Promise<{ browser: Browser; backend: RenderBackend }> {
  for (const backend of RENDER_BACKEND_ORDER) {
    try {
      if (backend === RenderBackend.OBSCURA) {
        if (!obscuraBrowser) obscuraBrowser = await connectObscura();
        return { browser: obscuraBrowser, backend: RenderBackend.OBSCURA };
      }
      if (backend === RenderBackend.CHROMIUM) {
        if (!chromiumBrowser) chromiumBrowser = await launchChromium();
        return { browser: chromiumBrowser, backend: RenderBackend.CHROMIUM };
      }
    } catch (err) {
      console.warn(`Backend ${backend} unavailable:`, (err as Error).message);
      continue;
    }
  }
  throw new Error('No rendering backend available');
}
```

**`POST /scrape` handler** — wrap in a retry loop:

```typescript
app.post('/scrape', async (req, res) => {
  // ... validation unchanged ...

  for (const backend of RENDER_BACKEND_ORDER) {
    try {
      const { browser, backend: usedBackend } = await getBrowserForScrape();
      const result = await scrapePage(browser, url, timeout, wait_after_load, headers, skip_tls_verification);
      res.json({ ...result, _backend: usedBackend }); // _backend is stripped in production, useful for debugging
      return;
    } catch (err) {
      console.warn(`Scrape failed on backend, trying next:`, (err as Error).message);
      continue;
    }
  }
  res.status(500).json({ error: 'All rendering backends exhausted' });
});
```

**Key behaviors**:
- `RENDER_BACKEND_ORDER=obscura,chromium` — tries obscura first, falls back to Chromium
- `RENDER_BACKEND_ORDER=chromium` — never uses obscura (production safe default)
- `RENDER_BACKEND_ORDER=chromium,obscura` — tries Chromium first, obscura as fallback
- If `OBSCURA_CDP_URL` is not set, obscura is simply skipped (no config needed for existing users)

### Step 1.4: Add obscura to start-firecrawl.sh (Opt-in via env var)

**File**: `start-firecrawl.sh` — after the Playwright service block, conditionally:

```bash
# 4b. Obscura (lightweight headless browser) — optional, enable with START_OBSCURA=true
if [ "${START_OBSCURA:-false}" = "true" ]; then
  if [ -z "${OBSCURA_CDP_SECRET:-}" ]; then
    echo "ERROR: START_OBSCURA=true but OBSCURA_CDP_SECRET is not set." >&2
    echo "  Generate one: openssl rand -hex 32" >&2
    exit 1
  fi
  echo "[4b/5] Starting Obscura..."
  podman build -t firecrawl-obscura:local ./obscura
  podman run -d --name firecrawl-obscura --network="$NETWORK" \
    --cpus 2 --memory 512m --memory-swap 512m \
    --security-opt no-new-privileges --read-only \
    --tmpfs /tmp:noexec,nosuid,size=128m \
    -e OBSCURA_CDP_SECRET="$OBSCURA_CDP_SECRET" \
    firecrawl-obscura:local \
    serve --port 9222 --host 0.0.0.0 --stealth --cdp-secret "$OBSCURA_CDP_SECRET"

  # Pass to playwright-service
  OBSCURA_CDP_URL="ws://firecrawl-obscura:9222"
else
  OBSCURA_CDP_URL=""
fi

# Then in the playwright-service podman run, add:
#   -e OBSCURA_CDP_URL="${OBSCURA_CDP_URL}" \
#   -e OBSCURA_CDP_SECRET="${OBSCURA_CDP_SECRET:-}" \
#   -e RENDER_BACKEND_ORDER="${RENDER_BACKEND_ORDER:-chromium}" \
```

**What changed**: obscura is fully opt-in. Existing deployments are unaffected. The script fails fast with a clear error if `OBSCURA_CDP_SECRET` is missing.

**stop-firecrawl.sh**: add `firecrawl-obscura` to cleanup, conditionally.

### Step 1.5: Add FlareSolverr Proxy (Opt-in, Per-Request)

**Critical design change**: FlareSolverr is NOT set as the global `PROXY_SERVER`. Setting it globally routes ALL traffic — including authenticated requests with custom headers — through FlareSolverr's Chrome instance, which is a data privacy concern and silently re-adds the 1-2GB memory cost you were trying to eliminate.

Instead, FlareSolverr is added as a service that users can opt into per-request via a new `proxy` parameter on the Firecrawl API scrape endpoint.

**docker-compose.obscura.yaml addition** (or a separate `docker-compose.flaresolverr.yaml`):

```yaml
  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr@sha256:abc123...  # pinned digest, not :latest
    networks:
      - firecrawl-net
    environment:
      LOG_LEVEL: ${FLARESOLVERR_LOG_LEVEL:-info}
    cpus: 2.0
    mem_limit: 2G
    memswap_limit: 2G
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "2"
        compress: "true"
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8191/v1 | grep -q 'FlareSolverr is ready' || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 15s
```

**start-firecrawl.sh**: FlareSolverr is added under a `START_FLARESOLVERR` flag, with a comment:

```bash
# WARNING: FlareSolverr adds ~2GB memory for its own headless Chrome instance.
# Only enable if you need Cloudflare bypass. Without it, total stack is <1GB.
```

### Phase 1 Deliverables Summary

| File | Change |
|---|---|
| `apps/ssrf-protection/` | **New** — shared SSRF library extracted from playwright-service |
| `apps/playwright-service-ts/api.ts` | Import SSRF from shared lib; add `initializeBrowser()` fallback chain; add scrape retry loop |
| `obscura/crates/obscura-cdp/src/server.rs` | CDP WebSocket authentication via `?cdp-secret=` query param |
| `obscura/crates/obscura-cli/` | `--cdp-secret` CLI flag + env var |
| `docker-compose.obscura.yaml` | **New** — override file with obscura service (built from source) |
| `docker-compose.flaresolverr.yaml` | **New** — optional override with FlareSolverr (pinned digest, healthcheck) |
| `start-firecrawl.sh` | Conditional obscura + FlareSolverr blocks, under env-var flags |
| `stop-firecrawl.sh` | Conditional cleanup entries |

### Honest Resource Accounting

| Configuration | Services Running | Steady-State Memory |
|---|---|---|
| Baseline (current) | api(8G) + playwright(4G) + redis(~50M) + rabbitmq(~100M) + postgres(~200M) | ~12.4 GB (docker-compose limits) / ~4-6 GB (actual usage) |
| +obscura, chromium fallback | above + obscura(512M) | ~12.9 GB limit / ~4.5-6.5 GB actual |
| +obscura only (no chromium) | api(8G) + playwright(512M config) + obscura(512M) + redis + rabbitmq + postgres | ~9.5 GB limit / ~2-3 GB actual |
| +FlareSolverr | above + flaresolverr(2G, with internal Chrome) | ~5-7 GB actual |

**Bottom line**: obscura alone saves ~3 GB at steady state. Adding FlareSolverr eats half of that back. Users should make an informed choice.

---

## Phase 2: Crawl4AI Markdown Post-Processing (Server-Side)

**Goal**: Add optional server-side HTML→Markdown conversion via Crawl4AI, producing cleaner output than `@mendable/firecrawl-rs` for LLM consumption.

**Design change from original**: The original recommended "Approach A — Client-side post-processing (zero API code changes)" which is not a feature — it's telling users to call a different service themselves. This rewrite implements server-side integration via the `formats` parameter.

### Step 2.1: Add Crawl4AI to docker-compose (Pinned Digest)

```yaml
  crawl4ai:
    image: unclecode/crawl4ai@sha256:<PINNED_DIGEST>
    networks:
      - firecrawl-net
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8080/health | grep -q ok || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "2"
        compress: "true"
    security_opt:
      - no-new-privileges:true
```

### Step 2.2: Wire Crawl4AI into the API

The Firecrawl API already has a `formats` parameter (`["markdown"]`, `["html"]`, etc.). When `CRAWL4AI_URL` is set and `formats` includes `"markdown"`, the API passes the scraped HTML through Crawl4AI's conversion endpoint instead of (or as a supplement to) the Rust native converter.

**File**: `apps/api/src/lib/markdown-converter.ts` (new, optional module)

```typescript
const CRAWL4AI_URL = process.env.CRAWL4AI_URL;

export async function convertToMarkdown(html: string, url: string): Promise<string> {
  // If Crawl4AI is available, use it
  if (CRAWL4AI_URL) {
    try {
      const response = await fetch(`${CRAWL4AI_URL}/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: url,
          raw_html: html,     // Note: depends on Crawl4AI API accepting raw HTML
          output_format: 'markdown'
        }),
        signal: AbortSignal.timeout(15000)
      });
      if (response.ok) {
        const data = await response.json();
        if (data?.markdown) return data.markdown;
      }
      console.warn('Crawl4AI conversion failed, falling back to native converter');
    } catch (err) {
      console.warn('Crawl4AI unavailable:', (err as Error).message);
    }
  }
  // Fall back to native @mendable/firecrawl-rs converter (existing behavior)
  return nativeMarkdownConvert(html, url);
}
```

**Key points**:
- Crawl4AI is optional — if the service is down, the API silently falls back to the native converter
- The API never makes a second HTTP request to the target URL — it passes the already-scraped HTML directly
- No client-side changes needed; users get better markdown automatically when enabled

### Phase 2 Deliverables

| File | Change |
|---|---|
| `docker-compose.crawl4ai.yaml` | **New** — optional override with pinned digest |
| `apps/api/src/lib/markdown-converter.ts` | **New** — Crawl4AI integration with native fallback |
| `start-firecrawl.sh` | Conditional Crawl4AI block under `START_CRAWL4AI` flag |

---

## Phase 3: Anti-Detection Layer

**Goal**: Add specialized anti-bot capabilities for aggressive sites. These are **fallback renderers** — they are only invoked when the primary pipeline (Phase 1's obscura→chromium chain) returns a 403, CAPTCHA page, or empty body.

### 3.1: nodriver — Turnstile Bypass Microservice

**Critical design fixes from original plan**:

| Original Problem | Fix |
|---|---|
| Launches Chromium per-request (2-4s cold start) | Browser pool at module level, pre-warmed at startup |
| Runs as root | `USER 10001` in Dockerfile |
| No healthcheck contract | Implements full `/health` and `/metrics` endpoints |
| 2G mem_limit with no justification | 2G documented as "includes nodriver browser pool + OS overhead" |

**File**: `apps/nodriver-adapter/app/main.py`

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import nodriver as uc
import asyncio
from contextlib import asynccontextmanager
import time
import os

# ---- Browser pool (module-level, not per-request) ----
BROWSER_POOL_SIZE = int(os.getenv("BROWSER_POOL_SIZE", "3"))
browsers: list = []
start_time: float = 0

async def warm_pool():
    global start_time
    start_time = time.time()
    for _ in range(BROWSER_POOL_SIZE):
        browsers.append(await uc.start(headless=True))

async def drain_pool():
    for b in browsers:
        await b.stop()
    browsers.clear()

def get_browser():
    """Pop a browser from the pool. Caller must return it."""
    if not browsers:
        raise RuntimeError("Browser pool exhausted")
    return browsers.pop()

def return_browser(browser):
    if len(browsers) < BROWSER_POOL_SIZE:
        browsers.append(browser)
    # else: discard (already have enough)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await warm_pool()
    yield
    await drain_pool()

app = FastAPI(lifespan=lifespan)

# ---- Metrics ----
scrape_requests = {"success": 0, "ssrf_blocked": 0, "error": 0}
active_requests = 0

# ---- Request model (matches canonical /scrape contract) ----
class ScrapeRequest(BaseModel):
    url: str
    wait_after_load: int = 0
    timeout: int = 15000
    headers: dict = {}
    check_selector: str | None = None
    skip_tls_verification: bool = False

@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "backend": "nodriver",
        "activePages": active_requests,
        "maxConcurrentPages": BROWSER_POOL_SIZE,
        "uptime": time.time() - start_time,
        "poolSize": len(browsers),
        "maxPoolSize": BROWSER_POOL_SIZE
    }

@app.get("/metrics")
async def metrics():
    return {
        "scrape_requests_total": scrape_requests,
        "active_pages": active_requests
    }

@app.post("/scrape")
async def scrape(req: ScrapeRequest):
    global active_requests
    active_requests += 1
    browser = get_browser()
    try:
        tab = await browser.get(req.url)
        await tab
        if req.wait_after_load:
            await asyncio.sleep(req.wait_after_load / 1000)
        # Try Turnstile bypass
        await tab.cf_verify()
        content = await tab.get_content()
        scrape_requests["success"] += 1
        return {"content": content, "pageStatusCode": 200, "contentType": "text/html"}
    except Exception as e:
        scrape_requests["error"] += 1
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        return_browser(browser)
        active_requests -= 1
```

**Dockerfile** (`apps/nodriver-adapter/Dockerfile`):
```dockerfile
FROM python:3.11-slim@sha256:<PINNED_DIGEST>
RUN apt-get update && apt-get install -y chromium && rm -rf /var/lib/apt/lists/*
RUN addgroup --system --gid 10001 app && adduser --system --uid 10001 --gid 10001 app
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Pre-download Chromium for nodriver during build
RUN python -c "import nodriver as uc; import asyncio; asyncio.run(uc.start(headless=True))" || true
COPY app/ ./app/
ENV PORT=3000
EXPOSE 3000
USER 10001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000"]
```

**docker-compose.antibot.yaml** (override file):
```yaml
  nodriver-adapter:
    build: ./apps/nodriver-adapter
    image: firecrawl/nodriver-adapter:local
    networks:
      - firecrawl-net
    environment:
      PORT: 3000
      BROWSER_POOL_SIZE: ${NODRIVER_POOL_SIZE:-3}
    cpus: 2.0
    mem_limit: 2G
    memswap_limit: 2G
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/health | grep -q healthy || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 30s
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:noexec,nosuid,size=256m
```

### 3.2: Fallback Chain Integration in the API

The Firecrawl API's scrape handler gains a fallback chain concept. When a scrape returns a 403, CAPTCHA indicator, or empty content, it retries through anti-bot backends.

**File**: `apps/api/src/lib/antibot-fallback.ts` (new)

```typescript
interface AntiBotBackend {
  name: string;
  url: string;
  detectFailure(response: ScrapeResponse): boolean;
}

const ANTIBOT_BACKENDS: AntiBotBackend[] = [];

if (process.env.NODRIVER_ADAPTER_URL) {
  ANTIBOT_BACKENDS.push({
    name: 'nodriver',
    url: process.env.NODRIVER_ADAPTER_URL,
    detectFailure: (r) =>
      r.pageStatusCode === 403 ||
      (r.pageStatusCode === 200 && isCaptchaPage(r.content))
  });
}

if (process.env.STEALTH_BROWSER_URL && process.env.STEALTH_AUTH_TOKEN) {
  ANTIBOT_BACKENDS.push({
    name: 'stealth-browser',
    url: process.env.STEALTH_BROWSER_URL,
    detectFailure: (r) =>
      r.pageStatusCode === 403 ||
      (r.pageStatusCode === 200 && isCaptchaPage(r.content))
  });
}

function isCaptchaPage(html: string): boolean {
  // Heuristic detection of challenge pages
  const indicators = [
    'cf-challenge-running',
    'challenge-platform',
    'g-recaptcha',
    'turnstile-wrapper',
  ];
  return indicators.some(i => html.includes(i));
}

export async function tryAntiBotFallback(
  url: string,
  originalResponse: ScrapeResponse,
  requestOptions: ScrapeRequestOptions
): Promise<ScrapeResponse | null> {
  for (const backend of ANTIBOT_BACKENDS) {
    if (!backend.detectFailure(originalResponse)) continue;

    console.log(`Retrying ${url} via anti-bot backend: ${backend.name}`);
    try {
      const response = await fetch(backend.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(backend.name === 'stealth-browser' && {
            'Authorization': `Bearer ${process.env.STEALTH_AUTH_TOKEN}`
          })
        },
        body: JSON.stringify({ url, ...requestOptions }),
        signal: AbortSignal.timeout(30000)
      });

      if (response.ok) {
        const result: ScrapeResponse = await response.json();
        if (result.content && !backend.detectFailure(result)) {
          return result;
        }
      }
    } catch (err) {
      console.warn(`Anti-bot backend ${backend.name} failed:`, (err as Error).message);
      continue;
    }
  }
  return null;
}
```

**MCP bridge estimate**: The original plan said 200 lines for the stealth-browser MCP bridge. After analyzing the MCP protocol (initialize → tools/list → tools/call lifecycle with session management, streaming, and error mapping), a proper implementation is ~500-600 lines. This phase scopes it as a separate `apps/stealth-bridge/` TypeScript service rather than a "thin bridge in the API."

### 3.3: browser-use — With Privacy Warning

browser-use is added as an optional sidecar. Its docker-compose entry includes a prominent comment about data privacy:

```yaml
  # WARNING: browser-use sends scraped page content to OpenAI's API for
  # AI-driven navigation. Do not enable if you scrape confidential data,
  # PII, or proprietary internal documentation.
  # Only enable if your use case involves public web pages only.
  browser-use:
    image: ghcr.io/browser-use/browser-use@sha256:<PINNED_DIGEST>
    # NEVER use :latest
    networks:
      - firecrawl-net
    environment:
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    cpus: 2.0
    mem_limit: 3G
    memswap_limit: 3G
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8000/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "2"
        compress: "true"
```

### Phase 3 Deliverables Summary

| File | Change |
|---|---|
| `apps/nodriver-adapter/` | **New** — Python microservice with browser pool, health, metrics, non-root user |
| `apps/api/src/lib/antibot-fallback.ts` | **New** — fallback chain: detect failure → retry through anti-bot backends |
| `apps/stealth-bridge/` | **New** — TypeScript MCP→HTTP bridge for stealth-browser (500-600 lines) |
| `docker-compose.antibot.yaml` | **New** — override file with nodriver, stealth-browser, browser-use services |
| `start-firecrawl.sh` | Conditional blocks for each anti-bot service |
| `.env.example` | `NODRIVER_ADAPTER_URL`, `STEALTH_BROWSER_URL`, `STEALTH_AUTH_TOKEN` (required, no defaults) |

---

## Phase 4: chaser-oxide — Protocol-Level CDP Stealth (Conditional)

**Goal**: Maximum anti-detection via a Rust CDP microservice with 13,000+ V8 patches and per-session fingerprint randomization. This is a multi-week engineering project — only activated if real-world data from Phases 1-3 shows it's needed.

### Activation Criteria (quantitative)

All three must be true, measured over a 30-day period in production:
1. **Failure rate > 5%** on anti-bot-protected sites (BotGuard, DataDome, Akamai) even with Phase 3 fallbacks
2. **Business need documented** — specific target sites that cannot be scraped with current toolchain
3. **Phase 3 stealth-browser-mcp is performing** — proving the MCP bridge pattern works before investing in a full Rust microservice

### Architecture

```
                          ┌──────────────────────────────────┐
                          │     Firecrawl API (unchanged)      │
                          │  PLAYWRIGHT_MICROSERVICE_URL ──────┼──► chaser-service:3000/scrape
                          └──────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┘
│
▼
chaser-service (Rust/axum) ◄── ChaserPage ◄── ChaserProfile
│                                                    │
│  • 13,000+ V8 patches                             │
│  • Per-session fingerprint randomization           │
│  • Bezier-curve human input simulation              │
│  • Realistic sizing: 50-100 concurrent sessions     │
│  • Multi-arch Docker image (~80MB)                  │
└─────────────────────────────────────────────────────┘
```

**Honest session count**: The original plan claimed "300+ concurrent sessions per node." Chrome itself struggles past ~50 concurrent tabs on typical hardware. A more realistic target is 50-100 concurrent sessions, benchmarked and documented.

### Implementation Steps

1. `apps/chaser-service/` — Rust/axum project implementing the canonical `/scrape` contract + `/health` + `/metrics`
2. `ChaserProfile` builder exposed via request body `profile` field — OS, GPU, RAM, screen, locale, timezone randomization
3. CreepJS detection score validation as part of CI — automated test scrapes CreepJS and asserts score ≤ 5%
4. Multi-stage Dockerfile, non-root user, read-only filesystem
5. Gradual rollout via `RENDER_BACKEND_ORDER=chaser,chromium` or weighted proxy
6. **Rust microservice estimate**: 1,500-2,500 lines (adjusted down from original — reuses the shared SSRF library patterns, only needs to implement the CDP layer)

---

## Phase 5: Observability & Operations

### 5.1: Unified Structured Logging

All services emit JSON-formatted logs with these fields:

```json
{
  "timestamp": "2026-05-26T10:30:00.000Z",
  "level": "info",
  "service": "playwright-service",
  "backend": "obscura",
  "message": "Scrape completed",
  "duration_ms": 234,
  "url": "https://example.com",
  "page_status": 200,
  "content_length": 45231,
  "fallback_used": false
}
```

### 5.2: Health Check Dashboard

All services expose `GET /health` and `GET /metrics`. A single `docker compose ps` or `podman ps` shows status. For production, a Prometheus scrape config targeting all `/metrics` endpoints.

### 5.3: Persistent Browser Caches (Volumes)

Every browser-based service gets a named volume for browser profiles and caches, avoiding re-download on restart:

```yaml
volumes:
  obscura-cache:
  nodriver-cache:
  stealth-browser-data:
```

### 5.4: Startup Ordering with Health Checks

All service-to-service `depends_on` uses `condition: service_healthy`, not `service_started`. The existing `docker-compose.yaml` already does this for rabbitmq; extend to playwright-service, obscura, and all new services.

---

## Phase 6: Maintenance & Governance

- Each new service has an `OWNERS.md` listing who maintains it
- SDK/tool version pins go in the service's own `Dockerfile` or `requirements.txt` / `Cargo.toml` — there is no global version manager
- Weekly automated dependency update PRs (Dependabot or Renovate) for each service
- Integration tests in CI that spin up the full stack and verify each adapter's `/scrape`, `/health`, and `/metrics` endpoints

---

## Security Appendix

### Threat Model

| Threat | Mitigation |
|---|---|
| Unauthenticated CDP access (anyone controls browser) | `OBSCURA_CDP_SECRET` shared secret on CDP WebSocket. Required at startup — no default. Services on the internal Docker network only. |
| Hardcoded default credentials | **Zero defaults.** `OBSCURA_CDP_SECRET`, `STEALTH_AUTH_TOKEN`, `BULL_AUTH_KEY` — all fail at startup if unset. |
| SSRF bypass through new adapters | All adapters import `@firecrawl/ssrf-protection` shared library. One code path, one audit surface. |
| Supply chain: untrusted Docker images | All custom images built from source in this workspace. Third-party images pinned to immutable digests (no `:latest`). |
| Container escape via browser zero-day | All services run as non-root (`USER 10001`). All services use `no-new-privileges:true`. Most use `read_only: true` filesystem. |
| Data leakage to third-party AI (browser-use) | Prominent warning in docker-compose and docs. Service is opt-in only. |
| FlareSolverr MITM of authenticated traffic | FlareSolverr is NOT the global proxy. It's only used when explicitly routed per-request. |
| DNS rebinding / TOCTOU SSRF | Existing `lookupWithCache` with 30s TTL from shared library. Same protection across all adapters. |

### Compliance Note

Scraping websites that deploy anti-bot measures (Cloudflare Turnstile, DataDome, Akamai) may raise legal questions depending on jurisdiction and the nature of the content. This toolchain provides technical capabilities — users are responsible for compliance with applicable laws, robots.txt, and terms of service.

---

## Summary: Phased Rollout

```
Phase 0 (Day 1)           Phase 1 (Week 1-2)        Phase 2 (Week 2)           Phase 3 (Week 3-4)        Phase 4 (Conditional)     Phase 5 (Ongoing)
─────────────────────     ────────────────────      ──────────────────         ──────────────────        ────────────────────      ────────────────────
Baseline benchmarks        Shared SSRF library       Crawl4AI server-side       Anti-bot fallback chain    chaser-oxide Rust         Observability
                           obscura beta path         markdown post-processing   nodriver + stealth-bridge  microservice              Unified logging
                           FlareSolverr opt-in                                                            Activation: metrics-driven Metrics endpoints
                           CDP authentication                                                             Realistic session counts   Health checks on all
                                                                                                                                    Digest pinning
```

**Each phase is independently shippable and tested against the Phase 0 baseline.** Phase 1 adds obscura as an opt-in beta without touching the Chromium pipeline. Phase 2 improves output quality. Phase 3 fills anti-bot gaps. Phase 4 is gated on production data. Phase 5 runs throughout.

---

## Testing Checklist (per phase)

### Phase 0
- [ ] `docker compose up -d` starts all services
- [ ] `./start-firecrawl.sh` starts all services via podman
- [ ] Baseline scrape of `https://example.com` succeeds and returns valid HTML
- [ ] Baseline markdown scrape produces reasonable output
- [ ] `docker stats --no-stream` recorded for memory baseline
- [ ] Response time recorded for latency baseline
- [ ] `./stop-firecrawl.sh` cleans up all containers

### Phase 1
- [ ] `@firecrawl/ssrf-protection` builds and passes tests
- [ ] playwright-service SSRF behavior identical after extracting shared lib
- [ ] `docker compose -f docker-compose.yaml -f docker-compose.obscura.yaml up -d` starts all services
- [ ] `curl http://localhost:9222/json/version?cdp-secret=<secret>` returns obscura version
- [ ] Request without `cdp-secret` returns 403
- [ ] Scrape through playwright-service with `RENDER_BACKEND_ORDER=obscura,chromium` succeeds
- [ ] Scrape fails gracefully to Chromium when obscura is unavailable
- [ ] FlareSolverr starts only when `START_FLARESOLVERR=true`
- [ ] `docker stats` shows obscura ≤ 512 MB steady state
- [ ] `./stop-firecrawl.sh` cleans up unconditionally

### Phase 2
- [ ] `curl http://localhost:8080/health` returns ok
- [ ] Markdown scrape with `CRAWL4AI_URL` set produces cleaner output than baseline
- [ ] Markdown scrape with Crawl4AI down silently falls back to native converter
- [ ] Response time increase from Crawl4AI hop is < 2 seconds

### Phase 3
- [ ] nodriver adapter `/health` reports healthy pool
- [ ] nodriver adapter `/scrape` returns content for Cloudflare Turnstile page
- [ ] Anti-bot fallback chain detects 403/CAPTCHA and retries through nodriver
- [ ] Fallback correctly caches per-domain results (5 min TTL)
- [ ] `./stop-firecrawl.sh` cleans up all anti-bot containers

### Phase 4 (if activated)
- [ ] chaser-service `/scrape` matches canonical contract
- [ ] CreepJS detection score ≤ 5%
- [ ] 50 concurrent sessions stable on 4-core node
- [ ] Fallback chain correctly routes to chaser when configured

### Phase 5
- [ ] All services expose `/health` and `/metrics` endpoints
- [ ] Structured JSON logs emitted by all services
- [ ] Named volumes persist browser caches across restarts
- [ ] Health checks gate service startup ordering correctly
