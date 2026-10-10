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
	ALLOWED_ORIGINS?: string; // Comma-separated list of origins allowed for CORS
}

/**
 * Returns the request origin if it is present in the configured allowlist,
 * otherwise null. Only the caller's own origin is ever echoed back, so the
 * configured list is never disclosed.
 */
function getAllowedOrigin(
	requestOrigin: string | null,
	env: Env,
): string | null {
	if (!requestOrigin) return null;

	const allowedOrigins = (env.ALLOWED_ORIGINS || "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);

	return allowedOrigins.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * Applies CORS headers to a response. `Vary: Origin` is always emitted because
 * the response representation depends on the request's Origin, so downstream
 * caches must not reuse one origin's response for another. The
 * `Access-Control-Allow-Origin` header is only added when the request origin
 * matched the allowlist. The response is cloned because cached and redirect
 * responses have immutable headers.
 */
function withCors(response: Response, allowedOrigin: string | null): Response {
	const headers = new Headers(response.headers);
	headers.set("Vary", "Origin");
	if (allowedOrigin) {
		headers.set("Access-Control-Allow-Origin", allowedOrigin);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function getYahooQuote(
	symbol: string,
	fetchTimeoutMs: number,
): Promise<number | null> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;

	const response = await fetch(url, {
		headers: {
			"User-Agent": randomUserAgent(),
		},
		signal: AbortSignal.timeout(fetchTimeoutMs),
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

async function tryRewriteExchangeSymbol(
	symbol: string,
	url: URL,
	fetchTimeoutMs: number,
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

	if ((await getYahooQuote(candidate, fetchTimeoutMs)) !== null) {
		return Response.redirect(
			`${url.origin}/api/quotes/${encodeURIComponent(candidate)}`,
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

		const match = url.pathname.match(/^\/api\/quotes\/([^/]+)$/);
		if (match && (request.method === "GET" || request.method === "OPTIONS")) {
			const allowedOrigin = getAllowedOrigin(
				request.headers.get("Origin"),
				env,
			);

			// Handle CORS preflight requests
			if (request.method === "OPTIONS") {
				const headers = new Headers({
					"Access-Control-Allow-Methods": "GET, OPTIONS",
					Vary: "Origin",
				});
				if (allowedOrigin) {
					headers.set("Access-Control-Allow-Origin", allowedOrigin);
				}
				return new Response(null, { status: 204, headers });
			}

			const symbol = match[1];

			const fetchTimeoutMs = parseInt(env.FETCH_TIMEOUT_MS || "5000", 10);
			const cacheTTL = parseInt(env.CACHE_TTL || "300", 10);

			// Create cache key from the request URL (query params and headers
			// such as Origin are stripped so the cached entry is shared across
			// all allowed origins)
			const cacheKey = new Request(`${url.origin}${url.pathname}`, {
				method: request.method,
			});
			const cache = caches.default;

			// The rewrite probe and the quote fetch can both throw (e.g. on a
			// Yahoo Finance 500 or timeout), so both are protected here to
			// guarantee the error response still carries CORS headers.
			try {
				// Try exchange-prefixed rewrite (e.g. BIT:VWCE -> VWCE.MI)
				const rewriteRedirect = await tryRewriteExchangeSymbol(
					symbol,
					url,
					fetchTimeoutMs,
				);
				if (rewriteRedirect) return withCors(rewriteRedirect, allowedOrigin);

				// Check if we have a cached response
				let response = await cache.match(cacheKey);

				if (response) {
					// Return cached response
					return withCors(response, allowedOrigin);
				}

				// Cache miss - fetch from Yahoo Finance
				const price = await getYahooQuote(symbol, fetchTimeoutMs);

				if (price === null) {
					return withCors(
						new Response("Price not available", {
							status: 404,
							headers: {
								"Content-Type": "text/plain",
								"Cache-Control": "no-store",
							},
						}),
						allowedOrigin,
					);
				}

				response = new Response(price.toString(), {
					status: 200,
					headers: {
						"Content-Type": "text/plain",
						"Cache-Control": `public, max-age=${cacheTTL}`,
					},
				});

				// Store the plain response in cache (without CORS headers, so a
				// single entry serves every allowed origin). CORS headers are
				// added per-request on the way out.
				// Clone the response before caching since response body can only be read once
				ctx.waitUntil(cache.put(cacheKey, response.clone()));

				return withCors(response, allowedOrigin);
			} catch (error) {
				return withCors(
					new Response(
						`Error fetching quote: ${error instanceof Error ? error.message : "Unknown error"}`,
						{
							status: 500,
							headers: {
								"Content-Type": "text/plain",
								"Cache-Control": "no-store",
							},
						},
					),
					allowedOrigin,
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
