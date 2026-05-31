import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import { readdir, unlink, rename, mkdir, stat, copyFile as fsCopyFile, chmod, appendFile as fsAppendFile } from "node:fs/promises";
import { createPatch } from "diff";
import { ripgrep } from "ripgrep";
import path from "node:path";
import { createWriteStream } from "node:fs";
import type { ToolRegistryEntry } from "./index";
import type { FileTracker } from "./file-tracker";
import { notifyFileChange } from "../../plugins";
import { truncateSearchResults, truncateTree } from "./truncation";

/** Write file and notify plugins (LSP servers) of the change. Returns any diagnostics. */
async function writeAndNotify(filePath: string, content: string): Promise<string[]> {
	await Bun.write(filePath, content);
	try {
		return await notifyFileChange(filePath, content);
	} catch {
		return [];
	}
}

/** Format diagnostics as a suffix for tool results. */
function formatDiagnosticsSuffix(diagnostics: string[]): string {
	if (diagnostics.length === 0) return "";
	return `\n\nLSP Diagnostics (${diagnostics.length}):\n${diagnostics.join("\n")}`;
}
import { createIgnoreFilter, extendIgnoreFilter, isPathIgnored, type IgnoreFilter } from "./ignore";

// ---------------------------------------------------------------------------
// Path safety helper
// ---------------------------------------------------------------------------

/**
 * Resolves `targetPath` to an absolute path and, when `workspacePath` is
 * provided, verifies the resolved path is inside the workspace or one of the
 * additional allowed directories (prevents directory traversal attacks).
 *
 * Throws if the path escapes all allowed boundaries.
 */
export function validatePath(targetPath: string, workspacePath?: string, allowedPaths?: string[]): string {
	// Resolve relative paths against workspace (not process CWD which is the Electrobun build dir)
	const resolved = workspacePath && !path.isAbsolute(targetPath)
		? path.resolve(workspacePath, targetPath)
		: path.resolve(targetPath);

	if (workspacePath) {
		const candidates = [workspacePath, ...(allowedPaths ?? [])];
		let allowed = false;

		for (const candidate of candidates) {
			const resolvedCandidate = path.resolve(candidate);
			const normalized = resolvedCandidate.endsWith(path.sep)
				? resolvedCandidate
				: resolvedCandidate + path.sep;
			if (resolved.startsWith(normalized) || resolved === resolvedCandidate) {
				allowed = true;
				break;
			}
		}

		if (!allowed) {
			throw new Error(
				`Path "${resolved}" is outside the workspace boundary "${path.resolve(workspacePath)}"`,
			);
		}
	}

	return resolved;
}

// ---------------------------------------------------------------------------
// Shared parameter schemas (used by both static tools and tracked factory)
// ---------------------------------------------------------------------------

const readFileParams = z.object({
	path: z.string().describe("Absolute or relative path to the file to read"),
	startLine: z.number().int().min(1).optional().describe("1-based line number to start reading from (inclusive). Omit to read from the beginning."),
	endLine: z.number().int().min(1).optional().describe("1-based line number to stop reading at (inclusive). Omit to read to the end."),
});
const writeFileParams = z.object({
	path: z.string().describe("Absolute or relative path to the file to write"),
	content: z.string().describe("The text content to write to the file"),
});
const editFileParams = z.object({
	path: z.string().describe("Absolute or relative path to the file to edit"),
	old_text: z.string().describe("The exact text to search for and replace (must appear in the file). When useRegex is true, this is a regex pattern."),
	new_text: z.string().describe("The replacement text. When useRegex is true, supports capture group references ($1, $2, etc.)"),
	useRegex: z.boolean().optional().default(false).describe("When true, treat old_text as a regex pattern instead of literal text"),
	regexFlags: z.string().optional().default("").describe("Regex flags when useRegex is true: g (global/all matches), m (multiline), i (case-insensitive). Example: 'gi'"),
	replace_all: z.boolean().optional().default(false).describe("When true, replace ALL occurrences of old_text in the file (not just the first). Ignored when useRegex is true — use regexFlags 'g' instead."),
});
const multiEditFileParams = z.object({
	path: z.string().describe("Absolute or relative path to the file to edit"),
	edits: z.array(z.object({
		old_text: z.string().describe("Exact text to find (must exist in the file at time of replacement)"),
		new_text: z.string().describe("Replacement text"),
	})).min(1).describe("Ordered list of edits to apply sequentially"),
});
const appendFileParams = z.object({
	path: z.string().describe("Absolute or relative path to the file to append to"),
	content: z.string().describe("The text to append"),
});
const patchFileParams = z.object({
	path: z.string().describe("Absolute or relative path to the file to patch"),
	patch: z.string().describe("The unified diff content to apply (unified diff format)"),
});
const deleteFileParams = z.object({
	path: z.string().describe("Absolute or relative path to the file to delete"),
});
const moveFileParams = z.object({
	source: z.string().describe("Absolute or relative path to the file to move"),
	destination: z.string().describe("Absolute or relative path for the file's new location"),
});

// ---------------------------------------------------------------------------
// Line-range helper for read_file
// ---------------------------------------------------------------------------

/**
 * Extracts a line range from file content. When startLine/endLine are omitted,
 * returns the full content. When specified, returns only the requested lines
 * plus a metadata header with total line count and range info.
 */
