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
 * Delete a single message by ID.
 */
export async function deleteMessage(id: string): Promise<{ success: boolean }> {
	await db.delete(messages).where(eq(messages.id, id));
	return { success: true };
}

/**
 * Delete all messages in a conversation without deleting the conversation itself.
 */
export async function clearConversationMessages(
	id: string,
): Promise<{ success: boolean }> {
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
	// Stop any running agents for this conversation's project before deleting
	// to prevent FK failures from agents writing to deleted messages.
	try {
		const convRow = await db.select({ projectId: conversations.projectId }).from(conversations).where(eq(conversations.id, id)).limit(1);
		if (convRow.length > 0) {
			const { abortAllAgents, engines } = await import("../engine-manager");
			const projectId = convRow[0].projectId;
			engines.get(projectId)?.stopAll();
			abortAllAgents(projectId);
			// Brief delay for agent cleanup to complete
			await new Promise((r) => setTimeout(r, 50));
		}
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
}

/**
 * Return messages for a conversation ordered by createdAt ASC.
 *
 * Uses SQL-level cursor pagination via `WHERE created_at < ? LIMIT ?`
 * instead of fetching all rows and slicing in JS.
 */
export async function getMessages(
	conversationId: string,
	limit = 100,
	before?: string,
): Promise<MessageListItem[]> {
	if (before) {
		// Resolve cursor timestamp
		const cursorRows = await db
			.select({ createdAt: messages.createdAt })
			.from(messages)
			.where(eq(messages.id, before));

		if (cursorRows.length > 0) {
			const cursorTimestamp = cursorRows[0].createdAt;
			// Use raw SQL with the composite index for efficient cursor pagination
			const rows = sqlite.prepare(`
				SELECT * FROM messages
				WHERE conversation_id = ? AND created_at < ?
				ORDER BY created_at DESC
				LIMIT ?
			`).all(conversationId, cursorTimestamp, limit) as Array<typeof messages.$inferSelect>;

			// Reverse to get ASC order
			return rows.reverse().map(mapMessage);
		}
	}

	const rows = await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(asc(messages.createdAt))
		.limit(limit);

	return rows.map(mapMessage);
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

	// Fetch all messages in order
	const allMessages = await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(asc(messages.createdAt));

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

function mapMessage(row: typeof messages.$inferSelect): MessageListItem {
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
	};
}
