export interface Env {
	CACHE_TTL?: string; // Cache time-to-live in seconds
	ROOT_REDIRECT_URL?: string; // URL to redirect root path to
}

async function getYahooQuote(symbol: string): Promise<number | null> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;

	const response = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0",
		},
	});

	if (response.status === 404) {
		// Symbol not found, return null to indicate no price available
		return null;
	}

	if (!response.ok) {
		throw new Error(`Yahoo Finance API error: ${response.status}`);
	}

	const data = (await response.json()) as any;
	const result = data?.chart?.result?.[0];
	const price = result?.meta?.regularMarketPrice;

	return price ?? null;
}

async function searchYahooSymbol(query: string): Promise<string[]> {
	const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`;

	const response = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0",
		},
	});

	if (!response.ok) return [];

	const data = (await response.json()) as any;
	const quotes = data?.quotes ?? [];
	const symbols = quotes
		.map((q: any) => q?.symbol)
		.filter((s: any) => typeof s === "string")
		.slice(0, 3);

	return symbols;
}

async function tryRewriteExchangeSymbol(
	symbol: string,
	url: URL,
): Promise<Response | null> {
	if (!symbol.includes(":")) return null;

	const [prefix, base] = symbol.split(":");
	if (prefix.toUpperCase() !== "BIT" || !base) return null;

	const candidate = `${base}.MI`;
	try {
		const exists = await getYahooQuote(candidate);
		if (exists !== null) {
			return Response.redirect(
				`${url.origin}/api/quotes/${encodeURIComponent(candidate)}`,
				301,
			);
		}
	} catch {
		// ignore errors and fall through to normal handling
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

		const match = url.pathname.match(/^\/api\/quotes\/([^/]+)$/);
		if (match && request.method === "GET") {
			const symbol = match[1];

			// Try exchange-prefixed rewrite (e.g. BIT:VWCE -> VWCE.MI)
			const rewriteRedirect = await tryRewriteExchangeSymbol(symbol, url);
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
				const price = await getYahooQuote(symbol);

				if (price === null) {
					// If no direct price, try searching for a suggested symbol
					try {
						const suggestions = await searchYahooSymbol(symbol);
						if (suggestions && suggestions.length > 0) {
							return new Response(
								`Symbol not found - similar: ${suggestions.join(" ")}`,
								{
									status: 200,
									headers: {
										"Content-Type": "text/plain",
									},
								},
							);
						}
					} catch {
						// ignore search errors and fall through to generic 404
					}

					return new Response("Price not available", {
						status: 404,
						headers: {
							"Content-Type": "text/plain",
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
