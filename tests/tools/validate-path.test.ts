/**
 * validate-path.test.ts
 *
 * Tests for the validatePath() security helper in file-ops.ts.
 *
 * validatePath is the primary defence against directory traversal attacks —
 * it ensures that any path an agent tries to read or write is inside the
 * declared workspace boundary. These tests are security-critical and must
 * cover every bypass attempt exhaustively.
 *
 * No mocks needed: validatePath is a pure synchronous function.
 */

import { describe, it, expect } from "bun:test";
import path from "node:path";
import { tmpdir } from "node:os";

// file-ops.ts imports electrobun/bun transitively (via plugins) but
// validatePath itself does not use it. We mock the heavy dependencies so the
// module loads cleanly without side-effects.
import { mock } from "bun:test";

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-validate-path" } },
}));
mock.module("../../src/bun/db", () => ({ db: {} }));
mock.module("../../src/bun/plugins", () => ({
	notifyFileChange: async () => [],
}));

const { validatePath } = await import("../../src/bun/agents/tools/file-ops");

// ---------------------------------------------------------------------------
// Use the OS temp dir as the workspace root in tests
// ---------------------------------------------------------------------------

const WORKSPACE = path.resolve(tmpdir(), "agentdesk-test-workspace");

// ---------------------------------------------------------------------------
// No workspacePath — simple path resolution
// ---------------------------------------------------------------------------

describe("validatePath — no workspacePath (no boundary check)", () => {
	it("resolves a relative path against process.cwd()", () => {
		const result = validatePath("src/index.ts");
		expect(path.isAbsolute(result)).toBe(true);
	});

	it("returns an absolute path unchanged", () => {
		const abs = path.join(tmpdir(), "some-file.txt");
		expect(validatePath(abs)).toBe(abs);
	});

	it("does not throw for any path when no workspacePath is given", () => {
		expect(() => validatePath("../../etc/passwd")).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Valid paths inside workspace
// ---------------------------------------------------------------------------

describe("validatePath — paths inside the workspace", () => {
	it("accepts a relative path that resolves inside the workspace", () => {
		const resolved = validatePath("src/index.ts", WORKSPACE);
		expect(resolved).toBe(path.resolve(WORKSPACE, "src/index.ts"));
	});

	it("accepts a deeply nested relative path", () => {
		const resolved = validatePath("a/b/c/d/file.ts", WORKSPACE);
		expect(resolved).toContain(WORKSPACE);
	});

	it("accepts an absolute path that is inside the workspace", () => {
		const abs = path.join(WORKSPACE, "src", "app.ts");
		const resolved = validatePath(abs, WORKSPACE);
		expect(resolved).toBe(abs);
	});

	it("accepts a path exactly equal to the workspace root", () => {
		const resolved = validatePath(WORKSPACE, WORKSPACE);
		expect(resolved).toBe(path.resolve(WORKSPACE));
	});

	it("resolves dot-segments that stay within the workspace", () => {
		// src/../lib/index.ts resolves to lib/index.ts — still inside workspace
		const resolved = validatePath("src/../lib/index.ts", WORKSPACE);
		expect(resolved).toBe(path.resolve(WORKSPACE, "lib/index.ts"));
	});
});

// ---------------------------------------------------------------------------
// Directory traversal attacks — must throw
// ---------------------------------------------------------------------------

describe("validatePath — directory traversal prevention", () => {
	it("throws when a relative path escapes via '../'", () => {
		expect(() => validatePath("../../etc/passwd", WORKSPACE)).toThrow(
			/outside the workspace boundary/i,
		);
	});

	it("throws when an absolute path is outside the workspace", () => {
		expect(() => validatePath("/etc/hosts", WORKSPACE)).toThrow(
			/outside the workspace boundary/i,
		);
	});

	it("throws for a path that starts with the workspace but escapes via traversal", () => {
		// e.g. /tmp/agentdesk-test-workspace/../sensitive
		const traversal = path.join(WORKSPACE, "..", "sensitive-data", "secret.txt");
		expect(() => validatePath(traversal, WORKSPACE)).toThrow(
			/outside the workspace boundary/i,
		);
	});

	it("throws for a path that only LOOKS like it is inside workspace (prefix attack)", () => {
		// If workspace is /tmp/workspace, a path like /tmp/workspace-evil should NOT be allowed.
		const evilPath = WORKSPACE + "-evil/file.txt";
		expect(() => validatePath(evilPath, WORKSPACE)).toThrow(
			/outside the workspace boundary/i,
		);
	});

	it("throws when relative path goes to root and back", () => {
		const manyDots = "../".repeat(20) + "etc/passwd";
		expect(() => validatePath(manyDots, WORKSPACE)).toThrow(
			/outside the workspace boundary/i,
		);
	});
});

// ---------------------------------------------------------------------------
// allowedPaths — additional permitted directories
// ---------------------------------------------------------------------------

describe("validatePath — allowedPaths extension", () => {
	const ALLOWED_DIR = path.resolve(tmpdir(), "allowed-extra-dir");

	it("accepts a path inside an allowedPaths directory", () => {
		const target = path.join(ALLOWED_DIR, "data.json");
		const resolved = validatePath(target, WORKSPACE, [ALLOWED_DIR]);
		expect(resolved).toBe(target);
	});

	it("still rejects paths outside workspace AND allowedPaths", () => {
		expect(() => validatePath("/root/.ssh/id_rsa", WORKSPACE, [ALLOWED_DIR])).toThrow(
			/outside the workspace boundary/i,
		);
	});

	it("accepts paths inside the primary workspace when allowedPaths is provided", () => {
		const target = path.join(WORKSPACE, "src/component.tsx");
		const resolved = validatePath(target, WORKSPACE, [ALLOWED_DIR]);
		expect(resolved).toBe(target);
	});

	it("handles an empty allowedPaths array the same as no allowedPaths", () => {
		const valid = path.join(WORKSPACE, "file.ts");
		expect(() => validatePath(valid, WORKSPACE, [])).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Return value
// ---------------------------------------------------------------------------

describe("validatePath — return value", () => {
	it("always returns an absolute path", () => {
		const result = validatePath("src/index.ts", WORKSPACE);
		expect(path.isAbsolute(result)).toBe(true);
	});

	it("normalises path separators to the OS convention", () => {
		// On Windows forward-slashes in the input should be normalised
		const result = validatePath("src/foo/bar.ts", WORKSPACE);
		// path.resolve always normalises for the current OS
		expect(result).toBe(path.resolve(WORKSPACE, "src", "foo", "bar.ts"));
	});

	it("strips trailing slashes from the workspace boundary (consistent resolution)", () => {
		const workspaceWithSlash = WORKSPACE + path.sep;
		const target = path.join(WORKSPACE, "index.ts");
		// Should not throw — boundary check normalises the workspace
		expect(() => validatePath(target, workspaceWithSlash)).not.toThrow();
	});
});
