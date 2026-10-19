import { describe, expect, it } from "vitest";
import {
	computeCandleStats,
	formatExchangeDate,
	formatIsoTimestamp,
	type YahooChartResult,
} from "./stats";

function chart(
	closes: number[],
	meta: YahooChartResult["meta"] = {},
	overrides: Partial<{
		high: (number | null)[];
		low: (number | null)[];
		close: (number | null)[];
		volume: (number | null)[];
		adjclose: (number | null)[];
	}> = {},
): YahooChartResult {
	const start = Date.UTC(2024, 0, 1) / 1000;
	return {
		meta,
		timestamp: closes.map((_, i) => start + i * 86_400),
		indicators: {
			quote: [
				{
					high: overrides.high ?? closes.map((c) => c + 1),
					low: overrides.low ?? closes.map((c) => c - 1),
					close: overrides.close ?? closes,
					volume: overrides.volume ?? closes.map(() => 1000),
				},
			],
			adjclose: [{ adjclose: overrides.adjclose ?? closes }],
		},
	};
}

describe("formatExchangeDate", () => {
	it("formats a timestamp in the exchange timezone", () => {
		// 2026-10-18T23:00:00Z is already 2026-10-19 in Sydney.
		const timestamp = Date.UTC(2026, 9, 18, 23, 0, 0) / 1000;

		expect(formatExchangeDate(timestamp, "Australia/Sydney")).toBe(
			"2026-10-19",
		);
		expect(formatExchangeDate(timestamp, "UTC")).toBe("2026-10-18");
	});

	it("falls back to UTC for an unknown timezone", () => {
		const timestamp = Date.UTC(2026, 9, 18, 23, 0, 0) / 1000;

		expect(formatExchangeDate(timestamp, "Not/AZone")).toBe("2026-10-18");
	});

	it("returns null for a missing or invalid timestamp", () => {
		expect(formatExchangeDate(undefined)).toBeNull();
		expect(formatExchangeDate(Number.NaN)).toBeNull();
	});
});

describe("formatIsoTimestamp", () => {
	it("formats epoch seconds as ISO 8601 UTC", () => {
		expect(formatIsoTimestamp(1_792_424_111)).toBe("2026-10-19T15:35:11.000Z");
	});

	it("returns null for a missing timestamp", () => {
		expect(formatIsoTimestamp(undefined)).toBeNull();
		expect(formatIsoTimestamp(Number.NaN)).toBeNull();
	});
});

describe("computeCandleStats", () => {
	it("returns all nulls when there is no candle data", () => {
		expect(computeCandleStats({ meta: {} })).toEqual({
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

	it("computes zero volatility, return and drawdown for a flat series", () => {
		const stats = computeCandleStats(
			chart(
				Array.from({ length: 60 }, () => 100),
				{
					regularMarketPrice: 100,
					exchangeTimezoneName: "UTC",
				},
			),
		);

		expect(stats.volatility).toBe(0);
		expect(stats.return1y).toBe(0);
		expect(stats.maxDrawdown).toBe(0);
		expect(stats.sma50).toBe(100);
		expect(stats.distanceFromSma50).toBe(0);
		expect(stats.sma200).toBeNull();
		expect(stats.distanceFromSma200).toBeNull();
	});

	it("computes max drawdown from a running peak", () => {
		const stats = computeCandleStats(
			chart([100, 120, 90, 110], {
				regularMarketPrice: 110,
				exchangeTimezoneName: "UTC",
			}),
		);

		expect(stats.return1y).toBe(10);
		expect(stats.maxDrawdown).toBe(-25);
		// Fewer than 60 returns, so volatility stays withheld.
		expect(stats.volatility).toBeNull();
	});

	it("computes annualized volatility to one decimal from 60+ closes", () => {
		const closes = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i);
		const stats = computeCandleStats(chart(closes));

		expect(stats.volatility).not.toBeNull();
		// All returns are identical, so the sample deviation is zero.
		expect(stats.volatility).toBe(0);
	});

	it("skips null closes instead of treating them as zero", () => {
		const closes = [100, 110, null, 105, 120, null, 115];
		const stats = computeCandleStats(
			chart(
				closes as number[],
				{ regularMarketPrice: 115 },
				{
					close: closes,
					adjclose: closes,
				},
			),
		);

		expect(stats.return1y).toBe(15);
		expect(stats.maxDrawdown).toBeCloseTo((105 / 110 - 1) * 100, 2);
	});

	it("withholds volatility below 60 valid closes", () => {
		const closes = Array.from({ length: 59 }, (_, i) => 100 + i);
		const stats = computeCandleStats(chart(closes));

		expect(stats.volatility).toBeNull();
		expect(stats.sma50).not.toBeNull();
		expect(stats.return1y).not.toBeNull();
	});

	it("withholds SMAs until enough closes are available", () => {
		const stats49 = computeCandleStats(
			chart(Array.from({ length: 49 }, () => 10)),
		);
		const stats50 = computeCandleStats(
			chart(Array.from({ length: 50 }, () => 10)),
		);
		const stats199 = computeCandleStats(
			chart(Array.from({ length: 199 }, () => 10)),
		);

		expect(stats49.sma50).toBeNull();
		expect(stats49.distanceFromSma50).toBeNull();
		expect(stats50.sma50).toBe(10);
		expect(stats199.sma200).toBeNull();
	});

	it("computes the distance from each SMA as a percentage", () => {
		const closes = Array.from({ length: 200 }, () => 100);
		const stats = computeCandleStats(
			chart(closes, { regularMarketPrice: 105 }),
		);

		expect(stats.sma200).toBe(100);
		expect(stats.distanceFromSma50).toBe(5);
		expect(stats.distanceFromSma200).toBe(5);
	});

	it("dates the 52-week high and low from daily highs and lows", () => {
		const stats = computeCandleStats(
			chart(
				Array.from({ length: 3 }, () => 100),
				{ exchangeTimezoneName: "UTC" },
				{
					high: [101, 130, 105],
					low: [99, 98, 80],
				},
			),
		);

		// Bars are one day apart starting 2024-01-01.
		expect(stats.fiftyTwoWeekHighDate).toBe("2024-01-02");
		expect(stats.fiftyTwoWeekLowDate).toBe("2024-01-03");
	});

	it("averages non-null daily volumes and rounds to an integer", () => {
		const stats = computeCandleStats(
			chart(
				[100, 100, 100],
				{},
				{
					volume: [1000, null, 2001],
				},
			),
		);

		expect(stats.averageVolume).toBe(1501);
	});
});
