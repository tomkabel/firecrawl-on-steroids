import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../../../../config";
import { scrapeOptions as v1ScrapeOptions } from "../../../../../controllers/v1/types";
import { scrapeOptions as v2ScrapeOptions } from "../../../../../controllers/v2/types";
import { scrapePDFWithFirePDFAsync } from "../firePDFAsync";

function createTestMeta(overrides: Record<string, unknown> = {}) {
  const abortController = new AbortController();
  const logger: any = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => logger),
  };

  return {
    id: "scrape-test-1",
    url: "https://example.com/file.pdf",
    rewrittenUrl: undefined,
    options: {
      __experimental_firePdfAsync: true,
      skipTlsVerification: false,
      parsers: [{ type: "pdf", mode: "ocr", maxPages: 5 }],
    },
    internalOptions: {
      teamId: "team-test",
      crawlId: "crawl-test",
      zeroDataRetention: false,
    },
    logger,
    abort: {
      throwIfAborted: jest.fn(() => {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason ?? new Error("aborted");
        }
      }),
      scrapeTimeout: jest.fn(() => 120000),
      asSignal: jest.fn(() => abortController.signal),
      isAborted: jest.fn(() => abortController.signal.aborted),
    },
    mock: null,
    ...overrides,
  } as any;
}

function createFetchMock(responses: Array<{ status: number; body?: unknown }>) {
  return jest.fn(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch call");
    }

    return {
      status: response.status,
      text: async () =>
        response.body === undefined ? "" : JSON.stringify(response.body),
    };
  });
}

describe("__experimental_firePdfAsync option plumbing", () => {
  it("defaults false in v2 scrape options and accepts true", () => {
    expect(v2ScrapeOptions.parse({}).__experimental_firePdfAsync).toBe(false);
    expect(
      v2ScrapeOptions.parse({ __experimental_firePdfAsync: true })
        .__experimental_firePdfAsync,
    ).toBe(true);
  });

  it("defaults false in v1 scrape options and accepts true", () => {
    expect(v1ScrapeOptions.parse({}).__experimental_firePdfAsync).toBe(false);
    expect(
      v1ScrapeOptions.parse({ __experimental_firePdfAsync: true })
        .__experimental_firePdfAsync,
    ).toBe(true);
  });
});

