import express, { Request, Response } from 'express';
import { parseMcpSse } from './mcp';
import helmet from 'helmet';
import { lookup } from 'dns/promises';
import net from 'net';

const app = express();
app.use(helmet());
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT || '3001', 10);
const STEALTH_MCP_URL = process.env.STEALTH_BROWSER_URL || '';
// Optional bearer token the upstream API must present to call /scrape.
const STEALTH_BRIDGE_TOKEN = process.env.STEALTH_BRIDGE_TOKEN || '';
// Optional bearer token required when talking to the upstream MCP server.
const STEALTH_MCP_TOKEN = process.env.STEALTH_MCP_TOKEN || '';
const ALLOW_LOCAL_WEBHOOKS =
  (process.env.ALLOW_LOCAL_WEBHOOKS || 'False').toUpperCase() === 'TRUE';
const PER_REQUEST_TIMEOUT_MS = 15000;
// Overall budget for a single /scrape (sum of sequential MCP calls). Honors the
// caller's own 30s timeout so we don't burn a spawned browser on a doomed call.
const SCRAPE_TIMEOUT_MS = parseInt(process.env.SCRAPE_TIMEOUT_MS || '45000', 10);
const MAX_CONCURRENT_SCRAPES = parseInt(process.env.MAX_CONCURRENT_SCRAPES || '10', 10);

// ---------- Metrics ----------
const counters = { success: 0, ssrf_blocked: 0, error: 0 };
let activeRequests = 0;
const startTime = Date.now();

// ---------- SSRF protection ----------
// Minimal inline guard mirroring @firecrawl/ssrf-protection so this standalone
// service does not silently fetch internal/private targets.
function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateV6(ip: string): boolean {
  const u = ip.toLowerCase();
  if (u === '::' || u === '::1') return true;
  if (u.startsWith('fe80')) return true;
  if (u.startsWith('fc') || u.startsWith('fd')) return true;
  if (u.startsWith('::ffff:')) return isPrivateV4(u.slice(7));
  return false;
}

function isPrivateAddress(addr: string): boolean {
  if (net.isIPv4(addr)) return isPrivateV4(addr);
  if (net.isIPv6(addr)) return isPrivateV6(addr);
  return false;
}

async function assertSafeTargetUrl(urlString: string): Promise<void> {
  if (ALLOW_LOCAL_WEBHOOKS) return;
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported protocol "${parsed.protocol}"`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) throw new Error('hostname is missing');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('localhost targets are not allowed');
  }
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(`private IP "${hostname}" is not allowed`);
    }
    return;
  }
  const resolved = await lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new Error(`hostname "${hostname}" did not resolve to any IP address`);
  }
  if (resolved.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`hostname "${hostname}" resolves to a private IP`);
  }
}

// ---------- MCP JSON-RPC helper ----------

let mcpNextId = 0;
// MCP SSE sessions are identified by a session id returned on initialize and
// expected on every subsequent request.
let mcpSessionId: string | undefined;

async function mcpCall(
  method: string,
  params?: Record<string, unknown>,
  overrideUrl?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const isNotification = method.startsWith('notifications/');
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: isNotification ? undefined : ++mcpNextId,
    method,
    params: params || {},
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;
  if (STEALTH_MCP_TOKEN) headers['Authorization'] = `Bearer ${STEALTH_MCP_TOKEN}`;

  const perRequestSignal = AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([signal, perRequestSignal])
    : perRequestSignal;
  const res = await fetch(overrideUrl || STEALTH_MCP_URL, {
    method: 'POST',
    headers,
    body,
    signal: combinedSignal,
  });

  // Capture the session id so subsequent calls stay on the same MCP session.
  const sessionHeader = res.headers.get('mcp-session-id');
  if (sessionHeader) mcpSessionId = sessionHeader;

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status} for ${method}: ${await res.text().catch(() => '')}`);
  }

  // Notifications (e.g. notifications/initialized) do not return a result.
  if (isNotification) return undefined;

  const text = await res.text();

  // FastMCP HTTP transport returns SSE: "data: {...}\n\n" lines
  return parseMcpSse(text);
}

// ---------- Session-scoped scrape ----------

