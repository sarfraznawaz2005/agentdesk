/**
 * rpc.test.ts (general-chat RPC layer)
 *
 * Tests for src/bun/rpc/general-chat.ts — the CRUD/DB-facing handlers behind
 * General Chat's standalone, project-independent conversations. The
 * general-chat/orchestrator module (which actually runs the Assistant agent)
 * is mocked out here so these tests stay at the DB/business-logic layer;
 * orchestrator.ts itself has its own dedicated test file (orchestrator.test.ts,
 * in this same directory — it must load first so its real import of
 * "../../src/bun/general-chat/orchestrator" wins before this file mocks that
 * exact specifier; see orchestrator.test.ts's own header comment for why this
 * whole directory sorts after tests/rpc/).
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-general-chat-rpc" } },
}));

const { db: testDb, sqlite: testSqlite } = createTestDb();
mock.module("../../src/bun/db", () => ({ db: testDb }));
mock.module("../../src/bun/db/connection", () => ({
	sqlite: testSqlite,
	dbFilePath: "/tmp/test-agentdesk-general-chat-rpc/agentdesk.db",
}));

mock.module("../../src/bun/providers/models", () => ({
	getContextLimit: (modelId: string) => (modelId === "huge-context-model" ? 1_000_000 : 128_000),
	getDefaultModel: () => "mock-default-model",
	clearContextLimitCache: () => {},
}));

/** Controllable orchestrator mock — tests reach in to flip these before acting. */
const runningConversationIds = new Set<string>();
const stopCalls: string[] = [];
const sendMessageCalls: Array<{ conversationId: string; content: string }> = [];
let compactImpl: (conversationId: string) => Promise<{ success: boolean; message?: string }> = async () => ({
	success: true,
});
let resolveProviderImpl: (conversationId: string) => Promise<{ config: { id: string }; modelId: string }> = async () => ({
	config: { id: "prov-mock" },
	modelId: "mock-model",
});

mock.module("../../src/bun/general-chat/orchestrator", () => ({
	sendMessage: async (conversationId: string, content: string) => {
		sendMessageCalls.push({ conversationId, content });
		return { status: "completed", assistantText: "mock reply" };
	},
	stopGeneralChatGeneration: (conversationId: string) => {
		stopCalls.push(conversationId);
		runningConversationIds.delete(conversationId);
	},
	isGeneralChatRunning: (conversationId: string) => runningConversationIds.has(conversationId),
	compactConversation: (conversationId: string) => compactImpl(conversationId),
	resolveProviderConfig: (conversationId: string) => resolveProviderImpl(conversationId),
}));

const rpc = await import("../../src/bun/rpc/general-chat");
const { generalChatConversations, generalChatMessages } = await import("../../src/bun/db/schema");

function resetState() {
	runningConversationIds.clear();
	stopCalls.length = 0;
	sendMessageCalls.length = 0;
	compactImpl = async () => ({ success: true });
	resolveProviderImpl = async () => ({ config: { id: "prov-mock" }, modelId: "mock-model" });
	testSqlite.exec("DELETE FROM general_chat_messages");
	testSqlite.exec("DELETE FROM general_chat_conversations");
	testSqlite.exec("DELETE FROM settings");
}

beforeEach(resetState);
afterEach(resetState);

// ── createGeneralChatConversation ─────────────────────────────────────────

describe("createGeneralChatConversation", () => {
	it("creates a new conversation with the default title when none is given", async () => {
		const { id, title } = await rpc.createGeneralChatConversation({});
		expect(title).toBe("New conversation");
		const rows = await testDb.select().from(generalChatConversations).where(eq(generalChatConversations.id, id));
		expect(rows.length).toBe(1);
	});

	it("creates a conversation with an explicit title", async () => {
		const { title } = await rpc.createGeneralChatConversation({ title: "Trip planning" });
		expect(title).toBe("Trip planning");
	});

	it("reuses an existing empty 'New conversation' instead of creating a duplicate", async () => {
		const first = await rpc.createGeneralChatConversation({});
		const second = await rpc.createGeneralChatConversation({});
		expect(second.id).toBe(first.id);

		const all = await testDb.select().from(generalChatConversations);
		expect(all.length).toBe(1);
	});

	it("does not reuse a 'New conversation' that already has messages", async () => {
		const first = await rpc.createGeneralChatConversation({});
		await testDb.insert(generalChatMessages).values({ conversationId: first.id, role: "user", content: "hi" });

		const second = await rpc.createGeneralChatConversation({});
		expect(second.id).not.toBe(first.id);

		const all = await testDb.select().from(generalChatConversations);
		expect(all.length).toBe(2);
	});

	it("always creates a new row when an explicit title is given, even if an empty 'New conversation' exists", async () => {
		await rpc.createGeneralChatConversation({});
		const second = await rpc.createGeneralChatConversation({ title: "Explicit" });
		const all = await testDb.select().from(generalChatConversations);
		expect(all.length).toBe(2);
		expect(second.title).toBe("Explicit");
	});
});

