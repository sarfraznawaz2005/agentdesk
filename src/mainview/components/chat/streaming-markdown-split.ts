/**
 * Splits still-streaming markdown into a prefix of finished blocks plus the
 * one block that is still growing, so only the growing block has to be
 * re-parsed on each token flush.
 *
 * Without this, every flush (~30/sec) fed the ENTIRE accumulated reply through
 * remark → rehype-sanitize → a fresh React tree. That is O(n) per flush and
 * O(n²) across a reply, and replies here reach 80KB+ — by the end, a single
 * parse costs more than the interval between flushes.
 *
 * Splitting markdown is only safe at boundaries where the two halves cannot
 * influence each other's parse. The rules below are deliberately conservative:
 * a missed split costs a little performance, a wrong split renders incorrectly.
 */

/** Opening/closing fence of a code block (``` or ~~~, up to 3 leading spaces). */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * A blank line only starts a new *independent* block if what follows can't be
 * a continuation of what came before:
 *
 * - list markers (`-`, `*`, `+`, `1.`, `1)`) — a blank line between items makes
 *   a LOOSE list, still one list. Splitting there yields two lists, which
 *   restarts `<ol>` numbering at 1.
 * - `|` — a second table, or a table the parser would otherwise join.
 * - 4+ leading spaces — an indented code block or a list-item continuation.
 */
const CONTINUATION_RE = /^(?:\s{4,}|\s{0,3}(?:[-*+]\s|\d{1,9}[.)]\s|\|))/;

/**
 * Link reference definitions (`[label]: url`) and footnotes (`[^1]: text`) are
 * resolved per-parse, so a definition in a later block would stop resolving for
 * a usage in an earlier one. Rare in model output, and cheap to bail on.
 */
const REFERENCE_DEFINITION_RE = /^\s{0,3}\[[^\]]+\]:\s/m;

export interface SplitMarkdown {
	/** Finished blocks, in order. Each is final and never re-parsed again. */
	stable: string[];
	/** The trailing block, still being written. Re-parsed on every flush. */
	tail: string;
}

/**
 * Cut `text` at blank lines that provably end a block.
 *
 * A cut is only taken when the line starting the next block is already
 * complete — the final line of the input is still being typed, so a cut is
 * never placed there. That guarantee is what lets callers memoise `stable`:
 * once a string lands in it, no later call can change it.
 */
export function splitStableBlocks(text: string): SplitMarkdown {
	if (REFERENCE_DEFINITION_RE.test(text)) return { stable: [], tail: text };

	const lines = text.split("\n");
	const cuts: number[] = [];
	let fence: string | null = null;

	// The last line has no terminating newline yet, so it may still grow — never
	// judge it, and never cut at it.
	for (let i = 0; i < lines.length - 1; i++) {
		const line = lines[i];

		const fenceMatch = FENCE_RE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1][0];
			if (fence === null) fence = marker;
			else if (marker === fence) fence = null;
			continue;
		}
		if (fence !== null) continue; // inside a code block — no structure to cut on
		if (line.trim() !== "") continue;

		// Look past a run of blank lines to whatever actually starts next.
		let next = i + 1;
		while (next < lines.length && lines[next].trim() === "") next++;
		if (next >= lines.length - 1) break; // only the still-growing line remains

		// Resume at that line rather than re-examining the rest of the blank
		// run — each blank in the run would otherwise resolve to the same
		// `next` and push a duplicate cut, producing an empty block and losing
		// a newline when the pieces are rejoined.
		i = next - 1;

		if (CONTINUATION_RE.test(lines[next])) continue;
		cuts.push(next);
	}

	if (cuts.length === 0) return { stable: [], tail: text };

	const stable: string[] = [];
	let start = 0;
	for (const cut of cuts) {
		stable.push(lines.slice(start, cut).join("\n"));
		start = cut;
	}
	return { stable, tail: lines.slice(start).join("\n") };
}
