# Yahoo Finance Import API

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A Cloudflare Worker that fetches real-time stock quotes from Yahoo Finance
public charts API and returns them in plain text format, perfect for importing
into Google Sheets.

**For Google Sheets**: Use the `IMPORTDATA` function to easily pull any asset
price available on Yahoo Finance. This is especially useful for European
securities that Google Finance (via `GOOGLEFINANCE` function) stopped serving.

```text
=IMPORTDATA("https://yf-import.gionn.net/api/quotes/VUAA.MI")
=IMPORTDATA("https://yf-import.gionn.net/api/quotes/VWCE.DE")
=IMPORTDATA("https://yf-import.gionn.net/api/quotes/AAPL")
```

Swap `/api/quotes` for `/api/details` to pull the name, currency, price,
52-week range and more as separate columns:

```text
=IMPORTDATA("https://yf-import.gionn.net/api/details/VWCE.MI")
```

You can easily find a symbol by looking at the Yahoo Finance URL when
viewing an asset page.

## Features

- ⚡ Fast edge-deployed API using Cloudflare Workers
- 📝 Plain text response — ideal for `IMPORTDATA()` in Google Sheets
- 📈 Real-time stock prices from Yahoo Finance
- 🔁 Automatic symbol rewriting for certain exchange prefixes (e.g., `BIT:VWCE`
  → `VWCE.MI`)
- 📋 Asset details endpoint (description, currency, price, quote fields and
  52-week stats) as CSV or JSON
- 🔎 Symbol search endpoint for autocomplete, returning ticker, market suffix
  and exchange as CSV or JSON
- 🌐 Global availability with low latency
- 💰 Cloudflare Free tier: 100,000 requests/day (global)
- 🔒 No API key required
- 🗄️ Edge caching
- 🌍 Works with international stock symbols (US, European, Asian markets)

## Deployment to Cloudflare Workers

You can deploy your own fork of this project on GitHub to your Cloudflare
account for better control.

### Prerequisites

- GitHub account (free account)
- Cloudflare account (free tier available)

### Cloudflare Workers Free Tier Limits

- 100,000 requests per day
- 10ms CPU time per invocation (external API wait time is free)
- No duration charges

Perfect for personal projects and medium-traffic applications.

### Option 1: Deploy from GitHub (Recommended)

