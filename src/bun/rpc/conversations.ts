import { eq, and, asc, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { conversations, messages, conversationSummaries, messageParts } from "../db/schema";
import { logAudit } from "../db/audit";

export interface ConversationListItem {
	id: string;
	projectId: string;
	title: string;
	isPinned: boolean;
	isArchived: boolean;
	createdAt: string;
	updatedAt: string;
}

/**
 * Return non-archived conversations for a given project.
 */
export async function getConversations(
	projectId: string,
): Promise<ConversationListItem[]> {
	const rows = await db
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.projectId, projectId),
				eq(conversations.isArchived, 0),
			),
		)
		.orderBy(desc(conversations.updatedAt));

	return rows.map(mapConversation);
}

/**
 * Return archived conversations for a given project.
 */
export async function getArchivedConversations(
	projectId: string,
): Promise<ConversationListItem[]> {
	const rows = await db
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.projectId, projectId),
				eq(conversations.isArchived, 1),
			),
		)
		.orderBy(desc(conversations.updatedAt));

	return rows.map(mapConversation);
}

/**
 * Create a new conversation for a project with an optional title.
 * If a non-archived, non-pinned conversation with no messages already exists,
 * reuse it (bump updatedAt so it sorts to the top) instead of creating a duplicate.
 */
export async function createConversation(
	projectId: string,
	title?: string,
): Promise<{ id: string; title: string; reused: boolean }> {
	// Only auto-reuse when no explicit title is requested (i.e. "New conversation" button)
	if (!title) {
		// Single query: find the first empty "New conversation" using NOT EXISTS
		const candidates = await db
			.select({ id: conversations.id, title: conversations.title })
			.from(conversations)
			.where(
				and(
					eq(conversations.projectId, projectId),
					eq(conversations.isArchived, 0),
					eq(conversations.isPinned, 0),
					eq(conversations.title, "New conversation"),
					sql`NOT EXISTS (
						SELECT 1 FROM ${messages}
						WHERE ${messages.conversationId} = ${conversations.id}
						LIMIT 1
					)`,
				),
			)
			.limit(1);

		if (candidates.length > 0) {
			const conv = candidates[0];
			const now = new Date().toISOString();
			await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conv.id));
			return { id: conv.id, title: conv.title, reused: true };
		}
	}

	const id = crypto.randomUUID();
	const resolvedTitle = title ?? "New conversation";

	const now = new Date().toISOString();
	await db.insert(conversations).values({
		id,
		projectId,
		title: resolvedTitle,
		createdAt: now,
		updatedAt: now,
	});

	logAudit({ action: "conversation.create", entityType: "conversation", entityId: id, details: { projectId, title: resolvedTitle } });
	return { id, title: resolvedTitle, reused: false };
}

/**
 * Stop any running agents for the given conversation before a message/conversation
 * delete proceeds. A sub-agent's inline run (agent-loop.ts's runInlineAgent)
 * writes its streamed text/reasoning/tool-call parts via fire-and-forget
 * inserts referencing its own `messages` row — if that row disappears out
 * from under it mid-stream, those still-in-flight inserts hit a FOREIGN KEY
 * constraint failure. Aborting first (with a brief grace period for cleanup)
 * closes that window.
 *
 * Scoped to just this conversation — NOT abortAllAgents/engine.stopAll() with
 * no conversationId — so deleting/clearing one conversation never kills a
 * sibling conversation's PM turn, a scheduler run, or a review-cycle agent
 * running elsewhere in the same project.
 */
async function stopAgentsBeforeDelete(projectId: string, conversationId: string): Promise<void> {
	try {
		const { abortAgentsForConversation, engines } = await import("../engine-manager");
		engines.get(projectId)?.stopAll(conversationId);
		abortAgentsForConversation(projectId, conversationId);
		await new Promise((r) => setTimeout(r, 50));
	} catch { /* non-critical */ }
}

/**
 * Delete a single message by ID.
 */
export async function deleteMessage(id: string): Promise<{ success: boolean }> {
	const msgRow = await db.select({ conversationId: messages.conversationId }).from(messages).where(eq(messages.id, id)).limit(1);
	if (msgRow.length > 0) {
		const convRow = await db.select({ projectId: conversations.projectId }).from(conversations).where(eq(conversations.id, msgRow[0].conversationId)).limit(1);
		if (convRow.length > 0) await stopAgentsBeforeDelete(convRow[0].projectId, msgRow[0].conversationId);
	}

	await db.delete(messages).where(eq(messages.id, id));
	return { success: true };
}

/**
 * Delete all messages in a conversation without deleting the conversation itself.
 */
export async function clearConversationMessages(
	id: string,
): Promise<{ success: boolean }> {
	const convRow = await db.select({ projectId: conversations.projectId }).from(conversations).where(eq(conversations.id, id)).limit(1);
	if (convRow.length > 0) await stopAgentsBeforeDelete(convRow[0].projectId, id);

	// Clear all dependent data alongside conversation messages
	await db.delete(conversationSummaries).where(eq(conversationSummaries.conversationId, id));
	await db.delete(messages).where(eq(messages.conversationId, id));
	logAudit({ action: "conversation.clear_messages", entityType: "conversation", entityId: id });
	return { success: true };
}

