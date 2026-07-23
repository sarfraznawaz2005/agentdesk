/**
 * logger.ts — one category-scoped file logger for {userData}/logs/<category>.log.
 *
 * The same "append a timestamped line, rotate at 5 MB" routine had been
 * hand-copied into five places (agent-loop's logAgent, prompt-logger,
 * error-logger, ambient/debug-log, both updaters), each with slightly
 * different rotation and failure behaviour. New diagnostics should use this
 * instead of writing a sixth copy.
 *
 * Deliberately NOT a replacement for error-logger: that one also mirrors into
 * the audit table and installs process-level handlers. This is the plain
 * diagnostic-trace case.
 *
 * Never throws. A logging failure must never take down the thing being logged.
 */

import { Utils } from "electrobun/bun";
import { existsSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync } from "fs";
import { join } from "path";

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_OLD_FILES = 2;

/**
 * Log files this module owns. A union rather than a free string so a typo
 * can't silently scatter lines across `provider_errors.log` and `provider-errors.log`.
 *
 * - `agent-loop`      — sub-agent run lifecycle (start/steps/compaction/end)
 * - `provider_errors` — every AI provider call failure (endpoint, status, retries),
 *                       from any call site; see providers/error-log.ts
 */
export type LogCategory = "agent-loop" | "provider_errors";

const paths = new Map<LogCategory, string>();

function resolvePath(category: LogCategory): string {
	const cached = paths.get(category);
	if (cached) return cached;
	const dir = join(Utils.paths.userData, "logs");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const path = join(dir, `${category}.log`);
	paths.set(category, path);
	return path;
}

function rotateIfNeeded(path: string): void {
	try {
		if (!existsSync(path) || statSync(path).size < MAX_LOG_SIZE) return;
		// <name>.log.2 dropped, .1 → .2, current → .1
		for (let i = MAX_OLD_FILES; i >= 1; i--) {
			const src = i === 1 ? path : `${path}.${i - 1}`;
			const dst = `${path}.${i}`;
			if (!existsSync(src)) continue;
			if (i === MAX_OLD_FILES && existsSync(dst)) unlinkSync(dst);
			renameSync(src, dst);
		}
	} catch {
		// Rotation failure is non-critical — keep appending to the current file.
	}
}

/** Append one timestamped line to `<category>.log`. */
export function log(category: LogCategory, line: string): void {
	try {
		const path = resolvePath(category);
		rotateIfNeeded(path);
		appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// Non-critical — a diagnostic trace must never break the caller.
	}
}

/** Bind a category once at module scope: `const logAgent = createLogger("agent-loop")`. */
export function createLogger(category: LogCategory): (line: string) => void {
	return (line: string) => log(category, line);
}

/**
 * Render `{ a: 1, b: "x y" }` as `a=1 b="x y"` for a scannable, greppable line.
 * Undefined/null values are dropped; strings containing spaces are quoted.
 */
export function fields(values: Record<string, string | number | boolean | undefined | null>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined || value === null) continue;
		const str = String(value);
		parts.push(`${key}=${/[\s"]/.test(str) ? JSON.stringify(str) : str}`);
	}
	return parts.join(" ");
}
