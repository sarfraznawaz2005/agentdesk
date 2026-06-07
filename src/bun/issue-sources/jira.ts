import { getSavedConfig } from "./config-store";
import { normalisePriority, parseSelectedBuckets } from "./types";
import type { IssueSourceAdapter, NormalisedIssue, TestResult, IssueRef, CreateIssueInput, BucketGroup } from "./types";

// ── helpers ─────────────────────────────────────────────────────────────────

function baseUrl(config: Record<string, string>): string {
	return config.baseUrl.replace(/\/+$/, "");
}

function authHeader(config: Record<string, string>): string {
	const basic = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
	return `Basic ${basic}`;
}

async function jiraFetch(
	config: Record<string, string>,
	path: string,
	options: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
	const res = await fetch(`${baseUrl(config)}${path}`, {
		...options,
		headers: {
			Authorization: authHeader(config),
			Accept: "application/json",
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

/** Flatten Atlassian Document Format (ADF) into plain text, best-effort. */
function adfToText(node: unknown): string {
	if (!node || typeof node !== "object") return "";
	const n = node as { type?: string; text?: string; content?: unknown[] };
	if (n.type === "text" && typeof n.text === "string") return n.text;
	let out = "";
	if (Array.isArray(n.content)) {
		for (const child of n.content) out += adfToText(child);
		// Add a line break after block-level nodes for readability.
		if (n.type === "paragraph" || n.type === "heading") out += "\n";
	}
	return out;
}

/** Wrap plain text into a minimal ADF document for create/update. */
function textToAdf(text: string) {
	return {
		type: "doc",
		version: 1,
		content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
	};
}

interface JiraIssue {
	key: string;
	fields: {
		summary: string;
		description: unknown;
		status: { statusCategory?: { key?: string } };
		labels: string[];
		assignee: { displayName?: string } | null;
		priority: { name?: string } | null;
		created: string;
		duedate: string | null;
	};
}

// Buckets = the project's statuses (de-duplicated across all issue types).
async function fetchJiraStatuses(config: Record<string, string>): Promise<BucketGroup[]> {
	const res = await jiraFetch(config, `/rest/api/3/project/${encodeURIComponent(config.projectKey)}/statuses`);
	if (!res.ok) {
		const msg = (res.data as { errorMessages?: string[] }).errorMessages?.join("; ") ?? `HTTP ${res.status}`;
		throw new Error(`Jira API error: ${msg}`);
	}
	const issueTypes = (res.data as Array<{ statuses?: Array<{ id: string; name: string }> }>) ?? [];
	const seen = new Map<string, string>();
	for (const it of issueTypes) {
		for (const s of it.statuses ?? []) {
			if (!seen.has(s.id)) seen.set(s.id, s.name);
		}
	}
	return [
		{
			groupId: config.projectKey,
			groupName: `${config.projectKey} statuses`,
			buckets: [...seen.entries()].map(([id, title]) => ({ id, title })),
		},
	];
}

// ── adapter ──────────────────────────────────────────────────────────────────

export const jiraAdapter: IssueSourceAdapter = {
	source: "jira",

	resolveConfig(projectId) {
		return getSavedConfig(projectId, "jira");
	},

	// Buckets = the project's statuses (unique across issue types). A project is a single group.
	fetchBuckets(config) {
		return fetchJiraStatuses(config);
	},

	async fetchIssues(config): Promise<NormalisedIssue[]> {
		// If the user picked specific statuses, filter to those; otherwise default to
		// everything not in the "Done" category (still open).
		const selected = parseSelectedBuckets(config);
		// Status IDs must be unquoted in JQL (quoted values are matched as names).
		const scope =
			selected.size > 0
				? `status in (${[...selected].filter((id) => /^\d+$/.test(id)).join(",")})`
				: `statusCategory != Done`;
		const jql = encodeURIComponent(`project = "${config.projectKey}" AND ${scope} ORDER BY created DESC`);
		const fields = "summary,description,status,labels,assignee,priority,created,duedate";
		const res = await jiraFetch(config, `/rest/api/3/search?jql=${jql}&maxResults=100&fields=${fields}`);
		if (!res.ok) {
			const msg =
				(res.data as { errorMessages?: string[] }).errorMessages?.join("; ") ?? `HTTP ${res.status}`;
			throw new Error(`Jira API error: ${msg}`);
		}
		const issues = (res.data as { issues?: JiraIssue[] }).issues ?? [];
		return issues.map<NormalisedIssue>((it) => {
			const done = it.fields.status?.statusCategory?.key === "done";
			return {
				sourceId: it.key,
				title: it.fields.summary,
				body: adfToText(it.fields.description).trim() || null,
				state: done ? "closed" : "open",
				url: `${baseUrl(config)}/browse/${it.key}`,
				labels: it.fields.labels ?? [],
				assignee: it.fields.assignee?.displayName ?? null,
				priority: normalisePriority(it.fields.priority?.name),
				dueDate: it.fields.duedate ?? null,
				sourceCreatedAt: it.fields.created ?? null,
				metadata: {},
			};
		});
	},

	async testConnection(config): Promise<TestResult> {
		const res = await jiraFetch(config, `/rest/api/3/myself`);
		if (!res.ok) {
			const msg =
				(res.data as { errorMessages?: string[] }).errorMessages?.join("; ") ??
				`HTTP ${res.status} — check URL, email and token.`;
			return { ok: false, error: msg };
		}
		const me = res.data as { emailAddress?: string; displayName?: string };
		// Also verify the project key resolves.
		const proj = await jiraFetch(config, `/rest/api/3/project/${encodeURIComponent(config.projectKey)}`);
		if (!proj.ok) {
			return { ok: false, error: `Authenticated, but project "${config.projectKey}" was not found.` };
		}
		return { ok: true, detail: `Connected as ${me.displayName ?? me.emailAddress ?? "user"}` };
	},

	async closeIssue(config, ref: IssueRef) {
		// Find a transition whose target status is in the "done" category, then apply it.
		const res = await jiraFetch(config, `/rest/api/3/issue/${ref.sourceId}/transitions`);
		if (!res.ok) return;
		const transitions = (res.data as { transitions?: Array<{ id: string; to?: { statusCategory?: { key?: string } } }> }).transitions ?? [];
		const doneTransition = transitions.find((t) => t.to?.statusCategory?.key === "done");
		if (!doneTransition) return;
		await jiraFetch(config, `/rest/api/3/issue/${ref.sourceId}/transitions`, {
			method: "POST",
			body: JSON.stringify({ transition: { id: doneTransition.id } }),
		});
	},

	async createIssue(config, input: CreateIssueInput): Promise<NormalisedIssue> {
		const res = await jiraFetch(config, `/rest/api/3/issue`, {
			method: "POST",
			body: JSON.stringify({
				fields: {
					project: { key: config.projectKey },
					summary: input.title,
					description: textToAdf(input.body),
					issuetype: { name: "Task" },
				},
			}),
		});
		if (!res.ok) {
			const msg =
				(res.data as { errorMessages?: string[]; errors?: Record<string, string> });
			const detail = msg.errorMessages?.join("; ") ?? Object.values(msg.errors ?? {}).join("; ") ?? "create failed";
			throw new Error(`Jira API error: ${detail}`);
		}
		const created = res.data as { key: string };
		return {
			sourceId: created.key,
			title: input.title,
			body: input.body || null,
			state: "open",
			url: `${baseUrl(config)}/browse/${created.key}`,
			labels: [],
			assignee: null,
			priority: input.priority,
			dueDate: null,
			sourceCreatedAt: null,
			metadata: {},
		};
	},
};
