/**
 * conversations.test.ts
 *
 * Tests for conversation and message RPC handlers.
 * Uses an in-memory SQLite database for full isolation.
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../helpers/db";

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-conversations" } },
}));

const { db: testDb, sqlite: testSqlite } = createTestDb();

mock.module("../../src/bun/db", () => ({ db: testDb }));
mock.module("../../src/bun/db/connection", () => ({ sqlite: testSqlite }));
mock.module("../../src/bun/db/audit", () => ({ logAudit: () => {} }));
mock.module("../../src/bun/engine-manager", () => ({
	abortAllAgents: () => {},
	engines: new Map(),
	broadcastToWebview: () => {},
	getOrCreateEngine: () => ({ getActiveConversationId: () => null }),
	registerAgentController: () => {},
	unregisterAgentController: () => {},
	getRunningAgentCount: () => 0,
	getRunningAgentNames: () => [],
}));

const {
	createConversation,
	getConversations,
	getArchivedConversations,
	archiveConversation,
	restoreConversation,
	pinConversation,
	renameConversation,
	deleteConversation,
	getMessages,
} = await import("../../src/bun/rpc/conversations");

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function seedProject(): Promise<string> {
	const id = crypto.randomUUID();
	testSqlite.exec(`INSERT INTO projects(id, name, workspace_path) VALUES ('${id}','test-project','/tmp/${id}')`);
	return id;
}

// -------------------------------------------------------------------------

describe("createConversation", () => {
	it("creates a conversation and returns an id", async () => {
		const projectId = await seedProject();
		const result = await createConversation(projectId);
		expect(result.id).toBeTruthy();
		expect(result.title).toBe("New conversation");
		expect(result.reused).toBe(false);
	});

	it("reuses an empty 'New conversation' instead of creating a duplicate", async () => {
		const projectId = await seedProject();
		const first = await createConversation(projectId);
		const second = await createConversation(projectId);
		// The second call should reuse the first empty conversation.
		expect(second.id).toBe(first.id);
		expect(second.reused).toBe(true);
	});

	it("does NOT reuse when an explicit title is provided", async () => {
		const projectId = await seedProject();
		const first = await createConversation(projectId);
		const second = await createConversation(projectId, "Custom Title");
		expect(second.id).not.toBe(first.id);
		expect(second.reused).toBe(false);
		expect(second.title).toBe("Custom Title");
	});

	it("stores the projectId on the conversation", async () => {
		const projectId = await seedProject();
		const { id } = await createConversation(projectId);
		const { conversations } = await import("../../src/bun/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await testDb.select().from(conversations).where(eq(conversations.id, id));
		expect(rows[0].projectId).toBe(projectId);
	});
});

describe("getConversations", () => {
	it("returns only non-archived conversations for the project", async () => {
		const projectId = await seedProject();
		const { id: c1 } = await createConversation(projectId, "Active Conv");
		const { id: c2 } = await createConversation(projectId, "Archived Conv");
		await archiveConversation(c2);

		const list = await getConversations(projectId);
		const ids = list.map((c) => c.id);
		expect(ids).toContain(c1);
		expect(ids).not.toContain(c2);
	});

	it("returns conversations only for the specified project", async () => {
		const p1 = await seedProject();
		const p2 = await seedProject();
		const { id: c1 } = await createConversation(p1, "P1 Conv");
		const { id: c2 } = await createConversation(p2, "P2 Conv");

		const p1Convs = await getConversations(p1);
		expect(p1Convs.map((c) => c.id)).toContain(c1);
		expect(p1Convs.map((c) => c.id)).not.toContain(c2);
	});
});

describe("archiveConversation / restoreConversation", () => {
	it("archiveConversation sets isArchived to true", async () => {
		const projectId = await seedProject();
		const { id } = await createConversation(projectId, "Archive Me");
		await archiveConversation(id);
		const archived = await getArchivedConversations(projectId);
		expect(archived.map((c) => c.id)).toContain(id);
	});

	it("restoreConversation makes a conversation active again", async () => {
		const projectId = await seedProject();
		const { id } = await createConversation(projectId, "Restore Me");
		await archiveConversation(id);
		await restoreConversation(id);
		const active = await getConversations(projectId);
		expect(active.map((c) => c.id)).toContain(id);
	});
});

describe("pinConversation", () => {
	it("pins a conversation (isPinned = true)", async () => {
		const projectId = await seedProject();
		const { id } = await createConversation(projectId, "Pin Me");
		await pinConversation(id, true);

		const { conversations } = await import("../../src/bun/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await testDb.select({ isPinned: conversations.isPinned }).from(conversations).where(eq(conversations.id, id));
		expect(rows[0].isPinned).toBe(1);
	});

	it("unpins a conversation (isPinned = false)", async () => {
		const projectId = await seedProject();
		const { id } = await createConversation(projectId, "Unpin Me");
		await pinConversation(id, true);
		await pinConversation(id, false);

		const { conversations } = await import("../../src/bun/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await testDb.select({ isPinned: conversations.isPinned }).from(conversations).where(eq(conversations.id, id));
		expect(rows[0].isPinned).toBe(0);
	});
});

describe("renameConversation", () => {
	it("updates the conversation title", async () => {
		const projectId = await seedProject();
		const { id } = await createConversation(projectId, "Old Title");
		await renameConversation(id, "New Title");

		const { conversations } = await import("../../src/bun/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await testDb.select({ title: conversations.title }).from(conversations).where(eq(conversations.id, id));
		expect(rows[0].title).toBe("New Title");
	});
});

describe("deleteConversation", () => {
	it("removes the conversation from the database", async () => {
		const projectId = await seedProject();
		const { id } = await createConversation(projectId, "Delete Me");
		await deleteConversation(id);

		const { conversations } = await import("../../src/bun/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await testDb.select().from(conversations).where(eq(conversations.id, id));
		expect(rows).toHaveLength(0);
	});

	it("returns success:true", async () => {
		const projectId = await seedProject();
		const { id } = await createConversation(projectId, "Delete Me 2");
		const result = await deleteConversation(id);
		expect(result.success).toBe(true);
	});
});

describe("getMessages", () => {
	it("returns an empty array for a conversation with no messages", async () => {
		const projectId = await seedProject();
		const { id } = await createConversation(projectId);
		const msgs = await getMessages(id);
		expect(msgs).toHaveLength(0);
	});

	it("returns messages ordered by createdAt ascending", async () => {
		const projectId = await seedProject();
		const { id: convId } = await createConversation(projectId);

		const { messages } = await import("../../src/bun/db/schema");
		const now = Date.now();
		await testDb.insert(messages).values([
			{ id: crypto.randomUUID(), conversationId: convId, role: "user", content: "msg A", createdAt: new Date(now).toISOString() },
			{ id: crypto.randomUUID(), conversationId: convId, role: "assistant", content: "msg B", createdAt: new Date(now + 1000).toISOString() },
			{ id: crypto.randomUUID(), conversationId: convId, role: "user", content: "msg C", createdAt: new Date(now + 2000).toISOString() },
		]);

		const msgs = await getMessages(convId);
		expect(msgs).toHaveLength(3);
		expect(msgs[0].content).toBe("msg A");
		expect(msgs[1].content).toBe("msg B");
		expect(msgs[2].content).toBe("msg C");
	});

	it("respects the limit parameter", async () => {
		const projectId = await seedProject();
		const { id: convId } = await createConversation(projectId);

		const { messages } = await import("../../src/bun/db/schema");
		const now = Date.now();
		for (let i = 0; i < 5; i++) {
			await testDb.insert(messages).values({
				id: crypto.randomUUID(),
				conversationId: convId,
				role: "user",
				content: `message ${i}`,
				createdAt: new Date(now + i * 1000).toISOString(),
			});
		}

		const msgs = await getMessages(convId, 2);
		expect(msgs).toHaveLength(2);
	});
});
