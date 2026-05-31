import { db } from "../db";
import { sqlite } from "../db/connection";
import { inboxMessages } from "../db/schema";
import { eq, and, desc, sql, like, or, inArray } from "drizzle-orm";
import { applyInboxRules } from "./inbox-rules";
import { broadcastToWebview } from "../engine-manager";
import { sendChannelMessage } from "../channels/manager";

export async function getInboxMessages(filters?: {
  projectId?: string;
  isRead?: boolean;
  isArchived?: boolean;
  limit?: number;
}) {
  const conditions = [];
  if (filters?.projectId) conditions.push(eq(inboxMessages.projectId, filters.projectId));
  if (filters?.isRead !== undefined) conditions.push(eq(inboxMessages.isRead, filters.isRead ? 1 : 0));
  // Default to non-archived unless explicitly requested
  if (filters?.isArchived !== undefined) {
    conditions.push(eq(inboxMessages.isArchived, filters.isArchived ? 1 : 0));
  } else {
    conditions.push(eq(inboxMessages.isArchived, 0));
  }

  let query = db.select().from(inboxMessages).orderBy(desc(inboxMessages.createdAt));

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  if (filters?.limit) {
    query = query.limit(filters.limit) as typeof query;
  }

  return query;
}

export async function markAsRead(id: string) {
  await db.update(inboxMessages).set({ isRead: 1 }).where(eq(inboxMessages.id, id));
  return { success: true };
}

export async function markAsUnread(id: string) {
  await db.update(inboxMessages).set({ isRead: 0 }).where(eq(inboxMessages.id, id));
  return { success: true };
}

export async function markAllAsRead(projectId?: string) {
  if (projectId) {
    await db.update(inboxMessages).set({ isRead: 1 }).where(
      and(eq(inboxMessages.projectId, projectId), eq(inboxMessages.isRead, 0))
    );
  } else {
    await db.update(inboxMessages).set({ isRead: 1 }).where(eq(inboxMessages.isRead, 0));
  }
  return { success: true };
}

export async function getUnreadCount(projectId?: string) {
  const conditions = [eq(inboxMessages.isRead, 0), eq(inboxMessages.isArchived, 0)];
  if (projectId) conditions.push(eq(inboxMessages.projectId, projectId));
  const rows = await db.select({ count: sql<number>`count(*)` }).from(inboxMessages).where(and(...conditions));
  return { count: rows[0]?.count ?? 0 };
}

export async function deleteInboxMessage(id: string) {
  await db.delete(inboxMessages).where(eq(inboxMessages.id, id));
  return { success: true };
}

export async function searchInboxMessages(query: string, projectId?: string) {
  // Use FTS5 for fast full-text search, fall back to LIKE if FTS fails
  try {
    const sql = projectId
      ? `SELECT m.* FROM inbox_messages m JOIN inbox_fts f ON m.rowid = f.rowid
         WHERE inbox_fts MATCH ?1 AND f.project_id = ?2
         ORDER BY rank LIMIT 100`
      : `SELECT m.* FROM inbox_messages m JOIN inbox_fts f ON m.rowid = f.rowid
         WHERE inbox_fts MATCH ?1
         ORDER BY rank LIMIT 100`;
    const rows = projectId
      ? sqlite.prepare(sql).all(query, projectId)
      : sqlite.prepare(sql).all(query);
    return rows as Array<typeof inboxMessages.$inferSelect>;
  } catch {
    const pattern = `%${query}%`;
    const conditions = [
      or(
        like(inboxMessages.content, pattern),
        like(inboxMessages.sender, pattern),
      ),
    ];
    if (projectId) conditions.push(eq(inboxMessages.projectId, projectId));
    return db.select().from(inboxMessages)
      .where(and(...conditions))
      .orderBy(desc(inboxMessages.createdAt))
      .limit(100);
  }
}

export async function archiveInboxMessage(id: string) {
  await db.update(inboxMessages).set({ isArchived: 1 }).where(eq(inboxMessages.id, id));
  return { success: true };
}

export async function unarchiveInboxMessage(id: string) {
  await db.update(inboxMessages).set({ isArchived: 0 }).where(eq(inboxMessages.id, id));
  return { success: true };
}

export async function bulkArchiveInboxMessages(ids: string[]) {
  if (ids.length === 0) return { success: true, count: 0 };
  await db.update(inboxMessages).set({ isArchived: 1 }).where(inArray(inboxMessages.id, ids));
  return { success: true, count: ids.length };
}

export async function bulkDeleteInboxMessages(ids: string[]) {
  if (ids.length === 0) return { success: true, count: 0 };
  await db.delete(inboxMessages).where(inArray(inboxMessages.id, ids));
  return { success: true, count: ids.length };
}

export async function bulkMarkAsReadInboxMessages(ids: string[]) {
  if (ids.length === 0) return { success: true, count: 0 };
  await db.update(inboxMessages).set({ isRead: 1 }).where(inArray(inboxMessages.id, ids));
  return { success: true, count: ids.length };
}

export async function replyToInboxMessage(id: string, content: string) {
  // Get the original message to find channel context
  const rows = await db.select().from(inboxMessages).where(eq(inboxMessages.id, id)).limit(1);
  const msg = rows[0];
  if (!msg) return { success: false };

  // Only channel messages (non-chat) can be replied to via the channel
  if (msg.channelId && msg.platform !== "chat") {
    await sendChannelMessage(msg.channelId, content);

    // Persist the reply as an inbox message so it appears in the conversation
    await db.insert(inboxMessages).values({
      id: crypto.randomUUID(),
      projectId: msg.projectId,
      channelId: msg.channelId,
      sender: "You",
      content,
      platform: msg.platform,
      threadId: msg.threadId,
      isRead: 1,
    });
  }
  return { success: true };
}

export async function updateAgentResponse(messageId: string, response: string) {
  await db.update(inboxMessages).set({ agentResponse: response }).where(eq(inboxMessages.id, messageId));
}

export async function writeInboxMessage(params: {
  projectId?: string;
  channelId?: string;
  sender: string;
  content: string;
  platform?: string;
  threadId?: string;
}) {
  const processed = await applyInboxRules(params);
  const id = crypto.randomUUID();
  await db.insert(inboxMessages).values({
    id,
    projectId: processed.projectId ?? null,
    channelId: processed.channelId ?? null,
    sender: processed.sender,
    content: processed.content,
    ...(processed.platform !== undefined && { platform: processed.platform }),
    ...(processed.threadId !== undefined && { threadId: processed.threadId }),
    ...(processed.priority !== undefined && { priority: processed.priority }),
    ...(processed.category !== undefined && { category: processed.category }),
    ...(processed.markAsRead && { isRead: 1 }),
  });

  // Broadcast to frontend for real-time inbox updates
  broadcastToWebview("inboxMessageReceived", {
    messageId: id,
    projectId: processed.projectId ?? null,
    sender: processed.sender,
    platform: processed.platform ?? "chat",
  });

  return { id };
}
