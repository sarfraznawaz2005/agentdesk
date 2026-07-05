/**
 * chat-store.test.ts
 *
 * Tests for src/mainview/stores/chat-store.ts covering the cross-project /
 * cross-conversation staleness guards fixed this session:
 *   - loadMessages() must drop a late-resolving fetch for a conversation the
 *     user has since switched away from (previously, a slow fetch for
 *     conversation A could land after switching to B and silently blank/
 *     overwrite B's messages — the "recent conversation + last prompt vanish"
 *     bug).
 *   - setActiveConversation() must reset in-flight streaming state on a
 *     genuine switch, but NOT wipe pendingConversationTarget.
 *   - reset() must preserve activeProjectId/drafts/pendingConversationTarget
 *     (it runs on every project-switch mount) while clearing conversation data.
 *
 * rpc is mocked — no real Electrobun/network/DB access.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";
import "../helpers/dom-shim";

// ---------------------------------------------------------------------------
// Mock rpc BEFORE importing chat-store (and chat-event-handlers, which it
// pulls in transitively) so nothing tries a real Electrobun RPC call.
// ---------------------------------------------------------------------------

let getMessagesImpl: (conversationId: string) => Promise<unknown[]> = async () => [];

mock.module("../../src/mainview/lib/rpc", () => ({
	rpc: {
		getConversations: async () => [],
		getMessages: (conversationId: string) => getMessagesImpl(conversationId),
		createConversation: async () => ({ id: "new-conv", title: "New conversation", reused: false }),
		deleteConversation: async () => ({ success: true }),
		clearConversationMessages: async () => ({ success: true }),
		deleteMessage: async () => ({ success: true }),
		branchConversation: async () => ({ id: "branch-conv", title: "Branch" }),
		renameConversation: async () => ({ success: true }),
		pinConversation: async () => ({ success: true }),
		sendMessage: async () => ({ messageId: "m1", userMessageId: "u1" }),
		stopGeneration: async () => ({ success: true }),
		stopAgent: async () => ({ success: true }),
		getRunningAgents: async () => [],
		getPmStatus: async () => ({ processing: false }),
		getPendingApprovals: async () => ({ shell: [], question: [] }),
	},
}));

const { useChatStore } = await import("../../src/mainview/stores/chat-store");

beforeEach(() => {
	useChatStore.getState().reset();
	// reset() intentionally preserves activeProjectId/drafts/pendingConversationTarget
	// across calls (that's the behavior under test) — clear them explicitly
	// between tests so one test can't leak state into the next.
	useChatStore.setState({ activeProjectId: null, drafts: {}, pendingConversationTarget: null });
	getMessagesImpl = async () => [];
});

// ---------------------------------------------------------------------------
// loadMessages — staleness guard
// ---------------------------------------------------------------------------

describe("loadMessages", () => {
	it("applies the result when still viewing the requested conversation", async () => {
		useChatStore.setState({ activeConversationId: "conv-A" });
		getMessagesImpl = async () => [
			{ id: "m1", conversationId: "conv-A", role: "user", agentId: null, agentName: null, content: "hi", metadata: null, tokenCount: 0, hasParts: 0, createdAt: "", seq: 1 },
		];
		await useChatStore.getState().loadMessages("conv-A");
		expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(["hi"]);
	});

	it("drops a late-resolving fetch for a conversation switched away from (THE FIX)", async () => {
		useChatStore.setState({ activeConversationId: "conv-A" });

		// Simulate a slow fetch for conv-A that resolves AFTER the user has
		// already switched to conv-B.
		let resolveA!: (rows: unknown[]) => void;
		getMessagesImpl = (conversationId: string) => {
			if (conversationId === "conv-A") {
				return new Promise((resolve) => { resolveA = resolve; });
			}
			return Promise.resolve([
				{ id: "mB", conversationId: "conv-B", role: "user", agentId: null, agentName: null, content: "B's message", metadata: null, tokenCount: 0, hasParts: 0, createdAt: "", seq: 1 },
			]);
		};

		const loadA = useChatStore.getState().loadMessages("conv-A"); // in flight, not yet resolved

		// User switches to conv-B and its (faster) fetch completes first.
		useChatStore.getState().setActiveConversation("conv-B");
		await useChatStore.getState().loadMessages("conv-B");
		expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(["B's message"]);

		// NOW the stale conv-A fetch resolves. Before the fix, this would
		// silently overwrite B's messages (or blank them) since nothing
		// checked whether conv-A was still the active conversation.
		resolveA([
			{ id: "mA", conversationId: "conv-A", role: "user", agentId: null, agentName: null, content: "A's stale message", metadata: null, tokenCount: 0, hasParts: 0, createdAt: "", seq: 1 },
		]);
		await loadA;

		expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(["B's message"]);
	});

	it("a stale call's finally does NOT clear messagesLoading — only the current conversation's own fetch may", async () => {
		// Real usage always pairs setActiveConversation(id) with loadMessages(id)
		// (see chat-layout.tsx's handleSelectConversation) — so B's own fetch is
		// what's responsible for settling messagesLoading, not A's leftover call.
		// If the stale call's `finally` cleared the flag unconditionally, it could
		// race ahead of B's still-in-flight fetch and hide B's loading spinner
		// prematurely.
		useChatStore.setState({ activeConversationId: "conv-A" });
		let resolveA!: (rows: unknown[]) => void;
		let resolveB!: (rows: unknown[]) => void;
		getMessagesImpl = (conversationId: string) =>
			new Promise((resolve) => {
				if (conversationId === "conv-A") resolveA = resolve;
				else resolveB = resolve;
			});

		const loadA = useChatStore.getState().loadMessages("conv-A");
		useChatStore.getState().setActiveConversation("conv-B");
		const loadB = useChatStore.getState().loadMessages("conv-B");
		expect(useChatStore.getState().messagesLoading).toBe(true);

		// Stale A resolves first — must NOT clear the flag (B's fetch is still pending).
		resolveA([]);
		await loadA;
		expect(useChatStore.getState().messagesLoading).toBe(true);

		// B's own (current) fetch resolves — now it correctly clears.
		resolveB([]);
		await loadB;
		expect(useChatStore.getState().messagesLoading).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// setActiveConversation
// ---------------------------------------------------------------------------

describe("setActiveConversation", () => {
	it("resets in-flight streaming state on a genuine conversation switch", () => {
		useChatStore.setState({
			activeConversationId: "conv-A",
			isStreaming: true,
			streamingMessageId: "m1",
			streamingContent: "partial reply...",
			pmThinkingText: "thinking...",
			liveContextTokens: 500,
			liveContextLimit: 100_000,
		});

		useChatStore.getState().setActiveConversation("conv-B");

		const state = useChatStore.getState();
		expect(state.activeConversationId).toBe("conv-B");
		expect(state.isStreaming).toBe(false);
		expect(state.streamingMessageId).toBeNull();
		expect(state.streamingContent).toBe("");
		expect(state.pmThinkingText).toBe("");
		expect(state.liveContextTokens).toBe(0);
		expect(state.liveContextLimit).toBe(0);
	});

	it("calling with the SAME id only resets the context meter, not streaming state", () => {
		useChatStore.setState({
			activeConversationId: "conv-A",
			isStreaming: true,
			streamingContent: "still going",
		});

		useChatStore.getState().setActiveConversation("conv-A");

		const state = useChatStore.getState();
		// Same-id call is a remount/no-op for identity purposes — must NOT
		// interrupt an in-progress stream for the conversation still being viewed.
		expect(state.isStreaming).toBe(true);
		expect(state.streamingContent).toBe("still going");
		expect(state.liveContextTokens).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// reset() — what survives a project switch
// ---------------------------------------------------------------------------

describe("reset", () => {
	it("preserves activeProjectId across reset (ProjectPage owns it via setActiveProject)", () => {
		useChatStore.getState().setActiveProject("project-A");
		useChatStore.setState({ conversations: [{ id: "c1", projectId: "project-A", title: "x", isPinned: false, isArchived: false, createdAt: "", updatedAt: "" }] });

		useChatStore.getState().reset();

		expect(useChatStore.getState().activeProjectId).toBe("project-A");
		expect(useChatStore.getState().conversations).toEqual([]);
	});

	it("preserves drafts across reset", () => {
		useChatStore.getState().setDraft("conv-A", "unsent text");
		useChatStore.getState().reset();
		expect(useChatStore.getState().drafts["conv-A"]).toBe("unsent text");
	});

	it("preserves pendingConversationTarget across reset — critical for the cross-project approval toast", () => {
		// This is exactly the scenario the toast's "Open" button triggers:
		// setPendingConversationTarget() is called, then navigation causes
		// ProjectPage to mount for the new project, which calls resetChat()
		// (reset()) BEFORE its own conversation-loading effect ever gets a
		// chance to consume the pending target. If reset() didn't preserve
		// it, the target would be silently wiped before it could be used.
		useChatStore.getState().setPendingConversationTarget({ projectId: "project-B", conversationId: "conv-waiting" });

		useChatStore.getState().reset();

		expect(useChatStore.getState().pendingConversationTarget).toEqual({
			projectId: "project-B",
			conversationId: "conv-waiting",
		});
	});

	it("clears activeConversationId, messages, and streaming state", () => {
		useChatStore.setState({
			activeConversationId: "conv-A",
			messages: [{ id: "m1", conversationId: "conv-A", role: "user", agentId: null, agentName: null, content: "hi", metadata: null, tokenCount: 0, hasParts: 0, createdAt: "" }],
			isStreaming: true,
		});

		useChatStore.getState().reset();

		const state = useChatStore.getState();
		expect(state.activeConversationId).toBeNull();
		expect(state.messages).toEqual([]);
		expect(state.isStreaming).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// pendingConversationTarget
// ---------------------------------------------------------------------------

describe("setPendingConversationTarget", () => {
	it("sets the target", () => {
		useChatStore.getState().setPendingConversationTarget({ projectId: "p1", conversationId: "c1" });
		expect(useChatStore.getState().pendingConversationTarget).toEqual({ projectId: "p1", conversationId: "c1" });
	});

	it("clears the target when passed null (consumed by ProjectPage's auto-select effect)", () => {
		useChatStore.getState().setPendingConversationTarget({ projectId: "p1", conversationId: "c1" });
		useChatStore.getState().setPendingConversationTarget(null);
		expect(useChatStore.getState().pendingConversationTarget).toBeNull();
	});
});
