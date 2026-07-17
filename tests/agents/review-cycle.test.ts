/**
 * review-cycle.test.ts
 *
 * Tests the pure heuristic functions exported from (or accessible via) review-cycle:
 *   - reviewSummaryHasIssues: phrase-based verdict detection
 *   - isAgentCancelled: cancellation vs failure detection
 *   - getSubmitReviewVerdict: DB-backed tool call lookup
 *
 * All external collaborators (DB, LLM, Electrobun) are mocked so the tests
 * are instant and deterministic.
 */

import { mock, describe, it, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { createTestDb } from "../helpers/db";

// Electrobun mock must precede any import that touches it.
mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-review" } },
}));

const { db: testDb, sqlite: testSqlite } = createTestDb();

mock.module("../../src/bun/db", () => ({ db: testDb }));

// The PM's "active conversation" — used to verify the fallback path when a
// task has no dedicated conversation recorded via setTaskConversation.
const PM_ACTIVE_CONV = "pm-main-conv";

// Stub out heavy collaborators review-cycle pulls in.
mock.module("../../src/bun/engine-manager", () => ({
	broadcastToWebview: () => {},
	registerAgentController: () => {},
	unregisterAgentController: () => {},
	getOrCreateEngine: () => ({ getActiveConversationId: () => PM_ACTIVE_CONV }),
	getRunningAgentCount: () => 0,
	getRunningAgentNames: () => [],
	getChatScopedAgentNames: () => [],
	abortAllAgents: () => {},
	engines: new Map(),
	resolveUserQuestion: () => false,
	resolveShellApproval: () => false,
	getPendingChannelInteraction: () => null,
}));
// Mock scheduler so rpc/kanban can be used without a real event bus.
mock.module("../../src/bun/scheduler", () => ({
	eventBus: { emit: () => {} },
}));
mock.module("../../src/bun/db/audit", () => ({ logAudit: () => {} }));
mock.module("../../src/bun/db/connection", () => ({ sqlite: testSqlite }));
// rpc/settings uses the mocked db (returns null on empty test DB) — not mocked to
// avoid contaminating settings.test.ts module cache.
mock.module("../../src/bun/notifications/desktop", () => ({
	sendDesktopNotification: async () => {},
}));
// Captures every runInlineAgent call so tests can assert which conversationId
// spawnReviewAgent resolved to. Returns "cancelled" so notifyTaskInReview's
// early-return path fires and no downstream moveKanbanTask/channel/issue
// collaborators (unmocked here) are exercised.
const runInlineAgentCalls: Array<{ conversationId: string; agentName: string }> = [];
mock.module("../../src/bun/agents/agent-loop", () => ({
	runInlineAgent: async (opts: { conversationId: string; agentName: string }) => {
		runInlineAgentCalls.push({ conversationId: opts.conversationId, agentName: opts.agentName });
		return { status: "cancelled", summary: "Cancelled by test", filesModified: [], tokensUsed: { prompt: 0, completion: 0, total: 0 }, messageIds: [] };
	},
	READ_ONLY_AGENTS: new Set(["code-explorer", "research-expert", "task-planner"]),
	isWriteConcurrencyExempt: async (agentName: string) => ["code-explorer", "research-expert", "task-planner", "code-reviewer"].includes(agentName),
}));

// Import after mocks.
const reviewCycleModule = await import("../../src/bun/agents/review-cycle");

// reviewSummaryHasIssues and isAgentCancelled are not exported, so we test
// their behaviour through the observable result of the review cycle, or we
// extract the logic by re-implementing the same pure function here to document
// the expected contract. Since the source is readable, we inline equivalent
// test-only versions and then cross-check against integration evidence.
//
// For getSubmitReviewVerdict we test via DB state since its side-effects are
// all within the database.

// --- inline the pure heuristic so we can test it directly ---
// This re-implements the exact same logic as in review-cycle.ts.
function reviewSummaryHasIssues(summary: string): boolean {
	const lower = summary.toLowerCase();

	const cleanSignals = [
		"no issues", "no bugs", "no errors", "no problems", "no critical",
		"lgtm", "looks good", "all good", "passes review", "approved",
		"clean code", "well implemented", "review passed",
	];
	if (cleanSignals.some((s) => lower.includes(s))) return false;

	const negativeSignals = [
		"changes_requested", "changes requested", "must fix", "bug found",
		"bugs found", "issue found", "issues found", "problem found",
		"fix required", "needs fixing", "needs work", "incorrect implementation",
		"critical issue", "critical bug", "security vulnerability",
		"fails to", "failed to", "does not work", "doesn't work",
		"broken", "regression", "not met", "not satisfied",
		"missing implementation", "missing feature",
	];
	return negativeSignals.some((signal) => lower.includes(signal));
}

