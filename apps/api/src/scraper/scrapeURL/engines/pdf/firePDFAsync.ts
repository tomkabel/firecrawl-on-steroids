import { Counter, Histogram, register } from "prom-client";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { Meta } from "../..";
import { config } from "../../../../config";
import type { PDFMode } from "../../../../controllers/v2/types";
import {
  createPdfCacheKey,
  getPdfResultFromCache,
  savePdfResultToCache,
} from "../../../../lib/gcs-pdf-cache";
import type { PDFProcessorResult } from "./types";
import { safeMarkdownToHtml } from "./markdownToHtml";

type FirePdfAsyncFallbackReason =
  | "http_404"
  | "http_413"
  | "http_503"
  | "http_429"
  | "http_5xx"
  | "network_error"
  | "terminal_failed"
  | "terminal_expired"
  | "terminal_cancelled"
  | "polling_timeout"
  | "result_503";

type FirePdfAsyncTerminalStatus = "done" | "failed" | "expired" | "cancelled";

type FirePdfAsyncFetch = typeof undiciFetch;

type FirePdfAsyncClientOptions = {
  fetch?: FirePdfAsyncFetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

const FIRE_PDF_ASYNC_MIN_DEADLINE_MS = 6000;
const FIRE_PDF_ASYNC_MAX_DEADLINE_MS = 29 * 60 * 1000;
const FIRE_PDF_ASYNC_TERMINAL_BUFFER_MS = 30 * 1000;
const FIRE_PDF_ASYNC_DEFAULT_RETRY_AFTER_MS = 1000;
const FIRE_PDF_ASYNC_MAX_RETRY_AFTER_MS = 5000;

function getMetric<T>(name: string, create: () => T): T {
  return (register.getSingleMetric(name) as T | undefined) ?? create();
}

const firePdfAsyncSubmittedTotal = getMetric(
  "firecrawl_fire_pdf_async_submitted_total",
  () =>
    new Counter({
      name: "firecrawl_fire_pdf_async_submitted_total",
      help: "FirePDF async jobs submitted",
      labelNames: ["lane"],
    }),
);

const firePdfAsyncCompletedTotal = getMetric(
  "firecrawl_fire_pdf_async_completed_total",
  () =>
    new Counter({
      name: "firecrawl_fire_pdf_async_completed_total",
      help: "FirePDF async terminal states observed",
      labelNames: ["terminal_status"],
    }),
);

const firePdfAsyncFallbackTotal = getMetric(
  "firecrawl_fire_pdf_async_fallback_total",
  () =>
    new Counter({
      name: "firecrawl_fire_pdf_async_fallback_total",
      help: "FirePDF async fallbacks to sync OCR",
      labelNames: ["reason"],
    }),
);

const firePdfAsyncTotalDurationSeconds = getMetric(
  "firecrawl_fire_pdf_async_total_duration_seconds",
  () =>
    new Histogram({
      name: "firecrawl_fire_pdf_async_total_duration_seconds",
      help: "Duration from FirePDF async selection to result availability",
      buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900, 1800],
    }),
);

