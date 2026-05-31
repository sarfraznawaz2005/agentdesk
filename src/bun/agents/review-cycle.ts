/**
 * review-cycle.ts — Standalone code review cycle for kanban tasks.
 *
 * When a task is moved to the "review" column, this module automatically
 * spawns a code-reviewer agent. Based on the review verdict, it either:
 *   - Moves the task to "done" (approved)
 *   - Moves back to "working" and spawns a fix agent (changes_requested)
 *   - Force-completes after max review rounds with a warning note
 *
 * This module is fully independent — no WorkflowEngine dependency.
 * It uses runInlineAgent directly to spawn reviewer/fix agents.
 */

import { eq, and, desc } from "drizzle-orm";
import { stat } from "node:fs/promises";
import { join } from "path";
import { db } from "../db";
import {
	settings,
	messageParts,
	agents as agentsTable,
	aiProviders,
	projects,
	kanbanTasks,
} from "../db/schema";
import { runInlineAgent, type InlineAgentCallbacks, type MessagePart } from "./agent-loop";
import { getKanbanTask, moveKanbanTask, updateKanbanTask } from "../rpc/kanban";
import { getSetting } from "../rpc/settings";
import {
	broadcastToWebview,
	registerAgentController,
	unregisterAgentController,
	getOrCreateEngine,
	getRunningAgentCount,
} from "../engine-manager";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Tasks currently in the review cycle — prevents duplicate reviewer spawns. */
const activeReviews = new Set<string>();

/** Per-task review round counters (in-memory, reset on app restart). */
const reviewRounds = new Map<string, number>();

/** Commit hash recorded by autoCommitTask — read by the reviewer to locate the diff. */
const taskCommitHashes = new Map<string, string>();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_MAX_REVIEW_ROUNDS = 2;

