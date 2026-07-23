/**
 * streaming-markdown-split.test.ts
 *
 * splitStableBlocks lets the streaming bubble re-parse only the block still
 * being written instead of the whole reply on every token flush (~30/sec over
 * replies that reach 80KB+).
 *
 * The performance win is worthless if a cut lands somewhere that changes how
 * the markdown renders, so these tests are mostly about where it must NOT cut:
 * inside fenced code, between loose list items (which would restart <ol>
 * numbering), inside tables, and anywhere a link reference definition is in
 * play.
 *
 * The other invariant is monotonicity: callers memoise `stable` by index, so a
 * string that has once appeared there must never change as more text arrives.
 */

import { describe, it, expect } from "bun:test";
import { splitStableBlocks } from "../../src/mainview/components/chat/streaming-markdown-split";

/** Concatenating the pieces must always reproduce the input exactly. */
function assertLossless(text: string): ReturnType<typeof splitStableBlocks> {
	const result = splitStableBlocks(text);
	expect([...result.stable, result.tail].join("\n")).toBe(text);
	return result;
}

describe("splitStableBlocks — safety", () => {
	it("does not cut inside a fenced code block", () => {
		const text = "Intro para\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter\n";
		const { stable, tail } = assertLossless(text);
		// The blank line inside the fence must not produce a cut.
		for (const block of [...stable, tail]) {
			const fences = (block.match(/```/g) ?? []).length;
			expect(fences % 2).toBe(0);
		}
	});

	it("treats an unclosed fence as still-growing and keeps it in the tail", () => {
		const text = "Para\n\n```python\nx = 1\n\ny = 2";
		const { stable, tail } = assertLossless(text);
		expect(stable.join("\n")).not.toContain("```");
		expect(tail).toContain("```python");
	});

	it("does not split a loose ordered list (would restart numbering at 1)", () => {
		const text = "Steps:\n\n1. first\n\n2. second\n\n3. third\n\nDone\n";
		const { stable, tail } = assertLossless(text);
		const listBlocks = [...stable, tail].filter((b) => /^\d+\.\s/m.test(b));
		expect(listBlocks.length).toBe(1);
	});

	it("does not split a loose bullet list", () => {
		const text = "Items:\n\n- one\n\n- two\n\n- three\n\nEnd\n";
		const { stable, tail } = assertLossless(text);
		const listBlocks = [...stable, tail].filter((b) => /^-\s/m.test(b));
		expect(listBlocks.length).toBe(1);
	});

	it("keeps a table intact", () => {
		const text =
			"Summary:\n\n| Category | Status |\n|---|---|\n| Tests | None |\n| Lint | None |\n\nAfter table\n";
		const { stable, tail } = assertLossless(text);
		const tableBlocks = [...stable, tail].filter((b) => b.includes("|"));
		expect(tableBlocks.length).toBe(1);
		expect(tableBlocks[0]).toContain("| Tests | None |");
		expect(tableBlocks[0]).toContain("| Lint | None |");
	});

	it("refuses to split at all when a link reference definition is present", () => {
		const text = "See [docs] for details.\n\nMore prose here.\n\n[docs]: https://example.com\n";
		const { stable, tail } = assertLossless(text);
		expect(stable).toEqual([]);
		expect(tail).toBe(text);
	});

	it("does not cut before an indented continuation line", () => {
		const text = "- item\n\n    continued paragraph inside the item\n\nOutside\n";
		const { stable, tail } = assertLossless(text);
		const withIndent = [...stable, tail].filter((b) => b.includes("continued paragraph"));
		expect(withIndent[0]).toContain("- item");
	});
});

describe("splitStableBlocks — behaviour", () => {
	it("returns everything as tail when there is nothing to cut", () => {
		const { stable, tail } = assertLossless("Just one paragraph still being written");
		expect(stable).toEqual([]);
		expect(tail).toBe("Just one paragraph still being written");
	});

	it("separates finished paragraphs from the growing one", () => {
		const text = "First para.\n\nSecond para.\n\nThird is still bei";
		const { stable, tail } = assertLossless(text);
		expect(stable.length).toBeGreaterThan(0);
		expect(tail).toContain("Third is still bei");
		expect(stable.join("\n")).toContain("First para.");
		expect(stable.join("\n")).not.toContain("Third is still bei");
	});

	it("never cuts at the final, still-growing line", () => {
		// "- " here could become a list marker on the next token; judging it now
		// and cutting before it would be a decision we might have to revisit.
		const { stable, tail } = assertLossless("Done para.\n\n- ");
		expect(tail).toContain("- ");
		expect(stable.join("\n")).not.toContain("- ");
	});

	it("cuts before a heading once the block after it has started", () => {
		const text = "Some intro.\n\n## A heading\n\nBody text.\n\nMore contin";
		const { stable, tail } = assertLossless(text);
		expect(stable.some((b) => b.includes("Some intro."))).toBe(true);
		expect(stable.some((b) => b.includes("## A heading"))).toBe(true);
		expect(tail).toContain("More contin");
	});

	it("survives runs of consecutive blank lines", () => {
		// Each blank in a run resolves to the same next block; without
		// deduping, that pushed one cut per blank and dropped newlines.
		const { stable, tail } = assertLossless("A\n\n\n\nB\n\n\nC\n\nstill typ");
		expect(stable.every((b) => b.length > 0)).toBe(true);
		expect(tail).toContain("still typ");
	});

	it("is monotonic — a stable block never changes as more text arrives", () => {
		const full =
			"# Title\n\nIntro paragraph.\n\n```ts\nconst x = 1;\n```\n\n## Section\n\n- a\n- b\n\n| h |\n|---|\n| v |\n\nClosing words.\n";

		// Replay the reply one character at a time, as streaming would.
		const seen: string[] = [];
		for (let i = 1; i <= full.length; i++) {
			const { stable } = splitStableBlocks(full.slice(0, i));
			for (let b = 0; b < stable.length; b++) {
				if (seen[b] === undefined) seen[b] = stable[b];
				else expect(stable[b]).toBe(seen[b]); // must never be rewritten
			}
		}
		expect(seen.length).toBeGreaterThan(1);
	});

	it("is lossless across every prefix of a realistic reply", () => {
		const full =
			"Here is the summary.\n\n| Category | Status | Details |\n|---|---|---|\n| Tests | None | no runner |\n| Lint | None | no eslint |\n\n1. First step\n\n2. Second step\n\n```bash\nbun run dev\n```\n\nThat's everything.\n";
		for (let i = 1; i <= full.length; i++) assertLossless(full.slice(0, i));
	});
});
