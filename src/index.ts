export interface Env {
	CACHE_TTL?: string; // Cache time-to-live in seconds
}

async function getYahooQuote(symbol: string): Promise<number | null> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;

	const response = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0",
		},
	});

	if (!response.ok) {
		throw new Error(`Yahoo Finance API error: ${response.status}`);
	}

	const data = (await response.json()) as any;
	const result = data?.chart?.result?.[0];
	const price = result?.meta?.regularMarketPrice;

	return price ?? null;
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle /api/quotes/:symbol endpoint
		const match = url.pathname.match(/^\/api\/quotes\/([^/]+)$/);
		if (match) {
			const symbol = match[1];
			const cacheTTL = parseInt(env.CACHE_TTL || "300", 10);

			// Create cache key from the request URL
			const cacheKey = new Request(url.toString(), request);
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
				await cache.put(cacheKey, response.clone());

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

		// Handle 404 for other routes
		return new Response("Not Found", {
			status: 404,
			headers: {
				"Content-Type": "text/plain",
			},
		});
	},
};