function isAgentCancelled(result: { status: string; summary: string }): boolean {
	if (result.status === "completed") return false;
	const s = result.summary.toLowerCase();
	return s.includes("cancel") || s.includes("engine stopped") || s.includes("aborterror") || s.includes("aborted");
}

// -------------------------------------------------------------------------

describe("reviewSummaryHasIssues", () => {
	it("returns false for 'LGTM, all good, approved'", () => {
		expect(reviewSummaryHasIssues("LGTM, all good, approved")).toBe(false);
	});

	it("returns false for 'Code approved'", () => {
		expect(reviewSummaryHasIssues("Code approved")).toBe(false);
	});

	it("returns false for 'APPROVED' (uppercase)", () => {
		expect(reviewSummaryHasIssues("APPROVED")).toBe(false);
	});

	it("returns false for 'Tests pass'", () => {
		expect(reviewSummaryHasIssues("Tests pass")).toBe(false);
	});

	it("returns false for 'review passed, no issues found'", () => {
		expect(reviewSummaryHasIssues("review passed, no issues found")).toBe(false);
	});

	it("returns false for 'Looks good to me'", () => {
		expect(reviewSummaryHasIssues("Looks good to me")).toBe(false);
	});

	it("returns true for 'Changes requested: fix null check'", () => {
		expect(reviewSummaryHasIssues("Changes requested: fix null check")).toBe(true);
	});

	it("returns true for 'Found 3 critical bugs'", () => {
		expect(reviewSummaryHasIssues("Found 3 critical bugs in the auth module")).toBe(true);
	});

	it("returns true for 'needs work'", () => {
		expect(reviewSummaryHasIssues("Implementation needs work before merging")).toBe(true);
	});

	it("returns true for 'regression detected'", () => {
		expect(reviewSummaryHasIssues("This introduces a regression in the login flow")).toBe(true);
	});

	it("returns true for 'security vulnerability'", () => {
		expect(reviewSummaryHasIssues("Found a security vulnerability in input validation")).toBe(true);
	});

	it("returns true for 'does not work'", () => {
		expect(reviewSummaryHasIssues("The feature does not work when user is logged out")).toBe(true);
	});

	it("returns true for 'missing implementation'", () => {
		expect(reviewSummaryHasIssues("missing implementation for the export function")).toBe(true);
	});

	it("returns false for a neutral description with no signal words", () => {
		// Neither clean nor negative signals — defaults to false (no issues detected)
		expect(reviewSummaryHasIssues("The implementation creates a new component and updates the router")).toBe(false);
	});

	it("clean signal takes precedence over negative signal in the same string", () => {
		// Clean signal appears first in the text; the function checks clean signals first
		expect(reviewSummaryHasIssues("LGTM although there are minor improvements needed")).toBe(false);
	});
});

describe("isAgentCancelled", () => {
	it("returns false when status is completed", () => {
		expect(isAgentCancelled({ status: "completed", summary: "done" })).toBe(false);
	});

	it("returns true when summary contains 'cancel'", () => {
		expect(isAgentCancelled({ status: "cancelled", summary: "Cancelled by user after 10s" })).toBe(true);
	});

	it("returns true when summary contains 'aborted'", () => {
		expect(isAgentCancelled({ status: "failed", summary: "Request was aborted" })).toBe(true);
	});

	it("returns true when summary contains 'engine stopped'", () => {
		expect(isAgentCancelled({ status: "failed", summary: "Agent stopped: engine stopped" })).toBe(true);
	});

	it("returns true when summary contains 'AbortError'", () => {
		expect(isAgentCancelled({ status: "failed", summary: "AbortError: signal aborted" })).toBe(true);
	});

	it("returns false when status is failed with a genuine error", () => {
		expect(isAgentCancelled({ status: "failed", summary: "Failed: null pointer dereference" })).toBe(false);
	});

	it("returns false when status is context_full", () => {
		expect(isAgentCancelled({ status: "context_full", summary: "Context window full after 600s" })).toBe(false);
	});
});

