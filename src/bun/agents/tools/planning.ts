import { tool } from "ai";
import { z } from "zod";
import { eq, like } from "drizzle-orm";
import { db } from "../../db";
import { projects } from "../../db/schema";
import type { ToolRegistryEntry } from "./index";

// ---------------------------------------------------------------------------
// TaskDefinition type (standalone — no workflow dependency)
// ---------------------------------------------------------------------------

export interface TaskDefinition {
	title: string;
	description: string;
	assigned_agent: string;
	priority: "critical" | "high" | "medium" | "low";
	blocked_by: number[];
	acceptance_criteria: string[];
}

/** Zod schema for validating task definitions from AI output. */
export const taskDefinitionSchema = z.object({
	title: z.string(),
	description: z.string(),
	assigned_agent: z.string(),
	priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
	blocked_by: z.array(z.number()).default([]),
	acceptance_criteria: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveProjectId(projectIdOrName: string): Promise<string | null> {
	const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (uuidPattern.test(projectIdOrName)) return projectIdOrName;

	const rows = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.name, projectIdOrName))
		.limit(1);

	if (rows.length > 0) return rows[0].id;

	const partial = await db
		.select({ id: projects.id })
		.from(projects)
		.where(like(projects.name, `%${projectIdOrName}%`))
		.limit(1);

	return partial.length > 0 ? partial[0].id : null;
}

// ---------------------------------------------------------------------------
// Pending task definitions store
//
// When the task-planner calls define_tasks, definitions are held here keyed
// by project ID. The PM can drain them via drainTaskDefinitions() to create
// kanban tasks after user approval.
// ---------------------------------------------------------------------------

const pendingTaskDefinitions = new Map<string, TaskDefinition[]>();

/** Read pending task definitions without clearing them. */
export function peekTaskDefinitions(projectId: string): TaskDefinition[] | undefined {
	return pendingTaskDefinitions.get(projectId);
}

/** Read and clear pending task definitions for a project. */
export function drainTaskDefinitions(projectId: string): TaskDefinition[] | undefined {
	const defs = pendingTaskDefinitions.get(projectId);
	if (defs) pendingTaskDefinitions.delete(projectId);
	return defs;
}

/** Re-store drained task definitions (used when validation fails and we need to retry). */
export function restoreTaskDefinitions(projectId: string, defs: TaskDefinition[]): void {
	pendingTaskDefinitions.set(projectId, defs);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const planningTools: Record<string, ToolRegistryEntry> = {
	define_tasks: {
		category: "kanban",
		tool: tool({
			description:
				"Store structured task definitions for a project plan. These definitions are NOT written to the kanban board — they are held until the human approves the plan. Call this alongside create_doc when producing a project plan.",
			inputSchema: z.object({
				project_id: z
					.string()
					.describe("The project ID these task definitions belong to"),
				tasks: z
					.array(taskDefinitionSchema)
					.describe("Array of task definitions. Each task needs: title, description, assigned_agent, priority, blocked_by (array of task indices that must complete first), acceptance_criteria (array of verifiable criteria)."),
			}),
			execute: async (args) => {
				const resolvedProjectId = await resolveProjectId(args.project_id);
				const projectKey = resolvedProjectId ?? args.project_id;

				let definitions: TaskDefinition[] = args.tasks.map((t, idx) => ({
					...t,
					blocked_by: t.blocked_by.filter((b) => b !== idx),
				}));

				// Auto-inject contract task for cross-layer plans:
				// If tasks are assigned to both frontend and backend agents, prepend
				// a "Define shared interfaces" task and block all others on it.
				const agents = new Set(definitions.map((t) => t.assigned_agent));
				const hasFrontend = [...agents].some((a) => a.includes("frontend") || a.includes("ui"));
				const hasBackend = [...agents].some((a) => a.includes("backend") || a.includes("api") || a.includes("data"));
				if (hasFrontend && hasBackend) {
					const contractTask: TaskDefinition = {
						title: "Define shared interfaces and contracts",
						description:
							"Create shared type definitions, API shapes, and data contracts that both frontend and backend agents must follow. " +
							"This ensures consistency across layers. Create a contracts/ directory or shared types file.",
						assigned_agent: "software-architect",
						priority: "critical",
						blocked_by: [],
						acceptance_criteria: [
							"Shared type definitions or API contracts file exists",
							"Data models documented for cross-layer communication",
						],
					};
					// Shift all existing blocked_by indices by 1 (contract task is index 0)
					definitions = definitions.map((t) => ({
						...t,
						blocked_by: [0, ...t.blocked_by.map((b) => b + 1)],
					}));
					definitions.unshift(contractTask);
				}

				// Replace any existing definitions — each define_tasks call is the
				// authoritative complete list for this project. Appending caused duplicates
				// when the task-planner called define_tasks multiple times in one session.
				pendingTaskDefinitions.set(projectKey, definitions);

				const totalCount = definitions.length;
				const contractNote = hasFrontend && hasBackend
					? " A contracts task was auto-added as Task 0 — all implementation tasks depend on it."
					: "";
				return JSON.stringify({
					success: true,
					count: definitions.length,
					totalCount,
					contractTaskAdded: hasFrontend && hasBackend,
					message: `Stored ${totalCount} task definitions for project (previous definitions replaced).${contractNote}`,
				});
			},
		}),
	},
};
