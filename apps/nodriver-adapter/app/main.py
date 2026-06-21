"""
nodriver-adapter: Anti-bot scraping microservice with browser pool.

Implements the canonical /scrape contract, plus /health and /metrics.
Uses a pre-warmed pool of nodriver browsers to avoid per-request cold starts.
Includes Turnstile bypass (cf_verify) for Cloudflare-protected pages.
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import nodriver as uc
import asyncio
import time
import os

BROWSER_POOL_SIZE = int(os.getenv("BROWSER_POOL_SIZE", "3"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "info")
BROWSER_EXECUTABLE_PATH = os.getenv("CHROME_BIN", os.getenv("BROWSER_EXECUTABLE_PATH", None))

browsers: list[uc.Browser] = []
pool_lock = asyncio.Lock()
start_time: float = 0

scrape_requests = {"success": 0, "ssrf_blocked": 0, "error": 0}
active_requests = 0


async def warm_pool():
    global start_time
    start_time = time.time()
    kwargs = {"headless": True, "no_sandbox": True, "browser_args": ["--disable-dev-shm-usage"]}
    if BROWSER_EXECUTABLE_PATH:
        kwargs["browser_executable_path"] = BROWSER_EXECUTABLE_PATH
    print(f"[nodriver-adapter] Warming browser pool (size={BROWSER_POOL_SIZE}, binary={BROWSER_EXECUTABLE_PATH or 'auto'})...")
    for i in range(BROWSER_POOL_SIZE):
        try:
            b = await uc.start(**kwargs)
            browsers.append(b)
            print(f"[nodriver-adapter] Browser {i + 1}/{BROWSER_POOL_SIZE} ready")
        except Exception as e:
            print(f"[nodriver-adapter] Failed to start browser {i + 1}: {e}")
            raise
    print(f"[nodriver-adapter] Pool warmup complete ({len(browsers)} browsers)")


async def drain_pool():
    print("[nodriver-adapter] Draining browser pool...")
    for b in browsers:
        try:
            await b.stop()
        except Exception:
            pass
    browsers.clear()
    print("[nodriver-adapter] Pool drained")


async def get_browser():
    async with pool_lock:
        if not browsers:
            raise RuntimeError("Browser pool exhausted")
        return browsers.pop()


async def return_browser(browser):
    async with pool_lock:
        if len(browsers) < BROWSER_POOL_SIZE:
            browsers.append(browser)


app = FastAPI(
    title="nodriver-adapter",
    version="1.0.0",
    lifespan=None,
)


@app.on_event("startup")
async def startup():
    await warm_pool()


@app.on_event("shutdown")
async def shutdown():
    await drain_pool()


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
        "maxPoolSize": BROWSER_POOL_SIZE,
    }


@app.get("/metrics")
async def metrics():
    lines = []
    for status, count in scrape_requests.items():
        lines.append(f'scrape_requests_total{{status="{status}"}} {count}')
    lines.append(f"active_pages {active_requests}")
    return JSONResponse(content="\n".join(lines) + "\n")


@app.post("/scrape")
async def scrape(req: ScrapeRequest):
    if not req.url or not req.url.strip():
        return JSONResponse(
            status_code=400, content={"error": "URL is required"}
        )

    global active_requests
    active_requests += 1
    browser = await get_browser()

    try:
        tab = await browser.get(req.url)
        await tab

        if req.wait_after_load:
            await asyncio.sleep(req.wait_after_load / 1000)

        try:
            await tab.cf_verify()
        except Exception:
            pass

        content = await tab.get_content()
        scrape_requests["success"] += 1

        return {
            "content": content,
            "pageStatusCode": 200,
            "contentType": "text/html",
        }
    except Exception as e:
        scrape_requests["error"] += 1
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await return_browser(browser)
        active_requests -= 1
