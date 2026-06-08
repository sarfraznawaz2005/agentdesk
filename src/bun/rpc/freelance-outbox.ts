// ---------------------------------------------------------------------------
// Auto-Earn — outbox RPC handlers (approval queue + assisted send)
//
// Send flow (assisted): draftReply → user edits (updateDraft) → approveSend
// (governor gate + mark sending, returns body) → the FRONTEND types it into the
// real composer via the write-step script → markResult finalizes the status.
// ---------------------------------------------------------------------------

import { sqlite } from "../db/connection";
import { broadcastToWebview } from "../engine-manager";
import { FREELANCE_EVENTS } from "../freelance/events";
import { gateSend, recordAction } from "../freelance/session/governor";
import { isConnectedPlatform } from "./freelance-inbox";
import { draftReplyForThread } from "../freelance/reply-pipeline";
import { getAutoEarnSettings } from "../freelance/auto-earn-settings";
import { sendDesktopNotification } from "../notifications/desktop";
import type { FreelanceOutboxItemDto } from "../../shared/rpc/freelance";

const DEFAULT_PLATFORM = "freelancer";
const DEFAULT_BID_DAYS = 7;

/** avg(min,max) | single value | null (no budget → user fills the amount). */
function computeBidAmount(min: number | null, max: number | null): number | null {
	if (min != null && max != null) return Math.round((min + max) / 2);
	if (max != null) return max;
	if (min != null) return min;
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

// ─── list ─────────────────────────────────────────────────────────────────────
export async function list(params: { status?: string }): Promise<{ items: FreelanceOutboxItemDto[] }> {
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
export async function approveSend(params: { id: string }): Promise<{
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
					.prepare(`SELECT url, budget_min, budget_max FROM freelance_listings WHERE id = ?`)
					.get(listingId) as { url: string; budget_min: number | null; budget_max: number | null } | undefined)
			: undefined;
	const listingUrl = listingRow?.url ?? null;
	// Bid amount = average of the budget range, or the single value, or null (the
	// project listed no budget → the user must type the amount before placing).
	const bidAmount = computeBidAmount(listingRow?.budget_min ?? null, listingRow?.budget_max ?? null);
	const bidDays = isBid ? (await getAutoEarnSettings()).bidDeliveryDays || DEFAULT_BID_DAYS : DEFAULT_BID_DAYS;
	// Bids are NEVER auto-submitted: even in full-auto we only PREFILL the form and
	// notify — the user always clicks "Place Bid" themselves (it moves real money).
	const autoPlace = false;

	// Re-auth guard: never attempt a send when the session is logged out.
	if (!isConnectedPlatform(platform)) {
		recordAction(platform, "blocked", "blocked", "send while logged out");
		return { allowed: false, reason: "not logged in — re-login in the live session", platform, kind, threadId, listingId, listingUrl, body };
	}

	// Template-variation guard: never send a body byte-identical to a prior send
	// (identical proposals/replies are a top ban signal). Editing it is required.
	const dup = sqlite
		.prepare(
			`SELECT 1 FROM freelance_outbox
			 WHERE platform = ? AND status = 'sent' AND id != ? AND COALESCE(final_body, draft_body) = ?
			 LIMIT 1`,
		)
		.get(platform, params.id, body) as unknown;
	if (dup) {
		recordAction(platform, "blocked", "blocked", "duplicate body");
		return {
			allowed: false,
			reason: "identical to a previous send — tweak the wording before sending",
			platform, kind, threadId, listingId, listingUrl, body,
		};
	}

	const decision = await gateSend(platform, isBid ? "submit_bid" : "send_reply", { isBid });
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
