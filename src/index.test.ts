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
			(global.fetch as any).mockResolvedValueOnce({
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
			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => ({ chart: { result: [{ meta: {} }] } }),
			});

			const request = new Request("http://localhost/api/quotes/INVALID");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Price not available");
		});

		it("should return 500 when Yahoo Finance API fails", async () => {
			// Mock API error response
			(global.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const request = new Request("http://localhost/api/quotes/AAPL");
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(500);
			expect(await response.text()).toContain("Error fetching quote");
		});

		it("should use custom cache TTL from environment", async () => {
			const customEnv = { CACHE_TTL: "600" };

			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(100.5),
			});

			const request = new Request("http://localhost/api/quotes/TSLA");
			const response = await worker.fetch(request, customEnv, ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("public, max-age=600");
		});

		it("should use default cache TTL when not specified", async () => {
			(global.fetch as any).mockResolvedValueOnce({
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
			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(175.5),
			});

			const request1 = new Request("http://localhost/api/quotes/MSFT");
			const response1 = await worker.fetch(request1, env, ctx);

			expect(response1.status).toBe(200);
			expect(await response1.text()).toBe("175.5");
			expect(global.fetch).toHaveBeenCalledOnce();

			// Second request - should hit cache
			const request2 = new Request("http://localhost/api/quotes/MSFT");
			const response2 = await worker.fetch(request2, env, ctx);

			expect(response2.status).toBe(200);
			expect(await response2.text()).toBe("175.5");
			expect(response2.headers.get("CF-Cache-Status")).toBe("HIT");
			// Should still be called only once (cache hit)
			expect(global.fetch).toHaveBeenCalledOnce();
		});

		it("should handle cache with different symbols independently", async () => {
			// First request (cache miss)
			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(150.25),
			});

			const request1 = new Request("http://localhost/api/quotes/AMZN");
			const response1 = await worker.fetch(request1, env, ctx);

			expect(response1.status).toBe(200);
			expect(await response1.text()).toBe("150.25");

			// Second request, different symbol (cache miss)
			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(2500.75),
			});

			const request2 = new Request("http://localhost/api/quotes/NVDA");
			const response2 = await worker.fetch(request2, env, ctx);

			expect(response2.status).toBe(200);
			expect(await response2.text()).toBe("2500.75");

			// Verify fetch was called twice (once per symbol)
			expect(global.fetch).toHaveBeenCalledTimes(2);
		});
	});

	describe("Other routes", () => {
		it("should return 404 for unknown routes", async () => {
			const mockContext = {
				waitUntil: async (promise: Promise<any>) => {
					await promise;
				},
				passThroughOnException: vi.fn(),
			} as any;

			const request = new Request("http://localhost/unknown");
			const response = await worker.fetch(request, env, mockContext);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		});

		it("should return 404 for root path", async () => {
			const mockContext = {
				waitUntil: async (promise: Promise<any>) => {
					await promise;
				},
				passThroughOnException: vi.fn(),
			} as any;

			const request = new Request("http://localhost/");
			const response = await worker.fetch(request, env, mockContext);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		});
	});
});

describe("Integration Tests", () => {
	describe("Real Yahoo Finance API", () => {
		it("should fetch real quote for VWCE.MI", { timeout: 10000 }, async () => {
			const mockContext = {
				waitUntil: async (promise: Promise<any>) => {
					await promise;
				},
				passThroughOnException: vi.fn(),
			} as any;

			const request = new Request("http://localhost/api/quotes/VWCE.MI");
			const response = await worker.fetch(request, env, mockContext);

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
