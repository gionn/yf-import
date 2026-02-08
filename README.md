# Simple API Project

A minimal Cloudflare Worker that returns "42" in plain text for the `/api/quotes/VWCE` endpoint.

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

## Testing the Endpoint

```bash
curl http://localhost:8787/api/quotes/VWCE
```

This should return: `42`

## Deployment to Cloudflare Workers

1. Login to Cloudflare:
```bash
npx wrangler login
```

2. Deploy:
```bash
npm run deploy
```

Your worker will be deployed to: `https://yahoof2sheet.<your-subdomain>.workers.dev`

## Project Structure

- `src/index.ts` - Main worker code
- `wrangler.toml` - Cloudflare Workers configuration
- `package.json` - Dependencies and scripts
- `tsconfig.json` - TypeScript configuration

---

## Legacy Python Version

The Python/FastAPI version is preserved in:
- `main.py` - FastAPI application
- `requirements.txt` - Python dependencies

To run the Python version:
```bash
pip install -r requirements.txt
python main.py
```