// ── renameGeneralChatConversation ─────────────────────────────────────────

describe("renameGeneralChatConversation", () => {
	it("updates the title", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		const result = await rpc.renameGeneralChatConversation({ id, title: "Renamed" });
		expect(result.success).toBe(true);

		const rows = await testDb.select().from(generalChatConversations).where(eq(generalChatConversations.id, id));
		expect(rows[0].title).toBe("Renamed");
	});
});

// ── pin / archive ──────────────────────────────────────────────────────────

describe("pinGeneralChatConversation / archiveGeneralChatConversation", () => {
	it("pins and unpins a conversation", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		await rpc.pinGeneralChatConversation({ id, pinned: true });
		let rows = await testDb.select().from(generalChatConversations).where(eq(generalChatConversations.id, id));
		expect(rows[0].isPinned).toBe(1);

		await rpc.pinGeneralChatConversation({ id, pinned: false });
		rows = await testDb.select().from(generalChatConversations).where(eq(generalChatConversations.id, id));
		expect(rows[0].isPinned).toBe(0);
	});

	it("archives a conversation, excluding it from the default list", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		await rpc.archiveGeneralChatConversation({ id, archived: true });

		const active = await rpc.listGeneralChatConversations();
		expect(active.find((c) => c.id === id)).toBeUndefined();

		const archived = await rpc.listArchivedGeneralChatConversations();
		expect(archived.find((c) => c.id === id)).toBeDefined();
	});
});

// ── deleteGeneralChatConversation ─────────────────────────────────────────

describe("deleteGeneralChatConversation", () => {
	it("deletes the conversation and its messages", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		await testDb.insert(generalChatMessages).values({ conversationId: id, role: "user", content: "hi" });

		await rpc.deleteGeneralChatConversation({ id });

		const convRows = await testDb.select().from(generalChatConversations).where(eq(generalChatConversations.id, id));
		const msgRows = await testDb.select().from(generalChatMessages).where(eq(generalChatMessages.conversationId, id));
		expect(convRows.length).toBe(0);
		expect(msgRows.length).toBe(0);
	});

	it("stops an in-flight generation before deleting", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		runningConversationIds.add(id);

		await rpc.deleteGeneralChatConversation({ id });

		expect(stopCalls).toContain(id);
	});

	it("does not call stop when no generation is running", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		await rpc.deleteGeneralChatConversation({ id });
		expect(stopCalls).not.toContain(id);
	});

	it("cleans up project-scoped settings rows keyed by the conversation id", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		testSqlite
			.prepare("INSERT INTO settings(id, key, value, category) VALUES (?, ?, ?, 'git')")
			.run(crypto.randomUUID(), `project:${id}:chatModelId`, "\"gpt-5\"");
		// A settings row for a DIFFERENT project must survive.
		const otherId = "other-conv-id";
		testSqlite
			.prepare("INSERT INTO settings(id, key, value, category) VALUES (?, ?, ?, 'git')")
			.run(crypto.randomUUID(), `project:${otherId}:chatModelId`, "\"gpt-5\"");

		await rpc.deleteGeneralChatConversation({ id });

		const own = testSqlite.prepare("SELECT * FROM settings WHERE key LIKE ?").all(`project:${id}:%`);
		const other = testSqlite.prepare("SELECT * FROM settings WHERE key LIKE ?").all(`project:${otherId}:%`);
		expect(own.length).toBe(0);
		expect(other.length).toBe(1);
	});
});

