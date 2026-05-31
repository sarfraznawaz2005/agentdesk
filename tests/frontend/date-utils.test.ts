/**
 * date-utils.test.ts
 *
 * Tests for pure date utility functions:
 *   - relativeTime        — short relative time string ("5m ago", "3h ago", etc.)
 *   - relativeTimeVerbose — date-fns based verbose version
 *   - formatDateTime      — locale-formatted date-time string
 *   - relativeTimeFuture  — future/past relative time with "in Xm" format
 *
 * These functions are pure with respect to the filesystem and have no
 * Electrobun or React dependencies, so they run directly in Bun.
 */

import { describe, it, expect } from "bun:test";

// date-utils.ts uses date-fns (a plain npm dep) — no mocks needed.
const {
	relativeTime,
	relativeTimeVerbose,
	formatDateTime,
	relativeTimeFuture,
} = await import("../../src/mainview/lib/date-utils");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoMinutesAgo(minutes: number): string {
	return new Date(Date.now() - minutes * 60_000).toISOString();
}

function isoHoursAgo(hours: number): string {
	return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function isoDaysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString();
}

function isoMinutesFromNow(minutes: number): string {
	// +500ms buffer so Math.floor in relativeTime* doesn't round down due to test execution time
	return new Date(Date.now() + minutes * 60_000 + 500).toISOString();
}

function isoHoursFromNow(hours: number): string {
	// +1s buffer so Math.floor in relativeTimeFuture doesn't round down due to test execution time
	return new Date(Date.now() + hours * 3_600_000 + 1_000).toISOString();
}

// SQLite-style datetime string (no T, no Z)
function sqliteDateTime(dateIso: string): string {
	return dateIso.replace("T", " ").replace(/\.\d+Z$/, "").replace("Z", "");
}

// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------

describe("relativeTime — null / undefined / invalid inputs", () => {
	it("returns '—' for null", () => {
		expect(relativeTime(null)).toBe("—");
	});

	it("returns '—' for undefined", () => {
		expect(relativeTime(undefined)).toBe("—");
	});

	it("returns '—' for an empty string", () => {
		expect(relativeTime("")).toBe("—");
	});

	it("returns '—' for an invalid date string", () => {
		expect(relativeTime("not-a-date")).toBe("—");
	});
});

describe("relativeTime — recent timestamps", () => {
	it("returns 'just now' for a timestamp less than 1 minute ago", () => {
		const thirty_seconds_ago = new Date(Date.now() - 30_000).toISOString();
		expect(relativeTime(thirty_seconds_ago)).toBe("just now");
	});

	it("returns 'just now' for a future timestamp (negative diff)", () => {
		const five_seconds_future = new Date(Date.now() + 5_000).toISOString();
		expect(relativeTime(five_seconds_future)).toBe("just now");
	});

	it("returns 'Xm ago' for timestamps 1–59 minutes ago", () => {
		expect(relativeTime(isoMinutesAgo(1))).toBe("1m ago");
		expect(relativeTime(isoMinutesAgo(5))).toBe("5m ago");
		expect(relativeTime(isoMinutesAgo(30))).toBe("30m ago");
		expect(relativeTime(isoMinutesAgo(59))).toBe("59m ago");
	});

	it("returns 'Xh ago' for timestamps 1–23 hours ago", () => {
		expect(relativeTime(isoHoursAgo(1))).toBe("1h ago");
		expect(relativeTime(isoHoursAgo(6))).toBe("6h ago");
		expect(relativeTime(isoHoursAgo(23))).toBe("23h ago");
	});

	it("returns 'Xd ago' for timestamps 1–6 days ago", () => {
		expect(relativeTime(isoDaysAgo(1))).toBe("1d ago");
		expect(relativeTime(isoDaysAgo(6))).toBe("6d ago");
	});

	it("returns a short date string for timestamps older than 7 days", () => {
		const old = isoDaysAgo(10);
		const result = relativeTime(old);
		// Should not be "just now", "Xm ago", "Xh ago", or "Xd ago"
		expect(result).not.toMatch(/ago$/);
		// Should be a locale date like "Mar 7" or similar
		expect(result.length).toBeGreaterThan(0);
		expect(result).not.toBe("—");
	});
});

