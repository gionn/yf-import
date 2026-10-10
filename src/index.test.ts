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

		const detailsMeta = {
			symbol: "VWCE.MI",
			longName: "Vanguard FTSE All-World UCITS ETF USD Accumulation",
			currency: "EUR",
			regularMarketPrice: 172.89,
			fiftyTwoWeekHigh: 173.98,
			fiftyTwoWeekLow: 138.2,
		};

		const metaResponse = (meta: Record<string, unknown>) => ({
			ok: true,
			json: async () => ({ chart: { result: [{ meta }] } }),
		});

		it("should return a single CSV row with all fields", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				metaResponse(detailsMeta),
			);

			const request = new Request("http://localhost/api/details/VWCE.MI");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(
				"text/csv; charset=utf-8",
			);
			expect(response.headers.get("Vary")).toBe("Accept");
			expect(await response.text()).toBe(
				"VWCE.MI,Vanguard FTSE All-World UCITS ETF USD Accumulation,EUR,172.89,173.98,138.2",
			);
			expect(response.headers.get("Cache-Control")).toContain("max-age=");
		});

		it("should fall back to shortName for description", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				metaResponse({
					symbol: "XYZ",
					shortName: "Short Name",
					currency: "USD",
					regularMarketPrice: 10,
				}),
			);

			const request = new Request("http://localhost/api/details/XYZ");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("XYZ,Short Name,USD,10,,");
		});

		it("should fall back to the symbol when no name is available", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				metaResponse({ currency: "USD", regularMarketPrice: 5 }),
			);

			const request = new Request("http://localhost/api/details/NONAME");
			const response = await worker.fetch(request, env, ctx);

			expect(await response.text()).toBe("NONAME,NONAME,USD,5,,");
		});

		it("should escape commas and quotes in CSV fields", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				metaResponse({
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
				'ESC,"Vanguard ""Test"", Fund",EUR,1,2,3',
			);
		});

		it("should return JSON when format=json is requested", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				metaResponse(detailsMeta),
			);

			const request = new Request(
				"http://localhost/api/details/VWCE.MI?format=json",
			);
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("application/json");
			expect(JSON.parse(await response.text())).toEqual({
				symbol: "VWCE.MI",
				description: "Vanguard FTSE All-World UCITS ETF USD Accumulation",
				currency: "EUR",
				price: 172.89,
				fiftyTwoWeekHigh: 173.98,
				fiftyTwoWeekLow: 138.2,
			});
		});

		it("should return JSON when Accept: application/json is sent", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				metaResponse({
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
				metaResponse({ regularMarketPrice: 123.45 }),
			);

			const request = new Request("http://localhost/api/details/BIT:VWCE");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe(
				"http://localhost/api/details/VWCE.MI",
			);
		});

		it("should redirect when the rewritten symbol exists without a current price", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				metaResponse({ symbol: "VWCE.MI", currency: "EUR" }),
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
				metaResponse({
					symbol: "CACHED",
					longName: "Cached Fund",
					currency: "EUR",
					regularMarketPrice: 42,
				}),
			);

			const request1 = new Request("http://localhost/api/details/CACHED");
			const response1 = await worker.fetch(request1, env, ctx);
			expect(response1.status).toBe(200);
			expect(await response1.text()).toBe("CACHED,Cached Fund,EUR,42,,");
			expect(globalThis.fetch).toHaveBeenCalledOnce();

			const request2 = new Request("http://localhost/api/details/CACHED");
			const response2 = await worker.fetch(request2, env, ctx);
			expect(response2.status).toBe(200);
			expect(await response2.text()).toBe("CACHED,Cached Fund,EUR,42,,");
			expect(response2.headers.get("CF-Cache-Status")).toBe("HIT");
			expect(globalThis.fetch).toHaveBeenCalledOnce();
		});

		it("should cache CSV and JSON independently", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce(
				metaResponse({
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
				metaResponse({
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
});

describe("Integration Tests", () => {
	describe("Real Yahoo Finance API", () => {
		it("should fetch real quote for VWCE.MI", { timeout: 10000 }, async () => {
			const ctx = createExecutionContext();

			const request = new Request("http://localhost/api/quotes/VWCE.MI");
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

				const request = new Request("http://localhost/api/details/VWCE.MI");
				const response = await worker.fetch(request, env, ctx);

				expect(response.status).toBe(200);
				expect(response.headers.get("Content-Type")).toBe(
					"text/csv; charset=utf-8",
				);

				const fields = (await response.text()).split(",");
				expect(fields).toHaveLength(6);
				expect(fields[0]).toBe("VWCE.MI");
				expect(fields[1]).toContain("Vanguard");
				expect(fields[2]).toBe("EUR");
				expect(Number.parseFloat(fields[3])).toBeGreaterThan(0);
			},
		);
	});
});
