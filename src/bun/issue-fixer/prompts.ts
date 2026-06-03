// ---------------------------------------------------------------------------
// Issue Fixer — intent + dynamic task-prompt builder
//
// The agent's persona + hard rules live in its seeded system prompt (seed.ts).
// This module maps trigger keywords → intents and builds the per-run task block
// (intent directive + custom instructions + issue context + branch/PR rules)
// that the orchestrator passes to runInlineAgent.
// ---------------------------------------------------------------------------

export type IssueIntent = "fix" | "feature" | "test" | "docs" | "refactor" | "review";

export interface IntentKeyword {
	keyword: string; // always lower-case, agentdesk- prefixed
	intent: IssueIntent;
	description: string; // shown in the settings UI
}

/** All trigger keywords/labels must start with this prefix (case-insensitive). */
export const KEYWORD_PREFIX = "agentdesk-";

/**
 * Predefined trigger keywords. Every one is "real work" that writes files and
 * results in a branch + PR — there are no analysis/answer-only intents.
 */
export const PREDEFINED_KEYWORDS: IntentKeyword[] = [
	{ keyword: "agentdesk-fix", intent: "fix", description: "Diagnose and fix the reported bug/error." },
	{ keyword: "agentdesk-feature", intent: "feature", description: "Implement the described feature." },
	{ keyword: "agentdesk-test", intent: "test", description: "Add or repair tests." },
	{ keyword: "agentdesk-docs", intent: "docs", description: "Write or update documentation." },
	{ keyword: "agentdesk-refactor", intent: "refactor", description: "Restructure code without changing behavior." },
	{ keyword: "agentdesk-review", intent: "review", description: "Review the code/PR and apply concrete improvements as commits." },
];

/** Resolve a keyword (case-insensitive) to its intent, or null if unknown. */
export function intentForKeyword(keyword: string): IssueIntent | null {
	const k = keyword.trim().toLowerCase();
	return PREDEFINED_KEYWORDS.find((d) => d.keyword === k)?.intent ?? null;
}

const INTENT_DIRECTIVES: Record<IssueIntent, string> = {
	fix: "Reproduce the problem, find the root cause, and implement the minimal correct fix.",
	feature: "Implement the described feature end-to-end. Add tests if the repo has a test setup.",
	test: "Add or repair tests covering the described behavior. Do not change production behavior.",
	docs: "Create or update the relevant documentation files. Do not change code behavior.",
	refactor: "Restructure the named code without changing behavior. Keep existing tests green.",
	review: "Review the relevant code (or PR) and apply concrete improvements as commits — not just comments.",
};

/** The intent-specific directive (also reused standalone for the PR-feedback loop). */
export function buildIntentDirective(intent: IssueIntent): string {
	return `## Task intent: ${intent}\n${INTENT_DIRECTIVES[intent]}`;
}

export interface IssueContext {
	number: number;
	title: string;
	body?: string | null;
	comments?: string[];
}

/**
 * Build the full per-run task block passed to the issue-fixer agent. Embeds the
 * intent directive, custom project instructions, the issue (title/body/comments),
 * the strict branch-only / no-merge rules, and the "Fixes #N" PR directive.
 */
export function buildIssueFixerTask(opts: {
	intent: IssueIntent;
	issue: IssueContext;
	branch: string;
	baseBranch: string;
	customInstructions?: string | null;
}): string {
	const { intent, issue, branch, baseBranch, customInstructions } = opts;
	const commentsBlock = issue.comments?.length
		? `\n\n### Issue comments\n${issue.comments.map((c) => `- ${c}`).join("\n")}`
		: "";
	return [
		buildIntentDirective(intent),
		customInstructions?.trim()
			? `## Custom project instructions\n${customInstructions.trim()}`
			: "",
		`## The issue\n#${issue.number} — ${issue.title}\n\n${issue.body?.trim() || "(no description provided)"}${commentsBlock}`,
		`## Working branch\nYou are on \`${branch}\` (base: \`${baseBranch}\`). Make all changes here. ` +
			`NEVER switch branches, merge, rebase, force-push, or touch \`${baseBranch}\`.`,
		`## When done\nMake and verify the code changes ONLY. Do NOT run \`git push\`, do NOT use the \`gh\` CLI, and do NOT open or merge a pull request — ` +
			`the system automatically commits your changes on \`${branch}\`, runs the test/build gate, pushes, and opens the PR ("Fixes #${issue.number}") for human review. ` +
			`Finish with a concise summary of what you changed.`,
	]
		.filter(Boolean)
		.join("\n\n");
}
