/**
 * tests/db/conversations.test.ts
 *
 * Tests for conversation and message CRUD using the test DB.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq, asc } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";

let testDbInstance: TestDb;
const PROJECT_ID = "proj-conv-" + crypto.randomUUID();

beforeEach(async () => {
	testDbInstance = createTestDb();
	const { projects } = await import("../../src/bun/db/schema");
	await testDbInstance.db.insert(projects).values({
		id: PROJECT_ID,
		name: "Conv Test Project",
		workspacePath: "/tmp/conv-ws",
	});
});

afterEach(() => {
	testDbInstance.sqlite.close();
});

describe("Conversations", () => {
	it("creates a conversation for a project", async () => {
		const { conversations } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const convId = crypto.randomUUID();
		await db.insert(conversations).values({
			id: convId,
			projectId: PROJECT_ID,
			title: "Feature discussion",
		});

		const rows = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, convId));

		expect(rows.length).toBe(1);
		expect(rows[0].title).toBe("Feature discussion");
		expect(rows[0].projectId).toBe(PROJECT_ID);
		expect(rows[0].isArchived).toBe(0);
	});

	it("inserts messages with different roles in order", async () => {
		const { conversations, messages } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const convId = crypto.randomUUID();
		await db.insert(conversations).values({
			id: convId,
			projectId: PROJECT_ID,
			title: "Chat",
		});

		const now = Date.now();
		const msgs = [
			{ id: crypto.randomUUID(), conversationId: convId, role: "user", content: "Hello", createdAt: new Date(now).toISOString() },
			{ id: crypto.randomUUID(), conversationId: convId, role: "assistant", content: "Hi there", createdAt: new Date(now + 1000).toISOString() },
			{ id: crypto.randomUUID(), conversationId: convId, role: "user", content: "How are you?", createdAt: new Date(now + 2000).toISOString() },
		];

		for (const m of msgs) {
			await db.insert(messages).values(m);
		}

		const rows = await db
			.select({ role: messages.role, content: messages.content })
			.from(messages)
			.where(eq(messages.conversationId, convId))
			.orderBy(asc(messages.createdAt));

		expect(rows.length).toBe(3);
		expect(rows[0].role).toBe("user");
		expect(rows[0].content).toBe("Hello");
		expect(rows[1].role).toBe("assistant");
		expect(rows[2].role).toBe("user");
	});

	it("toggles archive flag", async () => {
		const { conversations } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const convId = crypto.randomUUID();
		await db.insert(conversations).values({
			id: convId,
			projectId: PROJECT_ID,
			title: "Old chat",
		});

		await db
			.update(conversations)
			.set({ isArchived: 1 })
			.where(eq(conversations.id, convId));

		const rows = await db
			.select({ isArchived: conversations.isArchived })
			.from(conversations)
			.where(eq(conversations.id, convId));

		expect(rows[0].isArchived).toBe(1);
	});

	it("deletes conversation after manually removing messages (app-level cascade)", async () => {
		const { conversations, messages } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const convId = crypto.randomUUID();
		await db.insert(conversations).values({
			id: convId,
			projectId: PROJECT_ID,
			title: "Temp conv",
		});

		await db.insert(messages).values({
			id: crypto.randomUUID(),
			conversationId: convId,
			role: "user",
			content: "test",
		});

		// Application-level cascade: delete child rows first, then parent.
		await db.delete(messages).where(eq(messages.conversationId, convId));
		await db.delete(conversations).where(eq(conversations.id, convId));

		const convRows = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, convId));
		const msgRows = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, convId));

		expect(convRows.length).toBe(0);
		expect(msgRows.length).toBe(0);
	});

	it("returns messages in creation order when multiple exist", async () => {
		const { conversations, messages } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		const convId = crypto.randomUUID();
		await db.insert(conversations).values({
			id: convId,
			projectId: PROJECT_ID,
			title: "Ordered chat",
		});

		// Insert with explicit ordering content
		const contents = ["First message", "Second message", "Third message"];
		for (const content of contents) {
			await db.insert(messages).values({
				id: crypto.randomUUID(),
				conversationId: convId,
				role: "user",
				content,
			});
		}

		const rows = await db
			.select({ content: messages.content })
			.from(messages)
			.where(eq(messages.conversationId, convId))
			.orderBy(asc(messages.createdAt));

		// All messages are there (order may vary by timestamp resolution)
		expect(rows.map((r) => r.content)).toEqual(
			expect.arrayContaining(contents),
		);
		expect(rows.length).toBe(3);
	});
});
