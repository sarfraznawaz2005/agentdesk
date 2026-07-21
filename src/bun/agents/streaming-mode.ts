import { getSetting } from "../rpc/settings";

export type StreamingMode = "hybrid" | "none" | "full";

const VALID_MODES = new Set<StreamingMode>(["hybrid", "none", "full"]);

/**
 * Global (not per-project) user preference controlling live-streaming behavior
 * across every chat surface. Read once per request by each surface — never
 * cached, since this is a rarely-changed settings page value, not a hot path.
 *
 * - "hybrid" (default): today's existing mixed behavior, unchanged — PM chat
 *   and six widget/chat surfaces stream live except on Claude Subscription's
 *   CLI/SDK path; sub-agent cards and Playground never stream live. General
 *   Chat is a special case: it runs through runInlineAgent (agent-loop.ts),
 *   the same mechanism Playground/sub-agent cards use, so left on the literal
 *   "hybrid" value it would inherit their never-stream-live behavior too. But
 *   Hybrid's whole reason to differ from Full — sub-agent cards updating per
 *   step, not live — doesn't apply to General Chat (no sub-agent cards; every
 *   turn IS the top-level agent) — so general-chat/orchestrator.ts maps
 *   "hybrid" to "full" specifically for its own runInlineAgent call via
 *   streamingModeOverride, rather than calling this function's default.
 * - "none": every surface delivers one complete response for text/reasoning.
 *   Tool-call activity still shows live in every mode — that's not "streaming"
 *   in the token sense. Claude Subscription's CLI path already behaves this
 *   way today, and becomes the reference behavior for this mode everywhere.
 *   General Chat honors an explicit "none" as-is — no override.
 * - "full": every surface streams live, token-by-token, including Claude
 *   Subscription's CLI path, sub-agent cards, and Playground.
 */
export async function getStreamingMode(): Promise<StreamingMode> {
	const raw = await getSetting("streamingMode", "ai");
	return typeof raw === "string" && VALID_MODES.has(raw as StreamingMode) ? (raw as StreamingMode) : "hybrid";
}
