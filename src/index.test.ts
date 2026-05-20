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

		afterEach(() => {
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
	});

	describe("Outbound request headers and host", () => {
		let ctx: ExecutionContext;

		beforeEach(() => {
			vi.stubGlobal("fetch", vi.fn());
			ctx = createExecutionContext();
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("should send all expected browser-like headers", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(100),
			});

			const request = new Request("http://localhost/api/quotes/HDR_TEST");
			await worker.fetch(request, env, ctx);

			const [_url, init] = (globalThis.fetch as any).mock.calls[0];
			const headers = init.headers as Record<string, string>;

			expect(headers["User-Agent"]).toBeTruthy();
			expect(headers["Accept"]).toBe(
				"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			);
			expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
			expect(headers["Accept-Encoding"]).toBe("gzip, deflate, br");
			expect(headers["Referer"]).toBe("https://finance.yahoo.com/");
			expect(headers["Origin"]).toBe("https://finance.yahoo.com");
		});

		it("should send a User-Agent from the known pool", async () => {
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(100),
			});

			const request = new Request("http://localhost/api/quotes/UA_TEST");
			await worker.fetch(request, env, ctx);

			const [_url, init] = (globalThis.fetch as any).mock.calls[0];
			const ua = (init.headers as Record<string, string>)["User-Agent"];

			const knownUAs = [
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
			];
			expect(knownUAs).toContain(ua);
		});

		it("should use query1 host when Math.random returns 0", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0);
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(100),
			});

			const request = new Request("http://localhost/api/quotes/Q1_TEST");
			await worker.fetch(request, env, ctx);

			const [url] = (globalThis.fetch as any).mock.calls[0];
			expect(url).toContain("query1.finance.yahoo.com");
		});

		it("should use query2 host when Math.random returns 0.9", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.9);
			(globalThis.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(100),
			});

			const request = new Request("http://localhost/api/quotes/Q2_TEST");
			await worker.fetch(request, env, ctx);

			const [url] = (globalThis.fetch as any).mock.calls[0];
			expect(url).toContain("query2.finance.yahoo.com");
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
	});
});
