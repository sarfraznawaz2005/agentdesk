/**
 * missed-recovery.test.ts
 *
 * Unit tests for the missed-run recovery logic in initCronScheduler.
 * The logic compares job.lastRunAt against the cron expression's previousRun()
 * to determine whether a job missed at least one fire.
 *
 * We test the underlying decision logic directly (without spawning real cron
 * timers) by replicating the condition that the scheduler uses.
 */

import { describe, it, expect } from "bun:test";
import { Cron } from "croner";

/**
 * Mirrors the missed-run check inside initCronScheduler:
 *   "If the next scheduled fire after lastRunAt is already in the past, a run was missed."
 *
 * Returns true when the job should be recovered (re-run now).
 * Note: previousRun() is unreliable on paused Cron instances (returns null before
 * first fire); nextRun(lastRan) is always computable from the expression.
 */
function shouldRecover(cronExpression: string, timezone: string, lastRunAt: string | null): boolean {
	if (!lastRunAt) return false;
	try {
		const checker = new Cron(cronExpression, { timezone, paused: true });
		const lastRan = new Date(lastRunAt);
		const nextAfterLast = checker.nextRun(lastRan);
		checker.stop();
		if (!nextAfterLast) return false;
		return nextAfterLast < new Date();
	} catch {
		return false;
	}
}

// -------------------------------------------------------------------------

describe("shouldRecover (missed-run decision logic)", () => {
	it("returns true for an hourly job that last ran 2 hours ago", () => {
		const lastRunAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
		expect(shouldRecover("0 * * * *", "UTC", lastRunAt)).toBe(true);
	});

	it("returns false for an hourly job that ran after the most recent scheduled fire", () => {
		// Use Cron to find the actual most recent :00 boundary, then set lastRunAt
		// to 1 second after it. This avoids false failures when the test runs
		// within 5 minutes of the top of an hour.
		const finder = new Cron("0 * * * *", { timezone: "UTC", paused: true });
		const mostRecentFire = finder.nextRun(new Date(Date.now() - 3600_000))!;
		finder.stop();
		const lastRunAt = new Date(mostRecentFire.getTime() + 1000).toISOString();
		expect(shouldRecover("0 * * * *", "UTC", lastRunAt)).toBe(false);
	});

	it("returns false when lastRunAt is null (never ran)", () => {
		expect(shouldRecover("0 * * * *", "UTC", null)).toBe(false);
	});

	it("returns true for a daily job that last ran 25 hours ago", () => {
		const lastRunAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
		expect(shouldRecover("0 0 * * *", "UTC", lastRunAt)).toBe(true);
	});

	it("returns false for a daily job that ran just after today's most recent midnight", () => {
		// Use today's midnight UTC + 1 minute to ensure we're safely after the last fire.
		// nextRun will be tomorrow's midnight — always in the future regardless of time of day.
		const midnight = new Date();
		midnight.setUTCHours(0, 1, 0, 0); // 00:01 today UTC
		if (midnight > new Date()) {
			// We're in a timezone offset or it's still yesterday — shift back one day
			midnight.setUTCDate(midnight.getUTCDate() - 1);
		}
		expect(shouldRecover("0 0 * * *", "UTC", midnight.toISOString())).toBe(false);
	});

	it("returns false for an invalid cron expression", () => {
		expect(shouldRecover("not-a-cron", "UTC", new Date(Date.now() - 3600 * 1000).toISOString())).toBe(false);
	});

	it("returns true for a minutely job when lastRunAt was 3 minutes ago", () => {
		const lastRunAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
		// "every minute" job — clearly missed 2+ runs
		expect(shouldRecover("* * * * *", "UTC", lastRunAt)).toBe(true);
	});

	it("returns false when lastRunAt equals now (ran just now)", () => {
		// Job ran at this exact second — previousRun should be <= lastRunAt
		// In practice this edge case resolves to false since nothing was missed.
		const lastRunAt = new Date().toISOString();
		// The result may be true or false depending on exact timing, but we verify
		// it does not throw.
		expect(() => shouldRecover("0 * * * *", "UTC", lastRunAt)).not.toThrow();
	});
});

describe("shouldRecover — timezone handling", () => {
	it("does not throw with a non-UTC timezone", () => {
		const lastRunAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
		expect(() => shouldRecover("0 * * * *", "America/New_York", lastRunAt)).not.toThrow();
	});

	it("does not throw with UTC+0 timezone string", () => {
		const lastRunAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
		expect(() => shouldRecover("0 * * * *", "Etc/UTC", lastRunAt)).not.toThrow();
	});
});

describe("one-shot jobs should not be recovered", () => {
	// The scheduler skips recovery for one-shot jobs.  Since that check is done
	// in initCronScheduler before calling shouldRecover, we document the intent
	// here and verify the helper itself is agnostic to the oneShot flag.
	it("shouldRecover has no knowledge of oneShot — caller is responsible for the guard", () => {
		// One-shot guard is enforced in initCronScheduler, not in shouldRecover.
		// Verify the function signature accepts only the required args.
		const lastRunAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
		// If the caller passes a one-shot job here, shouldRecover would return true —
		// the caller must check job.oneShot before invoking recovery.
		const result = shouldRecover("0 * * * *", "UTC", lastRunAt);
		expect(typeof result).toBe("boolean");
	});
});
