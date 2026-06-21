Firecrawl is a web scraper API. The directory you have access to is a monorepo:
 - `apps/api` has the actual API and worker code
 - `apps/*-sdk` are various SDKs

When making changes to the API, here are the general steps you should take:
1. Write some end-to-end tests that assert your win conditions, if they don't already exist
  - 1 happy path (more is encouraged if there are multiple happy paths with significantly different code paths taken)
  - 1+ failure path(s)
  - Generally, E2E (called `snips` in the API) is always preferred over unit testing.
  - In the API, always use `scrapeTimeout` from `./lib` to set the timeout you use for scrapes.
  - These tests will be ran on a variety of configurations. You should gate tests in the following manner:
    - If it requires fire-engine: `!process.env.TEST_SUITE_SELF_HOSTED`
    - If it requires AI: `!process.env.TEST_SUITE_SELF_HOSTED || process.env.OPENAI_API_KEY || process.env.OLLAMA_BASE_URL`
2. Write code to achieve your win conditions
3. Run your tests using `pnpm harness jest ...`
  - `pnpm harness` is a command that gets the API server and workers up for you to run the tests. Don't try to `pnpm start` manually.
  - The full test suite takes a long time to run, so you should try to only execute the relevant tests locally, and let CI run the full test suite.
4. Push to a branch, open a PR, and let CI run to verify your win condition.
Keep these steps in mind while building your TODO list.

# Memory

## Project Overview

Firecrawl is a web scraping, crawling, and search API platform — "the web context API to find sources, extract content, and turn it into clean Markdown or structured data your agents can ship with." This is a **polyglot, loosely-coupled monorepo** with no unified build tool. Each sub-project manages itself independently.

Key directories:

| Directory | Purpose |
|---|---|
| `apps/api/` | **Core API + worker** — TypeScript/Node.js Express server. The heart of Firecrawl. |
| `apps/playwright-service-ts/` | Browser rendering microservice (Playwright-based JS rendering) |
| `apps/go-html-to-md-service/` | Go-based HTML→Markdown conversion microservice |
| `apps/nuq-postgres/` | PostgreSQL Docker image with `pg_cron` for the NUQ (Native Unified Queue) |
| `apps/*-sdk/` | SDKs in 9 languages: JS, Python, Rust, Go, Java, Elixir, Ruby, PHP, .NET |
| `apps/test-suite/` | E2E/integration tests (Artillery + snips) |
| `apps/test-site/` | Local test website for scraping tests |
| `apps/ui/` | Ingestion UI frontend |
| `apps/api/native/` | Rust native module (`@mendable/firecrawl-rs`) via napi-rs for HTML parsing, PDF extraction, etc. |
| `chaser-oxide/` | Rust — hardened undetectable browser automation (fork of `chromiumoxide`) with CDP-level stealth |
| `chromiumoxide/` | Rust — upstream async CDP library for Chrome/Chromium |
| `nodriver/` | Python — successor to Undetected-Chromedriver, async CDP browser automation |
| `obscura/` | Rust workspace — lightweight stealth headless browser engine (~30MB vs 200MB+ Chrome) |
| `stealth-browser-mcp/` | Python MCP server wrapping `nodriver` for AI agent browser control |
| `firecrawl-cli/` | CLI tools (git submodule to `firecrawl/cli`) |
| `firecrawl-skills/` | Agent skills for AI coding assistants |
| `firecrawl-workflows/` | Reusable Firecrawl-powered workflow skills |

**Primary language:** TypeScript/Node.js (pnpm). **Infrastructure:** Docker Compose (Redis, PostgreSQL+pg_cron, RabbitMQ, Playwright microservice, API+workers).

## Code Style Guidelines

- Use descriptive variable names
- Follow existing patterns in the codebase
- Extract complex conditions into meaningful boolean variables
- API controllers live in `apps/api/src/controllers/v{0,1,2}/` — match the version pattern
- Routes are defined in `apps/api/src/routes/v{0,1,2}.ts`
- Library utilities go in `apps/api/src/lib/`
- Worker processes go in `apps/api/src/services/worker/`
- Always use `scrapeTimeout` from `apps/api/src/lib/` for scrape timeouts in tests

## Architecture Notes

### No top-level monorepo tool
There is no root `package.json`, no `pnpm-workspace.yaml` at root, no `turbo.json`. The only pnpm workspace is inside `apps/api/` (which includes `native/`). All other SDKs and services are standalone.

