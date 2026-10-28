import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

// Mock Yahoo Finance API responses
const mockYahooResponse = (price: number) => ({
	chart: {
		result: [
			{
				meta: {
					regularMarketPrice: price,
				},
			},
		],
	},
});

describe("Quotes API", () => {
	describe("GET /api/quotes/:symbol", () => {
		let ctx: ExecutionContext;

		beforeEach(() => {
			// Mock fetch for unit tests
			vi.stubGlobal("fetch", vi.fn());
			ctx = createExecutionContext();
		});

		afterEach(async () => {
			// Wait for scheduled cache writes before restoring globals
			await waitOnExecutionContext(ctx);
			// Properly restore globals
			vi.unstubAllGlobals();
		});

		it("should return stock price for valid symbol", async () => {
			// Mock Yahoo Finance API response
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(150.25),
			});

			const request = new Request("http://localhost/api/quotes/AAPL");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("150.25");
			expect(response.headers.get("Content-Type")).toBe("text/plain");
			expect(response.headers.get("Cache-Control")).toContain("max-age=");
		});

		it("should request a one-day intraday series for quotes", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(150.25),
			});

			await worker.fetch(
				new Request("http://localhost/api/quotes/RANGEQ"),
				env,
				ctx,
			);

			const requestedUrl = (globalThis.fetch as any).mock.calls[0][0];
			expect(requestedUrl).toContain("range=1d");
			expect(requestedUrl).toContain("interval=1m");
		});

		it("should return 404 when price is not available", async () => {
			// Mock API response with no price
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			const request = new Request("http://localhost/api/quotes/INVALID");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Price not available");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		});

		it("should return 500 when Yahoo Finance API fails", async () => {
			// Mock API error response
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const request = new Request("http://localhost/api/quotes/FAIL500");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(500);
			expect(await response.text()).toContain("Error fetching quote");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		});

		it("should use custom cache TTL from environment", async () => {
			const customEnv = { CACHE_TTL: "600" };

			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(100.5),
			});

			const request = new Request("http://localhost/api/quotes/TSLA");
			const response = await worker.fetch(request, customEnv, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("public, max-age=600");
		});

		it("should use default cache TTL when not specified", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(200.75),
			});

			const request = new Request("http://localhost/api/quotes/GOOGL");
			const response = await worker.fetch(request, {}, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
		});

		it("should return cached response on cache hit", async () => {
			// First request - cache miss
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(175.5),
			});

			const request1 = new Request("http://localhost/api/quotes/MSFT");
			const response1 = await worker.fetch(request1, env, ctx);

			expect(response1.status).toBe(200);
			expect(await response1.text()).toBe("175.5");
			expect(globalThis.fetch).toHaveBeenCalledOnce();

			// Second request - should hit cache
			const request2 = new Request("http://localhost/api/quotes/MSFT");
			const response2 = await worker.fetch(request2, env, ctx);

			expect(response2.status).toBe(200);
			expect(await response2.text()).toBe("175.5");
			expect(response2.headers.get("CF-Cache-Status")).toBe("HIT");
			// Should still be called only once (cache hit)
			expect(globalThis.fetch).toHaveBeenCalledOnce();
		});

		it("should handle cache with different symbols independently", async () => {
			// First request (cache miss)
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(150.25),
			});

			const request1 = new Request("http://localhost/api/quotes/AMZN");
			const response1 = await worker.fetch(request1, env, ctx);

			expect(response1.status).toBe(200);
			expect(await response1.text()).toBe("150.25");

			// Second request, different symbol (cache miss)
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(2500.75),
			});

			const request2 = new Request("http://localhost/api/quotes/NVDA");
			const response2 = await worker.fetch(request2, env, ctx);

			expect(response2.status).toBe(200);
			expect(await response2.text()).toBe("2500.75");

			// Verify fetch was called twice (once per symbol)
			expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		});

		it("should only respond to GET requests", async () => {
			const request = new Request("http://localhost/api/quotes/AAPL", {
				method: "POST",
			});
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		});

		it("should ignore query params in cache key", async () => {
			// First request with query params
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(100.5),
			});

			const request1 = new Request(
				"http://localhost/api/quotes/CACHEKEY?foo=bar",
			);
			const response1 = await worker.fetch(request1, env, ctx);

			expect(response1.status).toBe(200);
			expect(await response1.text()).toBe("100.5");
			expect(globalThis.fetch).toHaveBeenCalledOnce();

			// Second request with different query params - should hit cache
			const request2 = new Request(
				"http://localhost/api/quotes/CACHEKEY?baz=qux",
			);
			const response2 = await worker.fetch(request2, env, ctx);

			expect(response2.status).toBe(200);
			expect(await response2.text()).toBe("100.5");
			expect(response2.headers.get("CF-Cache-Status")).toBe("HIT");
			// Should still be called only once (cache hit)
			expect(globalThis.fetch).toHaveBeenCalledOnce();

			// Third request without query params - should also hit cache
			const request3 = new Request("http://localhost/api/quotes/CACHEKEY");
			const response3 = await worker.fetch(request3, env, ctx);

			expect(response3.status).toBe(200);
			expect(await response3.text()).toBe("100.5");
			expect(response3.headers.get("CF-Cache-Status")).toBe("HIT");
			// Should still be called only once (cache hit)
			expect(globalThis.fetch).toHaveBeenCalledOnce();
		});

		it("should rewrite BIT:SYMBOL to SYMBOL.MI and redirect with 301 when exists", async () => {
			// Mock Yahoo Finance API response for the rewritten symbol
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					chart: { result: [{ meta: { regularMarketPrice: 123.45 } }] },
				}),
			});

			const request = new Request("http://localhost/api/quotes/BIT:VWCE");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe(
				"http://localhost/api/quotes/VWCE.MI",
			);
		});

		it("should rewrite SYMBOL.FR to SYMBOL.PA and redirect with 301 when exists", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					chart: { result: [{ meta: { regularMarketPrice: 55.0 } }] },
				}),
			});

			const request = new Request("http://localhost/api/quotes/AIR.FR");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe(
				"http://localhost/api/quotes/AIR.PA",
			);
		});

		it("should not redirect when .FR rewritten symbol has no price and return 404", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			const request = new Request("http://localhost/api/quotes/XXXX.FR");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toContain("Price not available");
		});

		it("should not redirect when rewritten symbol has no price and return 404", async () => {
			// First call to check if rewritten symbol exists
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			// Second call to fetch untouched symbol also returns 404
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			const request = new Request("http://localhost/api/quotes/BIT:XXXX");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toContain("Price not available");
		});

		it("should not redirect a candidate that has metadata but no price", async () => {
			// The rewrite probe finds metadata without a current price. Quotes
			// must not redirect on metadata alone, or it would 301 to a symbol
			// that then 404s.
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					chart: {
						result: [{ meta: { symbol: "VWCE.MI", currency: "EUR" } }],
					},
				}),
			});

			// Fall through to the original symbol, which also has no price
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					chart: {
						result: [{ meta: { symbol: "VWCE.MI", currency: "EUR" } }],
					},
				}),
			});

			const request = new Request("http://localhost/api/quotes/BIT:VWCE");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toContain("Price not available");
		});

		it("should return 500 when the rewrite probe fails", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const request = new Request("http://localhost/api/quotes/BIT:VWCE");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(500);
			expect(await response.text()).toContain("Error fetching quote");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		});
	});

	describe("CORS", () => {
		let ctx: ExecutionContext;

		const corsEnv = {
			ALLOWED_ORIGINS: "https://app.example.com,https://sheets.example.org",
		};

		beforeEach(() => {
			vi.stubGlobal("fetch", vi.fn());
			ctx = createExecutionContext();
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("should echo an allowed origin and set Vary: Origin", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(150.25),
			});

			const request = new Request("http://localhost/api/quotes/CORSALLOW", {
				headers: { Origin: "https://app.example.com" },
			});
			const response = await worker.fetch(request, corsEnv, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://app.example.com",
			);
			expect(response.headers.get("Vary")).toBe("Origin");
		});

		it("should not send CORS headers for a disallowed origin", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(150.25),
			});

			const request = new Request("http://localhost/api/quotes/CORSDENY", {
				headers: { Origin: "https://evil.example.com" },
			});
			const response = await worker.fetch(request, corsEnv, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
			// Vary is emitted even when not allowed so shared caches do not
			// reuse this response for an allowlisted origin
			expect(response.headers.get("Vary")).toBe("Origin");
		});

		it("should serve requests without an Origin header without CORS headers", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(99.5),
			});

			const request = new Request("http://localhost/api/quotes/CORSPLAIN");
			const response = await worker.fetch(request, corsEnv, ctx);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("99.5");
			expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
			expect(response.headers.get("Vary")).toBe("Origin");
		});

		it("should handle OPTIONS preflight for an allowed origin", async () => {
			const request = new Request("http://localhost/api/quotes/AAPL", {
				method: "OPTIONS",
				headers: { Origin: "https://app.example.com" },
			});
			const response = await worker.fetch(request, corsEnv, ctx);

			expect(response.status).toBe(204);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://app.example.com",
			);
			expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
				"GET, OPTIONS",
			);
			expect(response.headers.get("Vary")).toBe("Origin");
		});

		it("should permit requested custom headers on preflight for an allowed origin", async () => {
			const request = new Request("http://localhost/api/quotes/AAPL", {
				method: "OPTIONS",
				headers: {
					Origin: "https://app.example.com",
					"Access-Control-Request-Method": "GET",
					"Access-Control-Request-Headers": "Authorization, X-Custom",
				},
			});
			const response = await worker.fetch(request, corsEnv, ctx);

			expect(response.status).toBe(204);
			expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
				"Authorization, X-Custom",
			);
			expect(response.headers.get("Vary")).toContain("Origin");
			expect(response.headers.get("Vary")).toContain(
				"Access-Control-Request-Headers",
			);
		});

		it("should wrap rewrite probe failures with CORS headers", async () => {
			// Upstream error while probing the rewritten symbol throws before
			// falling through; the 500 must still carry CORS headers.
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const request = new Request("http://localhost/api/quotes/BIT:VWCE", {
				headers: { Origin: "https://app.example.com" },
			});
			const response = await worker.fetch(request, corsEnv, ctx);

			expect(response.status).toBe(500);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://app.example.com",
			);
			expect(response.headers.get("Vary")).toBe("Origin");
		});

		it("should reflect the requesting origin on a cache hit", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(42.42),
			});

			// First request (cache miss) from one allowed origin
			const request1 = new Request("http://localhost/api/quotes/CORSCACHE", {
				headers: { Origin: "https://app.example.com" },
			});
			const response1 = await worker.fetch(request1, corsEnv, ctx);
			expect(response1.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://app.example.com",
			);
			await response1.text();

			// Second request (cache hit) from a different allowed origin
			const request2 = new Request("http://localhost/api/quotes/CORSCACHE", {
				headers: { Origin: "https://sheets.example.org" },
			});
			const response2 = await worker.fetch(request2, corsEnv, ctx);
			expect(response2.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://sheets.example.org",
			);
			// Cached response is origin-agnostic: Yahoo is only called once
			expect(globalThis.fetch).toHaveBeenCalledOnce();
		});
	});

	describe("Other routes", () => {
		it("should return 404 for unknown routes", async () => {
			const ctx = createExecutionContext();
			const request = new Request("http://localhost/unknown");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		});

		it("should return 404 for root path when no redirect is configured", async () => {
			const ctx = createExecutionContext();
			const request = new Request("http://localhost/");
			const response = await worker.fetch(request, {}, ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		});
	});

	describe("Root path redirect", () => {
		it("should redirect to configured URL with 301 status", async () => {
			const ctx = createExecutionContext();
			const customEnv = { ROOT_REDIRECT_URL: "https://example.com" };
			const request = new Request("http://localhost/");
			const response = await worker.fetch(request, customEnv, ctx);

			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe("https://example.com/");
		});

		it("should return 404 for invalid redirect URL", async () => {
			const ctx = createExecutionContext();
			const customEnv = { ROOT_REDIRECT_URL: "not-a-valid-url" };
			const request = new Request("http://localhost/");
			const response = await worker.fetch(request, customEnv, ctx);

			expect(response.status).toBe(404);
		});

		it("should only redirect exact root path, not other paths", async () => {
			const ctx = createExecutionContext();
			const customEnv = { ROOT_REDIRECT_URL: "https://example.com" };
			const request = new Request("http://localhost/other");
			const response = await worker.fetch(request, customEnv, ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		});
	});
});

