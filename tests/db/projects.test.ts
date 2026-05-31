/**
 * tests/db/projects.test.ts
 *
 * Tests for project CRUD operations using the test DB directly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";

let testDbInstance: TestDb;

beforeEach(() => {
	testDbInstance = createTestDb();
});

afterEach(() => {
	testDbInstance.sqlite.close();
});

function makeProject(overrides: Partial<{
	id: string;
	name: string;
	description: string;
	workspacePath: string;
}> = {}) {
	return {
		id: crypto.randomUUID(),
		name: "Test Project",
		description: "A test project",
		workspacePath: "/tmp/test-workspace",
		...overrides,
	};
}

describe("Project CRUD", () => {
	it("inserts a project and reads it back with all fields", async () => {
		const { projects } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const projectData = makeProject({ name: "My App", description: "Cool app" });
		await db.insert(projects).values(projectData);

		const rows = await db
			.select()
			.from(projects)
			.where(eq(projects.id, projectData.id));

		expect(rows.length).toBe(1);
		expect(rows[0].name).toBe("My App");
		expect(rows[0].description).toBe("Cool app");
		expect(rows[0].workspacePath).toBe("/tmp/test-workspace");
		expect(rows[0].status).toBe("active");
	});

	it("updates workspace_path", async () => {
		const { projects } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const p = makeProject();
		await db.insert(projects).values(p);

		await db
			.update(projects)
			.set({ workspacePath: "/new/path" })
			.where(eq(projects.id, p.id));

		const rows = await db
			.select({ workspacePath: projects.workspacePath })
			.from(projects)
			.where(eq(projects.id, p.id));

		expect(rows[0].workspacePath).toBe("/new/path");
	});

	it("deletes a project", async () => {
		const { projects } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const p = makeProject();
		await db.insert(projects).values(p);

		await db.delete(projects).where(eq(projects.id, p.id));

		const rows = await db.select().from(projects).where(eq(projects.id, p.id));
		expect(rows.length).toBe(0);
	});

	it("deletes project after manually removing conversations and messages (app-level cascade)", async () => {
		const { projects, conversations, messages } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const p = makeProject();
		await db.insert(projects).values(p);

		const convId = crypto.randomUUID();
		await db.insert(conversations).values({
			id: convId,
			projectId: p.id,
			title: "Test conv",
		});

		await db.insert(messages).values({
			id: crypto.randomUUID(),
			conversationId: convId,
			role: "user",
			content: "Hello",
		});

		// Application-level cascade: delete deepest children first.
		await db.delete(messages).where(eq(messages.conversationId, convId));
		await db.delete(conversations).where(eq(conversations.id, convId));
		await db.delete(projects).where(eq(projects.id, p.id));

		const convRows = await db
			.select()
			.from(conversations)
			.where(eq(conversations.projectId, p.id));
		const projRows = await db
			.select()
			.from(projects)
			.where(eq(projects.id, p.id));

		expect(convRows.length).toBe(0);
		expect(projRows.length).toBe(0);
	});

	it("two projects do not share settings under their own keys", async () => {
		const { projects, settings } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const pA = makeProject({ name: "Project A" });
		const pB = makeProject({ name: "Project B" });
		await db.insert(projects).values(pA);
		await db.insert(projects).values(pB);

		// Insert project-scoped settings
		await db.insert(settings).values({
			id: crypto.randomUUID(),
			key: `project:${pA.id}:theme`,
			value: '"light"',
			category: "general",
		});
		await db.insert(settings).values({
			id: crypto.randomUUID(),
			key: `project:${pB.id}:theme`,
			value: '"dark"',
			category: "general",
		});

		const rowA = await db
			.select({ value: settings.value })
			.from(settings)
			.where(eq(settings.key, `project:${pA.id}:theme`));
		const rowB = await db
			.select({ value: settings.value })
			.from(settings)
			.where(eq(settings.key, `project:${pB.id}:theme`));

		expect(rowA[0].value).toBe('"light"');
		expect(rowB[0].value).toBe('"dark"');
	});

	it("lists all projects", async () => {
		const { projects } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const p1 = makeProject({ name: "Alpha" });
		const p2 = makeProject({ name: "Beta" });
		await db.insert(projects).values(p1);
		await db.insert(projects).values(p2);

		const all = await db.select({ name: projects.name }).from(projects);
		const names = all.map((r) => r.name);
		expect(names).toContain("Alpha");
		expect(names).toContain("Beta");
	});
});
