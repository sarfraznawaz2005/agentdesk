// ---------------------------------------------------------------------------
// Auto-Earn — writing rules for single-shot pipelines (bid + reply)
//
// The source of truth is the built-in skills:
//   skills/humanizer/SKILL.md         — general AI-pattern removal
//   skills/freelance-writing/SKILL.md — freelance-specific additions
//
// This module loads both skill contents from the registry at call time and
// combines them. Bid-pipeline and reply-pipeline use generateText (no tool
// loop), so they can't call read_skill — we inject the content directly.
//
// The expert orchestrator uses read_skill('humanizer') + read_skill('freelance-writing')
// via its agent loop instead.
// ---------------------------------------------------------------------------

import { skillRegistry } from "../skills/registry";

/**
 * Load combined writing rules for freelance messages at runtime.
 * Merges humanizer + freelance-writing skill content.
 * Falls back to a minimal rule set if skills are not loaded yet.
 */
export function getHumanizerRules(): string {
	const humanizer = skillRegistry.getByName("humanizer");
	const freelance = skillRegistry.getByName("freelance-writing");

	if (humanizer?.content || freelance?.content) {
		const parts: string[] = [
			"WRITING RULES — follow all of these without exception. The client reads this directly; it MUST read as written by a real person, not an AI.",
		];
		if (humanizer?.content) parts.push(humanizer.content);
		if (freelance?.content) {
			// Strip the preamble line that says "call read_skill('humanizer')" since we already injected it above
			const body = freelance.content.replace(/\*\*First, apply all rules from the `humanizer` skill\*\*[^\n]*\n?/g, "");
			parts.push(body.trim());
		}
		return parts.join("\n\n");
	}

	// Fallback — should not occur in normal operation since skills load on startup
	return FALLBACK_HUMANIZER_RULES;
}

// ---------------------------------------------------------------------------
// Fallback rules (used only if the skill registry hasn't loaded yet)
// ---------------------------------------------------------------------------

const FALLBACK_HUMANIZER_RULES = `WRITING RULES — follow all of these without exception. The client reads this directly; it MUST read as written by a real person, not an AI.

HONESTY:
- Never invent past projects, clients, portfolio items, metrics, or experience not given to you. Write from the technical approach + understanding of the project instead.

PROPOSALS / OPENINGS:
- Open a bid proposal with a simple salutation ("Hi," or "Hi [Client Name],"). Keep the opening line on the client's problem, not on you.

LANGUAGE:
- No AI vocabulary. Never use: utilize, leverage, delve, seamlessly, groundbreaking, revolutionize, comprehensive, robust, streamline, synergy, cutting-edge, game-changing, facilitate, testament, landscape, boasts, showcases, underscores, pivotal, vibrant, thriving, foster, spearhead, embark, unleash, unlock.
- No copula avoidance. Write "is" and "has" — not "serves as", "boasts", "stands as".
- Active voice: "I built", not "it was built".

STYLE — CRITICAL:
- No em dashes (—) or en dashes (–). Replace with commas or periods.
- No special Unicode characters. Plain ASCII punctuation only.
- No emojis. No smart/curly quotes.
- No unnecessary bold. No inline-header lists.

COMMUNICATION:
- No chatbot artifacts ("I hope this helps!", "Happy to assist!", "Feel free to ask").
- No sycophancy ("Great question!", "That's a really interesting challenge").
- No hedge disclaimers.

VOICE:
- Use contractions (don't, can't, I'll, it's). Mix sentence lengths.
- Write as final copy ready to send. Stop when done — no trailing sign-off.`;
