/**
 * coalesceBroadcast — debounce bursty, idempotent "something changed, refresh"
 * broadcasts into a single trailing emit.
 *
 * Why this exists: several backend loops emit one `*-updated` broadcast PER ITEM
 * (e.g. the auto-shortlist / analyze loop fires `freelance.listingsUpdated` once
 * per analyzed listing). Each broadcast crosses the RPC boundary and makes the
 * renderer re-fetch a full list — so an N-item loop fans out into N refetches,
 * which is the structural root behind the freelance "skeleton flash on every
 * cycle" report (and the notes/docs refetch churn).
 *
 * Use this for HIGH-FREQUENCY, IDEMPOTENT refresh signals where only the final
 * state matters. The LAST payload wins (it is not a delta — do not use this for
 * events the frontend accumulates, like token streams or per-message appends).
 *
 *   coalesceBroadcast("freelance.listingsUpdated", { count: 0 });
 *
 * Semantics:
 *  - windowMs (default 300): trailing debounce — collapse a rapid burst into one
 *    emit shortly after it goes quiet.
 *  - maxWaitMs (default 1200): a ceiling so a SUSTAINED burst (e.g. a multi-minute
 *    analyze loop) still flushes periodically, keeping the UI live rather than
 *    silent until the loop ends.
 *
 * A direct `broadcastToWebview` is still the right tool for one-shot, semantically
 * distinct payloads (e.g. a fetch-complete event carrying `source`/`errors`) — do
 * not route those through here, or distinct payloads on the same channel would
 * overwrite each other.
 */

import { broadcastToWebview } from "../engine-manager";

interface Pending {
	timer: ReturnType<typeof setTimeout>;
	payload: unknown;
	firstAt: number;
}

const pending = new Map<string, Pending>();

export interface CoalesceOptions {
	windowMs?: number;
	maxWaitMs?: number;
}

export function coalesceBroadcast(
	method: string,
	payload: unknown,
	opts: CoalesceOptions = {},
): void {
	const windowMs = opts.windowMs ?? 300;
	const maxWaitMs = opts.maxWaitMs ?? 1200;
	const now = Date.now();

	const existing = pending.get(method);
	if (existing) {
		existing.payload = payload; // last write wins
		const elapsed = now - existing.firstAt;
		clearTimeout(existing.timer);
		if (elapsed >= maxWaitMs) {
			// We've been coalescing long enough — flush now so live updates keep flowing.
			flush(method);
			return;
		}
		const remaining = Math.min(windowMs, maxWaitMs - elapsed);
		existing.timer = setTimeout(() => flush(method), remaining);
		return;
	}

	const timer = setTimeout(() => flush(method), windowMs);
	pending.set(method, { timer, payload, firstAt: now });
}

function flush(method: string): void {
	const p = pending.get(method);
	if (!p) return;
	pending.delete(method);
	clearTimeout(p.timer);
	broadcastToWebview(method, p.payload);
}

/** Immediately emit any pending coalesced broadcast for a channel (e.g. on shutdown). */
export function flushCoalesced(method: string): void {
	flush(method);
}