1. **Fork the repository on GitHub:**
   - Go to the [repository page](https://github.com/gionn/yf-import)
   - Click the **Fork** button in the top right corner
   - Select your account as the destination

2. **Connect to Cloudflare:**
   - Go to [dash.cloudflare.com](https://dash.cloudflare.com)
   - Navigate to **Workers & Pages** from the left sidebar
   - Click **Create Application**

3. **Connect your GitHub repository:**
   - Click **Connect GitHub** and authorize Cloudflare
   - Select your forked repository (`yf-import`)
   - Click **Begin setup**

4. **Configure the build:**
   - **Project name:** `yf-import` (or your preferred name)
   - Click **Deploy**

5. **Configure environment variables (optional):**
   - After deployment, go to **Settings** > **Environment variables**
   - Add `CACHE_TTL` with your desired value (e.g., `300` for 5 minutes)
   - Click **Save**

Your worker will be available at: `https://yf-import.<account-id>.workers.dev`

Every push to your GitHub repository will automatically trigger a new deployment.

### Option 2: Deploy via Wrangler CLI

For developers who prefer the command line:

```bash
# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Deploy to your Cloudflare account
npm run deploy
```

## Development

### Installation

```bash
npm install
```

### Pre-commit hooks

This project uses [pre-commit](https://pre-commit.com/) to automatically check
code quality before commits. It's highly recommended to enable it to catch
issues early and maintain code consistency.

**Install pre-commit:**

```bash
pip install pre-commit
```

**Enable hooks for this repository:**

```bash
pre-commit install
```

The hooks will now run automatically on every commit, checking:

- YAML, JSON, and TOML syntax
- Code formatting and linting with Biome
- Trailing whitespace and end-of-file fixes

**Run hooks manually (optional):**

```bash
# Check all files
pre-commit run --all-files

# Check staged files only
pre-commit run
```

### Running Locally

```bash
npm run dev
```

The API will be available at `http://localhost:8787`

## Usage

### Get a Stock Quote

```bash
curl http://localhost:8787/api/quotes/AAPL
# Returns: 189.25

curl http://localhost:8787/api/quotes/VWCE.MI
# Returns: 112.34
```

The API endpoint format is: `/api/quotes/{SYMBOL}`

Supports any valid Yahoo Finance stock symbol (AAPL, GOOGL, MSFT, VWCE.MI, etc.)

The API also understands certain exchange-prefixed symbols. For example,
`BIT:VWCE` will be rewritten to `VWCE.MI` and, if that symbol exists on Yahoo
Finance, the worker responds with a 301 redirect to `/api/quotes/VWCE.MI`. This
allows users to use symbols from Google Finance while still getting the quotes
from Yahoo Finance.

### Get Asset Details by Symbol

```bash
curl http://localhost:8787/api/details/VWCE.MI
# Returns: VWCE.MI,Vanguard FTSE All-World UCITS ETF USD Accumulation,EUR,170.78,173.98,139.19,0.199,170.88,170,30725,ETF,MIL,Europe/Rome,2026-10-19T15:35:11.000Z,2020-01-14,140.32,11.3,19.71,-6.53,168.7798,1.19,158.6474,7.65,2026-10-07,2025-11-21,43990
```

The endpoint format is `/api/details/{SYMBOL}` and returns a single CSV row with
these columns, in order. The first six keep their positions, so existing
`IMPORTDATA()` sheets keep working.

| # | Column | Description |
| - | ------ | ----------- |
| 1 | `symbol` | Yahoo Finance symbol (e.g. `VWCE.MI`) |
| 2 | `description` | Instrument name (`longName`, falling back to `shortName`, then the requested symbol) |
| 3 | `currency` | Quote currency (e.g. `EUR`) |
| 4 | `price` | Current market price |
| 5 | `fiftyTwoWeekHigh` | 52-week high |
| 6 | `fiftyTwoWeekLow` | 52-week low |
| 7 | `changePercent` | Today's change in percent points (`0.199` means +0.199%) |
| 8 | `dayHigh` | Today's high |
| 9 | `dayLow` | Today's low |
| 10 | `volume` | Today's volume |
| 11 | `instrumentType` | Instrument type (e.g. `ETF`) |
| 12 | `exchangeName` | Exchange code (e.g. `MIL`) |
| 13 | `exchangeTimezone` | Exchange timezone used by the date columns |
| 14 | `marketTime` | Last market time, ISO 8601 UTC |
| 15 | `firstTradeDate` | First trade date, `YYYY-MM-DD` in the exchange timezone |
| 16 | `chartPreviousClose` | Yahoo's close just before the 1-year window, not yesterday's close |
| 17 | `volatility` | Annualized volatility from the last year of daily adjusted closes |
| 18 | `return1y` | Return over the available year of daily adjusted closes |
| 19 | `maxDrawdown` | Largest peak-to-trough fall over the year |
| 20 | `sma50` | Mean of the last 50 daily closes |
| 21 | `distanceFromSma50` | Current price against the 50-day SMA, in percent points |
| 22 | `sma200` | Mean of the last 200 daily closes |
| 23 | `distanceFromSma200` | Current price against the 200-day SMA, in percent points |
| 24 | `fiftyTwoWeekHighDate` | Date of the highest daily high, in the exchange timezone |
| 25 | `fiftyTwoWeekLowDate` | Date of the lowest daily low, in the exchange timezone |
| 26 | `averageVolume` | Mean daily volume over the year |

Missing values are returned as empty CSV cells and JSON `null`.

The stats come from the same yearly daily-candle request that supplies the meta
fields, with no extra upstream call. Returns, drawdown and volatility use
adjusted closes, so distributing funds do not show a false drop on the ex-date.
SMAs and their distances use raw closes, which compare directly with `price`.
Volatility needs at least 60 closes; shorter histories return `null`. The SMAs
return `null` until 50 or 200 closes are available. Today's partial session is
included, so intraday figures move until the close.

This is convenient with `IMPORTDATA()`, which parses the row into separate
columns:

```text
=IMPORTDATA("https://yf-import.gionn.net/api/details/VWCE.MI")
```

For programmatic use, request JSON either with the `format=json` query param or
by sending an `Accept: application/json` header:

```bash
curl "http://localhost:8787/api/details/VWCE.MI?format=json"
# Returns: {"symbol":"VWCE.MI","description":"Vanguard FTSE All-World UCITS ETF USD Accumulation","currency":"EUR","price":170.78,"fiftyTwoWeekHigh":173.98,"fiftyTwoWeekLow":139.19,"changePercent":0.199,"dayHigh":170.88,"dayLow":170,"volume":30725,"instrumentType":"ETF","exchangeName":"MIL","exchangeTimezone":"Europe/Rome","marketTime":"2026-10-19T15:35:11.000Z","firstTradeDate":"2020-01-14","chartPreviousClose":140.32,"volatility":11.3,"return1y":19.71,"maxDrawdown":-6.53,"sma50":168.7798,"distanceFromSma50":1.19,"sma200":158.6474,"distanceFromSma200":7.65,"fiftyTwoWeekHighDate":"2026-10-07","fiftyTwoWeekLowDate":"2025-11-21","averageVolume":43990}
```

Use `changePercent` for today's move. `chartPreviousClose` is the close from a
year ago under this range, so it is not a substitute for yesterday's close.

Symbol rewriting applies here too (`BIT:VWCE` → `/api/details/VWCE.MI`), and the
same edge caching as `/api/quotes` is used.

### Search for Symbols

```bash
curl "http://localhost:8787/api/search?q=vwce"
# Returns:
# symbol,ticker,market,description,quoteType,exchange,exchangeDisplay
# VWCE.DE,VWCE,.DE,Vanguard FTSE All-World UCITS ETF USD Accumulation,ETF,GER,XETRA
```

`/api/search` is the same lookup Yahoo Finance runs in its own search bar. It
takes a `q` query string and an optional `count` (default 10, clamped to 20),
and returns no news, lists or fuzzy matches. The response is CSV with a header
row and one row per result, so `IMPORTDATA()` parses it into a table:

```text
=IMPORTDATA("https://yf-import.gionn.net/api/search?q=vwce")
```

Yahoo truncates the quotes array at 7 per query, so a larger `count` changes
nothing today.

| Column | Description |
| ------ | ----------- |
| `symbol` | Yahoo Finance symbol (e.g. `VWCE.MI`) |
| `ticker` | Symbol without the market suffix (e.g. `VWCE`) |
| `market` | Market suffix including the dot (e.g. `.MI`), empty for US listings |
| `description` | Name (`longName`, falling back to `shortName`) |
| `quoteType` | Instrument type (e.g. `ETF`, `EQUITY`) |
| `exchange` | Exchange code (e.g. `MIL`) |
| `exchangeDisplay` | Exchange name (e.g. `Milan`) |

For programmatic use, request JSON either with the `format=json` query param or
by sending an `Accept: application/json` header:

```bash
curl "http://localhost:8787/api/search?q=vwce&format=json"
# Returns: {"query":"vwce","results":[{"symbol":"VWCE.DE","ticker":"VWCE","market":".DE","description":"Vanguard FTSE All-World UCITS ETF USD Accumulation","quoteType":"ETF","exchange":"GER","exchangeDisplay":"XETRA"}]}
```

Results keep Yahoo's ranking. Non-Yahoo hits (ISIN/CUSIP lookups) are dropped,
and one symbol appears once. Missing `q`, a blank query or one longer than 64
characters is a `400`; an upstream failure is a `500`. Errors follow the
requested format, so CSV mode gets plain text and JSON mode gets
`{"error": "..."}`. Casing and repeated spaces are ignored for caching, so
`VWCE` and `vwce` share one entry, and CSV and JSON are cached separately.

Cross-listed funds come back once per listing, so the caller usually wants to
sort or filter by `market`/`exchange`. A result carries no currency or price;
fetch `/api/details/{symbol}` for those.

## Project Structure

- `src/index.ts` - Main worker code with Yahoo Finance API integration
- `src/cors.ts` - CORS allowlist and per-request response wrapping
- `src/stats.ts` - Candle math for the details stats
- `src/index.test.ts` - Automated tests for the worker
- `src/stats.test.ts` - Unit tests for the candle math
- `wrangler.toml` - Cloudflare Workers configuration
- `package.json` - Dependencies and scripts
- `tsconfig.json` - TypeScript configuration

## Configuration

### Cache TTL

Configure cache duration in [wrangler.toml](wrangler.toml):

```toml
[vars]
CACHE_TTL = "300"  # Cache for 5 minutes (300 seconds)
FETCH_TIMEOUT_MS = "5000"  # Timeout for Yahoo Finance fetch in ms (default 5000)
```

Responses are cached at Cloudflare's edge using `Cache-Control` headers. This
means:

- Same quote requests within the TTL window are served instantly from cache
- No API calls to Yahoo Finance during cache hits
- Reduces load and improves response times

### Root redirect

Configure root URL redirect in [wrangler.toml](wrangler.toml):

```toml
[vars]
ROOT_REDIRECT_URL = "https://your-redirect-url.com"
```

When a user visits the root URL of the worker (e.g.,
`https://yf-import.<account-id>.workers.dev/`), they will be automatically
redirected to the specified URL. This is useful for directing users to
documentation, a homepage, or any relevant resource.

### Allowed origins (CORS)

Set the websites allowed to read responses from the browser as a comma-separated
list of exact origins in `[vars]` (empty disables CORS):

```toml
[vars]
ALLOWED_ORIGINS = "https://app.example.com,https://sheets.example.org"
```

A request's `Origin` is echoed in `Access-Control-Allow-Origin` only on an exact
match; other origins still get the data but no header, so the browser blocks it.
`Vary: Origin` is always sent so caches stay correct, and `OPTIONS` preflights
from allowed origins return `204` with the requested methods and headers. This
applies to every route (`/api/quotes`, `/api/details`, `/api/search`); the
details response varies on both `Accept` and `Origin`.

The list is never disclosed — only the caller's own origin is echoed back.

> **Note:** CORS only controls which browser pages can *read* a response, not who
> can call the API. `curl`, server scripts, and Google Sheets `IMPORTDATA` send no
> `Origin`, so they are unaffected.

## How It Works

The worker makes requests to Yahoo Finance's public quote API and returns the `regularMarketPrice` field. It uses Cloudflare's edge runtime with the standard `fetch` API, making it fast and efficient.

## Disclaimer

This project is **not affiliated with, endorsed by, or in any way officially connected with Yahoo, Yahoo Finance, or any of their subsidiaries or affiliates**. The official Yahoo Finance website can be found at [finance.yahoo.com](https://finance.yahoo.com).

This tool is provided for educational and personal use only. Users are responsible for ensuring their use complies with Yahoo Finance's Terms of Service and any applicable rate limits or usage restrictions. Use at your own risk.

## Built with OpenCode

This project is developed using [OpenCode](https://opencode.ai) with the
**DeepSeek V4.1 Flash** model served through
[OpenRouter](https://openrouter.ai).
