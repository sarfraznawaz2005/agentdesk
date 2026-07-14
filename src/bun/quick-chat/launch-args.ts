// ---------------------------------------------------------------------------
// Detects whether this launch was triggered by the OS Explorer "Open in
// AgentDesk" context-menu entry, and if so, for which folder.
//
// PRIMARY mechanism: a handoff file. LIVE-TESTED and confirmed necessary —
// Electrobun's launcher.exe does NOT forward its own argv to the bundled
// bun/index.js it spawns (a real run showed process.argv as exactly
// [bun.exe path, index.js path], regardless of what was passed to
// launcher.exe). The registry command (os-integration.ts) instead runs a
// small PowerShell script — the same "spawn hidden PowerShell to do OS
// integration work" pattern already proven in windows-registry.ts — that
// writes the target folder to this well-known file BEFORE launching
// launcher.exe, and this module reads (and deletes) it once on every
// startup.
//
// SECONDARY mechanism: still checks process.argv for a --quick-chat flag
// too, in case a future Electrobun version does forward launcher args, or
// another code path (a test harness, a different platform's launch
// mechanism) invokes the app directly with it. Costs nothing to keep.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { Utils } from "electrobun/bun";

const QUICK_CHAT_FLAG = "--quick-chat";

/** Shared with os-integration.ts, which writes this file from the registered Explorer command. */
export function quickChatHandoffFilePath(): string {
	return join(Utils.paths.userData, "quick-chat-request.txt");
}

function parseFromArgv(argv: string[]): string | null {
	const flagIndex = argv.indexOf(QUICK_CHAT_FLAG);
	if (flagIndex === -1 || flagIndex === argv.length - 1) return null;
	const path = argv[flagIndex + 1]?.trim();
	return path || null;
}

/** Reads and deletes the pending handoff file, if present. Destructive — call at most once per startup. */
function readAndClearHandoffFile(): string | null {
	const filePath = quickChatHandoffFilePath();
	if (!existsSync(filePath)) return null;
	let content: string | null = null;
	try {
		// Windows PowerShell 5.1's `Set-Content -Encoding UTF8` (the launcher
		// script writes with it) prepends a UTF-8 BOM — strip it explicitly
		// (via a charCode check, not a literal character in source, so this
		// is unambiguous regardless of editor/encoding) rather than relying
		// on trim()'s handling of U+FEFF.
		let raw = readFileSync(filePath, "utf8");
		if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
		content = raw.trim() || null;
	} catch (err) {
		console.error("[quick-chat] Failed to read handoff file:", err);
	}
	try { unlinkSync(filePath); } catch { /* best-effort cleanup */ }
	return content;
}

/** Returns the requested workspace path for this launch, or null if this isn't a Quick Chat launch. */
export function parseQuickChatPathFromArgv(argv: string[] = process.argv): string | null {
	return readAndClearHandoffFile() ?? parseFromArgv(argv);
}
