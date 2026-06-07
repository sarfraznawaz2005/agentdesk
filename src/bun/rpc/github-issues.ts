/**
 * GitHub issues — backwards-compatible shim.
 *
 * The original GitHub-only sync has been generalised into the multi-source
 * engine in `./issues.ts` backed by the `external_issues` table. These wrappers
 * preserve the legacy RPC surface (getGithubIssues / syncGithubIssues /
 * createGithubIssueFromTask / linkIssueToTask) so existing callers — notably the
 * kanban task-detail modal — keep working against `source = 'github'`.
 */
import { db } from "../db";
import { externalIssues } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { getGithubConfigError } from "./github-api";
import {
	getExternalIssues,
	syncIssueSource,
	linkExternalIssueToTask,
	createExternalIssueFromTask,
	closeExternalIssueForTask,
} from "./issues";

// ── Read (legacy shape with githubIssueNumber) ──────────────────────────────────

export async function getGithubIssues(projectId: string, state?: string) {
	const rows = await getExternalIssues(projectId, "github", state);
	return rows.map((r) => ({
		id: r.id,
		projectId: r.projectId,
		githubIssueNumber: Number(r.sourceId),
		taskId: r.taskId,
		title: r.title,
		body: r.body,
		state: r.state,
		labels: r.labels,
		githubCreatedAt: r.sourceCreatedAt,
		syncedAt: r.syncedAt,
	}));
}

// ── Sync from GitHub → local ──────────────────────────────────────────────────

export async function syncGithubIssues(
	projectId: string,
): Promise<{ synced: number; created: number; closed: number; error?: string }> {
	// Preserve the precise "what's missing" message the old UI relied on.
	const configError = await getGithubConfigError(projectId);
	if (configError) return { synced: 0, created: 0, closed: 0, error: configError };
	return syncIssueSource(projectId, "github");
}

// ── Create GitHub issue from kanban task ──────────────────────────────────────

export async function createGithubIssueFromTask(
	taskId: string,
	projectId: string,
): Promise<{ success: boolean; issueNumber?: number; error?: string }> {
	const res = await createExternalIssueFromTask(taskId, projectId, "github");
	if (!res.success) return { success: false, error: res.error };
	// Resolve the issue number from the freshly-linked row.
	const linked = (
		await db
			.select()
			.from(externalIssues)
			.where(and(eq(externalIssues.taskId, taskId), eq(externalIssues.source, "github")))
			.limit(1)
	)[0];
	return { success: true, issueNumber: linked ? Number(linked.sourceId) : undefined };
}

// ── Link / close (delegate to the generalised engine) ──────────────────────────

export async function linkIssueToTask(issueId: string, taskId: string | null) {
	return linkExternalIssueToTask(issueId, taskId);
}

export async function closeGithubIssueForTask(taskId: string, projectId: string) {
	return closeExternalIssueForTask(taskId, projectId);
}
