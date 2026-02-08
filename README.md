# Yahoo Finance Quote API

A Cloudflare Worker that fetches real-time stock quotes from Yahoo Finance. Returns the current market price for any stock symbol in plain text format.

## Features

- ⚡ Fast edge-deployed API using Cloudflare Workers
- 📈 Real-time stock prices from Yahoo Finance
- 🌐 Global availability with low latency
- 💰 Free tier: 100,000 requests/day
- 🔒 No API key required

## Prerequisites

- Node.js (v18 or later)
- npm or yarn
- Cloudflare account (for deployment)

## Installation

```bash
npm install
```

## Running Locally

```bash
npm run dev
```

The API will be available at `http://localhost:8787`

## Usage

### Get a Stock Quote

```bash
curl http://localhost:8787/api/quotes/AAPL
# Returns: 189.25

curl http://localhost:8787/api/quotes/VWCE
# Returns: 112.34
```

The API endpoint format is: `/api/quotes/{SYMBOL}`

Supports any valid Yahoo Finance stock symbol (AAPL, GOOGL, MSFT, VWCE, etc.)

## Deployment to Cloudflare Workers

1. Login to Cloudflare:
```bash
npx wrangler login
```

2. Deploy:
```bash
npm run deploy
```

Your worker will be deployed to: `https://yf-import.<your-subdomain>.workers.dev`

## Project Structure

- `src/index.ts` - Main worker code with Yahoo Finance API integration
- `wrangler.toml` - Cloudflare Workers configuration
- `package.json` - Dependencies and scripts
- `tsconfig.json` - TypeScript configuration

## How It Works

The worker makes requests to Yahoo Finance's public quote API and returns the `regularMarketPrice` field. It uses Cloudflare's edge runtime with the standard `fetch` API, making it fast and efficient.

## Cloudflare Workers Free Tier Limits

- 100,000 requests per day
- 10ms CPU time per invocation (external API wait time is free)
- No duration charges

Perfect for personal projects and medium-traffic applications.
