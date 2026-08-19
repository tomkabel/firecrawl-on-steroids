import { config } from "../config";
import "../services/sentry";
import * as Sentry from "@sentry/node";
import { logger } from "./logger";
import type { Logger } from "winston";

const CRAWL4AI_TIMEOUT_MS = 30000;

export async function convertHTMLToMarkdownWithCrawl4AI(
  html: string,
  context?: {
    logger?: Logger;
    requestId?: string;
    zeroDataRetention?: boolean;
  },
): Promise<string | null> {
  if (!config.CRAWL4AI_URL) {
    return null;
  }

  const contextLogger = context?.logger || logger;
  const requestId = context?.requestId;
  const zeroDataRetention = context?.zeroDataRetention === true;

  try {
    const response = await fetch(`${config.CRAWL4AI_URL}/md`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: `raw://${html}`,
        f: "raw",
        c: "0",
      }),
      signal: AbortSignal.timeout(CRAWL4AI_TIMEOUT_MS),
    });

    if (!response.ok) {
      contextLogger.warn("Crawl4AI /md endpoint returned non-OK status", {
        status: response.status,
        statusText: response.statusText,
        ...(requestId && !zeroDataRetention ? { requestId } : {}),
      });
      return null;
    }

    const data = await response.json();
    // Use `!== undefined` rather than a truthy check: a successful conversion
    // can legitimately return an empty markdown string, which a truthy check
    // would wrongly discard as a failure.
    if (data?.success && data?.markdown != null) {
      return data.markdown as string;
    }

    contextLogger.warn("Crawl4AI response missing markdown field", {
      hasSuccess: !!data?.success,
      hasMarkdown: data?.markdown != null,
      ...(requestId && !zeroDataRetention ? { requestId } : {}),
    });
    return null;
  } catch (error) {
    contextLogger.warn("Crawl4AI markdown conversion failed, falling back", {
      error: (error as Error).message,
      ...(requestId && !zeroDataRetention ? { requestId } : {}),
    });
    Sentry.captureException(error, {
      tags: {
        fallback: "crawl4ai_unavailable",
        ...(requestId && !zeroDataRetention ? { request_id: requestId } : {}),
      },
    });
    return null;
  }
}
