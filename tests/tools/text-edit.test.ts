/**
 * text-edit.test.ts
 *
 * Regression tests for encoding-robust file editing. These cover the bug where
 * edit_file / multi_edit_file / patch_file failed with "old_text not found" on
 * Windows because the file was CRLF but the model supplied LF old_text (which
 * then pushed agents into useRegex=true and the "invalid regex: missing )"
 * follow-on error).
 *
 * Two layers:
 *   1. Pure unit tests of the text-edit helpers (no I/O, no mocks).
 *   2. End-to-end tests that drive the REAL tracked file tools against temp
 *      files written with explicit bytes (CRLF / LF / BOM / multibyte UTF-8),
 *      asserting both that the edit applies AND that the file's line-ending and
 *      BOM are preserved.
 *
 * No AI provider is needed — the bug is mechanical and is reproduced
 * deterministically. (An optional provider-driven smoke script lives separately
 * at scripts/edit-tools-smoke.ts.)
 */

import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	detectEol,
	toLf,
	fromLf,
	literalReplace,
} from "../../src/bun/agents/tools/text-edit";

// ---------------------------------------------------------------------------
// Part 1 — pure helpers (no mocks required: text-edit.ts has no I/O imports)
// ---------------------------------------------------------------------------

describe("detectEol", () => {
	it("detects CRLF", () => {
		expect(detectEol("a\r\nb\r\nc")).toBe("\r\n");
	});
	it("detects LF", () => {
		expect(detectEol("a\nb\nc")).toBe("\n");
	});
	it("treats CRLF as dominant on a tie", () => {
		expect(detectEol("a\r\nb\nc")).toBe("\r\n");
	});
	it("defaults to LF for text with no line endings", () => {
		expect(detectEol("single line")).toBe("\n");
	});
});

describe("toLf / fromLf", () => {
	it("normalises CRLF and lone CR to LF", () => {
		expect(toLf("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
	});
	it("fromLf restores CRLF", () => {
		expect(fromLf("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
	});
	it("fromLf is a no-op for LF", () => {
		expect(fromLf("a\nb", "\n")).toBe("a\nb");
	});
});

describe("literalReplace — line endings", () => {
	it("matches LF old_text against a CRLF file and keeps CRLF", () => {
		const original = "line1\r\nline2\r\nline3\r\n";
		const res = literalReplace(original, "line1\nline2", "LINE1\nLINE2");
		expect(res.error).toBeUndefined();
		expect(res.eolAdjusted).toBe(true);
		expect(res.updated).toBe("LINE1\r\nLINE2\r\nline3\r\n");
	});

	it("matches exactly when old_text already has the file's CRLF", () => {
		const original = "a\r\nb\r\n";
		const res = literalReplace(original, "a\r\nb", "x\r\ny");
		expect(res.error).toBeUndefined();
		expect(res.eolAdjusted).toBeUndefined(); // exact path, no adjustment
		expect(res.updated).toBe("x\r\ny\r\n");
	});

	it("works on a pure LF file", () => {
		const res = literalReplace("a\nb\nc\n", "b", "B");
		expect(res.updated).toBe("a\nB\nc\n");
	});

	it("returns an error when the text genuinely is not present", () => {
		const res = literalReplace("a\r\nb\r\n", "zzz", "x");
		expect(res.error).toBe("old_text not found in file");
	});
});

describe("literalReplace — `$` in replacement is literal (no regex expansion)", () => {
	it("does not expand $&, $1, $$ in new_text", () => {
		const original = "const x = 1\n";
		const newText = "const price = `$${total}` // $1 $& done";
		const res = literalReplace(original, "const x = 1", newText);
		expect(res.updated).toBe(newText + "\n");
	});
});

describe("literalReplace — replace_all", () => {
	it("replaces every occurrence when replaceAll is true", () => {
		const res = literalReplace("x\r\nx\r\nx\r\n", "x", "y", true);
		expect(res.updated).toBe("y\r\ny\r\ny\r\n");
	});
	it("replaces only the first when replaceAll is false", () => {
		const res = literalReplace("x\nx\nx\n", "x", "y", false);
		expect(res.updated).toBe("y\nx\nx\n");
	});
});

describe("literalReplace — BOM", () => {
	const BOM = String.fromCharCode(0xfeff);
	it("preserves a leading BOM and still matches near the start", () => {
		const original = BOM + "first\r\nsecond\r\n";
		const res = literalReplace(original, "first", "FIRST");
		expect(res.updated).toBe(BOM + "FIRST\r\nsecond\r\n");
	});
});

// ---------------------------------------------------------------------------
// Part 2 — end-to-end against the REAL tracked file tools
//
// file-ops.ts pulls in electrobun/bun (via plugins) and the db; mock the heavy
// deps so the module loads cleanly, exactly like validate-path.test.ts.
// ---------------------------------------------------------------------------

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: path.join(tmpdir(), "agentdesk-test-text-edit-userdata") } },
}));
mock.module("../../src/bun/db", () => ({ db: {} }));
mock.module("../../src/bun/plugins", () => ({ notifyFileChange: async () => [] }));

