// ---------------------------------------------------------------------------
// Handoff summary generation — bridges sequential workflow agents
// ---------------------------------------------------------------------------

import { readFileSync, statSync } from "fs";
import { extname, basename } from "path";

// ---------------------------------------------------------------------------
// Secret redaction — applied before any file content is quoted into a
// handoff note or an AI-summary prompt. Errs toward over-redaction: a false
// positive just hides a harmless string, while a miss could leak a real
// credential into a note the next agent (or a channel-relayed message) reads.
// Scoped to credential-shaped strings, not general PII (email/phone), which
// would false-positive heavily on ordinary source (license headers, authors).
// ---------------------------------------------------------------------------

/** Filenames whose content is never read into a handoff summary — listed by name only. */
const SENSITIVE_FILE_RE = /(^|[\\/])\.env(\.\w+)?$|\.pem$|\.key$|(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$|credentials\.json$|secrets?\.(json|ya?ml)$/i;

export function redactSecrets(text: string): string {
	return text
		.replace(/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
		.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]")
		.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
		.replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]")
		.replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_API_KEY]")
		.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]")
		.replace(/Bearer\s+[A-Za-z0-9\-_.]{15,}/gi, "Bearer [REDACTED]")
		.replace(/((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key)\s*[:=]\s*)(['"]?)[A-Za-z0-9_\-/+=]{8,}\2/gi, "$1$2[REDACTED]$2");
}

/**
 * Generate a handoff summary from the files an agent modified.
 * Small changes (<=3 files, <200 lines each) → deterministic summary with
 * file names, key exports, class names, and IDs extracted via regex.
 * Large changes → lightweight AI summary via the provided summarise function.
 * File content is redacted (see redactSecrets) before it is ever quoted into
 * the summary or the AI prompt; files matching SENSITIVE_FILE_RE are never
 * read at all — only their name is recorded.
 */
export async function generateHandoffSummary(
	filesModified: string[],
	aiSummarise?: (prompt: string) => Promise<string>,
): Promise<string> {
	if (filesModified.length === 0) return "";

	// Read files and check if they qualify for deterministic summary
	const fileContents: { path: string; content: string; lines: number }[] = [];
	const sensitiveFiles: string[] = [];

	for (const filePath of filesModified) {
		if (SENSITIVE_FILE_RE.test(filePath)) {
			sensitiveFiles.push(basename(filePath));
			continue;
		}
		try {
			const stat = statSync(filePath);
			if (stat.size > 500_000) continue; // skip very large files
			const content = redactSecrets(readFileSync(filePath, "utf-8"));
			const lines = content.split("\n").length;
			fileContents.push({ path: filePath, content, lines });
		} catch {
			// File may have been deleted or moved — skip
		}
	}

	const sensitiveNote = sensitiveFiles.length > 0
		? `Sensitive files modified (content omitted for redaction): ${sensitiveFiles.join(", ")}`
		: "";
	const withSensitiveNote = (body: string) => sensitiveNote ? `${sensitiveNote}\n\n${body}` : body;

	if (fileContents.length === 0) {
		if (sensitiveNote) return sensitiveNote;
		return `Modified files: ${filesModified.map(f => basename(f)).join(", ")} (contents unavailable)`;
	}

	// Small changes: deterministic summary
	const isSmall = fileContents.length <= 3 && fileContents.every(f => f.lines < 200);

	if (isSmall) {
		return withSensitiveNote(buildDeterministicSummary(fileContents));
	}

	// Large changes: try AI summary, fall back to deterministic
	if (aiSummarise) {
		try {
			const filesBlock = fileContents.map(f => {
				const preview = f.content.slice(0, 2000);
				return `### ${basename(f.path)} (${f.lines} lines)\n\`\`\`\n${preview}\n\`\`\``;
			}).join("\n\n");

			const prompt = `Summarise what was built/changed in these files in 3-5 bullet points. Focus on: file purposes, key exports/components, CSS classes, DOM IDs, function names, and API endpoints. Be specific — the next developer needs exact names to integrate with these files. Do not restate requirements, rationale, or design decisions already captured in the project's plan/PRD docs — the next agent fetches those separately via list_docs. Report only concrete facts visible in this diff.\n\n${filesBlock}`;

			return withSensitiveNote(await aiSummarise(prompt));
		} catch {
			// Fall through to deterministic
		}
	}

	return withSensitiveNote(buildDeterministicSummary(fileContents));
}

// ---------------------------------------------------------------------------
// Completion report parsing — reads back the structured report that
// verify_implementation (tools/kanban.ts) writes to a task's importantNotes,
// even after a Handoff Summary / Suggested Next Steps section has since been
// appended below it.
// ---------------------------------------------------------------------------

export interface CompletionReport {
	summary?: string;
	files_changed?: string[];
	decisions_made?: string[];
	api_contracts?: string[];
	follow_up_issues?: string[];
	verification_evidence?: string;
}

export function extractCompletionReport(notes: string | null | undefined): CompletionReport | null {
	if (!notes) return null;
	// verify_implementation appends a new "## Completion Report (round N)" block on
	// each re-verification rather than overwriting — take the LAST one (current
	// truth), not the first (which may describe a since-fixed, stale state).
	const matches = [...notes.matchAll(/## Completion Report(?: \(round \d+\))?\n```json\n([\s\S]*?)\n```/g)];
	if (matches.length === 0) return null;
	try {
		return JSON.parse(matches[matches.length - 1][1]) as CompletionReport;
	} catch {
		return null;
	}
}

/** Follow-up issues the implementing agent flagged, if any (see verify_implementation). */
export function extractFollowUpIssues(notes: string | null | undefined): string[] {
	const report = extractCompletionReport(notes);
	return Array.isArray(report?.follow_up_issues) ? report.follow_up_issues : [];
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
