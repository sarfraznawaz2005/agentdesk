/**
 * agent-capabilities.test.ts
 *
 * Locks the invariant that motivated src/shared/agent-capabilities.ts: an
 * agent's advertised capabilities must match what it can actually do once
 * dispatched.
 *
 * The regression this guards against is subtle and shipped twice. Capability
 * truth is COMPUTED at dispatch (filterReadOnlyTools strips WRITE_TOOLS from
 * read-only agents) but was DESCRIBED in several hand-maintained places that
 * never imported the enforcing code — the seed defaults, two divergent
 * read-only agent lists in prompts.ts, and the Settings → Agents UI. Each
 * drifted independently:
 *   - code-explorer was granted run_shell it could never use, so Settings
 *     showed an enabled toggle for a tool the agent correctly reported it
 *     did not have.
 *   - prompts.ts's second list named a non-existent agent ("explore") and
 *     omitted task-planner, so task-planner received the write-agent prompt
 *     while being dispatched with its write tools stripped.
 *   - the read-only kanban section instructed agents to call move_task and
 *     check_criteria, neither of which survives the strip.
 *
 * These tests are deliberately data-driven off the real seed defaults, so a
 * future edit that reintroduces any of those mismatches fails here rather than
 * silently misleading an agent at runtime.
 */

import { describe, it, expect } from "bun:test";
import {
	WRITE_TOOLS,
	READ_ONLY_AGENTS,
	READ_ONLY_WRITE_EXCEPTIONS,
	isToolStrippedAtDispatch,
	describeCapabilities,
	summarizeCapabilities,
} from "../../src/shared/agent-capabilities";
// Imported from agent-tool-defaults (not seed.ts) so this test never opens a DB
// connection — see that module's header.
import { getDefaultAgentTools } from "../../src/bun/db/agent-tool-defaults";

/** Tools each read-only agent is expected to keep despite being in WRITE_TOOLS. */
const EXPECTED_EXCEPTIONS: Record<string, string[]> = {
	"task-planner": ["create_task"],
};

describe("isToolStrippedAtDispatch", () => {
	it("strips write tools from read-only agents", () => {
		expect(isToolStrippedAtDispatch("code-explorer", "run_shell")).toBe(true);
		expect(isToolStrippedAtDispatch("code-explorer", "write_file")).toBe(true);
		expect(isToolStrippedAtDispatch("research-expert", "run_background")).toBe(true);
	});

	it("leaves read tools on read-only agents", () => {
		expect(isToolStrippedAtDispatch("code-explorer", "read_file")).toBe(false);
		expect(isToolStrippedAtDispatch("code-explorer", "git_show")).toBe(false);
		expect(isToolStrippedAtDispatch("code-explorer", "query_sqlite")).toBe(false);
	});

	it("never strips anything from a write agent", () => {
		for (const toolName of WRITE_TOOLS) {
			expect(isToolStrippedAtDispatch("backend-engineer", toolName)).toBe(false);
		}
	});

	it("honours per-agent exceptions", () => {
		expect(isToolStrippedAtDispatch("task-planner", "create_task")).toBe(false);
		// …but only for the excepted tool.
		expect(isToolStrippedAtDispatch("task-planner", "move_task")).toBe(true);
	});

	it("exception table matches expectations", () => {
		for (const [agent, tools] of Object.entries(EXPECTED_EXCEPTIONS)) {
			expect([...(READ_ONLY_WRITE_EXCEPTIONS[agent] ?? [])].sort()).toEqual(tools.sort());
		}
	});
});

describe("run_background counts as shell", () => {
	// run_background's own description is "Spawn a shell command as a background
	// process". Leaving it out of WRITE_TOOLS made the claim "read-only agents
	// cannot run commands" false — research-expert held it via the PROCESS family.
	it("is a write tool", () => {
		expect(WRITE_TOOLS.has("run_background")).toBe(true);
		expect(WRITE_TOOLS.has("kill_process")).toBe(true);
	});

	it("makes describeCapabilities report shell=false for read-only agents that had it", () => {
		const caps = describeCapabilities("research-expert", ["read_file", "run_background"]);
		expect(caps.shell).toBe(false);
		expect(caps.strippedTools).toContain("run_background");
	});
});

describe("seed defaults never grant a read-only agent an unusable write tool", () => {
	// A granted-but-stripped tool is exactly what Settings rendered as an enabled
	// toggle for a tool that could never run. Excepted tools are legitimate.
	for (const agentName of READ_ONLY_AGENTS) {
		it(`${agentName} has no dead write-tool grants`, () => {
			const granted = getDefaultAgentTools(agentName);
			expect(granted.length).toBeGreaterThan(0);
			const dead = granted.filter((t) => isToolStrippedAtDispatch(agentName, t));
			expect(dead).toEqual([]);
		});
	}

	it("code-explorer specifically has no shell", () => {
		const granted = getDefaultAgentTools("code-explorer");
		expect(granted).not.toContain("run_shell");
		expect(granted).not.toContain("run_background");
		expect(granted).not.toContain("execute_code");
	});

	it("code-explorer can inspect commits and databases without shell", () => {
		// The two capabilities whose absence previously forced an escalation to a
		// write agent for a purely read-only question.
		const granted = getDefaultAgentTools("code-explorer");
		expect(granted).toContain("git_show");
		expect(granted).toContain("query_sqlite");
	});

	it("task-planner keeps create_task", () => {
		expect(getDefaultAgentTools("task-planner")).toContain("create_task");
	});
});

describe("describeCapabilities / summarizeCapabilities", () => {
	it("reports a read-only agent as having no shell and no writes", () => {
		const caps = describeCapabilities("code-explorer", getDefaultAgentTools("code-explorer"));
		expect(caps.readOnly).toBe(true);
		expect(caps.shell).toBe(false);
		expect(caps.fileWrite).toBe(false);
		expect(caps.gitRead).toBe(true);
		expect(summarizeCapabilities(caps)).toContain("no shell");
		expect(summarizeCapabilities(caps)).toContain("no writes");
	});

	it("reports a write agent as full write", () => {
		const caps = describeCapabilities("backend-engineer", getDefaultAgentTools("backend-engineer"));
		expect(caps.readOnly).toBe(false);
		expect(caps.shell).toBe(true);
		expect(caps.fileWrite).toBe(true);
		expect(caps.strippedTools).toEqual([]);
		expect(summarizeCapabilities(caps)).toContain("full write");
	});

	it("summary of a read-only agent never claims shell or writes", () => {
		for (const agentName of READ_ONLY_AGENTS) {
			const summary = summarizeCapabilities(
				describeCapabilities(agentName, getDefaultAgentTools(agentName)),
			);
			expect(summary).not.toContain("full write");
			expect(summary).toContain("no shell");
		}
	});
});
