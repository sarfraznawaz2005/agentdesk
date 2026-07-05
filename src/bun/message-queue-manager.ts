// ---------------------------------------------------------------------------
// Server-side message queue — messages typed while a conversation's PM/agents
// are busy. Kept here (not in the frontend Zustand store) so a queued message
// still gets delivered to the RIGHT project+conversation once idle, no matter
// what the user is currently viewing. Draining is driven from engine-manager's
// idle-check (onStreamComplete/onStreamError), not from any mounted component.
//
// In-memory only (matches runningAgentControllers/sessionHadAgentActivity —
// none of engine-manager's per-project run state survives a restart either).
// ---------------------------------------------------------------------------

export interface QueuedMessage {
	id: string;
	conversationId: string;
	content: string;
	queuedAt: number;
}

export const MESSAGE_QUEUE_MAX = 3;

// projectId -> conversationId -> queue
const queues = new Map<string, Map<string, QueuedMessage[]>>();

function getList(projectId: string, conversationId: string, create: true): QueuedMessage[];
function getList(projectId: string, conversationId: string, create: false): QueuedMessage[] | undefined;
function getList(projectId: string, conversationId: string, create: boolean): QueuedMessage[] | undefined {
	let byConv = queues.get(projectId);
	if (!byConv) {
		if (!create) return undefined;
		byConv = new Map();
		queues.set(projectId, byConv);
	}
	let list = byConv.get(conversationId);
	if (!list && create) {
		list = [];
		byConv.set(conversationId, list);
	}
	return list;
}

/** Enqueue a message. Returns null if the queue for this conversation is already full. */
export function enqueueMessage(projectId: string, conversationId: string, content: string): QueuedMessage | null {
	const list = getList(projectId, conversationId, true);
	if (list.length >= MESSAGE_QUEUE_MAX) return null;
	const msg: QueuedMessage = { id: `q-${crypto.randomUUID()}`, conversationId, content, queuedAt: Date.now() };
	list.push(msg);
	return msg;
}

/** Remove and return the oldest queued message for a conversation, or null if empty. */
export function dequeueMessage(projectId: string, conversationId: string): QueuedMessage | null {
	const list = getList(projectId, conversationId, false);
	if (!list || list.length === 0) return null;
	return list.shift() ?? null;
}

/** Remove one specific queued message by id. Returns true if it was found and removed. */
export function removeQueuedMessage(projectId: string, conversationId: string, messageId: string): boolean {
	const list = getList(projectId, conversationId, false);
	if (!list) return false;
	const idx = list.findIndex((m) => m.id === messageId);
	if (idx === -1) return false;
	list.splice(idx, 1);
	return true;
}

/** Current queue snapshot for a conversation (empty array if none). */
export function getQueuedMessages(projectId: string, conversationId: string): QueuedMessage[] {
	return getList(projectId, conversationId, false)?.slice() ?? [];
}

/** Drop the entire queue for one conversation (e.g. on Clear Chat / delete). */
export function clearQueueForConversation(projectId: string, conversationId: string): void {
	queues.get(projectId)?.delete(conversationId);
}

/** Drop every conversation's queue for a project (e.g. on project reset/delete/engine eviction). */
export function clearQueueForProject(projectId: string): void {
	queues.delete(projectId);
}
