import { tool } from "ai";
import { z } from "zod";
import type { ToolRegistryEntry } from "./index";
import { db } from "../../db";
import { settings } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { runGit } from "../../lib/git-runner";

// ---------------------------------------------------------------------------
// Helper: read git settings and format commit message
// ---------------------------------------------------------------------------

async function getGitSetting(key: string): Promise<string | null> {
	const rows = await db
		.select()
		.from(settings)
		.where(and(eq(settings.key, key), eq(settings.category, "git")));
	if (rows.length === 0) return null;
	try {
		return JSON.parse(rows[0].value);
	} catch {
		return rows[0].value;
	}
}

function formatCommitMessage(template: string, data: { files?: string[]; task?: string; description?: string; date?: string }): string {
	let message = template;
	if (data.files) message = message.replace("{files}", data.files.join(", "));
	if (data.task) message = message.replace("{task}", data.task);
	if (data.description) message = message.replace("{description}", data.description);
	if (data.date) message = message.replace("{date}", data.date);
	return message;
}

// ---------------------------------------------------------------------------
// git_status
// ---------------------------------------------------------------------------

const gitStatusTool = tool({
	description:
		"Return the current git working-tree status as a structured object with three lists: " +
		"modified (unstaged changes), staged (changes ready to commit), and untracked files. " +
		"Uses `git status --porcelain` internally.",
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
	}),
	execute: async ({ workspacePath }, { abortSignal }): Promise<string> => {
		try {
			const { stdout, stderr, exitCode } = await runGit(
				["status", "--porcelain"],
				workspacePath,
				abortSignal,
			);

			if (exitCode !== 0) {
				return JSON.stringify({ error: stderr || "git status failed" });
			}

			const modified: string[] = [];
			const staged: string[] = [];
			const untracked: string[] = [];

			for (const line of stdout.split("\n")) {
				if (!line) continue;

				const x = line[0]; // Index (staged) status
				const y = line[1]; // Working-tree (unstaged) status
				const file = line.slice(3);

				if (x === "?" && y === "?") {
					untracked.push(file);
					continue;
				}
				if (x !== " " && x !== "?") {
					staged.push(file);
				}
				if (y !== " " && y !== "?") {
					modified.push(file);
				}
			}

			return JSON.stringify({ modified, staged, untracked });
		} catch (err) {
			return JSON.stringify({
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},
});

// ---------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------

const gitDiffTool = tool({
	description:
		"Show git diff output for both unstaged and staged changes, combined into one result. " +
		"Optionally restrict the diff to a single file. Output is truncated to 10 000 characters.",
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
		file: z
			.string()
			.optional()
			.describe("Optional path (relative to workspacePath) to limit the diff to one file"),
	}),
	execute: async ({ workspacePath, file }, { abortSignal }): Promise<string> => {
		try {
			const extraArgs = file ? ["--", file] : [];

			const [unstaged, staged] = await Promise.all([
				runGit(["diff", ...extraArgs], workspacePath, abortSignal),
				runGit(["diff", "--staged", ...extraArgs], workspacePath, abortSignal),
			]);

			const combined = [unstaged.stdout, staged.stdout].filter(Boolean).join("\n");

			const MAX = 10_000;
			if (combined.length > MAX) {
				return combined.slice(0, MAX) + `\n... (truncated at ${MAX} characters)`;
			}

			return combined || "(no changes)";
		} catch (err) {
			return `Error running git diff: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// git_commit
// ---------------------------------------------------------------------------

const gitCommitTool = tool({
	description:
		"Stage the specified files with `git add` and then create a commit with the given message. " +
		"Returns a JSON object with success, the commit hash (on success), or an error message.",
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
		files: z.array(z.string()).describe("List of file paths (relative to workspacePath) to stage"),
		message: z.string().describe("The commit message"),
	}),
	execute: async ({ workspacePath, files, message }, { abortSignal }): Promise<string> => {
		try {
			// Stage files
			const addResult = await runGit(["add", ...files], workspacePath, abortSignal);
			if (addResult.exitCode !== 0) {
				return JSON.stringify({
					success: false,
					error: addResult.stderr || "git add failed",
				});
			}

			// Read commit message template from settings and format it
			const template = await getGitSetting("commitMessageFormat");
			const finalMessage = template ? formatCommitMessage(template, { files, description: message }) : message;

			// Commit
			const commitResult = await runGit(["commit", "-m", finalMessage], workspacePath, abortSignal);
			if (commitResult.exitCode !== 0) {
				return JSON.stringify({
					success: false,
					error: commitResult.stderr || commitResult.stdout || "git commit failed",
				});
			}

			// Extract the short commit hash from the commit output (e.g. "[main abc1234]")
			const hashMatch = commitResult.stdout.match(/\[.*?\s+([0-9a-f]+)\]/);
			const hash = hashMatch ? hashMatch[1] : undefined;

			return JSON.stringify({ success: true, hash });
		} catch (err) {
			return JSON.stringify({
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},
});

// ---------------------------------------------------------------------------
// git_branch
// ---------------------------------------------------------------------------

const gitBranchTool = tool({
	description:
		"Manage git branches. Supports three actions: " +
		'"list" — list all local and remote branches; ' +
		'"create" — create and switch to a new branch (requires name); ' +
		'"switch" — switch to an existing branch (requires name).',
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
		action: z
			.enum(["list", "create", "switch"])
			.describe('Action to perform: "list", "create", or "switch"'),
		name: z
			.string()
			.optional()
			.describe('Branch name — required for "create" and "switch" actions'),
	}),
	execute: async ({ workspacePath, action, name }, { abortSignal }): Promise<string> => {
		try {
			if (action === "list") {
				const { stdout, stderr, exitCode } = await runGit(["branch", "-a"], workspacePath, abortSignal);
				if (exitCode !== 0) {
					return `Error listing branches: ${stderr || "unknown error"}`;
				}
				return stdout || "(no branches)";
			}

			if (!name) {
				return `Error: "name" is required for the "${action}" action`;
			}

			if (action === "create") {
				const { stdout, stderr, exitCode } = await runGit(
					["checkout", "-b", name],
					workspacePath,
					abortSignal,
				);
				if (exitCode !== 0) {
					return `Error creating branch "${name}": ${stderr || stdout || "unknown error"}`;
				}
				return stdout || stderr || `Switched to new branch '${name}'`;
			}

			// action === "switch"
			const { stdout, stderr, exitCode } = await runGit(
				["checkout", name],
				workspacePath,
				abortSignal,
			);
			if (exitCode !== 0) {
				return `Error switching to branch "${name}": ${stderr || stdout || "unknown error"}`;
			}
			return stdout || stderr || `Switched to branch '${name}'`;
		} catch (err) {
			return `Error running git branch: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

// ---------------------------------------------------------------------------
// git_push
// ---------------------------------------------------------------------------

const gitPushTool = tool({
	description:
		"Push commits to a remote repository. " +
		"IMPORTANT: this tool never executes the push directly. Instead it returns a " +
		"{ requiresApproval: true, command: string } object so the engine can request " +
		"explicit human approval before the push is executed.",
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
		remote: z
			.string()
			.optional()
			.default("origin")
			.describe('Remote name to push to (defaults to "origin")'),
		branch: z
			.string()
			.optional()
			.describe(
				"Branch to push. If omitted the current branch is used (git will infer it).",
			),
	}),
	execute: async ({ workspacePath, remote = "origin", branch }, { abortSignal }): Promise<string> => {
		try {
			// Determine the current branch name when none is provided
			let targetBranch = branch;
			if (!targetBranch) {
				const { stdout, exitCode } = await runGit(
					["rev-parse", "--abbrev-ref", "HEAD"],
					workspacePath,
					abortSignal,
				);
				if (exitCode === 0 && stdout) {
					targetBranch = stdout;
				}
			}

			const command = targetBranch
				? `git push ${remote} ${targetBranch}`
				: `git push ${remote}`;

			return JSON.stringify({
				requiresApproval: true,
				command,
			});
		} catch (err) {
			return JSON.stringify({
				requiresApproval: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},
});

// ---------------------------------------------------------------------------
// git_pull
// ---------------------------------------------------------------------------

const gitPullTool = tool({
	description:
		"Pull the latest changes from a remote repository into the current branch. " +
		"Equivalent to `git pull [remote] [branch]`.",
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
		remote: z
			.string()
			.optional()
			.describe('Remote name (default: "origin")'),
		branch: z
			.string()
			.optional()
			.describe("Branch to pull. If omitted, git uses the tracking branch."),
	}),
	execute: async ({ workspacePath, remote, branch }, { abortSignal }): Promise<string> => {
		try {
			const args = ["pull"];
			if (remote) args.push(remote);
			if (branch) args.push(branch);

			const { stdout, stderr, exitCode } = await runGit(args, workspacePath, abortSignal);
			return JSON.stringify({ exitCode, stdout, stderr });
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// git_fetch
// ---------------------------------------------------------------------------

const gitFetchTool = tool({
	description:
		"Fetch changes from a remote repository without merging. " +
		"Equivalent to `git fetch [remote]`.",
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
		remote: z
			.string()
			.optional()
			.describe('Remote to fetch from (default: "origin"). Pass "--all" to fetch all remotes.'),
	}),
	execute: async ({ workspacePath, remote = "origin" }, { abortSignal }): Promise<string> => {
		try {
			const args = remote === "--all" ? ["fetch", "--all"] : ["fetch", remote];
			const { stdout, stderr, exitCode } = await runGit(args, workspacePath, abortSignal);
			return JSON.stringify({ exitCode, stdout, stderr });
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// git_log
// ---------------------------------------------------------------------------

const gitLogTool = tool({
	description:
		"Return the commit history for a git repository as a JSON array. " +
		"Each entry contains hash, author, date, and message. " +
		"Optionally filter to commits touching a specific file.",
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.describe("Number of commits to return (default: 20)"),
		file: z
			.string()
			.optional()
			.describe("Optional file path (relative to workspacePath) to filter commits by"),
		branch: z
			.string()
			.optional()
			.describe("Branch or ref to read history from (default: current branch)"),
	}),
	execute: async ({ workspacePath, limit = 20, file, branch }, { abortSignal }): Promise<string> => {
		try {
			// Use a unique delimiter unlikely to appear in commit messages
			const SEP = "||AIDESK||";
			const FORMAT = `%H${SEP}%an${SEP}%ae${SEP}%ai${SEP}%s`;

			const args = ["log", `--format=${FORMAT}`, `-${limit}`];
			if (branch) args.push(branch);
			if (file) args.push("--", file);

			const { stdout, stderr, exitCode } = await runGit(args, workspacePath, abortSignal);

			if (exitCode !== 0) {
				return JSON.stringify({ error: stderr || "git log failed" });
			}

			const commits = stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [hash, author, email, date, ...messageParts] = line.split(SEP);
					return { hash, author, email, date, message: messageParts.join(SEP) };
				});

			return JSON.stringify({ commits, total: commits.length });
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// git_pr — Create or list GitHub Pull Requests
// ---------------------------------------------------------------------------

const gitPrTool = tool({
	description:
		"Create or list GitHub Pull Requests via the GitHub REST API. " +
		"Requires a GitHub token stored in settings (category: git, key: githubToken). " +
		"The repo owner/name is inferred from the remote URL automatically.",
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
		action: z
			.enum(["create", "list"])
			.describe('"create" to open a new PR, "list" to list open PRs'),
		title: z
			.string()
			.optional()
			.describe('PR title (required for "create")'),
		body: z
			.string()
			.optional()
			.describe('PR description body (for "create")'),
		head: z
			.string()
			.optional()
			.describe('Source branch (for "create", defaults to current branch)'),
		base: z
			.string()
			.optional()
			.describe('Target branch for the PR (for "create"). Use the project\'s configured working branch — do not assume "main".'),
	}),
	execute: async ({ workspacePath, action, title, body, head, base }, { abortSignal }): Promise<string> => {
		try {
			// Read GitHub token from settings
			const token = await getGitSetting("githubToken");
			if (!token) {
				return JSON.stringify({
					error: "GitHub token not configured. Add it in Settings → Git → GitHub Token.",
				});
			}

			// Infer owner/repo from remote URL
			const { stdout: remoteUrl, exitCode: remoteExit } = await runGit(
				["remote", "get-url", "origin"],
				workspacePath,
				abortSignal,
			);
			if (remoteExit !== 0 || !remoteUrl.trim()) {
				return JSON.stringify({ error: "Could not determine remote URL from git origin" });
			}

			const repoMatch = remoteUrl
				.trim()
				.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
			if (!repoMatch) {
				return JSON.stringify({ error: `Remote URL does not appear to be a GitHub repo: ${remoteUrl.trim()}` });
			}
			const [, owner, repo] = repoMatch;

			const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
			const headers = {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
				"User-Agent": "AgentDeskAI/1.0",
			};

			if (action === "list") {
				const resp = await fetch(`${apiBase}/pulls?state=open&per_page=20`, {
					headers,
					signal: abortSignal ?? AbortSignal.timeout(15_000),
				});
				if (!resp.ok) {
					return JSON.stringify({ error: `GitHub API ${resp.status}: ${await resp.text()}` });
				}
				const prs = await resp.json() as Array<{ number: number; title: string; html_url: string; head: { ref: string }; base: { ref: string }; state: string }>;
				return JSON.stringify({
					prs: prs.map((pr) => ({
						number: pr.number,
						title: pr.title,
						url: pr.html_url,
						head: pr.head.ref,
						base: pr.base.ref,
						state: pr.state,
					})),
				});
			}

			// action === "create"
			if (!title) {
				return JSON.stringify({ error: '"title" is required to create a PR' });
			}

			// Use current branch as head if not specified
			let headBranch = head;
			if (!headBranch) {
				const { stdout: currentBranch, exitCode } = await runGit(
					["rev-parse", "--abbrev-ref", "HEAD"],
					workspacePath,
					abortSignal,
				);
				if (exitCode !== 0 || !currentBranch.trim()) {
					return JSON.stringify({ error: "Could not determine current branch" });
				}
				headBranch = currentBranch.trim();
			}

			// If base not specified, detect the remote's default branch
			let baseBranch = base;
			if (!baseBranch) {
				const { stdout: symRef } = await runGit(
					["symbolic-ref", "refs/remotes/origin/HEAD"],
					workspacePath,
					abortSignal,
				);
				baseBranch = symRef.trim().replace("refs/remotes/origin/", "") || "main";
			}

			const resp = await fetch(`${apiBase}/pulls`, {
				method: "POST",
				headers,
				body: JSON.stringify({ title, body: body ?? "", head: headBranch, base: baseBranch }),
				signal: abortSignal ?? AbortSignal.timeout(15_000),
			});

			const data = await resp.json() as { number?: number; html_url?: string; message?: string };

			if (!resp.ok) {
				return JSON.stringify({ error: `GitHub API ${resp.status}: ${data.message ?? JSON.stringify(data)}` });
			}

			return JSON.stringify({
				success: true,
				number: data.number,
				url: data.html_url,
				head: headBranch,
				base: baseBranch,
			});
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// git_stash
// ---------------------------------------------------------------------------

const gitStashTool = tool({
	description:
		"Manage the git stash. Supports four actions: " +
		'"save" — stash uncommitted changes (optional message); ' +
		'"pop" — apply and remove the top stash entry; ' +
		'"list" — list all stash entries; ' +
		'"drop" — remove a stash entry by index (defaults to 0).',
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
		action: z
			.enum(["save", "pop", "list", "drop"])
			.describe('Action to perform: "save", "pop", "list", or "drop"'),
		message: z
			.string()
			.optional()
			.describe('Optional message for the "save" action'),
		index: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe('Stash index for "pop" or "drop" (defaults to 0)'),
	}),
	execute: async ({ workspacePath, action, message, index = 0 }, { abortSignal }): Promise<string> => {
		try {
			let args: string[];

			switch (action) {
				case "save":
					args = message ? ["stash", "push", "-m", message] : ["stash", "push"];
					break;
				case "pop":
					args = ["stash", "pop", `stash@{${index}}`];
					break;
				case "list":
					args = ["stash", "list"];
					break;
				case "drop":
					args = ["stash", "drop", `stash@{${index}}`];
					break;
			}

			const { stdout, stderr, exitCode } = await runGit(args, workspacePath, abortSignal);

			if (exitCode !== 0) {
				return JSON.stringify({ error: stderr || stdout || `git stash ${action} failed` });
			}

			return stdout || stderr || `git stash ${action} completed`;
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// git_reset — safe version (--soft and --mixed only, no --hard)
// ---------------------------------------------------------------------------

const gitResetTool = tool({
	description:
		"Reset the current HEAD to a specified state. Supports two safe modes: " +
		'"soft" — move HEAD but keep changes staged; ' +
		'"mixed" (default) — move HEAD and unstage changes but keep working-tree files. ' +
		"IMPORTANT: --hard mode is intentionally not supported to prevent data loss.",
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
		mode: z
			.enum(["soft", "mixed"])
			.optional()
			.default("mixed")
			.describe('Reset mode: "soft" (keep staged) or "mixed" (unstage, default)'),
		target: z
			.string()
			.optional()
			.default("HEAD~1")
			.describe('The commit, ref, or expression to reset to (defaults to "HEAD~1")'),
	}),
	execute: async ({ workspacePath, mode = "mixed", target = "HEAD~1" }, { abortSignal }): Promise<string> => {
		try {
			const args = ["reset", `--${mode}`, target];
			const { stdout, stderr, exitCode } = await runGit(args, workspacePath, abortSignal);

			if (exitCode !== 0) {
				return JSON.stringify({ error: stderr || stdout || "git reset failed" });
			}

			return JSON.stringify({
				success: true,
				mode,
				target,
				output: (stdout || stderr || "").trim(),
			});
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// git_cherry_pick — selectively apply commits from other branches
// ---------------------------------------------------------------------------

const gitCherryPickTool = tool({
	description:
		"Apply one or more commits from another branch onto the current branch. " +
		'Supports a single commit hash, a space-separated list of hashes, or a range (e.g. "abc123..def456"). ' +
		"Does NOT auto-commit by default (--no-commit) so you can review before committing. " +
		'Set auto_commit to true if you want git to commit each cherry-picked change immediately.',
	inputSchema: z.object({
		workspacePath: z.string().describe("Absolute path to the git repository root"),
		commits: z
			.string()
			.describe('Commit hash(es) or range. Examples: "abc1234", "abc1234 def5678", "abc1234..def5678"'),
		auto_commit: z
			.boolean()
			.optional()
			.default(false)
			.describe("If true, commit each cherry-pick automatically. Default: false (--no-commit)"),
	}),
	execute: async ({ workspacePath, commits, auto_commit = false }, { abortSignal }): Promise<string> => {
		try {
			const args = ["cherry-pick"];
			if (!auto_commit) args.push("--no-commit");

			// Split space-separated hashes; ranges (containing ..) stay as one token
			const tokens = commits.trim().split(/\s+/);
			args.push(...tokens);

			const { stdout, stderr, exitCode } = await runGit(args, workspacePath, abortSignal);

			if (exitCode !== 0) {
				// If cherry-pick fails (conflict), abort to leave the tree clean
				await runGit(["cherry-pick", "--abort"], workspacePath, abortSignal).catch(() => {});
				return JSON.stringify({
					success: false,
					error: stderr || stdout || "Cherry-pick failed (likely a merge conflict). The cherry-pick has been aborted.",
				});
			}

			return JSON.stringify({
				success: true,
				commits: tokens,
				autoCommit: auto_commit,
				output: (stdout || stderr || "").trim(),
			});
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// Exported tool registry
// ---------------------------------------------------------------------------

export const gitTools: Record<string, ToolRegistryEntry> = {
	git_status: { tool: gitStatusTool, category: "git" },
	git_diff: { tool: gitDiffTool, category: "git" },
	git_commit: { tool: gitCommitTool, category: "git" },
	git_branch: { tool: gitBranchTool, category: "git" },
	git_push: { tool: gitPushTool, category: "git" },
	git_pull: { tool: gitPullTool, category: "git" },
	git_fetch: { tool: gitFetchTool, category: "git" },
	git_log: { tool: gitLogTool, category: "git" },
	git_pr: { tool: gitPrTool, category: "git" },
	git_stash: { tool: gitStashTool, category: "git" },
	git_reset: { tool: gitResetTool, category: "git" },
	git_cherry_pick: { tool: gitCherryPickTool, category: "git" },
};
