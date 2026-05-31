/**
 * paths.test.ts
 *
 * Tests for the Playground temp-folder lifecycle helpers (src/bun/playground/paths.ts).
 *
 * These are pure fs/path helpers (no Electrobun/db), so they import cleanly with no mocks.
 * The most important behaviour is that "New Playground" (wipePlayground) recursively removes
 * ARBITRARILY-NESTED folders and recreates an empty structure — the exact concern about
 * "folders inside folders".
 */

import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
	PLAYGROUND_ROOT,
	PLAYGROUND_FILES_DIR,
	PLAYGROUND_META_DIR,
	PLAYGROUND_COPY_IGNORE,
	ensurePlaygroundDirs,
	wipePlayground,
	hasPlaygroundFiles,
} from "../../src/bun/playground/paths";

describe("playground paths", () => {
	it("locates the playground under the OS temp dir with files/ and .playground/ subdirs", () => {
		expect(PLAYGROUND_ROOT).toBe(path.join(tmpdir(), "agentdesk-playground"));
		expect(PLAYGROUND_FILES_DIR).toBe(path.join(PLAYGROUND_ROOT, "files"));
		expect(PLAYGROUND_META_DIR).toBe(path.join(PLAYGROUND_ROOT, ".playground"));
		// .playground is a SIBLING of files/, so metadata is never inside the served/copied tree.
		expect(PLAYGROUND_META_DIR.startsWith(PLAYGROUND_FILES_DIR)).toBe(false);
	});

	it("ensurePlaygroundDirs creates both the files and meta dirs (idempotent)", () => {
		wipePlayground();
		ensurePlaygroundDirs();
		ensurePlaygroundDirs(); // second call must not throw
		expect(existsSync(PLAYGROUND_FILES_DIR)).toBe(true);
		expect(existsSync(PLAYGROUND_META_DIR)).toBe(true);
	});

	it("excludes dependency/build/metadata dirs from project copies", () => {
		for (const name of ["node_modules", ".git", "dist", "build", ".next", ".playground"]) {
			expect(PLAYGROUND_COPY_IGNORE.has(name)).toBe(true);
		}
	});

	it("hasPlaygroundFiles reflects whether the files dir has content", () => {
		wipePlayground();
		expect(hasPlaygroundFiles()).toBe(false);
		writeFileSync(path.join(PLAYGROUND_FILES_DIR, "index.html"), "<h1>hi</h1>");
		expect(hasPlaygroundFiles()).toBe(true);
	});

	it("wipePlayground recursively deletes deeply nested folders and recreates an empty structure", () => {
		ensurePlaygroundDirs();

		// Deeply nested tree: files/a/b/c/d/e/deep.txt
		const deep = path.join(PLAYGROUND_FILES_DIR, "a", "b", "c", "d", "e");
		mkdirSync(deep, { recursive: true });
		writeFileSync(path.join(deep, "deep.txt"), "x");

		// A node_modules-style tree (lots of nesting) + a top-level file
		const nm = path.join(PLAYGROUND_FILES_DIR, "node_modules", "pkg", "lib");
		mkdirSync(nm, { recursive: true });
		writeFileSync(path.join(nm, "index.js"), "x");
		writeFileSync(path.join(PLAYGROUND_FILES_DIR, "index.html"), "<h1>hi</h1>");

		expect(hasPlaygroundFiles()).toBe(true);

		wipePlayground();

		// Entire tree gone…
		expect(existsSync(path.join(PLAYGROUND_FILES_DIR, "a"))).toBe(false);
		expect(existsSync(path.join(PLAYGROUND_FILES_DIR, "node_modules"))).toBe(false);
		expect(existsSync(path.join(PLAYGROUND_FILES_DIR, "index.html"))).toBe(false);
		// …structure recreated and empty.
		expect(existsSync(PLAYGROUND_FILES_DIR)).toBe(true);
		expect(existsSync(PLAYGROUND_META_DIR)).toBe(true);
		expect(readdirSync(PLAYGROUND_FILES_DIR).length).toBe(0);
		expect(hasPlaygroundFiles()).toBe(false);
	});
});
