// Frontend twin of the backend `coalesceBroadcast` (src/bun/lib/coalesce-broadcast.ts).
//
// Several React listeners reload a full dataset on EVERY backend event
// (agent-inline-complete, stream-complete, kanban-task-updated, activity-updated).
// During a PM run with N sub-agents, or a cascade of kanban moves, that fans out
// into N redundant refetches + re-renders. createCoalescer wraps a reload so a
// rapid burst collapses into a single trailing invocation.
//
// Semantics (match the backend helper):
//  - windowMs (default 300): trailing debounce — fire once shortly after the burst
//    goes quiet.
//  - maxWaitMs (default 1000): a ceiling so a SUSTAINED burst still flushes
//    periodically, keeping the UI live rather than starved until the burst ends.
//
// This is for IDEMPOTENT "reload current state" calls only — never for events the
// UI accumulates (token streams, per-message appends).

export interface CoalesceOptions {
	windowMs?: number;
	maxWaitMs?: number;
}

export interface Coalescer {
	/** Schedule a (coalesced) invocation of the wrapped function. */
	(): void;
	/** Cancel any pending invocation (e.g. on effect cleanup / unmount). */
	cancel: () => void;
}

export function createCoalescer(fn: () => void, opts: CoalesceOptions = {}): Coalescer {
	const windowMs = opts.windowMs ?? 300;
	const maxWaitMs = opts.maxWaitMs ?? 1000;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let firstAt = 0;

	const flush = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		firstAt = 0;
		fn();
	};

	const trigger = (() => {
		const now = Date.now();
		if (timer === null) firstAt = now;
		const elapsed = now - firstAt;
		if (timer) clearTimeout(timer);
		if (elapsed >= maxWaitMs) {
			flush();
			return;
		}
		const remaining = Math.min(windowMs, maxWaitMs - elapsed);
		timer = setTimeout(flush, remaining);
	}) as Coalescer;

	trigger.cancel = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		firstAt = 0;
	};

	return trigger;
}
