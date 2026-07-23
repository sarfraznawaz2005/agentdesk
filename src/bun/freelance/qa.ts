// ---------------------------------------------------------------------------
// Auto-Earn — proposal/reply QA self-check
//
// A fast editor pass over a drafted client message or proposal before it enters
// the outbox: strips over-promising ("guaranteed", "100%", unrealistic timelines),
// unverifiable boasts (specific past clients/numbers not given to us), and AI
// giveaways — protecting the user's reputation at scale. Best-effort: on any error
// (or if the revision looks degenerate) the original text is returned unchanged.
// ---------------------------------------------------------------------------

import { generateText } from "ai";
import type { createProviderAdapter } from "../providers";
import { internalCallModelId } from "../providers/claude-subscription";
import { withTransientRetry } from "../agents/safety";

type ProviderAdapter = ReturnType<typeof createProviderAdapter>;

export async function qaRevise(
	adapter: ProviderAdapter,
	modelId: string,
	kind: "reply" | "proposal",
	text: string,
	providerType?: string,
): Promise<string> {
	const trimmed = text.trim();
	if (trimmed.length < 20) return trimmed;
	try {
		const { text: out } = await withTransientRetry(() => generateText({
			maxRetries: 0,
			model: adapter.createModel(providerType ? internalCallModelId(providerType, modelId) : modelId),
			instructions: `You are a strict editor reviewing a freelancer's client ${kind} before it is sent. Remove or soften: any over-promise (guarantees, "100%", "best", unrealistic timelines), any unverifiable boast (specific past clients, numbers, or credentials you were not explicitly given), and any AI giveaway phrasing. Preserve the meaning, tone, and roughly the length. Do NOT add new claims or new information. Output ONLY the corrected ${kind} text — no preamble, no quotes, no notes. If it is already clean, return it unchanged.`,
			prompt: trimmed,
			temperature: 0.2,
		}), { label: "freelance-qa" });
		const revised = out.trim();
		// Guard against a degenerate/empty rewrite — fall back to the original.
		return revised.length >= 20 ? revised : trimmed;
	} catch {
		return trimmed;
	}
}
