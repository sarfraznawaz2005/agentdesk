/**
 * ignore.test.ts
 *
 * Tests for src/bun/agents/tools/ignore.ts:
 *   - createIgnoreFilter   — combines ALWAYS_IGNORE + .gitignore patterns
 *   - extendIgnoreFilter   — accumulates nested .gitignore rules
 *   - isPathIgnored        — checks each segment of a relative path
 *   - clearIgnoreCache     — resets the module-level caches
 *
 * Real filesystem I/O is used only to write temporary .gitignore files
 * inside a per-test temp directory. No Electrobun or DB dependencies.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const {
	createIgnoreFilter,
	extendIgnoreFilter,
	isPathIgnored,
	clearIgnoreCache,
} = await import("../../src/bun/agents/tools/ignore");

// ---------------------------------------------------------------------------
// Temp workspace
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
	testDir = path.join(
		tmpdir(),
		`agentdesk-ignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(testDir, { recursive: true });
	// Always clear caches so tests are independent
	clearIgnoreCache();
});

afterEach(() => {
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
	clearIgnoreCache();
});

function writeGitignore(dir: string, content: string): void {
	writeFileSync(path.join(dir, ".gitignore"), content, "utf-8");
}

// ---------------------------------------------------------------------------
// createIgnoreFilter — ALWAYS_IGNORE
// ---------------------------------------------------------------------------

describe("createIgnoreFilter — ALWAYS_IGNORE entries", () => {
	it("ignores 'node_modules'", async () => {
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("node_modules")).toBe(true);
	});

	it("ignores '.git'", async () => {
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored(".git")).toBe(true);
	});

	it("ignores 'dist'", async () => {
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("dist")).toBe(true);
	});

	it("ignores 'build'", async () => {
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("build")).toBe(true);
	});

	it("ignores '__pycache__'", async () => {
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("__pycache__")).toBe(true);
	});

	it("ignores '.vscode'", async () => {
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored(".vscode")).toBe(true);
	});

	it("ignores 'target' (Rust build)", async () => {
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("target")).toBe(true);
	});

	it("is case-insensitive for ALWAYS_IGNORE (e.g. NODE_MODULES)", async () => {
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("NODE_MODULES")).toBe(true);
		expect(filter.isIgnored("Dist")).toBe(true);
	});

	it("does NOT ignore a normal source file name", async () => {
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("index.ts")).toBe(false);
		expect(filter.isIgnored("App.tsx")).toBe(false);
		expect(filter.isIgnored("README.md")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// createIgnoreFilter — .gitignore patterns
// ---------------------------------------------------------------------------

describe("createIgnoreFilter — .gitignore patterns", () => {
	it("ignores entries matching a .gitignore pattern", async () => {
		writeGitignore(testDir, "*.log\nbuild-output/\n");
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("app.log")).toBe(true);
		expect(filter.isIgnored("error.log")).toBe(true);
	});

	it("does not ignore entries that do not match .gitignore patterns", async () => {
		writeGitignore(testDir, "*.log\n");
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("app.ts")).toBe(false);
		expect(filter.isIgnored("main.go")).toBe(false);
	});

	it("skips blank lines and comments in .gitignore", async () => {
		writeGitignore(testDir, "# This is a comment\n\n*.log\n");
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("app.log")).toBe(true);
		// Comments and blanks don't become patterns
		expect(filter.isIgnored("# This is a comment")).toBe(false);
	});

	it("strips leading slash from root-anchored .gitignore patterns", async () => {
		writeGitignore(testDir, "/dist/\n");
		const filter = await createIgnoreFilter(testDir);
		// After stripping the slash, pattern becomes "dist" — matches the name
		expect(filter.isIgnored("dist")).toBe(true);
	});

	it("returns a fresh (non-cached) filter after clearIgnoreCache", async () => {
		// Without .gitignore, nothing matches custom patterns
		const filterBefore = await createIgnoreFilter(testDir);
		expect(filterBefore.isIgnored("coverage")).toBe(true); // ALWAYS_IGNORE

		// Now write a .gitignore that would add *.bak
		writeGitignore(testDir, "*.bak\n");
		clearIgnoreCache();

		const filterAfter = await createIgnoreFilter(testDir);
		expect(filterAfter.isIgnored("backup.bak")).toBe(true);
	});

	it("uses cache — second call with same dir returns same object", async () => {
		const filter1 = await createIgnoreFilter(testDir);
		const filter2 = await createIgnoreFilter(testDir);
		// Same reference (cached)
		expect(filter1).toBe(filter2);
	});
});

// ---------------------------------------------------------------------------
// createIgnoreFilter — no .gitignore file
// ---------------------------------------------------------------------------

describe("createIgnoreFilter — directory with no .gitignore", () => {
	it("still ignores ALWAYS_IGNORE entries even without a .gitignore", async () => {
		// testDir has no .gitignore
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("node_modules")).toBe(true);
	});

	it("does not ignore regular source file names", async () => {
		const filter = await createIgnoreFilter(testDir);
		expect(filter.isIgnored("src")).toBe(false);
		expect(filter.isIgnored("index.ts")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// extendIgnoreFilter
// ---------------------------------------------------------------------------

describe("extendIgnoreFilter", () => {
	it("inherits all parent rules", async () => {
		const parentFilter = await createIgnoreFilter(testDir);
		const subDir = path.join(testDir, "sub");
		mkdirSync(subDir, { recursive: true });

		const childFilter = await extendIgnoreFilter(parentFilter, subDir);
		// Parent's ALWAYS_IGNORE rules should still apply
		expect(childFilter.isIgnored("node_modules")).toBe(true);
	});

	it("adds child .gitignore patterns on top of parent rules", async () => {
		const parentFilter = await createIgnoreFilter(testDir);
		const subDir = path.join(testDir, "sub");
		mkdirSync(subDir, { recursive: true });
		writeGitignore(subDir, "*.tmp\n");

		const childFilter = await extendIgnoreFilter(parentFilter, subDir);
		expect(childFilter.isIgnored("temp.tmp")).toBe(true);
		// Parent rules still work
		expect(childFilter.isIgnored("node_modules")).toBe(true);
	});

	it("returns the parent filter when the child dir has no .gitignore", async () => {
		const parentFilter = await createIgnoreFilter(testDir);
		const subDir = path.join(testDir, "clean-sub");
		mkdirSync(subDir, { recursive: true });
		// No .gitignore in subDir

		const childFilter = await extendIgnoreFilter(parentFilter, subDir);
		// Should be the same object (no new rules added)
		expect(childFilter).toBe(parentFilter);
	});

	it("child-only patterns do not leak into parent filter", async () => {
		const parentFilter = await createIgnoreFilter(testDir);
		const subDir = path.join(testDir, "sub-with-extra");
		mkdirSync(subDir, { recursive: true });
		writeGitignore(subDir, "*.secret\n");

		await extendIgnoreFilter(parentFilter, subDir);

		// Parent filter should NOT be contaminated
		expect(parentFilter.isIgnored("file.secret")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isPathIgnored
// ---------------------------------------------------------------------------

describe("isPathIgnored", () => {
	it("returns true when a path segment is in ALWAYS_IGNORE", async () => {
		// "src/node_modules/lodash/index.js" — node_modules is always ignored
		const result = await isPathIgnored("src/node_modules/lodash/index.js", testDir);
		expect(result).toBe(true);
	});

	it("returns false for a clean relative path with no ignored segments", async () => {
		const result = await isPathIgnored("src/components/Button.tsx", testDir);
		expect(result).toBe(false);
	});

	it("respects root .gitignore patterns in nested paths", async () => {
		writeGitignore(testDir, "*.log\n");
		clearIgnoreCache();

		// The log file segment should match root .gitignore
		const result = await isPathIgnored("logs/app.log", testDir);
		expect(result).toBe(true);
	});

	it("returns true for a path whose first segment is ignored", async () => {
		const result = await isPathIgnored("dist/bundle.js", testDir);
		expect(result).toBe(true);
	});

	it("returns false for a single-segment path that is a valid source file", async () => {
		const result = await isPathIgnored("index.ts", testDir);
		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// clearIgnoreCache
// ---------------------------------------------------------------------------

describe("clearIgnoreCache", () => {
	it("does not throw when called multiple times", () => {
		expect(() => {
			clearIgnoreCache();
			clearIgnoreCache();
		}).not.toThrow();
	});

	it("forces re-read of .gitignore files after cache clear", async () => {
		// No .gitignore initially
		const filter1 = await createIgnoreFilter(testDir);
		expect(filter1.isIgnored("*.snap")).toBe(false);

		// Add a .gitignore
		writeGitignore(testDir, "*.snap\n");
		clearIgnoreCache();

		const filter2 = await createIgnoreFilter(testDir);
		// New filter should pick up the pattern
		// Note: *.snap is a glob — Bun.Glob will try to match against "file.snap"
		expect(filter2.isIgnored("component.snap")).toBe(true);
	});
});
