// ---------------------------------------------------------------------------
// Auto-Earn — server-side human pacing helpers
//
// The in-page typing/pacing lives in shared/freelance/write-steps.ts (it runs in
// the webview). These helpers pace the BUN-side governor loop: jittered waits
// between scheduled actions so full-auto never fires on a fixed cadence.
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A jittered "human-ish" gap in ms within [minMs, maxMs]. */
export function humanGapMs(minMs: number, maxMs: number): number {
	const span = Math.max(0, maxMs - minMs);
	return Math.round(minMs + Math.random() * span);
}

/** Wait a jittered human-ish gap. */
export function humanPause(minMs: number, maxMs: number): Promise<void> {
	return sleep(humanGapMs(minMs, maxMs));
}
