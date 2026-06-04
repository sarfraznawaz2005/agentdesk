// RPC handlers for the Issue Fixer feature.

import { eq } from "drizzle-orm";
import { db } from "../db";
import { projects } from "../db/schema";
import {
	getIssueFixerConfig as dbGetConfig,
	saveIssueFixerConfig as dbSaveConfig,
	listRuns,
	getRun,
	updateRun,
	type IssueFixRunRow,
} from "../issue-fixer/config";
import { pollProject } from "../issue-fixer/poller";
import { enqueueIssueFix, getLiveRun } from "../issue-fixer/orchestrator";
import { PREDEFINED_KEYWORDS } from "../issue-fixer/prompts";
import { getIssue } from "../issue-fixer/github";
import { resolveGitHubToken, parseGithubUrl } from "./github-api";
import { abortAgentByName } from "../engine-manager";
import type { IssueFixRunDto, IssueFixerConfigDto, ActiveIssueFixRunDto } from "../../shared/rpc/issue-fixer";

function mapRun(r: IssueFixRunRow): IssueFixRunDto {
	return {
		id: r.id,
		projectId: r.projectId,
		issueNumber: r.issueNumber,
		issueTitle: r.issueTitle,
		issueUrl: r.issueUrl ?? null,
		triggerType: r.triggerType,
		triggerKeyword: r.triggerKeyword ?? null,
		intent: r.intent,
		author: r.author ?? null,
		authorized: r.authorized === 1,
		status: r.status,
		branchName: r.branchName ?? null,
		prNumber: r.prNumber ?? null,
		prUrl: r.prUrl ?? null,
		testPassed: r.testPassed == null ? null : r.testPassed === 1,
		summary: r.summary ?? null,
		error: r.error ?? null,
		startedAt: r.startedAt,
		finishedAt: r.finishedAt ?? null,
	};
}

export async function getIssueFixerConfig(params: { projectId: string }): Promise<{ config: IssueFixerConfigDto | null }> {
	const config = await dbGetConfig(params.projectId);
	return { config: config as IssueFixerConfigDto | null };
}

export async function saveIssueFixerConfig(params: {
	projectId: string;
	config: Partial<Omit<IssueFixerConfigDto, "projectId">>;
}): Promise<{ config: IssueFixerConfigDto }> {
	const config = await dbSaveConfig(params.projectId, params.config);
	return { config: config as IssueFixerConfigDto };
}

export async function listIssueFixRuns(params: { projectId: string; limit?: number }): Promise<{ runs: IssueFixRunDto[] }> {
	const rows = await listRuns(params.projectId, params.limit ?? 100);
	return { runs: rows.map(mapRun) };
}

export async function getIssueFixRun(params: { id: string }): Promise<{ run: IssueFixRunDto | null }> {
	const row = await getRun(params.id);
	return { run: row ? mapRun(row) : null };
}

export async function getActiveIssueFixRun(params: { projectId: string }): Promise<{ run: ActiveIssueFixRunDto | null }> {
	return { run: getLiveRun(params.projectId) as ActiveIssueFixRunDto | null };
}

export async function pollIssueFixerNow(params: { projectId: string }): Promise<{
	ok: boolean;
	reason?: "disabled" | "no-credentials" | "primed" | "polled";
	enqueued?: number;
	ignored?: number;
	error?: string;
}> {
	try {
		const r = await pollProject(params.projectId);
		return { ok: true, reason: r.reason, enqueued: r.enqueued, ignored: r.ignored };
	} catch (e) {
		console.error("[issue-fixer] pollNow failed:", e);
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

export async function cancelIssueFixRun(params: { runId: string }): Promise<{ ok: boolean }> {
	const run = await getRun(params.runId);
	if (!run) return { ok: false };
	abortAgentByName(run.projectId, "issue-fixer");
	await updateRun(params.runId, {
		status: "cancelled",
		error: "Cancelled by user",
		finishedAt: new Date().toISOString(),
	});
	return { ok: true };
}

export async function triggerIssueFixManually(params: {
	projectId: string;
	issueNumber: number;
}): Promise<{ ok: boolean; error?: string }> {
	const proj = (await db.select().from(projects).where(eq(projects.id, params.projectId)).limit(1))[0];
	const parsed = proj?.githubUrl ? parseGithubUrl(proj.githubUrl) : null;
	const token = await resolveGitHubToken({ projectId: params.projectId });
	if (!parsed || !token) return { ok: false, error: "Project has no GitHub repo URL or token configured." };

	const issue = await getIssue(parsed.owner, parsed.repo, params.issueNumber, token);
	if (!issue) return { ok: false, error: `Issue #${params.issueNumber} not found.` };

	void enqueueIssueFix({
		projectId: params.projectId,
		issueNumber: issue.number,
		issueTitle: issue.title,
		issueBody: issue.body,
		issueUrl: issue.htmlUrl,
		// Manual "fix this issue" is really "do whatever the issue asks" — use the
		// generic task intent so the agent infers the right kind of work itself.
		intent: "task",
		triggerType: "manual",
		triggerKeyword: null,
		triggerCommentId: `manual:${Date.now()}`,
		author: "manual",
		authorized: true,
		prNumber: issue.isPullRequest ? issue.number : null,
	});
	return { ok: true };
}

export async function getIssueFixerKeywordCatalog(): Promise<{
	keywords: { keyword: string; intent: string; description: string }[];
}> {
	return { keywords: PREDEFINED_KEYWORDS.map((k) => ({ keyword: k.keyword, intent: k.intent, description: k.description })) };
}
