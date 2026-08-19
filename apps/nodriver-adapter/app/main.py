"""
nodriver-adapter: Anti-bot scraping microservice with browser pool.

Implements the canonical /scrape contract, plus /health and /metrics.
Uses a pre-warmed pool of nodriver browsers to avoid per-request cold starts.
Includes Turnstile bypass (Cloudflare verify) for Cloudflare-protected pages.
"""

import asyncio
import inspect
import ipaddress
import itertools
import logging
import os
import shutil
import socket
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

import nodriver as uc
from nodriver import cdp

LOG_LEVEL = os.getenv("LOG_LEVEL", "info")
logging.basicConfig(level=LOG_LEVEL.upper())
logger = logging.getLogger("nodriver-adapter")

BROWSER_POOL_SIZE = int(os.getenv("BROWSER_POOL_SIZE", "3"))
BROWSER_START_TIMEOUT = float(os.getenv("BROWSER_START_TIMEOUT", "30"))
BROWSER_EXECUTABLE_PATH = os.getenv("CHROME_BIN", os.getenv("BROWSER_EXECUTABLE_PATH", None))
CHROME_USER_DATA_DIR = os.getenv("CHROME_USER_DATA_DIR")
ALLOW_LOCAL_WEBHOOKS = os.getenv("ALLOW_LOCAL_WEBHOOKS", "False").upper() == "TRUE"

# Prometheus text exposition format (never application/json).
PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

browsers: list[uc.Browser] = []
pool_lock = asyncio.Lock()
start_time: float = 0

scrape_requests = {"success": 0, "ssrf_blocked": 0, "error": 0}
active_requests = 0

_profile_counter = itertools.count()


def _browser_kwargs() -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "headless": True,
        "no_sandbox": True,
        "browser_args": ["--disable-dev-shm-usage"],
    }
    if BROWSER_EXECUTABLE_PATH:
        kwargs["browser_executable_path"] = BROWSER_EXECUTABLE_PATH
    if CHROME_USER_DATA_DIR:
        # Chromium refuses to share one profile directory between processes, so
        # every pooled browser gets its own subdirectory under the configured
        # root. Creating it up front also guarantees it is writable for the
        # (non-root) runtime user instead of Chromium falling back to $HOME.
        profile_dir = os.path.join(CHROME_USER_DATA_DIR, f"profile-{next(_profile_counter)}")
        os.makedirs(profile_dir, exist_ok=True)
        kwargs["user_data_dir"] = profile_dir
        # HOME is set explicitly by the image; fall back to the profile root so
        # Chromium never writes to an unwritable home when it is missing.
        os.environ.setdefault("HOME", CHROME_USER_DATA_DIR)
    return kwargs


def _cleanup_profile(browser: uc.Browser) -> None:
    """Remove the profile directory of a stopped browser (we own it)."""
    if not CHROME_USER_DATA_DIR:
        return
    profile_dir = str(getattr(getattr(browser, "config", None), "user_data_dir", "") or "")
    if not profile_dir:
        return
    root = os.path.abspath(CHROME_USER_DATA_DIR)
    if os.path.abspath(profile_dir).startswith(root + os.sep):
        shutil.rmtree(profile_dir, ignore_errors=True)


async def _start_browser() -> uc.Browser:
    """Launch a browser, bounded by a timeout so a wedged Chromium cannot hang
    startup or a request that is replacing a discarded browser."""
    return await asyncio.wait_for(uc.start(**_browser_kwargs()), timeout=BROWSER_START_TIMEOUT)


async def _close_browser(browser: uc.Browser) -> None:
    """Stop a browser process. `Browser.stop()` is synchronous in nodriver, but
    tolerate an awaitable so this keeps working across versions."""
    try:
        result = browser.stop()
        if inspect.isawaitable(result):
            await result
    except Exception as e:  # noqa: BLE001
        logger.warning("[nodriver-adapter] Failed to stop browser: %r", e)
    _cleanup_profile(browser)


async def warm_pool():
    global start_time
    start_time = time.time()
    logger.info(
        "[nodriver-adapter] Warming browser pool (size=%s, binary=%s)...",
        BROWSER_POOL_SIZE,
        BROWSER_EXECUTABLE_PATH or "auto",
    )
    for i in range(BROWSER_POOL_SIZE):
        try:
            b = await _start_browser()
            browsers.append(b)
            logger.info("[nodriver-adapter] Browser %s/%s ready", i + 1, BROWSER_POOL_SIZE)
        except Exception as e:  # noqa: BLE001
            logger.error("[nodriver-adapter] Failed to start browser %s: %s", i + 1, e)
            # Don't leave half a pool of orphaned Chromium processes behind.
            await drain_pool()
            raise
    logger.info("[nodriver-adapter] Pool warmup complete (%s browsers)", len(browsers))


