import { githubFetch, getProjectGithubRepo, getGithubConfigError } from "../rpc/github-api";
import type { IssueSourceAdapter, NormalisedIssue, TestResult, IssueRef, CreateIssueInput } from "./types";

// Priority → GitHub label mapping (used when pushing a task out as an issue).
const PRIORITY_LABELS: Record<string, string> = {
	critical: "priority: critical",
	high: "priority: high",
	medium: "priority: medium",
	low: "priority: low",
};

/**
 * GitHub adapter. Unlike the other sources, GitHub reuses the existing global
 * config: the repo URL from Project Settings and the PAT from Settings › GitHub.
 * Its resolved "config" therefore carries owner/repo/pat resolved on demand.
 */
export const githubAdapter: IssueSourceAdapter = {
	source: "github",

	async resolveConfig(projectId) {
		const repo = await getProjectGithubRepo(projectId);
		if (!repo) return null;
		return { owner: repo.owner, repo: repo.repo, pat: repo.pat };
	},

	async fetchIssues(config) {
		// Only open issues (newest first by default).
		const res = await githubFetch(
			`/repos/${config.owner}/${config.repo}/issues?state=open&per_page=100`,
			{},
			config.pat,
		);
		if (!res.ok) {
			throw new Error(`GitHub API error: ${(res.data as { message?: string }).message ?? res.status}`);
		}
		const ghIssues = res.data as Array<{
			number: number;
			title: string;
			body: string | null;
			state: string;
			html_url: string;
			labels: Array<{ name: string }>;
			assignee: { login: string } | null;
			created_at: string;
			pull_request?: unknown;
		}>;
		return ghIssues
			.filter((i) => !i.pull_request) // PRs also surface on the issues endpoint
			.map<NormalisedIssue>((i) => ({
				sourceId: String(i.number),
				title: i.title,
				body: i.body,
				state: i.state === "closed" ? "closed" : "open",
				url: i.html_url,
				labels: i.labels.map((l) => l.name),
				assignee: i.assignee?.login ?? null,
				priority: null,
				dueDate: null,
				sourceCreatedAt: i.created_at,
				metadata: { githubIssueNumber: i.number },
			}));
	},

	async testConnection(config): Promise<TestResult> {
		// config here is the resolved {owner,repo,pat}. When called from the
		// configure dialog GitHub has no form, so this path is mainly internal.
		if (!config.owner || !config.repo || !config.pat) {
			return { ok: false, error: "GitHub repository URL and token must be configured in Settings." };
		}
		const res = await githubFetch(`/repos/${config.owner}/${config.repo}`, {}, config.pat);
		if (!res.ok) {
			return { ok: false, error: `GitHub API error: ${(res.data as { message?: string }).message ?? res.status}` };
		}
		return { ok: true, detail: `Connected to ${config.owner}/${config.repo}` };
	},

	async closeIssue(config, ref: IssueRef) {
		await githubFetch(
			`/repos/${config.owner}/${config.repo}/issues/${ref.sourceId}`,
			{ method: "PATCH", body: JSON.stringify({ state: "closed" }) },
			config.pat,
		);
	},

	async createIssue(config, input: CreateIssueInput): Promise<NormalisedIssue> {
		const labels = input.priority && PRIORITY_LABELS[input.priority] ? [PRIORITY_LABELS[input.priority]] : [];
		const res = await githubFetch(
			`/repos/${config.owner}/${config.repo}/issues`,
			{ method: "POST", body: JSON.stringify({ title: input.title, body: input.body, labels }) },
			config.pat,
		);
		if (!res.ok) {
			throw new Error(`GitHub API error: ${(res.data as { message?: string }).message ?? res.status}`);
		}
		const issue = res.data as { number: number; html_url: string; created_at: string };
		return {
			sourceId: String(issue.number),
			title: input.title,
			body: input.body,
			state: "open",
			url: issue.html_url,
			labels,
			assignee: null,
			priority: input.priority,
			dueDate: null,
			sourceCreatedAt: issue.created_at,
			metadata: { githubIssueNumber: issue.number },
		};
	},
};

/** Re-export so the engine can surface the specific GitHub config error. */
export { getGithubConfigError };