describe("Details API", () => {
	const detailsMeta = {
		symbol: "MOCK.MI",
		longName: "Vanguard FTSE All-World UCITS ETF USD Accumulation",
		currency: "EUR",
		regularMarketPrice: 172.89,
		fiftyTwoWeekHigh: 173.98,
		fiftyTwoWeekLow: 138.2,
		regularMarketChangePercent: 0.199,
		regularMarketDayHigh: 173.5,
		regularMarketDayLow: 172.2,
		regularMarketVolume: 12345,
		instrumentType: "ETF",
		exchangeName: "MIL",
		exchangeTimezoneName: "Europe/Rome",
		regularMarketTime: 1792424111,
		firstTradeDate: 1578988800,
		chartPreviousClose: 140.32,
	};

	interface MockCandle {
		timestamp?: number;
		high?: number | null;
		low?: number | null;
		close?: number | null;
		volume?: number | null;
		adjclose?: number | null;
	}

	const chartResponse = (
		meta: Record<string, unknown>,
		candles: MockCandle[] = [],
	) => ({
		ok: true,
		json: async () => ({
			chart: {
				result: [
					{
						meta,
						timestamp: candles.map(
							(candle, i) => candle.timestamp ?? 1730000000 + i * 86_400,
						),
						indicators: {
							quote: [
								{
									high: candles.map((candle) => candle.high ?? null),
									low: candles.map((candle) => candle.low ?? null),
									close: candles.map((candle) => candle.close ?? null),
									volume: candles.map((candle) => candle.volume ?? null),
								},
							],
							adjclose: [
								{
									adjclose: candles.map(
										(candle) => candle.adjclose ?? candle.close ?? null,
									),
								},
							],
						},
					},
				],
			},
		}),
	});

	// Volatility, returns, drawdown, SMAs, dates and average volume.
	const emptyStatsTail = ",".repeat(10);
	// The ten stats plus the ten meta fields these mocks omit.
	const emptyMetaAndStatsTail = ",".repeat(20);

	const flatCandles = (count: number): MockCandle[] =>
		Array.from({ length: count }, (_, i) => ({
			timestamp: Date.UTC(2024, 0, 1) / 1000 + i * 86_400,
			high: 101,
			low: 99,
			close: 100,
			volume: 1000,
		}));

	describe("GET /api/details/:symbol", () => {
		let ctx: ExecutionContext;

		beforeEach(() => {
			vi.stubGlobal("fetch", vi.fn());
			ctx = createExecutionContext();
		});

		afterEach(async () => {
			// Wait for scheduled cache writes before restoring globals
			await waitOnExecutionContext(ctx);
			vi.unstubAllGlobals();
		});

		it("should return a single CSV row with all fields", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse(detailsMeta),
			);

			const request = new Request("http://localhost/api/details/MOCK.MI");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(
				"text/csv; charset=utf-8",
			);
			expect(response.headers.get("Vary")).toBe("Accept, Origin");
			expect(await response.text()).toBe(
				`MOCK.MI,Vanguard FTSE All-World UCITS ETF USD Accumulation,EUR,172.89,173.98,138.2,0.199,173.5,172.2,12345,ETF,MIL,Europe/Rome,2026-10-19T15:35:11.000Z,2020-01-14,140.32${emptyStatsTail}`,
			);
			expect(response.headers.get("Cache-Control")).toContain("max-age=");
		});

		it("should fall back to shortName for description", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({
					symbol: "XYZ",
					shortName: "Short Name",
					currency: "USD",
					regularMarketPrice: 10,
				}),
			);

			const request = new Request("http://localhost/api/details/XYZ");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe(
				`XYZ,Short Name,USD,10,,${emptyMetaAndStatsTail}`,
			);
		});

		it("should fall back to the symbol when no name is available", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({ currency: "USD", regularMarketPrice: 5 }),
			);

			const request = new Request("http://localhost/api/details/NONAME");
			const response = await worker.fetch(request, env, ctx);

			expect(await response.text()).toBe(
				`NONAME,NONAME,USD,5,,${emptyMetaAndStatsTail}`,
			);
		});

		it("should escape commas and quotes in CSV fields", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({
					symbol: "ESC",
					longName: 'Vanguard "Test", Fund',
					currency: "EUR",
					regularMarketPrice: 1,
					fiftyTwoWeekHigh: 2,
					fiftyTwoWeekLow: 3,
				}),
			);

			const request = new Request("http://localhost/api/details/ESC");
			const response = await worker.fetch(request, env, ctx);

			expect(await response.text()).toBe(
				`ESC,"Vanguard ""Test"", Fund",EUR,1,2,3${emptyMetaAndStatsTail}`,
			);
		});

		it("should return JSON when format=json is requested", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse(detailsMeta),
			);

			const request = new Request(
				"http://localhost/api/details/MOCK.MI?format=json",
			);
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("application/json");
			expect(JSON.parse(await response.text())).toEqual({
				symbol: "MOCK.MI",
				description: "Vanguard FTSE All-World UCITS ETF USD Accumulation",
				currency: "EUR",
				price: 172.89,
				fiftyTwoWeekHigh: 173.98,
				fiftyTwoWeekLow: 138.2,
				changePercent: 0.199,
				dayHigh: 173.5,
				dayLow: 172.2,
				volume: 12345,
				instrumentType: "ETF",
				exchangeName: "MIL",
				exchangeTimezone: "Europe/Rome",
				marketTime: "2026-10-19T15:35:11.000Z",
				firstTradeDate: "2020-01-14",
				chartPreviousClose: 140.32,
				volatility: null,
				return1y: null,
				maxDrawdown: null,
				sma50: null,
				distanceFromSma50: null,
				sma200: null,
				distanceFromSma200: null,
				fiftyTwoWeekHighDate: null,
				fiftyTwoWeekLowDate: null,
				averageVolume: null,
			});
		});

		it("should return JSON when Accept: application/json is sent", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({
					symbol: "ACCEPT",
					longName: "Accepted",
					currency: "USD",
					regularMarketPrice: 1,
				}),
			);

			const request = new Request("http://localhost/api/details/ACCEPT", {
				headers: { Accept: "application/json" },
			});
			const response = await worker.fetch(request, env, ctx);

			expect(response.headers.get("Content-Type")).toBe("application/json");
			const body = JSON.parse(await response.text());
			expect(body.symbol).toBe("ACCEPT");
			expect(body.fiftyTwoWeekHigh).toBeNull();
			expect(body.fiftyTwoWeekLow).toBeNull();
		});

		it("should match the Accept media type case-insensitively", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({
					symbol: "CASING",
					longName: "Casing",
					currency: "USD",
					regularMarketPrice: 1,
				}),
			);

			const request = new Request("http://localhost/api/details/CASING", {
				headers: { Accept: "Application/JSON" },
			});
			const response = await worker.fetch(request, env, ctx);

			expect(response.headers.get("Content-Type")).toBe("application/json");
			expect(JSON.parse(await response.text()).symbol).toBe("CASING");
		});

		it("should only match an exact JSON media type, not a prefix", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({
					symbol: "JSONSEQ",
					longName: "Json Seq",
					currency: "USD",
					regularMarketPrice: 1,
				}),
			);

			const request = new Request("http://localhost/api/details/JSONSEQ", {
				headers: { Accept: "application/json-seq" },
			});
			const response = await worker.fetch(request, env, ctx);

			expect(response.headers.get("Content-Type")).toBe(
				"text/csv; charset=utf-8",
			);
		});

		it("should compute 52-week stats from daily candles", async () => {
			const candles = Array.from({ length: 200 }, (_, i) => ({
				timestamp: Date.UTC(2024, 0, 1) / 1000 + i * 86_400,
				high: 100 + i + 1,
				low: 100 + i - 1,
				close: 100 + i,
				volume: 1000 + i,
			}));

			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse(
					{
						symbol: "STATS",
						currency: "EUR",
						regularMarketPrice: 299,
						exchangeTimezoneName: "UTC",
					},
					candles,
				),
			);

			const response = await worker.fetch(
				new Request("http://localhost/api/details/STATS?format=json"),
				env,
				ctx,
			);

			const body = JSON.parse(await response.text());
			expect(body.return1y).toBe(199);
			expect(body.maxDrawdown).toBe(0);
			expect(body.sma50).toBe(274.5);
			expect(body.distanceFromSma50).toBe(8.93);
			expect(body.sma200).toBe(199.5);
			expect(body.distanceFromSma200).toBe(49.87);
			expect(body.averageVolume).toBe(1100);
			expect(body.volatility).not.toBeNull();
			expect(body.fiftyTwoWeekHighDate).toBe("2024-07-18");
			expect(body.fiftyTwoWeekLowDate).toBe("2024-01-01");
		});

		it("should return adjusted returns but price-based SMA distances", async () => {
			const candles = Array.from({ length: 60 }, (_, i) => ({
				high: 101,
				low: 99,
				close: 100,
				volume: 1000,
				adjclose: i === 59 ? 150 : 100,
			}));

			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse(
					{
						symbol: "ADJUSTED",
						currency: "EUR",
						regularMarketPrice: 100,
						exchangeTimezoneName: "UTC",
					},
					candles,
				),
			);

			const response = await worker.fetch(
				new Request("http://localhost/api/details/ADJUSTED?format=json"),
				env,
				ctx,
			);

			const body = JSON.parse(await response.text());
			expect(body.return1y).toBe(50);
			expect(body.sma50).toBe(100);
			expect(body.distanceFromSma50).toBe(0);
		});

		it("should withhold volatility when there are fewer than 60 candles", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse(
					{
						symbol: "YOUNG",
						currency: "EUR",
						regularMarketPrice: 129,
						exchangeTimezoneName: "UTC",
					},
					flatCandles(30),
				),
			);

			const response = await worker.fetch(
				new Request("http://localhost/api/details/YOUNG?format=json"),
				env,
				ctx,
			);

			const body = JSON.parse(await response.text());
			expect(body.volatility).toBeNull();
			expect(body.return1y).toBe(0);
			expect(body.sma50).toBeNull();
			expect(body.distanceFromSma50).toBeNull();
		});

		it("should skip null closes when computing stats", async () => {
			const candles = flatCandles(61).map((candle, i) =>
				i === 20 ? { ...candle, close: null, adjclose: null } : candle,
			);

			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse(
					{
						symbol: "NULLS",
						currency: "EUR",
						regularMarketPrice: 100,
						exchangeTimezoneName: "UTC",
					},
					candles,
				),
			);

			const response = await worker.fetch(
				new Request("http://localhost/api/details/NULLS?format=json"),
				env,
				ctx,
			);

			const body = JSON.parse(await response.text());
			expect(body.volatility).toBe(0);
			expect(body.return1y).toBe(0);
			expect(body.sma50).toBe(100);
		});

		it("should request a one-year daily series for details", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({ symbol: "RANGE" }),
			);

			await worker.fetch(
				new Request("http://localhost/api/details/RANGE"),
				env,
				ctx,
			);

			const requestedUrl = (globalThis.fetch as any).mock.calls[0][0];
			expect(requestedUrl).toContain("range=1y");
			expect(requestedUrl).toContain("interval=1d");
		});

		it("should return 404 when the symbol is not found", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			const request = new Request("http://localhost/api/details/INVALID");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Symbol not found");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		});

		it("should return a JSON error when the symbol is not found in JSON mode", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			const request = new Request(
				"http://localhost/api/details/INVALIDJSON?format=json",
			);
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(404);
			expect(response.headers.get("Content-Type")).toBe("application/json");
			expect(JSON.parse(await response.text())).toEqual({
				error: "Symbol not found",
			});
		});

		it("should return 500 when the Yahoo Finance API fails", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const request = new Request("http://localhost/api/details/FAIL500");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(500);
			expect(await response.text()).toContain("Error fetching details");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		});

		it("should return a JSON 500 when Yahoo fails in JSON mode", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const request = new Request(
				"http://localhost/api/details/FAIL500JSON?format=json",
			);
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(500);
			expect(response.headers.get("Content-Type")).toBe("application/json");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			const body = JSON.parse(await response.text());
			expect(body.error).toContain("Error fetching details");
		});

		it("should return a JSON 500 for Accept: application/json on upstream failure", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const request = new Request(
				"http://localhost/api/details/FAIL500ACCEPT",
				{ headers: { Accept: "application/json" } },
			);
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(500);
			expect(response.headers.get("Content-Type")).toBe("application/json");
			const body = JSON.parse(await response.text());
			expect(body.error).toContain("Error fetching details");
		});

		it("should only respond to GET requests", async () => {
			const request = new Request("http://localhost/api/details/AAPL", {
				method: "POST",
			});
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		});

		it("should rewrite BIT:VWCE to VWCE.MI and redirect with 301", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({ regularMarketPrice: 123.45 }),
			);

			const request = new Request("http://localhost/api/details/BIT:VWCE");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe(
				"http://localhost/api/details/VWCE.MI",
			);
		});

		it("should preserve the query string when redirecting a rewrite", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({ regularMarketPrice: 123.45 }),
			);

			const request = new Request(
				"http://localhost/api/details/BIT:VWCE?format=json",
			);
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe(
				"http://localhost/api/details/VWCE.MI?format=json",
			);
		});

		it("should redirect when the rewritten symbol exists without a current price", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({ symbol: "VWCE.MI", currency: "EUR" }),
			);

			const request = new Request("http://localhost/api/details/BIT:VWCE");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe(
				"http://localhost/api/details/VWCE.MI",
			);
		});

		it("should return 500 when the rewrite probe fails", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const request = new Request("http://localhost/api/details/BIT:VWCE");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(500);
			expect(await response.text()).toContain("Error fetching details");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		});

		it("should serve cached responses on cache hit", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({
					symbol: "CACHED",
					longName: "Cached Fund",
					currency: "EUR",
					regularMarketPrice: 42,
				}),
			);

			const request1 = new Request("http://localhost/api/details/CACHED");
			const response1 = await worker.fetch(request1, env, ctx);
			expect(response1.status).toBe(200);
			expect(await response1.text()).toBe(
				`CACHED,Cached Fund,EUR,42,,${emptyMetaAndStatsTail}`,
			);
			expect(globalThis.fetch).toHaveBeenCalledOnce();

			const request2 = new Request("http://localhost/api/details/CACHED");
			const response2 = await worker.fetch(request2, env, ctx);
			expect(response2.status).toBe(200);
			expect(await response2.text()).toBe(
				`CACHED,Cached Fund,EUR,42,,${emptyMetaAndStatsTail}`,
			);
			expect(response2.headers.get("CF-Cache-Status")).toBe("HIT");
			expect(globalThis.fetch).toHaveBeenCalledOnce();
		});

		it("should cache CSV and JSON independently", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({
					symbol: "BOTH",
					longName: "Both Formats",
					currency: "EUR",
					regularMarketPrice: 7,
				}),
			);

			// CSV request (cache miss)
			const csvResponse = await worker.fetch(
				new Request("http://localhost/api/details/BOTH"),
				env,
				ctx,
			);
			expect(csvResponse.headers.get("Content-Type")).toBe(
				"text/csv; charset=utf-8",
			);

			// JSON request (separate cache key, cache miss)
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({
					symbol: "BOTH",
					longName: "Both Formats",
					currency: "EUR",
					regularMarketPrice: 7,
				}),
			);
			const jsonResponse = await worker.fetch(
				new Request("http://localhost/api/details/BOTH?format=json"),
				env,
				ctx,
			);
			expect(jsonResponse.headers.get("Content-Type")).toBe("application/json");
			expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		});
	});

	describe("CORS", () => {
		let ctx: ExecutionContext;

		const corsEnv = {
			ALLOWED_ORIGINS: "https://app.example.com,https://sheets.example.org",
		};

		beforeEach(() => {
			vi.stubGlobal("fetch", vi.fn());
			ctx = createExecutionContext();
		});

		afterEach(async () => {
			await waitOnExecutionContext(ctx);
			vi.unstubAllGlobals();
		});

		it("should echo an allowed origin and merge Vary with Accept", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({
					symbol: "CORSALLOW",
					longName: "Cors Fund",
					currency: "EUR",
					regularMarketPrice: 10,
				}),
			);

			const request = new Request("http://localhost/api/details/CORSALLOW", {
				headers: { Origin: "https://app.example.com" },
			});
			const response = await worker.fetch(request, corsEnv, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://app.example.com",
			);
			expect(response.headers.get("Vary")).toBe("Accept, Origin");
		});

		it("should not send CORS headers for a disallowed origin but still vary", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({
					symbol: "CORSDENY",
					longName: "Deny Fund",
					currency: "EUR",
					regularMarketPrice: 10,
				}),
			);

			const request = new Request("http://localhost/api/details/CORSDENY", {
				headers: { Origin: "https://evil.example.com" },
			});
			const response = await worker.fetch(request, corsEnv, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
			expect(response.headers.get("Vary")).toBe("Accept, Origin");
		});

		it("should handle OPTIONS preflight for an allowed origin", async () => {
			const request = new Request("http://localhost/api/details/AAPL", {
				method: "OPTIONS",
				headers: { Origin: "https://app.example.com" },
			});
			const response = await worker.fetch(request, corsEnv, ctx);

			expect(response.status).toBe(204);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://app.example.com",
			);
			expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
				"GET, OPTIONS",
			);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});

		it("should reflect the requesting origin on a cache hit", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				chartResponse({
					symbol: "CORSCACHE",
					longName: "Cache Fund",
					currency: "EUR",
					regularMarketPrice: 5,
				}),
			);

			const request1 = new Request("http://localhost/api/details/CORSCACHE", {
				headers: { Origin: "https://app.example.com" },
			});
			const response1 = await worker.fetch(request1, corsEnv, ctx);
			expect(response1.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://app.example.com",
			);
			await response1.text();

			const request2 = new Request("http://localhost/api/details/CORSCACHE", {
				headers: { Origin: "https://sheets.example.org" },
			});
			const response2 = await worker.fetch(request2, corsEnv, ctx);
			expect(response2.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://sheets.example.org",
			);
			expect(globalThis.fetch).toHaveBeenCalledOnce();
		});
	});
});

