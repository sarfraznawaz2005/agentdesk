// ---------------------------------------------------------------------------
// Issue Fixer — run orchestrator
//
// Runs the hidden "issue-fixer" agent autonomously (no PM / kanban / approval card)
// against a project's local git repo, then deterministically commits, pushes
// (token-authenticated), and opens a PR for human review. NEVER merges.
//
// Mirrors the Playground orchestrator: runInlineAgent + live broadcasts, plus
// registerAgentController so the run shows on the dashboard project card.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db } from "../db";
import { projects, aiProviders } from "../db/schema";
import { runInlineAgent, type InlineAgentCallbacks, type MessagePart } from "../agents/agent-loop";
import { broadcastToWebview, registerAgentController, unregisterAgentController } from "../engine-manager";
import { runGit } from "../lib/git-runner";
import { resolveGitHubToken, pushBranchAuthenticated, parseGithubUrl, gitAuthArgs } from "../rpc/github-api";
import { createPullRequest, postIssueComment, getPullHeadBranch, findOpenPullByHead } from "./github";
import { buildIssueFixerTask, type IssueIntent } from "./prompts";
import { createGuardedShellTool } from "./shell-guard";
import { getDefaultModel } from "../providers/models";
import { getIssueFixerConfig, createRun, updateRun, mostRecentFinishedAt } from "./config";
import { notifyIssueFixResult } from "./notify";
import type { ProviderConfig } from "../providers/types";

export interface IssueFixInput {
	projectId: string;
	issueNumber: number;
	issueTitle: string;
	issueBody?: string | null;
	issueUrl?: string | null;
	comments?: string[];
	intent: IssueIntent;
	triggerType: string;
	triggerKeyword?: string | null;
	triggerCommentId?: string | null;
	author?: string | null;
	authorized: boolean;
	/** When set, work on this existing PR's head branch (PR-feedback loop) instead of a new branch. */
	prNumber?: number | null;
}

// Sequential queue per project (avoids git conflicts on the same workspace).
const projectQueues = new Map<string, Promise<unknown>>();

export function enqueueIssueFix(input: IssueFixInput): Promise<void> {
	const prev = projectQueues.get(input.projectId) ?? Promise.resolve();
	const next = prev.catch(() => {}).then(() => runIssueFix(input));
	projectQueues.set(input.projectId, next);
	return next;
}

function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "issue"
	);
}

async function resolveProviderConfig(): Promise<{ config: ProviderConfig; modelId: string }> {
	let row = (await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1))[0];
	if (!row) row = (await db.select().from(aiProviders).limit(1))[0];
	if (!row) throw new Error("No AI provider configured. Add one in Settings → Providers first.");
	return {
		config: {
			id: row.id,
			name: row.name,
			providerType: row.providerType,
			apiKey: row.apiKey ?? "",
			baseUrl: row.baseUrl ?? null,
			defaultModel: row.defaultModel ?? null,
		},
		modelId: row.defaultModel || getDefaultModel(row.providerType),
	};
}

function serializePart(part: MessagePart): Record<string, unknown> {
	return {
		id: part.id,
		type: part.type,
		content: part.content,
		toolName: part.toolName,
		toolInput: part.toolInput,
		toolOutput: part.toolOutput,
		toolState: part.toolState,
		sortOrder: part.sortOrder,
		agentName: part.agentName,
		timeStart: part.timeStart,
		timeEnd: part.timeEnd,
	};
}

/** Run a test/build command in the workspace. Returns true on exit code 0. */
async function runTestCommand(command: string, cwd: string, abortSignal?: AbortSignal): Promise<boolean> {
	const args = process.platform === "win32" ? ["cmd", "/c", command] : ["bash", "-lc", command];
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const onAbort = () => { try { proc.kill(); } catch { /* already exited */ } };
	abortSignal?.addEventListener("abort", onAbort, { once: true });
	try {
		const code = await proc.exited;
		return code === 0;
	} finally {
		abortSignal?.removeEventListener("abort", onAbort);
	}
}

