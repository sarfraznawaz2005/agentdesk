/**
 * orchestrator.test.ts
 *
 * Tests for src/bun/general-chat/orchestrator.ts — the standalone Assistant
 * agent runner behind General Chat (sendMessage, compactConversation,
 * resolveProviderConfig, stop/isRunning). runInlineAgent (agent-loop.ts) and
 * every other external collaborator (AI SDK, providers, engine-manager
 * broadcasts, desktop notifications, the Assistant-exclusive tool factories)
 * are mocked so no real LLM calls or filesystem/network access are needed.
 *
 * Directory note: `mock.module()` replaces a specifier for the rest of the
 * `bun test` process — there is no per-file undo. orchestrator.ts imports
 * "../rpc/settings" and "../rpc/projects" directly, and this file needs to
 * fully stub both, but tests/rpc/settings.test.ts and tests/rpc/projects.test.ts
 * need the REAL modules for their own tests. bun test loads files in path
 * order, so this suite lives under `zz-general-chat` (sorts after `rpc/`)
 * to guarantee those two files finish importing the real modules first.
 * See tests/agents/agent-loop.test.ts / review-cycle.test.ts for the same
 * constraint solved by natural alphabetical luck ("agents" < "general-chat").
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-general-chat-orch" } },
}));

const { db: testDb, sqlite: testSqlite } = createTestDb();
mock.module("../../src/bun/db", () => ({ db: testDb }));

// ── runInlineAgent — the core collaborator under test's control ───────────

interface MockCallbacks {
	onPartCreated: (part: Record<string, unknown>) => void;
	onPartUpdated: (messageId: string, partId: string, updates: Record<string, unknown>) => void;
	onTextDelta?: (messageId: string, delta: string) => void;
	onStepUsage?: (promptTokens: number, contextLimit: number) => void;
	onStreamPerformance?: (tokensPerSecond: number, timeToFirstOutputMs: number | undefined) => void;
}
interface MockRunOpts {
	conversationId: string;
	callbacks: MockCallbacks;
	abortSignal?: AbortSignal;
	deepResearchMode?: boolean;
	extraTools?: Record<string, unknown>;
}
interface MockRunResult {
	status: "completed" | "failed" | "cancelled" | "context_full" | "timeout";
	summary: string;
	filesModified: string[];
	tokensUsed: { prompt: number; completion: number; total: number };
	messageIds: string[];
}

let runInlineAgentImpl: (opts: MockRunOpts) => Promise<MockRunResult> = async () => ({
	status: "completed",
	summary: "Mock assistant reply.",
	filesModified: [],
	tokensUsed: { prompt: 500, completion: 200, total: 700 },
	messageIds: [],
});

mock.module("../../src/bun/agents/agent-loop", () => ({
	runInlineAgent: (opts: MockRunOpts) => runInlineAgentImpl(opts),
}));

// ── ai (generateText — used only by compactConversation) ──────────────────

let generateTextImpl: (args: { messages?: Array<{ content: string }> }) => Promise<{ text: string }> = async () => ({
	text: "Condensed summary of the conversation.",
});

mock.module("ai", () => ({
	generateText: (args: unknown) => generateTextImpl(args as { messages?: Array<{ content: string }> }),
}));

// ── providers ────────────────────────────────────────────────────────────

mock.module("../../src/bun/providers", () => ({
	createProviderAdapter: () => ({ createModel: (modelId: string) => ({ _mock: true, modelId }) }),
}));
mock.module("../../src/bun/providers/models", () => ({
	getDefaultModel: (providerType: string) => `default-${providerType}-model`,
	getContextLimit: () => 128_000,
	clearContextLimitCache: () => {},
}));
mock.module("../../src/bun/providers/claude-subscription", () => ({
	internalCallModelId: (_providerType: string, modelId: string) => modelId,
}));

// ── settings / streaming mode / project settings ───────────────────────────

let getSettingImpl: (key: string, category?: string) => Promise<unknown> = async (key) => {
	if (key === "session_complete_notification") return null; // null → defaults to enabled
	return null;
};
mock.module("../../src/bun/rpc/settings", () => ({
	getSetting: (key: string, category?: string) => getSettingImpl(key, category),
}));

let streamingModeImpl: () => Promise<string> = async () => "hybrid";
mock.module("../../src/bun/agents/streaming-mode", () => ({
	getStreamingMode: () => streamingModeImpl(),
}));

let projectSettingsImpl: (conversationId: string) => Promise<Record<string, string>> = async () => ({});
mock.module("../../src/bun/rpc/projects", () => ({
	getProjectSettings: (conversationId: string) => projectSettingsImpl(conversationId),
}));

// ── broadcasts / notifications ──────────────────────────────────────────────

const broadcasts: Array<{ event: string; payload: Record<string, unknown> }> = [];
let appFocused = true;
mock.module("../../src/bun/engine-manager", () => ({
	broadcastToWebview: (event: string, payload: Record<string, unknown>) => {
		broadcasts.push({ event, payload });
	},
	isAppFocused: () => appFocused,
}));

const notificationCalls: Array<{ title: string; body: string }> = [];
mock.module("../../src/bun/notifications/desktop", () => ({
	sendDesktopNotification: async (title: string, body: string) => {
		notificationCalls.push({ title, body });
	},
}));

// ── Assistant-exclusive tool factories (not under test here) ──────────────

mock.module("../../src/bun/agents/tools/general-chat-memory", () => ({
	createGeneralChatMemoryTools: () => ({}),
}));
const clearTodosCalls: string[] = [];
mock.module("../../src/bun/agents/tools/general-chat-todos", () => ({
	createGeneralChatTodoTools: () => ({}),
	clearGeneralChatTodos: (conversationId: string) => {
		clearTodosCalls.push(conversationId);
	},
}));
mock.module("../../src/bun/agents/tools/general-chat-code-exec", () => ({
	createGeneralChatCodeExecTool: () => ({}),
}));
mock.module("../../src/bun/agents/tools/deep-research", () => ({
	createDeepResearchTool: () => ({ deep_research: { tool: {} } }),
}));
mock.module("../../src/bun/agents/tools/screenshot", () => ({
	extractImagePayload: (output: unknown) => {
		if (typeof output !== "string") return null;
		try {
			const parsed = JSON.parse(output) as { image?: { base64?: string; mimeType?: string } };
			const base64 = parsed.image?.base64;
			const mimeType = parsed.image?.mimeType;
			return base64 && mimeType ? { base64, mimeType } : null;
		} catch {
			return null;
		}
	},
}));

// ── Import module under test (after all mocks are wired) ──────────────────

const orchestrator = await import("../../src/bun/general-chat/orchestrator");
const { generalChatConversations, generalChatMessages } = await import("../../src/bun/db/schema");

// ── Test helpers ─────────────────────────────────────────────────────────

async function createConversation(overrides: { id?: string; title?: string } = {}): Promise<string> {
	const id = overrides.id ?? crypto.randomUUID();
	await testDb.insert(generalChatConversations).values({
		id,
		title: overrides.title ?? "New conversation",
	});
	return id;
}

function seedProvider(opts: { id?: string; isDefault?: number } = {}): void {
	const id = opts.id ?? "prov-1";
	testSqlite.exec(
		`INSERT INTO ai_providers(id, name, provider_type, api_key, is_default, is_valid)
     VALUES ('${id}', 'Mock Provider', 'anthropic', 'sk-mock', ${opts.isDefault ?? 1}, 1)`,
	);
}

function removeAllProviders(): void {
	testSqlite.exec("DELETE FROM ai_providers");
}

async function getMessages(conversationId: string) {
	return testDb.select().from(generalChatMessages).where(eq(generalChatMessages.conversationId, conversationId));
}

function eventsFor(event: string) {
	return broadcasts.filter((b) => b.event === event);
}

function resetState(): void {
	broadcasts.length = 0;
	notificationCalls.length = 0;
	clearTodosCalls.length = 0;
	appFocused = true;
	getSettingImpl = async (key) => (key === "session_complete_notification" ? null : null);
	streamingModeImpl = async () => "hybrid";
	projectSettingsImpl = async () => ({});
	generateTextImpl = async () => ({ text: "Condensed summary of the conversation." });
	runInlineAgentImpl = async () => ({
		status: "completed",
		summary: "Mock assistant reply.",
		filesModified: [],
		tokensUsed: { prompt: 500, completion: 200, total: 700 },
		messageIds: [],
	});
	testSqlite.exec("DELETE FROM general_chat_messages");
	testSqlite.exec("DELETE FROM general_chat_conversations");
	testSqlite.exec("DELETE FROM ai_providers");
}

beforeEach(resetState);
afterEach(resetState);

// ── resolveProviderConfig ───────────────────────────────────────────────────

describe("resolveProviderConfig", () => {
	it("throws when no AI provider is configured", async () => {
		const id = await createConversation();
		await expect(orchestrator.resolveProviderConfig(id)).rejects.toThrow(/no ai provider configured/i);
	});

	it("picks the provider flagged as default when multiple exist", async () => {
		const id = await createConversation();
		seedProvider({ id: "prov-a", isDefault: 0 });
		seedProvider({ id: "prov-b", isDefault: 1 });

		const { config } = await orchestrator.resolveProviderConfig(id);
		expect(config.id).toBe("prov-b");
	});

	it("falls back to the first provider when none is flagged default", async () => {
		const id = await createConversation();
		seedProvider({ id: "prov-only", isDefault: 0 });

		const { config } = await orchestrator.resolveProviderConfig(id);
		expect(config.id).toBe("prov-only");
	});

	it("honors a per-conversation model override from project settings", async () => {
		const id = await createConversation();
		seedProvider({ id: "prov-default", isDefault: 1 });
		projectSettingsImpl = async (conversationId) =>
			conversationId === id ? { chatModelId: "custom-model-id" } : {};

		const { modelId } = await orchestrator.resolveProviderConfig(id);
		expect(modelId).toBe("custom-model-id");
	});

	it("falls back to the provider's default model when no override is set", async () => {
		const id = await createConversation();
		seedProvider({ id: "prov-default", isDefault: 1 });

		const { modelId } = await orchestrator.resolveProviderConfig(id);
		// ai_providers.default_model is NULL in the seed helper → falls through to getDefaultModel()
		expect(modelId).toBe("default-anthropic-model");
	});
});

// ── sendMessage — happy path ────────────────────────────────────────────────

describe("sendMessage — happy path", () => {
	it("persists the user and assistant messages and returns the completed status", async () => {
		const id = await createConversation();
		seedProvider();

		const result = await orchestrator.sendMessage(id, "Hello there");
		expect(result.status).toBe("completed");
		expect(result.assistantText).toBe("Mock assistant reply.");

		const rows = await getMessages(id);
		expect(rows.length).toBe(2);
		expect(rows[0].role).toBe("user");
		expect(rows[0].content).toBe("Hello there");
		expect(rows[1].role).toBe("assistant");
		expect(rows[1].content).toBe("Mock assistant reply.");

		const metadata = JSON.parse(rows[1].metadata ?? "{}");
		expect(metadata.status).toBe("completed");
		expect(typeof metadata.modelId).toBe("string");
	});

	it("broadcasts generalChatRunStarted then generalChatComplete", async () => {
		const id = await createConversation();
		seedProvider();

		await orchestrator.sendMessage(id, "Hi");

		expect(eventsFor("generalChatRunStarted").length).toBe(1);
		const complete = eventsFor("generalChatComplete");
		expect(complete.length).toBe(1);
		expect(complete[0].payload.status).toBe("completed");
		expect(complete[0].payload.assistantText).toBe("Mock assistant reply.");
		expect(typeof complete[0].payload.userMessageId).toBe("string");
		expect(typeof complete[0].payload.assistantMessageId).toBe("string");
	});

	it("clears the conversation's scratch todos once the turn finishes", async () => {
		const id = await createConversation();
		seedProvider();
		await orchestrator.sendMessage(id, "Hi");
		expect(clearTodosCalls).toContain(id);
	});

	it("throws for an unknown conversation id", async () => {
		await expect(orchestrator.sendMessage("does-not-exist", "hi")).rejects.toThrow(/no general chat conversation/i);
	});
});

// ── sendMessage — auto-title ─────────────────────────────────────────────────

describe("sendMessage — auto-title", () => {
	it("titles a fresh conversation from the first message verbatim when short", async () => {
		const id = await createConversation({ title: "New conversation" });
		seedProvider();

		await orchestrator.sendMessage(id, "Plan my trip");

		const rows = await testDb.select().from(generalChatConversations).where(eq(generalChatConversations.id, id));
		expect(rows[0].title).toBe("Plan my trip");
		expect(eventsFor("generalChatConversationRenamed").length).toBe(1);
	});

	it("truncates a long first message to 37 chars + ellipsis", async () => {
		const id = await createConversation({ title: "New conversation" });
		seedProvider();

		const longText = "A".repeat(60);
		await orchestrator.sendMessage(id, longText);

		const rows = await testDb.select().from(generalChatConversations).where(eq(generalChatConversations.id, id));
		expect(rows[0].title).toBe("A".repeat(37) + "...");
	});

	it("does not re-title a conversation that already has a custom title", async () => {
		const id = await createConversation({ title: "My custom title" });
		seedProvider();

		await orchestrator.sendMessage(id, "Another message");

		const rows = await testDb.select().from(generalChatConversations).where(eq(generalChatConversations.id, id));
		expect(rows[0].title).toBe("My custom title");
		expect(eventsFor("generalChatConversationRenamed").length).toBe(0);
	});
});

// ── sendMessage — failure status ─────────────────────────────────────────────

describe("sendMessage — failure status", () => {
	it("still persists a real assistant row, flagged failed in metadata", async () => {
		const id = await createConversation();
		seedProvider();
		runInlineAgentImpl = async () => ({
			status: "failed",
			summary: "Failed: the model errored out",
			filesModified: [],
			tokensUsed: { prompt: 10, completion: 0, total: 10 },
			messageIds: [],
		});

		const result = await orchestrator.sendMessage(id, "Do the thing");
		expect(result.status).toBe("failed");

		const rows = await getMessages(id);
		expect(rows.length).toBe(2);
		expect(rows[1].content).toBe("Failed: the model errored out");
		const metadata = JSON.parse(rows[1].metadata ?? "{}");
		expect(metadata.status).toBe("failed");
	});
});

// ── sendMessage — generated-image embedding ──────────────────────────────────

describe("sendMessage — generated-image embedding", () => {
	it("embeds an execute_code-produced image as a <generated-image> block", async () => {
		const id = await createConversation();
		seedProvider();

		runInlineAgentImpl = async (opts) => {
			opts.callbacks.onPartCreated({
				id: "part-1",
				messageId: "msg-1",
				type: "tool_call",
				content: "",
				toolName: "execute_code",
				sortOrder: 0,
			});
			opts.callbacks.onPartUpdated("msg-1", "part-1", {
				toolState: "success",
				toolOutput: JSON.stringify({ success: true, image: { base64: "QUJD", mimeType: "image/png" } }),
			});
			return {
				status: "completed",
				summary: "Here is your chart.",
				filesModified: [],
				tokensUsed: { prompt: 10, completion: 5, total: 15 },
				messageIds: [],
			};
		};

		await orchestrator.sendMessage(id, "Plot something");

		const rows = await getMessages(id);
		expect(rows[1].content).toContain("Here is your chart.");
		expect(rows[1].content).toContain('<generated-image mime="image/png">QUJD</generated-image>');
	});

	it("does not embed an image for tools outside IMAGE_OUTPUT_TOOLS", async () => {
		const id = await createConversation();
		seedProvider();

		runInlineAgentImpl = async (opts) => {
			opts.callbacks.onPartCreated({
				id: "part-1",
				messageId: "msg-1",
				type: "tool_call",
				content: "",
				toolName: "read_image",
				sortOrder: 0,
			});
			opts.callbacks.onPartUpdated("msg-1", "part-1", {
				toolState: "success",
				toolOutput: JSON.stringify({ success: true, image: { base64: "QUJD", mimeType: "image/png" } }),
			});
			return {
				status: "completed",
				summary: "Viewed the attachment.",
				filesModified: [],
				tokensUsed: { prompt: 10, completion: 5, total: 15 },
				messageIds: [],
			};
		};

		await orchestrator.sendMessage(id, "Look at this");

		const rows = await getMessages(id);
		expect(rows[1].content).toBe("Viewed the attachment.");
		expect(rows[1].content).not.toContain("generated-image");
	});
});

// ── sendMessage — error handling ─────────────────────────────────────────────

describe("sendMessage — error handling", () => {
	it("broadcasts generalChatRunError and rethrows when runInlineAgent throws", async () => {
		const id = await createConversation();
		seedProvider();
		runInlineAgentImpl = async () => {
			throw new Error("boom");
		};

		await expect(orchestrator.sendMessage(id, "hi")).rejects.toThrow("boom");
		expect(eventsFor("generalChatRunError").length).toBe(1);
	});

	it("cleans up the running state so a subsequent call is allowed", async () => {
		const id = await createConversation();
		seedProvider();
		runInlineAgentImpl = async () => {
			throw new Error("boom");
		};
		await expect(orchestrator.sendMessage(id, "hi")).rejects.toThrow();
		expect(orchestrator.isGeneralChatRunning(id)).toBe(false);

		// A second call after the failure should be allowed to proceed (not blocked by a stuck guard).
		runInlineAgentImpl = async () => ({
			status: "completed",
			summary: "Recovered.",
			filesModified: [],
			tokensUsed: { prompt: 1, completion: 1, total: 2 },
			messageIds: [],
		});
		const result = await orchestrator.sendMessage(id, "try again");
		expect(result.status).toBe("completed");
	});

	it("does not persist any message when the conversation lookup fails before the guard is set", async () => {
		await expect(orchestrator.sendMessage("nope", "hi")).rejects.toThrow();
		expect(orchestrator.isGeneralChatRunning("nope")).toBe(false);
	});
});

// ── sendMessage — desktop notification gating ────────────────────────────────

describe("sendMessage — desktop notification", () => {
	it("sends a notification when the app is not focused and the setting is enabled (default)", async () => {
		const id = await createConversation();
		seedProvider();
		appFocused = false;

		await orchestrator.sendMessage(id, "hi");
		expect(notificationCalls.length).toBe(1);
	});

	it("does not send a notification when the app is focused", async () => {
		const id = await createConversation();
		seedProvider();
		appFocused = true;

		await orchestrator.sendMessage(id, "hi");
		expect(notificationCalls.length).toBe(0);
	});

	it("does not send a notification when the setting is explicitly disabled", async () => {
		const id = await createConversation();
		seedProvider();
		appFocused = false;
		getSettingImpl = async (key) => (key === "session_complete_notification" ? false : null);

		await orchestrator.sendMessage(id, "hi");
		expect(notificationCalls.length).toBe(0);
	});
});

// ── stop / isRunning ─────────────────────────────────────────────────────────

describe("stopGeneralChatGeneration / isGeneralChatRunning", () => {
	it("reports not running for an unknown conversation", () => {
		expect(orchestrator.isGeneralChatRunning("unknown")).toBe(false);
	});

	it("is a no-op for an unknown conversation (does not throw)", () => {
		expect(() => orchestrator.stopGeneralChatGeneration("unknown")).not.toThrow();
	});

	it("aborts the signal passed to runInlineAgent and reports running while in flight", async () => {
		const id = await createConversation();
		seedProvider();

		let capturedSignal: AbortSignal | undefined;
		let resolveRun: ((r: MockRunResult) => void) | undefined;
		runInlineAgentImpl = (opts) => {
			capturedSignal = opts.abortSignal;
			return new Promise((resolve) => {
				resolveRun = resolve;
			});
		};

		const pending = orchestrator.sendMessage(id, "long running task");
		// Let the guard-setting await (the conversation lookup) flush before checking state.
		await new Promise((r) => setTimeout(r, 20));

		expect(orchestrator.isGeneralChatRunning(id)).toBe(true);
		orchestrator.stopGeneralChatGeneration(id);
		expect(capturedSignal?.aborted).toBe(true);

		// Unblock the hanging mock so the test can clean up without leaking a dangling promise.
		resolveRun?.({
			status: "cancelled",
			summary: "",
			filesModified: [],
			tokensUsed: { prompt: 0, completion: 0, total: 0 },
			messageIds: [],
		});
		await pending;
		expect(orchestrator.isGeneralChatRunning(id)).toBe(false);
	});
});

// ── sendMessage — concurrency guard ──────────────────────────────────────────

describe("sendMessage — concurrency guard", () => {
	it("rejects a second call for the same conversation while one is in flight", async () => {
		const id = await createConversation();
		seedProvider();

		let resolveRun: ((r: MockRunResult) => void) | undefined;
		runInlineAgentImpl = () =>
			new Promise((resolve) => {
				resolveRun = resolve;
			});

		const first = orchestrator.sendMessage(id, "first");
		await new Promise((r) => setTimeout(r, 20));

		await expect(orchestrator.sendMessage(id, "second")).rejects.toThrow(/already being generated/i);

		resolveRun?.({
			status: "completed",
			summary: "done",
			filesModified: [],
			tokensUsed: { prompt: 1, completion: 1, total: 2 },
			messageIds: [],
		});
		await first;
	});

	it("allows concurrent calls for two different conversations", async () => {
		const idA = await createConversation();
		const idB = await createConversation();
		seedProvider();

		const [resultA, resultB] = await Promise.all([
			orchestrator.sendMessage(idA, "hi A"),
			orchestrator.sendMessage(idB, "hi B"),
		]);
		expect(resultA.status).toBe("completed");
		expect(resultB.status).toBe("completed");
	});
});

// ── compactConversation ───────────────────────────────────────────────────────

describe("compactConversation", () => {
	async function seedMessages(conversationId: string, count: number) {
		const now = Date.now();
		const rows = Array.from({ length: count }, (_, i) => ({
			conversationId,
			role: i % 2 === 0 ? "user" : "assistant",
			content: `Message ${i}`,
			createdAt: new Date(now + i * 1000).toISOString(),
		}));
		await testDb.insert(generalChatMessages).values(rows);
	}

	it("refuses to compact when there aren't enough messages", async () => {
		const id = await createConversation();
		seedProvider();
		await seedMessages(id, 5); // <= COMPACT_KEEP_RECENT (10)

		const result = await orchestrator.compactConversation(id);
		expect(result.success).toBe(false);
		expect(result.message).toContain("Not enough messages");

		const rows = await getMessages(id);
		expect(rows.length).toBe(5); // untouched
	});

	it("compacts older messages into a single summary, keeping the most recent 10", async () => {
		const id = await createConversation();
		seedProvider();
		await seedMessages(id, 15);
		generateTextImpl = async () => ({ text: "Condensed summary." });

		const result = await orchestrator.compactConversation(id);
		expect(result.success).toBe(true);

		const rows = await getMessages(id);
		// 10 kept originals + 1 new summary row
		expect(rows.length).toBe(11);
		const summaryRow = rows.find((r) => r.content.startsWith("## Conversation summary (compacted)"));
		expect(summaryRow).toBeDefined();
		expect(summaryRow?.content).toContain("Condensed summary.");
		expect(summaryRow?.role).toBe("assistant");

		expect(eventsFor("generalChatCompacted").length).toBe(1);
	});

	it("returns success:false and leaves messages untouched when the summary is empty", async () => {
		const id = await createConversation();
		seedProvider();
		await seedMessages(id, 15);
		generateTextImpl = async () => ({ text: "   " });

		const result = await orchestrator.compactConversation(id);
		expect(result.success).toBe(false);
		expect(result.message).toContain("empty");

		const rows = await getMessages(id);
		expect(rows.length).toBe(15); // untouched — deletion only happens after a non-empty summary
	});
});
