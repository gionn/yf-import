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
 * Returns the request origin if present in ALLOWED_ORIGINS, else null. Only the
 * caller's own origin is echoed, so the list is never disclosed.
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
 * Merges a token into an existing `Vary` header value without duplicating it.
 */
function appendVary(current: string | null, value: string): string {
	const values = (current || "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!values.includes(value)) values.push(value);
	return values.join(", ");
}

/**
 * Adds CORS headers, cloning the response (cached/redirect responses have
 * immutable headers). `Vary: Origin` is always set (merged with any existing
 * `Vary` values, e.g. `Accept`) so caches never reuse one origin's response for
 * another; `Access-Control-Allow-Origin` is set only on a match.
 */
function withCors(response: Response, allowedOrigin: string | null): Response {
	const headers = new Headers(response.headers);
	headers.set("Vary", appendVary(headers.get("Vary"), "Origin"));
	if (allowedOrigin) {
		headers.set("Access-Control-Allow-Origin", allowedOrigin);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * Builds a CORS preflight (OPTIONS) response. The endpoints are public, so any
 * requested headers are accepted; the origin allowlist is the real gate.
 */
function corsPreflightResponse(
	request: Request,
	allowedOrigin: string | null,
): Response {
	const headers = new Headers({
		"Access-Control-Allow-Methods": "GET, OPTIONS",
		Vary: "Origin",
	});
	if (allowedOrigin) {
		headers.set("Access-Control-Allow-Origin", allowedOrigin);

		const requestedHeaders = request.headers.get(
			"Access-Control-Request-Headers",
		);
		if (requestedHeaders) {
			headers.set("Access-Control-Allow-Headers", requestedHeaders);
			headers.append("Vary", "Access-Control-Request-Headers");
		}
	}
	return new Response(null, { status: 204, headers });
}

/**
 * Resolves the CORS origin for a request and, for OPTIONS requests, the ready
 * preflight response. Shared by every route so CORS behaves identically.
 */
function resolveCors(
	request: Request,
	env: Env,
): { allowedOrigin: string | null; preflight: Response | null } {
	const allowedOrigin = getAllowedOrigin(request.headers.get("Origin"), env);
	const preflight =
		request.method === "OPTIONS"
			? corsPreflightResponse(request, allowedOrigin)
			: null;

	return { allowedOrigin, preflight };
}

/**
 * Runs a route handler, wrapping any thrown error in a `500 no-store` response
 * and adding CORS headers to every outcome (including errors).
 */
async function corsGuarded(
	handler: () => Promise<Response>,
	allowedOrigin: string | null,
	errorLabel: string,
): Promise<Response> {
	try {
		return withCors(await handler(), allowedOrigin);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return withCors(
			noStoreResponse(`Error fetching ${errorLabel}: ${message}`, 500),
			allowedOrigin,
		);
	}
}

/**
 * A non-cacheable response (errors, not-found) with the given content type.
 */
function noStoreResponse(
	body: string,
	status: number,
	contentType = "text/plain",
): Response {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": contentType,
			"Cache-Control": "no-store",
		},
	});
}

/**
 * A publicly cacheable `200` response, optionally varying on a header.
 */
function cacheableResponse(
	body: string,
	contentType: string,
	cacheTTL: number,
	vary?: string,
): Response {
	const headers = new Headers({
		"Content-Type": contentType,
		"Cache-Control": `public, max-age=${cacheTTL}`,
	});
	if (vary) headers.set("Vary", vary);

	return new Response(body, { status: 200, headers });
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
	if (meta !== null) {
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
		if (
			quotesMatch &&
			(request.method === "GET" || request.method === "OPTIONS")
		) {
			const { allowedOrigin, preflight } = resolveCors(request, env);
			if (preflight) return preflight;

			const symbol = quotesMatch[1];
			const fetchTimeoutMs = parseInt(env.FETCH_TIMEOUT_MS || "5000", 10);
			const cacheTTL = parseInt(env.CACHE_TTL || "300", 10);

			// Strip query params and headers (e.g. Origin) so one cache entry
			// serves every allowed origin
			const cacheKey = new Request(`${url.origin}${url.pathname}`, {
				method: "GET",
			});
			const cache = caches.default;

			return corsGuarded(
				async () => {
					// Try exchange-prefixed rewrite (e.g. BIT:VWCE -> VWCE.MI)
					const rewriteRedirect = await tryRewriteExchangeSymbol(
						symbol,
						url,
						fetchTimeoutMs,
					);
					if (rewriteRedirect) return rewriteRedirect;

					// Check if we have a cached response
					const cached = await cache.match(cacheKey);
					if (cached) return cached;

					// Cache miss - fetch from Yahoo Finance
					const meta = await getYahooMeta(symbol, fetchTimeoutMs);
					const price = meta?.regularMarketPrice ?? null;
					if (price === null) {
						return noStoreResponse("Price not available", 404);
					}

					const response = cacheableResponse(
						price.toString(),
						"text/plain",
						cacheTTL,
					);

					// Cache the plain response (CORS is added per request).
					// Clone it first: a response body can only be read once.
					ctx.waitUntil(cache.put(cacheKey, response.clone()));

					return response;
				},
				allowedOrigin,
				"quote",
			);
		}

		const detailsMatch = url.pathname.match(/^\/api\/details\/([^/]+)$/);
		if (
			detailsMatch &&
			(request.method === "GET" || request.method === "OPTIONS")
		) {
			const { allowedOrigin, preflight } = resolveCors(request, env);
			if (preflight) return preflight;

			const symbol = detailsMatch[1];
			const fetchTimeoutMs = parseInt(env.FETCH_TIMEOUT_MS || "5000", 10);
			const cacheTTL = parseInt(env.CACHE_TTL || "300", 10);
			const format = resolveFormat(request, url);
			const contentType =
				format === "json" ? "application/json" : "text/csv; charset=utf-8";

			// Include the format in the cache key so CSV and JSON don't collide
			const cacheKey = new Request(
				`${url.origin}${url.pathname}?format=${format}`,
				{ method: "GET" },
			);
			const cache = caches.default;

			return corsGuarded(
				async () => {
					// Try exchange-prefixed rewrite (e.g. BIT:VWCE -> VWCE.MI)
					const rewriteRedirect = await tryRewriteExchangeSymbol(
						symbol,
						url,
						fetchTimeoutMs,
						"/api/details",
					);
					if (rewriteRedirect) return rewriteRedirect;

					// Check if we have a cached response
					const cached = await cache.match(cacheKey);
					if (cached) return cached;

					// Cache miss - fetch from Yahoo Finance
					const meta = await getYahooMeta(symbol, fetchTimeoutMs);
					if (meta === null) {
						return noStoreResponse(
							format === "json"
								? JSON.stringify({ error: "Symbol not found" })
								: "Symbol not found",
							404,
							contentType,
						);
					}

					const body =
						format === "json"
							? JSON.stringify(buildDetails(meta, symbol))
							: detailsToCsv(meta, symbol);

					// Vary on Accept: the format is content-negotiated.
					const response = cacheableResponse(
						body,
						contentType,
						cacheTTL,
						"Accept",
					);

					// Cache the plain response (CORS is added per request).
					ctx.waitUntil(cache.put(cacheKey, response.clone()));

					return response;
				},
				allowedOrigin,
				"details",
			);
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
