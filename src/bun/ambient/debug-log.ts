// Ambient voice pipeline debug log — every diagnostic point added while
// investigating the barge-in/echo/latency issues (recording, turns, tool
// calls, TTS, timing) writes here via logAmbient() instead of a bare
// console.log, so there's a persistent record in {userData}/logs/ambient.log
// even without DevTools or the dev terminal open. Mirrors prompt-logger.ts's
// size-capped append pattern, minus its debug_prompts on/off gate — this is
// an always-on diagnostic aid, not something with a privacy/performance cost
// worth hiding behind a setting.

import { Utils } from "electrobun/bun";
import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
let logPath: string | null = null;

// Both off by default — logAmbient() call sites stay in place (they're cheap
// and useful for a future debugging pass) but don't persist real user
// transcripts to disk for every user by default. Flip LOG_TO_FILE back to
// true locally when actively debugging the ambient pipeline.
const LOG_TO_CONSOLE = false;
const LOG_TO_FILE = false;

function getLogPath(): string {
	if (!logPath) logPath = join(Utils.paths.userData, "logs", "ambient.log");
	return logPath;
}

function rotateIfNeeded(path: string) {
	try {
		if (existsSync(path) && statSync(path).size > MAX_LOG_SIZE) renameSync(path, `${path}.old`);
	} catch {
		// best-effort — a rotation failure shouldn't break logging itself
	}
}

/**
 * When enabled, echoes to console (LOG_TO_CONSOLE) and/or appends a
 * timestamped line to {userData}/logs/ambient.log (LOG_TO_FILE) — use this
 * instead of console.log for anything in the ambient voice pipeline (frontend
 * callers go through the logAmbientDebug RPC, see mainview/lib/log-ambient.ts,
 * since the webview has no direct file access). A no-op with both off.
 */
export function logAmbient(message: string): void {
	if (LOG_TO_CONSOLE) console.log(`[ambient] ${message}`);
	if (!LOG_TO_FILE) return;
	try {
		const path = getLogPath();
		mkdirSync(dirname(path), { recursive: true });
		rotateIfNeeded(path);
		appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// best-effort — never let logging itself break a turn
	}
}
