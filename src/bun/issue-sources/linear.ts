import { getSavedConfig } from "./config-store";
import type { IssueSourceAdapter, NormalisedIssue, TestResult, IssueRef, CreateIssueInput } from "./types";

const LINEAR_API = "https://api.linear.app/graphql";

async function linearGraphQL(
	apiKey: string,
	query: string,
	variables?: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown; errors?: string }> {
	const res = await fetch(LINEAR_API, {
		method: "POST",
		headers: {
			Authorization: apiKey, // Linear uses the raw key, NOT "Bearer ..."
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query, variables }),
	});
	let json: { data?: unknown; errors?: Array<{ message: string }> } = {};
	try {
		json = await res.json();
	} catch {
		/* empty */
	}
	if (json.errors?.length) {
		return { ok: false, errors: json.errors.map((e) => e.message).join("; ") };
	}
	if (!res.ok) return { ok: false, errors: `HTTP ${res.status}` };
	return { ok: true, data: json.data };
}

// Linear priority: 0 none, 1 urgent, 2 high, 3 normal, 4 low.
function mapLinearPriority(p: number | null | undefined): string | null {
	switch (p) {
		case 1: return "critical";
		case 2: return "high";
		case 3: return "medium";
		case 4: return "low";
		default: return null;
	}
}

function priorityToLinear(priority: string | null): number {
	switch (priority) {
		case "critical": return 1;
		case "high": return 2;
		case "medium": return 3;
		case "low": return 4;
		default: return 0;
	}
}

interface LinearNode {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	url: string;
	priority: number;
	createdAt: string;
	dueDate: string | null;
	state: { name: string; type: string } | null;
	labels: { nodes: Array<{ name: string }> };
	assignee: { name: string } | null;
}

/** Resolve a team's UUID from a config that may hold either a UUID or a team key. */
async function resolveTeamId(apiKey: string, teamRef: string): Promise<string | null> {
	// A UUID is accepted directly.
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(teamRef)) return teamRef;
	const res = await linearGraphQL(apiKey, `query { teams(first: 50) { nodes { id key name } } }`);
	if (!res.ok) return null;
	const teams = (res.data as { teams?: { nodes: Array<{ id: string; key: string }> } }).teams?.nodes ?? [];
	const match = teams.find((t) => t.key.toLowerCase() === teamRef.toLowerCase());
	return match?.id ?? null;
}

export const linearAdapter: IssueSourceAdapter = {
	source: "linear",

	resolveConfig(projectId) {
		return getSavedConfig(projectId, "linear");
	},

	async fetchIssues(config): Promise<NormalisedIssue[]> {
		// Only open issues — exclude completed/canceled workflow states.
		const filterParts: string[] = [`state: { type: { nin: ["completed", "canceled"] } }`];
		if (config.teamId) {
			const teamId = await resolveTeamId(config.apiKey, config.teamId);
			if (teamId) filterParts.unshift(`team: { id: { eq: "${teamId}" } }`);
		}
		const filterClause = `, filter: { ${filterParts.join(", ")} }`;
		const query = `query {
  issues(first: 100${filterClause}) {
    nodes {
      id identifier title description url priority createdAt dueDate
      state { name type }
      labels { nodes { name } }
      assignee { name }
    }
  }
}`;
		const res = await linearGraphQL(config.apiKey, query);
		if (!res.ok) throw new Error(`Linear API error: ${res.errors}`);
		const nodes = (res.data as { issues?: { nodes: LinearNode[] } }).issues?.nodes ?? [];
		return nodes.map<NormalisedIssue>((n) => {
			const closed = n.state?.type === "completed" || n.state?.type === "canceled";
			return {
				sourceId: n.id,
				title: n.title,
				body: n.description || null,
				state: closed ? "closed" : "open",
				url: n.url,
				labels: n.labels?.nodes.map((l) => l.name) ?? [],
				assignee: n.assignee?.name ?? null,
				priority: mapLinearPriority(n.priority),
				dueDate: n.dueDate ?? null,
				sourceCreatedAt: n.createdAt,
				metadata: { identifier: n.identifier },
			};
		});
	},

	async testConnection(config): Promise<TestResult> {
		const res = await linearGraphQL(config.apiKey, `query { viewer { name email } }`);
		if (!res.ok) return { ok: false, error: res.errors ?? "Authentication failed." };
		const viewer = (res.data as { viewer?: { name?: string; email?: string } }).viewer;
		if (config.teamId) {
			const teamId = await resolveTeamId(config.apiKey, config.teamId);
			if (!teamId) return { ok: false, error: `Team "${config.teamId}" not found.` };
		}
		return { ok: true, detail: `Connected as ${viewer?.name ?? viewer?.email ?? "user"}` };
	},

	async closeIssue(config, ref: IssueRef) {
		// Find a "completed" workflow state, preferring the issue's own team.
		const teamQuery = `query { issue(id: "${ref.sourceId}") { team { id } } }`;
		const issueRes = await linearGraphQL(config.apiKey, teamQuery);
		if (!issueRes.ok) return;
		const teamId = (issueRes.data as { issue?: { team?: { id: string } } }).issue?.team?.id;
		if (!teamId) return;
		const statesRes = await linearGraphQL(
			config.apiKey,
			`query { workflowStates(filter: { team: { id: { eq: "${teamId}" } }, type: { eq: "completed" } }, first: 1) { nodes { id } } }`,
		);
		if (!statesRes.ok) return;
		const stateId = (statesRes.data as { workflowStates?: { nodes: Array<{ id: string }> } }).workflowStates?.nodes[0]?.id;
		if (!stateId) return;
		await linearGraphQL(
			config.apiKey,
			`mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
			{ id: ref.sourceId, stateId },
		);
	},

	async createIssue(config, input: CreateIssueInput): Promise<NormalisedIssue> {
		if (!config.teamId) {
			throw new Error("A Team ID/Key is required to create Linear issues. Add it in the Linear config.");
		}
		const teamId = await resolveTeamId(config.apiKey, config.teamId);
		if (!teamId) throw new Error(`Linear team "${config.teamId}" not found.`);
		const res = await linearGraphQL(
			config.apiKey,
			`mutation($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url createdAt }
  }
}`,
			{ input: { teamId, title: input.title, description: input.body, priority: priorityToLinear(input.priority) } },
		);
		if (!res.ok) throw new Error(`Linear API error: ${res.errors}`);
		const issue = (res.data as { issueCreate?: { issue?: { id: string; identifier: string; url: string; createdAt: string } } }).issueCreate?.issue;
		if (!issue) throw new Error("Linear issue creation returned no issue.");
		return {
			sourceId: issue.id,
			title: input.title,
			body: input.body || null,
			state: "open",
			url: issue.url,
			labels: [],
			assignee: null,
			priority: input.priority,
			dueDate: null,
			sourceCreatedAt: issue.createdAt,
			metadata: { identifier: issue.identifier },
		};
	},
};
