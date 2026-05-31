/**
 * truncation.ts — Tool output truncation with disk-based overflow
 *
 * Caps tool outputs at configurable line/byte limits. When truncated,
 * the full output is saved to a temp file on disk and the model gets
 * a preview + hint to use read_file with offset/limit.
 *
 * Inspired by OpenCode's Truncate module. This is the single biggest
 * token-saving measure: tool results never blow up the context window.
 */

import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { readdir, unlink, stat } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Directory where full truncated outputs are saved. */
let truncationDir: string | null = null;

/** Max age of truncation files before cleanup (7 days). */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface TruncateOptions {
	maxLines?: number;
	maxBytes?: number;
	/** "head" keeps the first N lines, "tail" keeps the last N lines. */
	direction?: "head" | "tail";
}

export interface TruncateResult {
	content: string;
	truncated: boolean;
	/** Path to the full output file, if truncated. */
	savedPath?: string;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Set the directory for storing full truncated outputs.
 * Called once at startup with the app's userData path.
 */
export function initTruncationDir(baseDir: string): void {
	truncationDir = path.join(baseDir, "truncated-outputs");
	if (!existsSync(truncationDir)) {
		mkdirSync(truncationDir, { recursive: true });
	}
}

/**
 * Get the truncation dir, creating it lazily if not initialized.
 * Falls back to OS temp dir if initTruncationDir was never called.
 */
function getTruncationDir(): string {
	if (truncationDir) return truncationDir;

	// Fallback: use OS temp
	const fallback = path.join(
		process.env.TEMP || process.env.TMP || "/tmp",
		"agentdesk-truncated-outputs",
	);
	if (!existsSync(fallback)) {
		mkdirSync(fallback, { recursive: true });
	}
	truncationDir = fallback;
	return fallback;
}

// ---------------------------------------------------------------------------
// Core truncation
// ---------------------------------------------------------------------------

/**
 * Truncate tool output if it exceeds limits. When truncated, saves the
 * full output to a temp file and returns a preview with a hint.
 *
 * Default limits: 500 lines or 40KB (whichever is hit first).
 */
export async function truncateOutput(
	text: string,
	toolName: string,
	options: TruncateOptions = {},
): Promise<TruncateResult> {
	const maxLines = options.maxLines ?? 500;
	const maxBytes = options.maxBytes ?? 40_000;
	const direction = options.direction ?? "head";

	const lines = text.split("\n");
	const totalBytes = Buffer.byteLength(text, "utf-8");

	// If within limits, return as-is
	if (lines.length <= maxLines && totalBytes <= maxBytes) {
		return { content: text, truncated: false };
	}

	// Build truncated preview
	const preview: string[] = [];
	let bytes = 0;

	if (direction === "head") {
		for (let i = 0; i < lines.length && preview.length < maxLines; i++) {
			const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
			if (bytes + lineBytes > maxBytes) break;
			preview.push(lines[i]);
			bytes += lineBytes;
		}
	} else {
		// Tail: collect from the end
		for (let i = lines.length - 1; i >= 0 && preview.length < maxLines; i--) {
			const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (preview.length > 0 ? 1 : 0);
			if (bytes + lineBytes > maxBytes) break;
			preview.unshift(lines[i]);
			bytes += lineBytes;
		}
	}

	// Save full output to disk
	const dir = getTruncationDir();
	const filename = `${toolName}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.txt`;
	const savedPath = path.join(dir, filename);

	try {
		await Bun.write(savedPath, text);
	} catch {
		// If we can't save to disk, just truncate without hint
		const omitted = lines.length - preview.length;
		const previewText = preview.join("\n");
		return {
			content: direction === "head"
				? `${previewText}\n\n... (${omitted} more lines, ${totalBytes} bytes total — truncated)`
				: `... (${omitted} lines omitted, ${totalBytes} bytes total — truncated)\n\n${previewText}`,
			truncated: true,
		};
	}

	const omitted = lines.length - preview.length;
	const previewText = preview.join("\n");

	const hint =
		`The output was truncated (${lines.length} lines, ${totalBytes} bytes). ` +
		`Full output saved to: ${savedPath}\n` +
		`Use read_file with startLine/endLine to view specific sections, or search_content to find specific patterns.`;

	const content = direction === "head"
		? `${previewText}\n\n... ${omitted} more lines truncated ...\n\n${hint}`
		: `... ${omitted} lines truncated ...\n\n${hint}\n\n${previewText}`;

	return { content, truncated: true, savedPath };
}

// ---------------------------------------------------------------------------
// Tool-specific presets
// ---------------------------------------------------------------------------

/** Truncate read_file output — 500 lines max, hint to use line range. */
export async function truncateReadFile(text: string): Promise<TruncateResult> {
	return truncateOutput(text, "read_file", { maxLines: 500, maxBytes: 40_000 });
}

/** Truncate shell output — 200 lines max, tail (most recent output matters more). */
export async function truncateShellOutput(text: string): Promise<TruncateResult> {
	return truncateOutput(text, "shell", { maxLines: 200, maxBytes: 30_000, direction: "tail" });
}

/** Truncate search results — 50 matches max. */
export async function truncateSearchResults(text: string): Promise<TruncateResult> {
	return truncateOutput(text, "search", { maxLines: 50, maxBytes: 20_000 });
}

/** Truncate directory tree — 300 entries max. */
export async function truncateTree(text: string): Promise<TruncateResult> {
	return truncateOutput(text, "tree", { maxLines: 300, maxBytes: 25_000 });
}

// ---------------------------------------------------------------------------
// Cleanup — remove old truncation files
// ---------------------------------------------------------------------------

/**
 * Remove truncation files older than RETENTION_MS.
 * Call periodically (e.g., on app startup).
 */
export async function cleanupTruncationFiles(): Promise<number> {
	const dir = getTruncationDir();
	let removed = 0;

	try {
		const entries = await readdir(dir);
		const cutoff = Date.now() - RETENTION_MS;

		for (const entry of entries) {
			const filePath = path.join(dir, entry);
			try {
				const s = await stat(filePath);
				if (s.mtimeMs < cutoff) {
					await unlink(filePath);
					removed++;
				}
			} catch { /* skip */ }
		}
	} catch { /* dir may not exist */ }

	return removed;
}
