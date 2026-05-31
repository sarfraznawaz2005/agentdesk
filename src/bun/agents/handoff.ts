// ---------------------------------------------------------------------------
// Handoff summary generation — bridges sequential workflow agents
// ---------------------------------------------------------------------------

import { readFileSync, statSync } from "fs";
import { extname, basename } from "path";

/**
 * Generate a handoff summary from the files an agent modified.
 * Small changes (<=3 files, <200 lines each) → deterministic summary with
 * file names, key exports, class names, and IDs extracted via regex.
 * Large changes → lightweight AI summary via the provided summarise function.
 */
export async function generateHandoffSummary(
	filesModified: string[],
	aiSummarise?: (prompt: string) => Promise<string>,
): Promise<string> {
	if (filesModified.length === 0) return "";

	// Read files and check if they qualify for deterministic summary
	const fileContents: { path: string; content: string; lines: number }[] = [];

	for (const filePath of filesModified) {
		try {
			const stat = statSync(filePath);
			if (stat.size > 500_000) continue; // skip very large files
			const content = readFileSync(filePath, "utf-8");
			const lines = content.split("\n").length;
			fileContents.push({ path: filePath, content, lines });
		} catch {
			// File may have been deleted or moved — skip
		}
	}

	if (fileContents.length === 0) {
		return `Modified files: ${filesModified.map(f => basename(f)).join(", ")} (contents unavailable)`;
	}

	// Small changes: deterministic summary
	const isSmall = fileContents.length <= 3 && fileContents.every(f => f.lines < 200);

	if (isSmall) {
		return buildDeterministicSummary(fileContents);
	}

	// Large changes: try AI summary, fall back to deterministic
	if (aiSummarise) {
		try {
			const filesBlock = fileContents.map(f => {
				const preview = f.content.slice(0, 2000);
				return `### ${basename(f.path)} (${f.lines} lines)\n\`\`\`\n${preview}\n\`\`\``;
			}).join("\n\n");

			const prompt = `Summarise what was built/changed in these files in 3-5 bullet points. Focus on: file purposes, key exports/components, CSS classes, DOM IDs, function names, and API endpoints. Be specific — the next developer needs exact names to integrate with these files.\n\n${filesBlock}`;

			return await aiSummarise(prompt);
		} catch {
			// Fall through to deterministic
		}
	}

	return buildDeterministicSummary(fileContents);
}

// ---------------------------------------------------------------------------
// Deterministic summary — regex-based extraction
// ---------------------------------------------------------------------------

function buildDeterministicSummary(
	files: { path: string; content: string; lines: number }[],
): string {
	const parts: string[] = [];

	for (const file of files) {
		const name = basename(file.path);
		const ext = extname(file.path).toLowerCase();
		const extracted: string[] = [];

		// CSS classes
		if (ext === ".css" || ext === ".scss" || ext === ".less") {
			const classes = new Set<string>();
			for (const m of file.content.matchAll(/\.([a-zA-Z_][\w-]*)\s*[{,]/g)) {
				classes.add(m[1]);
			}
			if (classes.size > 0) extracted.push(`CSS classes: ${[...classes].slice(0, 20).join(", ")}`);
		}

		// HTML IDs and classes
		if (ext === ".html" || ext === ".htm") {
			const ids = new Set<string>();
			const classes = new Set<string>();
			for (const m of file.content.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(m[1]);
			for (const m of file.content.matchAll(/\bclass=["']([^"']+)["']/g)) {
				for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
			}
			if (ids.size > 0) extracted.push(`IDs: ${[...ids].slice(0, 20).join(", ")}`);
			if (classes.size > 0) extracted.push(`Classes: ${[...classes].slice(0, 20).join(", ")}`);
		}

		// JS/TS exports and key identifiers
		if ([".js", ".ts", ".jsx", ".tsx", ".mjs", ".mts"].includes(ext)) {
			const exports = new Set<string>();
			for (const m of file.content.matchAll(/export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g)) {
				exports.add(m[1]);
			}
			if (exports.size > 0) extracted.push(`Exports: ${[...exports].slice(0, 15).join(", ")}`);

			// DOM selectors used in JS
			const selectors = new Set<string>();
			for (const m of file.content.matchAll(/(?:getElementById|querySelector(?:All)?)\s*\(\s*["']([^"']+)["']/g)) {
				selectors.add(m[1]);
			}
			if (selectors.size > 0) extracted.push(`DOM selectors: ${[...selectors].slice(0, 10).join(", ")}`);
		}

		// Python
		if (ext === ".py") {
			const defs = new Set<string>();
			for (const m of file.content.matchAll(/^(?:def|class)\s+(\w+)/gm)) defs.add(m[1]);
			if (defs.size > 0) extracted.push(`Definitions: ${[...defs].slice(0, 15).join(", ")}`);
		}

		const detail = extracted.length > 0 ? ` — ${extracted.join("; ")}` : "";
		parts.push(`- **${name}** (${file.lines} lines)${detail}`);
	}

	return `Files created/modified:\n${parts.join("\n")}`;
}
