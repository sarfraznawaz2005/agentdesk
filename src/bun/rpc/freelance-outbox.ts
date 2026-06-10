// ---------------------------------------------------------------------------
// Auto-Earn — outbox RPC handlers (approval queue + assisted send)
//
// Send flow (assisted): draftReply → user edits (updateDraft) → approveSend
// (governor gate + mark sending, returns body) → the FRONTEND types it into the
// real composer via the write-step script → markResult finalizes the status.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db } from "../db";
import { settings } from "../db/schema";
import { sqlite } from "../db/connection";
import { broadcastToWebview } from "../engine-manager";
import { FREELANCE_EVENTS } from "../freelance/events";
import { gateSend, recordAction, getGovernorState, setPause, clearPause, getPauseUntilMs, type GovernorState } from "../freelance/session/governor";
import { isConnectedPlatform } from "./freelance-inbox";
import { draftReplyForThread } from "../freelance/reply-pipeline";
import { getAutoEarnSettings } from "../freelance/auto-earn-settings";
import { SEND_SIMILARITY_MAX, maxSimilarityAgainst } from "../freelance/similarity";
import { escalateToHuman } from "../freelance/expert/notify";
import { sendDesktopNotification } from "../notifications/desktop";
import type { FreelanceOutboxItemDto } from "../../shared/rpc/freelance";

const DEFAULT_PLATFORM = "freelancer";
const DEFAULT_BID_DAYS = 7;

interface BidPricing {
	mode: string; // avg | min | max | percentile
	percentile: number;
	minClamp: number;
	maxClamp: number;
	hourlyRate: number;
}

/**
 * Strategy-driven bid amount. Hourly projects use the configured hourly rate (if
 * set). For fixed budgets the base comes from the pricing mode (avg/min/max/
 * percentile of the range, or the single value), then absolute min/max clamps are
 * applied. Returns null when there is no budget and no fallback (user fills it in).
 */
function computeBidAmount(min: number | null, max: number | null, budgetType: string, s: BidPricing): number | null {
	if (budgetType === "hourly" && s.hourlyRate > 0) return Math.round(s.hourlyRate);
	let base: number | null;
	if (min != null && max != null) {
		switch (s.mode) {
			case "min": base = min; break;
			case "max": base = max; break;
			case "percentile": {
				const p = Math.max(0, Math.min(100, s.percentile)) / 100;
				base = min + (max - min) * p;
				break;
			}
			default: base = (min + max) / 2; // avg
		}
	} else {
		base = max ?? min; // single value, or null
	}
	if (base == null) return null;
	if (s.minClamp > 0) base = Math.max(base, s.minClamp);
	if (s.maxClamp > 0) base = Math.min(base, s.maxClamp);
	return Math.round(base);
}

/** Best-effort delivery-days estimate from a project's text (heuristic). */
function extractDeliveryDays(text: string): number | null {
	if (!text) return null;
	const t = text.toLowerCase();
	let m = t.match(/(?:within|in|deliver(?:ed|y)?(?:\s+(?:in|within))?|deadline[^.\d]{0,20})\s*(\d{1,3})\s*(?:business\s+|working\s+)?days?/);
	if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 365) return n; }
	m = t.match(/(?:within|in)\s*(\d{1,2})\s*weeks?/);
	if (m) { const n = parseInt(m[1], 10) * 7; if (n >= 1 && n <= 365) return n; }
	m = t.match(/(\d{1,3})\s*hours?\b/);
	if (m) { const h = parseInt(m[1], 10); if (h > 0 && h <= 24 * 60) return Math.max(1, Math.ceil(h / 24)); }
	return null;
}

function rowToDto(r: Record<string, unknown>): FreelanceOutboxItemDto {
	return {
		id: String(r.id),
		platform: String(r.platform),
		kind: String(r.kind),
		threadId: (r.thread_id as string | null) ?? null,
		listingId: (r.listing_id as string | null) ?? null,
		draftBody: (r.draft_body as string | null) ?? "",
		status: String(r.status),
		autonomyMode: String(r.autonomy_mode),
		createdAt: String(r.created_at),
		error: (r.error as string | null) ?? null,
	};
}

function notifyUpdated(): void {
	const c = sqlite
		.prepare(`SELECT COUNT(*) AS c FROM freelance_outbox WHERE status IN ('draft','approved','sending','awaiting_review')`)
		.get() as { c: number } | undefined;
	broadcastToWebview(FREELANCE_EVENTS.OUTBOX_UPDATED, { count: c?.c ?? 0 });
}