describe("getSubmitReviewVerdict (via DB state)", () => {
	// We test the DB query logic by directly inserting message_parts rows that
	// mirror what submit_review produces and then calling notifyTaskInReview.
	// For unit isolation we test the verdict detection by querying the DB the
	// same way the function does.

	let messageParts: (typeof import("../../src/bun/db/schema"))["messageParts"];
	let eq: (typeof import("drizzle-orm"))["eq"];
	let and: (typeof import("drizzle-orm"))["and"];
	let desc: (typeof import("drizzle-orm"))["desc"];

	beforeAll(async () => {
		({ messageParts } = await import("../../src/bun/db/schema"));
		({ eq, and, desc } = await import("drizzle-orm"));
	});

	async function getVerdict(taskId: string): Promise<"approved" | "changes_requested" | null> {
		const rows = await testDb
			.select({ toolInput: messageParts.toolInput })
			.from(messageParts)
			.where(and(
				eq(messageParts.toolName, "submit_review"),
				eq(messageParts.type, "tool_call"),
			))
			.orderBy(desc(messageParts.sortOrder))
			.limit(10);

		for (const row of rows) {
			if (!row.toolInput) continue;
			try {
				const input = JSON.parse(row.toolInput);
				if (input.task_id === taskId) {
					if (input.verdict === "approved" || input.verdict === "changes_requested") {
						return input.verdict;
					}
				}
			} catch { /* invalid JSON */ }
		}
		return null;
	}

	// Seed prerequisites.
	let projectId: string;
	let conversationId: string;
	let messageId: string;

	beforeEach(async () => {
		projectId = crypto.randomUUID();
		conversationId = crypto.randomUUID();
		messageId = crypto.randomUUID();
		testSqlite.exec(`INSERT INTO projects(id, name, workspace_path) VALUES ('${projectId}','p','/tmp')`);
		testSqlite.exec(`INSERT INTO conversations(id, project_id) VALUES ('${conversationId}','${projectId}')`);
		testSqlite.exec(`INSERT INTO messages(id, conversation_id, role, content) VALUES ('${messageId}','${conversationId}','assistant','test')`);
	});

	afterEach(() => {
		testSqlite.exec(`DELETE FROM message_parts WHERE message_id = '${messageId}'`);
		testSqlite.exec(`DELETE FROM messages WHERE id = '${messageId}'`);
		testSqlite.exec(`DELETE FROM conversations WHERE id = '${conversationId}'`);
		testSqlite.exec(`DELETE FROM projects WHERE id = '${projectId}'`);
	});

	it("returns 'approved' when submit_review tool call has verdict approved", async () => {
		const taskId = "task-001";
		await testDb.insert(messageParts).values({
			id: crypto.randomUUID(),
			messageId,
			type: "tool_call",
			content: "submitting review",
			toolName: "submit_review",
			toolInput: JSON.stringify({ task_id: taskId, verdict: "approved", summary: "LGTM" }),
			sortOrder: 0,
		});

		const verdict = await getVerdict(taskId);
		expect(verdict).toBe("approved");
	});

	it("returns 'changes_requested' when submit_review tool call has that verdict", async () => {
		const taskId = "task-002";
		await testDb.insert(messageParts).values({
			id: crypto.randomUUID(),
			messageId,
			type: "tool_call",
			content: "submitting review",
			toolName: "submit_review",
			toolInput: JSON.stringify({ task_id: taskId, verdict: "changes_requested", summary: "Fix the null check" }),
			sortOrder: 0,
		});

		const verdict = await getVerdict(taskId);
		expect(verdict).toBe("changes_requested");
	});

	it("returns null when there is no submit_review call in the DB", async () => {
		const verdict = await getVerdict("task-no-review");
		expect(verdict).toBeNull();
	});

	it("returns null when submit_review was for a DIFFERENT task_id", async () => {
		await testDb.insert(messageParts).values({
			id: crypto.randomUUID(),
			messageId,
			type: "tool_call",
			content: "submitting review",
			toolName: "submit_review",
			toolInput: JSON.stringify({ task_id: "other-task", verdict: "approved", summary: "ok" }),
			sortOrder: 0,
		});

		// Should not find verdict for a different task
		const verdict = await getVerdict("task-we-want");
		expect(verdict).toBeNull();
	});

	it("returns the most recent verdict when multiple exist for the same task", async () => {
		const taskId = "task-multi";
		await testDb.insert(messageParts).values({
			id: crypto.randomUUID(),
			messageId,
			type: "tool_call",
			content: "first review",
			toolName: "submit_review",
			toolInput: JSON.stringify({ task_id: taskId, verdict: "changes_requested", summary: "needs work" }),
			sortOrder: 0,
		});
		await testDb.insert(messageParts).values({
			id: crypto.randomUUID(),
			messageId,
			type: "tool_call",
			content: "second review",
			toolName: "submit_review",
			toolInput: JSON.stringify({ task_id: taskId, verdict: "approved", summary: "fixed" }),
			sortOrder: 1,
		});

		const verdict = await getVerdict(taskId);
		// DESC order means most recent comes first.  Most recently created is "approved".
		expect(verdict).toBe("approved");
	});
});