describe("scrapePDFWithFirePDFAsync", () => {
  it("submits a job, polls to done, and fetches the result", async () => {
    const fetchMock = createFetchMock([
      {
        status: 202,
        body: {
          scrape_id: "scrape-test-1",
          status: "queued",
          retry_after_ms: 1,
          lane: "fast",
        },
      },
      {
        status: 202,
        body: {
          scrape_id: "scrape-test-1",
          status: "running",
          retry_after_ms: 1,
        },
      },
      {
        status: 200,
        body: {
          scrape_id: "scrape-test-1",
          status: "done",
          pages_processed: 7,
          failed_pages: null,
          partial_pages: null,
        },
      },
      {
        status: 200,
        body: {
          schema_version: 1,
          markdown: "# Async PDF",
          pages_processed: 7,
          failed_pages: null,
          partial_pages: null,
        },
      },
    ]);
    const fallbackToSync = jest.fn();
    const sleep = jest.fn(async () => undefined);
    const meta = createTestMeta();
    const originalBaseUrl = config.FIRE_PDF_BASE_URL;
    config.FIRE_PDF_BASE_URL = "https://fire-pdf.test";

    try {
      const result = await scrapePDFWithFirePDFAsync(
        meta,
        "JVBERi0xLjQK",
        5,
        7,
        "ocr",
        fallbackToSync as any,
        {
          fetch: fetchMock as any,
          sleep,
          now: () => 1000,
        },
      );

      expect(result.markdown).toBe("# Async PDF");
      expect(result.html).toContain("Async PDF");
      expect(result.pagesProcessed).toBe(7);
      expect(fallbackToSync).not.toHaveBeenCalled();
      expect(sleep).toHaveBeenCalledWith(1, expect.any(AbortSignal));
      const fetchCalls = fetchMock.mock.calls as unknown as Array<
        [string, { body: string }]
      >;
      expect(fetchCalls.map(call => call[0])).toEqual([
        "https://fire-pdf.test/jobs",
        "https://fire-pdf.test/jobs/scrape-test-1",
        "https://fire-pdf.test/jobs/scrape-test-1",
        "https://fire-pdf.test/jobs/scrape-test-1/result",
      ]);

      const submitBody = JSON.parse(fetchCalls[0][1].body);
      expect(submitBody).toMatchObject({
        pdf_b64: "JVBERi0xLjQK",
        scrape_id: "scrape-test-1",
        source: "firecrawl",
        zdr: false,
        team_id: "team-test",
        crawl_id: "crawl-test",
        options: {
          pages_estimate: 7,
          max_pages: 5,
          mode: "ocr",
          url: "https://example.com/file.pdf",
        },
      });
      expect(new Date(submitBody.deadline_at).toString()).not.toBe(
        "Invalid Date",
      );
    } finally {
      config.FIRE_PDF_BASE_URL = originalBaseUrl;
    }
  });

  it("falls back to sync OCR when POST /jobs returns 503", async () => {
    const fetchMock = createFetchMock([
      {
        status: 503,
        body: { error: "capacity" },
      },
    ]);
    const fallbackToSync = jest.fn(async () => ({
      markdown: "sync markdown",
      html: "sync html",
      pagesProcessed: 3,
    }));
    const meta = createTestMeta();
    const originalBaseUrl = config.FIRE_PDF_BASE_URL;
    config.FIRE_PDF_BASE_URL = "https://fire-pdf.test";

    try {
      const result = await scrapePDFWithFirePDFAsync(
        meta,
        "JVBERi0xLjQK",
        5,
        7,
        "ocr",
        fallbackToSync,
        {
          fetch: fetchMock as any,
          sleep: jest.fn(async () => undefined),
          now: () => 1000,
        },
      );

      expect(result.markdown).toBe("sync markdown");
      expect(fallbackToSync).toHaveBeenCalledTimes(1);
      expect(meta.logger.warn).toHaveBeenCalledWith(
        "FirePDF async falling back to sync /ocr",
        expect.objectContaining({
          scrapeId: "scrape-test-1",
          reason: "http_503",
        }),
      );
    } finally {
      config.FIRE_PDF_BASE_URL = originalBaseUrl;
    }
  });
});

const runFirePdfAsyncStagingTest =
  process.env.FIRE_PDF_ASYNC_STAGING_BASE_URL !== undefined ? it : it.skip;

runFirePdfAsyncStagingTest(
  "exercises the flag=true happy path against a real fire-pdf staging instance",
  async () => {
    const originalBaseUrl = config.FIRE_PDF_BASE_URL;
    config.FIRE_PDF_BASE_URL = process.env.FIRE_PDF_ASYNC_STAGING_BASE_URL;
    const pdfB64 =
      process.env.FIRE_PDF_ASYNC_STAGING_PDF_B64 ??
      (
        await readFile(
          path.resolve(process.cwd(), "../test-site/public/example.pdf"),
        )
      ).toString("base64");
    const meta = createTestMeta({
      id: crypto.randomUUID(),
      options: {
        __experimental_firePdfAsync: true,
        skipTlsVerification: false,
        parsers: [{ type: "pdf", mode: "ocr", maxPages: 1 }],
      },
      internalOptions: {
        teamId: process.env.FIRE_PDF_ASYNC_STAGING_TEAM_ID ?? "staging-test",
        zeroDataRetention: false,
      },
    });

    try {
      const result = await scrapePDFWithFirePDFAsync(
        meta,
        pdfB64,
        1,
        1,
        "ocr",
        async () => {
          throw new Error("staging async test unexpectedly fell back to /ocr");
        },
      );

      expect(result.markdown?.length).toBeGreaterThan(0);
      expect(result.pagesProcessed).toBeGreaterThan(0);
    } finally {
      config.FIRE_PDF_BASE_URL = originalBaseUrl;
    }
  },
  180000,
);