const firePdfAsyncPollCount = getMetric(
  "firecrawl_fire_pdf_async_poll_count",
  () =>
    new Histogram({
      name: "firecrawl_fire_pdf_async_poll_count",
      help: "Number of FirePDF async job status polls per job",
      buckets: [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
    }),
);

const firePdfAsyncPostResponseSchema = z
  .object({
    scrape_id: z.string(),
    status: z.enum(["queued", "published", "running", "done"]),
    retry_after_ms: z.number().optional(),
    lane: z.string().optional(),
  })
  .passthrough();

const firePdfAsyncJobStatusSchema = z
  .object({
    scrape_id: z.string(),
    status: z.enum([
      "queued",
      "published",
      "running",
      "done",
      "failed",
      "expired",
      "cancelled",
    ]),
    retry_after_ms: z.number().optional(),
    pages_processed: z.number().optional(),
    failed_pages: z.array(z.number()).nullable().optional(),
    partial_pages: z.array(z.number()).nullable().optional(),
    error_class: z.string().optional(),
    error_message: z.string().optional(),
  })
  .passthrough();

const firePdfAsyncResultSchema = z
  .object({
    schema_version: z.literal(1),
    markdown: z.string(),
    pages_processed: z.number(),
    failed_pages: z.array(z.number()).nullable(),
    partial_pages: z.array(z.number()).nullable(),
  })
  .passthrough();

class FirePdfAsyncFallbackSignal extends Error {
  name = "FirePdfAsyncFallbackSignal";

  constructor(
    public reason: FirePdfAsyncFallbackReason,
    public context?: Record<string, unknown>,
  ) {
    super(`FirePDF async fallback: ${reason}`);
  }
}

export class FirePdfAsyncFatalError extends Error {
  name = "FirePdfAsyncFatalError";

  constructor(
    message: string,
    public context?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function isFirePdfAsyncFatalError(
  error: unknown,
): error is FirePdfAsyncFatalError {
  return error instanceof FirePdfAsyncFatalError;
}

function fallbackSignal(
  reason: FirePdfAsyncFallbackReason,
  context?: Record<string, unknown>,
): never {
  throw new FirePdfAsyncFallbackSignal(reason, context);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason ?? new Error("Aborted");
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal.reason ?? new Error("Aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function clampRetryAfterMs(retryAfterMs: number | undefined): number {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs)) {
    return FIRE_PDF_ASYNC_DEFAULT_RETRY_AFTER_MS;
  }

  return Math.min(
    Math.max(0, Math.floor(retryAfterMs)),
    FIRE_PDF_ASYNC_MAX_RETRY_AFTER_MS,
  );
}

function nextRetryDelayMs(
  currentDelayMs: number,
  retryAfterMs: number | undefined,
): number {
  const floor = clampRetryAfterMs(retryAfterMs);
  return Math.min(
    Math.max(currentDelayMs * 2, floor),
    FIRE_PDF_ASYNC_MAX_RETRY_AFTER_MS,
  );
}

function buildFirePdfAsyncDeadline(
  meta: Meta,
  nowMs: number,
): { deadlineAt: string; deadlineAtMs: number } {
  const remainingMs = meta.abort.scrapeTimeout();
  const budgetMs =
    remainingMs === undefined
      ? FIRE_PDF_ASYNC_MAX_DEADLINE_MS
      : Math.min(
          Math.max(Math.floor(remainingMs), FIRE_PDF_ASYNC_MIN_DEADLINE_MS),
          FIRE_PDF_ASYNC_MAX_DEADLINE_MS,
        );
  const deadlineAtMs = nowMs + budgetMs;

  return {
    deadlineAt: new Date(deadlineAtMs).toISOString(),
    deadlineAtMs,
  };
}

function getFirePdfAsyncBaseUrl(): string {
  return (config.FIRE_PDF_BASE_URL ?? "").replace(/\/+$/, "");
}

async function firePdfAsyncFetchJson(
  fetchImpl: FirePdfAsyncFetch,
  url: string,
  method: "GET" | "POST",
  body: unknown | undefined,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown; parseError?: unknown }> {
  const response = await fetchImpl(url, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();

  if (text.trim().length === 0) {
    return { status: response.status, body: undefined };
  }

  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch (error) {
    return { status: response.status, body: undefined, parseError: error };
  }
}

export async function scrapePDFWithFirePDFAsync(
  meta: Meta,
  base64Content: string,
  maxPages: number | undefined,
  pagesProcessed: number | undefined,
  mode: PDFMode | undefined,
  fallbackToSync: () => Promise<PDFProcessorResult>,
  clientOptions: FirePdfAsyncClientOptions = {},
): Promise<PDFProcessorResult> {
  const logger = meta.logger;

  if (meta.internalOptions.zeroDataRetention === true) {
    logger.info("FirePDF async skipped for ZDR request", {
      scrapeId: meta.id,
    });
    return await fallbackToSync();
  }

  const cacheable =
    mode !== "fast" && !maxPages && !meta.internalOptions.zeroDataRetention;
  const ownVariant: string | undefined = mode === "ocr" ? "ocr" : undefined;
  const lookupVariants: (string | undefined)[] =
    mode === "ocr" ? ["ocr"] : [undefined, "ocr"];

  if (cacheable) {
    for (const variant of lookupVariants) {
      try {
        const cached = await getPdfResultFromCache(
          base64Content,
          "firepdf",
          variant,
        );
        if (cached) {
          logger.info("Using cached FirePDF result", {
            scrapeId: meta.id,
            requestedMode: mode,
            cacheVariant: variant ?? "base",
          });
          return {
            ...cached,
            pagesProcessed: cached.pagesProcessed ?? pagesProcessed,
          };
        }
      } catch (error) {
        logger.warn("Error checking FirePDF cache, proceeding", {
          error,
          cacheVariant: variant ?? "base",
        });
      }
    }
  }

  meta.abort.throwIfAborted();

  const fetchImpl = clientOptions.fetch ?? undiciFetch;
  const sleep = clientOptions.sleep ?? defaultSleep;
  const now = clientOptions.now ?? Date.now;
  const signal = meta.abort.asSignal();
  const asyncStartedAt = now();
  const asyncBaseUrl = getFirePdfAsyncBaseUrl();
  let pollCount = 0;
  let submittedRecorded = false;
  let terminalStatusForMetrics: FirePdfAsyncTerminalStatus | undefined;

  const recordSubmitted = (lane?: string) => {
    if (submittedRecorded) return;
    firePdfAsyncSubmittedTotal.inc({ lane: lane ?? "unknown" });
    submittedRecorded = true;
  };

  const observePollsAndTerminal = () => {
    firePdfAsyncPollCount.observe(pollCount);
    if (terminalStatusForMetrics !== undefined) {
      firePdfAsyncCompletedTotal.inc({
        terminal_status: terminalStatusForMetrics,
      });
      terminalStatusForMetrics = undefined;
    }
  };

  const runFallback = async (
    reason: FirePdfAsyncFallbackReason,
    context?: Record<string, unknown>,
  ): Promise<PDFProcessorResult> => {
    firePdfAsyncFallbackTotal.inc({ reason });
    logger.warn("FirePDF async falling back to sync /ocr", {
      scrapeId: meta.id,
      reason,
      ...context,
    });

    observePollsAndTerminal();
    const result = await fallbackToSync();
    firePdfAsyncTotalDurationSeconds.observe((now() - asyncStartedAt) / 1000);
    return result;
  };

  const requestJson = async (
    url: string,
    method: "GET" | "POST",
    body?: unknown,
  ) => {
    try {
      return await firePdfAsyncFetchJson(fetchImpl, url, method, body, signal);
    } catch (error) {
      if (meta.abort.isAborted()) {
        meta.abort.throwIfAborted();
      }
      fallbackSignal("network_error", {
        error,
        url,
        method,
      });
    }
  };

  const throwFatal = (
    message: string,
    context?: Record<string, unknown>,
  ): never => {
    logger.error(message, {
      scrapeId: meta.id,
      ...context,
    });
    throw new FirePdfAsyncFatalError(message, {
      scrapeId: meta.id,
      ...context,
    });
  };

  try {
    if (!asyncBaseUrl) {
      fallbackSignal("network_error", {
        error: "FIRE_PDF_BASE_URL is not configured",
      });
    }

    const { deadlineAt, deadlineAtMs } = buildFirePdfAsyncDeadline(meta, now());
    const pollingTimeoutAtMs = deadlineAtMs + FIRE_PDF_ASYNC_TERMINAL_BUFFER_MS;
    const pdfSha256 = createPdfCacheKey(base64Content);
    const postBody = {
      pdf_b64: base64Content,
      scrape_id: meta.id,
      source: "firecrawl",
      zdr: false,
      deadline_at: deadlineAt,
      team_id: meta.internalOptions.teamId,
      ...(meta.internalOptions.crawlId && {
        crawl_id: meta.internalOptions.crawlId,
      }),
      options: {
        ...(pagesProcessed !== undefined &&
          pagesProcessed > 0 && { pages_estimate: pagesProcessed }),
        ...(maxPages !== undefined && { max_pages: maxPages }),
        ...(mode !== undefined && { mode }),
        url: meta.rewrittenUrl ?? meta.url,
        pdf_sha256: pdfSha256,
      },
    };

    logger.info("FirePDF async started", {
      scrapeId: meta.id,
      url: meta.rewrittenUrl ?? meta.url,
      maxPages,
      pagesEstimate: pagesProcessed,
      deadlineAt,
    });

    let postResponse: Awaited<ReturnType<typeof firePdfAsyncFetchJson>>;
    try {
      postResponse = await firePdfAsyncFetchJson(
        fetchImpl,
        `${asyncBaseUrl}/jobs`,
        "POST",
        postBody,
        signal,
      );
    } catch (error) {
      if (meta.abort.isAborted()) {
        meta.abort.throwIfAborted();
      }
      recordSubmitted("unknown");
      fallbackSignal("network_error", {
        error,
        stage: "submit",
      });
    }

    const parsedPostResponse = firePdfAsyncPostResponseSchema.safeParse(
      postResponse.body,
    );
    recordSubmitted(
      parsedPostResponse.success ? parsedPostResponse.data.lane : "unknown",
    );

    if (postResponse.status === 400) {
      throwFatal("FirePDF async POST /jobs validation failed", {
        status: postResponse.status,
        body: postResponse.body,
      });
    }

    if (postResponse.status === 409) {
      throwFatal("FirePDF async POST /jobs scrape_id conflict", {
        status: postResponse.status,
        body: postResponse.body,
      });
    }

    if (postResponse.status === 404) {
      fallbackSignal("http_404", {
        status: postResponse.status,
        stage: "submit",
      });
    }

    if (postResponse.status === 413) {
      fallbackSignal("http_413", {
        status: postResponse.status,
        stage: "submit",
      });
    }

    if (postResponse.status === 429) {
      fallbackSignal("http_429", {
        status: postResponse.status,
        stage: "submit",
      });
    }

    if (postResponse.status === 503) {
      fallbackSignal("http_503", {
        status: postResponse.status,
        stage: "submit",
      });
    }

    if (postResponse.status >= 500) {
      fallbackSignal("http_5xx", {
        status: postResponse.status,
        stage: "submit",
      });
    }

    if (
      (postResponse.status !== 200 && postResponse.status !== 202) ||
      !parsedPostResponse.success ||
      postResponse.parseError
    ) {
      fallbackSignal("network_error", {
        status: postResponse.status,
        stage: "submit",
        parseError: postResponse.parseError,
        validationError: parsedPostResponse.success
          ? undefined
          : parsedPostResponse.error,
      });
    }

    const pollUntilDone = async (
      initialDelayMs: number,
      sleepBeforeFirstPoll: boolean,
    ): Promise<z.infer<typeof firePdfAsyncJobStatusSchema>> => {
      let delayMs = clampRetryAfterMs(initialDelayMs);
      let shouldSleep = sleepBeforeFirstPoll;

      while (true) {
        if (now() > pollingTimeoutAtMs) {
          fallbackSignal("polling_timeout", {
            stage: "poll",
            pollCount,
          });
        }

        if (shouldSleep) {
          await sleep(delayMs, signal);
        }
        shouldSleep = true;

        if (now() > pollingTimeoutAtMs) {
          fallbackSignal("polling_timeout", {
            stage: "poll",
            pollCount,
          });
        }

        pollCount += 1;
        const statusResponse = await requestJson(
          `${asyncBaseUrl}/jobs/${encodeURIComponent(meta.id)}`,
          "GET",
        );
        const parsedStatus = firePdfAsyncJobStatusSchema.safeParse(
          statusResponse.body,
        );

        if (statusResponse.status === 404) {
          throwFatal("FirePDF async GET /jobs/:id returned 404", {
            status: statusResponse.status,
            body: statusResponse.body,
            pollCount,
          });
        }

        if (statusResponse.status === 410) {
          const terminalStatus =
            parsedStatus.success &&
            (parsedStatus.data.status === "cancelled" ||
              parsedStatus.data.status === "expired")
              ? parsedStatus.data.status
              : "expired";
          terminalStatusForMetrics = terminalStatus;
          fallbackSignal(
            terminalStatus === "cancelled"
              ? "terminal_cancelled"
              : "terminal_expired",
            {
              status: statusResponse.status,
              body: statusResponse.body,
              pollCount,
            },
          );
        }

        if (statusResponse.status === 502) {
          terminalStatusForMetrics = "failed";
          fallbackSignal("terminal_failed", {
            status: statusResponse.status,
            body: statusResponse.body,
            pollCount,
          });
        }

        if (statusResponse.status === 429) {
          fallbackSignal("http_429", {
            status: statusResponse.status,
            stage: "poll",
            pollCount,
          });
        }

        if (statusResponse.status >= 500) {
          fallbackSignal("http_5xx", {
            status: statusResponse.status,
            stage: "poll",
            pollCount,
          });
        }

        if (
          (statusResponse.status !== 200 && statusResponse.status !== 202) ||
          !parsedStatus.success ||
          statusResponse.parseError
        ) {
          fallbackSignal("network_error", {
            status: statusResponse.status,
            stage: "poll",
            pollCount,
            parseError: statusResponse.parseError,
            validationError: parsedStatus.success
              ? undefined
              : parsedStatus.error,
          });
        }

        const status = parsedStatus.data.status;
        if (status === "done") {
          terminalStatusForMetrics = "done";
          return parsedStatus.data;
        }

        if (status === "failed") {
          terminalStatusForMetrics = "failed";
          fallbackSignal("terminal_failed", {
            status: statusResponse.status,
            body: statusResponse.body,
            pollCount,
          });
        }

        if (status === "expired") {
          terminalStatusForMetrics = "expired";
          fallbackSignal("terminal_expired", {
            status: statusResponse.status,
            body: statusResponse.body,
            pollCount,
          });
        }

        if (status === "cancelled") {
          terminalStatusForMetrics = "cancelled";
          fallbackSignal("terminal_cancelled", {
            status: statusResponse.status,
            body: statusResponse.body,
            pollCount,
          });
        }

        delayMs = nextRetryDelayMs(delayMs, parsedStatus.data.retry_after_ms);
      }
    };

    if (postResponse.status === 202) {
      await pollUntilDone(
        parsedPostResponse.data.retry_after_ms ??
          FIRE_PDF_ASYNC_DEFAULT_RETRY_AFTER_MS,
        true,
      );
    } else {
      terminalStatusForMetrics = "done";
    }

    while (true) {
      const resultResponse = await requestJson(
        `${asyncBaseUrl}/jobs/${encodeURIComponent(meta.id)}/result`,
        "GET",
      );

      if (resultResponse.status === 409) {
        await pollUntilDone(FIRE_PDF_ASYNC_DEFAULT_RETRY_AFTER_MS, false);
        continue;
      }

      if (resultResponse.status === 503) {
        fallbackSignal("result_503", {
          status: resultResponse.status,
          stage: "result",
        });
      }

      if (resultResponse.status === 404) {
        fallbackSignal("http_404", {
          status: resultResponse.status,
          stage: "result",
        });
      }

      if (resultResponse.status === 429) {
        fallbackSignal("http_429", {
          status: resultResponse.status,
          stage: "result",
        });
      }

      if (resultResponse.status >= 500) {
        fallbackSignal("http_5xx", {
          status: resultResponse.status,
          stage: "result",
        });
      }

      const parsedResult = firePdfAsyncResultSchema.safeParse(
        resultResponse.body,
      );

      if (
        resultResponse.status !== 200 ||
        !parsedResult.success ||
        resultResponse.parseError
      ) {
        fallbackSignal("network_error", {
          status: resultResponse.status,
          stage: "result",
          parseError: resultResponse.parseError,
          validationError: parsedResult.success
            ? undefined
            : parsedResult.error,
        });
      }

      const durationMs = now() - asyncStartedAt;
      const pages = parsedResult.data.pages_processed ?? pagesProcessed;

      logger.info("FirePDF async completed", {
        scrapeId: meta.id,
        url: meta.rewrittenUrl ?? meta.url,
        durationMs,
        markdownLength: parsedResult.data.markdown.length,
        failedPages: parsedResult.data.failed_pages,
        partialPages: parsedResult.data.partial_pages,
        pagesProcessed: pages,
        pollCount,
        perPageMs: pages ? Math.round(durationMs / pages) : undefined,
      });

      const processorResult: PDFProcessorResult & { markdown: string } = {
        markdown: parsedResult.data.markdown,
        html: await safeMarkdownToHtml(
          parsedResult.data.markdown,
          logger,
          meta.id,
        ),
        pagesProcessed: pages,
      };

      if (cacheable) {
        try {
          await savePdfResultToCache(
            base64Content,
            processorResult,
            "firepdf",
            ownVariant,
          );
        } catch (error) {
          logger.warn("Error saving FirePDF result to cache", { error });
        }
      }

      observePollsAndTerminal();
      firePdfAsyncTotalDurationSeconds.observe((now() - asyncStartedAt) / 1000);
      return processorResult;
    }
  } catch (error) {
    if (meta.abort.isAborted()) {
      meta.abort.throwIfAborted();
    }

    if (error instanceof FirePdfAsyncFallbackSignal) {
      return await runFallback(error.reason, error.context);
    }

    throw error;
  }
}