/**
 * Delete a conversation and all its dependent rows (FK ordering: children first).
 */
export async function deleteConversation(
	id: string,
): Promise<{ success: boolean }> {
	try {
		const convRow = await db.select({ projectId: conversations.projectId }).from(conversations).where(eq(conversations.id, id)).limit(1);
		if (convRow.length > 0) await stopAgentsBeforeDelete(convRow[0].projectId, id);
	} catch { /* non-critical */ }

	// Delete in FK-safe order: parts → messages → summaries → conversation
	const msgIds = await db.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, id));
	if (msgIds.length > 0) {
		const { messageParts } = await import("../db/schema");
		const { inArray } = await import("drizzle-orm");
		for (let i = 0; i < msgIds.length; i += 100) {
			const batch = msgIds.slice(i, i + 100).map(m => m.id);
			await db.delete(messageParts).where(inArray(messageParts.messageId, batch));
		}
	}
	await db.delete(messages).where(eq(messages.conversationId, id));
	await db.delete(conversationSummaries).where(eq(conversationSummaries.conversationId, id));
	await db.delete(conversations).where(eq(conversations.id, id));
	logAudit({ action: "conversation.delete", entityType: "conversation", entityId: id });
	return { success: true };
}

/**
 * Rename a conversation.
 */
export async function renameConversation(
	id: string,
	title: string,
): Promise<{ success: boolean }> {
	await db
		.update(conversations)
		.set({ title, updatedAt: new Date().toISOString() })
		.where(eq(conversations.id, id));
	return { success: true };
}

/**
 * Pin or unpin a conversation. SQLite stores the boolean as 0/1.
 */
export async function pinConversation(
	id: string,
	pinned: boolean,
): Promise<{ success: boolean }> {
	await db
		.update(conversations)
		.set({ isPinned: pinned ? 1 : 0, updatedAt: new Date().toISOString() })
		.where(eq(conversations.id, id));
	return { success: true };
}

/**
 * Archive a conversation.
 */
export async function archiveConversation(
	id: string,
): Promise<{ success: boolean }> {
	await db
		.update(conversations)
		.set({ isArchived: 1, updatedAt: new Date().toISOString() })
		.where(eq(conversations.id, id));
	return { success: true };
}

/**
 * Restore an archived conversation.
 */
export async function restoreConversation(
	id: string,
): Promise<{ success: boolean }> {
	await db
		.update(conversations)
		.set({ isArchived: 0, updatedAt: new Date().toISOString() })
		.where(eq(conversations.id, id));
	return { success: true };
}

/**
 * Archive all conversations older than `daysOld` days for a project.
 */
export async function archiveOldConversations(
	projectId: string,
	daysOld = 30,
): Promise<{ archived: number }> {
	const cutoff = new Date(Date.now() - daysOld * 86_400_000).toISOString();
	const info = sqlite.prepare(
		`UPDATE conversations SET is_archived = 1, updated_at = ?
		 WHERE project_id = ? AND is_archived = 0 AND is_pinned = 0 AND updated_at < ?`
	).run(new Date().toISOString(), projectId, cutoff);
	return { archived: info.changes };
}

export interface MessageListItem {
	id: string;
	conversationId: string;
	role: string;
	agentId: string | null;
	agentName: string | null;
	content: string;
	metadata: string | null;
	tokenCount: number;
	hasParts: number;
	createdAt: string;
	seq: number;
}

// Explicit column selection that also exposes the implicit SQLite rowid as
// `seq` — the monotonic insertion-order key we sort by. rowid is assigned when
// a row is first inserted (and never on UPDATE), so it reflects TRUE insertion
// order even though `createdAt` gets mutated later (e.g. the PM message's
// timestamp is bumped after its sub-agents run). Ordering by rowid keeps a PM
// message above the sub-agents it spawned on reload. Works for existing data
// with no migration, since every historical row already has a rowid.
const messageSelection = {
	id: messages.id,
	conversationId: messages.conversationId,
	role: messages.role,
	agentId: messages.agentId,
	agentName: messages.agentName,
	content: messages.content,
	metadata: messages.metadata,
	tokenCount: messages.tokenCount,
	hasParts: messages.hasParts,
	createdAt: messages.createdAt,
	seq: sql<number>`${messages}.rowid`,
};

/**
 * Return messages for a conversation ordered by insertion order (rowid ASC).
 *
 * `limit` selects the NEWEST slice, not the oldest — a conversation longer than
 * the limit must show its most recent messages, since that's where the user is
 * reading and where a reply lands. Ordering the query ASC and truncating would
 * return the first N and silently hide everything after them.
 *
 * Cursor pagination uses the message's rowid (`seq`) rather than createdAt, so
 * the cursor is stable even when timestamps collide or are later mutated.
 */