// ─── dismissStaleBids ──────────────────────────────────────────────────────────
// Auto-dismiss bids parked in `awaiting_review` longer than `bidStaleHours` — the
// project has very likely been awarded to someone else by then, so placing the bid
// would be pointless. Runs lazily whenever the outbox is listed (cheap, no
// scheduler). Disabled when bidStaleHours <= 0.
export async function dismissStaleBids(): Promise<number> {
	let hours = 24;
	try {
		hours = (await getAutoEarnSettings()).bidStaleHours;
	} catch {
		/* default */
	}
	if (!hours || hours <= 0) return 0;
	// Compare via julianday so ISO ('…T…Z') updated_at values parse correctly against
	// the cutoff (a plain string <= comparison would mismatch the 'T'/space formats).
	const res = sqlite
		.prepare(
			`UPDATE freelance_outbox SET status = 'rejected', updated_at = ?
			 WHERE status = 'awaiting_review' AND julianday(updated_at) <= julianday('now', ?)`,
		)
		.run(new Date().toISOString(), `-${Math.floor(hours)} hours`) as { changes?: number };
	const n = res.changes ?? 0;
	if (n > 0) {
		recordAction(DEFAULT_PLATFORM, "blocked", "ok", `auto-dismissed ${n} stale bid(s) (> ${hours}h in review)`);
		notifyUpdated();
	}
	return n;
}

// ─── recoverInterruptedSends ───────────────────────────────────────────────────
// A row stuck in 'sending' means the app/webview died mid-type (the write-step
// never reported back). Without recovery it wedges the in-flight governor guard
// and silently strands the message. Fail it so the user sees it and can Retry.
// Runs lazily on list() and from the bun-side watchdog.
export async function recoverInterruptedSends(): Promise<number> {
	const res = sqlite
		.prepare(
			`UPDATE freelance_outbox
			 SET status = 'failed', error = 'interrupted — the app or page closed mid-send; check the live session before retrying', updated_at = ?
			 WHERE status = 'sending' AND julianday(updated_at) <= julianday('now','-10 minutes')`,
		)
		.run(new Date().toISOString()) as { changes?: number };
	const n = res.changes ?? 0;
	if (n > 0) {
		recordAction(DEFAULT_PLATFORM, "blocked", "error", `recovered ${n} interrupted send(s)`);
		notifyUpdated();
	}
	return n;
}

// ─── list ─────────────────────────────────────────────────────────────────────
export async function list(params: { status?: string }): Promise<{ items: FreelanceOutboxItemDto[] }> {
	await dismissStaleBids(); // lazy sweep — never surface a long-dead bid
	await recoverInterruptedSends(); // lazy sweep — un-wedge crash-stranded sends
	let rows: Array<Record<string, unknown>>;
	if (params.status) {
		rows = sqlite
			.prepare(`SELECT * FROM freelance_outbox WHERE status = ? ORDER BY created_at DESC LIMIT 200`)
			.all(params.status) as Array<Record<string, unknown>>;
	} else {
		rows = sqlite
			.prepare(`SELECT * FROM freelance_outbox WHERE status != 'rejected' ORDER BY created_at DESC LIMIT 200`)
			.all() as Array<Record<string, unknown>>;
	}
	return { items: rows.map(rowToDto) };
}

// ─── draftReply ─────────────────────────────────────────────────────────────
export async function draftReply(params: { threadId: string; platform?: string }): Promise<{ item: FreelanceOutboxItemDto }> {
	const platform = params.platform ?? DEFAULT_PLATFORM;
	const item = await draftReplyForThread(platform, params.threadId);
	notifyUpdated();
	return {
		item: {
			id: item.id, platform: item.platform, kind: item.kind, threadId: item.threadId,
			listingId: item.listingId, draftBody: item.draftBody, status: item.status,
			autonomyMode: item.autonomyMode, createdAt: item.createdAt,
		},
	};
}

// ─── draftBid ─────────────────────────────────────────────────────────────────
// Implemented by the bidding task; declared here so the contract is complete.
export async function draftBid(params: { listingId: string; platform?: string }): Promise<{ item: FreelanceOutboxItemDto }> {
	const { draftBidForListing } = await import("../freelance/bid-pipeline");
	const item = await draftBidForListing(params.platform ?? DEFAULT_PLATFORM, params.listingId);
	notifyUpdated();
	return { item };
}

