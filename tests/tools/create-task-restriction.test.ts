/**
 * create-task-restriction.test.ts
 *
 * `create_task` is restricted to the task-planner (the sole task author). The
 * enforcement lives in `restrictCreateTask`, applied by getToolsForAgent to BOTH
 * resolution paths — the allowlist path AND the zero-`agent_tools`-rows full
 * registry path — so no other sub-agent (including full-registry agents like
 * freelance-expert / issue-fixer / custom agents) can author kanban tasks. The PM
 * is handled separately (its inline tool set omits create_task).
 */

import { describe, it, expect } from "bun:test";
import type { Tool } from "ai";

// The policy lives in its own dependency-free module (no electrobun/db imports),
// so this imports cleanly and is immune to other test files that mock tools/index.
import { restrictCreateTask, CREATE_TASK_AGENT } from "../../src/bun/agents/tools/create-task-policy";

/** Build a fake tool map (values are unused — restrictCreateTask only deletes keys). */
function toolMap(...names: string[]): Record<string, Tool> {
	const m: Record<string, Tool> = {};
	for (const n of names) m[n] = {} as Tool;
	return m;
}

describe("restrictCreateTask", () => {
	it("CREATE_TASK_AGENT is the task-planner", () => {
		expect(CREATE_TASK_AGENT).toBe("task-planner");
	});

	it("keeps create_task for the task-planner", () => {
		const tools = toolMap("create_task", "list_tasks", "read_file");
		restrictCreateTask("task-planner", tools);
		expect("create_task" in tools).toBe(true);
	});

	it("removes create_task for an implementer agent, leaving other kanban tools", () => {
		const tools = toolMap("create_task", "move_task", "update_task", "list_tasks", "read_file");
		restrictCreateTask("backend-engineer", tools);
		expect("create_task" in tools).toBe(false);
		// Other kanban + file tools are untouched.
		expect("move_task" in tools).toBe(true);
		expect("update_task" in tools).toBe(true);
		expect("list_tasks" in tools).toBe(true);
		expect("read_file" in tools).toBe(true);
	});

	it("removes create_task for full-registry / zero-rows agents (freelance-expert, issue-fixer, custom)", () => {
		for (const name of ["freelance-expert", "issue-fixer", "code-reviewer", "my-custom-agent"]) {
			const tools = toolMap("create_task", "list_tasks");
			restrictCreateTask(name, tools);
			expect("create_task" in tools).toBe(false);
			expect("list_tasks" in tools).toBe(true);
		}
	});

	it("is a no-op when create_task is not present", () => {
		const tools = toolMap("list_tasks", "read_file");
		restrictCreateTask("backend-engineer", tools);
		expect(Object.keys(tools).sort()).toEqual(["list_tasks", "read_file"]);
	});
});
