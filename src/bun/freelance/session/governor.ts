// ---------------------------------------------------------------------------
// Auto-Earn — Behavior Governor (the anti-ban core)
//
// Bans are behavioral, not fingerprint-based: sub-4s submits, abnormal velocity,
// identical templates, off-hours machine-gun sending. The governor is the single
// gate every outbound action passes through. It enforces:
//   • a minimum gap between any two sends
//   • a per-hour send cap
//   • an active-hours window (no sends at 4am)
//   • jittered scheduling (never a fixed cadence)
// and records every action + decision in freelance_action_log for forensics and
// for its own rate-limit queries.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { sqlite } from "../../db/connection";
import { settings } from "../../db/schema";
import { broadcastToWebview } from "../../engine-manager";
import { FREELANCE_EVENTS } from "../events";

export type GovernorAction = "login" | "inbox_sync" | "send_reply" | "submit_bid" | "blocked";

export interface GovernorSettings {
	activeHours: { start: number; end: number };
	maxSendsPerHour: number;
	minGapSeconds: number;
	pollMinSeconds: number;
	pollMaxSeconds: number;
	timezone: string; // IANA tz from General settings (empty = OS local)
}

const DEFAULTS: GovernorSettings = {
	activeHours: { start: 9, end: 22 },
	maxSendsPerHour: 1,
	minGapSeconds: 90,
	pollMinSeconds: 180,
	pollMaxSeconds: 480,
	timezone: "",
};

const KEYS = {
	activeHours: "freelance_active_hours",
	maxSendsPerHour: "freelance_max_sends_per_hour",
	minGapSeconds: "freelance_min_gap_seconds",
	pollMinSeconds: "freelance_inbox_poll_min",
	pollMaxSeconds: "freelance_inbox_poll_max",
};

/** Read the global timezone setting (General tab). Empty string = OS local. */
async function getGlobalTimezone(): Promise<string> {
	try {
		const row = (await db.select().from(settings).where(eq(settings.key, "timezone")).limit(1))[0];
		if (!row?.value) return "";
		try {
			return String(JSON.parse(row.value));
		} catch {
			return String(row.value);
		}
	} catch {
		return "";
	}
}

export async function getGovernorSettings(): Promise<GovernorSettings> {
	const rows = await db.select().from(settings).where(eq(settings.category, "freelance"));
	const map = new Map(rows.map((r) => [r.key, r.value]));
	const num = (k: string, d: number) => {
		const raw = map.get(k);
		if (raw === undefined) return d;
		const n = Number(JSON.parse(raw));
		return Number.isFinite(n) ? n : d;
	};
	let activeHours = DEFAULTS.activeHours;
	const ahRaw = map.get(KEYS.activeHours);
	if (ahRaw) {
		try {
			const parsed = JSON.parse(ahRaw) as { start?: number; end?: number };
			if (typeof parsed.start === "number" && typeof parsed.end === "number") activeHours = { start: parsed.start, end: parsed.end };
		} catch { /* default */ }
	}
	return {
		activeHours,
		maxSendsPerHour: num(KEYS.maxSendsPerHour, DEFAULTS.maxSendsPerHour),
		minGapSeconds: num(KEYS.minGapSeconds, DEFAULTS.minGapSeconds),
		pollMinSeconds: num(KEYS.pollMinSeconds, DEFAULTS.pollMinSeconds),
		pollMaxSeconds: num(KEYS.pollMaxSeconds, DEFAULTS.pollMaxSeconds),
		timezone: await getGlobalTimezone(),
	};
}

/** Current hour (0–23) in the given IANA timezone; falls back to OS local. */
export function hourInTimezone(tz: string, date = new Date()): number {
	if (!tz) return date.getHours();
	try {
		const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(date);
		const h = parseInt(s, 10);
		if (!Number.isFinite(h)) return date.getHours();
		return h === 24 ? 0 : h;
	} catch {
		return date.getHours(); // invalid tz string — degrade gracefully
	}
}

