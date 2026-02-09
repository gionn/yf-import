export interface Env {
	CACHE_TTL?: string; // Cache time-to-live in seconds
	USER_AGENT?: string; // User agent for API requests
}

const DEFAULT_USER_AGENT = "Mozilla/5.0";

async function getYahooQuote(
	symbol: string,
	userAgent: string,
): Promise<number | null> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
	const headers = {
		"User-Agent": userAgent,
	};

	const response = await fetch(url, { headers });

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

			try {
				const userAgent = env.USER_AGENT || DEFAULT_USER_AGENT;
				const price = await getYahooQuote(symbol, userAgent);

				if (price === null) {
					return new Response("Price not available", {
						status: 404,
						headers: {
							"Content-Type": "text/plain",
						},
					});
				}

				const cacheTTL = parseInt(env.CACHE_TTL || "300", 10);

				return new Response(price.toString(), {
					status: 200,
					headers: {
						"Content-Type": "text/plain",
						"Cache-Control": `public, max-age=${cacheTTL}`,
					},
				});
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
