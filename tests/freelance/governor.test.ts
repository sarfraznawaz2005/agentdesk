/**
 * governor.test.ts
 *
 * src/bun/freelance/session/governor.ts is the Behavior Governor — "the
 * anti-ban core" of Auto-Earn per its own header comment. It is the single
 * gate every autonomous outbound send (bid/reply) passes through, and its
 * whole premise is that platform bans are BEHAVIORAL (sub-4s submits,
 * abnormal velocity, off-hours machine-gun sending), not fingerprint-based.
 * If its rate limiting, active-hours window, or pause mechanism silently
 * failed open, Auto-Earn could hammer a real freelance account into a ban —
 * yet the entire freelance/ subsystem (governor included) had zero test
 * coverage. This suite exercises the real evaluateSend()/gateSend() logic
 * against an in-memory DB seeded with the same tables the real schema uses
 * (freelance_action_log, freelance_outbox, settings), extracted from
 * migrations v35/v36.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";
import { createTestDb } from "../helpers/db";

const { db: testDb, sqlite: testSqlite } = createTestDb();

// Tables added by v36 (freelance-auto-earn-outbox) that createTestDb's shared
// helper doesn't include (it only covers v1-v8) — extracted directly from
// src/bun/db/migrations/v36_freelance-auto-earn-outbox.ts / v35.
testSqlite.exec(`
CREATE TABLE IF NOT EXISTS freelance_outbox (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  thread_id     TEXT,
  listing_id    TEXT,
  draft_body    TEXT NOT NULL DEFAULT '',
  final_body    TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  autonomy_mode TEXT NOT NULL DEFAULT 'assisted',
  scheduled_for TEXT,
  sent_at       TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS freelance_action_log (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL,
  action      TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT 'ok',
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

mock.module("../../src/bun/db", () => ({ db: testDb }));
mock.module("../../src/bun/db/connection", () => ({ sqlite: testSqlite }));

const broadcasts: Array<{ event: string; payload: unknown }> = [];
mock.module("../../src/bun/engine-manager", () => ({
	broadcastToWebview: (event: string, payload: unknown) => {
		broadcasts.push({ event, payload });
	},
}));

const {
	evaluateSend,
	gateSend,
	recordAction,
	isWithinActiveHours,
	hourInTimezone,
	setPause,
	clearPause,
	getPauseUntilMs,
	getGovernorState,
	jitter,
} = await import("../../src/bun/freelance/session/governor");

const PLATFORM = "freelancer";

/** Force fully permissive active-hours (24h) so hour-of-day flakiness can't affect gap/cap tests. */
function force24hActiveWindow() {
	testSqlite
		.prepare("INSERT INTO settings(id, key, value, category) VALUES (?, ?, ?, ?)")
		.run(crypto.randomUUID(), "freelance_active_hours", JSON.stringify({ start: 0, end: 0 }), "freelance");
}

function insertActionLogAt(action: string, secondsAgo: number, outcome = "ok") {
	testSqlite
		.prepare(
			`INSERT INTO freelance_action_log (id, platform, action, outcome, detail, created_at)
			 VALUES (?, ?, ?, ?, NULL, datetime('now', ?))`,
		)
		.run(crypto.randomUUID(), PLATFORM, action, outcome, `-${secondsAgo} seconds`);
}

beforeEach(() => {
	testSqlite.exec("DELETE FROM settings; DELETE FROM freelance_action_log; DELETE FROM freelance_outbox;");
	broadcasts.length = 0;
});

// ---------------------------------------------------------------------------

describe("isWithinActiveHours / hourInTimezone", () => {
	it("start === end means 'always active' (24h)", () => {
		expect(isWithinActiveHours({ activeHours: { start: 0, end: 0 }, timezone: "" } as never)).toBe(true);
	});

	it("a same-day window (9..22) excludes hours outside it", () => {
		const g = { activeHours: { start: 9, end: 22 }, timezone: "" } as never;
		expect(isWithinActiveHours(g, new Date(2026, 0, 1, 3))).toBe(false); // 3am
		expect(isWithinActiveHours(g, new Date(2026, 0, 1, 14))).toBe(true); // 2pm
		expect(isWithinActiveHours(g, new Date(2026, 0, 1, 22))).toBe(false); // end is exclusive
	});

	it("a midnight-crossing window (22..6) wraps correctly", () => {
		const g = { activeHours: { start: 22, end: 6 }, timezone: "" } as never;
		expect(isWithinActiveHours(g, new Date(2026, 0, 1, 23))).toBe(true);
		expect(isWithinActiveHours(g, new Date(2026, 0, 1, 3))).toBe(true);
		expect(isWithinActiveHours(g, new Date(2026, 0, 1, 12))).toBe(false);
	});

	it("hourInTimezone falls back to local time for an invalid IANA string instead of throwing", () => {
		const date = new Date(2026, 0, 1, 15);
		expect(hourInTimezone("Not/A_Real_Zone", date)).toBe(date.getHours());
	});

	it("hourInTimezone reads the hour in a real named timezone", () => {
		// Midday UTC in a fixed instant — Tokyo (UTC+9) should read into the evening.
		const utcNoon = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));
		expect(hourInTimezone("Asia/Tokyo", utcNoon)).toBe(21);
	});
});

