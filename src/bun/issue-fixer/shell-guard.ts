// ---------------------------------------------------------------------------
// Issue Fixer — guarded auto-approved shell
//
// The auto-approved shell is the one place the agent could escape the toolset
// restrictions (no merge tool, git_pr create/list only). This wraps it with a
// denylist that enforces the STRICT "humans only merge" rule: no merge / rebase
// onto base / gh pr merge / force-push / hard-reset / push to the base branch.
// ---------------------------------------------------------------------------

import type { Tool } from "ai";
import { autoApprovedShellTool } from "../agents/tools/shell";

/**
 * Forbidden command patterns, independent of branch name. Covers merges, history
 * rewrites, and anything destructive that could undo/reset/wipe the user's repo
 * or working tree. (This guards the AGENT's shell only — the orchestrator's own
 * git lifecycle uses runGit directly and is unaffected.)
 */
const BLOCKED_PATTERNS: RegExp[] = [
	// merges / rebases (humans only merge)
	/\bgit\s+merge\b/i,
	/\bgit\s+rebase\b/i,
	/\bgh\s+pr\s+merge\b/i,
	// destructive / undo / discard
	/\bgit\s+reset\b/i,
	/\bgit\s+clean\b/i,
	/\bgit\s+restore\b/i,
	/\bgit\s+checkout\b/i, // discards / branch-switching — agent must stay on its branch
	/\bgit\s+switch\b/i,
	// branch deletion
	/\bgit\s+branch\b[^\n]*\s-[dD]\b/i,
	// pushing AND pull-request creation are owned by the orchestrator — the agent must
	// never push or use the gh CLI (otherwise it races the orchestrator's authenticated
	// push/PR and can create a duplicate/mis-attributed PR).
	/\bgit\s+push\b/i,
	/(^|[\s;&|(])gh\s/i,
	// history rewrite / ref surgery
	/\bgit\s+(filter-branch|filter-repo)\b/i,
	/\bgit\s+update-ref\b/i,
	/\bgit\s+reflog\b/i,
	/\bgit\s+stash\b[^\n]*\b(drop|clear)\b/i,
	// recursive file deletion (agent should use the delete_file tool, not raw rm -rf)
	/\brm\s+-\S*r/i,
	/\brm\s+--recursive\b/i,
];

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Block any `git push ... <baseBranch>` (pushing to the protected base branch). */
function pushesToBaseBranch(command: string, baseBranch: string): boolean {
	if (!baseBranch) return false;
	const re = new RegExp(`\\bgit\\s+push\\b[^\\n]*\\b${escapeRegex(baseBranch)}\\b`, "i");
	return re.test(command);
}

/**
 * Returns a human-readable reason if the command is forbidden, or null if allowed.
 * Pure + dependency-free so it can be unit-tested directly.
 */
export function findShellViolation(command: string, baseBranch: string): string | null {
	for (const re of BLOCKED_PATTERNS) {
		if (re.test(command)) {
			return `Blocked: the Issue Fixer must never merge, rebase, force-push, or hard-reset (matched ${re}).`;
		}
	}
	if (pushesToBaseBranch(command, baseBranch)) {
		return `Blocked: pushing to the base branch "${baseBranch}" is not allowed — push only to your dedicated working branch.`;
	}
	return null;
}

/**
 * An auto-approved shell tool for the Issue Fixer that rejects forbidden commands
 * before delegating to the normal auto-approved shell.
 */
export function createGuardedShellTool(baseBranch: string): Tool {
	const inner = autoApprovedShellTool as Tool & {
		execute: (args: Record<string, unknown>, opts: unknown) => Promise<unknown>;
	};
	return {
		...inner,
		execute: async (args: Record<string, unknown>, opts: unknown) => {
			const command = String((args as { command?: string }).command ?? "");
			const violation = findShellViolation(command, baseBranch);
			if (violation) {
				return JSON.stringify({ exitCode: 1, stdout: "", stderr: violation });
			}
			return inner.execute(args, opts);
		},
	} as Tool;
}
