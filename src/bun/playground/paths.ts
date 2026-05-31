// ---------------------------------------------------------------------------
// Playground temp-folder layout
//
//   {os.tmpdir()}/agentdesk-playground/
//     files/                 ← agent workspace (cwd, shell sandbox root, static
//                              web root, copied verbatim on "Create Project")
//     .playground/           ← internal metadata (NEVER copied into a project)
//       conversation.json    ← [{ role, content }] turns for context threading
//       preview.json         ← current preview manifest
//
// A single active playground (no per-session subfolders) — "New Playground"
// wipes the whole root and recreates the empty structure.
// ---------------------------------------------------------------------------

import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";

export const PLAYGROUND_ROOT = path.join(os.tmpdir(), "agentdesk-playground");
export const PLAYGROUND_FILES_DIR = path.join(PLAYGROUND_ROOT, "files");
export const PLAYGROUND_META_DIR = path.join(PLAYGROUND_ROOT, ".playground");
export const CONVERSATION_FILE = path.join(PLAYGROUND_META_DIR, "conversation.json");
export const PREVIEW_FILE = path.join(PLAYGROUND_META_DIR, "preview.json");

/** Directory/file names that must never be copied into a created project. */
export const PLAYGROUND_COPY_IGNORE = new Set([
	"node_modules", ".git", "dist", "build", ".next", ".cache", ".turbo",
	".playground", ".DS_Store", "Thumbs.db",
]);

/** Create the playground directory structure if it does not exist (idempotent). */
export function ensurePlaygroundDirs(): void {
	mkdirSync(PLAYGROUND_FILES_DIR, { recursive: true });
	mkdirSync(PLAYGROUND_META_DIR, { recursive: true });
}

/** Delete everything and recreate an empty structure. Used by "New Playground". */
export function wipePlayground(): void {
	// `recursive` removes the whole tree at any nesting depth. `maxRetries`/`retryDelay`
	// handle Windows EBUSY/EPERM when a just-killed dev server (or antivirus/indexer) still
	// briefly holds a file handle — Node retries on those error codes automatically.
	rmSync(PLAYGROUND_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	ensurePlaygroundDirs();
}

/** True if the agent has created at least one artifact file. */
export function hasPlaygroundFiles(): boolean {
	try {
		return readdirSync(PLAYGROUND_FILES_DIR).length > 0;
	} catch {
		return false;
	}
}

export { existsSync };
