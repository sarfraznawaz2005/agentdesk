/**
 * kanban-enforcement.test.ts
 *
 * The kanban column state machine (backlog -> working -> review -> done) is
 * enforced entirely inside src/bun/agents/tools/kanban.ts's tool execute()
 * bodies — not by convention, not by DB constraint. tests/rpc/kanban.test.ts
 * and tests/db/kanban.test.ts only exercise the underlying CRUD/move RPCs
 * (plain column writes with no guard), so the actual kanban-flow-enforcement
 * invariants had no dedicated test:
 *
 *   - move_task cannot skip backlog -> review directly
 *   - move_task cannot move a task back out of "done"
 *   - move_task into "review" requires ALL acceptance criteria checked AND
 *     verify_implementation to have passed
 *   - verify_implementation auto-fails (and records verificationStatus
 *     "failed") if the model claims verdict=pass but any checklist item is
 *     false — this is the guard against a model self-reporting success
 *     dishonestly
 *   - submit_review only accepts a task actually sitting in "review"
 *   - check_criteria/check_all_criteria index validation and the per-task
 *     lock that prevents a lost update on concurrent calls
 *
 * The RPC layer (src/bun/rpc/kanban.ts) is mocked with a small in-memory
 * store so these tests exercise the real tool execute() functions without a
 * DB, matching the "prefer testing the underlying pure/mockable unit" rule
 * documented for this suite.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// In-memory fake for src/bun/rpc/kanban.ts
// ---------------------------------------------------------------------------

interface FakeTask {
	id: string;
	projectId: string;
	title: string;
	column: string;
	acceptanceCriteria: string | null;
	importantNotes: string | null;
	verificationStatus: string | null;
}

const store = new Map<string, FakeTask>();

function resetStore() {
	store.clear();
}

function seedTask(overrides: Partial<FakeTask> & { id: string }): FakeTask {
	const task: FakeTask = {
		projectId: "11111111-1111-1111-1111-111111111111",
		title: "Untitled",
		column: "backlog",
		acceptanceCriteria: null,
		importantNotes: null,
		verificationStatus: null,
		...overrides,
	};
	store.set(task.id, task);
	return task;
}

const notifiedReview: Array<{ projectId: string; taskId: string }> = [];
const autoCommitCalls: Array<{ projectId: string; taskId: string }> = [];

mock.module("../../src/bun/rpc/kanban", () => ({
	getKanbanTask: async (id: string) => {
		// yield a microtask so concurrent calls can genuinely interleave —
		// exercises the criteriaLocks race guard for real.
		await Promise.resolve();
		const t = store.get(id);
		return t ? { ...t } : null;
	},
	updateKanbanTask: async (params: { id: string; [k: string]: unknown }) => {
		await Promise.resolve();
		const t = store.get(params.id);
		if (!t) return { success: false };
		for (const [k, v] of Object.entries(params)) {
			if (k === "id" || v === undefined) continue;
			(t as unknown as Record<string, unknown>)[k] = v;
		}
		return { success: true };
	},
	moveKanbanTask: async (id: string, column: string) => {
		await Promise.resolve();
		const t = store.get(id);
		if (!t) return { success: false };
		t.column = column;
		return { success: true };
	},
}));

mock.module("../../src/bun/engine-manager", () => ({
	broadcastToWebview: () => {},
}));

mock.module("../../src/bun/agents/review-cycle", () => ({
	notifyTaskInReview: (projectId: string, taskId: string) => {
		notifiedReview.push({ projectId, taskId });
	},
	autoCommitTask: async (projectId: string, taskId: string) => {
		autoCommitCalls.push({ projectId, taskId });
	},
}));

const { createKanbanTools } = await import("../../src/bun/agents/tools/kanban");
const tools = createKanbanTools("test-agent");

async function moveTask(id: string, column: "backlog" | "working" | "review") {
	const raw = await tools.move_task.tool.execute(
		{ id, column } as never,
		{ abortSignal: undefined } as never,
	);
	return JSON.parse(raw as string);
}

async function verifyImpl(args: Record<string, unknown>) {
	const raw = await tools.verify_implementation.tool.execute(args as never, { abortSignal: undefined } as never);
	return JSON.parse(raw as string);
}

async function submitReview(taskId: string, verdict: "approved" | "changes_requested", summary = "looks good") {
	const raw = await tools.submit_review.tool.execute(
		{ task_id: taskId, verdict, summary } as never,
		{ abortSignal: undefined } as never,
	);
	return JSON.parse(raw as string);
}

async function checkCriteria(id: string, criteria_index: number | number[], checked = true) {
	const raw = await tools.check_criteria.tool.execute(
		{ id, criteria_index, checked } as never,
		{ abortSignal: undefined } as never,
	);
	return JSON.parse(raw as string);
}

const oneCriterion = JSON.stringify([{ text: "Does the thing", checked: true }]);

beforeEach(() => {
	resetStore();
	notifiedReview.length = 0;
	autoCommitCalls.length = 0;
});

// ---------------------------------------------------------------------------

describe("move_task — column transition guards", () => {
	it("rejects a direct backlog -> review skip", async () => {
		seedTask({ id: "t1", column: "backlog", acceptanceCriteria: oneCriterion, verificationStatus: "passed" });
		const result = await moveTask("t1", "review");
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/working.*first/i);
		expect(store.get("t1")!.column).toBe("backlog");
	});

	it("blocks moving review -> working -> ... out of done entirely", async () => {
		seedTask({ id: "t2", column: "done" });
		const result = await moveTask("t2", "working");
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/already marked done/i);
		expect(store.get("t2")!.column).toBe("done");
	});

	it("is a no-op when the task is already in the target column", async () => {
		seedTask({ id: "t3", column: "working" });
		const result = await moveTask("t3", "working");
		expect(result.success).toBe(true);
		expect(result.note).toMatch(/no move needed/i);
	});

	it("rejects working -> review when acceptance criteria are missing", async () => {
		seedTask({ id: "t4", column: "working", acceptanceCriteria: null });
		const result = await moveTask("t4", "review");
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/no acceptance criteria/i);
	});

	it("rejects working -> review when some criteria are unchecked", async () => {
		const unmet = JSON.stringify([
			{ text: "A", checked: true },
			{ text: "B", checked: false },
		]);
		seedTask({ id: "t5", column: "working", acceptanceCriteria: unmet, verificationStatus: "passed" });
		const result = await moveTask("t5", "review");
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/1 of 2 acceptance criteria/i);
		expect(result.error).toMatch(/- B/);
	});

	it("rejects working -> review when criteria are met but verify_implementation hasn't passed", async () => {
		seedTask({ id: "t6", column: "working", acceptanceCriteria: oneCriterion, verificationStatus: null });
		const result = await moveTask("t6", "review");
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/verify_implementation first/i);
	});

	it("allows working -> review once criteria are met and verification passed", async () => {
		seedTask({ id: "t7", column: "working", acceptanceCriteria: oneCriterion, verificationStatus: "passed" });
		const result = await moveTask("t7", "review");
		expect(result.success).toBe(true);
		expect(store.get("t7")!.column).toBe("review");
		expect(notifiedReview).toEqual([{ projectId: "11111111-1111-1111-1111-111111111111", taskId: "t7" }]);
	});

	it("allows review -> working (sent back for fixes) and resets verificationStatus", async () => {
		seedTask({ id: "t8", column: "review", verificationStatus: "passed" });
		const result = await moveTask("t8", "working");
		expect(result.success).toBe(true);
		expect(store.get("t8")!.column).toBe("working");
		expect(store.get("t8")!.verificationStatus).toBeNull();
	});

	it("allows working -> backlog (agent gives up) and resets verificationStatus", async () => {
		seedTask({ id: "t9", column: "working", verificationStatus: "passed" });
		const result = await moveTask("t9", "backlog");
		expect(result.success).toBe(true);
		expect(store.get("t9")!.verificationStatus).toBeNull();
	});

	it("returns success:false for a nonexistent task without throwing", async () => {
		const result = await moveTask("does-not-exist", "working");
		// The key guarantee under test: a missing task is reported, not thrown.
		expect(result.success).toBe(false);
	});
});

describe("verify_implementation — checklist gate", () => {
	const passingChecklist = {
		all_acceptance_criteria_met: true,
		ui_reflects_logic: true,
		logic_supports_ui: true,
		no_lsp_errors: true,
		feature_is_user_accessible: true,
	};

	it("verdict=fail records verificationStatus 'failed' and returns the issues", async () => {
		seedTask({ id: "v1", column: "working" });
		const result = await verifyImpl({
			task_id: "v1",
			verdict: "fail",
			files_changed: ["a.ts"],
			summary: "wip",
			checklist: passingChecklist,
			issues: ["still broken"],
		});
		expect(result.verdict).toBe("fail");
		expect(result.issues).toEqual(["still broken"]);
		expect(store.get("v1")!.verificationStatus).toBe("failed");
	});

	it("verdict=pass with any false checklist item is REJECTED even though the model claimed pass", async () => {
		seedTask({ id: "v2", column: "working" });
		const result = await verifyImpl({
			task_id: "v2",
			verdict: "pass",
			files_changed: ["a.ts"],
			summary: "done",
			checklist: { ...passingChecklist, no_lsp_errors: false },
		});
		expect(result.verdict).toBe("fail");
		expect(result.issues).toContain("LSP errors remain — including any pre-existing ones you noticed but didn't fix");
		// The dishonest "pass" claim must not be trusted — status flips to failed.
		expect(store.get("v2")!.verificationStatus).toBe("failed");
	});

	it("verdict=pass with a fully honest checklist passes, stores the report, and auto-moves to review", async () => {
		seedTask({ id: "v3", column: "working" });
		const result = await verifyImpl({
			task_id: "v3",
			verdict: "pass",
			files_changed: ["a.ts", "b.ts"],
			summary: "implemented the thing",
			checklist: passingChecklist,
		});
		expect(result.verdict).toBe("pass");
		const task = store.get("v3")!;
		expect(task.verificationStatus).toBe("passed");
		expect(task.column).toBe("review");
		expect(task.importantNotes).toMatch(/Completion Report/);
		expect(autoCommitCalls).toEqual([{ projectId: "11111111-1111-1111-1111-111111111111", taskId: "v3" }]);
		expect(notifiedReview).toEqual([{ projectId: "11111111-1111-1111-1111-111111111111", taskId: "v3" }]);
	});
});

describe("submit_review — only the code-reviewer's designated path into done", () => {
	it("rejects a task that isn't currently in the review column", async () => {
		seedTask({ id: "r1", column: "working" });
		const result = await submitReview("r1", "approved");
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not "review"/);
		expect(store.get("r1")!.column).toBe("working");
	});

	it("approved verdict moves the task to done and appends the review note", async () => {
		seedTask({ id: "r2", column: "review" });
		const result = await submitReview("r2", "approved", "all good");
		expect(result.success).toBe(true);
		const task = store.get("r2")!;
		expect(task.column).toBe("done");
		expect(task.importantNotes).toMatch(/APPROVED.*all good/s);
	});

	it("changes_requested sends the task back to working, not done", async () => {
		seedTask({ id: "r3", column: "review" });
		const result = await submitReview("r3", "changes_requested", "fix the null check");
		expect(result.success).toBe(true);
		const task = store.get("r3")!;
		expect(task.column).toBe("working");
		expect(task.importantNotes).toMatch(/CHANGES REQUESTED.*fix the null check/s);
	});
});

describe("check_criteria — index validation and the concurrent-call lock", () => {
	it("rejects an out-of-range index with the valid range in the message", async () => {
		seedTask({ id: "c1", acceptanceCriteria: JSON.stringify([{ text: "only one", checked: false }]) });
		const result = await checkCriteria("c1", 5);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/out of range/i);
		expect(result.error).toMatch(/0 to 0/);
	});

	it("marks multiple indices in a single call", async () => {
		seedTask({
			id: "c2",
			acceptanceCriteria: JSON.stringify([
				{ text: "A", checked: false },
				{ text: "B", checked: false },
				{ text: "C", checked: false },
			]),
		});
		await checkCriteria("c2", [0, 2], true);
		const criteria = JSON.parse(store.get("c2")!.acceptanceCriteria!);
		expect(criteria[0].checked).toBe(true);
		expect(criteria[1].checked).toBe(false);
		expect(criteria[2].checked).toBe(true);
	});

	it("serializes two concurrent calls on the same task so neither update is lost", async () => {
		seedTask({
			id: "c3",
			acceptanceCriteria: JSON.stringify([
				{ text: "A", checked: false },
				{ text: "B", checked: false },
			]),
		});
		// Fired concurrently — without the per-task lock, both would read the
		// same pre-write state and the second write would clobber the first.
		await Promise.all([checkCriteria("c3", 0, true), checkCriteria("c3", 1, true)]);
		const criteria = JSON.parse(store.get("c3")!.acceptanceCriteria!);
		expect(criteria[0].checked).toBe(true);
		expect(criteria[1].checked).toBe(true);
	});

	it("check_all_criteria marks every criterion checked", async () => {
		seedTask({
			id: "c4",
			acceptanceCriteria: JSON.stringify([
				{ text: "A", checked: false },
				{ text: "B", checked: false },
			]),
		});
		const raw = await tools.check_all_criteria.tool.execute({ id: "c4" } as never, { abortSignal: undefined } as never);
		const result = JSON.parse(raw as string);
		expect(result.success).toBe(true);
		expect(result.checked).toBe(2);
		const criteria = JSON.parse(store.get("c4")!.acceptanceCriteria!);
		expect(criteria.every((c: { checked: boolean }) => c.checked)).toBe(true);
	});

	it("check_all_criteria errors when the task has no criteria at all", async () => {
		seedTask({ id: "c5", acceptanceCriteria: null });
		const raw = await tools.check_all_criteria.tool.execute({ id: "c5" } as never, { abortSignal: undefined } as never);
		const result = JSON.parse(raw as string);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/no acceptance criteria/i);
	});
});