export async function getMessages(
	conversationId: string,
	limit = 100,
	before?: string,
): Promise<MessageListItem[]> {
	if (before) {
		// Resolve the cursor message's rowid
		const cursorRows = await db
			.select({ seq: sql<number>`${messages}.rowid` })
			.from(messages)
			.where(eq(messages.id, before));

		if (cursorRows.length > 0) {
			const cursorSeq = cursorRows[0].seq;
			const rows = await db
				.select(messageSelection)
				.from(messages)
				.where(
					and(
						eq(messages.conversationId, conversationId),
						sql`${messages}.rowid < ${cursorSeq}`,
					),
				)
				.orderBy(desc(sql`${messages}.rowid`))
				.limit(limit);

			// Reverse to get ASC (insertion) order
			return rows.reverse().map(mapMessage);
		}
	}

	// DESC + limit takes the newest `limit` rows; reverse restores ASC
	// (insertion) order for the caller — same shape as the cursor branch above.
	const rows = await db
		.select(messageSelection)
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(desc(sql`${messages}.rowid`))
		.limit(limit);

	return rows.reverse().map(mapMessage);
}

/**
 * Create a new conversation that is a branch of an existing one.
 * Copies all messages up to and including `upToMessageId` into the new conversation.
 */
export async function branchConversation(
	conversationId: string,
	upToMessageId: string,
): Promise<{ id: string; title: string }> {
	// Fetch source conversation to inherit projectId + title
	const sourceRows = await db
		.select()
		.from(conversations)
		.where(eq(conversations.id, conversationId));

	if (sourceRows.length === 0) {
		throw new Error(`Conversation ${conversationId} not found`);
	}

	const source = sourceRows[0];

	// Fetch all messages in true insertion order (rowid) so the copied rows are
	// re-inserted in the same order and the branch gets a consistent ordering.
	const allMessages = await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(asc(sql`${messages}.rowid`));

	// Slice up to and including the target message
	const pivotIndex = allMessages.findIndex((m) => m.id === upToMessageId);
	const messagesToCopy = pivotIndex === -1
		? allMessages
		: allMessages.slice(0, pivotIndex + 1);

	// Create the new conversation
	const newId = crypto.randomUUID();
	const branchTitle = `Fork of ${source.title}`;

	const branchNow = new Date().toISOString();
	await db.insert(conversations).values({
		id: newId,
		projectId: source.projectId,
		title: branchTitle,
		createdAt: branchNow,
		updatedAt: branchNow,
	});

	// Insert copied messages with new IDs and the new conversationId
	if (messagesToCopy.length > 0) {
		await db.insert(messages).values(
			messagesToCopy.map((m) => ({
				id: crypto.randomUUID(),
				conversationId: newId,
				role: m.role,
				agentId: m.agentId,
				content: m.content,
				metadata: m.metadata,
				tokenCount: m.tokenCount,
				createdAt: m.createdAt,
			})),
		);
	}

	logAudit({
		action: "conversation.branch",
		entityType: "conversation",
		entityId: newId,
		details: { sourceConversationId: conversationId, upToMessageId },
	});

	return { id: newId, title: branchTitle };
}

/**
 * Fetch message parts for a specific message, ordered by sort_order.
 */
export async function getMessageParts(
	messageId: string,
): Promise<Array<{
	id: string;
	messageId: string;
	type: string;
	content: string;
	toolName: string | null;
	toolInput: string | null;
	toolOutput: string | null;
	toolState: string | null;
	sortOrder: number;
	timeStart: string | null;
	timeEnd: string | null;
	createdAt: string;
}>> {
	const rows = await db
		.select({
			id: messageParts.id,
			messageId: messageParts.messageId,
			type: messageParts.type,
			content: messageParts.content,
			toolName: messageParts.toolName,
			toolInput: messageParts.toolInput,
			toolOutput: messageParts.toolOutput,
			toolState: messageParts.toolState,
			sortOrder: messageParts.sortOrder,
			timeStart: messageParts.timeStart,
			timeEnd: messageParts.timeEnd,
			createdAt: messageParts.createdAt,
		})
		.from(messageParts)
		.where(eq(messageParts.messageId, messageId))
		.orderBy(asc(messageParts.sortOrder));

	return rows;
}

function mapConversation(row: typeof conversations.$inferSelect): ConversationListItem {
	return {
		id: row.id,
		projectId: row.projectId,
		title: row.title,
		isPinned: row.isPinned === 1,
		isArchived: (row as { isArchived?: number }).isArchived === 1,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function mapMessage(row: typeof messages.$inferSelect & { seq: number }): MessageListItem {
	return {
		id: row.id,
		conversationId: row.conversationId,
		role: row.role,
		agentId: row.agentId,
		agentName: row.agentName,
		content: row.content,
		metadata: row.metadata,
		tokenCount: row.tokenCount,
		hasParts: row.hasParts,
		createdAt: row.createdAt,
		seq: row.seq,
	};
}