const { createTrackedFileTools } = await import("../../src/bun/agents/tools/file-ops");
const { FileTracker } = await import("../../src/bun/agents/tools/file-tracker");

type Eol = "lf" | "crlf";

/** Write a file with explicit line endings and optional BOM (byte-accurate). */
function writeRaw(file: string, content: string, eol: Eol, bom = false): void {
	const body = content.replace(/\n/g, eol === "crlf" ? "\r\n" : "\n");
	const parts: Buffer[] = [];
	if (bom) parts.push(Buffer.from([0xef, 0xbb, 0xbf]));
	parts.push(Buffer.from(body, "utf8"));
	writeFileSync(file, Buffer.concat(parts));
}

function readBuf(file: string): Buffer {
	return readFileSync(file);
}

/** Count CRLF vs bare-LF line endings in a buffer. */
function eolStats(buf: Buffer): { crlf: number; bareLf: number } {
	const s = buf.toString("latin1"); // byte-faithful
	const crlf = (s.match(/\r\n/g) || []).length;
	const lf = (s.match(/\n/g) || []).length;
	return { crlf, bareLf: lf - crlf };
}

const hasBom = (buf: Buffer): boolean => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

// Build a fresh tool set + workspace per test so the FileTracker never blocks.
let workspace: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tools: Record<string, any>;

beforeAll(() => {
	workspace = mkdtempSync(path.join(tmpdir(), "agentdesk-edit-tools-"));
	tools = createTrackedFileTools(new FileTracker(), undefined, workspace) as Record<string, unknown> as typeof tools;
});

