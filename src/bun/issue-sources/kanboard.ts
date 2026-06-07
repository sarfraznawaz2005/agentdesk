import { getSavedConfig } from "./config-store";
import { parseSelectedBuckets } from "./types";
import type { IssueSourceAdapter, NormalisedIssue, TestResult, IssueRef, CreateIssueInput, BucketGroup } from "./types";

// Only import the latest N open tasks (mirrors the 100-cap of the other sources).
const MAX_TASKS = 100;

function endpoint(config: Record<string, string>): string {
	const base = config.url.replace(/\/+$/, "");
	// Accept either the bare base URL or one already pointing at jsonrpc.php.
	return /jsonrpc\.php$/i.test(base) ? base : `${base}/jsonrpc.php`;
}

function authHeader(config: Record<string, string>): string {
	// Kanboard API: HTTP Basic with username "jsonrpc" and the API token as password.
	const basic = Buffer.from(`jsonrpc:${config.apiToken}`).toString("base64");
	return `Basic ${basic}`;
}

/** Single JSON-RPC 2.0 call. Returns the `result` field or throws on error. */
async function rpcCall(config: Record<string, string>, method: string, params: unknown): Promise<unknown> {
	const res = await fetch(endpoint(config), {
		method: "POST",
		headers: { Authorization: authHeader(config), "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", method, id: 1, params }),
	});
	const json = (await res.json().catch(() => {
		throw new Error(`Kanboard: invalid response (HTTP ${res.status})`);
	})) as { result?: unknown; error?: { message?: string; code?: number } };
	if (json.error) {
		throw new Error(`Kanboard API error: ${json.error.message ?? json.error.code ?? "unknown"}`);
	}
	return json.result;
}

interface KanboardTask {
	id: string | number;
	title: string;
	description: string;
	is_active: string | number; // "1" open, "0" closed
	priority: string | number;
	column_id?: string | number;
	project_id?: string | number;
	url?: string;
	assignee_name?: string;
	owner_id?: string | number;
	date_creation?: string | number;
	date_due?: string | number;
}

/** Parse the comma-separated Project IDs field into a list of numeric ids. */
function parseProjectIds(config: Record<string, string>): number[] {
	return (config.projectId ?? "")
		.split(",")
		.map((s) => Number(s.trim()))
		.filter((n) => Number.isFinite(n) && n > 0);
}

function taskUrl(config: Record<string, string>, task: KanboardTask): string {
	if (task.url) return task.url;
	const base = config.url.replace(/\/+$/, "").replace(/\/jsonrpc\.php$/i, "");
	return `${base}/?controller=TaskViewController&action=show&task_id=${task.id}&project_id=${task.project_id ?? ""}`;
}

// Kanboard priority is an arbitrary integer (commonly 0–3).
function mapKanboardPriority(p: string | number | undefined): string | null {
	const n = Number(p);
	if (Number.isNaN(n) || n <= 0) return null;
	if (n >= 3) return "high";
	if (n === 2) return "medium";
	return "low";
}

function toNormalised(config: Record<string, string>, task: KanboardTask): NormalisedIssue {
	const open = Number(task.is_active) === 1;
	const created = task.date_creation ? new Date(Number(task.date_creation) * 1000).toISOString() : null;
	// Kanboard stores due as a Unix timestamp; 0/empty means "no due date".
	const due = Number(task.date_due) > 0 ? new Date(Number(task.date_due) * 1000).toISOString() : null;
	return {
		sourceId: String(task.id),
		title: task.title,
		body: task.description || null,
		state: open ? "open" : "closed",
		url: taskUrl(config, task),
		labels: [],
		assignee: task.assignee_name || null,
		priority: mapKanboardPriority(task.priority),
		dueDate: due,
		sourceCreatedAt: created,
		metadata: { columnId: task.column_id != null ? String(task.column_id) : undefined },
	};
}