describe("evaluateSend — pause gate", () => {
	it("blocks every send while paused, and reports remaining time", async () => {
		force24hActiveWindow();
		await setPause(2);
		const decision = await evaluateSend(PLATFORM);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/paused/i);
		expect(decision.retryAfterMs).toBeGreaterThan(0);
	});

	it("clearPause immediately un-blocks sends", async () => {
		force24hActiveWindow();
		await setPause(2);
		await clearPause();
		expect(await getPauseUntilMs()).toBe(0);
		const decision = await evaluateSend(PLATFORM);
		expect(decision.allowed).toBe(true);
	});
});

describe("evaluateSend — active-hours gate", () => {
	// A 1-hour window offset +2h from the current hour is guaranteed to
	// exclude "now" (no dependency on which timezone the test runs in),
	// so this is deterministic without faking the clock.
	function excludingCurrentHourWindow() {
		const h = new Date().getHours();
		const start = (h + 2) % 24;
		const end = (h + 3) % 24;
		return { start, end };
	}

	it("blocks an autonomous send outside active hours", async () => {
		const { start, end } = excludingCurrentHourWindow();
		testSqlite
			.prepare("INSERT INTO settings(id, key, value, category) VALUES (?, ?, ?, ?)")
			.run(crypto.randomUUID(), "freelance_active_hours", JSON.stringify({ start, end }), "freelance");
		const decision = await evaluateSend(PLATFORM);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/outside active hours/i);
	});

	it("skipActiveHours lets an assisted (human-initiated) send bypass the hour window", async () => {
		const { start, end } = excludingCurrentHourWindow();
		testSqlite
			.prepare("INSERT INTO settings(id, key, value, category) VALUES (?, ?, ?, ?)")
			.run(crypto.randomUUID(), "freelance_active_hours", JSON.stringify({ start, end }), "freelance");
		const decision = await evaluateSend(PLATFORM, { skipActiveHours: true });
		expect(decision.allowed).toBe(true);
	});
});

describe("evaluateSend — minimum gap between sends", () => {
	it("blocks a reply sent too soon after the last one", async () => {
		force24hActiveWindow();
		insertActionLogAt("send_reply", 5); // 5s ago, default minGapSeconds is 90
		const decision = await evaluateSend(PLATFORM, { isBid: false });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/min gap/i);
	});

	it("allows a reply once the gap has elapsed", async () => {
		force24hActiveWindow();
		insertActionLogAt("send_reply", 200); // well past the 90s default
		const decision = await evaluateSend(PLATFORM, { isBid: false });
		expect(decision.allowed).toBe(true);
	});

	it("bids require 3x the reply gap (stricter — cold outreach is the loudest spam signal)", async () => {
		force24hActiveWindow();
		insertActionLogAt("submit_bid", 200); // > reply's 90s gap, but < bid's 270s gap
		const decision = await evaluateSend(PLATFORM, { isBid: true });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/min gap/i);
	});

	it("reply and bid gap clocks are entirely independent streams", async () => {
		force24hActiveWindow();
		insertActionLogAt("submit_bid", 1); // a bid one second ago...
		// ...must not block a reply, which is a separate stream.
		const decision = await evaluateSend(PLATFORM, { isBid: false });
		expect(decision.allowed).toBe(true);
	});
});

describe("evaluateSend — hourly cap", () => {
	it("blocks once the reply hourly cap (default 4) is reached", async () => {
		force24hActiveWindow();
		for (let i = 0; i < 4; i++) insertActionLogAt("send_reply", 1000 + i); // outside min-gap, inside the hour
		const decision = await evaluateSend(PLATFORM, { isBid: false });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/hourly cap/i);
	});

	it("the bid hourly cap is half the reply cap (min 1)", async () => {
		force24hActiveWindow();
		insertActionLogAt("submit_bid", 1000); // 1 bid, cap = max(1, floor(4/2)) = 2
		const first = await evaluateSend(PLATFORM, { isBid: true });
		expect(first.allowed).toBe(true); // 1 used, cap 2 — still room
		insertActionLogAt("submit_bid", 900);
		const second = await evaluateSend(PLATFORM, { isBid: true });
		expect(second.allowed).toBe(false);
		expect(second.reason).toMatch(/hourly cap/i);
	});
});