afterAll(() => {
	try { rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
});

const run = (name: string, args: Record<string, unknown>): Promise<string> =>
	tools[name].execute(args, { toolCallId: "test", messages: [] });

describe("edit_file — CRLF file, LF old_text (the reported bug)", () => {
	it("applies the edit and keeps the file CRLF", async () => {
		const file = path.join(workspace, "crlf.ts");
		writeRaw(file, "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n", "crlf");

		const out = await run("edit_file", {
			path: file,
			old_text: "export const b = 2;", // single line — exact match regardless of EOL
			new_text: "export const b = 22;",
		});
		expect(out).toContain("Successfully edited");

		const buf = readBuf(file);
		expect(buf.toString("utf8")).toContain("export const b = 22;");
		const { crlf, bareLf } = eolStats(buf);
		expect(crlf).toBe(3);     // all three line endings stayed CRLF
		expect(bareLf).toBe(0);   // no line ending got converted to bare LF
	});

	it("matches a MULTI-LINE LF old_text against a CRLF file", async () => {
		const file = path.join(workspace, "crlf-multiline.ts");
		writeRaw(file, "function f() {\n  return 1;\n}\n", "crlf");

		const out = await run("edit_file", {
			path: file,
			old_text: "function f() {\n  return 1;\n}", // LF — the model's natural output
			new_text: "function f() {\n  return 2;\n}",
		});
		expect(out).toContain("Successfully edited");

		const buf = readBuf(file);
		expect(buf.toString("utf8")).toContain("return 2;");
		expect(eolStats(buf).bareLf).toBe(0); // edited region re-emitted as CRLF
	});
});

describe("edit_file — `$` in new_text is written literally", () => {
	it("does not corrupt a replacement containing $ sequences", async () => {
		const file = path.join(workspace, "dollar.ts");
		writeRaw(file, "const a = 0;\n", "lf");
		const replacement = "const a = `$${x}`; // $1 $& $$";
		const out = await run("edit_file", { path: file, old_text: "const a = 0;", new_text: replacement });
		expect(out).toContain("Successfully edited");
		expect(readBuf(file).toString("utf8")).toBe(replacement + "\n");
	});
});

describe("multi_edit_file — CRLF file, sequential LF edits (reproduces the transcript)", () => {
	it("applies all edits and preserves CRLF", async () => {
		const file = path.join(workspace, "store.ts");
		writeRaw(
			file,
			[
				"  // Live context window usage from backend",
				"  liveContextTokens: number;",
				"  liveContextLimit: number;",
				"",
				"  // Actions",
				"  reset: () => void;",
				"",
				"  isCompacting: false,",
				"  liveContextLimit: 0,",
				"};",
				"",
			].join("\n"),
			"crlf",
		);

		const out = await run("multi_edit_file", {
			path: file,
			edits: [
				{
					old_text: "  liveContextLimit: number;\n\n  // Actions",
					new_text: "  liveContextLimit: number;\n\n  collapsedAgentBlocks: Record<string, true>;\n\n  // Actions",
				},
				{
					old_text: "  liveContextLimit: 0,\n};",
					new_text: "  liveContextLimit: 0,\n  collapsedAgentBlocks: {} as Record<string, true>,\n};",
				},
			],
		});

		expect(out).toContain("Successfully applied 2 edit(s)");
		const text = readBuf(file).toString("utf8");
		expect(text).toContain("collapsedAgentBlocks: Record<string, true>;");
		expect(text).toContain("collapsedAgentBlocks: {} as Record<string, true>,");
		expect(eolStats(readBuf(file)).bareLf).toBe(0);
	});

	it("reports which edit failed when text is genuinely absent", async () => {
		const file = path.join(workspace, "store2.ts");
		writeRaw(file, "a\nb\nc\n", "crlf");
		const out = await run("multi_edit_file", {
			path: file,
			edits: [
				{ old_text: "a", new_text: "A" },
				{ old_text: "DOES_NOT_EXIST", new_text: "X" },
			],
		});
		expect(out).toContain("Error in edit 2/2");
	});
});

describe("patch_file — CRLF file", () => {
	it("applies a unified diff and preserves CRLF", async () => {
		const file = path.join(workspace, "patch.ts");
		writeRaw(file, "alpha\nbeta\ngamma\n", "crlf");

		const patch = [
			"@@ -1,3 +1,3 @@",
			" alpha",
			"-beta",
			"+BETA",
			" gamma",
		].join("\n");

		const out = await run("patch_file", { path: file, patch });
		expect(out).toContain("Successfully patched");
		const buf = readBuf(file);
		expect(buf.toString("utf8")).toContain("BETA");
		expect(eolStats(buf).bareLf).toBe(0);
	});
});

describe("BOM preservation", () => {
	it("edit_file keeps a leading UTF-8 BOM", async () => {
		const file = path.join(workspace, "bom.ts");
		writeRaw(file, "export const x = 1;\nexport const y = 2;\n", "crlf", /* bom */ true);
		expect(hasBom(readBuf(file))).toBe(true);

		const out = await run("edit_file", { path: file, old_text: "export const y = 2;", new_text: "export const y = 22;" });
		expect(out).toContain("Successfully edited");

		const buf = readBuf(file);
		expect(hasBom(buf)).toBe(true); // BOM survived the edit
		expect(buf.toString("utf8")).toContain("export const y = 22;");
		expect(eolStats(buf).bareLf).toBe(0);
	});
});

describe("multibyte UTF-8 content", () => {
	it("edits a line without corrupting emoji / CJK / accented neighbours", async () => {
		const file = path.join(workspace, "unicode.ts");
		writeRaw(file, 'const a = "café ☕";\nconst b = "日本語 🚀";\nconst c = "naïve";\n', "lf");

		const out = await run("edit_file", { path: file, old_text: 'const b = "日本語 🚀";', new_text: 'const b = "中文 🎉";' });
		expect(out).toContain("Successfully edited");

		const text = readBuf(file).toString("utf8");
		expect(text).toContain('const a = "café ☕";');   // untouched neighbour intact
		expect(text).toContain('const b = "中文 🎉";');   // edit applied
		expect(text).toContain('const c = "naïve";');     // untouched neighbour intact
	});
});
