const USER_AGENTS = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
];

function randomUserAgent(): string {
	return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export interface Env {
	CACHE_TTL?: string; // Cache time-to-live in seconds
	ROOT_REDIRECT_URL?: string; // URL to redirect root path to
	FETCH_TIMEOUT_MS?: string; // Yahoo Finance API fetch timeout in milliseconds
}

interface YahooMeta {
	symbol?: string;
	longName?: string;
	shortName?: string;
	currency?: string;
	regularMarketPrice?: number;
	fiftyTwoWeekHigh?: number;
	fiftyTwoWeekLow?: number;
}

interface Details {
	symbol: string;
	description: string;
	currency: string;
	price: number | null;
	fiftyTwoWeekHigh: number | null;
	fiftyTwoWeekLow: number | null;
}

const DETAILS_FIELDS: (keyof Details)[] = [
	"symbol",
	"description",
	"currency",
	"price",
	"fiftyTwoWeekHigh",
	"fiftyTwoWeekLow",
];

async function getYahooMeta(
	symbol: string,
	fetchTimeoutMs: number,
): Promise<YahooMeta | null> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;

	const response = await fetch(url, {
		headers: {
			"User-Agent": randomUserAgent(),
		},
		signal: AbortSignal.timeout(fetchTimeoutMs),
	});

	if (response.status === 404) {
		// Symbol not found, return null to indicate no data available
		return null;
	}

	if (!response.ok) {
		throw new Error(`Yahoo Finance API error: ${response.status}`);
	}

	const data = (await response.json()) as any;
	return data?.chart?.result?.[0]?.meta ?? null;
}

function buildDetails(meta: YahooMeta, symbol: string): Details {
	return {
		symbol: meta.symbol ?? symbol,
		description: meta.longName || meta.shortName || symbol,
		currency: meta.currency ?? "",
		price: meta.regularMarketPrice ?? null,
		fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
		fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
	};
}

