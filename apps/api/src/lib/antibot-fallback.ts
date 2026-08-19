import { z } from "zod";
import { config } from "../config";
import { detectAntiBotFailure } from "./antibot-detection";
import { logger } from "./logger";
import { robustFetch } from "../scraper/scrapeURL/lib/fetch";

export interface AntiBotScrapeResponse {
  content: string;
  pageStatusCode: number;
  contentType: string;
  pageError?: string;
}

interface AntiBotBackend {
  name: string;
  url: string;
  authToken?: string;
}

function buildAntiBotBackends(): AntiBotBackend[] {
  const backends: AntiBotBackend[] = [];

  if (config.NODRIVER_ADAPTER_URL) {
    backends.push({
      name: "nodriver",
      url: config.NODRIVER_ADAPTER_URL,
    });
  }

  if (config.CHASER_SERVICE_URL) {
    backends.push({
      name: "chaser",
      url: config.CHASER_SERVICE_URL,
    });
  }

  if (config.STEALTH_BROWSER_URL && config.STEALTH_AUTH_TOKEN) {
    backends.push({
      name: "stealth-browser",
      url: config.STEALTH_BROWSER_URL,
      authToken: config.STEALTH_AUTH_TOKEN,
    });
  }

  return backends;
}

export async function tryAntiBotFallback(
  url: string,
  html: string,
  statusCode: number,
  requestOptions: {
    wait_after_load?: number;
    timeout?: number;
    headers?: Record<string, string>;
    check_selector?: string;
    skip_tls_verification?: boolean;
  },
  opts?: { abort?: AbortSignal },
): Promise<AntiBotScrapeResponse | null> {
  const backends = buildAntiBotBackends();

  // Only attempt a fallback if the primary response actually looks like a bot
  // block in the first place.
  if (!detectAntiBotFailure(html, statusCode)) {
    return null;
  }

  // Honor the caller-supplied timeout (ms). This is the per-backend budget we
  // forward to the upstream service; the overall loop budget below keeps the
  // sequential attempts from accumulating unbounded latency.
  const timeoutMs =
    typeof requestOptions.timeout === "number" && requestOptions.timeout > 0
      ? requestOptions.timeout
      : 30000;

  const controller = new AbortController();
  // Overall budget for the whole fallback sequence: cap total wall-clock time
  // at the caller's timeout so sequential backend attempts can't accumulate up
  // to ~90s of latency. Each backend still gets `timeout` as its own upstream
  // budget via the request body below.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const parentSignal = opts?.abort;
  if (parentSignal?.aborted) {
    controller.abort();
  }
  // Propagate the caller's abort so a cancelled scrape cancels the fallback too.
  // Both the parent abort and the overall budget abort the same controller, so
  // the fetch below is cancelled by whichever fires first.
  parentSignal?.addEventListener("abort", () => controller.abort(), { once: true });
  const signal = controller.signal;

  try {
    for (const backend of backends) {
      if (controller.signal.aborted) break;

      try {
        const reqHeaders: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (backend.authToken) {
          reqHeaders["Authorization"] = `Bearer ${backend.authToken}`;
        }

        const result = await robustFetch({
          url: backend.url,
          method: "POST",
          headers: reqHeaders,
          body: {
            url,
            wait_after_load: requestOptions.wait_after_load,
            timeout: requestOptions.timeout,
            headers: requestOptions.headers,
            check_selector: requestOptions.check_selector,
            skip_tls_verification: requestOptions.skip_tls_verification,
          },
          schema: z.object({
            content: z.string(),
            pageStatusCode: z.number(),
            contentType: z.string().optional(),
            pageError: z.string().optional(),
          }),
          logger: logger.child({
            module: "antibot-fallback",
            backend: backend.name,
          }),
          mock: null,
          abort: signal,
        });

        if (
          result.content.length > 0 &&
          // Re-validate: if the fallback still returns a blocked page, keep
          // trying the remaining backends.
          !detectAntiBotFailure(result.content, result.pageStatusCode)
        ) {
          return {
            content: result.content,
            pageStatusCode: result.pageStatusCode,
            contentType: result.contentType ?? "text/html",
            ...(result.pageError ? { pageError: result.pageError } : {}),
          };
        }
      } catch (err) {
        logger.warn(`[antibot-fallback] Backend ${backend.name} failed`, {
          error: (err as Error).message,
        });
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return null;
}