describe("relativeTime — SQLite datetime format (no Z suffix)", () => {
	it("correctly parses a bare SQLite datetime string", () => {
		const sqlDate = sqliteDateTime(isoMinutesAgo(5));
		const result = relativeTime(sqlDate);
		expect(result).toBe("5m ago");
	});

	it("handles ISO strings with T separator and Z suffix", () => {
		const result = relativeTime(isoHoursAgo(2));
		expect(result).toBe("2h ago");
	});
});

// ---------------------------------------------------------------------------
// relativeTimeVerbose
// ---------------------------------------------------------------------------

describe("relativeTimeVerbose", () => {
	it("returns an empty string for null", () => {
		expect(relativeTimeVerbose(null)).toBe("");
	});

	it("returns an empty string for undefined", () => {
		expect(relativeTimeVerbose(undefined)).toBe("");
	});

	it("returns a non-empty string for a recent timestamp", () => {
		const result = relativeTimeVerbose(isoMinutesAgo(5));
		expect(result.length).toBeGreaterThan(0);
		// date-fns uses "about X minutes ago" style
		expect(result).toContain("ago");
	});

	it("does not throw for an invalid date string", () => {
		expect(() => relativeTimeVerbose("invalid")).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// formatDateTime
// ---------------------------------------------------------------------------

describe("formatDateTime", () => {
	it("returns '—' for null", () => {
		expect(formatDateTime(null)).toBe("—");
	});

	it("returns '—' for undefined", () => {
		expect(formatDateTime(undefined)).toBe("—");
	});

	it("returns '—' for an invalid date string", () => {
		expect(formatDateTime("not-a-date")).toBe("—");
	});

	it("returns a non-empty string for a valid ISO date", () => {
		const result = formatDateTime(new Date().toISOString());
		expect(result).not.toBe("—");
		expect(result.length).toBeGreaterThan(0);
	});

	it("includes both a month and time component", () => {
		// Use a well-known date to check for recognisable parts.
		// We cannot rely on locale-specific formatting strings, but we can
		// verify structure — the result should contain a colon (time) and a digit.
		const result = formatDateTime("2026-03-14T15:30:00Z");
		expect(result).toContain(":");  // time separator
		expect(/\d/.test(result)).toBe(true); // at least one digit
	});

	it("handles a SQLite-format datetime without Z suffix", () => {
		const result = formatDateTime("2026-03-14 15:30:00");
		expect(result).not.toBe("—");
	});
});

// ---------------------------------------------------------------------------
// relativeTimeFuture
// ---------------------------------------------------------------------------

describe("relativeTimeFuture", () => {
	it("returns '—' for null", () => {
		expect(relativeTimeFuture(null)).toBe("—");
	});

	it("returns '—' for undefined", () => {
		expect(relativeTimeFuture(undefined)).toBe("—");
	});

	it("returns '—' for an invalid date string", () => {
		expect(relativeTimeFuture("bad-date")).toBe("—");
	});

	it("returns 'just now' for a timestamp within 1 minute in the future", () => {
		const result = relativeTimeFuture(isoMinutesFromNow(0.5));
		expect(result).toBe("just now");
	});

	it("returns 'just now' for a timestamp within 1 minute in the past", () => {
		const result = relativeTimeFuture(isoMinutesAgo(0.5));
		expect(result).toBe("just now");
	});

	it("returns 'in Xm' for a timestamp X minutes in the future", () => {
		expect(relativeTimeFuture(isoMinutesFromNow(5))).toBe("in 5m");
		expect(relativeTimeFuture(isoMinutesFromNow(30))).toBe("in 30m");
	});

	it("returns 'in Xh' for a timestamp X hours in the future", () => {
		expect(relativeTimeFuture(isoHoursFromNow(2))).toBe("in 2h");
		expect(relativeTimeFuture(isoHoursFromNow(12))).toBe("in 12h");
	});

	it("returns 'Xm ago' for a timestamp that already passed by X minutes", () => {
		expect(relativeTimeFuture(isoMinutesAgo(10))).toBe("10m ago");
	});

	it("returns 'Xh ago' for a timestamp that already passed by X hours", () => {
		expect(relativeTimeFuture(isoHoursAgo(3))).toBe("3h ago");
	});

	it("returns 'Xd ago' for days-old timestamps", () => {
		expect(relativeTimeFuture(isoDaysAgo(2))).toBe("2d ago");
	});
});