describe("evaluateSend — daily bid budget", () => {
	it("blocks bids once the daily cap is reached even if the hourly cap has room", async () => {
		force24hActiveWindow();
		testSqlite
			.prepare("INSERT INTO settings(id, key, value, category) VALUES (?, ?, ?, ?)")
			.run(crypto.randomUUID(), "freelance_bid_daily_cap", JSON.stringify(1), "freelance");
		testSqlite
			.prepare("INSERT INTO settings(id, key, value, category) VALUES (?, ?, ?, ?)")
			.run(crypto.randomUUID(), "freelance_max_sends_per_hour", JSON.stringify(100), "freelance");
		insertActionLogAt("submit_bid", 23 * 3600); // within the last 24h, outside the last hour
		const decision = await evaluateSend(PLATFORM, { isBid: true });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/daily bid budget/i);
	});
});

describe("evaluateSend — in-flight send guard", () => {
	it("blocks a second send while one of the same kind is still 'sending'", async () => {
		force24hActiveWindow();
		testSqlite
			.prepare(
				`INSERT INTO freelance_outbox (id, platform, kind, status, updated_at)
				 VALUES (?, ?, 'reply', 'sending', datetime('now'))`,
			)
			.run(crypto.randomUUID(), PLATFORM);
		const decision = await evaluateSend(PLATFORM, { isBid: false });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/in progress/i);
	});

	it("a stale 'sending' row past the 10-minute zombie window no longer blocks", async () => {
		force24hActiveWindow();
		testSqlite
			.prepare(
				`INSERT INTO freelance_outbox (id, platform, kind, status, updated_at)
				 VALUES (?, ?, 'reply', 'sending', datetime('now', '-20 minutes'))`,
			)
			.run(crypto.randomUUID(), PLATFORM);
		const decision = await evaluateSend(PLATFORM, { isBid: false });
		expect(decision.allowed).toBe(true);
	});

	it("an in-flight bid does not block a reply (kind-scoped, not platform-wide)", async () => {
		force24hActiveWindow();
		testSqlite
			.prepare(
				`INSERT INTO freelance_outbox (id, platform, kind, status, updated_at)
				 VALUES (?, ?, 'bid', 'sending', datetime('now'))`,
			)
			.run(crypto.randomUUID(), PLATFORM);
		const decision = await evaluateSend(PLATFORM, { isBid: false });
		expect(decision.allowed).toBe(true);
	});
});

describe("gateSend — logs + broadcasts on block, but not on allow", () => {
	it("records a 'blocked' action and broadcasts GOVERNOR_BLOCKED when denied", async () => {
		force24hActiveWindow();
		await setPause(1);
		const decision = await gateSend(PLATFORM, "test send");
		expect(decision.allowed).toBe(false);
		const logged = testSqlite
			.prepare("SELECT * FROM freelance_action_log WHERE platform = ? AND action = 'blocked'")
			.all(PLATFORM);
		expect(logged.length).toBe(1);
		expect(broadcasts.length).toBe(1);
		expect(broadcasts[0].event).toBe("freelance.governor.blocked");
	});

	it("does not log or broadcast anything when the send is allowed", async () => {
		force24hActiveWindow();
		const decision = await gateSend(PLATFORM, "test send");
		expect(decision.allowed).toBe(true);
		const logged = testSqlite.prepare("SELECT * FROM freelance_action_log WHERE platform = ?").all(PLATFORM);
		expect(logged.length).toBe(0);
		expect(broadcasts.length).toBe(0);
	});
});

describe("getGovernorState — UI snapshot never fabricates a ready state while blocked", () => {
	it("reflects usedThisHour / cap / pausedUntilMs consistently with evaluateSend", async () => {
		force24hActiveWindow();
		insertActionLogAt("send_reply", 1000);
		insertActionLogAt("send_reply", 900);
		const state = await getGovernorState(PLATFORM);
		expect(state.reply.usedThisHour).toBe(2);
		expect(state.reply.cap).toBe(4);
		expect(state.pausedUntilMs).toBe(0);
	});
});

describe("recordAction", () => {
	it("writes a row that evaluateSend's own queries can then see", () => {
		recordAction(PLATFORM, "send_reply", "ok", "manual test row");
		const row = testSqlite
			.prepare("SELECT * FROM freelance_action_log WHERE platform = ? AND action = 'send_reply'")
			.get(PLATFORM) as { outcome: string; detail: string };
		expect(row.outcome).toBe("ok");
		expect(row.detail).toBe("manual test row");
	});
});

describe("jitter", () => {
	it("always returns a value within [min, max]", () => {
		for (let i = 0; i < 50; i++) {
			const v = jitter(100, 200);
			expect(v).toBeGreaterThanOrEqual(100);
			expect(v).toBeLessThanOrEqual(200);
		}
	});

	it("handles min === max without throwing", () => {
		expect(jitter(500, 500)).toBe(500);
	});
});
