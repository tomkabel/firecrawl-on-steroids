---

## 1. Self-Hosted Instance at `http://localhost:3002`

From `SELF_HOST.md` and the source code, the self-hosted Firecrawl API exposes these endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v2/scrape` | Scrape a single URL |
| `GET` | `/v2/scrape/:jobId` | Check scrape status |
| `POST` | `/v2/crawl` | Crawl an entire site |
| `GET` | `/v2/crawl/:jobId` | Check crawl status & get results |
| `DELETE` | `/v2/crawl/:jobId` | Cancel a crawl |
| `POST` | `/v2/map` | Discover all URLs on a site |
| `POST` | `/v2/search` | Web search |
| `POST` | `/v2/agent` | AI agent for autonomous data gathering |
| `POST` | `/v2/batch/scrape` | Scrape multiple URLs |

Default port is **3002**. No API key is required when hitting `localhost:3002` — the self-hosted check in `authMiddleware` auto-bypasses auth for non-cloud URLs.

---

## 2. The Official CLI: `firecrawl-cli`

Install:

```bash
npm install -g firecrawl-cli
```

### Point it at your self-hosted instance:

```bash
# Per-command (no API key needed for localhost)
firecrawl --api-url http://localhost:3002 scrape https://example.com

# Or persist via env
export FIRECRAWL_API_URL=http://localhost:3002
firecrawl scrape https://example.com

# Or persist via config
firecrawl config --api-url http://localhost:3002
```

> When `--api-url` is anything other than `https://api.firecrawl.dev`, authentication is **automatically skipped**.

---

## 3. Your Goal: Fully Scrape a URL + Domain-Constrained Links into `./output/`

### Approach A: Use `crawl` (recommended — domain-constrained by default)

```bash
export FIRECRAWL_API_URL=http://localhost:3002

firecrawl crawl https://example.com --wait --progress -o output/crawl-results.json
```

This:
- Starts from the seed URL
- Only follows same-domain links (`allowExternalLinks` defaults to `false`)
- Returns markdown for each page
- Saves the full JSON array to `output/crawl-results.json`

**To save each page as a separate `.md` file** — pipe through `jq`:

```bash
firecrawl crawl https://example.com --wait --pretty -o output/crawl-results.json

# Extract each page's markdown to individual files
mkdir -p output
cat output/crawl-results.json | jq -r '.data[] | "\(.metadata.sourceURL)\t\(.markdown)"' | while IFS=$'\t' read -r url md; do
  filename=$(echo "$url" | sed 's|https\?://||; s|/$||; s|/|_|g').md
  echo "$md" > "output/$filename"
  echo "Saved: output/$filename"
done
```

**Crawl with specific options:**

```bash
firecrawl crawl https://docs.example.com \
  --limit 100 \
  --max-depth 3 \
  --include-paths /docs,/guides \
  --exclude-paths /admin,/api \
  --delay 500 \
  --max-concurrency 3 \
  --wait --progress \
  -o output/crawl.json
```

### Approach B: Use experimental `firecrawl x download` (map + scrape combo)

The CLI has a built-in bulk download command that maps the site then scrapes each discovered URL:

```bash
export FIRECRAWL_API_URL=http://localhost:3002

firecrawl x download https://docs.firecrawl.dev
firecrawl x download https://docs.firecrawl.dev --screenshot --limit 20 -y
firecrawl x download https://docs.firecrawl.dev --include-paths "/features,/sdks" -y
```

This saves results under `.firecrawl/` directory automatically.

### Approach C: Two-step `map` + `scrape` (most control over output directory)

```bash
export FIRECRAWL_API_URL=http://localhost:3002

# Step 1: Discover all URLs
firecrawl map https://example.com --json -o output/urls.json

# Step 2: Scrape each URL concurrently (piped into a loop)
cat output/urls.json | jq -r '.links[].url' | while read -r url; do
  filename=$(echo "$url" | sed 's|https\?://||; s|/$||; s|[/?&=]|_|g').md
  firecrawl "$url" --only-main-content > "output/$filename"
  echo "Saved: output/$filename"
done
```

### Approach D: Raw `curl` against the API (no CLI needed)

