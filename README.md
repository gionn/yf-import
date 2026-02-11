# Yahoo Finance Import API

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A Cloudflare Worker that fetches real-time stock quotes from Yahoo Finance API
and returns them in plain text format, perfect for importing into Google Sheets.

**For Google Sheets**: Use the `IMPORTDATA` function to easily pull any asset
price available on Yahoo Finance. This is especially useful for European
securities that Google Finance (via `GOOGLEFINANCE` function) stopped serving.

```text
=IMPORTDATA("https://yf-import.gionn.net/api/quotes/VUAA.MI")
=IMPORTDATA("https://yf-import.gionn.net/api/quotes/VWCE.DE")
=IMPORTDATA("https://yf-import.gionn.net/api/quotes/AAPL")
```

You can easily find a symbol by looking at the Yahoo Finance URL when
viewing an asset page.

## Features

- ⚡ Fast edge-deployed API using Cloudflare Workers
- 📝 Plain text response — ideal for `IMPORTDATA()` in Google Sheets
- 📈 Real-time stock prices from Yahoo Finance
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

## Project Structure

- `src/index.ts` - Main worker code with Yahoo Finance API integration
- `src/index.test.ts` - Automated tests for the worker
- `wrangler.toml` - Cloudflare Workers configuration
- `package.json` - Dependencies and scripts
- `tsconfig.json` - TypeScript configuration

## Configuration

### Cache TTL

Configure cache duration in [wrangler.toml](wrangler.toml):

```toml
[vars]
CACHE_TTL = "300"  # Cache for 5 minutes (300 seconds)
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

## How It Works

The worker makes requests to Yahoo Finance's public quote API and returns the `regularMarketPrice` field. It uses Cloudflare's edge runtime with the standard `fetch` API, making it fast and efficient.

## Disclaimer

This project is **not affiliated with, endorsed by, or in any way officially connected with Yahoo, Yahoo Finance, or any of their subsidiaries or affiliates**. The official Yahoo Finance website can be found at [finance.yahoo.com](https://finance.yahoo.com).

This tool is provided for educational and personal use only. Users are responsible for ensuring their use complies with Yahoo Finance's Terms of Service and any applicable rate limits or usage restrictions. Use at your own risk.
