/**
 * Global error logging system.
 *
 * Writes errors to {userData}/logs/error.log with auto-rotation (5 MB max,
 * keeps 2 old files). Works independently of the database so it can capture
 * DB-related crashes too.
 */
import { Utils } from "electrobun/bun";
import { existsSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { logAudit } from "./audit";

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_OLD_FILES = 2;

let logsDir: string | null = null;

function getLogsDir(): string {
	if (!logsDir) {
		logsDir = join(Utils.paths.userData, "logs");
		if (!existsSync(logsDir)) {
			mkdirSync(logsDir, { recursive: true });
		}
	}
	return logsDir;
}

function getLogPath(): string {
	return join(getLogsDir(), "error.log");
}

function rotateIfNeeded(): void {
	const logPath = getLogPath();
	if (!existsSync(logPath)) return;

	try {
		const { size } = statSync(logPath);
		if (size < MAX_LOG_SIZE) return;

		// Shift old files: error.log.2 → deleted, error.log.1 → error.log.2, etc.
		for (let i = MAX_OLD_FILES; i >= 1; i--) {
			const src = i === 1 ? logPath : `${logPath}.${i - 1}`;
			const dst = `${logPath}.${i}`;
			if (existsSync(src)) {
				if (i === MAX_OLD_FILES && existsSync(dst)) {
					unlinkSync(dst);
				}
				renameSync(src, dst);
			}
		}
	} catch {
		// Rotation failure is non-critical — continue logging to current file
	}
}

/**
 * Write error to audit log (best-effort, never throws).
 * Skipped for uncaughtException since the process is about to exit
 * and the DB may be in a broken state.
 */
function logErrorToAudit(
	source: "bun" | "renderer",
	type: string,
	message: string,
): void {
	try {
		logAudit({
			action: "error",
			entityType: "error",
			entityId: `${source}:${type}`,
			details: { source, type, message: message.slice(0, 1000) },
		});
	} catch {
		// DB may not be ready — silently skip
	}
}

/**
 * Append a structured error entry to the log file.
 */
export function logError(
	source: "bun" | "renderer",
	type: string,
	message: string,
	stack?: string,
): void {
	try {
		rotateIfNeeded();

		const timestamp = new Date().toISOString();
		const lines = [
			`[${timestamp}] [${source}] [${type}]`,
			`  ${message}`,
		];
		if (stack) {
			lines.push(
				...stack
					.split("\n")
					.slice(0, 20) // cap stack depth
					.map((l) => `  ${l}`),
			);
		}
		lines.push(""); // blank line separator

		appendFileSync(getLogPath(), lines.join("\n") + "\n");
	} catch {
		// Last resort — if we can't write to the log file, at least console it
		console.error(`[error-logger] Failed to write error log: ${message}`);
	}

	// Also record in audit log for UI visibility (skip fatal errors — process is exiting)
	if (type !== "uncaughtException") {
		logErrorToAudit(source, type, message);
	}
}

/**
 * Install global process-level error handlers. Call this as early as possible
 * in the bun process lifecycle, before DB init.
 */
export function initGlobalErrorHandlers(): void {
	process.on("uncaughtException", (err: Error) => {
		const message = err?.message ?? String(err);
		const stack = err?.stack;
		console.error("[FATAL] Uncaught exception:", message);
		logError("bun", "uncaughtException", message, stack);
		process.exit(1);
	});

	process.on("unhandledRejection", (reason: unknown) => {
		const err = reason instanceof Error ? reason : new Error(String(reason));
		const message = err.message;
		const stack = err.stack;
		// AI SDK race condition: tool resolves after stream controller is closed on abort.
		// Benign — the agent was already stopped. Suppress the noise.
		if (message.includes("Controller is already closed")) return;
		console.error("[ERROR] Unhandled rejection:", message);
		logError("bun", "unhandledRejection", message, stack);
		// Don't exit — unhandled rejections are usually recoverable
	});

	console.log("[error-logger] Global error handlers installed.");
}