/** Read maxReviewRounds from project settings; defaults to 2. */
async function getMaxReviewRounds(projectId: string): Promise<number> {
	try {
		const rows = await db
			.select({ value: settings.value })
			.from(settings)
			.where(eq(settings.key, `project:${projectId}:maxReviewRounds`))
			.limit(1);
		if (rows.length === 0) return DEFAULT_MAX_REVIEW_ROUNDS;
		const parsed = parseInt(rows[0].value, 10);
		return isNaN(parsed) || parsed < 1 ? DEFAULT_MAX_REVIEW_ROUNDS : parsed;
	} catch {
		return DEFAULT_MAX_REVIEW_ROUNDS;
	}
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * Read the structured verdict + detailed feedback from the most recent
 * submit_review tool call for the given task.
 */
async function getSubmitReviewDetails(taskId: string): Promise<{
	verdict: "approved" | "changes_requested";
	feedback: string;
} | null> {
	try {
		const rows = await db
			.select({ toolInput: messageParts.toolInput })
			.from(messageParts)
			.where(and(
				eq(messageParts.toolName, "submit_review"),
				eq(messageParts.type, "tool_call"),
			))
			.orderBy(desc(messageParts.createdAt))
			.limit(10);

		for (const row of rows) {
			if (!row.toolInput) continue;
			try {
				const input = JSON.parse(row.toolInput);
				if (input.task_id === taskId) {
					if (input.verdict === "approved" || input.verdict === "changes_requested") {
						return {
							verdict: input.verdict,
							// `summary` is the reviewer's detailed per-issue feedback
							feedback: typeof input.summary === "string" ? input.summary : "",
						};
					}
				}
			} catch { /* invalid JSON */ }
		}
	} catch { /* DB error */ }
	return null;
}

/**
 * Heuristic fallback: does a code review summary indicate issues?
 * Used when submit_review wasn't called by the reviewer.
 */
function reviewSummaryHasIssues(summary: string): boolean {
	const lower = summary.toLowerCase();

	const cleanSignals = [
		"no issues", "no bugs", "no errors", "no problems", "no critical",
		"lgtm", "looks good", "all good", "passes review", "approved",
		"clean code", "well implemented", "review passed",
	];
	if (cleanSignals.some((s) => lower.includes(s))) return false;

	const negativeSignals = [
		"changes_requested", "changes requested", "must fix", "bug found",
		"bugs found", "issue found", "issues found", "problem found",
		"fix required", "needs fixing", "needs work", "incorrect implementation",
		"critical issue", "critical bug", "security vulnerability",
		"fails to", "failed to", "does not work", "doesn't work",
		"broken", "regression", "not met", "not satisfied",
		"missing implementation", "missing feature",
	];
	return negativeSignals.some((signal) => lower.includes(signal));
}

/** Returns true if an agent result indicates cancellation rather than genuine failure. */
function isAgentCancelled(result: { status: string; summary: string }): boolean {
	if (result.status === "completed") return false;
	const s = result.summary.toLowerCase();
	return s.includes("cancel") || s.includes("engine stopped") || s.includes("aborterror") || s.includes("aborted");
}

// ---------------------------------------------------------------------------
// Auto-continue: trigger PM to dispatch next task after review passes
// ---------------------------------------------------------------------------

async function triggerPMAutoContinue(projectId: string, completedTaskTitle: string): Promise<void> {
	try {
		// Check project setting
		const autoExecRows = await db
			.select({ value: settings.value })
			.from(settings)
			.where(eq(settings.key, `project:${projectId}:autoExecuteNextTask`))
			.limit(1);
		// Default to true if not set
		const autoExec = autoExecRows.length === 0 || autoExecRows[0].value !== "false";
		if (!autoExec) return;

		const eng = getOrCreateEngine(projectId);
		const conversationId = eng.getActiveConversationId();
		if (!conversationId) return;

		// Wait a moment for the review cycle to fully clean up
		await new Promise((r) => setTimeout(r, 1000));

		// Don't auto-continue if PM is already processing or agents are running
		if (eng.isProcessing() || getRunningAgentCount(projectId) > 0) return;

		// Build a specific next-action hint so PM knows exactly what to dispatch
		// instead of vague "continue" text that can cause hallucination.
		let nextAction = "";
		try {
			const allTasks = await db
				.select({ id: kanbanTasks.id, title: kanbanTasks.title, column: kanbanTasks.column, assignedAgentId: kanbanTasks.assignedAgentId, blockedBy: kanbanTasks.blockedBy, createdAt: kanbanTasks.createdAt })
				.from(kanbanTasks)
				.where(eq(kanbanTasks.projectId, projectId));
			const doneTasks = new Set(allTasks.filter(t => t.column === "done").map(t => t.id));
			const inBacklog = allTasks.filter(t => t.column === "backlog").sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
			const inWorking = allTasks.filter(t => t.column === "working");
			if (inWorking.length > 0) {
				const t = inWorking[0];
				const agent = t.assignedAgentId ?? "backend-engineer";
				nextAction = `\n\n[Next Action] DISPATCH — the plan is already approved and kanban tasks already exist. DO NOT run task-planner or create a new plan. Call run_agent NOW with agent_name="${agent}" and kanban_task_id="${t.id}" to execute the existing task: "${t.title}".`;
			} else {
				const unblocked = inBacklog.find(t => {
					if (!t.blockedBy) return true;
					try { return (JSON.parse(t.blockedBy) as string[]).every(id => doneTasks.has(id)); } catch { return true; }
				});
				if (unblocked) {
					const agent = unblocked.assignedAgentId ?? "backend-engineer";
					nextAction = `\n\n[Next Action] DISPATCH — the plan is already approved and kanban tasks already exist. DO NOT run task-planner or create a new plan. Call run_agent NOW with agent_name="${agent}" and kanban_task_id="${unblocked.id}" to execute the existing task: "${unblocked.title}".`;
				} else if (allTasks.every(t => t.column === "done")) {
					nextAction = `\n\n[Next Action] ALL DONE — all ${allTasks.length} tasks completed. Summarize results to the user.`;
				} else {
					nextAction = `\n\n[Next Action] BLOCKED — remaining tasks have unmet dependencies. Call list_tasks to check.`;
				}
			}
		} catch { /* non-fatal — PM can use list_tasks */ }

		console.log(`[ReviewCycle] Auto-continue: task "${completedTaskTitle}" done, sending continue to PM`);
		eng.sendMessage(conversationId, `[Agent Report] Task "${completedTaskTitle}" passed code review and moved to done.${nextAction}`, { type: "agent_report" } as Parameters<typeof eng.sendMessage>[2]).catch((err) => {
			console.error(`[ReviewCycle] Auto-continue failed:`, err);
		});
	} catch (err) {
		console.error(`[ReviewCycle] triggerPMAutoContinue error:`, err);
	}
}

// ---------------------------------------------------------------------------
// Agent spawning helper
// ---------------------------------------------------------------------------

/**
 * Spawn an inline agent for the review cycle. Resolves the default AI
 * provider, creates broadcast callbacks, and runs via runInlineAgent.
 *
 * This is a self-contained spawner — no WorkflowEngine or engine-manager
 * spawnAgent callback required.
 */
async function spawnReviewAgent(
	projectId: string,
	agentName: string,
	task: string,
	kanbanTaskId?: string,
): Promise<{ status: string; summary: string }> {
	const eng = getOrCreateEngine(projectId);
	const conversationId = eng.getActiveConversationId() ?? "";

	// Resolve display name
	const agentRows = await db
		.select({ displayName: agentsTable.displayName })
		.from(agentsTable)
		.where(eq(agentsTable.name, agentName))
		.limit(1);
	const displayName = agentRows[0]?.displayName ?? agentName;

	// Resolve AI provider
	const provRows = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
	const provRow = provRows[0] ?? (await db.select().from(aiProviders).limit(1))[0];
	if (!provRow) return { status: "failed", summary: "No AI provider configured" };

	// Resolve workspace path
	const projectRows = await db
		.select({ workspacePath: projects.workspacePath })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	const workspacePath = projectRows[0]?.workspacePath ?? undefined;

	// Build frontend broadcast callbacks
	const callbacks: InlineAgentCallbacks = {
		onPartCreated: (part: MessagePart) => {
			broadcastToWebview("partCreated", {
				conversationId,
				messageId: part.messageId,
				part: {
					id: part.id, type: part.type, content: part.content,
					toolName: part.toolName, toolInput: part.toolInput,
					toolOutput: part.toolOutput, toolState: part.toolState,
					sortOrder: part.sortOrder, agentName: part.agentName,
					timeStart: part.timeStart, timeEnd: part.timeEnd,
				},
			});
		},
		onPartUpdated: (_mid, partId, updates) => {
			broadcastToWebview("partUpdated", {
				conversationId, messageId: _mid, partId,
				updates: { content: updates.content, toolOutput: updates.toolOutput, toolState: updates.toolState, timeEnd: updates.timeEnd },
			});
		},
		onTextDelta: () => {},
		onAgentStart: (mid, an, adn, t) => {
			broadcastToWebview("agentInlineStart", { conversationId, messageId: mid, agentName: an, agentDisplayName: adn, task: t });
		},
		onAgentComplete: (mid, an, status, summary) => {
			broadcastToWebview("agentInlineComplete", { conversationId, messageId: mid, agentName: an, status, summary });
		},
		onMessageCreated: (mid, convId, an, content) => {
			broadcastToWebview("newMessage", {
				conversationId: convId, messageId: mid,
				agentId: an, agentName: an, content,
				metadata: JSON.stringify({ source: "agent" }),
			});
		},
	};

	const agentAbort = new AbortController();
	registerAgentController(projectId, agentAbort, agentName);
	try {
		const result = await runInlineAgent({
			conversationId,
			agentName,
			agentDisplayName: displayName,
			task,
			projectContext: `Project ID: ${projectId}`,
			providerConfig: {
				id: provRow.id,
				name: provRow.name,
				providerType: provRow.providerType,
				apiKey: provRow.apiKey,
				baseUrl: provRow.baseUrl,
				defaultModel: provRow.defaultModel,
			},
			kanbanTaskId,
			abortSignal: agentAbort.signal,
			callbacks,
			workspacePath,
			projectId,
		});
		return { status: result.status, summary: result.summary };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[ReviewCycle] Agent ${agentName} failed:`, msg);
		return { status: "failed", summary: msg };
	} finally {
		unregisterAgentController(projectId, agentAbort);
	}
}

// ---------------------------------------------------------------------------
// Auto-commit helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the workspace has a git repo. If `.git` does not exist, runs
 * `git init` followed by an initial commit of all files.
 */
async function ensureGitInit(workspacePath: string): Promise<void> {
	const gitDir = join(workspacePath, ".git");
	const exists = await stat(gitDir).then(() => true).catch(() => false);
	if (!exists) {
		Bun.spawnSync(["git", "init", "--initial-branch=main"], { cwd: workspacePath, stderr: "pipe" });
		Bun.spawnSync(["git", "add", "-A"], { cwd: workspacePath, stderr: "pipe" });
		Bun.spawnSync(
			["git", "commit", "-m", "chore: initial commit"],
			{ cwd: workspacePath, stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "AgentDesk", GIT_AUTHOR_EMAIL: "ai@agentdesk", GIT_COMMITTER_NAME: "AgentDesk", GIT_COMMITTER_EMAIL: "ai@agentdesk" } },
		);
	}
}

/**
 * Stage all changes and commit them with a message referencing the task.
 * Non-fatal — any error is logged and swallowed.
 */
export async function autoCommitTask(projectId: string, taskId: string, taskTitle: string): Promise<void> {
	try {
		const enabled = await getSetting("autoCommitEnabled", "git");
		console.log(`[ReviewCycle] autoCommitTask: enabled=${JSON.stringify(enabled)} (type=${typeof enabled}) for task ${taskId}`);
		if (enabled !== "true") return;

		const projectRows = await db
			.select({ workspacePath: projects.workspacePath })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		const workspacePath = projectRows[0]?.workspacePath;
		if (!workspacePath) return;

		await ensureGitInit(workspacePath);

		// If feature branch workflow is enabled, ensure all task commits land on the
		// same feature branch (set upfront by PM via set_feature_branch tool).
		// Falls back to a slug derived from task title if PM didn't set one.
		const featureBranchEnabled = await getSetting("featureBranchWorkflow", `project:${projectId}`);
		if (featureBranchEnabled === "true") {
			// Prefer the PM-declared branch name; fall back to task-title slug
			const stored = await getSetting(`currentFeatureBranch:${projectId}`, "git");
			const slug = taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
			const branchName = (stored && stored.startsWith("feature/")) ? stored : `feature/${slug}`;

			// Check current branch
			const currentResult = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspacePath, stderr: "pipe" });
			const currentBranch = new TextDecoder().decode(currentResult.stdout).trim();

			if (currentBranch === branchName) {
				// Already on the right branch — nothing to do
				console.log(`[ReviewCycle] Feature branch: already on '${branchName}'`);
			} else {
				// Switch to the feature branch — create it if it doesn't exist yet
				const branchExists = Bun.spawnSync(["git", "rev-parse", "--verify", branchName], { cwd: workspacePath, stderr: "pipe" });
				if (branchExists.exitCode === 0) {
					Bun.spawnSync(["git", "checkout", branchName], { cwd: workspacePath, stderr: "pipe" });
					console.log(`[ReviewCycle] Feature branch: switched to existing '${branchName}' from '${currentBranch}'`);
				} else {
					Bun.spawnSync(["git", "checkout", "-b", branchName], { cwd: workspacePath, stderr: "pipe" });
					console.log(`[ReviewCycle] Feature branch: created '${branchName}' from '${currentBranch}' for task "${taskTitle}"`);
				}
			}
		}

		// Stage everything
		const addResult = Bun.spawnSync(["git", "add", "-A"], { cwd: workspacePath, stderr: "pipe" });
		if (addResult.exitCode !== 0) {
			console.warn(`[ReviewCycle] git add failed for task ${taskId}:`, new TextDecoder().decode(addResult.stderr));
			return;
		}

		// Check if there's anything to commit
		const statusResult = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: workspacePath, stderr: "pipe" });
		// After `git add -A`, porcelain output before commit will show staged changes with letters in col 1
		// If nothing staged/unstaged, output is empty
		const statusOut = new TextDecoder().decode(statusResult.stdout).trim();
		// Check for staged changes (first char not space/? means staged)
		const hasStagedChanges = statusOut.split("\n").some((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?" && line.trim() !== "");
		if (!hasStagedChanges) {
			console.log(`[ReviewCycle] Nothing to commit for task ${taskId}`);
			return;
		}

		// Use configurable commit message format from Git settings
		const format = await getSetting("commitMessageFormat", "git") || "feat: {task}";
		const message = format
			.replace("{task}", taskTitle)
			.replace("{description}", `Task ${taskId}`)
			.replace("{date}", new Date().toISOString().slice(0, 10));
		const commitResult = Bun.spawnSync(
			["git", "commit", "-m", message],
			{
				cwd: workspacePath,
				stderr: "pipe",
				env: { ...process.env, GIT_AUTHOR_NAME: "AgentDesk", GIT_AUTHOR_EMAIL: "ai@agentdesk", GIT_COMMITTER_NAME: "AgentDesk", GIT_COMMITTER_EMAIL: "ai@agentdesk" },
			},
		);
		if (commitResult.exitCode === 0) {
			console.log(`[ReviewCycle] Auto-committed changes for task "${taskTitle}" (${taskId})`);
			// Capture the commit hash so the reviewer can reference it for `git show <hash>`
			const revResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: workspacePath, stderr: "pipe" });
			const hash = new TextDecoder().decode(revResult.stdout).trim();
			if (hash) taskCommitHashes.set(taskId, hash);
		} else {
			const stderr = new TextDecoder().decode(commitResult.stderr).trim();
			console.warn(`[ReviewCycle] git commit failed for task ${taskId}: ${stderr}`);
		}
	} catch (err) {
		console.warn(`[ReviewCycle] autoCommitTask error for ${taskId}:`, err);
	}
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Trigger the code review cycle for a kanban task.
 *
 * Call this when a task is moved to the "review" column. It:
 *   1. Spawns a code-reviewer agent
 *   2. Reads the verdict (submit_review tool call or heuristic fallback)
 *   3. On pass → moves task to "done"
 *   4. On fail → moves back to "working", spawns fix agent (up to maxRounds)
 *   5. On max rounds → force-completes with warning note
 *
 * Fire-and-forget — returns immediately, review runs asynchronously.
 * Duplicate calls for the same task are silently ignored.
 */
export function notifyTaskInReview(projectId: string, taskId: string): void {
	// Guard: prevent duplicate reviewer spawns
	if (activeReviews.has(taskId)) {
		console.log(`[ReviewCycle] Review already in progress for task ${taskId} — skipping`);
		return;
	}
	activeReviews.add(taskId);

	(async () => {
		try {
			const task = await getKanbanTask(taskId);
			if (!task) {
				console.warn(`[ReviewCycle] Task ${taskId} not found — skipping review`);
				return;
			}

			const maxRounds = await getMaxReviewRounds(projectId);

			console.log(`[ReviewCycle] Spawning code-reviewer for "${task.title}" (${taskId})`);

			// Spawn code-reviewer
			const commitHash = taskCommitHashes.get(taskId);
			const gitInstructions = commitHash
				? `\n## Finding the Changes\nThe implementation was auto-committed. Run these git commands to see what changed:\n- \`git show ${commitHash}\` — full diff of the implementation commit\n- \`git show ${commitHash} --stat\` — summary of files changed\n\nCommit hash: ${commitHash}`
				: `\n## Finding the Changes\nRun \`git log --oneline -5\` to find recent commits, then \`git show HEAD\` or \`git diff HEAD~1\` to see what changed. If the working tree has uncommitted changes, use \`git diff\` to see them.`;
			const reviewResult = await spawnReviewAgent(
				projectId,
				"code-reviewer",
				[
					`## Code Review: ${task.title}`,
					``,
					`**Task ID:** ${taskId}`,
					`**Project ID:** ${projectId}`,
					``,
					`FIRST ACTION: Call get_task(id="${taskId}") to get the authoritative task description and acceptance criteria. Review against those — not any assumption.`,
					gitInstructions,
					``,
					`## Review Checklist`,
					`- Correctness: does the implementation do what the task requires?`,
					`- Acceptance criteria: is every criterion fully met?`,
					`- Edge cases: null/undefined, empty inputs, error paths`,
					`- No regressions in existing functionality`,
					``,
					`## When calling submit_review`,
					`- verdict "approved": brief confirmation of what was verified`,
					`- verdict "changes_requested": list EVERY issue with exact file path, line number(s), what is wrong, and what to change. Be specific — the fix agent will use this list directly without reading the full codebase again.`,
					`  Example: "1. src/auth.ts:87 — token is never invalidated on logout, add db.tokens.delete(token) 2. src/api.ts:34 — missing await on async call, will silently swallow errors"`,
					``,
					`IMPORTANT: You MUST call submit_review before finishing.`,
				].filter(Boolean).join("\n"),
				taskId,
			);

			// Determine verdict + capture detailed feedback for the fix agent
			let hasIssues: boolean;
			let reviewerFeedback = reviewResult.summary; // fallback: inline agent summary
			if (reviewResult.status !== "completed") {
				hasIssues = !isAgentCancelled(reviewResult); // Cancelled = don't treat as failure
				if (isAgentCancelled(reviewResult)) {
					console.log(`[ReviewCycle] Reviewer was cancelled for "${task.title}" — leaving in review`);
					return; // Don't move task, leave in review for next dispatch
				}
			} else {
				const details = await getSubmitReviewDetails(taskId);
				if (details?.verdict === "approved") {
					hasIssues = false;
				} else if (details?.verdict === "changes_requested") {
					hasIssues = true;
					// Prefer the reviewer's structured feedback over the inline summary
					if (details.feedback) reviewerFeedback = details.feedback;
				} else {
					hasIssues = reviewSummaryHasIssues(reviewResult.summary);
				}
			}

			const currentRounds = reviewRounds.get(taskId) ?? 0;

			if (!hasIssues) {
				// Review passed — move to done
				console.log(`[ReviewCycle] Review passed for "${task.title}" — moving to done`);
				await moveKanbanTask(taskId, "done", undefined, "review-cycle");
				// Auto-continue: trigger PM to dispatch next task
				await triggerPMAutoContinue(projectId, task.title);
			} else if (currentRounds < maxRounds - 1) {
				// Review failed, rounds remaining — send back for fixes
				reviewRounds.set(taskId, currentRounds + 1);
				console.log(`[ReviewCycle] Review failed for "${task.title}" (round ${currentRounds + 1}/${maxRounds}) — sending back for fixes`);

				await moveKanbanTask(taskId, "working", undefined, "review-cycle");

				// Determine which agent should fix — use assigned agent from kanban task
				const fixAgent = task.assignedAgentId ?? "backend-engineer";

				// Wait for any PM-dispatched agents to finish before spawning fix agent
				// to avoid concurrent write agents
				const pollStart = Date.now();
				const MAX_WAIT_MS = 5 * 60_000; // 5 minutes max wait
				while (getRunningAgentCount(projectId) > 0 && Date.now() - pollStart < MAX_WAIT_MS) {
					await new Promise((r) => setTimeout(r, 2000));
				}

				// Release the activeReviews guard BEFORE spawning fix agent.
				// When the fix agent moves the task back to "review", move_task calls
				// notifyTaskInReview which needs the guard cleared to start a new review.
				activeReviews.delete(taskId);

				try {
					const fixResult = await spawnReviewAgent(
						projectId,
						fixAgent,
						[
							`## Fix Code Review Issues (round ${currentRounds + 1}/${maxRounds})`,
							``,
							`**Task:** ${task.title}`,
							`**Kanban task ID:** ${taskId}`,
							`**Project ID:** ${projectId}`,
							``,
							`## Issues to Fix`,
							``,
							reviewerFeedback,
							``,
							`## Instructions`,
							``,
							`- Fix ONLY the issues listed above. Do not refactor unrelated code.`,
							`- Each issue includes the file path and line number(s) — go directly to those locations.`,
							`- Read each affected file before editing to understand the surrounding context.`,
							`- After all fixes are applied, call check_criteria for each acceptance criterion.`,
							`- Finally, call verify_implementation — it will auto-move the task to review on pass.`,
							`- Do NOT call move_task yourself.`,
						].join("\n"),
						taskId,
					);

					if (fixResult.status !== "completed" && !isAgentCancelled(fixResult)) {
						// Fix agent failed — force done with note
						await updateKanbanTask({ id: taskId, importantNotes: `Review fix failed (round ${currentRounds + 1}): ${fixResult.summary}` }).catch(() => {});
						await moveKanbanTask(taskId, "done", undefined, "review-cycle").catch(() => {});
					}
					// If fix succeeded, agent called move_task("review") which triggers
					// notifyTaskInReview again — do NOT call it here to avoid double-review.
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					await updateKanbanTask({ id: taskId, importantNotes: `Review fix error: ${msg}` }).catch(() => {});
					await moveKanbanTask(taskId, "done", undefined, "review-cycle").catch(() => {});
				}
			} else {
				// Max review rounds exceeded — force done with warning
				reviewRounds.set(taskId, currentRounds + 1);
				console.warn(`[ReviewCycle] Review issues remain after ${currentRounds + 1} rounds for "${task.title}" — force-completing`);
				await updateKanbanTask({ id: taskId, importantNotes: `Review issues remain after ${currentRounds + 1} round(s): ${reviewResult.summary}` }).catch(() => {});
				await moveKanbanTask(taskId, "done", undefined, "review-cycle").catch(() => {});
			}
		} catch (err) {
			console.error(`[ReviewCycle] notifyTaskInReview failed for ${taskId}:`, err);
			// Force-complete to prevent stuck task
			try {
				await moveKanbanTask(taskId, "done", undefined, "review-cycle");
			} catch { /* best effort */ }
		} finally {
			activeReviews.delete(taskId);
			// Clean up round counter and commit hash if task is done
			try {
				const task = await getKanbanTask(taskId);
				if (task?.column === "done") {
					reviewRounds.delete(taskId);
					taskCommitHashes.delete(taskId);
				}
			} catch { /* non-critical */ }
		}
	})();
}

/**
 * Check if a task currently has an active review in progress.
 * Useful for concurrency checks — callers can skip dispatching
 * new agents while a review is running.
 */
export function isReviewActive(taskId: string): boolean {
	return activeReviews.has(taskId);
}

/**
 * Get the count of currently active reviews.
 * Useful for sequential execution enforcement.
 */
export function getActiveReviewCount(): number {
	return activeReviews.size;
}
