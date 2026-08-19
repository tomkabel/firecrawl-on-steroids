import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig: { CRAWL4AI_URL?: string } = {
  CRAWL4AI_URL: "http://localhost:9999",
};

vi.mock("../config", () => ({ config: mockConfig }));
vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));
vi.mock("../services/sentry", () => ({}));

import * as Sentry from "@sentry/node";
import { convertHTMLToMarkdownWithCrawl4AI } from "../crawl4ai-converter";

beforeEach(() => {
  vi.unstubAllGlobals();
  mockConfig.CRAWL4AI_URL = "http://localhost:9999";
  vi.clearAllMocks();
});

describe("convertHTMLToMarkdownWithCrawl4AI", () => {
  it("returns null when CRAWL4AI_URL is not configured", async () => {
    mockConfig.CRAWL4AI_URL = undefined;
    await expect(
      convertHTMLToMarkdownWithCrawl4AI("<html></html>"),
    ).resolves.toBeNull();
  });

  it("POSTs the raw html and returns the extracted markdown on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: any) => {
        expect(url).toBe("http://localhost:9999/md");
        expect(opts.method).toBe("POST");
        const body = JSON.parse(opts.body);
        expect(body.url).toMatch(/^raw:/);
        expect(body.f).toBe("raw");
        expect(body.c).toBe("0");
        return new Response(JSON.stringify({ success: true, markdown: "# md" }), {
          status: 200,
        });
      }),
    );

    await expect(
      convertHTMLToMarkdownWithCrawl4AI("<html></html>"),
    ).resolves.toBe("# md");
  });

  it("returns null when the response is missing the markdown field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true }), { status: 200 }),
      ),
    );

    await expect(
      convertHTMLToMarkdownWithCrawl4AI("<html></html>"),
    ).resolves.toBeNull();
  });

  it("returns null and does not throw on a non-OK status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    await expect(
      convertHTMLToMarkdownWithCrawl4AI("<html></html>"),
    ).resolves.toBeNull();
  });

  it("returns null and reports to Sentry when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );

    await expect(
      convertHTMLToMarkdownWithCrawl4AI("<html></html>"),
    ).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });
});
