import { getSavedConfig } from "./config-store";
import { normalisePriority } from "./types";
import type { IssueSourceAdapter, NormalisedIssue, TestResult, IssueRef, CreateIssueInput } from "./types";

function baseUrl(config: Record<string, string>): string {
	return (config.baseUrl?.trim() || "https://gitlab.com").replace(/\/+$/, "");
}

/** URL-encoded project identifier (path "group/project" or numeric id). */
function projectRef(config: Record<string, string>): string {
	return encodeURIComponent(config.projectPath);
}

async function gitlabFetch(
	config: Record<string, string>,
	path: string,
	options: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
	const res = await fetch(`${baseUrl(config)}/api/v4${path}`, {
		...options,
		headers: {
			"PRIVATE-TOKEN": config.token,
			"Content-Type": "application/json",
			...(options.headers ?? {}),
		},
	});
	let data: unknown;
	try {
		data = await res.json();
	} catch {
		data = {};
	}
	return { ok: res.ok, status: res.status, data };
}

interface GitLabIssue {
	iid: number;
	title: string;
	description: string | null;
	state: string; // "opened" | "closed"
	web_url: string;
	labels: string[];
	assignee: { name?: string } | null;
	created_at: string;
	due_date: string | null;
}

/** GitLab has no native priority; pull it from a scoped label `priority::x`. */
function priorityFromLabels(labels: string[]): string | null {
	const scoped = labels.find((l) => /^priority::/i.test(l));
	return scoped ? normalisePriority(scoped.split("::")[1]) : null;
}

export const gitlabAdapter: IssueSourceAdapter = {
	source: "gitlab",

	resolveConfig(projectId) {
		return getSavedConfig(projectId, "gitlab");
	},

	async fetchIssues(config): Promise<NormalisedIssue[]> {
		// Only open issues (state=opened in GitLab terms).
		const res = await gitlabFetch(config, `/projects/${projectRef(config)}/issues?per_page=100&state=opened&order_by=created_at`);
		if (!res.ok) {
			const msg = (res.data as { message?: string }).message ?? `HTTP ${res.status}`;
			throw new Error(`GitLab API error: ${msg}`);
		}
		const issues = res.data as GitLabIssue[];
		return issues.map<NormalisedIssue>((i) => ({
			sourceId: String(i.iid),
			title: i.title,
			body: i.description,
			state: i.state === "closed" ? "closed" : "open",
			url: i.web_url,
			labels: i.labels ?? [],
			assignee: i.assignee?.name ?? null,
			priority: priorityFromLabels(i.labels ?? []),
			dueDate: i.due_date ?? null,
			sourceCreatedAt: i.created_at,
			metadata: {},
		}));
	},

	async testConnection(config): Promise<TestResult> {
		const res = await gitlabFetch(config, `/projects/${projectRef(config)}`);
		if (!res.ok) {
			const msg = (res.data as { message?: string }).message ?? `HTTP ${res.status} — check URL, project path and token.`;
			return { ok: false, error: msg };
		}
		const proj = res.data as { path_with_namespace?: string };
		return { ok: true, detail: `Connected to ${proj.path_with_namespace ?? config.projectPath}` };
	},

	async closeIssue(config, ref: IssueRef) {
		await gitlabFetch(config, `/projects/${projectRef(config)}/issues/${ref.sourceId}?state_event=close`, {
			method: "PUT",
		});
	},

	async createIssue(config, input: CreateIssueInput): Promise<NormalisedIssue> {
		const labels = input.priority ? [`priority::${input.priority}`] : [];
		const params = new URLSearchParams({
			title: input.title,
			description: input.body,
			...(labels.length ? { labels: labels.join(",") } : {}),
		});
		const res = await gitlabFetch(config, `/projects/${projectRef(config)}/issues?${params.toString()}`, {
			method: "POST",
		});
		if (!res.ok) {
			const msg = (res.data as { message?: string }).message ?? `HTTP ${res.status}`;
			throw new Error(`GitLab API error: ${msg}`);
		}
		const issue = res.data as GitLabIssue;
		return {
			sourceId: String(issue.iid),
			title: issue.title,
			body: issue.description,
			state: "open",
			url: issue.web_url,
			labels: issue.labels ?? labels,
			assignee: null,
			priority: input.priority,
			dueDate: issue.due_date ?? null,
			sourceCreatedAt: issue.created_at,
			metadata: {},
		};
	},
};
