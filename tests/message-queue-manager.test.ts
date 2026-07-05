/**
 * message-queue-manager.test.ts
 *
 * Tests for src/bun/message-queue-manager.ts — the server-side, per-project
 * per-conversation message queue introduced to fix a cross-project bug: the
 * OLD frontend-only queue (src/mainview/stores/message-queue.ts, pre-redesign)
 * carried no project/conversation tag and was silently DISCARDED whenever the
 * user switched conversations, instead of being delivered to the conversation
 * it was queued for. These tests guard the new design's core invariant:
 * queues for different projects/conversations must never interfere with each
 * other, and must survive independently of whatever the frontend is viewing.
 *
 * No external dependencies — all logic is pure in-memory Maps.
 */

import { describe, it, expect } from "bun:test";
import {
	enqueueMessage,
	dequeueMessage,
	removeQueuedMessage,
	getQueuedMessages,
	clearQueueForConversation,
	clearQueueForProject,
	MESSAGE_QUEUE_MAX,
} from "../src/bun/message-queue-manager";

// Every test uses fresh, randomly-generated project/conversation ids so the
// shared module-level `queues` map can't leak state between tests.
function ids() {
	return { projectId: crypto.randomUUID(), conversationId: crypto.randomUUID() };
}

// ---------------------------------------------------------------------------
// enqueueMessage / getQueuedMessages
// ---------------------------------------------------------------------------

