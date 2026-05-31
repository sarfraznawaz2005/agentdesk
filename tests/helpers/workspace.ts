/**
 * tests/helpers/workspace.ts
 *
 * Utilities for creating and cleaning up temporary test workspaces on disk.
 */

import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface TempWorkspace {
	path: string;
	cleanup: () => void;
}

/**
 * Create a unique temporary directory for use as a test workspace.
 * Call `cleanup()` in afterEach/afterAll to remove it.
 */
export function createTempWorkspace(): TempWorkspace {
	const path = join(
		tmpdir(),
		`agentdesk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(path, { recursive: true });
	return {
		path,
		cleanup: () => rmSync(path, { recursive: true, force: true }),
	};
}

/**
 * Write a file inside a workspace directory.
 * Returns the absolute path of the written file.
 */
export function writeFile(dir: string, name: string, content: string): string {
	const full = join(dir, name);
	// Ensure parent directories exist
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content, "utf-8");
	return full;
}