async function runIssueFix(input: IssueFixInput): Promise<void> {
	const config = await getIssueFixerConfig(input.projectId);
	if (!config || !config.enabled) return;

	const proj = (await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1))[0];
	const workspacePath = proj?.workspacePath;
	if (!workspacePath) return;
	let baseBranch = proj.workingBranch?.trim() || "";
	const conversationId = `issue-fixer:${input.projectId}:${input.issueNumber}:${Date.now()}`;

	const runId = await createRun({
		projectId: input.projectId,
		issueNumber: input.issueNumber,
		issueTitle: input.issueTitle,
		issueUrl: input.issueUrl,
		triggerType: input.triggerType,
		triggerKeyword: input.triggerKeyword,
		triggerCommentId: input.triggerCommentId,
		intent: input.intent,
		author: input.author,
		authorized: input.authorized,
		status: "queued",
		conversationId,
	});

	const abort = new AbortController();
	registerAgentController(input.projectId, abort, "issue-fixer");
	broadcastToWebview("issueFixerRunStarted", {
		projectId: input.projectId,
		runId,
		issueNumber: input.issueNumber,
		issueTitle: input.issueTitle,
		intent: input.intent,
	});

	try {
		// Enforce the cooldown as a pacing delay (never drops a trigger): if a previous run
		// finished less than cooldownSec ago, wait out the remainder before starting.
		if (config.cooldownSec > 0) {
			const lastFinished = await mostRecentFinishedAt(input.projectId, runId);
			const waitMs = config.cooldownSec * 1000 - (Date.now() - lastFinished);
			if (lastFinished > 0 && waitMs > 0) {
				await new Promise((r) => setTimeout(r, waitMs));
			}
		}

		const token = await resolveGitHubToken({ projectId: input.projectId });
		const parsed = proj.githubUrl ? parseGithubUrl(proj.githubUrl) : null;
		if (!token) throw new Error("GitHub token not configured.");
		if (!parsed) throw new Error("Project has no valid GitHub repository URL.");

		await updateRun(runId, { status: "fixing" });

		// 1. Require a clean working tree (don't silently stash/lose the user's changes),
		//    then sync the base branch.
		const pre = await runGit(["status", "--porcelain"], workspacePath, abort.signal);
		if (pre.exitCode !== 0) throw new Error("Workspace is not a git repository or git is unavailable.");
		if (pre.stdout.trim()) {
			throw new Error("Workspace has uncommitted changes — Issue Fixer needs a clean working tree.");
		}
		// Authenticate all remote git ops with the token + NO credential helper, so Git
		// Credential Manager never pops its interactive GUI during autonomous runs.
		const authArgs = gitAuthArgs(token);
		await runGit([...authArgs, "fetch", "origin"], workspacePath, abort.signal);
		// Resolve base branch: project setting → remote default (origin/HEAD) → main.
		if (!baseBranch) {
			const sym = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], workspacePath, abort.signal);
			baseBranch = sym.stdout.trim().replace("refs/remotes/origin/", "") || "main";
		}
		await runGit(["checkout", baseBranch], workspacePath, abort.signal);
		await runGit([...authArgs, "pull", "origin", baseBranch], workspacePath, abort.signal).catch(() => {});

		// 2. Branch — the PR head branch (PR-feedback), an existing issue-fix branch (re-trigger —
		//    continue on it, never reset), or a fresh branch off base.
		let branch: string;
		const checkoutExisting = async (b: string) => {
			await runGit([...authArgs, "fetch", "origin", b], workspacePath, abort.signal).catch(() => {});
			await runGit(["checkout", b], workspacePath, abort.signal);
			await runGit([...authArgs, "pull", "origin", b], workspacePath, abort.signal).catch(() => {});
		};
		if (input.prNumber) {
			const head = await getPullHeadBranch(parsed.owner, parsed.repo, input.prNumber, token);
			branch = head ?? `issue-fix/${input.issueNumber}-${slugify(input.issueTitle)}`;
			await checkoutExisting(branch);
		} else {
			branch = `issue-fix/${input.issueNumber}-${slugify(input.issueTitle)}`;
			const remoteHas =
				(await runGit([...authArgs, "ls-remote", "--heads", "origin", branch], workspacePath, abort.signal)).stdout.trim() !== "";
			if (remoteHas) {
				// A prior run already created this branch (and likely a PR) — continue on it instead
				// of `checkout -B` (which would reset it and lose prior work).
				await checkoutExisting(branch);
			} else {
				await runGit(["checkout", "-B", branch], workspacePath, abort.signal);
			}
		}
		await updateRun(runId, { branchName: branch });

		// 3. "Working" comment (best-effort).
		await postIssueComment(
			parsed.owner,
			parsed.repo,
			input.issueNumber,
			`🤖 AgentDesk Issue Fixer is working on this (\`${input.intent}\`)…`,
			token,
		).catch(() => {});

		// 4. Run the agent (edits files only — git_push/git_pr excluded; orchestrator owns those).
		const { config: providerConfig, modelId } = await resolveProviderConfig();
		const task = buildIssueFixerTask({
			intent: input.intent,
			issue: {
				number: input.issueNumber,
				title: input.issueTitle,
				body: input.issueBody,
				comments: input.comments,
			},
			branch,
			baseBranch,
			customInstructions: config.customInstructions,
		});
		const projectContext =
			`## Repository\n- Absolute path: \`${workspacePath}\`\n- Base branch: \`${baseBranch}\`\n- Working branch: \`${branch}\`\n` +
			`All file operations and shell commands default here. Do all work on \`${branch}\`.`;

		const callbacks: InlineAgentCallbacks = {
			onPartCreated: (part) =>
				broadcastToWebview("issueFixerPart", { projectId: input.projectId, runId, part: serializePart(part) }),
			onPartUpdated: (_mid, partId, updates) =>
				broadcastToWebview("issueFixerPartUpdated", {
					projectId: input.projectId,
					runId,
					partId,
					updates: {
						content: updates.content,
						toolOutput: updates.toolOutput,
						toolState: updates.toolState,
						timeEnd: updates.timeEnd,
					},
				}),
			onTextDelta: () => {},
			onAgentStart: () => {},
			onAgentComplete: () => {},
		};

		const result = await runInlineAgent({
			conversationId,
			agentName: "issue-fixer",
			agentDisplayName: "Issue Fixer",
			task,
			projectContext,
			providerConfig,
			modelId,
			callbacks,
			workspacePath,
			projectId: input.projectId,
			persistToDb: false,
			// Auto-approved + guarded shell; deterministic git push/PR handled by the orchestrator.
			extraTools: { run_shell: createGuardedShellTool(baseBranch) },
			// No human-input (nobody to answer); push/PR owned by the orchestrator; NO kanban
			// writes; and NO destructive/branch-switching git tools (reset/cherry-pick/branch)
			// so the agent stays on its branch and can't undo/reset the user's repo.
			excludeTools: [
				"request_human_input",
				"git_push",
				"git_pr",
				"git_reset",
				"git_cherry_pick",
				"git_branch",
				"create_task",
				"update_task",
				"move_task",
				"delete_task",
				"submit_review",
				"verify_implementation",
			],
			abortSignal: abort.signal,
		});

		// 5. Test/build gate.
		let testPassed: number | null = null;
		if (config.testCommand && config.testCommand.trim()) {
			await updateRun(runId, { status: "testing" });
			testPassed = (await runTestCommand(config.testCommand.trim(), workspacePath, abort.signal)) ? 1 : 0;
		}

		// 6. Stage + commit any changes the agent made (and didn't commit itself).
		await runGit(["add", "-A"], workspacePath, abort.signal);
		const status = await runGit(["status", "--porcelain"], workspacePath, abort.signal);
		if (status.stdout.trim()) {
			await runGit(
				[
					"-c",
					"user.name=AgentDesk",
					"-c",
					"user.email=ai@agentdesk.local",
					"commit",
					"-m",
					`${input.intent}: ${input.issueTitle} (#${input.issueNumber})`,
				],
				workspacePath,
				abort.signal,
			);
		}

		// No new commits relative to base on a fresh branch means the agent made no change —
		// don't push an empty branch or open an empty PR (GitHub would 422). (PR-feedback runs
		// push to the existing PR branch regardless; a no-op push there is harmless.)
		if (!input.prNumber) {
			const ahead = await runGit(["rev-list", "--count", `${baseBranch}..HEAD`], workspacePath, abort.signal);
			if (ahead.exitCode !== 0 || ahead.stdout.trim() === "0") {
				throw new Error("Agent made no changes — nothing to open a pull request for.");
			}
		}

		// 7. Push the feature branch (token-authenticated; never the base branch).
		await updateRun(runId, { status: "pushing" });
		const push = await pushBranchAuthenticated({
			workspacePath,
			branch,
			projectId: input.projectId,
			abortSignal: abort.signal,
		});
		if (!push.ok) throw new Error(`Push failed: ${push.error}`);

		// 8. Open a PR, or update the existing one (PR-feedback / re-trigger). Never merge.
		let prNumber: number | null = input.prNumber ?? null;
		let prUrl: string | null = input.prNumber
			? `https://github.com/${parsed.owner}/${parsed.repo}/pull/${input.prNumber}`
			: null;
		let prCreatedNew = false;
		if (!input.prNumber) {
			const draft = config.autonomy === "draft" || testPassed === 0;
			const pr = await createPullRequest(
				parsed.owner,
				parsed.repo,
				{
					title: `[Issue Fixer] ${input.issueTitle} (#${input.issueNumber})`,
					body:
						`Fixes #${input.issueNumber}\n\n${result.summary}\n\n` +
						`— Automated by AgentDesk Issue Fixer (${input.intent}). Human review required; do not auto-merge.`,
					head: branch,
					base: baseBranch,
					draft,
				},
				token,
			);
			if (!pr.ok) {
				if (/already exists/i.test(pr.error)) {
					// The branch already had an open PR (re-trigger, or the agent opened one) — our
					// push updated it. Adopt the existing PR so the run links to it correctly.
					const existing = await findOpenPullByHead(parsed.owner, parsed.repo, branch, token);
					prNumber = existing?.number ?? null;
					prUrl = existing?.url ?? null;
				} else {
					throw new Error(`PR creation failed: ${pr.error}`);
				}
			} else {
				prNumber = pr.number;
				prUrl = pr.url;
				prCreatedNew = true;
			}
		}

		// 9. "Done" comment (best-effort).
		await postIssueComment(
			parsed.owner,
			parsed.repo,
			input.issueNumber,
			prCreatedNew
				? `✅ Done — opened PR #${prNumber}: ${prUrl}`
				: prUrl
					? `✅ Updated PR #${prNumber}: ${prUrl}`
					: `✅ Updated the existing pull request.`,
			token,
		).catch(() => {});

		const finalStatus = prCreatedNew ? "pr_created" : "pr_updated";
		await updateRun(runId, {
			status: finalStatus,
			prNumber,
			prUrl,
			testPassed,
			summary: result.summary,
			finishedAt: new Date().toISOString(),
		});
		broadcastToWebview("issueFixerRunComplete", {
			projectId: input.projectId,
			runId,
			status: finalStatus,
			prNumber,
			prUrl,
		});
		await notifyIssueFixResult({
			ok: true,
			projectId: input.projectId,
			issueNumber: input.issueNumber,
			issueTitle: input.issueTitle,
			intent: input.intent,
			prNumber,
			prUrl,
			summary: result.summary,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// A user-initiated Stop aborts the controller, which surfaces here as a thrown
		// AbortError. Treat that as a clean "cancelled" outcome — not a red failure — and
		// don't spam channels with a failure notification for an intentional cancel.
		if (abort.signal.aborted) {
			await updateRun(runId, {
				status: "cancelled",
				error: "Cancelled by user",
				finishedAt: new Date().toISOString(),
			});
			broadcastToWebview("issueFixerRunComplete", {
				projectId: input.projectId,
				runId,
				status: "cancelled",
				prNumber: null,
				prUrl: null,
			});
		} else {
			await updateRun(runId, { status: "failed", error: msg, finishedAt: new Date().toISOString() });
			broadcastToWebview("issueFixerRunError", { projectId: input.projectId, runId, error: msg });
			await notifyIssueFixResult({
				ok: false,
				projectId: input.projectId,
				issueNumber: input.issueNumber,
				issueTitle: input.issueTitle,
				intent: input.intent,
				error: msg,
			});
		}
	} finally {
		unregisterAgentController(input.projectId, abort);
	}
}
