// ---------------------------------------------------------------------------
// create_task access policy
//
// `create_task` is restricted to a single agent — the task-planner — which is the
// sole author of kanban tasks. This tiny, dependency-free module holds that policy
// so it can be reused by getToolsForAgent (which enforces it on every agent's tool
// set, both the allowlist and the zero-`agent_tools`-rows full-registry paths) and
// unit-tested in isolation. The PM is handled separately: its tool set is built
// inline in engine.ts and omits create_task; to add a task the PM spawns the
// task-planner.
// ---------------------------------------------------------------------------

import type { Tool } from "ai";

/** The only agent allowed to hold the `create_task` tool. */
export const CREATE_TASK_AGENT = "task-planner";

/**
 * Strip `create_task` from an agent's tool map unless it is the task-planner.
 * Mutates `tools` in place. Other kanban tools (move/update/list/etc.) are left
 * untouched.
 */
export function restrictCreateTask(agentName: string, tools: Record<string, Tool>): void {
	if (agentName !== CREATE_TASK_AGENT) delete tools.create_task;
}