describe("enqueueMessage", () => {
	it("adds a message and returns it", () => {
		const { projectId, conversationId } = ids();
		const msg = enqueueMessage(projectId, conversationId, "hello");
		expect(msg).not.toBeNull();
		expect(msg!.content).toBe("hello");
		expect(msg!.conversationId).toBe(conversationId);
		expect(getQueuedMessages(projectId, conversationId)).toEqual([msg!]);
	});

	it("preserves FIFO order across multiple enqueues", () => {
		const { projectId, conversationId } = ids();
		enqueueMessage(projectId, conversationId, "first");
		enqueueMessage(projectId, conversationId, "second");
		enqueueMessage(projectId, conversationId, "third");
		const queue = getQueuedMessages(projectId, conversationId);
		expect(queue.map((m) => m.content)).toEqual(["first", "second", "third"]);
	});

	it("rejects once MESSAGE_QUEUE_MAX is reached, without mutating the queue", () => {
		const { projectId, conversationId } = ids();
		for (let i = 0; i < MESSAGE_QUEUE_MAX; i++) {
			expect(enqueueMessage(projectId, conversationId, `msg-${i}`)).not.toBeNull();
		}
		const rejected = enqueueMessage(projectId, conversationId, "overflow");
		expect(rejected).toBeNull();
		expect(getQueuedMessages(projectId, conversationId).length).toBe(MESSAGE_QUEUE_MAX);
	});

	it("getQueuedMessages returns a snapshot copy, not a live reference", () => {
		const { projectId, conversationId } = ids();
		enqueueMessage(projectId, conversationId, "one");
		const snapshot = getQueuedMessages(projectId, conversationId);
		snapshot.push({ id: "fake", conversationId, content: "injected", queuedAt: 0 });
		// Mutating the returned array must not affect the real queue.
		expect(getQueuedMessages(projectId, conversationId).length).toBe(1);
	});

	it("getQueuedMessages returns an empty array for an unknown project/conversation", () => {
		const { projectId, conversationId } = ids();
		expect(getQueuedMessages(projectId, conversationId)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// dequeueMessage
// ---------------------------------------------------------------------------

describe("dequeueMessage", () => {
	it("returns null for an empty/unknown queue", () => {
		const { projectId, conversationId } = ids();
		expect(dequeueMessage(projectId, conversationId)).toBeNull();
	});

	it("removes and returns the oldest message (FIFO)", () => {
		const { projectId, conversationId } = ids();
		enqueueMessage(projectId, conversationId, "first");
		enqueueMessage(projectId, conversationId, "second");
		const dequeued = dequeueMessage(projectId, conversationId);
		expect(dequeued!.content).toBe("first");
		expect(getQueuedMessages(projectId, conversationId).map((m) => m.content)).toEqual(["second"]);
	});

	it("draining one message frees a capacity slot", () => {
		const { projectId, conversationId } = ids();
		for (let i = 0; i < MESSAGE_QUEUE_MAX; i++) enqueueMessage(projectId, conversationId, `m${i}`);
		expect(enqueueMessage(projectId, conversationId, "blocked")).toBeNull();
		dequeueMessage(projectId, conversationId);
		expect(enqueueMessage(projectId, conversationId, "now fits")).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// removeQueuedMessage
// ---------------------------------------------------------------------------

describe("removeQueuedMessage", () => {
	it("removes a specific message by id, leaving the others in order", () => {
		const { projectId, conversationId } = ids();
		const a = enqueueMessage(projectId, conversationId, "a")!;
		const b = enqueueMessage(projectId, conversationId, "b")!;
		const c = enqueueMessage(projectId, conversationId, "c")!;
		const removed = removeQueuedMessage(projectId, conversationId, b.id);
		expect(removed).toBe(true);
		expect(getQueuedMessages(projectId, conversationId).map((m) => m.id)).toEqual([a.id, c.id]);
	});

	it("returns false for an id that doesn't exist", () => {
		const { projectId, conversationId } = ids();
		enqueueMessage(projectId, conversationId, "a");
		expect(removeQueuedMessage(projectId, conversationId, "no-such-id")).toBe(false);
	});

	it("returns false for a conversation that was never enqueued into", () => {
		const { projectId, conversationId } = ids();
		expect(removeQueuedMessage(projectId, conversationId, "anything")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Cross-project / cross-conversation isolation — the core regression guard.
// This is the exact property that was MISSING in the old frontend-only queue.
// ---------------------------------------------------------------------------

describe("cross-project and cross-conversation isolation", () => {
	it("two different projects' queues never mix", () => {
		const a = ids();
		const b = ids();
		enqueueMessage(a.projectId, a.conversationId, "for project A");
		enqueueMessage(b.projectId, b.conversationId, "for project B");

		expect(getQueuedMessages(a.projectId, a.conversationId).map((m) => m.content)).toEqual(["for project A"]);
		expect(getQueuedMessages(b.projectId, b.conversationId).map((m) => m.content)).toEqual(["for project B"]);
	});

	it("two different conversations within the SAME project never mix", () => {
		const projectId = crypto.randomUUID();
		const convX = crypto.randomUUID();
		const convY = crypto.randomUUID();
		enqueueMessage(projectId, convX, "queued in X");
		enqueueMessage(projectId, convY, "queued in Y");

		expect(getQueuedMessages(projectId, convX).map((m) => m.content)).toEqual(["queued in X"]);
		expect(getQueuedMessages(projectId, convY).map((m) => m.content)).toEqual(["queued in Y"]);
	});

	it("dequeuing from one conversation does not touch a sibling conversation's queue", () => {
		const projectId = crypto.randomUUID();
		const convX = crypto.randomUUID();
		const convY = crypto.randomUUID();
		enqueueMessage(projectId, convX, "x1");
		enqueueMessage(projectId, convY, "y1");

		dequeueMessage(projectId, convX);

		expect(getQueuedMessages(projectId, convX)).toEqual([]);
		expect(getQueuedMessages(projectId, convY).map((m) => m.content)).toEqual(["y1"]);
	});

	it("filling project A's queue to MAX does not block project B's queue", () => {
		const a = ids();
		const b = ids();
		for (let i = 0; i < MESSAGE_QUEUE_MAX; i++) enqueueMessage(a.projectId, a.conversationId, `a${i}`);
		expect(enqueueMessage(a.projectId, a.conversationId, "overflow")).toBeNull();
		// B is a completely independent queue — must still accept messages.
		expect(enqueueMessage(b.projectId, b.conversationId, "b0")).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// clearQueueForConversation / clearQueueForProject
// ---------------------------------------------------------------------------

describe("clearQueueForConversation", () => {
	it("clears only the named conversation, leaving sibling conversations in the same project intact", () => {
		const projectId = crypto.randomUUID();
		const convX = crypto.randomUUID();
		const convY = crypto.randomUUID();
		enqueueMessage(projectId, convX, "x1");
		enqueueMessage(projectId, convY, "y1");

		clearQueueForConversation(projectId, convX);

		expect(getQueuedMessages(projectId, convX)).toEqual([]);
		expect(getQueuedMessages(projectId, convY).map((m) => m.content)).toEqual(["y1"]);
	});

	it("is a no-op for a conversation with no queue", () => {
		const { projectId, conversationId } = ids();
		expect(() => clearQueueForConversation(projectId, conversationId)).not.toThrow();
	});
});

describe("clearQueueForProject", () => {
	it("clears every conversation's queue within that project", () => {
		const projectId = crypto.randomUUID();
		const convX = crypto.randomUUID();
		const convY = crypto.randomUUID();
		enqueueMessage(projectId, convX, "x1");
		enqueueMessage(projectId, convY, "y1");

		clearQueueForProject(projectId);

		expect(getQueuedMessages(projectId, convX)).toEqual([]);
		expect(getQueuedMessages(projectId, convY)).toEqual([]);
	});

	it("does not affect a different project's queue (engine eviction/reset isolation)", () => {
		const a = ids();
		const b = ids();
		enqueueMessage(a.projectId, a.conversationId, "keep-a");
		enqueueMessage(b.projectId, b.conversationId, "keep-b");

		// Mirrors removeEngine()/handleReset() clearing ONLY the project being
		// evicted/reset — a background project's queue must survive untouched.
		clearQueueForProject(a.projectId);

		expect(getQueuedMessages(a.projectId, a.conversationId)).toEqual([]);
		expect(getQueuedMessages(b.projectId, b.conversationId).map((m) => m.content)).toEqual(["keep-b"]);
	});

	it("is a no-op for a project with no queues", () => {
		const { projectId } = ids();
		expect(() => clearQueueForProject(projectId)).not.toThrow();
	});
});
