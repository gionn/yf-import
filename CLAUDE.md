# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm test` — run all tests with Vitest
- `npm run test:watch` — run tests in watch mode
- `npm run test:coverage` — run tests with coverage
- `npm run dev` — start local dev server via wrangler
- `npm run deploy` — deploy to Cloudflare Workers
- `npm run generate-types` — regenerate worker-configuration.d.ts from wrangler.toml
- `npx biome check src/index.ts` — lint a single file (biome runs via pre-commit, no dedicated script)
- `pre-commit run --all-files` — run pre-commit hooks across all files
- `npm run generate-types && npm test` — regenerate types before tests if wrangler.toml changed

## Architecture

Single-file Cloudflare Worker (`src/index.ts`) behind the `yf-import` service name.

- **Route**: `GET /api/quotes/:symbol` — fetches a numeric price from Yahoo Finance public chart API and returns it as plain text (e.g. `150.25`)
- **Caching**: Uses Cloudflare's `caches.default` with a cache key derived from the URL path (query params stripped). Cache TTL configurable via `CACHE_TTL` env var (default 300s).
- **Symbol rewriting** (applied before fetching):
  - `BIT:SYMBOL` → probes `SYMBOL.MI`, redirects 301 if it exists
  - `SYMBOL.FR` → probes `SYMBOL.PA`, redirects 301 if it exists
  - If the rewritten symbol doesn't exist, falls through to normal fetch of original symbol
- **Root redirect**: `GET /` redirects to `ROOT_REDIRECT_URL` if configured (validated)
- **Env vars** (set in wrangler.toml [vars]): `CACHE_TTL`, `ROOT_REDIRECT_URL`

## Testing

- Uses `@cloudflare/vitest-pool-workers` for Cloudflare Workers runtime compatibility
- Yahoo Finance API calls are mocked via `vi.stubGlobal("fetch", vi.fn())` in unit tests
- One real integration test hits the live Yahoo Finance API (tagged `{ timeout: 10000 }`) — use `it.skip` when offline
- Tests create per-case `ExecutionContext` via `createExecutionContext()` and call `waitOnExecutionContext()` in afterEach