async function doScrape(url: string): Promise<{
  content: string;
  pageStatusCode: number;
  pageError?: string;
}> {
  // Bound the whole scrape (multiple sequential MCP calls) so we don't exceed
  // the caller's own timeout budget and waste a spawned browser.
  const scrapeController = new AbortController();
  const scrapeTimer = setTimeout(() => scrapeController.abort(), SCRAPE_TIMEOUT_MS);

  try {
    // 1. Initialize (required first call)
    const initResult = (await mcpCall(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stealth-bridge', version: '1.0.0' },
      },
      undefined,
      scrapeController.signal,
    )) as { protocolVersion?: string };

    // 2. Send initialized notification (no result expected)
    await mcpCall('notifications/initialized', undefined, undefined, scrapeController.signal);

    // 3. Spawn browser
    const spawnResult = (await mcpCall(
      'tools/call',
      {
        name: 'spawn_browser',
        arguments: { headless: true },
      },
      undefined,
      scrapeController.signal,
    )) as { content?: Array<{ type: string; text: string }> };

    const spawnText = spawnResult?.content?.[0]?.text;
    if (!spawnText) throw new Error('spawn_browser returned empty');
    const spawnData = JSON.parse(spawnText) as { instance_id?: string };
    const instanceId = spawnData.instance_id;
    if (!instanceId) throw new Error('No instance_id from spawn_browser');

    try {
      // 4. Navigate
      const navResult = (await mcpCall(
        'tools/call',
        {
          name: 'navigate',
          arguments: {
            instance_id: instanceId,
            url,
            wait_until: 'load',
            timeout: PER_REQUEST_TIMEOUT_MS,
          },
        },
        undefined,
        scrapeController.signal,
      )) as { content?: Array<{ type: string; text: string }> };

      const navText = navResult?.content?.[0]?.text;
      if (navText) {
        const navData = JSON.parse(navText) as { error?: string };
        if (navData.error) {
          return { content: '', pageStatusCode: 0, pageError: navData.error };
        }
      }

      // 5. Get content
      const contentResult = (await mcpCall(
        'tools/call',
        {
          name: 'get_page_content',
          arguments: { instance_id: instanceId, include_frames: false },
        },
        undefined,
        scrapeController.signal,
      )) as { content?: Array<{ type: string; text: string }> };

      const contentText = contentResult?.content?.[0]?.text;
      if (!contentText) {
        counters.error++;
        return { content: '', pageStatusCode: 0, pageError: 'get_page_content returned empty' };
      }

      const contentData = JSON.parse(contentText) as { html?: string; text?: string };
      const html = contentData.html || contentData.text || '';

      counters.success++;
      return { content: html, pageStatusCode: 200 };
    } catch (err) {
      counters.error++;
      return {
        content: '',
        pageStatusCode: 0,
        pageError: (err as Error).message,
      };
    } finally {
      // 6. Close browser instance — await so the response never resolves
      // before cleanup finishes, and so failures are observable (not swallowed).
      try {
        await mcpCall('tools/call', {
          name: 'close_instance',
          arguments: { instance_id: instanceId },
        });
      } catch (e) {
        console.warn('[stealth-bridge] close_instance failed:', (e as Error).message);
      }
    }
  } finally {
    clearTimeout(scrapeTimer);
  }
}

// ---------- Auth middleware ----------

function requireAuth(req: Request, res: Response, next: () => void): void {
  if (!STEALTH_BRIDGE_TOKEN) return next();
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ') || header.slice(7) !== STEALTH_BRIDGE_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ---------- Routes ----------

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    backend: 'stealth-browser-mcp',
    activePages: activeRequests,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    mcpUrl: !!STEALTH_MCP_URL,
  });
});

app.get('/metrics', (_req: Request, res: Response) => {
  res.type('text/plain').send(
    [
      `scrape_requests_total{status="success"} ${counters.success}`,
      `scrape_requests_total{status="ssrf_blocked"} ${counters.ssrf_blocked}`,
      `scrape_requests_total{status="error"} ${counters.error}`,
      `active_pages ${activeRequests}`,
      '',
    ].join('\n'),
  );
});

interface ScrapeBody {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: Record<string, string>;
  check_selector?: string;
  skip_tls_verification?: boolean;
}

app.post('/scrape', requireAuth, async (req: Request, res: Response) => {
  const body = req.body as ScrapeBody;

  if (!body?.url || typeof body.url !== 'string' || !body.url.trim()) {
    res.status(400).json({ error: 'URL is required' });
    return;
  }

  if (!STEALTH_MCP_URL) {
    counters.error++;
    res.status(500).json({ error: 'STEALTH_BROWSER_URL not configured on bridge' });
    return;
  }

  // SSRF gate before spawning a browser for the target.
  try {
    await assertSafeTargetUrl(body.url.trim());
  } catch (e) {
    counters.ssrf_blocked++;
    res.status(400).json({ error: `Blocked insecure target URL: ${(e as Error).message}` });
    return;
  }

  // Concurrency cap to avoid unbounded browser spawns against the MCP backend.
  if (activeRequests >= MAX_CONCURRENT_SCRAPES) {
    counters.error++;
    res.status(429).json({ error: 'Too many concurrent scrapes, try again later' });
    return;
  }

  activeRequests++;
  try {
    const result = await doScrape(body.url.trim());
    res.json({
      content: result.content,
      pageStatusCode: result.pageStatusCode,
      contentType: 'text/html',
      ...(result.pageError ? { pageError: result.pageError } : {}),
    });
  } catch (err) {
    counters.error++;
    console.error('[stealth-bridge] Scrape error:', (err as Error).message);
    res.status(500).json({ error: 'An error occurred while fetching the page.' });
  } finally {
    activeRequests--;
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[stealth-bridge] Listening on port ${PORT}`);
  if (!STEALTH_MCP_URL) {
    console.warn('[stealth-bridge] WARNING: STEALTH_BROWSER_URL not set — all scrapes will fail');
  }
});
