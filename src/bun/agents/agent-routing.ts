/**
 * agent-routing.ts — which agent to pick for which task.
 *
 * Split from prompts.ts so the roster-consistency test can read it without
 * opening a DB (same reason as agent-tool-defaults.ts / agent-seed-defs.ts).
 * Pure data and one pure formatter; prompts.ts renders it into the PM table
 * and pm-tools.ts serves it through list_agents.
 */

/**
 * Routing profiles — the PM's PRIMARY signal for WHICH agent, as opposed to the
 * Capabilities column's WHETHER-IT-CAN.
 *
 * Nearly every built-in write agent holds an equivalent toolset (shell, file
 * write, execute_code, git-read), so capabilities can only rule agents OUT.
 * With 20 near-identical candidates, "pick the best description" is where
 * routing actually degrades — a task landed on `backend-engineer` that
 * `database-expert` fit better, because nothing in backend-engineer's entry
 * pointed anywhere else.
 *
 * So each profile carries three parts, following the pattern established by
 * agent frameworks that route well with small rosters (Claude Code's
 * "Use this agent when…" descriptions, opencode's primary/subagent tiering):
 *   - `useWhen`  — the agent's real range, not its job title. Too narrow and it
 *                  gets skipped for work it suits: "Root-cause analysis" alone
 *                  reads as bugs-only.
 *   - `preferInstead` — explicit hand-offs to a better-fitting specialist. This
 *                  is the part that fixes wrong-specialist routing; a
 *                  description can only say what an agent IS, never what it
 *                  is second-best at.
 *   - `tier`     — "primary" agents lead the table; specialists follow under
 *                  their own heading, shrinking the effective choice space.
 */
export interface AgentRoutingProfile {
	useWhen: string;
	/** Better-fitting agent → the kind of work that should go there instead. */
	preferInstead?: Record<string, string>;
	tier: "primary" | "specialist";
}

export const BUILTIN_AGENT_PROFILES: Record<string, AgentRoutingProfile> = {
	// --- Primary: the everyday roster ---
	"code-explorer": {
		useWhen: "Codebase exploration, dependency mapping, tracing how something works, reading commits and databases. Cannot run commands or edit files",
		preferInstead: { "debugging-specialist": "anything needing a shell command to answer" },
		tier: "primary",
	},
	"research-expert": {
		useWhen: "Web search, library comparisons, multi-source research and evaluation. Cannot run commands or edit files",
		preferInstead: { "code-explorer": "questions answerable from this codebase rather than the web" },
		tier: "primary",
	},
	"task-planner": {
		useWhen: "Task breakdown and PRD creation — the only agent that authors kanban tasks. Cannot run commands or edit files",
		tier: "primary",
	},
	"backend-engineer": {
		useWhen: "Server-side logic, APIs, background jobs, service and data-layer implementation",
		preferInstead: {
			"database-expert": "schema design, migrations, query/index tuning, or inspecting an existing database",
			"api-designer": "designing the endpoint contract itself rather than implementing it",
		},
		tier: "primary",
	},
	"frontend_engineer": {
		useWhen: "UI components, React/TypeScript, styling, client-side state and browser behaviour",
		preferInstead: {
			"ui-ux-designer": "deciding what the interface should look like or how it should behave",
			"mobile-engineer": "React Native / Expo / native mobile screens",
		},
		tier: "primary",
	},
	"debugging-specialist": {
		useWhen: "Root-cause analysis and bug investigation; also the general-purpose choice for shell-driven investigation, inspecting system or tool state, and one-off diagnostic tasks that fit no other specialist",
		preferInstead: { "performance-expert": "code that works but is too slow" },
		tier: "primary",
	},
	"qa-engineer": {
		useWhen: "Test writing, end-to-end verification, reproducing reported behaviour, test infrastructure",
		preferInstead: { "code-reviewer": "judging whether an existing change is correct, rather than writing tests for it" },
		tier: "primary",
	},
	"code-reviewer": {
		useWhen: "Code review, correctness verification, running tests and lint against a change",
		preferInstead: { "security-expert": "a review specifically about vulnerabilities, auth, or permissions" },
		tier: "primary",
	},

	// --- Specialists: dispatch only when the task is squarely in their domain ---
	"software-architect": {
		useWhen: "System design, architecture decisions, evaluating technical approaches and trade-offs before implementation",
		preferInstead: { "task-planner": "breaking approved work into tasks rather than choosing the approach" },
		tier: "specialist",
	},
	"database-expert": {
		useWhen: "DB design, query optimisation, migrations, and inspecting or querying existing databases",
		tier: "specialist",
	},
	"api-designer": {
		useWhen: "REST/GraphQL design, OpenAPI specs, endpoint contracts and versioning",
		preferInstead: { "backend-engineer": "implementing an endpoint whose contract is already settled" },
		tier: "specialist",
	},
	"devops-engineer": {
		useWhen: "CI/CD, infrastructure, deployment, build pipelines, environment and release configuration. The only agent with git-write (commit/push/branch)",
		tier: "specialist",
	},
	"security-expert": {
		useWhen: "Security audits, vulnerability assessment, auth/permission review, applying security fixes",
		tier: "specialist",
	},
	"performance-expert": {
		useWhen: "Profiling, optimisation, benchmarking, diagnosing slow paths and resource use",
		preferInstead: { "debugging-specialist": "code that is wrong rather than slow" },
		tier: "specialist",
	},
	"refactoring-specialist": {
		useWhen: "Code restructuring, tech debt, splitting large modules, improving structure without changing behaviour",
		tier: "specialist",
	},
	"ui-ux-designer": {
		useWhen: "UX/UI design, wireframes, accessibility, visual and interaction review",
		preferInstead: { "frontend_engineer": "building the component once the design is decided" },
		tier: "specialist",
	},
	"mobile-engineer": {
		useWhen: "React Native, Expo, iOS/Android platform work",
		tier: "specialist",
	},
	"ml-engineer": {
		useWhen: "LLM integration, prompt engineering, model/provider wiring and evaluation",
		tier: "specialist",
	},
	"data-engineer": {
		useWhen: "Data pipelines, analytics, transforming and validating datasets",
		preferInstead: { "database-expert": "the database itself — schema, queries, migrations" },
		tier: "specialist",
	},
	"documentation-expert": {
		useWhen: "Docs, README, API docs, changelogs and written explanations",
		tier: "specialist",
	},
};

/**
 * Flat description map, derived from the profiles above.
 *
 * Kept as a separate export because `list_agents` and other callers want the
 * one-line form. Derived, never hand-written — a second literal list is exactly
 * how the last set of routing claims drifted apart.
 */
export const BUILTIN_AGENT_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
	Object.entries(BUILTIN_AGENT_PROFILES).map(([name, p]) => [name, describeProfile(p)]),
);

/** `useWhen`, with any hand-offs appended as a single sentence. */
export function describeProfile(profile: AgentRoutingProfile): string {
	const handoffs = Object.entries(profile.preferInstead ?? {});
	if (handoffs.length === 0) return profile.useWhen;
	const instead = handoffs.map(([agent, work]) => `${work} → ${agent}`).join("; ");
	return `${profile.useWhen}. **Instead use**: ${instead}`;
}
