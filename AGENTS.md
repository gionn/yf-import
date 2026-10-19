# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Commands

- `npm test` — run all tests with Vitest
- `npm run test:watch` — run tests in watch mode
- `npm run test:coverage` — run tests with coverage
- `npm run dev` — start local dev server via wrangler
- `npm run deploy` — deploy to Cloudflare Workers
- `npm run generate-types` — regenerate worker-configuration.d.ts from wrangler.toml
- `npx biome check src/` — lint the worker sources (biome runs via pre-commit, no dedicated script)
- `pre-commit run --all-files` — run pre-commit hooks across all files
- `npm run generate-types && npm test` — regenerate types before tests if wrangler.toml changed

## Architecture

Cloudflare Worker behind the `yf-import` service name. The route handler and shared helpers live in `src/index.ts`; the CORS layer is factored into `src/cors.ts`.

- **Route**: `GET /api/quotes/:symbol` — fetches a numeric price from Yahoo Finance public chart API and returns it as plain text (e.g. `150.25`)
- **Route**: `GET /api/details/:symbol` — returns one CSV row (26 columns: the original `symbol,description,currency,price,fiftyTwoWeekHigh,fiftyTwoWeekLow`, then quote fields and 52-week stats) or JSON via `?format=json` / `Accept: application/json`. `description` falls back `longName` → `shortName` → symbol; missing values are empty cells / `null`. CSV and JSON are cached under separate keys (format is part of the cache key).
- Both routes share `getYahooChart(symbol, fetchTimeoutMs, range, interval)` (returns `chart.result[0]` or `null` on 404; throws otherwise). `/api/quotes` requests `1d`/`1m` and reads `meta.regularMarketPrice`. `/api/details` requests `1y`/`1d`; `buildDetails` maps `meta` and `computeCandleStats(chart)` into the response.
- **Stats**: `src/stats.ts` holds the pure candle math (annualized volatility, 1-year return, max drawdown, 50/200-day SMAs and distances, 52-week extreme dates, average volume) plus date formatting. Returns, drawdown and volatility use `adjclose`; SMAs and distances use `close`. Volatility needs 60 valid closes. Today's partial bar is included.
- **Caching**: Uses Cloudflare's `caches.default` with a cache key derived from the URL path (query params stripped, except the `format` discriminator on `/api/details`). Cache TTL configurable via `CACHE_TTL` env var (default 300s).
- **Symbol rewriting** (applied to both routes before fetching):
  - `BIT:SYMBOL` → probes `SYMBOL.MI`, redirects 301 if it exists
  - `SYMBOL.FR` → probes `SYMBOL.PA`, redirects 301 if it exists
  - `/api/quotes` only redirects when the candidate has a current price;
    `/api/details` redirects on metadata alone (a missing price is still a valid
    details response)
  - If the rewritten symbol doesn't exist, falls through to normal fetch of original symbol
  - The redirect targets the same route family (`/api/quotes` or `/api/details`)
- **Root redirect**: `GET /` redirects to `ROOT_REDIRECT_URL` if configured (validated)
- **CORS**: Both routes echo a request's `Origin` in `Access-Control-Allow-Origin` only on an exact match with `ALLOWED_ORIGINS`, and always send `Vary: Origin` (merged with the details route's `Vary: Accept`). The list is never disclosed. Headers are applied per-request after cache lookup, keeping the cached body origin-agnostic; `OPTIONS` preflight returns 204 with the requested methods/headers. Shared via `resolveCors`/`corsPreflightResponse`/`withCors` in `src/cors.ts`; `corsGuarded` runs each route body and adds CORS to every outcome, including errors. `corsGuarded` takes an `errorResponse(message)` builder so each route emits failures in its own format.
- **Env vars** (set in wrangler.toml [vars]): `CACHE_TTL`, `ROOT_REDIRECT_URL`, `ALLOWED_ORIGINS`

## Testing

- Uses `@cloudflare/vitest-pool-workers` for Cloudflare Workers runtime compatibility
- Yahoo Finance API calls are mocked via `vi.stubGlobal("fetch", vi.fn())` in unit tests
- Live integration tests hit the Yahoo Finance API (tagged `{ timeout: 10000 }`) — use `it.skip` when offline
- Tests create per-case `ExecutionContext` via `createExecutionContext()` and call `waitOnExecutionContext()` in afterEach
- The Cache API is **not** reset between tests. Mocked unit tests therefore use throwaway symbols (e.g. `MOCK.MI`), and the live integration tests reserve real symbols (e.g. `VWCE.MI`) so a mocked cache entry can never satisfy a live assertion.
