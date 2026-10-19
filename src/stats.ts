/** Subset of Yahoo Finance chart `meta` used by the details response. */
export interface YahooMeta {
	symbol?: string;
	longName?: string;
	shortName?: string;
	currency?: string;
	regularMarketPrice?: number;
	regularMarketChangePercent?: number;
	regularMarketDayHigh?: number;
	regularMarketDayLow?: number;
	regularMarketVolume?: number;
	fiftyTwoWeekHigh?: number;
	fiftyTwoWeekLow?: number;
	chartPreviousClose?: number;
	instrumentType?: string;
	exchangeName?: string;
	exchangeTimezoneName?: string;
	regularMarketTime?: number;
	firstTradeDate?: number;
}

export interface YahooQuoteSeries {
	high?: (number | null)[];
	low?: (number | null)[];
	close?: (number | null)[];
	volume?: (number | null)[];
}

/** `chart.result[0]`, the shape `getYahooChart` returns. */
export interface YahooChartResult {
	meta?: YahooMeta;
	timestamp?: number[];
	indicators?: {
		quote?: YahooQuoteSeries[];
		adjclose?: Array<{ adjclose?: (number | null)[] }>;
	};
}

export interface CandleStats {
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

const MIN_VOLATILITY_BARS = 60;
const TRADING_DAYS_PER_YEAR = 252;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanOfLast(values: number[], count: number): number | null {
	if (values.length < count) return null;
	return mean(values.slice(-count));
}

function formatDateInZone(date: Date, timeZone: string): string | null {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const parts = formatter.formatToParts(date);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((entry) => entry.type === type)?.value;

	const year = part("year");
	const month = part("month");
	const day = part("day");
	if (!year || !month || !day) return null;

	return `${year}-${month}-${day}`;
}

/**
 * Formats epoch seconds as `YYYY-MM-DD` in the exchange timezone, falling back
 * to UTC for a missing or unrecognized timezone. The timezone matters: a
 * session that opens late in the UTC day (e.g. Sydney) belongs to the next
 * local date.
 */
export function formatExchangeDate(
	epochSeconds: number | null | undefined,
	timeZone?: string,
): string | null {
	if (!isFiniteNumber(epochSeconds)) return null;

	const date = new Date(epochSeconds * 1000);
	if (Number.isNaN(date.getTime())) return null;

	try {
		return formatDateInZone(date, timeZone || "UTC");
	} catch {
		return formatDateInZone(date, "UTC");
	}
}

/** Formats epoch seconds as ISO 8601 in UTC, or `null` when missing. */
export function formatIsoTimestamp(
	epochSeconds: number | null | undefined,
): string | null {
	if (!isFiniteNumber(epochSeconds)) return null;

	const date = new Date(epochSeconds * 1000);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Annualized standard deviation of daily log returns. Withheld below
 * `MIN_VOLATILITY_BARS` closes, since a short window is not a usable estimate.
 */
function annualizedVolatility(values: number[]): number | null {
	if (values.length < MIN_VOLATILITY_BARS) return null;

	const returns: number[] = [];
	for (let i = 1; i < values.length; i++) {
		const previous = values[i - 1];
		const current = values[i];
		if (previous <= 0 || current <= 0) continue;
		returns.push(Math.log(current / previous));
	}
	if (returns.length < 2) return null;

	const average = mean(returns);
	const variance =
		returns.reduce((sum, value) => sum + (value - average) ** 2, 0) /
		(returns.length - 1);

	return round(Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100, 1);
}

/** Total return over the series, in percent points. */
function totalReturn(values: number[]): number | null {
	if (values.length < 2) return null;

	const first = values[0];
	const last = values[values.length - 1];
	if (first <= 0) return null;

	return round((last / first - 1) * 100, 2);
}

/** Largest peak-to-trough fall as a negative percentage. */
function maxDrawdown(values: number[]): number | null {
	if (values.length < 2) return null;

	let peak = values[0];
	let worst = 0;
	for (const value of values) {
		if (value > peak) peak = value;
		if (peak <= 0) continue;
		worst = Math.min(worst, value / peak - 1);
	}

	return round(worst * 100, 2);
}

function smaAndDistance(
	closes: number[],
	days: number,
	price: number | undefined,
): { sma: number | null; distance: number | null } {
	const sma = meanOfLast(closes, days);
	if (sma === null) return { sma: null, distance: null };

	const distance =
		isFiniteNumber(price) && sma !== 0
			? round((price / sma - 1) * 100, 2)
			: null;

	return { sma: round(sma, 4), distance };
}

function extremeDate(
	timestamps: number[],
	values: (number | null)[] | undefined,
	mode: "max" | "min",
	timeZone: string | undefined,
): string | null {
	if (!values) return null;

	let extreme: number | null = null;
	let timestamp: number | null = null;
	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		const barTimestamp = timestamps[i];
		if (!isFiniteNumber(value) || !isFiniteNumber(barTimestamp)) continue;

		if (
			extreme === null ||
			(mode === "max" ? value > extreme : value < extreme)
		) {
			extreme = value;
			timestamp = barTimestamp;
		}
	}

	return formatExchangeDate(timestamp, timeZone);
}

/**
 * Computes the 52-week statistics from the daily candles. Returns, drawdown and
 * volatility use `adjclose` so distributions do not show up as price drops;
 * SMAs and their distances use `close`, which is comparable to the live price.
 * Today's partial bar is included, so intraday values can move until the close.
 */
export function computeCandleStats(chart: YahooChartResult): CandleStats {
	const quote = chart.indicators?.quote?.[0];
	const timestamps = chart.timestamp ?? [];
	const adjusted = (chart.indicators?.adjclose?.[0]?.adjclose ?? []).filter(
		isFiniteNumber,
	);
	const closes = (quote?.close ?? []).filter(isFiniteNumber);
	const volumes = (quote?.volume ?? []).filter(isFiniteNumber);
	const price = chart.meta?.regularMarketPrice;
	const timeZone = chart.meta?.exchangeTimezoneName;

	const sma50 = smaAndDistance(closes, 50, price);
	const sma200 = smaAndDistance(closes, 200, price);

	return {
		volatility: annualizedVolatility(adjusted),
		return1y: totalReturn(adjusted),
		maxDrawdown: maxDrawdown(adjusted),
		sma50: sma50.sma,
		distanceFromSma50: sma50.distance,
		sma200: sma200.sma,
		distanceFromSma200: sma200.distance,
		fiftyTwoWeekHighDate: extremeDate(timestamps, quote?.high, "max", timeZone),
		fiftyTwoWeekLowDate: extremeDate(timestamps, quote?.low, "min", timeZone),
		averageVolume: volumes.length > 0 ? Math.round(mean(volumes)) : null,
	};
}