```bash
# Step 1: Start the crawl
JOB_ID=$(curl -s -X POST http://localhost:3002/v2/crawl \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com",
    "limit": 100,
    "scrapeOptions": {
      "formats": ["markdown"],
      "onlyMainContent": true
    }
  }' | jq -r '.id')

echo "Crawl job: $JOB_ID"

# Step 2: Poll until complete
while true; do
  STATUS=$(curl -s http://localhost:3002/v2/crawl/$JOB_ID | jq -r '.status')
  echo "Status: $STATUS"
  [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] && break
  sleep 5
done

# Step 3: Save results
curl -s http://localhost:3002/v2/crawl/$JOB_ID | jq '.' > output/results.json

# Step 4: Extract individual markdown files
mkdir -p output
cat output/results.json | jq -c '.data[]' | while read -r doc; do
  url=$(echo "$doc" | jq -r '.metadata.sourceURL')
  md=$(echo "$doc" | jq -r '.markdown // empty')
  [ -n "$md" ] && echo "$md" > "output/$(echo "$url" | md5sum | cut -d' ' -f1).md"
done
```

---

## 4. Bonus: Unix Pipe Patterns

The CLI writes **markdown to stdout by default** — ideal for pipelining.

### With `jq` (extract links/fields from JSON output)

```bash
# Extract all links from a page
firecrawl https://example.com --format links | jq '.links[].url'

# Extract page title + URL from crawl results
cat output/crawl.json | jq -r '.data[] | "\(.metadata.title): \(.metadata.sourceURL)"'
```

### With `grep` / `rg` (search within scraped content)

```bash
firecrawl --api-url http://localhost:3002 https://example.com | grep -i "api key"
```

### With `pandoc` (markdown → PDF)

```bash
firecrawl --api-url http://localhost:3002 https://example.com | pandoc -o output/document.pdf
```

### With `ffuf` / `katana` / `unfurl` — use `map` first, pipe into scraping

**Firecrawl + katana + firecrawl (discovery chain):**

```bash
# Discover URLs with firecrawl map, then pass to katana for URL normalization
firecrawl --api-url http://localhost:3002 map https://example.com --json \
  | jq -r '.links[].url' \
  | katana -silent -f url \
  | xargs -P 4 -I{} firecrawl --api-url http://localhost:3002 {} --only-main-content -o "output/\$(echo {} | unfurl format %p-%f).md"
```

**Firecrawl + unfurl (extract domains/paths from results):**

```bash
# Extract unique domains from a crawl
cat output/crawl.json | jq -r '.data[].metadata.sourceURL' | unfurl domains | sort -u

# Extract all paths
cat output/crawl.json | jq -r '.data[].metadata.sourceURL' | unfurl paths | sort -u
```

**Firecrawl + ffuf (brute-force + scrape):**

```bash
# Discover hidden paths with ffuf, then scrape each found path
ffuf -u https://example.com/FUZZ -w wordlist.txt -o output/ffuf.json
cat output/ffuf.json | jq -r '.results[].url' \
  | xargs -P 8 -I{} firecrawl --api-url http://localhost:3002 {} -o "output/\$(echo {} | unfurl format %p).md"
```

---

## Summary Cheatsheet

```bash
# === CONFIGURATION ===
export FIRECRAWL_API_URL=http://localhost:3002

# === SINGLE PAGE ===
firecrawl https://example.com --only-main-content -o output/page.md
firecrawl https://example.com --format markdown,links -o output/data.json

# === FULL SITE CRAWL (domain-constrained by default) ===
firecrawl crawl https://example.com --limit 200 --wait --progress -o output/crawl.json

# === EXPERIMENTAL BULK DOWNLOAD ===
firecrawl x download https://example.com --include-paths "/docs" -y

# === MAP + SCRAPE PIPELINE ===
firecrawl map https://example.com --json \
  | jq -r '.links[].url' \
  | xargs -P 4 -I{} sh -c 'firecrawl "$1" --only-main-content > "output/$(echo "$1" | md5sum | cut -d" " -f1).md"' -- {}

# === PIPE PATTERNS ===
firecrawl https://example.com | grep -i "keyword"
firecrawl https://example.com | pandoc -o output/doc.pdf
firecrawl https://example.com --format links | jq '.links[].url'
cat output/crawl.json | jq -r '.data[].metadata.sourceURL' | unfurl domains | sort -u
```
