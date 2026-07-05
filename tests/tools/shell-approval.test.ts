/**
 * shell-approval.test.ts
 *
 * Tests for the shell approval gate in src/bun/agents/tools/shell.ts.
 *
 * This guards a real cross-project security bug found and fixed in this
 * session: `sessionAutoApproved` used to be a SINGLE GLOBAL boolean, so
 * clicking "Always allow" for one project's shell command silently disabled
 * the approval prompt for every OTHER project's agents too — bypassing their
 * own configured shellApprovalMode. It's now `sessionAutoApprovedProjects`,
 * a Set keyed by project id. The approval handler also used to fall back to
 * a buggy module-level "most recently touched engine" cache in
 * engine-manager.ts when resolving which project was asking; it now receives
 * the real project/conversation id directly (stamped onto the tool's args by
 * agent-loop.ts's run_shell wrapper — simulated here via the hidden
 * __projectId/__conversationId fields, since exercising the full agent-loop
 * wrapper would require mocking the entire AI SDK call chain).
 *
 * Runs real (harmless) shell commands via the actual execute() path — this is
 * intentionally closer to an integration test than a narrow unit test,
 * because the bug lived in the interaction between the approval gate and
 * per-project state, not in any single pure function.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { setShellApprovalHandler, resetShellAutoApprove, shellTools } from "../../src/bun/agents/tools/shell";

// Simulates agent-loop.ts's run_shell wrapper stamping the calling agent's
// real project/conversation id onto the args (hidden from the model, not
// part of the tool's public input schema).
function runShell(command: string, projectId: string, conversationId: string): Promise<string> {
	return shellTools.run_shell.tool.execute(
		{ command, __projectId: projectId, __conversationId: conversationId } as unknown as Parameters<
			typeof shellTools.run_shell.tool.execute
		>[0],
		{ abortSignal: undefined } as unknown as Parameters<typeof shellTools.run_shell.tool.execute>[1],
	) as Promise<string>;
}

beforeEach(() => {
	setShellApprovalHandler(null);
});

describe("shell approval gate — baseline behavior", () => {
	it("auto-allows when no approval handler is registered", async () => {
		const result = await runShell("echo no-handler", crypto.randomUUID(), crypto.randomUUID());
		const parsed = JSON.parse(result);
		expect(parsed.exitCode).toBe(0);
	});

	it("denies the command when the handler returns deny, without running it", async () => {
		setShellApprovalHandler(async () => "deny");
		const result = await runShell("echo should-not-run", crypto.randomUUID(), crypto.randomUUID());
		const parsed = JSON.parse(result);
		expect(parsed.exitCode).toBeNull();
		expect(parsed.stderr).toMatch(/denied/i);
	});

	it("passes the real project and conversation id through to the handler", async () => {
		const calls: Array<{ projectId: string; conversationId: string }> = [];
		setShellApprovalHandler(async (_cmd, _agentId, _agentName, projectId, conversationId) => {
			calls.push({ projectId, conversationId });
			return "allow";
		});
		const projectId = crypto.randomUUID();
		const conversationId = crypto.randomUUID();
		await runShell("echo hi", projectId, conversationId);
		expect(calls).toEqual([{ projectId, conversationId }]);
	});
});

describe("shell approval gate — per-project 'Always allow' isolation (the fixed bug)", () => {
	it("'Always allow' in project A does not suppress the prompt for project B", async () => {
		const calledForProject: string[] = [];
		setShellApprovalHandler(async (_cmd, _agentId, _agentName, projectId) => {
			calledForProject.push(projectId);
			return "always";
		});

		const projectA = crypto.randomUUID();
		const projectB = crypto.randomUUID();

		// First command in A: handler runs, returns "always" — A gets cached.
		await runShell("echo a1", projectA, crypto.randomUUID());
		expect(calledForProject).toEqual([projectA]);

		// Second command in A: handler must NOT run again (A is cached).
		await runShell("echo a2", projectA, crypto.randomUUID());
		expect(calledForProject).toEqual([projectA]);

		// First command in B: handler MUST run. Before the fix,
		// sessionAutoApproved was a single global boolean, so this would have
		// been silently auto-approved without ever prompting — bypassing
		// project B's own shellApprovalMode setting entirely.
		await runShell("echo b1", projectB, crypto.randomUUID());
		expect(calledForProject).toEqual([projectA, projectB]);

		// Second command in B now also cached, independently of A.
		await runShell("echo b2", projectB, crypto.randomUUID());
		expect(calledForProject).toEqual([projectA, projectB]);
	});

	it("resetShellAutoApprove(projectId) resets only that one project", async () => {
		const calledForProject: string[] = [];
		setShellApprovalHandler(async (_cmd, _agentId, _agentName, projectId) => {
			calledForProject.push(projectId);
			return "always";
		});

		const projectA = crypto.randomUUID();
		const projectB = crypto.randomUUID();

		await runShell("echo a1", projectA, crypto.randomUUID()); // caches A
		await runShell("echo b1", projectB, crypto.randomUUID()); // caches B
		expect(calledForProject).toEqual([projectA, projectB]);

		resetShellAutoApprove(projectA);

		await runShell("echo a2", projectA, crypto.randomUUID()); // A no longer cached
		expect(calledForProject).toEqual([projectA, projectB, projectA]);

		await runShell("echo b2", projectB, crypto.randomUUID()); // B still cached — handler skipped
		expect(calledForProject).toEqual([projectA, projectB, projectA]);
	});

	it("a fresh project (never seen 'always') always triggers the approval handler", async () => {
		const calledForProject: string[] = [];
		setShellApprovalHandler(async (_cmd, _agentId, _agentName, projectId) => {
			calledForProject.push(projectId);
			return "allow"; // note: NOT "always" — should be asked every time
		});

		const projectId = crypto.randomUUID();
		await runShell("echo 1", projectId, crypto.randomUUID());
		await runShell("echo 2", projectId, crypto.randomUUID());
		await runShell("echo 3", projectId, crypto.randomUUID());

		expect(calledForProject).toEqual([projectId, projectId, projectId]);
	});
});