describe("Search API", () => {
	interface MockQuote {
		symbol?: string;
		longname?: string;
		shortname?: string;
		quoteType?: string;
		exchange?: string;
		exchDisp?: string;
		isYahooFinance?: boolean;
	}

	const searchResponse = (quotes: MockQuote[]) => ({
		ok: true,
		json: async () => ({ quotes }),
	});

	const vwceQuote: MockQuote = {
		symbol: "VWCE.MI",
		longname: "Vanguard FTSE All-World UCITS ETF USD Accumulation",
		shortname: "Vanguard Ftse All-World Ucits E",
		quoteType: "ETF",
		exchange: "MIL",
		exchDisp: "Milan",
		isYahooFinance: true,
	};

	describe("GET /api/search", () => {
		let ctx: ExecutionContext;

		beforeEach(() => {
			vi.stubGlobal("fetch", vi.fn());
			ctx = createExecutionContext();
		});

		afterEach(async () => {
			// Wait for scheduled cache writes before restoring globals
			await waitOnExecutionContext(ctx);
			vi.unstubAllGlobals();
		});

		it("should return mapped JSON results", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				searchResponse([vwceQuote]),
			);

			const request = new Request("http://localhost/api/search?q=vwce");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("application/json");
			expect(response.headers.get("Vary")).toBe("Origin");
			expect(response.headers.get("Cache-Control")).toContain("max-age=");
			expect(await response.json()).toEqual({
				query: "vwce",
				results: [
					{
						symbol: "VWCE.MI",
						ticker: "VWCE",
						market: ".MI",
						description: "Vanguard FTSE All-World UCITS ETF USD Accumulation",
						quoteType: "ETF",
						exchange: "MIL",
						exchangeDisplay: "Milan",
					},
				],
			});
		});

		it("should query Yahoo's search endpoint without news or lists", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(searchResponse([]));

			await worker.fetch(
				new Request("http://localhost/api/search?q=MOCKQ"),
				env,
				ctx,
			);

			const [requestedUrl, init] = (globalThis.fetch as any).mock.calls[0];
			expect(requestedUrl).toContain("/v1/finance/search");
			expect(requestedUrl).toContain("q=MOCKQ");
			expect(requestedUrl).toContain("quotesCount=10");
			expect(requestedUrl).toContain("newsCount=0");
			expect(requestedUrl).toContain("listsCount=0");
			expect(init.headers["User-Agent"]).toBeTypeOf("string");
			expect(init.headers["User-Agent"]).not.toBe("");
		});

		it("should ignore a count parameter", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				searchResponse([vwceQuote]),
			);

			const response1 = await worker.fetch(
				new Request("http://localhost/api/search?q=COUNTQ&count=5"),
				env,
				ctx,
			);
			expect(response1.status).toBe(200);
			expect((globalThis.fetch as any).mock.calls[0][0]).toContain(
				"quotesCount=10",
			);
			await waitOnExecutionContext(ctx);

			// Same entry: count is not part of the query, so it changes nothing.
			const response2 = await worker.fetch(
				new Request("http://localhost/api/search?q=countq&count=50"),
				env,
				ctx,
			);
			expect(response2.status).toBe(200);
			expect(response2.headers.get("CF-Cache-Status")).toBe("HIT");
			expect(globalThis.fetch).toHaveBeenCalledOnce();
		});

		it("should split a US symbol into ticker and empty market", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				searchResponse([
					{
						symbol: "AAPL",
						shortname: "Apple Inc.",
						quoteType: "EQUITY",
						exchange: "NMS",
						exchDisp: "NASDAQ",
						isYahooFinance: true,
					},
				]),
			);

			const response = await worker.fetch(
				new Request("http://localhost/api/search?q=USQ"),
				env,
				ctx,
			);

			const body = (await response.json()) as {
				results: Array<{ ticker: string; market: string }>;
			};
			expect(body.results[0].ticker).toBe("AAPL");
			expect(body.results[0].market).toBe("");
		});

		it("should fall back from longname to shortname", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				searchResponse([
					{
						symbol: "SHORT.MI",
						shortname: "Short Name Only",
						isYahooFinance: true,
					},
				]),
			);

			const response = await worker.fetch(
				new Request("http://localhost/api/search?q=SHORTQ"),
				env,
				ctx,
			);

			const body = (await response.json()) as {
				results: Array<{ description: string }>;
			};
			expect(body.results[0].description).toBe("Short Name Only");
		});

		it("should drop non-Yahoo and symbol-less entries", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				searchResponse([
					{ symbol: "US0378331005", isYahooFinance: false },
					{ exchange: "NMS", quoteType: "EQUITY" },
					vwceQuote,
				]),
			);

			const response = await worker.fetch(
				new Request("http://localhost/api/search?q=FILTERQ"),
				env,
				ctx,
			);

			const body = (await response.json()) as {
				results: Array<{ symbol: string }>;
			};
			expect(body.results.map((result) => result.symbol)).toEqual(["VWCE.MI"]);
		});

		it("should return an empty result list when Yahoo has no matches", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(searchResponse([]));

			const response = await worker.fetch(
				new Request("http://localhost/api/search?q=EMPTYQ"),
				env,
				ctx,
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				query: "emptyq",
				results: [],
			});
		});

		it("should normalize the query to share one cache entry", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				searchResponse([vwceQuote]),
			);

			const response1 = await worker.fetch(
				new Request("http://localhost/api/search?q=CACHEQ"),
				env,
				ctx,
			);
			expect(response1.status).toBe(200);
			expect(globalThis.fetch).toHaveBeenCalledOnce();
			// The cache write is scheduled in waitUntil; drain it before the
			// second request or the read races the write.
			await waitOnExecutionContext(ctx);

			const response2 = await worker.fetch(
				new Request("http://localhost/api/search?q=cacheq"),
				env,
				ctx,
			);
			expect(response2.status).toBe(200);
			expect(response2.headers.get("CF-Cache-Status")).toBe("HIT");
			expect(globalThis.fetch).toHaveBeenCalledOnce();
		});

		it("should reject a missing, blank or oversized query", async () => {
			for (const path of [
				"/api/search",
				"/api/search?q=%20%20",
				`/api/search?q=${"a".repeat(65)}`,
			]) {
				const response = await worker.fetch(
					new Request(`http://localhost${path}`),
					env,
					ctx,
				);

				expect(response.status).toBe(400);
				expect(response.headers.get("Content-Type")).toBe("application/json");
				expect(response.headers.get("Cache-Control")).toBe("no-store");
			}

			expect(globalThis.fetch).not.toHaveBeenCalled();
		});

		it("should return a JSON 500 when Yahoo fails", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 429,
			});

			const response = await worker.fetch(
				new Request("http://localhost/api/search?q=FAILQ"),
				env,
				ctx,
			);

			expect(response.status).toBe(500);
			expect(response.headers.get("Content-Type")).toBe("application/json");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(await response.json()).toEqual({
				error: "Error fetching search: Yahoo Finance API error: 429",
			});
		});

		it("should only respond to GET requests", async () => {
			const response = await worker.fetch(
				new Request("http://localhost/api/search?q=POSTQ", {
					method: "POST",
				}),
				env,
				ctx,
			);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		});
	});

	describe("CORS", () => {
		let ctx: ExecutionContext;

		const corsEnv = {
			ALLOWED_ORIGINS: "https://app.example.com",
		};

		beforeEach(() => {
			vi.stubGlobal("fetch", vi.fn());
			ctx = createExecutionContext();
		});

		afterEach(async () => {
			await waitOnExecutionContext(ctx);
			vi.unstubAllGlobals();
		});

		it("should echo an allowed origin and set Vary: Origin", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(searchResponse([]));

			const response = await worker.fetch(
				new Request("http://localhost/api/search?q=CORSQ", {
					headers: { Origin: "https://app.example.com" },
				}),
				corsEnv,
				ctx,
			);

			expect(response.status).toBe(200);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://app.example.com",
			);
			expect(response.headers.get("Vary")).toBe("Origin");
		});

		it("should answer an OPTIONS preflight", async () => {
			const response = await worker.fetch(
				new Request("http://localhost/api/search?q=OPTIONSQ", {
					method: "OPTIONS",
					headers: { Origin: "https://app.example.com" },
				}),
				corsEnv,
				ctx,
			);

			expect(response.status).toBe(204);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://app.example.com",
			);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});
	});
});

