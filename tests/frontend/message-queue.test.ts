/**
 * message-queue.test.ts
 *
 * Tests for src/mainview/stores/message-queue.ts — the frontend half of the
 * message-queue redesign. This store is now a thin, staleness-guarded MIRROR
 * of the server-side queue (src/bun/message-queue-manager.ts); delivery
 * itself is backend-driven. These tests guard the mirror's own invariant:
 * an RPC response or broadcast for a project/conversation the user has since
 * switched away from must never be applied to whatever is now displayed.
 *
 * rpc is mocked — no real Electrobun/network access.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";

let enqueueImpl: (projectId: string, conversationId: string, content: string) => Promise<{ success: boolean; queue: unknown[] }>;
let getQueuedMessagesImpl: (projectId: string, conversationId: string) => Promise<unknown[]>;
let removeQueuedMessageImpl: (projectId: string, conversationId: string, messageId: string) => Promise<{ success: boolean; queue: unknown[] }>;
let clearQueuedMessagesImpl: (projectId: string, conversationId: string) => Promise<{ success: boolean }>;

mock.module("../../src/mainview/lib/rpc", () => ({
	rpc: {
		enqueueMessage: (p: string, c: string, content: string) => enqueueImpl(p, c, content),
		getQueuedMessages: (p: string, c: string) => getQueuedMessagesImpl(p, c),
		removeQueuedMessage: (p: string, c: string, id: string) => removeQueuedMessageImpl(p, c, id),
		clearQueuedMessages: (p: string, c: string) => clearQueuedMessagesImpl(p, c),
	},
}));

const { useMessageQueueStore } = await import("../../src/mainview/stores/message-queue");

function msg(id: string, conversationId: string, content: string) {
	return { id, conversationId, content, queuedAt: Date.now() };
}

beforeEach(() => {
	useMessageQueueStore.setState({ queue: [], activeProjectId: null, activeConversationId: null });
	enqueueImpl = async () => ({ success: true, queue: [] });
	getQueuedMessagesImpl = async () => [];
	removeQueuedMessageImpl = async () => ({ success: true, queue: [] });
	clearQueuedMessagesImpl = async () => ({ success: true });
});

// ---------------------------------------------------------------------------
// loadQueue
// ---------------------------------------------------------------------------

describe("loadQueue", () => {
	it("fetches and applies the queue for the given project+conversation", async () => {
		getQueuedMessagesImpl = async (p, c) => [msg("q1", c, "hello")];
		await useMessageQueueStore.getState().loadQueue("project-A", "conv-A");
		expect(useMessageQueueStore.getState().queue.map((m) => m.content)).toEqual(["hello"]);
		expect(useMessageQueueStore.getState().activeProjectId).toBe("project-A");
		expect(useMessageQueueStore.getState().activeConversationId).toBe("conv-A");
	});

	it("shows an empty queue immediately for a falsy conversationId (not yet selected)", async () => {
		useMessageQueueStore.setState({ queue: [msg("stale", "conv-old", "leftover")] });
		await useMessageQueueStore.getState().loadQueue("project-A", null);
		expect(useMessageQueueStore.getState().queue).toEqual([]);
		expect(useMessageQueueStore.getState().activeConversationId).toBeNull();
	});

	it("drops a late-resolving fetch for a conversation switched away from", async () => {
		let resolveA!: (rows: unknown[]) => void;
		getQueuedMessagesImpl = (p, c) => {
			if (c === "conv-A") return new Promise((resolve) => { resolveA = resolve; });
			return Promise.resolve([msg("qB", c, "B's queue")]);
		};

		const loadA = useMessageQueueStore.getState().loadQueue("project-1", "conv-A");
		await useMessageQueueStore.getState().loadQueue("project-1", "conv-B");
		expect(useMessageQueueStore.getState().queue.map((m) => m.content)).toEqual(["B's queue"]);

		resolveA([msg("qA-stale", "conv-A", "stale A content")]);
		await loadA;

		// Before the fix (old frontend-only queue with no per-conversation
		// tagging), there was no mechanism to even ask this question — the
		// queue was a single flat array. This guards the new mirror's own guard.
		expect(useMessageQueueStore.getState().queue.map((m) => m.content)).toEqual(["B's queue"]);
	});
});

// ---------------------------------------------------------------------------
// enqueue / remove / clear — must only apply to the currently-displayed conversation
// ---------------------------------------------------------------------------

describe("enqueue", () => {
	it("applies the returned queue when still viewing that project+conversation", async () => {
		useMessageQueueStore.setState({ activeProjectId: "p1", activeConversationId: "c1" });
		enqueueImpl = async () => ({ success: true, queue: [msg("q1", "c1", "queued msg")] });

		const ok = await useMessageQueueStore.getState().enqueue("p1", "c1", "queued msg");
		expect(ok).toBe(true);
		expect(useMessageQueueStore.getState().queue.map((m) => m.content)).toEqual(["queued msg"]);
	});

	it("does not apply the result if the user switched conversation before the RPC resolved", async () => {
		useMessageQueueStore.setState({ activeProjectId: "p1", activeConversationId: "c1" });
		let resolveEnqueue!: (r: { success: boolean; queue: unknown[] }) => void;
		enqueueImpl = () => new Promise((resolve) => { resolveEnqueue = resolve; });

		const promise = useMessageQueueStore.getState().enqueue("p1", "c1", "text");
		// User switches to a different conversation while the RPC is in flight.
		useMessageQueueStore.setState({ activeConversationId: "c2" });
		resolveEnqueue({ success: true, queue: [msg("q1", "c1", "text")] });
		await promise;

		// c1's queue result must not stamp itself over whatever c2 is showing.
		expect(useMessageQueueStore.getState().queue).toEqual([]);
	});

	it("returns false when the server reports the queue is full, without mutating local state", async () => {
		useMessageQueueStore.setState({ activeProjectId: "p1", activeConversationId: "c1", queue: [msg("a", "c1", "a"), msg("b", "c1", "b"), msg("c", "c1", "c")] });
		enqueueImpl = async () => ({ success: false, queue: [msg("a", "c1", "a"), msg("b", "c1", "b"), msg("c", "c1", "c")] });

		const ok = await useMessageQueueStore.getState().enqueue("p1", "c1", "overflow");
		expect(ok).toBe(false);
		expect(useMessageQueueStore.getState().queue.length).toBe(3);
	});
});

describe("remove", () => {
	it("applies the updated queue when still viewing that conversation", async () => {
		useMessageQueueStore.setState({ activeProjectId: "p1", activeConversationId: "c1", queue: [msg("a", "c1", "a"), msg("b", "c1", "b")] });
		removeQueuedMessageImpl = async () => ({ success: true, queue: [msg("b", "c1", "b")] });

		await useMessageQueueStore.getState().remove("p1", "c1", "a");
		expect(useMessageQueueStore.getState().queue.map((m) => m.id)).toEqual(["b"]);
	});

	it("ignores the result if the user navigated away before the RPC resolved", async () => {
		useMessageQueueStore.setState({ activeProjectId: "p1", activeConversationId: "c1", queue: [msg("a", "c1", "a")] });
		let resolveRemove!: (r: { success: boolean; queue: unknown[] }) => void;
		removeQueuedMessageImpl = () => new Promise((resolve) => { resolveRemove = resolve; });

		const promise = useMessageQueueStore.getState().remove("p1", "c1", "a");
		useMessageQueueStore.setState({ activeProjectId: "p2", activeConversationId: "c-other" });
		resolveRemove({ success: true, queue: [] });
		await promise;

		// p2/c-other's queue (empty in this test) must not get clobbered by p1/c1's result.
		expect(useMessageQueueStore.getState().activeProjectId).toBe("p2");
	});
});

describe("clear", () => {
	it("optimistically clears the local queue immediately when viewing that conversation", async () => {
		useMessageQueueStore.setState({ activeProjectId: "p1", activeConversationId: "c1", queue: [msg("a", "c1", "a")] });
		let resolveClear!: () => void;
		clearQueuedMessagesImpl = () => new Promise((resolve) => { resolveClear = () => resolve({ success: true }); });

		const promise = useMessageQueueStore.getState().clear("p1", "c1");
		// Cleared immediately, before the RPC round-trip even completes.
		expect(useMessageQueueStore.getState().queue).toEqual([]);

		resolveClear();
		await promise;
	});

	it("does not blank a different conversation's queue if switched away before calling clear resolves", async () => {
		useMessageQueueStore.setState({ activeProjectId: "p1", activeConversationId: "c-other", queue: [msg("keep", "c-other", "keep me")] });

		// Calling clear for a DIFFERENT (stale) project/conversation than what's
		// currently displayed must not touch the currently-displayed queue.
		await useMessageQueueStore.getState().clear("p1", "c1");

		expect(useMessageQueueStore.getState().queue.map((m) => m.id)).toEqual(["keep"]);
	});
});

// ---------------------------------------------------------------------------
// applyBroadcast
// ---------------------------------------------------------------------------

describe("applyBroadcast", () => {
	it("applies an update for the currently-displayed project+conversation", () => {
		useMessageQueueStore.setState({ activeProjectId: "p1", activeConversationId: "c1" });
		useMessageQueueStore.getState().applyBroadcast("p1", "c1", [msg("new", "c1", "auto-sent notice")]);
		expect(useMessageQueueStore.getState().queue.map((m) => m.id)).toEqual(["new"]);
	});

	it("ignores a broadcast for a project the user isn't currently viewing", () => {
		useMessageQueueStore.setState({ activeProjectId: "p1", activeConversationId: "c1", queue: [msg("mine", "c1", "mine")] });
		useMessageQueueStore.getState().applyBroadcast("p-other", "c-other", [msg("theirs", "c-other", "theirs")]);
		expect(useMessageQueueStore.getState().queue.map((m) => m.id)).toEqual(["mine"]);
	});

	it("ignores a broadcast for a different conversation within the SAME project", () => {
		useMessageQueueStore.setState({ activeProjectId: "p1", activeConversationId: "c1", queue: [msg("mine", "c1", "mine")] });
		useMessageQueueStore.getState().applyBroadcast("p1", "c2", [msg("theirs", "c2", "theirs")]);
		expect(useMessageQueueStore.getState().queue.map((m) => m.id)).toEqual(["mine"]);
	});
});
