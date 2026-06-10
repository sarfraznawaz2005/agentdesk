// ---------------------------------------------------------------------------
// Auto-Earn — near-duplicate detection for outbound bodies
//
// Byte-identical comparison almost never fires against LLM output, but NEAR-
// identical templates (same skeleton, a few words swapped) are the actual
// platform spam signal. Trigram Dice similarity is cheap, language-agnostic,
// and robust to small wording swaps — used at draft time (regenerate) and at
// send time (block) by the pipelines and the outbox gate.
// ---------------------------------------------------------------------------

import { sqlite } from "../db/connection";

/** Lowercase, strip punctuation, collapse whitespace — compare content, not formatting. */
function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9\s]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function trigrams(s: string): Set<string> {
	const out = new Set<string>();
	const t = `  ${s} `; // pad so short strings still produce grams
	for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
	return out;
}

/** Dice coefficient over character trigrams: 0 (unrelated) .. 1 (identical). */
export function textSimilarity(a: string, b: string): number {
	const na = normalize(a);
	const nb = normalize(b);
	if (!na || !nb) return 0;
	if (na === nb) return 1;
	const ga = trigrams(na);
	const gb = trigrams(nb);
	let shared = 0;
	for (const g of ga) if (gb.has(g)) shared++;
	return (2 * shared) / (ga.size + gb.size);
}

/** Highest similarity of `body` against a set of prior bodies. */
export function maxSimilarityAgainst(body: string, priors: string[]): number {
	let max = 0;
	for (const p of priors) {
		const s = textSimilarity(body, p);
		if (s > max) max = s;
	}
	return max;
}

// Draft-time threshold (regenerate above this) is stricter than the send-time
// block so most near-dupes are fixed quietly before they ever reach the gate.
export const DRAFT_SIMILARITY_MAX = 0.85;
export const SEND_SIMILARITY_MAX = 0.9;

/**
 * Recent outbound bodies of the same kind to compare a new draft against —
 * everything sent plus everything still pending (two pending near-identical
 * bids are just as bad as two sent ones).
 */
export function recentOutboxBodies(platform: string, kind: "reply" | "bid", limit = 20, excludeId?: string): string[] {
	const rows = sqlite
		.prepare(
			`SELECT COALESCE(final_body, draft_body) AS b FROM freelance_outbox
			 WHERE platform = ? AND kind = ? AND status IN ('sent','draft','approved','sending','awaiting_review')
			   AND id != ?
			 ORDER BY updated_at DESC LIMIT ?`,
		)
		.all(platform, kind, excludeId ?? "", limit) as Array<{ b: string | null }>;
	return rows.map((r) => r.b ?? "").filter(Boolean);
}
