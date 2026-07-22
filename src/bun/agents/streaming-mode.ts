import { getSetting } from "../rpc/settings";

export type StreamingMode = "hybrid" | "none" | "full";

const VALID_MODES = new Set<StreamingMode>(["hybrid", "none", "full"]);

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
 */
export async function getStreamingMode(): Promise<StreamingMode> {
	const raw = await getSetting("streamingMode", "ai");
	return typeof raw === "string" && VALID_MODES.has(raw as StreamingMode) ? (raw as StreamingMode) : "hybrid";
}

// General Chat's streaming preference is intentionally NOT the global one. It
// runs through runInlineAgent (like Playground/sub-agents) but has no sub-agent
// cards, so "hybrid" never meant anything distinct for it — it always resolved
// to "full". Its own setting therefore offers only the two modes that actually
// differ: "full" (live token-by-token, the default — preserves the out-of-box
// behavior, since the global default "hybrid" already resolved to "full" here)
// and "none" (deliver the complete response at once). Stored under its own
// settings key so changing the global streamingMode never touches General Chat
// and vice-versa. See general-chat/orchestrator.ts (streamingModeOverride) and
// the General Chat header gear-icon settings dialog (general-chat-settings.tsx).
export type GeneralChatStreamingMode = "none" | "full";

export async function getGeneralChatStreamingMode(): Promise<GeneralChatStreamingMode> {
	const raw = await getSetting("generalChatStreamingMode", "ai");
	return raw === "none" ? "none" : "full";
}