// ── clearGeneralChatConversation ──────────────────────────────────────────

describe("clearGeneralChatConversation", () => {
	it("deletes messages but keeps the conversation row", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		await testDb.insert(generalChatMessages).values({ conversationId: id, role: "user", content: "hi" });

		const result = await rpc.clearGeneralChatConversation({ id });
		expect(result.success).toBe(true);

		const convRows = await testDb.select().from(generalChatConversations).where(eq(generalChatConversations.id, id));
		const msgRows = await testDb.select().from(generalChatMessages).where(eq(generalChatMessages.conversationId, id));
		expect(convRows.length).toBe(1);
		expect(msgRows.length).toBe(0);
	});

	it("stops an in-flight generation before clearing", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		runningConversationIds.add(id);
		await rpc.clearGeneralChatConversation({ id });
		expect(stopCalls).toContain(id);
	});
});

// ── deleteGeneralChatMessage ───────────────────────────────────────────────

describe("deleteGeneralChatMessage", () => {
	it("deletes exactly the targeted message", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		const keepId = crypto.randomUUID();
		const deleteId = crypto.randomUUID();
		await testDb.insert(generalChatMessages).values([
			{ id: keepId, conversationId: id, role: "user", content: "keep me" },
			{ id: deleteId, conversationId: id, role: "assistant", content: "delete me" },
		]);

		await rpc.deleteGeneralChatMessage({ id: deleteId });

		const remaining = await testDb.select().from(generalChatMessages).where(eq(generalChatMessages.conversationId, id));
		expect(remaining.length).toBe(1);
		expect(remaining[0].id).toBe(keepId);
	});
});

// ── forkGeneralChatConversation ────────────────────────────────────────────

describe("forkGeneralChatConversation", () => {
	it("throws for an unknown source conversation", async () => {
		await expect(rpc.forkGeneralChatConversation({ id: "does-not-exist" })).rejects.toThrow();
	});

	it("copies all messages into a new conversation titled 'Fork of <source>'", async () => {
		const { id } = await rpc.createGeneralChatConversation({ title: "Original" });
		await testDb.insert(generalChatMessages).values([
			{ conversationId: id, role: "user", content: "one" },
			{ conversationId: id, role: "assistant", content: "two" },
		]);

		const fork = await rpc.forkGeneralChatConversation({ id });
		expect(fork.title).toBe("Fork of Original");
		expect(fork.id).not.toBe(id);

		const forkedMessages = await rpc.getGeneralChatMessages({ conversationId: fork.id });
		expect(forkedMessages.length).toBe(2);
		expect(forkedMessages.map((m) => m.content)).toEqual(["one", "two"]);
	});

	it("copies only messages up to and including upToMessageId", async () => {
		const { id } = await rpc.createGeneralChatConversation({ title: "Original" });
		const msgIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
		await testDb.insert(generalChatMessages).values([
			{ id: msgIds[0], conversationId: id, role: "user", content: "first" },
			{ id: msgIds[1], conversationId: id, role: "assistant", content: "second" },
			{ id: msgIds[2], conversationId: id, role: "user", content: "third" },
		]);

		const fork = await rpc.forkGeneralChatConversation({ id, upToMessageId: msgIds[1] });
		const forkedMessages = await rpc.getGeneralChatMessages({ conversationId: fork.id });
		expect(forkedMessages.map((m) => m.content)).toEqual(["first", "second"]);
	});

	it("creates an empty fork when the source has no messages", async () => {
		const { id } = await rpc.createGeneralChatConversation({ title: "Empty" });
		const fork = await rpc.forkGeneralChatConversation({ id });
		const forkedMessages = await rpc.getGeneralChatMessages({ conversationId: fork.id });
		expect(forkedMessages.length).toBe(0);
	});
});

// ── getGeneralChatMessages ─────────────────────────────────────────────────

describe("getGeneralChatMessages", () => {
	it("returns messages in creation order", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		const now = Date.now();
		await testDb.insert(generalChatMessages).values([
			{ conversationId: id, role: "user", content: "first", createdAt: new Date(now).toISOString() },
			{ conversationId: id, role: "assistant", content: "second", createdAt: new Date(now + 1000).toISOString() },
			{ conversationId: id, role: "user", content: "third", createdAt: new Date(now + 2000).toISOString() },
		]);

		const messages = await rpc.getGeneralChatMessages({ conversationId: id });
		expect(messages.map((m) => m.content)).toEqual(["first", "second", "third"]);
	});
});

