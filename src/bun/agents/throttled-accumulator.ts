/**
 * Accumulates live text chunks and flushes the FULL accumulated string on a
 * fixed interval, never more often. Used by every "Full Streaming" code path
 * (Claude Subscription CLI path, agent-loop.ts sub-agents, PM chat, and the
 * per-surface widget chats) so none of them repeats the mistake that likely
 * caused an earlier attempt at this to feel slower: pushing a React state
 * update (or a broadcast event) on every single token with no batching.
 *
 * 75ms landing point chosen deliberately between the two existing, already-
 * proven precedents in this codebase: PM's raw-token buffer flushes every
 * 32ms (chat-event-handlers.ts), its reasoning buffer every 300ms (engine.ts).
 */
const DEFAULT_FLUSH_MS = 75;

export interface ThrottledAccumulator {
	/** Append a chunk; schedules a flush if one isn't already pending. */
	push(chunk: string): void;
	/** Current accumulated value (does not flush). */
	value(): string;
	/** Force an immediate flush (e.g. at stream end) and clear any pending timer. */
	flushNow(): void;
	/** Cancel any pending timer without flushing — call on retract/abort. */
	cancel(): void;
}

/**
 * @param flushOnNewline when true, a chunk containing a newline flushes
 *   immediately instead of waiting for the timer. Lets a coarse `flushMs`
 *   (e.g. General Chat's "Chunked Streaming", ~1s) still update at natural line
 *   breaks — so code/lists stream line-by-line while only unbroken prose waits
 *   the full interval. Defaults false, so existing callers are unchanged.
 */
export function createThrottledAccumulator(
	onFlush: (accumulated: string) => void,
	flushMs: number = DEFAULT_FLUSH_MS,
	flushOnNewline = false,
): ThrottledAccumulator {
	let accumulated = "";
	let timer: ReturnType<typeof setTimeout> | null = null;

	const flush = () => {
		timer = null;
		onFlush(accumulated);
	};

	const flushNow = () => {
		if (timer) { clearTimeout(timer); timer = null; }
		onFlush(accumulated);
	};

	return {
		push(chunk: string) {
			accumulated += chunk;
			if (flushOnNewline && chunk.includes("\n")) { flushNow(); return; }
			if (!timer) timer = setTimeout(flush, flushMs);
		},
		value() {
			return accumulated;
		},
		flushNow,
		cancel() {
			if (timer) { clearTimeout(timer); timer = null; }
		},
	};
}