### Multi-database architecture
- **Supabase (PostgreSQL)** — teams, API keys, credits, crawl jobs, configs. Accessed via `@supabase/supabase-js` (`src/services/supabase.ts`)
- **Redis** — caching, rate limiting, BullMQ queue backend. Accessed via `ioredis` (`src/services/redis.ts`)
- **PostgreSQL (NUQ)** — job persistence for scrape/crawl tasks with `pgcrypto` and `pg_cron`. Schema at `apps/nuq-postgres/nuq.sql`. Raw `pg` driver.
- **ClickHouse** — analytics and usage metrics (`src/lib/clickhouse-client.ts`)
- **Google Cloud Storage** — fire engine results, indexes, media
- **No ORM** — direct SQL, Supabase JS client, and raw ClickHouse inserts

### Hybrid queue system
- **BullMQ (Redis-backed):** Lighter, administrative jobs — LLMs.txt generation, deep research, billing, pre-crawl operations. Monitored via Bull Board at `/admin/:key/queues`.
- **NUQ (PostgreSQL + RabbitMQ):** Core scrape/crawl work. Table `nuq.queue_scrape` with job statuses, locks, and priorities. Workers: `nuq-worker.ts`, `nuq-prefetch-worker.ts`, `nuq-reconciler-worker.ts`. Uses `amqplib` for listen/notify.

### Dedicated worker processes
Separate processes launched alongside the API server: `extract-worker.ts`, `index-worker.ts`, `zdr-worker.ts`, `queue-worker.ts`, `webhook/queue.ts`, and NUQ workers. All started by `src/harness.ts`.

### Stealth browser pipeline
The `playwright-service` is the JS rendering backend. For anti-bot evasion, the ecosystem includes multiple layers: `chaser-oxide` (Rust CDP stealth), `nodriver` (Python async CDP), `stealth-browser-mcp` (MCP integration), and `obscura` (experimental lightweight Rust browser engine). Self-hosted instances do NOT have access to Fire-engine (advanced IP block/robot detection handling).

### API versioning
Three API versions: `v0` (legacy), `v1`, `v2`. Routes mounted in `src/index.ts`. Controllers per version in `src/controllers/v{0,1,2}/`.

### Authentication
DB authentication is optional (`USE_DB_AUTHENTICATION` env var). When enabled, uses Supabase for team/API key management. Auth middleware in `src/routes/shared.ts`.

## Common Workflows

### Running the API locally (development)
```bash
cd apps/api
pnpm install
pnpm dev              # Starts API server + all workers via harness.ts
```

### Running with Docker/Podman (self-hosted)
```bash
# Docker Compose (from repo root):
docker compose up

# Or Podman scripts (from repo root):
./start-firecrawl.sh   # Starts all 5 services
./stop-firecrawl.sh    # Stops everything
```

The stack brings up: `playwright-service`, `api` (with workers), `redis`, `rabbitmq`, `nuq-postgres` on the `firecrawl-net` bridge network.

### Running tests
```bash
cd apps/api
pnpm harness jest src/__tests__/snips/v1/<test-file>.test.ts  # Run specific E2E tests
pnpm test:snips                                                  # All snips tests
pnpm test:local-no-auth                                          # Tests not requiring auth
```

Always use `pnpm harness` (not `pnpm start`) — harness boots the API + workers for testing. Gate tests with:
- `!process.env.TEST_SUITE_SELF_HOSTED` for fire-engine-dependent tests
- `!process.env.TEST_SUITE_SELF_HOSTED || process.env.OPENAI_API_KEY || process.env.OLLAMA_BASE_URL` for AI-dependent tests

### Building the Rust native module
```bash
cd apps/api/native
cargo build --release
```

### Working on SDKs
Each SDK is standalone — no cross-dependencies on other SDKs or the API. Navigate to `apps/<sdk-name>/` and follow that SDK's own build/test instructions. The Go SDK uses git submodules; run `git submodule update --init --recursive` first.

### Adding a new API endpoint
1. Write E2E (snips) tests in `apps/api/src/__tests__/snips/v{1,2}/` — prefer E2E over unit tests
2. Add the controller in `apps/api/src/controllers/v{1,2}/`
3. Register the route in `apps/api/src/routes/v{1,2}.ts`
4. Run tests with `pnpm harness jest ...`
5. Push to a branch and let CI run the full suite

### Environment configuration
- Root `.env` for Docker/Podman deployment
- `apps/api/.env` for local development (copy from `apps/api/.env.example`)
- Key env vars: `REDIS_URL`, `NUQ_DATABASE_URL`, `NUQ_RABBITMQ_URL`, `PLAYWRIGHT_MICROSERVICE_URL`, `OPENAI_API_KEY`, `USE_DB_AUTHENTICATION`