function sliceFileContent(
	content: string,
	startLine?: number,
	endLine?: number,
): string {
	if (startLine === undefined && endLine === undefined) {
		return content;
	}

	const lines = content.split("\n");
	const totalLines = lines.length;
	const start = Math.max(1, startLine ?? 1);
	const end = Math.min(totalLines, endLine ?? totalLines);

	if (start > totalLines) {
		return `[totalLines: ${totalLines}] Requested startLine ${start} exceeds file length.`;
	}

	const sliced = lines.slice(start - 1, end);
	return `[lines ${start}-${end} of ${totalLines}]\n${sliced.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const readFileTool = tool({
	description:
		"Read the contents of a file. Optionally specify startLine and endLine to read a specific range of lines (1-based, inclusive). " +
		"When a range is specified, the response includes total line count so you know the file size. " +
		"For large files, prefer reading in chunks rather than loading the entire file.",
	inputSchema: readFileParams,
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			const content = await Bun.file(resolvedPath).text();
			return sliceFileContent(content, args.startLine, args.endLine);
		} catch (err) {
			return `Error reading file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

const writeFileTool = tool({
	description:
		"Write content to a file at the given path, creating the file (and any missing parent directories) if it does not exist, or overwriting it if it does.",
	inputSchema: writeFileParams,
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			const parentDir = path.dirname(resolvedPath);

			// Create parent directories if they don't exist (equivalent to mkdir -p)
			await mkdir(parentDir, { recursive: true });

			const diags = await writeAndNotify(resolvedPath, args.content);
			return `Successfully wrote ${args.content.length} bytes to "${resolvedPath}"${formatDiagnosticsSuffix(diags)}`;
		} catch (err) {
			return `Error writing file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

/**
 * Performs the find-replace on `original` content using either literal or regex mode.
 * Returns { updated, error } — if error is set, the edit should be rejected.
 */
function applyEditReplace(
	original: string,
	oldText: string,
	newText: string,
	useRegex?: boolean,
	regexFlags?: string,
	replaceAll?: boolean,
): { updated?: string; error?: string } {
	if (useRegex) {
		try {
			const re = new RegExp(oldText, regexFlags || "");
			if (!re.test(original)) {
				return { error: "regex pattern did not match anything in file" };
			}
			// Re-create regex since test() advances lastIndex for global
			const reFresh = new RegExp(oldText, regexFlags || "");
			return { updated: original.replace(reFresh, newText) };
		} catch (err) {
			return { error: `invalid regex: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	if (!original.includes(oldText)) {
		return { error: "old_text not found in file" };
	}
	if (replaceAll) {
		return { updated: original.split(oldText).join(newText) };
	}
	return { updated: original.replace(oldText, newText) };
}

const editFileTool = tool({
	description:
		"Edit a file by replacing old_text with new_text. By default replaces only the first occurrence — set replace_all=true to replace every occurrence. " +
		"Set useRegex=true to treat old_text as a regex pattern (new_text supports $1, $2 capture refs). " +
		"Use regexFlags for global (g), multiline (m), or case-insensitive (i) matching.",
	inputSchema: editFileParams,
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			const original = await Bun.file(resolvedPath).text();

			const result = applyEditReplace(original, args.old_text, args.new_text, args.useRegex, args.regexFlags, args.replace_all);
			if (result.error) {
				return `Error editing file "${resolvedPath}": ${result.error}`;
			}

			const diags = await writeAndNotify(resolvedPath, result.updated ?? "");
			return `Successfully edited "${resolvedPath}"${formatDiagnosticsSuffix(diags)}`;
		} catch (err) {
			return `Error editing file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

const listDirectoryTool = tool({
	description:
		"List files and directories inside a directory. Optionally filter results by a glob pattern. " +
		"Automatically hides common non-essential entries (node_modules, .git, dist, __pycache__, etc.) and respects .gitignore.",
	inputSchema: z.object({
		directory: z.string().describe("Absolute or relative path to the directory to list"),
		pattern: z
			.string()
			.optional()
			.describe(
				"Optional glob pattern to filter results (e.g. '*.ts'). Only applied to file names, not full paths.",
			),
	}),
	execute: async (args): Promise<string> => {
		try {
			const dir = args.directory || (args as Record<string, unknown>).path as string | undefined;
			if (!dir) return "Error: 'directory' parameter is required";
			const resolvedDir = validatePath(dir);
			const ignoreFilter = await createIgnoreFilter(resolvedDir);
			const entries = await readdir(resolvedDir, { withFileTypes: true });

			let names = entries
				.filter((e) => !ignoreFilter.isIgnored(e.name))
				.map((e) => {
					const suffix = e.isDirectory() ? "/" : "";
					return e.name + suffix;
				});

			if (args.pattern) {
				const glob = new Bun.Glob(args.pattern);
				names = names.filter((name) => {
					const baseName = name.endsWith("/") ? name.slice(0, -1) : name;
					return glob.match(baseName);
				});
			}

			return JSON.stringify(names);
		} catch (err) {
			return `Error listing directory "${args.directory}": ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

const searchFilesTool = tool({
	description:
		"Search for files matching a glob pattern within a directory (recursive). " +
		"Automatically skips ignored directories (node_modules, .git, dist, etc.) and respects .gitignore. " +
		"Returns a JSON array of matching file paths (up to 200 results).",
	inputSchema: z.object({
		directory: z
			.string()
			.describe("Absolute or relative path to the root directory to search in"),
		pattern: z
			.string()
			.describe(
				"Glob pattern to match files against (e.g. '**/*.ts', 'src/**/*.test.*')",
			),
	}),
	execute: async (args): Promise<string> => {
		try {
			const dir = args.directory || (args as Record<string, unknown>).path as string | undefined;
			if (!dir) return "Error: 'directory' parameter is required";
			const resolvedDir = validatePath(dir);
			const glob = new Bun.Glob(args.pattern);

			// Collect all matching paths first, then batch the ignore checks in parallel
			const allPaths: string[] = [];
			for await (const filePath of glob.scan({ cwd: resolvedDir, onlyFiles: true })) {
				allPaths.push(filePath);
			}

			const ignoreResults = await Promise.all(
				allPaths.map((p) => isPathIgnored(p, resolvedDir)),
			);

			const results = allPaths
				.filter((_, i) => !ignoreResults[i])
				.slice(0, 200)
				.map((p) => path.join(resolvedDir, p));

			return JSON.stringify(results);
		} catch (err) {
			return `Error searching files in "${args.directory}": ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

const searchContentTool = tool({
	description:
		"Search the text content of files within a directory for lines matching a regex query (like grep -rn). " +
		"Automatically skips ignored directories (node_modules, .git, dist, etc.) and respects .gitignore. " +
		"Returns up to 100 matches in the format 'file:lineNumber:content'.",
	inputSchema: z.object({
		query: z
			.string()
			.describe("The regex pattern to search for within file contents"),
		directory: z
			.string()
			.describe("Absolute or relative path to the root directory to search in"),
		filePattern: z
			.string()
			.optional()
			.describe(
				"Optional glob pattern to restrict which files are searched (e.g. '**/*.ts')",
			),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedDir = validatePath(args.directory);

			const rgArgs: string[] = [
				"--json",
				"--max-count", "100",
				"--max-total-count", "100",
			];

			if (args.filePattern) {
				rgArgs.push("--glob", args.filePattern);
			}

			// Escape the query for ripgrep — it accepts PCRE-compatible regex
			rgArgs.push(args.query, ".");

			const { code, stdout } = await ripgrep(rgArgs, {
				buffer: true,
				// Map guest "." to our target directory so ripgrep sees all files
				preopens: { ".": resolvedDir },
			});

			// code 1 = no matches (not an error), code 2 = error
			if (code === 2) {
				// Fall back to JS grep on ripgrep error (invalid regex, etc.)
				const fileGlob = new Bun.Glob(args.filePattern ?? "**/*");
				const queryRegex = new RegExp(args.query);
				const matches: string[] = [];

				for await (const relPath of fileGlob.scan({ cwd: resolvedDir, onlyFiles: true })) {
					if (matches.length >= 100) break;
					if (await isPathIgnored(relPath, resolvedDir)) continue;
					const absoluteFilePath = path.join(resolvedDir, relPath);
					let content: string;
					try { content = await Bun.file(absoluteFilePath).text(); } catch { continue; }
					const lines = content.split("\n");
					for (let i = 0; i < lines.length; i++) {
						if (queryRegex.test(lines[i])) {
							matches.push(`${absoluteFilePath}:${i + 1}:${lines[i]}`);
							if (matches.length >= 100) break;
						}
					}
				}
				if (matches.length === 0) return "No matches found";
				const raw = matches.join("\n");
				const result = await truncateSearchResults(raw);
				return result.content;
			}

			if (code === 1 || !stdout.trim()) return "No matches found";

			// Parse ripgrep JSON output — each line is a JSON object
			const matches: string[] = [];
			for (const line of stdout.split("\n")) {
				if (!line.trim()) continue;
				try {
					const obj = JSON.parse(line) as {
						type: string;
						data: { path: { text: string }; line_number: number; lines: { text: string } };
					};
					if (obj.type === "match") {
						const absPath = path.join(resolvedDir, obj.data.path.text);
						const lineNum = obj.data.line_number;
						const lineContent = obj.data.lines.text.trimEnd();
						matches.push(`${absPath}:${lineNum}:${lineContent}`);
						if (matches.length >= 100) break;
					}
				} catch { /* skip malformed JSON lines */ }
			}

			if (matches.length === 0) return "No matches found";
			const raw = matches.join("\n");
			const result = await truncateSearchResults(raw);
			return result.content;
		} catch (err) {
			return `Error searching content in "${args.directory}": ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

const deleteFileTool = tool({
	description: "Delete a file at the given path.",
	inputSchema: deleteFileParams,
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			await unlink(resolvedPath);
			return `Successfully deleted "${resolvedPath}"`;
		} catch (err) {
			return `Error deleting file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

const moveFileTool = tool({
	description:
		"Move or rename a file from source path to destination path. Creates parent directories at the destination if needed.",
	inputSchema: moveFileParams,
	execute: async (args): Promise<string> => {
		try {
			const resolvedSource = validatePath(args.source);
			const resolvedDest = validatePath(args.destination);

			const destParent = path.dirname(resolvedDest);
			await mkdir(destParent, { recursive: true });

			await rename(resolvedSource, resolvedDest);
			return `Successfully moved "${resolvedSource}" to "${resolvedDest}"`;
		} catch (err) {
			return `Error moving file from "${args.source}" to "${args.destination}": ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

const appendFileTool = tool({
	description:
		"Append text to the end of a file without reading it first. " +
		"Creates the file (and any missing parent directories) if it does not exist. " +
		"More efficient than read_file + write_file for log files or large files.",
	inputSchema: appendFileParams,
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			const parentDir = path.dirname(resolvedPath);
			await mkdir(parentDir, { recursive: true });
			// Use fs.appendFile — no full-file read before write
			await fsAppendFile(resolvedPath, args.content);
			// Notify LSP with current content (read-back is only for diagnostics)
			try {
				const fullContent = await Bun.file(resolvedPath).text();
				await notifyFileChange(resolvedPath, fullContent);
			} catch { /* non-fatal */ }

			return `Successfully appended ${args.content.length} bytes to "${resolvedPath}"`;
		} catch (err) {
			return `Error appending to file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

const multiEditFileTool = tool({
	description:
		"Apply multiple find-and-replace edits to a single file in one operation. " +
		"Accepts an ordered array of {old_text, new_text} pairs applied sequentially. " +
		"Fails fast if any old_text is not found, reporting which edit failed. " +
		"Use this instead of multiple edit_file calls to reduce round-trips.",
	inputSchema: multiEditFileParams,
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			let content = await Bun.file(resolvedPath).text();

			for (let i = 0; i < args.edits.length; i++) {
				const { old_text, new_text } = args.edits[i];
				if (!content.includes(old_text)) {
					return `Error in edit ${i + 1}/${args.edits.length}: old_text not found in "${resolvedPath}":\n${old_text.slice(0, 200)}`;
				}
				content = content.replace(old_text, new_text);
			}

			const diags = await writeAndNotify(resolvedPath,content);
			return `Successfully applied ${args.edits.length} edit(s) to "${resolvedPath}"${formatDiagnosticsSuffix(diags)}`;
		} catch (err) {
			return `Error editing file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

const diffTextTool = tool({
	description:
		"Generate a unified diff between two strings (before and after). " +
		"Useful for producing a human-readable summary of changes during code review.",
	inputSchema: z.object({
		before: z.string().describe("The original text"),
		after: z.string().describe("The modified text"),
		label: z.string().optional().describe("Optional label used as the filename in the diff header (default: 'file')"),
	}),
	execute: async ({ before, after, label = "file" }): Promise<string> => {
		try {
			const diff = createPatch(label, before, after, "original", "modified");
			// createPatch always returns a header even with no changes — detect empty diff
			const lines = diff.split("\n");
			const hasChanges = lines.some(l => l.startsWith("+") || l.startsWith("-"));
			if (!hasChanges) return "(no differences)";

			const MAX = 20_000;
			return diff.length > MAX ? diff.slice(0, MAX) + "\n... (truncated)" : diff;
		} catch (err) {
			return `Error generating diff: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// patch_file — apply a unified diff patch to a file
// ---------------------------------------------------------------------------

/**
 * Parsed hunk from a unified diff. Each line carries its type so we can
 * use context lines for fuzz matching when the file has shifted.
 */
interface PatchHunk {
	/** 1-based line number in the original file where this hunk starts */
	origStart: number;
	/** Number of lines in the original file this hunk covers */
	origCount: number;
	/** Ordered patch operations: context (keep), remove, or add */
	ops: Array<{ type: "context" | "remove" | "add"; text: string }>;
}

/**
 * Parse a unified diff string into structured hunks.
 */
function parseUnifiedDiff(patch: string): PatchHunk[] {
	const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
	const lines = patch.split("\n");
	const hunks: PatchHunk[] = [];
	let current: PatchHunk | null = null;

	for (const line of lines) {
		const m = line.match(hunkHeaderRe);
		if (m) {
			if (current) hunks.push(current);
			current = {
				origStart: parseInt(m[1], 10),
				origCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
				ops: [],
			};
			continue;
		}
		if (!current) continue;
		// Skip diff header lines (---, +++, diff, index, etc.)
		if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) continue;

		if (line.startsWith("-")) {
			current.ops.push({ type: "remove", text: line.slice(1) });
		} else if (line.startsWith("+")) {
			current.ops.push({ type: "add", text: line.slice(1) });
		} else if (line.startsWith(" ") || line === "") {
			// Context line — the leading space is part of the diff format
			current.ops.push({ type: "context", text: line.startsWith(" ") ? line.slice(1) : line });
		}
		// Lines starting with \ (e.g. "\ No newline at end of file") are informational — skip
	}
	if (current) hunks.push(current);
	return hunks;
}

/**
 * Try to find the best offset where the hunk's context/remove lines match
 * the file. Starts at the expected position and searches outward (fuzz).
 * Returns the 0-based index in `fileLines` or -1 if no match found.
 */
function findHunkOffset(fileLines: string[], hunk: PatchHunk, maxFuzz: number): number {
	// Build the sequence of lines we expect to see in the file (context + remove)
	const expected = hunk.ops
		.filter((op) => op.type === "context" || op.type === "remove")
		.map((op) => op.text);

	if (expected.length === 0) {
		// Pure insertion — use the original start position
		return Math.min(hunk.origStart - 1, fileLines.length);
	}

	const idealIdx = hunk.origStart - 1; // 0-based

	// Search outward from ideal position
	for (let fuzz = 0; fuzz <= maxFuzz; fuzz++) {
		for (const offset of fuzz === 0 ? [0] : [-fuzz, fuzz]) {
			const tryIdx = idealIdx + offset;
			if (tryIdx < 0 || tryIdx + expected.length > fileLines.length) continue;

			let matches = true;
			for (let i = 0; i < expected.length; i++) {
				if (fileLines[tryIdx + i] !== expected[i]) {
					matches = false;
					break;
				}
			}
			if (matches) return tryIdx;
		}
	}
	return -1;
}

const patchFileTool = tool({
	description:
		"Apply a unified diff (patch) to a file. The patch should be in standard unified diff format " +
		"(lines prefixed with +, -, or space for context). Handles context lines for accurate matching " +
		"and supports fuzz matching (up to 50 lines offset) when the file has shifted. " +
		"Best for applying diffs generated by diff_text or git diff.",
	inputSchema: patchFileParams,
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			const original = await Bun.file(resolvedPath).text();
			const fileLines = original.split("\n");

			const hunks = parseUnifiedDiff(args.patch);
			if (hunks.length === 0) {
				return `Error: no valid hunks found in the patch`;
			}

			// Apply hunks in reverse order to preserve line numbers for earlier hunks
			hunks.sort((a, b) => b.origStart - a.origStart);

			const applied: string[] = [];
			for (const hunk of hunks) {
				const idx = findHunkOffset(fileLines, hunk, 50);
				if (idx === -1) {
					return `Error: hunk starting at line ${hunk.origStart} could not be matched in "${resolvedPath}". File may have diverged from the patch.`;
				}

				// Build the replacement: walk ops, skip removes, keep adds, verify context
				const newLines: string[] = [];
				let filePos = idx;
				for (const op of hunk.ops) {
					if (op.type === "context") {
						newLines.push(fileLines[filePos]);
						filePos++;
					} else if (op.type === "remove") {
						// Skip the line in the file (it's being removed)
						filePos++;
					} else {
						// add
						newLines.push(op.text);
					}
				}

				// Count how many file lines this hunk consumed
				const consumed = hunk.ops.filter((op) => op.type === "context" || op.type === "remove").length;
				fileLines.splice(idx, consumed, ...newLines);
				applied.push(`line ${hunk.origStart}${idx !== hunk.origStart - 1 ? ` (matched at ${idx + 1})` : ""}`);
			}

			const patchedContent = fileLines.join("\n");
			const diags = await writeAndNotify(resolvedPath, patchedContent);
			return `Successfully patched "${resolvedPath}" — ${hunks.length} hunk(s) applied: ${applied.join(", ")}${formatDiagnosticsSuffix(diags)}`;
		} catch (err) {
			return `Error patching file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// copy_file — binary-safe file copy
// ---------------------------------------------------------------------------

const copyFileTool = tool({
	description:
		"Copy a file from source to destination. Binary-safe (works for images, fonts, etc.). " +
		"Creates parent directories at the destination if needed.",
	inputSchema: z.object({
		source: z.string().describe("Absolute or relative path to the source file"),
		destination: z.string().describe("Absolute or relative path for the copy"),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedSource = validatePath(args.source);
			const resolvedDest = validatePath(args.destination);

			const destParent = path.dirname(resolvedDest);
			await mkdir(destParent, { recursive: true });

			await fsCopyFile(resolvedSource, resolvedDest);
			return `Successfully copied "${resolvedSource}" to "${resolvedDest}"`;
		} catch (err) {
			return `Error copying file: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// file_info — file metadata (size, modified time, line count, exists)
// ---------------------------------------------------------------------------

const fileInfoTool = tool({
	description:
		"Get metadata about a file: whether it exists, size in bytes, last modified time, " +
		"and line count (for text files). Useful for checking file state before operations.",
	inputSchema: z.object({
		path: z.string().describe("Absolute or relative path to the file"),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			const file = Bun.file(resolvedPath);
			const exists = await file.exists();

			if (!exists) {
				return JSON.stringify({ exists: false, path: resolvedPath });
			}

			const info = await stat(resolvedPath);
			const result: Record<string, unknown> = {
				exists: true,
				path: resolvedPath,
				size: info.size,
				modifiedAt: info.mtime.toISOString(),
				isDirectory: info.isDirectory(),
			};

			// Count lines for text files (skip large files > 10MB)
			if (!info.isDirectory() && info.size < 10_000_000) {
				try {
					const content = await file.text();
					result.lineCount = content.split("\n").length;
				} catch {
					// Binary file or encoding issue — skip line count
				}
			}

			return JSON.stringify(result);
		} catch (err) {
			return `Error getting file info: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// find_dead_code — scan for unused exports in TS/JS files
// ---------------------------------------------------------------------------

const findDeadCodeTool = tool({
	description:
		"Scan TypeScript/JavaScript files in a directory for exported symbols that are not imported " +
		"anywhere else in the project. Returns a JSON array of potentially unused exports with file " +
		"paths and symbol names. Useful for identifying dead code during refactoring. " +
		"Automatically skips ignored directories (node_modules, .git, dist, etc.) and respects .gitignore. " +
		"Note: only detects named exports referenced via import statements — dynamic imports, " +
		"re-exports from barrel files, and runtime usage (e.g. string-based lookups) may cause false positives.",
	inputSchema: z.object({
		directory: z
			.string()
			.describe("Absolute or relative path to the directory to scan"),
		filePattern: z
			.string()
			.optional()
			.default("**/*.{ts,tsx,js,jsx}")
			.describe('Glob pattern for files to scan (default: "**/*.{ts,tsx,js,jsx}")'),
		maxResults: z
			.number()
			.int()
			.min(1)
			.max(500)
			.optional()
			.default(100)
			.describe("Maximum number of unused exports to return (default: 100)"),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedDir = validatePath(args.directory);
			const fileGlob = new Bun.Glob(args.filePattern ?? "**/*.{ts,tsx,js,jsx}");

			// Phase 1: Collect all exported symbols and cache file contents
			const exportMap = new Map<string, { file: string; symbols: string[] }>();
			const allFiles: string[] = [];
			// Content cache — avoids O(exports × files) re-reads in Phase 2
			const contentCache = new Map<string, string>();

			for await (const relPath of fileGlob.scan({ cwd: resolvedDir, onlyFiles: true })) {
				if (await isPathIgnored(relPath, resolvedDir)) continue;

				const absPath = path.join(resolvedDir, relPath);
				allFiles.push(absPath);

				let content: string;
				try {
					content = await Bun.file(absPath).text();
				} catch {
					continue;
				}
				contentCache.set(absPath, content);

				const symbols: string[] = [];

				// Match: export function name, export class name, export const/let/var name
				const namedExportRe = /export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
				let m: RegExpExecArray | null;
				while ((m = namedExportRe.exec(content)) !== null) {
					symbols.push(m[1]);
				}

				// Match: export { name1, name2, name3 }
				const braceExportRe = /export\s*\{([^}]+)\}/g;
				while ((m = braceExportRe.exec(content)) !== null) {
					const names = m[1].split(",").map((s) => {
						// Handle "name as alias" — the original name is what matters
						const parts = s.trim().split(/\s+as\s+/);
						return parts[0].trim();
					}).filter(Boolean);
					symbols.push(...names);
				}

				if (symbols.length > 0) {
					exportMap.set(absPath, { file: relPath, symbols });
				}
			}

			// Phase 2: For each exported symbol, check if it's imported anywhere else.
			// Uses contentCache to avoid re-reading files from disk.
			const unusedExports: Array<{ file: string; symbol: string }> = [];

			for (const [exportFile, { file: relFile, symbols }] of exportMap) {
				for (const sym of symbols) {
					// Skip common entry-point names that are used by frameworks
					if (sym === "default" || sym === "App" || sym === "main") continue;

					let found = false;
					// Check all cached file contents for an import of this symbol
					for (const checkFile of allFiles) {
						if (checkFile === exportFile) continue;
						const content = contentCache.get(checkFile);
						if (!content) continue;

						// Check for: import { sym } or import { ... sym ... } or import { x as sym }
						// Also check for direct references like `from "...file"` combined with sym usage
						if (content.includes(sym)) {
							found = true;
							break;
						}
					}

					if (!found) {
						unusedExports.push({ file: relFile, symbol: sym });
						if (unusedExports.length >= (args.maxResults ?? 100)) break;
					}
				}
				if (unusedExports.length >= (args.maxResults ?? 100)) break;
			}

			if (unusedExports.length === 0) {
				return JSON.stringify({ message: "No unused exports found", scannedFiles: allFiles.length });
			}

			return JSON.stringify({
				unusedExports,
				count: unusedExports.length,
				scannedFiles: allFiles.length,
				note: "These exports are not referenced by name in any other scanned file. Verify before deleting — dynamic imports, barrel re-exports, and test files may cause false positives.",
			});
		} catch (err) {
			return `Error scanning for dead code: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// File conflict callback — emits activity events when edits are rejected
// ---------------------------------------------------------------------------

export type FileConflictCallback = (filePath: string) => void;

// ---------------------------------------------------------------------------
// Tracked file tools factory — per-agent-instance tools with freshness guards
// ---------------------------------------------------------------------------

const FILE_MODIFIED_MSG =
	"File was modified by another agent or external process since you last read it. " +
	"Read the file again before editing so you have the latest content.";

/**
 * Creates file tools that are bound to a per-agent FileTracker instance.
 *
 * - read_file:      tracks content hash + mtime after reading
 * - write_file:     tracks after writing
 * - edit_file:      checks freshness before editing, rejects if stale
 * - multi_edit_file: same guard as edit_file
 * - patch_file:     same guard as edit_file
 * - append_file:    tracks after appending
 * - delete_file:    removes from tracker
 * - move_file:      removes source from tracker
 *
 * Returns a map of tool name → Tool (without category metadata) so the
 * caller can overlay them onto the base tool set returned by getToolsForAgent().
 */
export function createTrackedFileTools(
	tracker: FileTracker,
	onConflict?: FileConflictCallback,
	workspacePath?: string,
	allowedPaths?: string[],
): Record<string, Tool> {
	/** Shorthand — validates path and enforces workspace boundary + allowed paths */
	const vp = (p: string) => validatePath(p, workspacePath, allowedPaths);
	const trackedReadFile = tool({
		description:
			"Read the contents of a file. Optionally specify startLine and endLine to read a specific range of lines (1-based, inclusive). " +
			"When a range is specified, the response includes total line count so you know the file size. " +
			"For large files, prefer reading in chunks rather than loading the entire file.",
		inputSchema: readFileParams,
		execute: async (args) => {
			try {
				const resolvedPath = vp(args.path);
				const content = await Bun.file(resolvedPath).text();
				tracker.track(resolvedPath);
				return sliceFileContent(content, args.startLine, args.endLine);
			} catch (err) {
				return `Error reading file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	const trackedWriteFile = tool({
		description: "Write content to a file at the given path, creating the file (and any missing parent directories) if it does not exist, or overwriting it if it does.",
		inputSchema: writeFileParams,
		execute: async (args) => {
			try {
				const resolvedPath = vp(args.path);
				const parentDir = path.dirname(resolvedPath);
				await mkdir(parentDir, { recursive: true });
				const diags = await writeAndNotify(resolvedPath, args.content);
				tracker.trackWrite(resolvedPath);

				return `Successfully wrote ${args.content.length} bytes to "${resolvedPath}"${formatDiagnosticsSuffix(diags)}`;
			} catch (err) {
				return `Error writing file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	const trackedEditFile = tool({
		description:
			"Edit a file by replacing old_text with new_text. By default replaces only the first occurrence — set replace_all=true to replace every occurrence. " +
			"Set useRegex=true to treat old_text as a regex pattern (new_text supports $1, $2 capture refs). " +
			"Use regexFlags for global (g), multiline (m), or case-insensitive (i) matching.",
		inputSchema: editFileParams,
		execute: async (args) => {
			try {
				const resolvedPath = vp(args.path);

				const freshness = tracker.checkFreshness(resolvedPath);
				if (freshness.status === "modified_externally") {
					onConflict?.(resolvedPath);
					return `Error editing file "${resolvedPath}": ${FILE_MODIFIED_MSG}`;
				}

				const original = await Bun.file(resolvedPath).text();
				const result = applyEditReplace(original, args.old_text, args.new_text, args.useRegex, args.regexFlags, args.replace_all);
				if (result.error) {
					return `Error editing file "${resolvedPath}": ${result.error}`;
				}
				const diags = await writeAndNotify(resolvedPath, result.updated ?? "");
				tracker.trackWrite(resolvedPath);

				return `Successfully edited "${resolvedPath}"${formatDiagnosticsSuffix(diags)}`;
			} catch (err) {
				return `Error editing file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	const trackedMultiEditFile = tool({
		description: "Apply multiple find-and-replace edits to a single file in one operation. Accepts an ordered array of {old_text, new_text} pairs applied sequentially. Fails fast if any old_text is not found.",
		inputSchema: multiEditFileParams,
		execute: async (args) => {
			try {
				const resolvedPath = vp(args.path);

				const freshness = tracker.checkFreshness(resolvedPath);
				if (freshness.status === "modified_externally") {
					onConflict?.(resolvedPath);
					return `Error editing file "${resolvedPath}": ${FILE_MODIFIED_MSG}`;
				}

				let content = await Bun.file(resolvedPath).text();
				for (let i = 0; i < args.edits.length; i++) {
					const { old_text, new_text } = args.edits[i];
					if (!content.includes(old_text)) {
						return `Error in edit ${i + 1}/${args.edits.length}: old_text not found in "${resolvedPath}":\n${old_text.slice(0, 200)}`;
					}
					content = content.replace(old_text, new_text);
				}
				const diags = await writeAndNotify(resolvedPath, content);
				tracker.trackWrite(resolvedPath);

				return `Successfully applied ${args.edits.length} edit(s) to "${resolvedPath}"${formatDiagnosticsSuffix(diags)}`;
			} catch (err) {
				return `Error editing file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	const trackedPatchFile = tool({
		description: "Apply a unified diff (patch) to a file. Supports fuzz matching (up to 50 lines offset).",
		inputSchema: patchFileParams,
		execute: async (args) => {
			try {
				const resolvedPath = vp(args.path);

				const freshness = tracker.checkFreshness(resolvedPath);
				if (freshness.status === "modified_externally") {
					onConflict?.(resolvedPath);
					return `Error patching file "${resolvedPath}": ${FILE_MODIFIED_MSG}`;
				}

				const original = await Bun.file(resolvedPath).text();
				const fileLines = original.split("\n");
				const hunks = parseUnifiedDiff(args.patch);
				if (hunks.length === 0) {
					return `Error: no valid hunks found in the patch`;
				}
				hunks.sort((a, b) => b.origStart - a.origStart);

				const applied: string[] = [];
				for (const hunk of hunks) {
					const idx = findHunkOffset(fileLines, hunk, 50);
					if (idx === -1) {
						return `Error: hunk starting at line ${hunk.origStart} could not be matched in "${resolvedPath}". File may have diverged from the patch.`;
					}
					const newLines: string[] = [];
					let filePos = idx;
					for (const op of hunk.ops) {
						if (op.type === "context") { newLines.push(fileLines[filePos]); filePos++; }
						else if (op.type === "remove") { filePos++; }
						else { newLines.push(op.text); }
					}
					const consumed = hunk.ops.filter((op) => op.type === "context" || op.type === "remove").length;
					fileLines.splice(idx, consumed, ...newLines);
					applied.push(`line ${hunk.origStart}${idx !== hunk.origStart - 1 ? ` (matched at ${idx + 1})` : ""}`);
				}

				const patched = fileLines.join("\n");
				const diags = await writeAndNotify(resolvedPath, patched);
				tracker.trackWrite(resolvedPath);

				return `Successfully patched "${resolvedPath}" — ${hunks.length} hunk(s) applied: ${applied.join(", ")}${formatDiagnosticsSuffix(diags)}`;
			} catch (err) {
				return `Error patching file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	const trackedAppendFile = tool({
		description: "Append text to the end of a file without reading it first. Creates the file if it does not exist.",
		inputSchema: appendFileParams,
		execute: async (args) => {
			try {
				const resolvedPath = vp(args.path);
				const parentDir = path.dirname(resolvedPath);
				await mkdir(parentDir, { recursive: true });
				// Use fs.appendFile — no full-file read before write
				await fsAppendFile(resolvedPath, args.content);
				tracker.trackWrite(resolvedPath);
				// Notify LSP with current content (read-back is only for diagnostics)
				try {
					const fullContent = await Bun.file(resolvedPath).text();
					await notifyFileChange(resolvedPath, fullContent);
				} catch { /* non-fatal */ }

				return `Successfully appended ${args.content.length} bytes to "${resolvedPath}"`;
			} catch (err) {
				return `Error appending to file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	const trackedDeleteFile = tool({
		description: "Delete a file at the given path.",
		inputSchema: deleteFileParams,
		execute: async (args) => {
			try {
				const resolvedPath = vp(args.path);
				await unlink(resolvedPath);
				tracker.remove(resolvedPath);

				return `Successfully deleted "${resolvedPath}"`;
			} catch (err) {
				return `Error deleting file "${args.path}": ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	const trackedMoveFile = tool({
		description: "Move or rename a file from source path to destination path. Creates parent directories at the destination if needed.",
		inputSchema: moveFileParams,
		execute: async (args) => {
			try {
				const resolvedSource = vp(args.source);
				const resolvedDest = vp(args.destination);
				const destParent = path.dirname(resolvedDest);
				await mkdir(destParent, { recursive: true });
				await rename(resolvedSource, resolvedDest);
				tracker.remove(resolvedSource);
				return `Successfully moved "${resolvedSource}" to "${resolvedDest}"`;
			} catch (err) {
				return `Error moving file from "${args.source}" to "${args.destination}": ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	});

	return {
		read_file: trackedReadFile,
		write_file: trackedWriteFile,
		edit_file: trackedEditFile,
		multi_edit_file: trackedMultiEditFile,
		patch_file: trackedPatchFile,
		append_file: trackedAppendFile,
		delete_file: trackedDeleteFile,
		move_file: trackedMoveFile,
	};
}

// ---------------------------------------------------------------------------
// directory_tree — recursive depth-limited tree view
// ---------------------------------------------------------------------------

async function buildTree(
	dir: string,
	prefix: string,
	depth: number,
	maxDepth: number,
	parentFilter: IgnoreFilter,
): Promise<string[]> {
	if (depth > maxDepth) return [];

	// Extend parent filter with this directory's .gitignore (if any)
	const ignoreFilter = await extendIgnoreFilter(parentFilter, dir);

	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const visible = entries
		.filter((e) => !ignoreFilter.isIgnored(e.name))
		.sort((a, b) => {
			if (a.isDirectory() && !b.isDirectory()) return -1;
			if (!a.isDirectory() && b.isDirectory()) return 1;
			return a.name.localeCompare(b.name);
		});

	// Collect directory entries that need recursive traversal, fan them out in parallel
	const dirTasks: Array<{ index: number; entry: (typeof visible)[0]; connector: string; childPrefix: string }> = [];
	const placeholders: string[] = new Array(visible.length).fill("");

	for (let i = 0; i < visible.length; i++) {
		const entry = visible[i];
		const isLast = i === visible.length - 1;
		const connector = isLast ? "└── " : "├── ";
		const childPrefix = isLast ? "    " : "│   ";

		if (entry.isDirectory()) {
			placeholders[i] = `${prefix}${connector}${entry.name}/`;
			if (depth < maxDepth) {
				dirTasks.push({ index: i, entry, connector, childPrefix });
			}
		} else {
			placeholders[i] = `${prefix}${connector}${entry.name}`;
		}
	}

	// Fan out all directory traversals in parallel, preserving original order
	const childResults = await Promise.all(
		dirTasks.map(({ entry, childPrefix }) =>
			buildTree(
				path.join(dir, entry.name),
				prefix + childPrefix,
				depth + 1,
				maxDepth,
				ignoreFilter,
			),
		),
	);

	// Rebuild lines array in original sorted order
	const lines: string[] = [];
	let taskIdx = 0;
	for (let i = 0; i < visible.length; i++) {
		if (placeholders[i]) lines.push(placeholders[i]);
		if (dirTasks[taskIdx]?.index === i) {
			lines.push(...childResults[taskIdx]);
			taskIdx++;
		}
	}
	return lines;
}

const directoryTreeTool = tool({
	description:
		"Show a recursive directory tree view with depth limit. Respects .gitignore patterns and skips " +
		"common non-essential directories (node_modules, .git, dist, build, __pycache__, etc.). " +
		"Much more efficient than repeated list_directory calls for understanding project structure.",
	inputSchema: z.object({
		path: z.string().describe("Absolute or relative path to the directory to tree"),
		maxDepth: z.number().int().min(1).max(10).optional().default(3)
			.describe("Maximum depth to recurse (default: 3, max: 10)"),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			const dirStat = await stat(resolvedPath);
			if (!dirStat.isDirectory()) {
				return `Error: "${resolvedPath}" is not a directory`;
			}

			const ignoreFilter = await createIgnoreFilter(resolvedPath);
			const dirName = path.basename(resolvedPath);
			const lines = [`${dirName}/`];
			const children = await buildTree(resolvedPath, "", 1, args.maxDepth ?? 3, ignoreFilter);
			lines.push(...children);

			const raw = lines.join("\n");
			const result = await truncateTree(raw);
			return result.content;
		} catch (err) {
			return `Error building directory tree: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// is_binary — detect whether a file is binary or text
// ---------------------------------------------------------------------------

const isBinaryTool = tool({
	description:
		"Check whether a file is binary (e.g. image, compiled, archive) or text. " +
		"Reads the first 8KB and checks for null bytes. Use before read_file or " +
		"edit_file to avoid corrupting binary files.",
	inputSchema: z.object({
		path: z.string().describe("Absolute or relative path to the file"),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			const file = Bun.file(resolvedPath);
			const exists = await file.exists();
			if (!exists) return JSON.stringify({ exists: false, path: resolvedPath });

			const slice = await file.slice(0, 8192).arrayBuffer();
			const bytes = new Uint8Array(slice);
			const isBinary = bytes.includes(0);

			return JSON.stringify({
				path: resolvedPath,
				isBinary,
				mimeType: file.type,
				size: file.size,
			});
		} catch (err) {
			return `Error checking file: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// create_directory — recursive mkdir
// ---------------------------------------------------------------------------

const createDirectoryTool = tool({
	description:
		"Create a directory (and all parent directories if needed). Equivalent to mkdir -p. " +
		"Safe to call on an existing directory — it will succeed without error.",
	inputSchema: z.object({
		path: z.string().describe("Absolute or relative path to the directory to create"),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			await mkdir(resolvedPath, { recursive: true });
			return JSON.stringify({ success: true, path: resolvedPath });
		} catch (err) {
			return `Error creating directory: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// download_file — binary-safe URL-to-disk download
// ---------------------------------------------------------------------------

const downloadFileTool = tool({
	description:
		"Download a file from a URL and save it to disk (binary-safe). Supports any file type: " +
		"images, fonts, archives, binaries, etc. Creates parent directories if needed.",
	inputSchema: z.object({
		url: z.string().url().describe("URL to download from"),
		destination: z.string().describe("Absolute or relative path where the file should be saved"),
		headers: z.record(z.string()).optional().describe("Optional HTTP headers (e.g. Authorization)"),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.destination);
			await mkdir(path.dirname(resolvedPath), { recursive: true });

			const response = await fetch(args.url, {
				headers: args.headers,
			});

			if (!response.ok) {
				return JSON.stringify({
					success: false,
					error: `HTTP ${response.status} ${response.statusText}`,
				});
			}

			// Stream directly to disk — avoids buffering entire file in memory
			await Bun.write(resolvedPath, response);
			const fileSize = Number(response.headers.get("content-length")) || (await stat(resolvedPath)).size;

			return JSON.stringify({
				success: true,
				path: resolvedPath,
				size: fileSize,
				contentType: response.headers.get("content-type") ?? "unknown",
			});
		} catch (err) {
			return `Error downloading file: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// checksum — compute file hash
// ---------------------------------------------------------------------------

const checksumTool = tool({
	description:
		"Compute a cryptographic hash (checksum) of a file. Supports MD5, SHA-1, SHA-256, and SHA-512. " +
		"Useful for verifying file integrity, comparing files, or security checks.",
	inputSchema: z.object({
		path: z.string().describe("Absolute or relative path to the file"),
		algorithm: z.enum(["md5", "sha1", "sha256", "sha512"]).optional().default("sha256")
			.describe("Hash algorithm to use (default: sha256)"),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			const file = Bun.file(resolvedPath);
			if (!(await file.exists())) {
				return JSON.stringify({ error: "File not found", path: resolvedPath });
			}

			// Stream through hasher — avoids loading entire file into memory
			const hasher = new Bun.CryptoHasher(args.algorithm);
			for await (const chunk of file.stream() as unknown as AsyncIterable<Uint8Array>) {
				hasher.update(chunk);
			}
			const hash = hasher.digest("hex");

			return JSON.stringify({
				path: resolvedPath,
				algorithm: args.algorithm,
				hash,
				size: file.size,
			});
		} catch (err) {
			return `Error computing checksum: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// batch_rename — rename multiple files by pattern
// ---------------------------------------------------------------------------

const batchRenameTool = tool({
	description:
		"Rename multiple files in a directory by replacing a pattern in their names. " +
		"Supports regex patterns. Performs a dry run first and returns the planned renames " +
		"so you can verify before applying.",
	inputSchema: z.object({
		directory: z.string().describe("Absolute or relative path to the directory containing files"),
		find: z.string().describe("Pattern to find in file names (regex supported)"),
		replace: z.string().describe("Replacement string (supports $1, $2, etc. for regex groups)"),
		dryRun: z.boolean().optional().default(true)
			.describe("If true, only show what would be renamed without doing it (default: true)"),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedDir = validatePath(args.directory);
			const entries = await readdir(resolvedDir);
			const regex = new RegExp(args.find);
			const renames: Array<{ from: string; to: string }> = [];

			for (const entry of entries) {
				if (regex.test(entry)) {
					const newName = entry.replace(regex, args.replace);
					if (newName !== entry) {
						renames.push({ from: entry, to: newName });
					}
				}
			}

			if (renames.length === 0) {
				return JSON.stringify({ matches: 0, message: "No files matched the pattern." });
			}

			if (args.dryRun) {
				return JSON.stringify({ dryRun: true, matches: renames.length, renames });
			}

			let renamed = 0;
			const errors: string[] = [];
			for (const r of renames) {
				try {
					await rename(
						path.join(resolvedDir, r.from),
						path.join(resolvedDir, r.to),
					);
					renamed++;
				} catch (err) {
					errors.push(`${r.from}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			return JSON.stringify({ renamed, errors: errors.length > 0 ? errors : undefined });
		} catch (err) {
			return `Error batch renaming: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// file_permissions — check/set file permissions (Unix)
// ---------------------------------------------------------------------------

const filePermissionsTool = tool({
	description:
		"Check or set file permissions (Unix chmod). On Windows, only reading permissions is supported. " +
		"Pass mode to set permissions (e.g. '755', '644'). Omit mode to just check current permissions.",
	inputSchema: z.object({
		path: z.string().describe("Absolute or relative path to the file or directory"),
		mode: z.string().optional()
			.describe("Octal permission mode to set (e.g. '755', '644'). Omit to just read current permissions."),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedPath = validatePath(args.path);
			const info = await stat(resolvedPath);

			if (args.mode) {
				const octal = parseInt(args.mode, 8);
				if (isNaN(octal)) {
					return JSON.stringify({ error: `Invalid mode: ${args.mode}. Use octal format like '755'.` });
				}
				await chmod(resolvedPath, octal);
			}

			// Re-read after chmod
			const updated = args.mode ? await stat(resolvedPath) : info;
			const modeStr = (updated.mode & 0o777).toString(8).padStart(3, "0");

			return JSON.stringify({
				path: resolvedPath,
				mode: modeStr,
				isDirectory: updated.isDirectory(),
				size: updated.size,
				...(args.mode ? { updated: true } : {}),
			});
		} catch (err) {
			return `Error with file permissions: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// archive — create or extract zip/tar archives
// ---------------------------------------------------------------------------

const archiveTool = tool({
	description:
		"Create or extract archive files. Supports zip and tar.gz formats. " +
		"To create: specify source files/directories and output path. " +
		"To extract: specify the archive path and destination directory.",
	inputSchema: z.object({
		action: z.enum(["create", "extract"]).describe("Whether to create or extract an archive"),
		format: z.enum(["zip", "tar.gz"]).optional().default("zip")
			.describe("Archive format (default: zip)"),
		archivePath: z.string().describe("Path to the archive file (output for create, input for extract)"),
		sources: z.array(z.string()).optional()
			.describe("Files or directories to include (only for create action)"),
		destination: z.string().optional()
			.describe("Directory to extract to (only for extract action)"),
	}),
	execute: async (args): Promise<string> => {
		try {
			const resolvedArchive = validatePath(args.archivePath);

			if (args.action === "create") {
				if (!args.sources || args.sources.length === 0) {
					return JSON.stringify({ error: "sources is required for create action" });
				}

				await mkdir(path.dirname(resolvedArchive), { recursive: true });

				if (args.format === "zip") {
					const { default: archiver } = await import("archiver");
					const output = createWriteStream(resolvedArchive);
					const archive = archiver("zip", { zlib: { level: 9 } });

					const done = new Promise<void>((resolve, reject) => {
						output.on("close", resolve);
						archive.on("error", reject);
					});

					archive.pipe(output);

					for (const src of args.sources) {
						const resolvedSrc = validatePath(src);
						const info = await stat(resolvedSrc);
						if (info.isDirectory()) {
							archive.directory(resolvedSrc, path.basename(resolvedSrc));
						} else {
							archive.file(resolvedSrc, { name: path.basename(resolvedSrc) });
						}
					}

					await archive.finalize();
					await done;

					const archiveInfo = await stat(resolvedArchive);
					return JSON.stringify({
						success: true,
						path: resolvedArchive,
						size: archiveInfo.size,
						format: "zip",
					});
				} else {
					// tar.gz
					const tar = await import("tar");
					await tar.create(
						{ gzip: true, file: resolvedArchive },
						args.sources.map(s => validatePath(s)),
					);

					const archiveInfo = await stat(resolvedArchive);
					return JSON.stringify({
						success: true,
						path: resolvedArchive,
						size: archiveInfo.size,
						format: "tar.gz",
					});
				}
			} else {
				// extract
				const dest = args.destination
					? validatePath(args.destination)
					: path.dirname(resolvedArchive);
				await mkdir(dest, { recursive: true });

				if (args.format === "zip" || resolvedArchive.endsWith(".zip")) {
					const { default: extractZip } = await import("extract-zip");
					await extractZip(resolvedArchive, { dir: dest });
				} else {
					const tar = await import("tar");
					await tar.extract({ file: resolvedArchive, cwd: dest });
				}

				return JSON.stringify({
					success: true,
					extractedTo: dest,
					format: resolvedArchive.endsWith(".zip") ? "zip" : "tar.gz",
				});
			}
		} catch (err) {
			return `Error with archive: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// Exported tool registry (static — used by PM and for category inspection)
// ---------------------------------------------------------------------------

export const fileOpsTools: Record<string, ToolRegistryEntry> = {
	read_file: { tool: readFileTool, category: "file" },
	write_file: { tool: writeFileTool, category: "file" },
	edit_file: { tool: editFileTool, category: "file" },
	list_directory: { tool: listDirectoryTool, category: "file" },
	search_files: { tool: searchFilesTool, category: "file" },
	search_content: { tool: searchContentTool, category: "file" },
	delete_file: { tool: deleteFileTool, category: "file" },
	move_file: { tool: moveFileTool, category: "file" },
	append_file: { tool: appendFileTool, category: "file" },
	multi_edit_file: { tool: multiEditFileTool, category: "file" },
	diff_text: { tool: diffTextTool, category: "file" },
	patch_file: { tool: patchFileTool, category: "file" },
	copy_file: { tool: copyFileTool, category: "file" },
	file_info: { tool: fileInfoTool, category: "file" },
	find_dead_code: { tool: findDeadCodeTool, category: "file" },
	directory_tree: { tool: directoryTreeTool, category: "file" },
	is_binary: { tool: isBinaryTool, category: "file" },
	create_directory: { tool: createDirectoryTool, category: "file" },
	download_file: { tool: downloadFileTool, category: "file" },
	checksum: { tool: checksumTool, category: "file" },
	batch_rename: { tool: batchRenameTool, category: "file" },
	file_permissions: { tool: filePermissionsTool, category: "file" },
	archive: { tool: archiveTool, category: "file" },
};
