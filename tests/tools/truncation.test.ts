/**
 * truncation.test.ts
 *
 * Tests for the tool output truncation module:
 *   - truncateOutput (core, head & tail modes)
 *   - truncateReadFile, truncateShellOutput, truncateSearchResults, truncateTree (presets)
 *   - cleanupTruncationFiles (file retention)
 *   - initTruncationDir initialisation
 *
 * No mocks needed — truncation.ts has no application-level dependencies.
 * Disk I/O goes to a tmp directory controlled by initTruncationDir.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

const TEST_TRUNCATION_DIR = path.join(
	process.env.TEMP || process.env.TMP || "/tmp",
	`agentdesk-truncation-test-${process.pid}`,
);

// Import the module under test.  initTruncationDir is called once to point
// disk writes at our test directory.
const {
	initTruncationDir,
	truncateOutput,
	truncateReadFile,
	truncateShellOutput,
	truncateSearchResults,
	truncateTree,
	cleanupTruncationFiles,
} = await import("../../src/bun/agents/tools/truncation");

beforeEach(() => {
	mkdirSync(TEST_TRUNCATION_DIR, { recursive: true });
	initTruncationDir(TEST_TRUNCATION_DIR);
});

afterEach(() => {
	if (existsSync(TEST_TRUNCATION_DIR)) {
		rmSync(TEST_TRUNCATION_DIR, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// truncateOutput — core
// ---------------------------------------------------------------------------

describe("truncateOutput — no truncation needed", () => {
	it("returns original content unchanged when within defaults", async () => {
		const text = "line\n".repeat(10);
		const result = await truncateOutput(text, "test_tool");
		expect(result.truncated).toBe(false);
		expect(result.content).toBe(text);
		expect(result.savedPath).toBeUndefined();
	});

	it("returns truncated=false for a single line below maxBytes", async () => {
		const text = "hello world";
		const result = await truncateOutput(text, "test_tool", { maxLines: 500, maxBytes: 40_000 });
		expect(result.truncated).toBe(false);
	});

	it("returns truncated=false when line count equals maxLines exactly", async () => {
		const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
		const result = await truncateOutput(text, "test_tool", { maxLines: 500, maxBytes: 40_000 });
		// Exactly 500 lines — should not truncate
		expect(result.truncated).toBe(false);
	});
});

describe("truncateOutput — head mode", () => {
	it("truncates and saves when line count exceeds maxLines", async () => {
		const text = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
		const result = await truncateOutput(text, "read_file", { maxLines: 100, maxBytes: 40_000, direction: "head" });
		expect(result.truncated).toBe(true);
		expect(result.savedPath).toBeTruthy();
		expect(existsSync(result.savedPath!)).toBe(true);
	});

	it("keeps the first N lines in head mode", async () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line_${i}`);
		const text = lines.join("\n");
		const result = await truncateOutput(text, "test", { maxLines: 10, maxBytes: 40_000, direction: "head" });
		expect(result.truncated).toBe(true);
		// First line should be preserved
		expect(result.content).toContain("line_0");
		// Lines near the end should be truncated away from preview
		expect(result.content).not.toContain("line_199");
	});

	it("includes a hint to use read_file with startLine/endLine", async () => {
		const text = "x\n".repeat(600);
		const result = await truncateOutput(text, "read_file", { maxLines: 100, maxBytes: 40_000 });
		expect(result.content).toContain("read_file");
		expect(result.content).toContain("startLine");
	});

	it("includes the path to the saved file in the hint", async () => {
		const text = "line\n".repeat(600);
		const result = await truncateOutput(text, "read_file", { maxLines: 100, maxBytes: 40_000 });
		expect(result.content).toContain(result.savedPath!);
	});

	it("truncates when byte count exceeds maxBytes even if line count is low", async () => {
		// One very long line that blows the byte limit
		const text = "a".repeat(50_000);
		const result = await truncateOutput(text, "test_tool", { maxLines: 500, maxBytes: 1_000 });
		expect(result.truncated).toBe(true);
	});
});

describe("truncateOutput — tail mode", () => {
	it("keeps the last N lines in tail mode", async () => {
		const lines = Array.from({ length: 300 }, (_, i) => `line_${i}`);
		const text = lines.join("\n");
		const result = await truncateOutput(text, "shell", { maxLines: 10, maxBytes: 40_000, direction: "tail" });
		expect(result.truncated).toBe(true);
		// The last line should appear in the preview
		expect(result.content).toContain("line_299");
		// The very first line should be omitted
		expect(result.content).not.toContain("line_0");
	});

	it("content starts with the omission notice in tail mode", async () => {
		const text = "line\n".repeat(300);
		const result = await truncateOutput(text, "shell", { maxLines: 10, maxBytes: 40_000, direction: "tail" });
		// The head of the content should mention truncated lines, not the tail
		expect(result.content.startsWith("...")).toBe(true);
	});
});

describe("truncateOutput — saved file contents", () => {
	it("saves the FULL original text to disk", async () => {
		const text = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
		const result = await truncateOutput(text, "read_file", { maxLines: 100, maxBytes: 40_000 });

		expect(result.savedPath).toBeTruthy();
		const saved = await Bun.file(result.savedPath!).text();
		expect(saved).toBe(text);
	});
});

// ---------------------------------------------------------------------------
// Preset functions
// ---------------------------------------------------------------------------

describe("truncateReadFile", () => {
	it("does not truncate output within 500 lines / 40KB", async () => {
		const text = "line\n".repeat(100);
		const result = await truncateReadFile(text);
		expect(result.truncated).toBe(false);
	});

	it("truncates output exceeding 500 lines", async () => {
		const text = "line\n".repeat(600);
		const result = await truncateReadFile(text);
		expect(result.truncated).toBe(true);
	});
});

describe("truncateShellOutput", () => {
	it("does not truncate short shell output", async () => {
		const text = "ok\n".repeat(10);
		const result = await truncateShellOutput(text);
		expect(result.truncated).toBe(false);
	});

	it("truncates shell output exceeding 200 lines using tail mode", async () => {
		const lines = Array.from({ length: 300 }, (_, i) => `log line ${i}`);
		const text = lines.join("\n");
		const result = await truncateShellOutput(text);
		expect(result.truncated).toBe(true);
		// Tail mode — last line present, first line absent
		expect(result.content).toContain("log line 299");
	});
});

describe("truncateSearchResults", () => {
	it("does not truncate within 50 lines / 20KB", async () => {
		const text = "match\n".repeat(40);
		const result = await truncateSearchResults(text);
		expect(result.truncated).toBe(false);
	});

	it("truncates when results exceed 50 lines", async () => {
		const text = "match line\n".repeat(100);
		const result = await truncateSearchResults(text);
		expect(result.truncated).toBe(true);
	});
});

describe("truncateTree", () => {
	it("does not truncate within 300 lines / 25KB", async () => {
		const text = "dir/\n".repeat(100);
		const result = await truncateTree(text);
		expect(result.truncated).toBe(false);
	});

	it("truncates directory trees exceeding 300 lines", async () => {
		const text = "entry\n".repeat(400);
		const result = await truncateTree(text);
		expect(result.truncated).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// cleanupTruncationFiles
// ---------------------------------------------------------------------------

describe("cleanupTruncationFiles", () => {
	it("returns 0 when the directory is empty", async () => {
		const removed = await cleanupTruncationFiles();
		expect(removed).toBe(0);
	});

	it("does not remove recently created files", async () => {
		// Create a fresh truncation file via truncateOutput
		const text = "line\n".repeat(600);
		const result = await truncateOutput(text, "recent_tool", { maxLines: 100, maxBytes: 40_000 });
		expect(result.savedPath).toBeTruthy();

		// Cleanup should skip files younger than 7 days
		const removed = await cleanupTruncationFiles();
		expect(removed).toBe(0);
		expect(existsSync(result.savedPath!)).toBe(true);
	});

	it("removes files older than retention period", async () => {
		// Write a file manually with an old mtime
		const oldFilePath = path.join(TEST_TRUNCATION_DIR, "truncated-outputs", "old_tool_12345_abc12345.txt");
		mkdirSync(path.dirname(oldFilePath), { recursive: true });
		await Bun.write(oldFilePath, "old content");

		// Backdate the file by modifying the filesystem mtime
		const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
		const { utimesSync } = await import("node:fs");
		const eightDaysAgo = new Date(eightDaysAgoMs);
		utimesSync(oldFilePath, eightDaysAgo, eightDaysAgo);

		const removed = await cleanupTruncationFiles();
		expect(removed).toBeGreaterThanOrEqual(1);
		expect(existsSync(oldFilePath)).toBe(false);
	});
});
