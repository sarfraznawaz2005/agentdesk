/**
 * kanban.test.ts
 *
 * Tests for kanban task CRUD operations (createKanbanTask, getKanbanTasks,
 * getKanbanTask, moveKanbanTask, updateKanbanTask, deleteKanbanTask).
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";
import { createTestDb } from "../helpers/db";

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-kanban" } },
}));

const { db: testDb, sqlite: testSqlite } = createTestDb();

mock.module("../../src/bun/db", () => ({ db: testDb }));
mock.module("../../src/bun/db/connection", () => ({ sqlite: testSqlite }));
mock.module("../../src/bun/db/audit", () => ({ logAudit: () => {} }));
mock.module("../../src/bun/engine-manager", () => ({
	broadcastToWebview: () => {},
	abortAllAgents: () => {},
	engines: new Map(),
	getOrCreateEngine: () => ({ getActiveConversationId: () => null }),
	registerAgentController: () => {},
	unregisterAgentController: () => {},
	getRunningAgentCount: () => 0,
	getRunningAgentNames: () => [],
}));
mock.module("../../src/bun/scheduler", () => ({
	eventBus: { emit: () => {} },
}));
mock.module("../../src/bun/notifications/desktop", () => ({
	sendDesktopNotification: async () => {},
}));

const {
	createKanbanTask,
	getKanbanTasks,
	getKanbanTask,
	moveKanbanTask,
	updateKanbanTask,
	deleteKanbanTask,
	getTaskActivity,
} = await import("../../src/bun/rpc/kanban");

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function seedProject(): Promise<string> {
	const id = crypto.randomUUID();
	testSqlite.exec(`INSERT INTO projects(id, name, workspace_path) VALUES ('${id}','kanban-test','/tmp/${id}')`);
	return id;
}

// -------------------------------------------------------------------------

describe("createKanbanTask", () => {
	it("inserts a task and returns success:true with an id", async () => {
		const projectId = await seedProject();
		const result = await createKanbanTask({ projectId, title: "My Task" });
		expect(result.success).toBe(true);
		expect(result.id).toBeTruthy();
	});

	it("defaults to column 'backlog'", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Backlog Task" });
		const task = await getKanbanTask(id);
		expect(task!.column).toBe("backlog");
	});

	it("respects the column parameter", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Working Task", column: "working" });
		const task = await getKanbanTask(id);
		expect(task!.column).toBe("working");
	});

	it("defaults priority to 'medium'", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Priority Task" });
		const task = await getKanbanTask(id);
		expect(task!.priority).toBe("medium");
	});

	it("stores blockedBy as a JSON string and retrieves it", async () => {
		const projectId = await seedProject();
		const blockedByJson = JSON.stringify(["task-a", "task-b"]);
		const { id } = await createKanbanTask({
			projectId,
			title: "Blocked Task",
			blockedBy: blockedByJson,
		});
		const task = await getKanbanTask(id);
		expect(task!.blockedBy).toBe(blockedByJson);
		const parsed = JSON.parse(task!.blockedBy ?? "[]");
		expect(parsed).toContain("task-a");
		expect(parsed).toContain("task-b");
	});
});

describe("getKanbanTasks", () => {
	it("returns all tasks for the specified project", async () => {
		const projectId = await seedProject();
		await createKanbanTask({ projectId, title: "Task 1" });
		await createKanbanTask({ projectId, title: "Task 2" });
		const tasks = await getKanbanTasks(projectId);
		expect(tasks.length).toBeGreaterThanOrEqual(2);
		const titles = tasks.map((t) => t.title);
		expect(titles).toContain("Task 1");
		expect(titles).toContain("Task 2");
	});

	it("does not return tasks from other projects", async () => {
		const p1 = await seedProject();
		const p2 = await seedProject();
		await createKanbanTask({ projectId: p1, title: "P1 Task" });
		await createKanbanTask({ projectId: p2, title: "P2 Task" });

		const p1Tasks = await getKanbanTasks(p1);
		expect(p1Tasks.map((t) => t.title)).toContain("P1 Task");
		expect(p1Tasks.map((t) => t.title)).not.toContain("P2 Task");
	});
});

describe("getKanbanTask", () => {
	it("returns null for a non-existent task id", async () => {
		const task = await getKanbanTask("does-not-exist");
		expect(task).toBeNull();
	});

	it("returns the correct task data", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({
			projectId,
			title: "Fetch Me",
			description: "A description",
			priority: "high",
		});
		const task = await getKanbanTask(id);
		expect(task!.title).toBe("Fetch Me");
		expect(task!.description).toBe("A description");
		expect(task!.priority).toBe("high");
		expect(task!.projectId).toBe(projectId);
	});
});

describe("moveKanbanTask", () => {
	it("updates the column of the task", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Move Me" });
		await moveKanbanTask(id, "working");
		const task = await getKanbanTask(id);
		expect(task!.column).toBe("working");
	});

	it("allows moving from working to review", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "To Review", column: "working" });
		await moveKanbanTask(id, "review");
		const task = await getKanbanTask(id);
		expect(task!.column).toBe("review");
	});

	it("allows moving to done column", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Complete", column: "review" });
		await moveKanbanTask(id, "done");
		const task = await getKanbanTask(id);
		expect(task!.column).toBe("done");
	});

	it("returns success:false for a non-existent task", async () => {
		const result = await moveKanbanTask("nonexistent", "working");
		expect(result.success).toBe(false);
	});

	it("is a no-op when already in the target column", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Already Working", column: "working" });
		const result = await moveKanbanTask(id, "working");
		expect(result.success).toBe(true);
		const task = await getKanbanTask(id);
		expect(task!.column).toBe("working");
	});

	it("logs a 'moved' activity entry", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Activity Test" });
		await moveKanbanTask(id, "working", undefined, "test-actor");
		const activity = await getTaskActivity(id);
		const moved = activity.find((a) => a.type === "moved");
		expect(moved).toBeDefined();
		const data = JSON.parse(moved!.data ?? "{}");
		expect(data.from).toBe("backlog");
		expect(data.to).toBe("working");
	});
});

describe("updateKanbanTask", () => {
	it("updates the task title", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Old Title" });
		await updateKanbanTask({ id, title: "New Title" });
		const task = await getKanbanTask(id);
		expect(task!.title).toBe("New Title");
	});

	it("updates the priority", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "PriorityTask" });
		await updateKanbanTask({ id, priority: "critical" });
		const task = await getKanbanTask(id);
		expect(task!.priority).toBe("critical");
	});

	it("updates the description", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Desc Task" });
		await updateKanbanTask({ id, description: "Updated description" });
		const task = await getKanbanTask(id);
		expect(task!.description).toBe("Updated description");
	});

	it("updates verificationStatus", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Verify Task" });
		await updateKanbanTask({ id, verificationStatus: "passed" });
		const task = await getKanbanTask(id);
		expect(task!.verificationStatus).toBe("passed");
	});

	it("can clear verificationStatus back to null", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Clear Verify" });
		await updateKanbanTask({ id, verificationStatus: "passed" });
		await updateKanbanTask({ id, verificationStatus: null });
		const task = await getKanbanTask(id);
		expect(task!.verificationStatus).toBeNull();
	});
});

describe("deleteKanbanTask", () => {
	it("removes the task from the database", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Delete Me" });
		await deleteKanbanTask(id);
		const task = await getKanbanTask(id);
		expect(task).toBeNull();
	});

	it("returns success:true", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Delete Me 2" });
		const result = await deleteKanbanTask(id);
		expect(result.success).toBe(true);
	});

	it("also deletes associated activity entries", async () => {
		const projectId = await seedProject();
		const { id } = await createKanbanTask({ projectId, title: "Cascade Delete" });
		await moveKanbanTask(id, "working");
		await deleteKanbanTask(id);
		const activity = await getTaskActivity(id);
		expect(activity).toHaveLength(0);
	});
});
