/**
 * Two-way sync between kanban tasks and GitHub Issues.
 */
import { db } from "../db";
import { githubIssues, kanbanTasks } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { githubFetch, getProjectGithubRepo, getGithubConfigError } from "./github-api";

// Priority → GitHub label mapping
const PRIORITY_LABELS: Record<string, string> = {
	critical: "priority: critical",
	high: "priority: high",
	medium: "priority: medium",
	low: "priority: low",
};

// ── Read ──────────────────────────────────────────────────────────────────────

export async function getGithubIssues(projectId: string, state?: string) {
	const conditions = state
		? and(eq(githubIssues.projectId, projectId), eq(githubIssues.state, state))
		: eq(githubIssues.projectId, projectId);
	const rows = await db.select().from(githubIssues).where(conditions);
	return rows.map((r) => ({
		id: r.id,
		projectId: r.projectId,
		githubIssueNumber: r.githubIssueNumber,
		taskId: r.taskId,
		title: r.title,
		body: r.body,
		state: r.state,
		labels: JSON.parse(r.labels) as string[],
		githubCreatedAt: r.githubCreatedAt,
		syncedAt: r.syncedAt,
	}));
}

// ── Sync from GitHub → local ──────────────────────────────────────────────────

export async function syncGithubIssues(
	projectId: string,
): Promise<{ synced: number; created: number; closed: number; error?: string }> {
	const configError = await getGithubConfigError(projectId);
	if (configError) return { synced: 0, created: 0, closed: 0, error: configError };
	const repo = await getProjectGithubRepo(projectId);
	if (!repo) return { synced: 0, created: 0, closed: 0, error: "GitHub not configured" };

	// Fetch all open issues from GitHub
	const res = await githubFetch(
		`/repos/${repo.owner}/${repo.repo}/issues?state=all&per_page=100`,
		{},
		repo.pat,
	);
	if (!res.ok) {
		return {
			synced: 0,
			created: 0,
			closed: 0,
			error: `GitHub API error: ${(res.data as { message?: string }).message ?? res.status}`,
		};
	}

	const ghIssues = res.data as Array<{
		number: number;
		title: string;
		body: string | null;
		state: string;
		labels: Array<{ name: string }>;
		created_at: string;
		pull_request?: unknown; // PRs also show in issues — skip them
	}>;

	// Filter out PRs (they appear in the issues endpoint too)
	const realIssues = ghIssues.filter((i) => !i.pull_request);
	if (realIssues.length === 0) return { synced: 0, created: 0, closed: 0 };

	// Batch-fetch all existing issues for this project in one query
	const existingRows = await db
		.select()
		.from(githubIssues)
		.where(eq(githubIssues.projectId, projectId));
	const existingByNumber = new Map(existingRows.map((r) => [r.githubIssueNumber, r]));

	let synced = 0;
	let created = 0;
	let closed = 0;
	const now = new Date().toISOString();

	for (const ghIssue of realIssues) {
		const labels = ghIssue.labels.map((l) => l.name);
		const labelsJson = JSON.stringify(labels);
		const existing = existingByNumber.get(ghIssue.number);

		if (existing) {
			// Update existing record
			await db
				.update(githubIssues)
				.set({
					title: ghIssue.title,
					body: ghIssue.body,
					state: ghIssue.state,
					labels: labelsJson,
					syncedAt: now,
				})
				.where(eq(githubIssues.id, existing.id));

			if (ghIssue.state === "closed" && existing.state === "open") closed++;
		} else {
			// Create new local record
			await db.insert(githubIssues).values({
				id: crypto.randomUUID(),
				projectId,
				githubIssueNumber: ghIssue.number,
				taskId: null,
				title: ghIssue.title,
				body: ghIssue.body,
				state: ghIssue.state,
				labels: labelsJson,
				githubCreatedAt: ghIssue.created_at,
			});
			created++;
		}
		synced++;
	}

	return { synced, created, closed };
}

// ── Create GitHub issue from kanban task ──────────────────────────────────────

export async function createGithubIssueFromTask(
	taskId: string,
	projectId: string,
): Promise<{ success: boolean; issueNumber?: number; error?: string }> {
	const repo = await getProjectGithubRepo(projectId);
	if (!repo) return { success: false, error: "GitHub not configured" };

	const tasks = await db
		.select()
		.from(kanbanTasks)
		.where(eq(kanbanTasks.id, taskId))
		.limit(1);
	const task = tasks[0];
	if (!task) return { success: false, error: "Task not found" };

	const priorityLabel = PRIORITY_LABELS[task.priority] ?? null;
	const labels = priorityLabel ? [priorityLabel] : [];

	const res = await githubFetch(
		`/repos/${repo.owner}/${repo.repo}/issues`,
		{
			method: "POST",
			body: JSON.stringify({
				title: task.title,
				body: task.description ?? "",
				labels,
			}),
		},
		repo.pat,
	);

	if (!res.ok) {
		return {
			success: false,
			error: `GitHub API error: ${(res.data as { message?: string }).message ?? res.status}`,
		};
	}

	const issue = res.data as { number: number; created_at: string };

	// Store in github_issues table
	const id = crypto.randomUUID();
	await db.insert(githubIssues).values({
		id,
		projectId,
		githubIssueNumber: issue.number,
		taskId,
		title: task.title,
		body: task.description,
		state: "open",
		labels: JSON.stringify(labels),
		githubCreatedAt: issue.created_at,
	});

	return { success: true, issueNumber: issue.number };
}

// ── Link issue to task ────────────────────────────────────────────────────────

export async function linkIssueToTask(issueId: string, taskId: string) {
	await db
		.update(githubIssues)
		.set({ taskId })
		.where(eq(githubIssues.id, issueId));
	return { success: true };
}

// ── Close GitHub issue when task moves to Done ────────────────────────────────

export async function closeGithubIssueForTask(taskId: string, projectId: string) {
	const repo = await getProjectGithubRepo(projectId);
	if (!repo) return;

	const issues = await db
		.select()
		.from(githubIssues)
		.where(and(eq(githubIssues.taskId, taskId), eq(githubIssues.state, "open")))
		.limit(1);
	const issue = issues[0];
	if (!issue) return;

	await githubFetch(
		`/repos/${repo.owner}/${repo.repo}/issues/${issue.githubIssueNumber}`,
		{ method: "PATCH", body: JSON.stringify({ state: "closed" }) },
		repo.pat,
	);
	await db
		.update(githubIssues)
		.set({ state: "closed" })
		.where(eq(githubIssues.id, issue.id));
}