// ─── updateDraft ─────────────────────────────────────────────────────────────
export async function updateDraft(params: { id: string; body: string }): Promise<{ success: boolean }> {
	sqlite
		.prepare(`UPDATE freelance_outbox SET draft_body = ?, updated_at = ? WHERE id = ? AND status = 'draft'`)
		.run(params.body, new Date().toISOString(), params.id);
	return { success: true };
}

// ─── retry ────────────────────────────────────────────────────────────────────
// Revert a failed send back to an editable draft (clearing the error) so the user
// can tweak it and Approve & Send again. No-op unless the item is currently failed.
export async function retry(params: { id: string }): Promise<{ success: boolean }> {
	sqlite
		.prepare(`UPDATE freelance_outbox SET status = 'draft', error = NULL, updated_at = ? WHERE id = ? AND status = 'failed'`)
		.run(new Date().toISOString(), params.id);
	notifyUpdated();
	return { success: true };
}

// ─── markBidPrefilled ───────────────────────────────────────────────────────
// The bid form was filled in the live session but NOT submitted (assisted mode,
// or full-auto with no known amount). Park the item as 'awaiting_review' and fire
// a desktop notification so the user knows it's their turn to click Place Bid.
export async function markBidPrefilled(params: { id: string; needsAmount?: boolean }): Promise<{ success: boolean }> {
	sqlite
		.prepare(`UPDATE freelance_outbox SET status = 'awaiting_review', updated_at = ? WHERE id = ?`)
		.run(new Date().toISOString(), params.id);
	notifyUpdated();
	const body = params.needsAmount
		? "Bid is ready except the amount — set your bid amount and click Place Bid in the live session."
		: "Your bid is filled in and ready — review it and click Place Bid in the live session.";
	sendDesktopNotification("Freelance bid ready", body).catch(() => {});
	return { success: true };
}

// ─── reject ─────────────────────────────────────────────────────────────────
export async function reject(params: { id: string }): Promise<{ success: boolean }> {
	sqlite
		.prepare(`UPDATE freelance_outbox SET status = 'rejected', updated_at = ? WHERE id = ?`)
		.run(new Date().toISOString(), params.id);
	notifyUpdated();
	return { success: true };
}

