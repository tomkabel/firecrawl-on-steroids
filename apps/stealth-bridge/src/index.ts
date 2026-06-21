import express, { Request, Response } from 'express';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT || '3001', 10);
const STEALTH_MCP_URL = process.env.STEALTH_BROWSER_URL || '';

const SCRAPE_TIMEOUT_MS = 45000;
const PER_REQUEST_TIMEOUT_MS = 15000;

// ---------- Metrics ----------
const counters = { success: 0, ssrf_blocked: 0, error: 0 };
let activeRequests = 0;
const startTime = Date.now();

// ---------- MCP JSON-RPC helper ----------

interface MCPResult {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let mcpNextId = 0;

async function mcpCall(
  method: string,
  params?: Record<string, unknown>,
  overrideUrl?: string,
): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: ++mcpNextId,
    method,
    params: params || {},
  });

  const res = await fetch(overrideUrl || STEALTH_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body,
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status} for ${method}: ${await res.text().catch(() => '')}`);
  }

  const text = await res.text();

  // FastMCP HTTP transport returns SSE: "data: {...}\n\n" lines
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const parsed = JSON.parse(raw) as MCPResult;
      if (parsed.result !== undefined) return parsed.result;
      if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
  }

  throw new Error(`No valid result in MCP response for ${method}`);
}

// ---------- Session-scoped scrape ----------

async function doScrape(url: string): Promise<{
  content: string;
  pageStatusCode: number;
  pageError?: string;
}> {
  // 1. Initialize (required first call)
  const initResult = (await mcpCall('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'stealth-bridge', version: '1.0.0' },
  })) as { protocolVersion?: string };

  // 2. Send initialized notification
  await mcpCall('notifications/initialized');

  // 3. Spawn browser
  const spawnResult = (await mcpCall('tools/call', {
    name: 'spawn_browser',
    arguments: { headless: true },
  })) as { content?: Array<{ type: string; text: string }> };

  const spawnText = spawnResult?.content?.[0]?.text;
  if (!spawnText) throw new Error('spawn_browser returned empty');
  const spawnData = JSON.parse(spawnText) as { instance_id?: string };
  const instanceId = spawnData.instance_id;
  if (!instanceId) throw new Error('No instance_id from spawn_browser');

  try {
    // 4. Navigate
    const navResult = (await mcpCall('tools/call', {
      name: 'navigate',
      arguments: {
        instance_id: instanceId,
        url,
        wait_until: 'load',
        timeout: 15000,
      },
    })) as { content?: Array<{ type: string; text: string }> };

    const navText = navResult?.content?.[0]?.text;
    if (navText) {
      const navData = JSON.parse(navText) as { error?: string };
      if (navData.error) {
        return { content: '', pageStatusCode: 0, pageError: navData.error };
      }
    }

    // 5. Get content
    const contentResult = (await mcpCall('tools/call', {
      name: 'get_page_content',
      arguments: { instance_id: instanceId, include_frames: false },
    })) as { content?: Array<{ type: string; text: string }> };

    const contentText = contentResult?.content?.[0]?.text;
    if (!contentText) {
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
    // 6. Close browser instance (best effort)
    mcpCall('tools/call', {
      name: 'close_instance',
      arguments: { instance_id: instanceId },
    }).catch(() => {});
  }
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
  res.type('text/plain').send([
    `scrape_requests_total{status="success"} ${counters.success}`,
    `scrape_requests_total{status="ssrf_blocked"} ${counters.ssrf_blocked}`,
    `scrape_requests_total{status="error"} ${counters.error}`,
    `active_pages ${activeRequests}`,
    '',
  ].join('\n'));
});

interface ScrapeBody {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: Record<string, string>;
  check_selector?: string;
  skip_tls_verification?: boolean;
}

app.post('/scrape', async (req: Request, res: Response) => {
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
