// src/bun/agents/tools/simple-dispatch.ts
//
// Minimal run_agent/run_agents_parallel for the project-less "Agent Task"
// (agent_task_simple) scheduler mode. Unlike pm-tools.ts's run_agent (which
// is fire-and-forget and relies on a persistent PM conversation to surface
// results via an [Agent Report] restart), there is no conversation to resume
// here — a single generateText call runs once. So dispatch is BLOCKING:
// execute() awaits runInlineAgent() to completion and returns the result
// directly as the tool's output, letting the same generateText stopWhen loop
// continue. See project-wiki/subsystems/agent-tools.md for the full writeup.
import { tool, type Tool } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { agents as agentsTable } from "../../db/schema";
import { runInlineAgent, READ_ONLY_AGENTS, type InlineAgentCallbacks } from "../agent-loop";
import type { ProviderConfig } from "../../providers/types";

export interface SimpleDispatchDeps {
	projectId?: string;
	workspacePath?: string;
	providerConfig: ProviderConfig;
	agentNames: readonly string[];
}

// No-op callbacks — this mode has no live chat UI to stream into. Same
// pattern as the other headless runInlineAgent caller, rpc/recommendations.ts.
const NOOP_CALLBACKS: InlineAgentCallbacks = {
	onPartCreated: () => {},
	onPartUpdated: () => {},
	onTextDelta: () => {},
	onAgentStart: () => {},
	onAgentComplete: () => {},
};

async function resolveAgent(agent: string): Promise<{ displayName: string }> {
	const rows = await db
		.select({ displayName: agentsTable.displayName, isEnabled: agentsTable.isEnabled, isBuiltin: agentsTable.isBuiltin, availableToPm: agentsTable.availableToPm })
		.from(agentsTable)
		.where(eq(agentsTable.name, agent))
		.limit(1);
	if (rows.length > 0 && !rows[0].isEnabled) {
		throw new Error(`Agent "${agent}" is disabled and cannot be dispatched. Enable it in Settings → Agents.`);
	}
	if (rows.length > 0 && rows[0].isBuiltin === 0 && rows[0].availableToPm === 0) {
		throw new Error(`Agent "${agent}" is not available to the PM. Toggle "Make Agent Available to PM" in Settings → Agents.`);
	}
	return { displayName: rows.length > 0 ? rows[0].displayName : agent };
}

export function createSimpleDispatchTools(deps: SimpleDispatchDeps): Record<string, Tool> {
	// Local re-entrancy guard, scoped to this one cron run — mirrors the real
	// engine's dispatchingAgents/writeAgentRunning invariant (pm-tools.ts) but
	// without any cross-run/cross-project coordination, since each
	// agent_task_simple invocation is independent.
	const dispatching = new Set<string>();
	let writeAgentRunning = false;
	const projectContext = deps.workspacePath ? `Workspace: ${deps.workspacePath}` : "";

	return {
		run_agent: tool({
			description: `Run a specialist sub-agent and BLOCK until it finishes, returning its result. Available agents: ${deps.agentNames.join(", ")}.`,
			inputSchema: z.object({
				agent: z.string().describe(`The specialist agent to run. Must be one of: ${deps.agentNames.join(", ")}`),
				task: z.string().describe("Comprehensive task description — the agent has no conversation history, this IS its entire context."),
			}),
			execute: async (args) => {
				if (!args.task?.trim()) {
					return JSON.stringify({ success: false, error: "Task description is required." });
				}
				const isReadOnly = READ_ONLY_AGENTS.has(args.agent);
				if (dispatching.has(args.agent)) {
					return JSON.stringify({ success: false, error: `${args.agent} is already running. Only one instance of each agent can run at a time.` });
				}
				if (!isReadOnly && writeAgentRunning) {
					return JSON.stringify({ success: false, error: "A write agent is already running. Wait for it to complete, or use run_agents_parallel for read-only work." });
				}
				dispatching.add(args.agent);
				if (!isReadOnly) writeAgentRunning = true;
				try {
					const { displayName } = await resolveAgent(args.agent);
					console.log(`[PM→DISPATCH SIMPLE] Spawning sub-agent "${args.agent}" (${displayName}) project=${deps.projectId ?? "none"} readOnly=${isReadOnly} taskPreview="${args.task.slice(0, 150).replace(/\n/g, " ")}"`);
					const result = await runInlineAgent({
						conversationId: `scheduler:${crypto.randomUUID()}`,
						agentName: args.agent,
						agentDisplayName: displayName,
						task: args.task,
						projectContext,
						providerConfig: deps.providerConfig,
						workspacePath: deps.workspacePath,
						projectId: deps.projectId ?? "",
						readOnly: isReadOnly,
						persistToDb: false,
						callbacks: NOOP_CALLBACKS,
					});
					console.log(`[PM→DISPATCH SIMPLE RESULT] agent="${args.agent}" status=${result.status} filesModified=${result.filesModified.length}`);
					return JSON.stringify({ success: true, agent: displayName, status: result.status, summary: result.summary, filesModified: result.filesModified });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				} finally {
					dispatching.delete(args.agent);
					if (!isReadOnly) writeAgentRunning = false;
				}
			},
		}),

		run_agents_parallel: tool({
			description: `Run multiple READ-ONLY agents concurrently for exploration or research and BLOCK until all finish. Only these agents are allowed: ${[...READ_ONLY_AGENTS].join(", ")}.`,
			inputSchema: z.object({
				tasks: z.array(z.object({
					agent: z.string().describe(`Read-only agent type. Must be one of: ${[...READ_ONLY_AGENTS].join(", ")}`),
					task: z.string().describe("Exploration/research task description"),
				})).min(1).max(5),
			}),
			execute: async (args) => {
				const invalidAgents = args.tasks.filter(t => !READ_ONLY_AGENTS.has(t.agent)).map(t => t.agent);
				if (invalidAgents.length > 0) {
					return JSON.stringify({
						success: false,
						error: `run_agents_parallel only accepts read-only agents (${[...READ_ONLY_AGENTS].join(", ")}). These agents must use run_agent instead: ${invalidAgents.join(", ")}`,
					});
				}

				const allResults = await Promise.allSettled(
					args.tasks.map(async (t, i) => {
						if (i > 0) await new Promise(r => setTimeout(r, i * 1500));
						const { displayName } = await resolveAgent(t.agent);
						console.log(`[PM→DISPATCH SIMPLE PARALLEL] Spawning sub-agent "${t.agent}" (${displayName}) project=${deps.projectId ?? "none"} taskPreview="${t.task.slice(0, 150).replace(/\n/g, " ")}"`);
						const result = await runInlineAgent({
							conversationId: `scheduler:${crypto.randomUUID()}`,
							agentName: t.agent,
							agentDisplayName: displayName,
							task: t.task,
							projectContext,
							providerConfig: deps.providerConfig,
							workspacePath: deps.workspacePath,
							projectId: deps.projectId ?? "",
							readOnly: true,
							persistToDb: false,
							callbacks: NOOP_CALLBACKS,
						});
						console.log(`[PM→DISPATCH SIMPLE PARALLEL RESULT] agent="${t.agent}" status=${result.status}`);
						return result;
					}),
				);

				const summaries = allResults.map((r, i) => ({
					agent: args.tasks[i].agent,
					task: args.tasks[i].task,
					status: r.status === "fulfilled" ? r.value.status : "failed",
					summary: r.status === "fulfilled" ? r.value.summary : (r.reason?.message ?? "Unknown error"),
				}));

				return JSON.stringify({ success: true, results: summaries });
			},
		}),
	};
}