describe("Integration Tests", () => {
	// Mocked unit tests use throwaway symbols (e.g. MOCK.MI), leaving real
	// symbols like VWCE.MI free for these live tests. That matters because the
	// Cache API is not reset between tests: a live test sharing a symbol with a
	// unit test would read that test's mocked cache entry instead of Yahoo.
	const liveSymbol = "VWCE.MI";

	describe("Real Yahoo Finance API", () => {
		it("should fetch real quote for VWCE.MI", { timeout: 10000 }, async () => {
			const ctx = createExecutionContext();

			const request = new Request(`http://localhost/api/quotes/${liveSymbol}`);
			const response = await worker.fetch(request, env, ctx);

			const responseText = await response.text();

			expect(response.status).toBe(200);
			const price = Number.parseFloat(responseText);

			expect(price).toBeGreaterThan(0);
			expect(Number.isNaN(price)).toBe(false);
			expect(response.headers.get("Content-Type")).toBe("text/plain");
			expect(response.headers.get("Cache-Control")).toContain("max-age=");
		});

		it(
			"should fetch real details for VWCE.MI",
			{ timeout: 10000 },
			async () => {
				const ctx = createExecutionContext();

				// Field-level assertions go through JSON: the description is
				// mutable and may contain commas, so splitting the CSV row on
				// commas would be a fragile parse.
				const request = new Request(
					`http://localhost/api/details/${liveSymbol}?format=json`,
				);
				const response = await worker.fetch(request, env, ctx);

				expect(response.status).toBe(200);
				expect(response.headers.get("Content-Type")).toBe("application/json");

				const body = JSON.parse(await response.text());
				expect(body.symbol).toBe(liveSymbol);
				expect(body.description).toContain("Vanguard");
				expect(body.currency).toBe("EUR");
				expect(body.price).toBeGreaterThan(0);
				expect(body.changePercent).toBeTypeOf("number");
				expect(body.marketTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
				expect(body.firstTradeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
				expect(body.chartPreviousClose).toBeGreaterThan(0);
				expect(body.volatility).toBeGreaterThan(0);
				expect(body.return1y).toBeTypeOf("number");
				expect(body.maxDrawdown).toBeLessThanOrEqual(0);
				expect(body.sma50).toBeGreaterThan(0);
				expect(body.sma200).toBeGreaterThan(0);
				expect(body.distanceFromSma50).toBeTypeOf("number");
				expect(body.distanceFromSma200).toBeTypeOf("number");
				expect(body.fiftyTwoWeekHighDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
				expect(body.fiftyTwoWeekLowDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
				expect(body.averageVolume).toBeGreaterThan(0);
			},
		);

		it("should serve real details as CSV", { timeout: 10000 }, async () => {
			const ctx = createExecutionContext();

			const response = await worker.fetch(
				new Request(`http://localhost/api/details/${liveSymbol}`),
				env,
				ctx,
			);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(
				"text/csv; charset=utf-8",
			);
			// No comma-splitting: just confirm the row leads with the symbol.
			expect((await response.text()).startsWith(`${liveSymbol},`)).toBe(true);
		});

		it("should search real symbols", { timeout: 10000 }, async () => {
			const ctx = createExecutionContext();

			const response = await worker.fetch(
				new Request("http://localhost/api/search?q=vwce"),
				env,
				ctx,
			);

			expect(response.status).toBe(200);
			const body = JSON.parse(await response.text());
			const symbols = body.results.map(
				(result: { symbol: string }) => result.symbol,
			);
			expect(symbols).toContain(liveSymbol);
		});
	});
});
