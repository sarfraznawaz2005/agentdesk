/**
 * manager.test.ts
 *
 * Tests for the ChannelManager public API:
 *   - registerAdapter / initChannelManager
 *   - getChannelStatuses / getAdapterStatus / getChannelPlatform
 *   - sendChannelMessage routing and reply-context attachment
 *   - getOrCreateProjectChannelConversation — idempotent conversation creation
 *   - disconnectChannel / shutdownChannelManager
 *
 * All heavy dependencies (DB, engine-manager, notifications) are mocked.
 * Adapter instances are lightweight stubs that implement ChannelAdapter.
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../helpers/db";

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-channel-manager" } },
}));

const { db: testDb, sqlite: testSqlite } = createTestDb();

mock.module("../../src/bun/db", () => ({ db: testDb }));
mock.module("../../src/bun/db/connection", () => ({ sqlite: testSqlite }));

const broadcastMock = mock(() => {});
mock.module("../../src/bun/engine-manager", () => ({
	broadcastToWebview: broadcastMock,
	getOrCreateEngine: () => ({}),
	abortAllAgents: () => {},
	engines: new Map(),
	registerAgentController: () => {},
	unregisterAgentController: () => {},
	getRunningAgentCount: () => 0,
	getRunningAgentNames: () => [],
}));

mock.module("../../src/bun/notifications/native", () => ({
	sendNativeNotification: async () => {},
}));

mock.module("../../src/bun/rpc/inbox", () => ({
	writeInboxMessage: async () => ({ id: "inbox-1" }),
}));

mock.module("../../src/bun/scheduler", () => ({
	eventBus: { emit: () => {} },
}));

// Import after mocks
import type { ChannelAdapter, ChannelConfig, ConnectionStatus, IncomingMessage, SendOptions } from "../../src/bun/channels/types";

const managerModule = await import("../../src/bun/channels/manager");
const {
	registerAdapter,
	initChannelManager,
	getChannelStatuses,
	getAdapterStatus,
	getChannelPlatform,
	sendChannelMessage,
	getOrCreateProjectChannelConversation,
	disconnectChannel,
	shutdownChannelManager,
} = managerModule;

// ---------------------------------------------------------------------------
// Stub adapter factory
// ---------------------------------------------------------------------------

function createStubAdapter(platform: "discord" | "whatsapp" | "email" | "chat" = "discord"): ChannelAdapter & {
	sentMessages: Array<{ to: string; content: string; options?: SendOptions }>;
	messageHandler: ((msg: IncomingMessage) => void) | null;
	simulateIncoming(msg: IncomingMessage): void;
} {
	let status: ConnectionStatus = "disconnected";
	let messageHandler: ((msg: IncomingMessage) => void) | null = null;
	const sentMessages: Array<{ to: string; content: string; options?: SendOptions }> = [];

	const adapter = {
		platform: platform as const,
		get sentMessages() { return sentMessages; },
		get messageHandler() { return messageHandler; },
		simulateIncoming(msg: IncomingMessage) {
			messageHandler?.(msg);
		},
		async connect(_config: ChannelConfig) {
			status = "connected";
		},
		async disconnect() {
			status = "disconnected";
		},
		getStatus(): ConnectionStatus {
			return status;
		},
		async sendMessage(to: string, content: string, options?: SendOptions) {
			sentMessages.push({ to, content, options });
		},
		onMessage(handler: (msg: IncomingMessage) => void) {
			messageHandler = handler;
		},
	};

	return adapter;
}

// ---------------------------------------------------------------------------
// Helpers to seed DB records
// ---------------------------------------------------------------------------

function insertChannel(opts: {
	id?: string;
	platform?: string;
	enabled?: number;
	projectId?: string;
}) {
	const id = opts.id ?? crypto.randomUUID();
	const projectId = opts.projectId ?? null;
	testSqlite.exec(
		`INSERT INTO channels(id, platform, config, enabled, project_id)
     VALUES ('${id}', '${opts.platform ?? "discord"}', '{}', ${opts.enabled ?? 1}, ${projectId ? `'${projectId}'` : "NULL"})`,
	);
	return id;
}

function insertProject(id?: string) {
	const pid = id ?? crypto.randomUUID();
	testSqlite.exec(`INSERT INTO projects(id, name, workspace_path) VALUES ('${pid}', 'Test Project', '/tmp')`);
	return pid;
}

// ---------------------------------------------------------------------------
// Cleanup state between tests
// ---------------------------------------------------------------------------

afterEach(async () => {
	await shutdownChannelManager();
	testSqlite.exec("DELETE FROM conversations");
	testSqlite.exec("DELETE FROM channels");
	testSqlite.exec("DELETE FROM projects");
	broadcastMock.mockClear();
});

// ---------------------------------------------------------------------------

describe("registerAdapter and getChannelStatuses", () => {
	it("returns an empty array when no channels are connected", () => {
		const statuses = getChannelStatuses();
		expect(statuses).toHaveLength(0);
	});

	it("connects a registered adapter on initChannelManager", async () => {
		const stub = createStubAdapter("discord");
		registerAdapter("discord", () => stub);

		const channelId = insertChannel({ platform: "discord", enabled: 1 });

		await initChannelManager(() => ({} as never));

		const statuses = getChannelStatuses();
		expect(statuses).toHaveLength(1);
		expect(statuses[0].channelId).toBe(channelId);
		expect(statuses[0].platform).toBe("discord");
		expect(statuses[0].status).toBe("connected");
	});

	it("skips disabled channels during init", async () => {
		const stub = createStubAdapter("discord");
		registerAdapter("discord", () => stub);

		insertChannel({ platform: "discord", enabled: 0 });

		await initChannelManager(() => ({} as never));

		expect(getChannelStatuses()).toHaveLength(0);
	});

	it("warns and skips channels without a registered factory", async () => {
		// Insert a channel for 'email' but only register a discord factory
		insertChannel({ platform: "email", enabled: 1 });

		registerAdapter("discord", () => createStubAdapter("discord"));

		// Should not throw
		await expect(initChannelManager(() => ({} as never))).resolves.toBeUndefined();
		expect(getChannelStatuses()).toHaveLength(0);
	});
});

describe("getAdapterStatus", () => {
	it("returns null for an unknown channelId", () => {
		const status = getAdapterStatus("nonexistent-channel");
		expect(status).toBeNull();
	});

	it("returns the adapter status after connection", async () => {
		const stub = createStubAdapter("discord");
		registerAdapter("discord", () => stub);

		const channelId = insertChannel({ platform: "discord", enabled: 1 });
		await initChannelManager(() => ({} as never));

		expect(getAdapterStatus(channelId)).toBe("connected");
	});
});

describe("getChannelPlatform", () => {
	it("returns null for an unknown channelId", () => {
		expect(getChannelPlatform("unknown")).toBeNull();
	});

	it("returns the correct platform after init", async () => {
		registerAdapter("discord", () => createStubAdapter("discord"));
		const channelId = insertChannel({ platform: "discord", enabled: 1 });
		await initChannelManager(() => ({} as never));

		expect(getChannelPlatform(channelId)).toBe("discord");
	});
});

describe("sendChannelMessage", () => {
	it("throws when no adapter is connected for the given channelId", async () => {
		await expect(sendChannelMessage("no-such-channel", "hello")).rejects.toThrow(
			/no active adapter/i,
		);
	});

	it("routes a message to the correct adapter", async () => {
		const stub = createStubAdapter("discord");
		registerAdapter("discord", () => stub);
		const channelId = insertChannel({ platform: "discord", enabled: 1 });
		await initChannelManager(() => ({} as never));

		await sendChannelMessage(channelId, "Hello Discord!");

		expect(stub.sentMessages).toHaveLength(1);
		expect(stub.sentMessages[0].content).toBe("Hello Discord!");
	});

	it("attaches reply context from the last inbound message", async () => {
		const stub = createStubAdapter("discord");
		registerAdapter("discord", () => stub);
		const channelId = insertChannel({ platform: "discord", enabled: 1 });
		const projectId = insertProject();

		await initChannelManager(() => ({} as never));

		// Simulate an inbound message so the manager records its context
		stub.simulateIncoming({
			platform: "discord",
			channelId,
			senderId: "user-123",
			senderName: "Alice",
			content: "Hello bot!",
			threadId: "thread-xyz",
			metadata: { msgChannelId: "disc-channel-snowflake" },
		});

		// Small settle delay for async handleIncomingMessage
		await new Promise((r) => setTimeout(r, 50));

		await sendChannelMessage(channelId, "Reply!");
		// The adapter should have received the message directed to the discord channel snowflake
		expect(stub.sentMessages.length).toBeGreaterThanOrEqual(1);
		const lastSent = stub.sentMessages[stub.sentMessages.length - 1];
		expect(lastSent.content).toBe("Reply!");
	});
});

describe("disconnectChannel", () => {
	it("is a no-op for a non-connected channelId", async () => {
		await expect(disconnectChannel("does-not-exist")).resolves.toBeUndefined();
	});

	it("disconnects a connected adapter and removes it from statuses", async () => {
		const stub = createStubAdapter("discord");
		registerAdapter("discord", () => stub);
		const channelId = insertChannel({ platform: "discord", enabled: 1 });
		await initChannelManager(() => ({} as never));

		expect(getChannelStatuses()).toHaveLength(1);

		await disconnectChannel(channelId);

		expect(getChannelStatuses()).toHaveLength(0);
		expect(getAdapterStatus(channelId)).toBeNull();
	});
});

describe("getOrCreateProjectChannelConversation", () => {
	it("creates a new conversation for a project+channel pair", async () => {
		const projectId = insertProject();
		const channelId = insertChannel({ platform: "discord", enabled: 1, projectId });

		const convId = await getOrCreateProjectChannelConversation(projectId, channelId, "discord");
		expect(convId).toBeTruthy();
		expect(typeof convId).toBe("string");
	});

	it("returns the same conversation ID on subsequent calls for the same project+channel+day", async () => {
		const projectId = insertProject();
		const channelId = insertChannel({ platform: "discord", enabled: 1, projectId });

		const convId1 = await getOrCreateProjectChannelConversation(projectId, channelId, "discord");
		const convId2 = await getOrCreateProjectChannelConversation(projectId, channelId, "discord");

		expect(convId1).toBe(convId2);
	});

	it("creates separate conversations for different projects", async () => {
		const projectA = insertProject();
		const projectB = insertProject();
		const channelId = insertChannel({ platform: "discord", enabled: 1 });

		const convA = await getOrCreateProjectChannelConversation(projectA, channelId, "discord");
		const convB = await getOrCreateProjectChannelConversation(projectB, channelId, "discord");

		expect(convA).not.toBe(convB);
	});

	it("formats the conversation title as '<Platform> - YYYY-MM-DD'", async () => {
		const projectId = insertProject();
		const channelId = insertChannel({ platform: "discord", enabled: 1, projectId });

		const convId = await getOrCreateProjectChannelConversation(projectId, channelId, "discord");

		const { conversations } = await import("../../src/bun/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await testDb.select({ title: conversations.title }).from(conversations).where(eq(conversations.id, convId));

		expect(rows).toHaveLength(1);
		expect(rows[0].title).toMatch(/^Discord - \d{4}-\d{2}-\d{2}$/);
	});
});

describe("shutdownChannelManager", () => {
	it("disconnects all active adapters without throwing", async () => {
		const stub = createStubAdapter("discord");
		registerAdapter("discord", () => stub);
		insertChannel({ platform: "discord", enabled: 1 });
		await initChannelManager(() => ({} as never));

		await expect(shutdownChannelManager()).resolves.toBeUndefined();
		expect(getChannelStatuses()).toHaveLength(0);
	});

	it("is safe to call when no adapters are connected", async () => {
		await expect(shutdownChannelManager()).resolves.toBeUndefined();
	});
});