async def drain_pool():
    logger.info("[nodriver-adapter] Draining browser pool...")
    for b in browsers:
        await _close_browser(b)
    browsers.clear()
    logger.info("[nodriver-adapter] Pool drained")


async def get_browser() -> uc.Browser:
    async with pool_lock:
        if not browsers:
            raise RuntimeError("Browser pool exhausted")
        return browsers.pop()


async def return_browser(browser: uc.Browser) -> None:
    """Put a *healthy* browser back into the pool."""
    async with pool_lock:
        if len(browsers) < BROWSER_POOL_SIZE:
            browsers.append(browser)
            return
    await _close_browser(browser)


async def discard_browser(browser: uc.Browser) -> None:
    """Close a browser that errored out (or that carries state we cannot revert)
    and replace it with a fresh one, so a bad instance never poisons the next
    request and the pool does not shrink permanently."""
    await _close_browser(browser)
    try:
        replacement = await _start_browser()
    except Exception as e:  # noqa: BLE001
        logger.error("[nodriver-adapter] Failed to replace discarded browser: %r", e)
        return
    await return_browser(replacement)


def _unwrap_ipv6(ip: Any) -> Any:
    """Return the IPv4 address embedded in an IPv6 address, if any.

    `::ffff:127.0.0.1` (IPv4-mapped), 6to4 and Teredo addresses all carry an
    IPv4 address whose privateness is *not* reported consistently by the IPv6
    properties across Python versions, so it is checked explicitly.
    """
    mapped = getattr(ip, "ipv4_mapped", None) or getattr(ip, "sixtofour", None)
    if mapped is not None:
        return mapped
    teredo = getattr(ip, "teredo", None)
    if teredo:
        # (server, client) - the client is the address the traffic ends up at.
        return teredo[1]
    return ip


def is_private_address(addr: str) -> bool:
    """True when `addr` must not be reached. Fails closed: anything that cannot
    be parsed as an IP address is treated as unsafe."""
    try:
        ip = _unwrap_ipv6(ipaddress.ip_address(addr))
    except ValueError:
        return True
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_unspecified
        or ip.is_multicast
        or ip.is_reserved
    )


class InsecureConnectionError(ValueError):
    """Raised when a caller-supplied URL fails the SSRF gate.

    Mirrors `InsecureConnectionError` from `@firecrawl/ssrf-protection`, which the
    TypeScript adapters in this stack use for the same purpose.
    """

    def __init__(self, blocked_url: str, reason: str):
        super().__init__(f"Blocked insecure target URL \"{blocked_url}\": {reason}")
        self.blocked_url = blocked_url
        self.reason = reason


@dataclass(frozen=True)
class SafeTarget:
    """A URL that passed `assert_safe_target_url()`.

    The navigation helper only accepts this type, so a caller-supplied URL cannot
    structurally reach `browser.get()` without having been validated first.
    """

    url: str


def assert_safe_target_url(url_string: str) -> SafeTarget:
    """Reject non-http(s) targets and any host that resolves to a private,
    loopback, link-local, unspecified or multicast address (SSRF protection).

    Every caller-supplied URL must pass through here before it is handed to
    `browser.get()`; the browser itself performs no filtering.
    """
    parsed = urlparse(url_string)
    # The scheme allow-list is enforced unconditionally: file:// or chrome://
    # navigations are never acceptable, not even with ALLOW_LOCAL_WEBHOOKS.
    if parsed.scheme not in ("http", "https"):
        raise InsecureConnectionError(url_string, f"unsupported protocol \"{parsed.scheme}\"")
    if ALLOW_LOCAL_WEBHOOKS:
        # Explicit opt-out for local/self-hosted setups (same env var as the
        # other adapters); the operator owns the target it points at.
        logger.debug("[nodriver-adapter] Address checks skipped via ALLOW_LOCAL_WEBHOOKS")
        return SafeTarget(url_string)
    hostname = (parsed.hostname or "").rstrip(".").lower()
    if not hostname:
        raise InsecureConnectionError(url_string, "hostname is missing")
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise InsecureConnectionError(url_string, "localhost targets are not allowed")
    if hostname.endswith(".internal") or hostname.endswith(".local"):
        raise InsecureConnectionError(url_string, "internal/mDNS targets are not allowed")

    # If the hostname is a literal IP, validate it directly.
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass  # not a literal IP, resolve below
    else:
        if is_private_address(hostname):
            raise InsecureConnectionError(url_string, f"private IP \"{hostname}\" is not allowed")
        return SafeTarget(url_string)

    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        raise InsecureConnectionError(
            url_string, f"DNS lookup failed for \"{hostname}\", cannot verify target is safe"
        ) from e

    if not infos:
        raise InsecureConnectionError(
            url_string, f"hostname \"{hostname}\" did not resolve to any IP address"
        )
    for info in infos:
        if is_private_address(info[4][0]):
            raise InsecureConnectionError(
                url_string, f"hostname \"{hostname}\" resolves to a private IP"
            )
    return SafeTarget(url_string)


