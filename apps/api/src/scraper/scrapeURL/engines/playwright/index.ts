import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { tryAntiBotFallback } from "../../../../lib/antibot-fallback";

// Some scrape backends wrap their result in an outer JSON envelope that must be
// unwrapped before the content can be used.
async function unwrapJsonContent(
  content: string,
  contentType: string | undefined,
): Promise<string> {
  if (contentType?.includes("application/json")) {
    return getInnerJson(content);
  }
  return content;
}

export async function scrapeURLWithPlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const response = await robustFetch({
    url: config.PLAYWRIGHT_MICROSERVICE_URL!,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      url: meta.rewrittenUrl ?? meta.url,
      wait_after_load: meta.options.waitFor,
      timeout: meta.abort.scrapeTimeout(),
      headers: meta.options.headers,
      skip_tls_verification: meta.options.skipTlsVerification,
    },
    method: "POST",
    logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
    schema: z.object({
      content: z.string(),
      pageStatusCode: z.number(),
      pageError: z.string().optional(),
      contentType: z.string().optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  response.content = await unwrapJsonContent(response.content, response.contentType);

  // Anti-bot fallback: if playwright returns a 403, CAPTCHA, or empty content,
  // try alternative anti-bot backends (nodriver, stealth-browser)
  const fallbackResult = await tryAntiBotFallback(
    meta.rewrittenUrl ?? meta.url,
    response.content,
    response.pageStatusCode,
    {
      wait_after_load: meta.options.waitFor,
      timeout: meta.abort.scrapeTimeout(),
      headers: meta.options.headers,
      skip_tls_verification: meta.options.skipTlsVerification,
    },
    { abort: meta.abort.asSignal() },
  );

  if (fallbackResult) {
    meta.logger.info("Anti-bot fallback succeeded, using fallback content");

    const content = await unwrapJsonContent(
      fallbackResult.content,
      fallbackResult.contentType,
    );

    return {
      url: meta.rewrittenUrl ?? meta.url,
      html: content,
      statusCode: fallbackResult.pageStatusCode,
      error: fallbackResult.pageError,
      contentType: fallbackResult.contentType,
      // The fallback routes through an anti-bot browser backend, not the
      // premium stealth *proxy* product — label it "basic" so it is not
      // mistakenly billed as a stealth proxy scrape.
      proxyUsed: "basic",
    };
  }

  return {
    url: meta.rewrittenUrl ?? meta.url, // TODO: impove redirect following
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,
    proxyUsed: "basic",
  };
}

export function playwrightMaxReasonableTime(meta: Meta): number {
  return (meta.options.waitFor ?? 0) + 30000;
}
