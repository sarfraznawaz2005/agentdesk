/**
 * file-tracker.test.ts
 *
 * Tests for the FileTracker class:
 *   - track() and checkFreshness()
 *   - trackWrite() and getModifiedFiles()
 *   - remove() and clear()
 *   - edge cases: deleted file, untracked file, mtime tolerance
 *
 * No mocks needed — FileTracker is a pure in-process class. Real files are
 * written to a temp directory so that mtime checks work against the filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import path from "node:path";
import { FileTracker } from "../../src/bun/agents/tools/file-tracker";

const TEST_DIR = path.join(
	process.env.TEMP || process.env.TMP || "/tmp",
	`agentdesk-file-tracker-test-${process.pid}`,
);

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true, force: true });
	}
});

function writeTmpFile(name: string, content: string): string {
	const filePath = path.join(TEST_DIR, name);
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

// ---------------------------------------------------------------------------
// checkFreshness — untracked file
// ---------------------------------------------------------------------------

describe("checkFreshness — untracked file", () => {
	it("returns { status: 'untracked' } when the file was never tracked", () => {
		const tracker = new FileTracker();
		const result = tracker.checkFreshness("/nonexistent/path/file.ts");
		expect(result.status).toBe("untracked");
	});
});

// ---------------------------------------------------------------------------
// track() and checkFreshness()
// ---------------------------------------------------------------------------

describe("track and checkFreshness", () => {
	it("returns 'fresh' immediately after tracking a file", () => {
		const tracker = new FileTracker();
		const filePath = writeTmpFile("fresh.ts", "const x = 1;");
		tracker.track(filePath, "const x = 1;");

		const result = tracker.checkFreshness(filePath);
		expect(result.status).toBe("fresh");
	});

	it("returns 'modified_externally' when the file is overwritten after tracking", async () => {
		const tracker = new FileTracker();
		const filePath = writeTmpFile("modified.ts", "original content");
		tracker.track(filePath, "original content");

		// Wait 10ms then rewrite the file so the mtime changes
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(filePath, "new content", "utf-8");

		const result = tracker.checkFreshness(filePath);
		expect(result.status).toBe("modified_externally");
	});

	it("returns 'modified_externally' when the file is deleted after tracking", () => {
		const tracker = new FileTracker();
		const filePath = writeTmpFile("deleted.ts", "content");
		tracker.track(filePath, "content");

		rmSync(filePath);

		const result = tracker.checkFreshness(filePath);
		expect(result.status).toBe("modified_externally");
	});

	it("does not track a file that does not exist on disk", () => {
		const tracker = new FileTracker();
		// File does not exist — track() should silently skip
		tracker.track("/tmp/nonexistent-abc123.ts", "content");
		// Since track() skipped, checkFreshness should return untracked
		const result = tracker.checkFreshness("/tmp/nonexistent-abc123.ts");
		expect(result.status).toBe("untracked");
	});

	it("re-tracking a file updates the stored mtime (fresh again after rewrite + re-track)", async () => {
		const tracker = new FileTracker();
		const filePath = writeTmpFile("retrack.ts", "v1");
		tracker.track(filePath, "v1");

		// Overwrite and re-track
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(filePath, "v2", "utf-8");
		tracker.track(filePath, "v2");

		const result = tracker.checkFreshness(filePath);
		expect(result.status).toBe("fresh");
	});
});

// ---------------------------------------------------------------------------
// trackWrite() and getModifiedFiles()
// ---------------------------------------------------------------------------

describe("trackWrite and getModifiedFiles", () => {
	it("getModifiedFiles returns an empty array initially", () => {
		const tracker = new FileTracker();
		expect(tracker.getModifiedFiles()).toEqual([]);
	});

	it("records a file as modified after trackWrite", () => {
		const tracker = new FileTracker();
		const filePath = writeTmpFile("written.ts", "export const x = 1;");
		tracker.trackWrite(filePath, "export const x = 1;");

		const modified = tracker.getModifiedFiles();
		expect(modified).toContain(filePath);
	});

	it("accumulates multiple written files", () => {
		const tracker = new FileTracker();
		const fileA = writeTmpFile("a.ts", "a");
		const fileB = writeTmpFile("b.ts", "b");
		const fileC = writeTmpFile("c.ts", "c");

		tracker.trackWrite(fileA, "a");
		tracker.trackWrite(fileB, "b");
		tracker.trackWrite(fileC, "c");

		const modified = tracker.getModifiedFiles();
		expect(modified).toContain(fileA);
		expect(modified).toContain(fileB);
		expect(modified).toContain(fileC);
		expect(modified).toHaveLength(3);
	});

	it("does not add duplicate entries when the same file is written twice", () => {
		const tracker = new FileTracker();
		const filePath = writeTmpFile("dedup.ts", "v1");
		tracker.trackWrite(filePath, "v1");

		writeFileSync(filePath, "v2", "utf-8");
		tracker.trackWrite(filePath, "v2");

		const modified = tracker.getModifiedFiles();
		// Set semantics — file should appear only once
		const count = modified.filter((f) => f === filePath).length;
		expect(count).toBe(1);
	});

	it("also updates freshness tracking via trackWrite", () => {
		const tracker = new FileTracker();
		const filePath = writeTmpFile("both.ts", "content");
		tracker.trackWrite(filePath, "content");

		// Immediately after, the file should be considered fresh
		const result = tracker.checkFreshness(filePath);
		expect(result.status).toBe("fresh");
	});

	it("does not include read-only tracked files in getModifiedFiles", () => {
		const tracker = new FileTracker();
		const filePath = writeTmpFile("readonly.ts", "readonly content");
		// track() (not trackWrite) — simulates a file read
		tracker.track(filePath, "readonly content");

		expect(tracker.getModifiedFiles()).not.toContain(filePath);
	});
});

// ---------------------------------------------------------------------------
// remove()
// ---------------------------------------------------------------------------

describe("remove", () => {
	it("removes a tracked file from freshness tracking", () => {
		const tracker = new FileTracker();
		const filePath = writeTmpFile("removable.ts", "data");
		tracker.track(filePath, "data");

		tracker.remove(filePath);

		const result = tracker.checkFreshness(filePath);
		expect(result.status).toBe("untracked");
	});

	it("is a no-op for a file that was never tracked", () => {
		const tracker = new FileTracker();
		// Should not throw
		expect(() => tracker.remove("/never/tracked.ts")).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe("clear", () => {
	it("resets all tracked files and modified files", () => {
		const tracker = new FileTracker();
		const fileA = writeTmpFile("a-clear.ts", "a");
		const fileB = writeTmpFile("b-clear.ts", "b");

		tracker.track(fileA, "a");
		tracker.trackWrite(fileB, "b");

		tracker.clear();

		expect(tracker.getModifiedFiles()).toHaveLength(0);
		expect(tracker.checkFreshness(fileA).status).toBe("untracked");
		expect(tracker.checkFreshness(fileB).status).toBe("untracked");
	});

	it("is safe to call on a fresh tracker", () => {
		const tracker = new FileTracker();
		expect(() => tracker.clear()).not.toThrow();
		expect(tracker.getModifiedFiles()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Multiple instances are independent
// ---------------------------------------------------------------------------

describe("independent tracker instances", () => {
	it("tracker A and tracker B do not share state", () => {
		const trackerA = new FileTracker();
		const trackerB = new FileTracker();

		const filePath = writeTmpFile("shared.ts", "shared");
		trackerA.trackWrite(filePath, "shared");

		expect(trackerA.getModifiedFiles()).toContain(filePath);
		expect(trackerB.getModifiedFiles()).not.toContain(filePath);
	});
});
