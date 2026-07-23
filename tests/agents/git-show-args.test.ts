/**
 * git-show-args.test.ts
 *
 * `git_show(stat: true, patch: false)` — the documented "fast file-list-only
 * view" — used to build `git show <c> --stat --no-patch`, which prints no file
 * list at all: `-s` suppresses every form of diff output, the stat included.
 * The tool returned bare commit metadata while claiming to return a file list.
 *
 * Caught by running the tool against a real commit, not by any type or lint
 * check, because the arguments are individually valid — they just cancel out.
 *
 * Only the arg construction is tested here; git.ts imports the DB, so the pure
 * part is exported for this file rather than executing the tool.
 */

import { describe, it, expect } from "bun:test";
import { buildGitShowArgs } from "../../src/bun/agents/tools/git";

describe("buildGitShowArgs", () => {
	it("never combines --stat with --no-patch", () => {
		for (const file of [undefined, "src/index.ts"]) {
			for (const stat of [true, false]) {
				for (const patch of [true, false]) {
					const args = buildGitShowArgs("abc123", stat, patch, file);
					const cancelled = args.includes("--stat") && args.includes("--no-patch");
					expect({ stat, patch, file, cancelled }).toEqual({ stat, patch, file, cancelled: false });
				}
			}
		}
	});

	it("stat-only uses `log -1 --stat`, which actually prints the file list", () => {
		expect(buildGitShowArgs("abc123", true, false)).toEqual(["log", "-1", "--stat", "abc123"]);
	});

	it("stat + patch uses `show --stat`", () => {
		expect(buildGitShowArgs("abc123", true, true)).toEqual(["show", "abc123", "--stat"]);
	});

	it("neither uses `show --no-patch` for metadata only", () => {
		expect(buildGitShowArgs("abc123", false, false)).toEqual(["show", "--no-patch", "abc123"]);
	});

	it("applies a pathspec in both modes that produce file output", () => {
		expect(buildGitShowArgs("abc123", true, true, "a.ts")).toEqual(["show", "abc123", "--stat", "--", "a.ts"]);
		expect(buildGitShowArgs("abc123", true, false, "a.ts")).toEqual(["log", "-1", "--stat", "abc123", "--", "a.ts"]);
	});

	it("omits the pathspec in metadata-only mode", () => {
		// `git show --no-patch -- <file>` errors; there is no output to narrow.
		expect(buildGitShowArgs("abc123", false, false, "a.ts")).not.toContain("a.ts");
	});
});