/** Record an action + outcome for forensics and rate-limit queries. */
export function recordAction(
	platform: string,
	action: GovernorAction,
	outcome: "ok" | "blocked" | "error" = "ok",
	detail?: string,
): void {
	try {
		sqlite
			.prepare(
				`INSERT INTO freelance_action_log (id, platform, action, outcome, detail, created_at)
				 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
			)
			.run(crypto.randomUUID(), platform, action, outcome, detail ?? null);
	} catch (err) {
		console.error("[freelance/governor] recordAction failed:", err);
	}
}

// Replies and bids are SEPARATE streams: an active paying client's replies must
// not be throttled by cold-bid volume (and vice-versa). The gap + hourly count
// are measured per action type.
function secondsSinceLastSend(platform: string, action: string): number | null {
	const row = sqlite
		.prepare(
			`SELECT (julianday('now') - julianday(MAX(created_at))) * 86400.0 AS secs
			 FROM freelance_action_log
			 WHERE platform = ? AND action = ? AND outcome = 'ok'`,
		)
		.get(platform, action) as { secs: number | null } | undefined;
	return row?.secs ?? null;
}

function sendsInLastHour(platform: string, action: string): number {
	const row = sqlite
		.prepare(
			`SELECT COUNT(*) AS c FROM freelance_action_log
			 WHERE platform = ? AND action = ? AND outcome = 'ok'
			   AND created_at >= datetime('now','-1 hour')`,
		)
		.get(platform, action) as { c: number } | undefined;
	return row?.c ?? 0;
}

export function isWithinActiveHours(g: GovernorSettings, date = new Date()): boolean {
	const h = hourInTimezone(g.timezone, date);
	const { start, end } = g.activeHours;
	if (start === end) return true; // 24h
	if (start < end) return h >= start && h < end;
	// window crosses midnight (e.g. 22..6)
	return h >= start || h < end;
}

export interface SendDecision {
	allowed: boolean;
	reason?: string;
	retryAfterMs?: number;
}

/**
 * Decide whether a send may happen right now. Bids get stricter caps than
 * replies (a flurry of proposals is the loudest spam signal): half the hourly
 * cap (min 1) and triple the minimum gap.
 */
export async function evaluateSend(platform: string, opts: { isBid?: boolean } = {}): Promise<SendDecision> {
	const g = await getGovernorSettings();
	const action = opts.isBid ? "submit_bid" : "send_reply";
	// Bids are cold outreach (loudest spam signal) → strict. Replies are to an
	// active conversation → responsive (base gap), but still human-paced.
	const minGap = opts.isBid ? g.minGapSeconds * 3 : g.minGapSeconds;
	const hourlyCap = opts.isBid ? Math.max(1, Math.floor(g.maxSendsPerHour / 2)) : g.maxSendsPerHour;

	if (!isWithinActiveHours(g)) {
		return { allowed: false, reason: "outside active hours", retryAfterMs: 15 * 60_000 };
	}

	const since = secondsSinceLastSend(platform, action);
	if (since !== null && since < minGap) {
		return {
			allowed: false,
			reason: `min gap ${minGap}s not elapsed (only ${Math.round(since)}s)`,
			retryAfterMs: Math.ceil((minGap - since) * 1000),
		};
	}

	const recent = sendsInLastHour(platform, action);
	if (recent >= hourlyCap) {
		return { allowed: false, reason: `hourly cap ${hourlyCap} reached`, retryAfterMs: 10 * 60_000 };
	}

	return { allowed: true };
}

/**
 * Evaluate a send and, if blocked, log it + broadcast governor.blocked.
 * Returns the decision so callers can defer or proceed.
 */
export async function gateSend(platform: string, detail?: string, opts: { isBid?: boolean } = {}): Promise<SendDecision> {
	const decision = await evaluateSend(platform, opts);
	if (!decision.allowed) {
		recordAction(platform, "blocked", "blocked", `${detail ?? "send"}: ${decision.reason}`);
		broadcastToWebview(FREELANCE_EVENTS.GOVERNOR_BLOCKED, {
			platform,
			reason: decision.reason ?? "blocked",
			retryAfterMs: decision.retryAfterMs ?? null,
		});
	}
	return decision;
}

/** Uniform jitter in [minMs, maxMs]. Index varies the seed so callers differ. */
export function jitter(minMs: number, maxMs: number, seed = 0): number {
	const span = Math.max(0, maxMs - minMs);
	// Deterministic-ish spread without Math.random (kept side-effect free):
	const frac = ((Date.now() + seed * 9973) % 1000) / 1000;
	return Math.round(minMs + frac * span);
}