// ─── approveSend ─────────────────────────────────────────────────────────────
// Governor-gated. On allow: mark 'sending' and return the body for the frontend
// to type into the real composer. On block: leave as draft, return the reason.
export async function approveSend(params: { id: string; userInitiated?: boolean }): Promise<{
	allowed: boolean;
	reason?: string;
	platform: string;
	kind: string;
	threadId: string | null;
	listingId: string | null;
	listingUrl?: string | null;
	body: string;
	bidAmount?: number | null;
	bidDays?: number;
	autoPlace?: boolean;
}> {
	const row = sqlite
		.prepare(`SELECT * FROM freelance_outbox WHERE id = ?`)
		.get(params.id) as Record<string, unknown> | undefined;
	if (!row) return { allowed: false, reason: "draft not found", platform: DEFAULT_PLATFORM, kind: "reply", threadId: null, listingId: null, body: "" };

	const platform = String(row.platform);
	const kind = String(row.kind);
	const threadId = (row.thread_id as string | null) ?? null;
	const listingId = (row.listing_id as string | null) ?? null;
	const body = (row.draft_body as string | null) ?? "";
	const isBid = kind === "bid";

	// Bids must navigate to the listing's REAL platform URL. The outbox stores the
	// internal DB id in listing_id, so reconstructing /projects/<id> yields a 404
	// ("This project doesn't exist"). Resolve the canonical url + budget from the row.
	const listingRow =
		isBid && listingId
			? (sqlite
					.prepare(`SELECT url, budget_min, budget_max, budget_type, full_description, description FROM freelance_listings WHERE id = ?`)
					.get(listingId) as
					| { url: string; budget_min: number | null; budget_max: number | null; budget_type: string | null; full_description: string | null; description: string | null }
					| undefined)
			: undefined;
	const listingUrl = listingRow?.url ?? null;
	const ae = isBid ? await getAutoEarnSettings() : null;
	// Bid amount: strategy-driven from the budget (or hourly rate), clamped; null
	// when the project lists no budget (the user types it before placing).
	const bidAmount =
		isBid && ae
			? computeBidAmount(listingRow?.budget_min ?? null, listingRow?.budget_max ?? null, listingRow?.budget_type ?? "fixed", {
					mode: ae.bidPricingMode,
					percentile: ae.bidPercentile,
					minClamp: ae.bidMinClamp,
					maxClamp: ae.bidMaxClamp,
					hourlyRate: ae.bidHourlyRate,
				})
			: null;
	// Delivery days: derived from the project's stated timeframe if present, else the default.
	const bidDays = isBid
		? extractDeliveryDays(listingRow?.full_description ?? listingRow?.description ?? "") ?? ae?.bidDeliveryDays ?? DEFAULT_BID_DAYS
		: DEFAULT_BID_DAYS;
	// Bids are NEVER auto-submitted: even in full-auto we only PREFILL the form and
	// notify — the user always clicks "Place Bid" themselves (it moves real money).
	const autoPlace = false;

	// Re-auth guard: never attempt a send when the session is logged out.
	if (!isConnectedPlatform(platform)) {
		recordAction(platform, "blocked", "blocked", "send while logged out");
		return { allowed: false, reason: "not logged in — re-login in the live session", platform, kind, threadId, listingId, listingUrl, body };
	}

	// Template-variation guard: never send a body that is identical OR near-
	// identical to a recent send. Byte-equality alone never fires against LLM
	// output — near-identical templates (same skeleton, a few words swapped) are
	// the actual platform spam signal, so this gate measures trigram similarity.
	const priorSent = sqlite
		.prepare(
			`SELECT COALESCE(final_body, draft_body) AS b FROM freelance_outbox
			 WHERE platform = ? AND kind = ? AND status = 'sent' AND id != ?
			 ORDER BY updated_at DESC LIMIT 30`,
		)
		.all(platform, kind, params.id) as Array<{ b: string | null }>;
	const sim = maxSimilarityAgainst(body, priorSent.map((r) => r.b ?? "").filter(Boolean));
	if (sim >= SEND_SIMILARITY_MAX) {
		recordAction(platform, "blocked", "blocked", `near-duplicate body (${Math.round(sim * 100)}% similar)`);
		return {
			allowed: false,
			reason: `${Math.round(sim * 100)}% similar to a previous send — vary the wording before sending`,
			platform, kind, threadId, listingId, listingUrl, body,
		};
	}

	// Humanized reply latency (autonomous replies only): an instant reply to every
	// client message, every time, is itself a bot tell — the documented kill signal
	// is the sub-4s submit, but a uniform 60-second reflex across weeks reads the
	// same way. Hold autonomous replies until the inbound message has aged past a
	// per-draft floor (deterministic per outbox id, so retries converge instead of
	// re-rolling). User-initiated sends skip this — the human is acting now.
	if (!isBid && !params.userInitiated && threadId) {
		const lastInbound = sqlite
			.prepare(
				`SELECT MAX(m.sent_at) AS t FROM freelance_inbox_messages m
				 WHERE m.thread_id = ?
				   AND m.from_user IS NOT NULL
				   AND m.from_user != COALESCE((SELECT self_user_id FROM freelance_accounts WHERE platform = ?), '')`,
			)
			.get(threadId, platform) as { t: number | null } | undefined;
		if (lastInbound?.t) {
			let hash = 0;
			for (const c of params.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
			const floorSec = 120 + (hash % 180); // 2–5 minutes, stable per draft
			const ageSec = Math.floor(Date.now() / 1000) - lastInbound.t;
			if (ageSec >= 0 && ageSec < floorSec) {
				return {
					allowed: false,
					reason: `humanized reply delay (${floorSec - ageSec}s remaining)`,
					platform, kind, threadId, listingId, listingUrl, body,
				};
			}
		}
	}

	// A user-initiated (assisted) send is a real human acting now → skip the
	// active-hours pacing rule (min-gap + hourly cap still apply). Autonomous
	// (full-auto loop) sends keep the active-hours guard.
	const decision = await gateSend(platform, isBid ? "submit_bid" : "send_reply", { isBid, skipActiveHours: !!params.userInitiated });
	if (!decision.allowed) {
		return { allowed: false, reason: decision.reason, platform, kind, threadId, listingId, listingUrl, body };
	}

	sqlite
		.prepare(`UPDATE freelance_outbox SET status = 'sending', final_body = ?, updated_at = ? WHERE id = ?`)
		.run(body, new Date().toISOString(), params.id);
	notifyUpdated();
	return { allowed: true, platform, kind, threadId, listingId, listingUrl, body, bidAmount, bidDays, autoPlace };
}

// ─── markResult ──────────────────────────────────────────────────────────────
// Called by the frontend after the write-step script runs in the webview.
export async function markResult(params: { id: string; ok: boolean; error?: string }): Promise<{ success: boolean }> {
	const row = sqlite
		.prepare(`SELECT platform, kind FROM freelance_outbox WHERE id = ?`)
		.get(params.id) as { platform: string; kind: string } | undefined;
	const now = new Date().toISOString();
	if (params.ok) {
		sqlite
			.prepare(`UPDATE freelance_outbox SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`)
			.run(now, now, params.id);
		if (row) recordAction(row.platform, row.kind === "bid" ? "submit_bid" : "send_reply", "ok", `outbox ${params.id}`);
	} else {
		sqlite
			.prepare(`UPDATE freelance_outbox SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
			.run(params.error ?? "send failed", now, params.id);
		if (row) recordAction(row.platform, row.kind === "bid" ? "submit_bid" : "send_reply", "error", params.error ?? "send failed");
	}
	notifyUpdated();
	return { success: true };
}

// ─── killSwitch ──────────────────────────────────────────────────────────────
// Halt everything pending: revert approved/sending back to draft.
export async function killSwitch(): Promise<{ success: boolean; halted: number }> {
	const res = sqlite
		.prepare(`UPDATE freelance_outbox SET status = 'draft', updated_at = ? WHERE status IN ('approved','sending')`)
		.run(new Date().toISOString()) as { changes?: number };
	notifyUpdated();
	return { success: true, halted: res.changes ?? 0 };
}

// ─── Governor visibility + global pause ────────────────────────────────────────
const GOV_PLATFORM = DEFAULT_PLATFORM;

/** Snapshot of governor usage/caps + active pause, for the UI. */
export async function governorState(): Promise<GovernorState> {
	return getGovernorState(GOV_PLATFORM);
}

/** Pause all autonomy (sends + full-auto + the expert agent) for `hours`; sync keeps running. */
export async function pauseAutonomy(params: { hours: number }): Promise<{ pausedUntil: string | null }> {
	const untilMs = await setPause(params.hours);
	broadcastToWebview(FREELANCE_EVENTS.OUTBOX_UPDATED, { count: 0 }); // nudge UI to refresh governor state
	return { pausedUntil: untilMs > Date.now() ? new Date(untilMs).toISOString() : null };
}

/** Resume autonomy immediately (clear any pause). */
export async function resumeAutonomy(): Promise<{ success: boolean }> {
	await clearPause();
	broadcastToWebview(FREELANCE_EVENTS.OUTBOX_UPDATED, { count: 0 });
	return { success: true };
}

// ─── Stuck-queue detection ──────────────────────────────────────────────────
// In full-auto, if queued auto-work hasn't gone out in a long time (logged out,
// active-hours misconfigured, paused-and-forgotten), the user should be told.
const STUCK_HOURS = 1;
const STUCK_COOLDOWN_MS = 6 * 3_600_000;
const STUCK_KEY = "freelance_stuck_escalated_at";

export async function checkStuckQueue(): Promise<void> {
	// Oldest still-pending outbox item, in hours (julianday handles ISO/space formats).
	const row = sqlite
		.prepare(
			`SELECT (julianday('now') - julianday(MIN(created_at))) * 24.0 AS hours FROM freelance_outbox WHERE status IN ('draft','approved','sending')`,
		)
		.get() as { hours: number | null } | undefined;
	const hours = row?.hours ?? null;
	if (hours == null || hours < STUCK_HOURS) return;
	// A successful send inside the window means the queue is draining — not stuck.
	const okRecent = sqlite
		.prepare(
			`SELECT 1 FROM freelance_action_log WHERE action IN ('send_reply','submit_bid') AND outcome = 'ok' AND julianday(created_at) >= julianday('now', ?) LIMIT 1`,
		)
		.get(`-${STUCK_HOURS} hours`);
	if (okRecent) return;
	// Dedup via cooldown.
	const last = (await db.select().from(settings).where(eq(settings.key, STUCK_KEY)).limit(1))[0];
	if (last?.value) {
		try {
			const t = Date.parse(JSON.parse(last.value) as string);
			if (Number.isFinite(t) && Date.now() - t < STUCK_COOLDOWN_MS) return;
		} catch {
			/* re-escalate */
		}
	}
	const now = new Date().toISOString();
	await db
		.insert(settings)
		.values({ id: crypto.randomUUID(), key: STUCK_KEY, value: JSON.stringify(now), category: "freelance", updatedAt: now })
		.onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(now), updatedAt: now } });
	await escalateToHuman({
		platform: DEFAULT_PLATFORM,
		reason: "Auto-Earn queue is stuck",
		detail: `Queued auto-work hasn't been sent in over ${STUCK_HOURS} hours. Check the live session is logged in, and your active-hours / pause settings.`,
		severity: "warn",
	});
}

// ─── Engine heartbeat ─────────────────────────────────────────────────────────
// The frontend engine loop pings checkStuck every tick; we stamp it so the bun-
// side watchdog can tell "engine alive" from "frontend silently died" (the whole
// full-auto loop lives in a hidden React component — a renderer crash stops it).
const HEARTBEAT_KEY = "freelance_engine_heartbeat_at";

async function recordEngineHeartbeat(): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(settings)
		.values({ id: crypto.randomUUID(), key: HEARTBEAT_KEY, value: JSON.stringify(now), category: "freelance", updatedAt: now })
		.onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(now), updatedAt: now } });
}

