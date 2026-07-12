import { tool, type Tool } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { agents, agentTools } from "../../db/schema";
import { fileOpsTools } from "./file-ops";
import { shellTools } from "./shell";
import { communicationTools, createCommunicationTools } from "./communication";
import { notesTools } from "./notes";
import { kanbanTools, createKanbanTools } from "./kanban";
import { restrictCreateTask } from "./create-task-policy";
import { gitTools } from "./git";
import { planningTools } from "./planning";
import { webTools } from "./web";
import { systemTools } from "./system";
import { processTools } from "./process";
import { screenshotTools } from "./screenshot";
import { audioTools } from "./audio";
import { lspTools } from "./lsp";
import { skillTools } from "./skills";
import { memoryTools } from "./memory";
// ---------------------------------------------------------------------------
// Tool category metadata
// ---------------------------------------------------------------------------

export type ToolCategory = "file" | "shell" | "communication" | "notes" | "kanban" | "git" | "web" | "system" | "process" | "plugin" | "skills" | "memory";

export interface ToolDefinition {
	name: string;
	category: ToolCategory;
	description: string;
}

export interface ToolRegistryEntry {
	tool: Tool;
	category: ToolCategory;
}

// deep_research's real implementation needs the run's resolved provider/model
// (see the overlay in agent-loop.ts, right after model resolution completes),
// which this static registry has no access to. This stub exists only so the
// tool NAME is valid for agent_tools rows / getToolDefinitions() listing —
// research-expert always gets the real, runtime-bound tool from the overlay
// instead. If this stub ever executes directly, something upstream is wrong.
const deepResearchStub: ToolRegistryEntry = {
	category: "web",
	tool: tool({
		description:
			"Autonomously research a BROAD topic in depth: plans sub-questions, searches the web " +
			"multiple times, reads full pages from many sources, and synthesizes a long-form cited " +
			"markdown report — in ONE call, instead of you making many manual web_search calls " +
			"yourself. Use this whenever a task asks you to: research across several distinct " +
			"sources/platforms/communities (e.g. Reddit, X, Indie Hackers, Product Hunt, G2, forums) " +
			"and cross-check or synthesize findings; validate or evaluate a business/product idea, " +
			"market, or investment opportunity against evidence from multiple sources; compare options " +
			"or survey the state of something; or produce ONE consolidated recommendation/report that " +
			"depends on cross-referencing many independent sources rather than one lookup. That is " +
			"exactly this tool's job — reach for it instead of a string of individual web_search calls " +
			"whenever a task's own instructions describe that kind of broad, multi-source research. " +
			"For quick lookups instead — error messages, package/library questions, API docs, or " +
			"checking one specific fact — use web_search, which is faster and cheaper. Give it one " +
			"topic (condense a long task into its research question if needed); it never asks " +
			"clarifying questions — it assumes a reasonable interpretation and proceeds autonomously, " +
			"which is required since this may run unattended via schedules.",
		inputSchema: z.object({ topic: z.string().min(1).describe("The research topic or question") }),
		execute: async (): Promise<string> =>
			JSON.stringify({
				error: "deep_research requires the research-expert agent's runtime context; this registry stub should never execute directly.",
			}),
	}),
};

// ---------------------------------------------------------------------------
// Internal registry — assembled from individual tool modules
// ---------------------------------------------------------------------------

const toolRegistry: Record<string, ToolRegistryEntry> = {
	...fileOpsTools,
	...shellTools,
	...communicationTools,
	...notesTools,
	...kanbanTools,
	...gitTools,
	...planningTools,
	...webTools,
	deep_research: deepResearchStub,
	...systemTools,
	...processTools,
	...screenshotTools,
	...audioTools,
	...lspTools,
	...skillTools,
	...memoryTools,
};

/**
 * Register additional tools at runtime (e.g. kanban tools after DB is ready).
 */
export function registerTools(tools: Record<string, ToolRegistryEntry>): void {
	Object.assign(toolRegistry, tools);
}

// ---------------------------------------------------------------------------
// Tool config cache — keyed by agent name, manually invalidated on writes
// ---------------------------------------------------------------------------

