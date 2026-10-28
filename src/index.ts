import { corsGuarded, resolveCors } from "./cors";
import {
	computeCandleStats,
	formatExchangeDate,
	formatIsoTimestamp,
	type YahooChartResult,
} from "./stats";

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

interface Details {
	symbol: string;
	description: string;
	currency: string;
	price: number | null;
	fiftyTwoWeekHigh: number | null;
	fiftyTwoWeekLow: number | null;
	changePercent: number | null;
	dayHigh: number | null;
	dayLow: number | null;
	volume: number | null;
	instrumentType: string | null;
	exchangeName: string | null;
	exchangeTimezone: string | null;
	marketTime: string | null;
	firstTradeDate: string | null;
	chartPreviousClose: number | null;
	volatility: number | null;
	return1y: number | null;
	maxDrawdown: number | null;
	sma50: number | null;
	distanceFromSma50: number | null;
	sma200: number | null;
	distanceFromSma200: number | null;
	fiftyTwoWeekHighDate: string | null;
	fiftyTwoWeekLowDate: string | null;
	averageVolume: number | null;
}

const DETAILS_FIELDS: (keyof Details)[] = [
	"symbol",
	"description",
	"currency",
	"price",
	"fiftyTwoWeekHigh",
	"fiftyTwoWeekLow",
	"changePercent",
	"dayHigh",
	"dayLow",
	"volume",
	"instrumentType",
	"exchangeName",
	"exchangeTimezone",
	"marketTime",
	"firstTradeDate",
	"chartPreviousClose",
	"volatility",
	"return1y",
	"maxDrawdown",
	"sma50",
	"distanceFromSma50",
	"sma200",
	"distanceFromSma200",
	"fiftyTwoWeekHighDate",
	"fiftyTwoWeekLowDate",
	"averageVolume",
];

async function getYahooChart(
	symbol: string,
	fetchTimeoutMs: number,
	range: string,
	interval: string,
): Promise<YahooChartResult | null> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;

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

	const data = (await response.json()) as {
		chart?: { result?: Array<YahooChartResult | null> | null };
	};
	return data?.chart?.result?.[0] ?? null;
}

function buildDetails(chart: YahooChartResult, symbol: string): Details {
	const meta = chart.meta ?? {};
	const stats = computeCandleStats(chart);

	return {
		symbol: meta.symbol ?? symbol,
		description: meta.longName || meta.shortName || symbol,
		currency: meta.currency ?? "",
		price: meta.regularMarketPrice ?? null,
		fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
		fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
		changePercent: meta.regularMarketChangePercent ?? null,
		dayHigh: meta.regularMarketDayHigh ?? null,
		dayLow: meta.regularMarketDayLow ?? null,
		volume: meta.regularMarketVolume ?? null,
		instrumentType: meta.instrumentType ?? null,
		exchangeName: meta.exchangeName ?? null,
		exchangeTimezone: meta.exchangeTimezoneName ?? null,
		marketTime: formatIsoTimestamp(meta.regularMarketTime),
		firstTradeDate: formatExchangeDate(
			meta.firstTradeDate,
			meta.exchangeTimezoneName,
		),
		chartPreviousClose: meta.chartPreviousClose ?? null,
		...stats,
	};
}

function csvEscape(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value);
	if (/[",\r\n]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}
	return text;
}

function detailsToCsv(chart: YahooChartResult, symbol: string): string {
	const details = buildDetails(chart, symbol);
	return DETAILS_FIELDS.map((field) => csvEscape(details[field])).join(",");
}

function resolveFormat(request: Request, url: URL): "csv" | "json" {
	const format = url.searchParams.get("format")?.toLowerCase();
	if (format === "json" || format === "csv") return format;

	const accept = request.headers.get("Accept");
	if (!accept) return "csv";
	// Media types are case-insensitive; compare the type token exactly so
	// prefixes like `application/json-seq` don't spuriously select JSON.
	const wantsJson = accept
		.split(",")
		.some(
			(range) =>
				range.split(";")[0].trim().toLowerCase() === "application/json",
		);
	return wantsJson ? "json" : "csv";
}

const YAHOO_SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search";
const SEARCH_DEFAULT_COUNT = 10;
const SEARCH_MAX_COUNT = 20;
const SEARCH_MAX_QUERY_LENGTH = 64;

/** A symbol suggestion as returned by the search route. */
interface SearchResult {
	symbol: string;
	ticker: string;
	market: string;
	description: string;
	quoteType: string | null;
	exchange: string | null;
	exchangeDisplay: string | null;
}

interface YahooSearchQuote {
	symbol?: unknown;
	longname?: unknown;
	shortname?: unknown;
	quoteType?: unknown;
	exchange?: unknown;
	exchDisp?: unknown;
	isYahooFinance?: unknown;
}

function pickText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text === "" ? null : text;
}

/**
 * Maps a Yahoo search hit to the slim shape the app consumes, splitting the
 * resolved symbols into the ticker and market suffix the catalog uses. Returns
 * null for hits the app can't use: non-Yahoo entries (e.g. ISIN lookups) and
 * rows without a symbol.
 */
function toSearchResult(quote: YahooSearchQuote): SearchResult | null {
	const symbol = pickText(quote.symbol);
	if (!symbol) return null;
	if (quote.isYahooFinance === false) return null;

	const suffixAt = symbol.lastIndexOf(".");
	const hasSuffix = suffixAt > 0;

	return {
		symbol,
		ticker: hasSuffix ? symbol.slice(0, suffixAt) : symbol,
		market: hasSuffix ? symbol.slice(suffixAt) : "",
		description: pickText(quote.longname) ?? pickText(quote.shortname) ?? "",
		quoteType: pickText(quote.quoteType),
		exchange: pickText(quote.exchange),
		exchangeDisplay: pickText(quote.exchDisp),
	};
}