function csvEscape(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value);
	if (/[",\r\n]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}
	return text;
}

function detailsToCsv(meta: YahooMeta, symbol: string): string {
	const details = buildDetails(meta, symbol);
	return DETAILS_FIELDS.map((field) => csvEscape(details[field])).join(",");
}

function resolveFormat(request: Request, url: URL): "csv" | "json" {
	const format = url.searchParams.get("format")?.toLowerCase();
	if (format === "json" || format === "csv") return format;

	const accept = request.headers.get("Accept") || "";
	return accept.includes("application/json") ? "json" : "csv";
}

async function tryRewriteExchangeSymbol(
	symbol: string,
	url: URL,
	fetchTimeoutMs: number,
	apiPath = "/api/quotes",
): Promise<Response | null> {
	let candidate: string | null = null;

	if (symbol.includes(":")) {
		const [prefix, base] = symbol.split(":");
		if (prefix.toUpperCase() === "BIT" && base) candidate = `${base}.MI`;
		else return null;
	} else if (symbol.toUpperCase().endsWith(".FR")) {
		candidate = `${symbol.slice(0, -3)}.PA`;
	}

	if (!candidate) return null;

	const meta = await getYahooMeta(candidate, fetchTimeoutMs);
	if (meta?.regularMarketPrice != null) {
		return Response.redirect(
			`${url.origin}${apiPath}/${encodeURIComponent(candidate)}`,
			301,
		);
	}
	return null;
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		const quotesMatch = url.pathname.match(/^\/api\/quotes\/([^/]+)$/);
		if (quotesMatch && request.method === "GET") {
			const symbol = quotesMatch[1];

			const fetchTimeoutMs = parseInt(env.FETCH_TIMEOUT_MS || "5000", 10);

			// Try exchange-prefixed rewrite (e.g. BIT:VWCE -> VWCE.MI)
			const rewriteRedirect = await tryRewriteExchangeSymbol(
				symbol,
				url,
				fetchTimeoutMs,
			);
			if (rewriteRedirect) return rewriteRedirect;

			const cacheTTL = parseInt(env.CACHE_TTL || "300", 10);

			// Create cache key from the request URL
			const cacheKey = new Request(`${url.origin}${url.pathname}`, request);
			const cache = caches.default;

			// Check if we have a cached response
			let response = await cache.match(cacheKey);

			if (response) {
				// Return cached response
				return response;
			}

			// Cache miss - fetch from Yahoo Finance
			try {
				const meta = await getYahooMeta(symbol, fetchTimeoutMs);
				const price = meta?.regularMarketPrice ?? null;

				if (price === null) {
					return new Response("Price not available", {
						status: 404,
						headers: {
							"Content-Type": "text/plain",
							"Cache-Control": "no-store",
						},
					});
				}

				response = new Response(price.toString(), {
					status: 200,
					headers: {
						"Content-Type": "text/plain",
						"Cache-Control": `public, max-age=${cacheTTL}`,
					},
				});

				// Store the response in cache
				// Clone the response before caching since response body can only be read once
				ctx.waitUntil(cache.put(cacheKey, response.clone()));

				return response;
			} catch (error) {
				return new Response(
					`Error fetching quote: ${error instanceof Error ? error.message : "Unknown error"}`,
					{
						status: 500,
						headers: {
							"Content-Type": "text/plain",
							"Cache-Control": "no-store",
						},
					},
				);
			}
		}

		const detailsMatch = url.pathname.match(/^\/api\/details\/([^/]+)$/);
		if (detailsMatch && request.method === "GET") {
			const symbol = detailsMatch[1];

			const fetchTimeoutMs = parseInt(env.FETCH_TIMEOUT_MS || "5000", 10);

			// Try exchange-prefixed rewrite (e.g. BIT:VWCE -> VWCE.MI)
			const rewriteRedirect = await tryRewriteExchangeSymbol(
				symbol,
				url,
				fetchTimeoutMs,
				"/api/details",
			);
			if (rewriteRedirect) return rewriteRedirect;

			const cacheTTL = parseInt(env.CACHE_TTL || "300", 10);
			const format = resolveFormat(request, url);

			// Include the format in the cache key so CSV and JSON don't collide
			const cacheKey = new Request(
				`${url.origin}${url.pathname}?format=${format}`,
				{
					method: "GET",
				},
			);
			const cache = caches.default;

			// Check if we have a cached response
			let response = await cache.match(cacheKey);

			if (response) {
				// Return cached response
				return response;
			}

			const contentType =
				format === "json" ? "application/json" : "text/csv; charset=utf-8";

			// Cache miss - fetch from Yahoo Finance
			try {
				const meta = await getYahooMeta(symbol, fetchTimeoutMs);

				if (meta === null) {
					return new Response(
						format === "json"
							? JSON.stringify({ error: "Symbol not found" })
							: "Symbol not found",
						{
							status: 404,
							headers: {
								"Content-Type": contentType,
								"Cache-Control": "no-store",
							},
						},
					);
				}

				const body =
					format === "json"
						? JSON.stringify(buildDetails(meta, symbol))
						: detailsToCsv(meta, symbol);

				response = new Response(body, {
					status: 200,
					headers: {
						"Content-Type": contentType,
						"Cache-Control": `public, max-age=${cacheTTL}`,
					},
				});

				// Store the response in cache
				ctx.waitUntil(cache.put(cacheKey, response.clone()));

				return response;
			} catch (error) {
				return new Response(
					`Error fetching details: ${error instanceof Error ? error.message : "Unknown error"}`,
					{
						status: 500,
						headers: {
							"Content-Type": "text/plain",
							"Cache-Control": "no-store",
						},
					},
				);
			}
		}

		// Handle root path redirect
		if (
			url.pathname === "/" &&
			request.method === "GET" &&
			env.ROOT_REDIRECT_URL &&
			isValidUrl(env.ROOT_REDIRECT_URL)
		) {
			return Response.redirect(env.ROOT_REDIRECT_URL, 301);
		}

		// Handle 404 for other routes
		return new Response("Not Found", {
			status: 404,
			headers: {
				"Content-Type": "text/plain",
			},
		});
	},
};

function isValidUrl(urlString: string): boolean {
	try {
		const url = new URL(urlString);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}
