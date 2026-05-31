/**
 * tests/db/kanban.test.ts
 *
 * Tests for kanban task CRUD and column transitions using the test DB.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";

let testDbInstance: TestDb;

// A project to attach tasks to
const PROJECT_A_ID = "proj-a-" + crypto.randomUUID();
const PROJECT_B_ID = "proj-b-" + crypto.randomUUID();

beforeEach(async () => {
	testDbInstance = createTestDb();
	const { projects } = await import("../../src/bun/db/schema");
	const { db } = testDbInstance;

	// Seed two projects
	await db.insert(projects).values([
		{ id: PROJECT_A_ID, name: "Project A", workspacePath: "/tmp/ws-a" },
		{ id: PROJECT_B_ID, name: "Project B", workspacePath: "/tmp/ws-b" },
	]);
});

afterEach(() => {
	testDbInstance.sqlite.close();
});

function makeTask(projectId: string, overrides: Partial<{
	id: string;
	title: string;
	column: string;
	priority: string;
	blockedBy: string;
}> = {}) {
	return {
		id: crypto.randomUUID(),
		projectId,
		title: "Sample task",
		column: "backlog",
		priority: "medium",
		position: 0,
		reviewRounds: 0,
		...overrides,
	};
}

describe("Kanban task CRUD", () => {
	it("inserts a task in backlog and reads it back", async () => {
		const { kanbanTasks } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const task = makeTask(PROJECT_A_ID, { title: "Implement login" });
		await db.insert(kanbanTasks).values(task);

		const rows = await db
			.select()
			.from(kanbanTasks)
			.where(eq(kanbanTasks.id, task.id));

		expect(rows.length).toBe(1);
		expect(rows[0].title).toBe("Implement login");
		expect(rows[0].column).toBe("backlog");
	});

	it("transitions task through all columns: backlog → working → review → done", async () => {
		const { kanbanTasks } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const task = makeTask(PROJECT_A_ID);
		await db.insert(kanbanTasks).values(task);

		for (const col of ["working", "review", "done"]) {
			await db
				.update(kanbanTasks)
				.set({ column: col })
				.where(eq(kanbanTasks.id, task.id));

			const rows = await db
				.select({ column: kanbanTasks.column })
				.from(kanbanTasks)
				.where(eq(kanbanTasks.id, task.id));

			expect(rows[0].column).toBe(col);
		}
	});

	it("stores and retrieves dependency IDs as a JSON string", async () => {
		const { kanbanTasks } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const deps = ["task-001", "task-002"];
		const task = makeTask(PROJECT_A_ID, { blockedBy: JSON.stringify(deps) });
		await db.insert(kanbanTasks).values(task);

		const rows = await db
			.select({ blockedBy: kanbanTasks.blockedBy })
			.from(kanbanTasks)
			.where(eq(kanbanTasks.id, task.id));

		const parsed = JSON.parse(rows[0].blockedBy!);
		expect(parsed).toEqual(deps);
	});

	it("deletes a task and removes it from DB", async () => {
		const { kanbanTasks } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const task = makeTask(PROJECT_A_ID);
		await db.insert(kanbanTasks).values(task);
		await db.delete(kanbanTasks).where(eq(kanbanTasks.id, task.id));

		const rows = await db
			.select()
			.from(kanbanTasks)
			.where(eq(kanbanTasks.id, task.id));
		expect(rows.length).toBe(0);
	});

	it("tasks for project A do not appear in project B queries", async () => {
		const { kanbanTasks } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const taskA = makeTask(PROJECT_A_ID, { title: "Task for A" });
		const taskB = makeTask(PROJECT_B_ID, { title: "Task for B" });
		await db.insert(kanbanTasks).values(taskA);
		await db.insert(kanbanTasks).values(taskB);

		const rowsA = await db
			.select({ title: kanbanTasks.title })
			.from(kanbanTasks)
			.where(eq(kanbanTasks.projectId, PROJECT_A_ID));

		const rowsB = await db
			.select({ title: kanbanTasks.title })
			.from(kanbanTasks)
			.where(eq(kanbanTasks.projectId, PROJECT_B_ID));

		expect(rowsA.map((r) => r.title)).toContain("Task for A");
		expect(rowsA.map((r) => r.title)).not.toContain("Task for B");
		expect(rowsB.map((r) => r.title)).toContain("Task for B");
		expect(rowsB.map((r) => r.title)).not.toContain("Task for A");
	});

	it("updates task priority and description", async () => {
		const { kanbanTasks } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const task = makeTask(PROJECT_A_ID, { title: "Refactor auth" });
		await db.insert(kanbanTasks).values(task);

		await db
			.update(kanbanTasks)
			.set({ priority: "high", description: "Needs urgent refactoring" })
			.where(eq(kanbanTasks.id, task.id));

		const rows = await db
			.select({ priority: kanbanTasks.priority, description: kanbanTasks.description })
			.from(kanbanTasks)
			.where(eq(kanbanTasks.id, task.id));

		expect(rows[0].priority).toBe("high");
		expect(rows[0].description).toBe("Needs urgent refactoring");
	});
});