class ScrapeRequest(BaseModel):
    url: str
    wait_after_load: int = 0
    timeout: int = 15000
    headers: dict[str, str] = Field(default_factory=dict)
    check_selector: str | None = None
    skip_tls_verification: bool = False


async def apply_request_overrides(tab: uc.Tab, req: ScrapeRequest) -> dict[str, bool]:
    """Apply the per-request options (custom headers, TLS behaviour) to the tab
    before navigation, and return the state needed to undo them afterwards."""
    extra_headers = {k: v for k, v in req.headers.items() if k.strip().lower() != "user-agent"}
    user_agent = next(
        (v for k, v in req.headers.items() if k.strip().lower() == "user-agent"), None
    )
    state = {
        "extra_headers": bool(extra_headers),
        "ignore_cert_errors": bool(req.skip_tls_verification),
        # A user-agent override cannot be reverted on a shared browser, so the
        # browser is recycled instead of being returned to the pool.
        "recycle": bool(user_agent),
    }

    if req.skip_tls_verification:
        await tab.send(cdp.security.set_ignore_certificate_errors(ignore=True))
    if extra_headers or user_agent:
        await tab.send(cdp.network.enable())
    if user_agent:
        await tab.send(cdp.network.set_user_agent_override(user_agent=user_agent))
    if extra_headers:
        await tab.send(
            cdp.network.set_extra_http_headers(headers=cdp.network.Headers(extra_headers))
        )
    return state


async def reset_request_overrides(tab: uc.Tab, state: dict[str, bool]) -> None:
    """Undo per-request state so a pooled browser cannot leak one caller's
    headers / TLS settings into the next scrape."""
    if state["extra_headers"]:
        await tab.send(cdp.network.set_extra_http_headers(headers=cdp.network.Headers({})))
    if state["ignore_cert_errors"]:
        await tab.send(cdp.security.set_ignore_certificate_errors(ignore=False))


def tab_identity(tab: uc.Tab) -> str:
    """Stable identity of a tab, used to verify that the tab which performed the
    navigation is the one the per-request overrides were installed on."""
    target_id = getattr(getattr(tab, "target", None), "target_id", None)
    return str(target_id) if target_id else f"obj-{id(tab):x}"


async def navigate_with_overrides(
    browser: uc.Browser, target: SafeTarget, req: ScrapeRequest, timeout_s: float
) -> tuple[uc.Tab, dict[str, bool]]:
    """Load `target` in a tab that carries this request's UA / header / TLS overrides.

    Only a `SafeTarget` (i.e. a URL that passed `assert_safe_target_url()`) can be
    navigated, so navigation cannot happen behind the SSRF gate's back.

    `browser.get()` reuses the browser's first page target, so navigating to
    about:blank first hands us that tab (and clears the page state left behind by
    the previous user of this pooled browser). That is an implicit contract with
    nodriver, so the identity of the tab returned by the real navigation is
    verified: if a different tab shows up, the overrides are re-applied to *that*
    tab and the page is reloaded, so the caller's settings can never be silently
    dropped. The browser is then flagged for recycling because the state left on
    the abandoned tab cannot be reverted reliably.
    """
    tab = await asyncio.wait_for(browser.get("about:blank"), timeout=timeout_s)
    overrides = await apply_request_overrides(tab, req)

    nav_tab = await asyncio.wait_for(browser.get(target.url), timeout=timeout_s)
    if tab_identity(nav_tab) == tab_identity(tab):
        return nav_tab, overrides

    logger.warning(
        "[nodriver-adapter] Navigation used tab %s but overrides were installed on %s; "
        "re-applying them on the navigating tab",
        tab_identity(nav_tab),
        tab_identity(tab),
    )
    if not any(overrides.values()):
        # Nothing was overridden, so the navigation above is already correct.
        return nav_tab, overrides

    stale_overrides = overrides
    overrides = await apply_request_overrides(nav_tab, req)
    # The first load ran without the caller's settings - redo it now that the
    # navigating tab carries them.
    await asyncio.wait_for(nav_tab.reload(), timeout=timeout_s)
    try:
        await reset_request_overrides(tab, stale_overrides)
    except Exception as e:  # noqa: BLE001
        logger.debug("[nodriver-adapter] Could not reset overrides on abandoned tab: %s", e)
    overrides["recycle"] = True
    return nav_tab, overrides