/** Epoch-ms of the last frontend engine tick, or 0 if never recorded. */
export async function getEngineHeartbeatMs(): Promise<number> {
	try {
		const row = (await db.select().from(settings).where(eq(settings.key, HEARTBEAT_KEY)).limit(1))[0];
		if (!row?.value) return 0;
		const t = Date.parse(JSON.parse(row.value) as string);
		return Number.isFinite(t) ? t : 0;
	} catch {
		return 0;
	}
}

/** RPC wrapper for the full-auto loop to ping periodically (doubles as heartbeat). */
export async function checkStuck(): Promise<{ success: boolean }> {
	await recordEngineHeartbeat();
	await checkStuckQueue();
	return { success: true };
}

// ─── Anomaly circuit breaker ──────────────────────────────────────────────────
// The live-session interceptor reports platform anomalies (429 rate-limits, 403s
// on the messaging API, captcha/challenge pages). A soft flag escalates into a
// ban precisely when automation keeps sending through it — so the breaker trips:
// pause ALL autonomy for a kind-scaled window and alert the human. Sync keeps
// running (it never calls the governor), so the inbox stays current.
const ANOMALY_PAUSE_HOURS: Record<string, number> = {
	rate_limit: 2,
	forbidden: 6,
	captcha: 12,
};
const ANOMALY_ESCALATE_COOLDOWN_MS = 30 * 60_000;
let lastAnomalyEscalateAt = 0;