// Buckets = board columns, grouped per project. Throws on connection/auth failure.
async function fetchKanboardBuckets(config: Record<string, string>): Promise<BucketGroup[]> {
	const projectIds = parseProjectIds(config);
	if (projectIds.length === 0) throw new Error("Enter at least one numeric Project ID.");

	const out: BucketGroup[] = [];
	for (const pid of projectIds) {
		const project = (await rpcCall(config, "getProjectById", { project_id: pid })) as { name?: string } | null;
		if (!project || Object.keys(project).length === 0) {
			throw new Error(`Project ${pid} not found, or the token lacks access to it.`);
		}
		const columns = ((await rpcCall(config, "getColumns", { project_id: pid })) as Array<{ id: string | number; title: string }>) ?? [];
		out.push({
			groupId: String(pid),
			groupName: project.name ?? `Project ${pid}`,
			buckets: columns.map((c) => ({ id: String(c.id), title: c.title })),
		});
	}
	return out;
}

export const kanboardAdapter: IssueSourceAdapter = {
	source: "kanboard",

	resolveConfig(projectId) {
		return getSavedConfig(projectId, "kanboard");
	},

	fetchBuckets(config) {
		return fetchKanboardBuckets(config);
	},

	async fetchIssues(config): Promise<NormalisedIssue[]> {
		const projectIds = parseProjectIds(config);
		const selectedColumns = parseSelectedBuckets(config); // bucket ids = column ids

		// Gather open tasks across all configured projects.
		const collected: KanboardTask[] = [];
		for (const pid of projectIds) {
			// status_id 1 = active/open (0 = closed). Only fetch open tasks.
			const tasks = ((await rpcCall(config, "getAllTasks", { project_id: pid, status_id: 1 })) as KanboardTask[]) ?? [];
			for (const t of tasks) {
				// Filter to the user-selected columns. If none selected (legacy config),
				// fall back to importing every open task.
				if (selectedColumns.size === 0 || selectedColumns.has(String(t.column_id))) {
					collected.push(t);
				}
			}
		}

		// Newest first, capped to the latest MAX_TASKS.
		collected.sort((a, b) => Number(b.date_creation ?? 0) - Number(a.date_creation ?? 0));
		return collected.slice(0, MAX_TASKS).map((t) => toNormalised(config, t));
	},

	async testConnection(config): Promise<TestResult> {
		try {
			const groups = await fetchKanboardBuckets(config);
			const names = groups.map((g) => g.groupName).join(", ");
			return { ok: true, detail: `Connected to ${groups.length} project(s): ${names}` };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : "Connection failed." };
		}
	},

	async closeIssue(config, ref: IssueRef) {
		await rpcCall(config, "closeTask", { task_id: Number(ref.sourceId) });
	},

	async createIssue(config, input: CreateIssueInput): Promise<NormalisedIssue> {
		// New tasks are created in the first configured project.
		const targetProject = parseProjectIds(config)[0];
		if (!targetProject) throw new Error("No valid Project ID configured.");
		const priorityNum =
			input.priority === "high" || input.priority === "critical" ? 3 : input.priority === "medium" ? 2 : input.priority === "low" ? 1 : 0;
		const newId = await rpcCall(config, "createTask", {
			title: input.title,
			project_id: targetProject,
			description: input.body,
			priority: priorityNum,
		});
		const taskId = Number(newId);
		if (!taskId) throw new Error("Kanboard task creation failed.");
		// Read the created task back for an accurate URL + fields.
		const task = (await rpcCall(config, "getTask", { task_id: taskId })) as KanboardTask | null;
		if (task) return toNormalised(config, task);
		return {
			sourceId: String(taskId),
			title: input.title,
			body: input.body || null,
			state: "open",
			url: taskUrl(config, { id: taskId, project_id: targetProject } as KanboardTask),
			labels: [],
			assignee: null,
			priority: input.priority,
			dueDate: null,
			sourceCreatedAt: null,
			metadata: {},
		};
	},
};
