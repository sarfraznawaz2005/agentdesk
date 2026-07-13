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
