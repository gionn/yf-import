import { env } from "cloudflare:test";
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
		let mockCache: any;
		let mockContext: ExecutionContext;

		beforeEach(() => {
			// Mock fetch for unit tests
			vi.stubGlobal("fetch", vi.fn());

			// Mock caches.default
			mockCache = {
				match: vi.fn(),
				put: vi.fn(),
			};
			vi.stubGlobal("caches", { default: mockCache });

			// Mock ExecutionContext
			mockContext = {
				waitUntil: vi.fn(),
				passThroughOnException: vi.fn(),
			} as any;
		});

		afterEach(() => {
			// Properly restore globals
			vi.unstubAllGlobals();
		});

		it("should return stock price for valid symbol", async () => {
			// Mock cache miss
			mockCache.match.mockResolvedValueOnce(undefined);

			// Mock Yahoo Finance API response
			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(150.25),
			});

			const request = new Request("http://localhost/api/quotes/AAPL");
			const response = await worker.fetch(request, env, mockContext);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("150.25");
			expect(response.headers.get("Content-Type")).toBe("text/plain");
			expect(response.headers.get("Cache-Control")).toContain("max-age=");
			expect(mockCache.put).toHaveBeenCalledOnce();
		});

		it("should return 404 when price is not available", async () => {
			// Mock cache miss
			mockCache.match.mockResolvedValueOnce(undefined);

			// Mock API response with no price
			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => ({ chart: { result: [{ meta: {} }] } }),
			});

			const request = new Request("http://localhost/api/quotes/INVALID");
			const response = await worker.fetch(request, env, mockContext);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Price not available");
		});

		it("should return 500 when Yahoo Finance API fails", async () => {
			// Mock cache miss
			mockCache.match.mockResolvedValueOnce(undefined);

			// Mock API error response
			(global.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const request = new Request("http://localhost/api/quotes/AAPL");
			const response = await worker.fetch(request, env, mockContext);

			expect(response.status).toBe(500);
			expect(await response.text()).toContain("Error fetching quote");
		});

		it("should use custom cache TTL from environment", async () => {
			const customEnv = { CACHE_TTL: "600" };

			// Mock cache miss
			mockCache.match.mockResolvedValueOnce(undefined);

			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(100.5),
			});

			const request = new Request("http://localhost/api/quotes/TSLA");
			const response = await worker.fetch(request, customEnv, mockContext);

			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("public, max-age=600");
		});

		it("should use default cache TTL when not specified", async () => {
			// Mock cache miss
			mockCache.match.mockResolvedValueOnce(undefined);

			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(200.75),
			});

			const request = new Request("http://localhost/api/quotes/GOOGL");
			const response = await worker.fetch(request, {}, mockContext);

			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
		});

		it("should return cached response on cache hit", async () => {
			// Mock cached response
			const cachedResponse = new Response("175.50", {
				status: 200,
				headers: {
					"Content-Type": "text/plain",
					"Cache-Control": "public, max-age=300",
				},
			});
			mockCache.match.mockResolvedValueOnce(cachedResponse);

			const request = new Request("http://localhost/api/quotes/AAPL");
			const response = await worker.fetch(request, env, mockContext);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("175.50");
			// Should not call Yahoo API on cache hit
			expect(global.fetch).not.toHaveBeenCalled();
			// Should not put to cache again
			expect(mockCache.put).not.toHaveBeenCalled();
		});

		it("should handle cache with different symbols independently", async () => {
			// First request (cache miss)
			mockCache.match.mockResolvedValueOnce(undefined);
			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(150.25),
			});

			const request1 = new Request("http://localhost/api/quotes/AAPL");
			const response1 = await worker.fetch(request1, env, mockContext);

			expect(response1.status).toBe(200);
			expect(await response1.text()).toBe("150.25");

			// Second request, different symbol (cache miss)
			mockCache.match.mockResolvedValueOnce(undefined);
			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockYahooResponse(2500.75),
			});

			const request2 = new Request("http://localhost/api/quotes/GOOGL");
			const response2 = await worker.fetch(request2, env, mockContext);

			expect(response2.status).toBe(200);
			expect(await response2.text()).toBe("2500.75");

			// Verify cache.put was called twice
			expect(mockCache.put).toHaveBeenCalledTimes(2);
		});
	});

	describe("Other routes", () => {
		it("should return 404 for unknown routes", async () => {
			const mockContext = {
				waitUntil: vi.fn(),
				passThroughOnException: vi.fn(),
			} as any;

			const request = new Request("http://localhost/unknown");
			const response = await worker.fetch(request, env, mockContext);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		});

		it("should return 404 for root path", async () => {
			const mockContext = {
				waitUntil: vi.fn(),
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
				waitUntil: vi.fn(),
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