/**
 * Per-agent tool config cache. Each entry is the resolved tool map for that
 * agent so repeated calls within the same session skip the DB entirely.
 * Use clearToolCache() to invalidate when agent tool assignments change.
 */
const toolConfigCache = new Map<string, Record<string, Tool>>();

/**
 * Invalidate the tool config cache.
 *
 * - Call with no arguments to flush the entire cache.
 * - Call with an agent name to flush only that agent's entry.
 */
export function clearToolCache(agentName?: string): void {
	if (agentName === undefined) {
		toolConfigCache.clear();
	} else {
		toolConfigCache.delete(agentName);
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the tools available for an agent.
 *
 * If the agent has rows in the agent_tools table, only tools marked as
 * enabled are returned. Otherwise all tools are returned (backwards
 * compatible with agents that have no explicit tool configuration).
 *
 * Results are cached in-process and invalidated via clearToolCache().
 */
export async function getToolsForAgent(agentName: string): Promise<Record<string, Tool>> {
	// Return cached result if available
	const cached = toolConfigCache.get(agentName);
	if (cached !== undefined) {
		return cached;
	}

	// Agent-specific kanban tools carry the agentName as actorId for audit logging
	const agentKanbanTools: Record<string, Tool> = {};
	for (const [name, entry] of Object.entries(createKanbanTools(agentName))) {
		agentKanbanTools[name] = entry.tool;
	}

	// Look up the agent's display name once — used to label the request_human_input
	// dialog with WHO is asking. Falls back to the internal name if not found.
	let displayName = agentName;
	let agentId: string | null = null;
	try {
		const agentRows = await db
			.select({ id: agents.id, displayName: agents.displayName })
			.from(agents)
			.where(eq(agents.name, agentName))
			.limit(1);
		if (agentRows.length > 0) {
			agentId = agentRows[0].id;
			if (agentRows[0].displayName) displayName = agentRows[0].displayName;
		}
	} catch {
		/* fall through — displayName stays as agentName */
	}

	// Agent-bound communication tools (request_human_input) carry the display name
	// and per-agent timeout, overlaid the same way as the kanban tools.
	const agentCommunicationTools: Record<string, Tool> = {};
	for (const [name, entry] of Object.entries(createCommunicationTools(agentName, displayName))) {
		agentCommunicationTools[name] = entry.tool;
	}

	// Try to load per-agent tool configuration from the DB
	try {
		if (agentId !== null) {
			const toolRows = await db
				.select({ toolName: agentTools.toolName, isEnabled: agentTools.isEnabled })
				.from(agentTools)
				.where(eq(agentTools.agentId, agentId));

			// Only filter if there are explicit tool assignments
			if (toolRows.length > 0) {
				const enabledTools = new Set(
					toolRows.filter((r) => r.isEnabled === 1).map((r) => r.toolName),
				);

				const result: Record<string, Tool> = {};
				for (const [name, entry] of Object.entries(toolRegistry)) {
					if (enabledTools.has(name)) {
						// Use the agent-bound kanban/communication tools when available
						// (they carry actorId / display name + per-agent timeout).
						result[name] = agentKanbanTools[name] ?? agentCommunicationTools[name] ?? entry.tool;
					}
				}
				restrictCreateTask(agentName, result);
				toolConfigCache.set(agentName, result);
				return result;
			}
		}
	} catch {
		// Fall through to returning all tools if DB query fails
	}

	// Default: return all tools with the agent-bound kanban + communication tools overlaid
	const allTools = { ...getAllTools(), ...agentKanbanTools, ...agentCommunicationTools };
	restrictCreateTask(agentName, allTools);
	toolConfigCache.set(agentName, allTools);
	return allTools;
}

/**
 * Returns all registered tools without filtering.
 */
export function getAllTools(): Record<string, Tool> {
	const result: Record<string, Tool> = {};
	for (const [name, entry] of Object.entries(toolRegistry)) {
		result[name] = entry.tool;
	}
	return result;
}

/**
 * Returns raw tool definition metadata for display or documentation purposes.
 */
export function getToolDefinitions(): ToolDefinition[] {
	return Object.entries(toolRegistry).map(([name, entry]) => ({
		name,
		category: entry.category,
		description: (entry.tool as { description?: string }).description ?? "",
	}));
}
