import { getSetting } from "../rpc/settings";

export type StreamingMode = "hybrid" | "none" | "full" | "chunked";

const VALID_MODES = new Set<StreamingMode>(["hybrid", "none", "full", "chunked"]);

// Flush interval (ms) for "chunked" streaming, vs. the throttled accumulator's
// smooth 75ms default used by "full". Paired with newline-flush, so code/lists
// still stream line-by-line while unbroken prose updates at most this often.
// Shared by every surface (accumulator-based and the PM chat frontend buffer).
export const CHUNKED_FLUSH_MS = 500;

/**
 * Whether this mode streams text live/progressively (full or chunked), vs.
 * hybrid/none which (on the surfaces that gate on it) deliver the whole text at
 * the end. "chunked" is just "full" with a coarser flush cadence — so wherever
 * a surface previously gated live streaming on `=== "full"`, it should use this.
 */
export function isLiveStreamingMode(mode: StreamingMode): boolean {
	return mode === "full" || mode === "chunked";
}

/**
 * Args to pass to createThrottledAccumulator for a given mode, as a tuple:
 * [flushMs, flushOnNewline]. "chunked" → coarse interval + newline-flush;
 * everything else → the accumulator's smooth defaults. Spread into the call:
 * `createThrottledAccumulator(cb, ...streamingFlushArgs(mode))`.
 */
export function streamingFlushArgs(mode: StreamingMode): [number | undefined, boolean] {
	return mode === "chunked" ? [CHUNKED_FLUSH_MS, true] : [undefined, false];
}

/**
 * Global (not per-project) user preference controlling live-streaming behavior
 * across every chat surface EXCEPT General Chat, which has its own dedicated
 * setting (see getGeneralChatStreamingMode below). Read once per request by
 * each surface — never cached, since this is a rarely-changed settings page
 * value, not a hot path.
 *
 * - "hybrid" (default): today's existing mixed behavior, unchanged — PM chat
 *   and six widget/chat surfaces stream live except on Claude Subscription's
 *   CLI/SDK path; sub-agent cards and Playground never stream live.
 * - "none": every surface delivers one complete response for text/reasoning.
 *   Tool-call activity still shows live in every mode — that's not "streaming"
 *   in the token sense. Claude Subscription's CLI path already behaves this
 *   way today, and becomes the reference behavior for this mode everywhere.
 * - "full": every surface streams live, token-by-token, including Claude
 *   Subscription's CLI path, sub-agent cards, and Playground.
 * - "chunked": like "full" but text arrives in larger blocks — a coarse
 *   ~500ms flush + newline-flush, so code/lists still stream line-by-line while
 *   unbroken prose updates ~twice a second, with far fewer frontend re-renders
 *   (lighter on long/code-heavy replies). Total speed is unchanged.
 */
export async function getStreamingMode(): Promise<StreamingMode> {
	const raw = await getSetting("streamingMode", "ai");
	return typeof raw === "string" && VALID_MODES.has(raw as StreamingMode) ? (raw as StreamingMode) : "hybrid";
}

// General Chat's streaming preference is intentionally NOT the global one. It
// runs through runInlineAgent (like Playground/sub-agents) but has no sub-agent
// cards, so "hybrid" never meant anything distinct for it — it always resolved
// to "full". Its own setting therefore offers three modes:
// - "chunked" (default): still live, but text arrives in larger blocks — the
//   orchestrator runs it as "full" with a coarse flush interval + newline-flush,
//   so code and lists still stream line-by-line while unbroken prose updates
//   roughly twice a second, with far fewer frontend re-renders (lighter on
//   long/code-heavy replies). The default because the constant re-render churn
//   of smooth per-token streaming is the main source of perceived lag here.
// - "full": live token-by-token, smooth typewriter feel (the old default).
// - "none": deliver the complete response at once.
// Stored under its own settings key so changing the global streamingMode never
// touches General Chat and vice-versa. Existing users (who have never set this
// key) pick up the new "chunked" default automatically — no migration. See
// general-chat/orchestrator.ts (passed straight through as streamingModeOverride)
// and the General Chat header gear-icon settings dialog (general-chat-settings.tsx).
export type GeneralChatStreamingMode = "none" | "full" | "chunked";

export async function getGeneralChatStreamingMode(): Promise<GeneralChatStreamingMode> {
	const raw = await getSetting("generalChatStreamingMode", "ai");
	return raw === "none" || raw === "full" ? raw : "chunked";
}