async def try_cf_verify(tab: uc.Tab, url: str) -> None:
    """Best-effort Cloudflare checkbox bypass. Failures are expected on pages
    without a challenge, but they are logged (LOG_LEVEL=debug) instead of being
    swallowed silently, so bypass efficacy stays diagnosable."""
    verify = getattr(tab, "verify_cf", None) or getattr(tab, "cf_verify", None)
    if verify is None:
        logger.debug("[nodriver-adapter] nodriver build exposes no Cloudflare verify helper")
        return
    try:
        await verify()
    except Exception as e:  # noqa: BLE001
        logger.debug("[nodriver-adapter] Cloudflare verify skipped for %s: %s", url, e)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await warm_pool()
    yield
    await drain_pool()


app = FastAPI(
    title="nodriver-adapter",
    version="1.0.0",
    lifespan=lifespan,
)


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
    """Prometheus text exposition format (`metric_name value` lines)."""
    lines = [
        "# HELP scrape_requests_total Total scrape requests by outcome.",
        "# TYPE scrape_requests_total counter",
        *(
            f'scrape_requests_total{{status="{status}"}} {count}'
            for status, count in scrape_requests.items()
        ),
        "# HELP active_pages Scrapes currently in flight.",
        "# TYPE active_pages gauge",
        f"active_pages {active_requests}",
        "# HELP browser_pool_available Idle browsers available in the pool.",
        "# TYPE browser_pool_available gauge",
        f"browser_pool_available {len(browsers)}",
    ]
    return PlainTextResponse("\n".join(lines) + "\n", media_type=PROMETHEUS_CONTENT_TYPE)


@app.post("/scrape")
async def scrape(req: ScrapeRequest):
    global active_requests

    url = (req.url or "").strip()
    if not url:
        return JSONResponse({"error": "URL is required"}, status_code=400)

    # SSRF gate: no caller-supplied URL reaches browser.get() unvalidated. The
    # validated URL is carried as a SafeTarget, which is the only thing
    # navigate_with_overrides() accepts.
    try:
        target = assert_safe_target_url(url)
    except InsecureConnectionError as e:
        scrape_requests["ssrf_blocked"] += 1
        logger.warning("[nodriver-adapter] %s", e)
        return JSONResponse({"error": str(e)}, status_code=400)

    # Acquire the browser *before* touching the gauge: get_browser() can raise on
    # pool exhaustion, which must be counted and must not leak active_requests.
    try:
        browser = await get_browser()
    except RuntimeError as e:
        scrape_requests["error"] += 1
        logger.warning("[nodriver-adapter] %s", e)
        raise HTTPException(status_code=503, detail="Browser pool exhausted") from e

    active_requests += 1
    reusable = False
    try:
        timeout_s = max(1.0, req.timeout / 1000)
        wait_after_load_s = max(0.0, req.wait_after_load / 1000)

        # The overrides must be installed on the tab that actually navigates, so
        # acquiring the tab, applying them and loading the URL is done together.
        deadline = asyncio.get_running_loop().time() + timeout_s + wait_after_load_s
        tab, overrides = await navigate_with_overrides(browser, target, req, timeout_s)
        await tab

        if wait_after_load_s:
            await asyncio.sleep(wait_after_load_s)

        await try_cf_verify(tab, url)

        page_error: str | None = None
        if req.check_selector:
            remaining = max(1.0, deadline - asyncio.get_running_loop().time())
            # Tab.select() waits for the element and returns None on timeout.
            if not await tab.select(req.check_selector, timeout=remaining):
                page_error = f"Selector not found: {req.check_selector}"

        if page_error:
            content, page_status_code = "", 0
            scrape_requests["error"] += 1
        else:
            content = await tab.get_content()
            page_status_code = 200
            scrape_requests["success"] += 1

        await reset_request_overrides(tab, overrides)
        reusable = not overrides["recycle"]

        response: dict[str, Any] = {
            "content": content,
            "pageStatusCode": page_status_code,
            "contentType": "text/html",
        }
        if page_error:
            response["pageError"] = page_error
        return response
    except asyncio.TimeoutError as e:
        scrape_requests["error"] += 1
        logger.warning("[nodriver-adapter] Timed out after %sms loading %s", req.timeout, url)
        raise HTTPException(status_code=504, detail="Timed out loading the page.") from e
    except Exception as e:  # noqa: BLE001
        scrape_requests["error"] += 1
        logger.error("[nodriver-adapter] Scrape failed for %s: %s", url, e)
        raise HTTPException(
            status_code=500, detail="An error occurred while fetching the page."
        ) from e
    finally:
        # Decrement first: the gauge must not leak even if pool bookkeeping below
        # raises. Only healthy browsers go back into the pool; anything that
        # errored (or that holds an override we cannot revert) is closed and
        # replaced.
        active_requests -= 1
        if reusable:
            await return_browser(browser)
        else:
            await discard_browser(browser)