/** Collapses runs of whitespace so the query and its cache key stay stable. */
function collapseSpaces(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function resolveSearchCount(value: string | null): number {
	const parsed = Number.parseInt(value ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 1) return SEARCH_DEFAULT_COUNT;
	return Math.min(parsed, SEARCH_MAX_COUNT);
}

async function getYahooSearch(
	query: string,
	count: number,
	fetchTimeoutMs: number,
): Promise<YahooSearchQuote[]> {
	const params = new URLSearchParams({
		q: query,
		quotesCount: count.toString(),
		newsCount: "0",
		listsCount: "0",
		enableFuzzyQuery: "false",
	});
	const response = await fetch(`${YAHOO_SEARCH_URL}?${params}`, {
		headers: {
			"User-Agent": randomUserAgent(),
		},
		signal: AbortSignal.timeout(fetchTimeoutMs),
	});

	if (!response.ok) {
		throw new Error(`Yahoo Finance API error: ${response.status}`);
	}

	const data = (await response.json()) as { quotes?: unknown };
	return Array.isArray(data?.quotes) ? (data.quotes as YahooSearchQuote[]) : [];
}

const SEARCH_FIELDS: (keyof SearchResult)[] = [
	"symbol",
	"ticker",
	"market",
	"description",
	"quoteType",
	"exchange",
	"exchangeDisplay",
];

/** Header row plus one CSV row per result, in `SEARCH_FIELDS` order. */
function searchToCsv(results: SearchResult[]): string {
	const rows = results.map((result) =>
		SEARCH_FIELDS.map((field) => csvEscape(result[field])).join(","),
	);
	return [SEARCH_FIELDS.join(","), ...rows].join("\n");
}

function searchError(
	message: string,
	status: number,
	format: "csv" | "json",
): Response {
	return noStoreResponse(
		format === "json" ? JSON.stringify({ error: message }) : message,
		status,
		format === "json" ? "application/json" : "text/plain",
	);
}

async function tryRewriteExchangeSymbol(
	symbol: string,
	url: URL,
	fetchTimeoutMs: number,
	apiPath = "/api/quotes",
	requirePrice = false,
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

	const chart = await getYahooChart(candidate, fetchTimeoutMs, "1d", "1m");
	if (chart === null) return null;
	const meta = chart.meta;
	if (!meta) return null;
	// `/api/quotes` needs a usable price, so a metadata-only candidate must
	// fall through to the 404 path rather than redirect to a dead symbol.
	// `/api/details` accepts metadata without a price.
	if (requirePrice && typeof meta.regularMarketPrice !== "number") return null;

	return Response.redirect(
		`${url.origin}${apiPath}/${encodeURIComponent(candidate)}${url.search}`,
		301,
	);
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
						"/api/quotes",
						true,
					);
					if (rewriteRedirect) return rewriteRedirect;

					// Check if we have a cached response
					const cached = await cache.match(cacheKey);
					if (cached) return cached;

					// Cache miss - fetch from Yahoo Finance
					const chart = await getYahooChart(symbol, fetchTimeoutMs, "1d", "1m");
					const price = chart?.meta?.regularMarketPrice ?? null;
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
				(message) => noStoreResponse(message, 500),
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
					const chart = await getYahooChart(symbol, fetchTimeoutMs, "1y", "1d");
					if (chart === null) {
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
							? JSON.stringify(buildDetails(chart, symbol))
							: detailsToCsv(chart, symbol);

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
				(message) =>
					noStoreResponse(
						format === "json" ? JSON.stringify({ error: message }) : message,
						500,
						contentType,
					),
			);
		}

		if (
			url.pathname === "/api/search" &&
			(request.method === "GET" || request.method === "OPTIONS")
		) {
			const { allowedOrigin, preflight } = resolveCors(request, env);
			if (preflight) return preflight;

			const rawQuery = collapseSpaces(url.searchParams.get("q") ?? "");
			const query = rawQuery.toLowerCase();
			const count = resolveSearchCount(url.searchParams.get("count"));
			const fetchTimeoutMs = parseInt(env.FETCH_TIMEOUT_MS || "5000", 10);
			const cacheTTL = parseInt(env.CACHE_TTL || "300", 10);
			const format = resolveFormat(request, url);
			const contentType =
				format === "json" ? "application/json" : "text/csv; charset=utf-8";

			// The normalized query is the cache key, so `VWCE` and `vwce` share
			// one upstream call and one entry.
			const cacheKey = new Request(
				`${url.origin}/api/search?q=${encodeURIComponent(query)}&count=${count}&format=${format}`,
				{ method: "GET" },
			);
			const cache = caches.default;

			return corsGuarded(
				async () => {
					if (!query) {
						return searchError("Missing q parameter", 400, format);
					}
					if (rawQuery.length > SEARCH_MAX_QUERY_LENGTH) {
						return searchError(
							`Query too long (max ${SEARCH_MAX_QUERY_LENGTH} characters)`,
							400,
							format,
						);
					}

					const cached = await cache.match(cacheKey);
					if (cached) return cached;

					const quotes = await getYahooSearch(rawQuery, count, fetchTimeoutMs);
					const seen = new Set<string>();
					const results: SearchResult[] = [];
					for (const quote of quotes) {
						const result = toSearchResult(quote);
						if (!result || seen.has(result.symbol)) continue;
						seen.add(result.symbol);
						results.push(result);
					}

					const body =
						format === "json"
							? JSON.stringify({ query, results })
							: searchToCsv(results);
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
				"search",
				(message) => searchError(message, 500, format),
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
