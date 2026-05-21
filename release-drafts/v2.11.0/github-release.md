# Firecrawl v2.11.0

## Improvements

- **Monitor JSON diffs** — Monitors that scrape with `{type: "json"}` or `{type: "changeTracking", modes: ["json"]}` now compute field-level JSON diffs against the previous run instead of diffing the rendered markdown. Each check persists a `snapshot.json` of current field values alongside the diff, available through `GET /v2/monitor/:id/checks/:checkId` and typed in the JS, Python, Java, .NET, Go, PHP, Ruby, and Rust SDKs.
- **Mixed-mode change tracking** — Monitors requesting both `["json", "git-diff"]` modes now run both diffs and report `changed` whenever either side changes, with the markdown unified diff attached as a sidecar on the JSON artifact. Previously this combination silently returned `same` when only one side moved.
- **X/Twitter scrape billing** — Updated X/Twitter scrapes to 29 credits per request (up from 9) to reflect the cost of the underlying provider.

## Fixes

- Resolved CVEs across the API and JS SDK by bumping `ws` to `8.20.1` (GHSA-58qx-3vcg-4xpx) and the `brace-expansion` override to `5.0.6` (GHSA-jxxr-4gwj-5jf2), applied across `apps/api`, `apps/js-sdk`, `apps/test-suite`, and `apps/ui/ingestion-ui`.
- Fixed `cancel` on `/v1` and `/v2` crawls and batches not draining the per-team concurrency-limit backlog — queued job IDs are now removed via a chunked Redis pipeline and `status` reports `cancelled` immediately, even while the worker group is still draining.
- Fixed sync `Firecrawl.search()` in the Python SDK raising `TypeError: ... unexpected keyword argument 'include_domains'` when callers passed `include_domains` or `exclude_domains` — the sync signature now matches the async client and the wire payload.
- Fixed JSON-mode monitor diffs returning spurious `changed` verdicts when the underlying scrape returned identical field values in a different order — diffs now use deep, order-insensitive equality.
- Fixed JSON-mode monitors treating an empty-string markdown scrape as missing input — pages that legitimately render no text now report `same` on subsequent runs instead of staying perpetually `changed`.
- Hardened monitor check responses against corrupt or unexpected artifact payloads in GCS — bad data now surfaces as no diff instead of breaking `GET /v2/monitor/:id/checks/:checkId`.

## API

- Added a structured `diff` object (`text` and/or `json`) and a `snapshot` field to `MonitorCheckPage` on `GET /v2/monitor/:id/checks/:checkId`. JSON-mode checks return field-level diffs plus a current-value snapshot; markdown-mode checks continue to return a text diff. Typed in the JS, Python, Java, .NET, Go, PHP, Ruby, and Rust SDKs.
- Normalized monitor `scrapeOptions.formats` so `{type: "changeTracking", modes: ["json"]}` is rewritten to `{type: "json"}` before scraping, and the mixed-mode `["json", "git-diff"]` form now runs both diffs instead of silently falling back to one.
- Added `include_domains` and `exclude_domains` keyword arguments to the Python SDK's sync `Firecrawl.search()` to bring it in line with `AsyncFirecrawl.search()` and the `/v2/search` wire payload.
- Changed X/Twitter scrape billing from 9 to 29 credits per scrape.

---

**Full Changelog**: https://github.com/firecrawl/firecrawl/compare/v2.10...v2.11.0
