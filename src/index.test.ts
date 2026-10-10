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