export async function reportAnomaly(params: {
	platform?: string;
	kind: string;
	detail?: string;
}): Promise<{ paused: boolean; pausedUntil: string | null }> {
	const platform = params.platform ?? DEFAULT_PLATFORM;
	const kind = Object.prototype.hasOwnProperty.call(ANOMALY_PAUSE_HOURS, params.kind) ? params.kind : "rate_limit";
	recordAction(platform, "blocked", "error", `anomaly:${kind}${params.detail ? ` ${params.detail.slice(0, 200)}` : ""}`);

	// Already paused (this or an earlier anomaly) — just log, don't re-alert.
	const existingPause = await getPauseUntilMs();
	if (existingPause > Date.now()) {
		return { paused: true, pausedUntil: new Date(existingPause).toISOString() };
	}

	const hours = ANOMALY_PAUSE_HOURS[kind];
	const untilMs = await setPause(hours);
	notifyUpdated(); // nudge the UI to refresh governor/pause state
	if (Date.now() - lastAnomalyEscalateAt >= ANOMALY_ESCALATE_COOLDOWN_MS) {
		lastAnomalyEscalateAt = Date.now();
		await escalateToHuman({
			platform,
			reason: `Platform anomaly detected (${kind.replace(/_/g, " ")})`,
			detail:
				`${params.detail ? `${params.detail.slice(0, 300)}\n\n` : ""}` +
				`Auto-Earn autonomy is paused for ${hours}h as a precaution. Check the live session ` +
				`(log in / complete any verification), then resume from the inbox when things look normal.`,
			severity: "blocker",
		});
	}
	return { paused: true, pausedUntil: new Date(untilMs).toISOString() };
}

export { getPauseUntilMs };