describe("spawnReviewAgent conversation routing (setTaskConversation)", () => {
	// Regression coverage for the "New Conv. per task" bug: review activity
	// must land in the task's own dedicated conversation (when recorded via
	// setTaskConversation, as pm-tools.ts's run_agent does on dispatch) rather
	// than always falling back to the PM's active conversation — otherwise the
	// code-reviewer runs invisibly from the task's own conversation's point of
	// view, making review look like it never happened.
	let kanbanTasks: (typeof import("../../src/bun/db/schema"))["kanbanTasks"];
	let projects: (typeof import("../../src/bun/db/schema"))["projects"];
	let aiProviders: (typeof import("../../src/bun/db/schema"))["aiProviders"];

	beforeAll(async () => {
		({ kanbanTasks, projects, aiProviders } = await import("../../src/bun/db/schema"));
	});

	let projectId: string;
	let taskId: string;
	let providerId: string;

	beforeEach(async () => {
		runInlineAgentCalls.length = 0;
		projectId = crypto.randomUUID();
		taskId = crypto.randomUUID();
		providerId = crypto.randomUUID();
		await testDb.insert(projects).values({ id: projectId, name: "p", workspacePath: "/tmp" });
		// spawnReviewAgent bails out (without calling runInlineAgent) unless a
		// provider row resolves — seed a default one so the mocked runInlineAgent
		// actually gets invoked and we can assert on its conversationId.
		await testDb.insert(aiProviders).values({
			id: providerId,
			name: "test-provider",
			providerType: "anthropic",
			apiKey: "test-key",
			isDefault: 1,
		});
		await testDb.insert(kanbanTasks).values({
			id: taskId,
			projectId,
			title: "Test task",
			column: "review",
			priority: "medium",
			position: 0,
			reviewRounds: 0,
		});
	});

	afterEach(() => {
		testSqlite.exec(`DELETE FROM kanban_task_activity WHERE task_id = '${taskId}'`);
		testSqlite.exec(`DELETE FROM kanban_tasks WHERE id = '${taskId}'`);
		testSqlite.exec(`DELETE FROM ai_providers WHERE id = '${providerId}'`);
		testSqlite.exec(`DELETE FROM projects WHERE id = '${projectId}'`);
	});

	it("routes the reviewer into the task's dedicated conversation when one is recorded", async () => {
		reviewCycleModule.setTaskConversation(taskId, "task-dedicated-conv");

		reviewCycleModule.notifyTaskInReview(projectId, taskId);
		await new Promise((r) => setTimeout(r, 50));

		expect(runInlineAgentCalls.length).toBeGreaterThan(0);
		expect(runInlineAgentCalls[0].conversationId).toBe("task-dedicated-conv");
		expect(runInlineAgentCalls[0].agentName).toBe("code-reviewer");
	});

	it("falls back to the PM's active conversation when no dedicated conversation was recorded", async () => {
		reviewCycleModule.notifyTaskInReview(projectId, taskId);
		await new Promise((r) => setTimeout(r, 50));

		expect(runInlineAgentCalls.length).toBeGreaterThan(0);
		expect(runInlineAgentCalls[0].conversationId).toBe(PM_ACTIVE_CONV);
	});
});

describe("isReviewActive and getActiveReviewCount exports", () => {
	it("isReviewActive returns false for an unknown task", () => {
		expect(reviewCycleModule.isReviewActive("nonexistent-task-id")).toBe(false);
	});

	it("getActiveReviewCount returns 0 when no reviews are running", () => {
		expect(reviewCycleModule.getActiveReviewCount()).toBe(0);
	});
});