// ── getGeneralChatStatus ───────────────────────────────────────────────────

describe("getGeneralChatStatus", () => {
	it("reflects whether a turn is currently running for the conversation", () => {
		expect(rpc.getGeneralChatStatus({ conversationId: "conv-x" }).isRunning).toBe(false);
		runningConversationIds.add("conv-x");
		expect(rpc.getGeneralChatStatus({ conversationId: "conv-x" }).isRunning).toBe(true);
	});
});

// ── sendGeneralChatMessage ─────────────────────────────────────────────────

describe("sendGeneralChatMessage", () => {
	it("rejects empty content without touching the orchestrator", () => {
		const result = rpc.sendGeneralChatMessage({ conversationId: "conv-1", content: "   " });
		expect(result).toEqual({ ok: false, error: "Message is empty." });
		expect(sendMessageCalls.length).toBe(0);
	});

	it("rejects when a generation is already in flight for the conversation", () => {
		runningConversationIds.add("conv-1");
		const result = rpc.sendGeneralChatMessage({ conversationId: "conv-1", content: "hello" });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("already being generated");
	});

	it("kicks off the orchestrator fire-and-forget and returns ok immediately", async () => {
		const result = rpc.sendGeneralChatMessage({ conversationId: "conv-1", content: "hello there" });
		expect(result).toEqual({ ok: true });

		// Fire-and-forget: give the microtask queue a tick to run the call.
		await new Promise((r) => setTimeout(r, 0));
		expect(sendMessageCalls).toContainEqual({ conversationId: "conv-1", content: "hello there" });
	});

	it("trims content before sending", async () => {
		rpc.sendGeneralChatMessage({ conversationId: "conv-2", content: "  padded message  " });
		await new Promise((r) => setTimeout(r, 0));
		expect(sendMessageCalls).toContainEqual({ conversationId: "conv-2", content: "padded message" });
	});
});

// ── stopGeneralChatGeneration ──────────────────────────────────────────────

describe("stopGeneralChatGeneration", () => {
	it("forwards to the orchestrator and reports success", () => {
		const result = rpc.stopGeneralChatGeneration({ conversationId: "conv-1" });
		expect(result).toEqual({ success: true });
		expect(stopCalls).toContain("conv-1");
	});
});

// ── setGeneralChatDeepResearchMode ─────────────────────────────────────────

describe("setGeneralChatDeepResearchMode", () => {
	it("toggles the flag on the conversation row", async () => {
		const { id } = await rpc.createGeneralChatConversation({});
		await rpc.setGeneralChatDeepResearchMode({ conversationId: id, enabled: true });

		let rows = await testDb.select().from(generalChatConversations).where(eq(generalChatConversations.id, id));
		expect(rows[0].deepResearchMode).toBe(1);

		await rpc.setGeneralChatDeepResearchMode({ conversationId: id, enabled: false });
		rows = await testDb.select().from(generalChatConversations).where(eq(generalChatConversations.id, id));
		expect(rows[0].deepResearchMode).toBe(0);
	});
});

// ── compactGeneralChatConversation ─────────────────────────────────────────

describe("compactGeneralChatConversation", () => {
	it("forwards to the orchestrator's compactConversation and returns its result", async () => {
		compactImpl = async () => ({ success: false, message: "Not enough messages to compact" });
		const result = await rpc.compactGeneralChatConversation({ conversationId: "conv-1" });
		expect(result).toEqual({ success: false, message: "Not enough messages to compact" });
	});
});

// ── getGeneralChatContextLimit ─────────────────────────────────────────────

describe("getGeneralChatContextLimit", () => {
	it("resolves the model via the orchestrator and returns its context limit", async () => {
		resolveProviderImpl = async () => ({ config: { id: "prov-mock" }, modelId: "huge-context-model" });
		const result = await rpc.getGeneralChatContextLimit({ conversationId: "conv-1" });
		expect(result).toEqual({ contextLimit: 1_000_000, modelId: "huge-context-model" });
	});
});
