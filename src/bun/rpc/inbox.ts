import { db } from "../db";
import { sqlite } from "../db/connection";
import { inboxMessages } from "../db/schema";
import { eq, and, desc, sql, like, or, inArray } from "drizzle-orm";
import { applyInboxRules } from "./inbox-rules";
import { broadcastToWebview } from "../engine-manager";
import { sendChannelMessage } from "../channels/manager";

// SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 32766 (older builds: 999) — chunk
// large id lists so "select all" bulk actions can't blow past it and fail outright.
const ID_CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function getInboxMessages(filters?: {
  projectId?: string;
  isRead?: boolean;
  isArchived?: boolean;
  isFavorite?: boolean;
  limit?: number;
}) {
  const conditions = [];
  if (filters?.projectId) conditions.push(eq(inboxMessages.projectId, filters.projectId));
  if (filters?.isRead !== undefined) conditions.push(eq(inboxMessages.isRead, filters.isRead ? 1 : 0));
  // Favorited messages are exclusive to the Favorites view — hidden everywhere
  // else (including Archived) so they can never be swept up by a bulk action
  // performed outside Favorites. Only an explicit isFavorite:true request (the
  // Favorites view itself) sees them.
  if (filters?.isFavorite) {
    conditions.push(eq(inboxMessages.isFavorite, 1));
  } else {
    conditions.push(eq(inboxMessages.isFavorite, 0));
  }
  // Default to non-archived unless explicitly requested. The Favorites view is an
  // exception — like Gmail's Starred, it spans both active and archived messages,
  // so don't force isArchived=0 there unless the caller also asked for it.
  if (filters?.isArchived !== undefined) {
    conditions.push(eq(inboxMessages.isArchived, filters.isArchived ? 1 : 0));
  } else if (!filters?.isFavorite) {
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
  // Mirrors getInboxMessages' default (Inbox) view: active, non-favorited only —
  // favorited messages are hidden from Inbox, so they shouldn't inflate its badge.
  const conditions = [eq(inboxMessages.isRead, 0), eq(inboxMessages.isArchived, 0), eq(inboxMessages.isFavorite, 0)];
  if (projectId) conditions.push(eq(inboxMessages.projectId, projectId));
  const rows = await db.select({ count: sql<number>`count(*)` }).from(inboxMessages).where(and(...conditions));
  return { count: rows[0]?.count ?? 0 };
}

export async function deleteInboxMessage(id: string) {
  await db.delete(inboxMessages).where(eq(inboxMessages.id, id));
  return { success: true };
}

export async function searchInboxMessages(query: string, projectId?: string, isFavorite?: boolean) {
  // Search must respect the same favorite-exclusivity as getInboxMessages —
  // otherwise a favorited message could surface in an Inbox/Archived search
  // and get bulk-deleted from there, defeating the point of favoriting it.
  const favoriteFlag = isFavorite ? 1 : 0;

  // Use FTS5 for fast full-text search, fall back to LIKE if FTS fails
  try {
    const sql = projectId
      ? `SELECT m.* FROM inbox_messages m JOIN inbox_fts f ON m.rowid = f.rowid
         WHERE inbox_fts MATCH ?1 AND f.project_id = ?2 AND m.is_favorite = ?3
         ORDER BY rank LIMIT 100`
      : `SELECT m.* FROM inbox_messages m JOIN inbox_fts f ON m.rowid = f.rowid
         WHERE inbox_fts MATCH ?1 AND m.is_favorite = ?2
         ORDER BY rank LIMIT 100`;
    const rows = projectId
      ? sqlite.prepare(sql).all(query, projectId, favoriteFlag)
      : sqlite.prepare(sql).all(query, favoriteFlag);
    return rows as Array<typeof inboxMessages.$inferSelect>;
  } catch {
    const pattern = `%${query}%`;
    const conditions = [
      or(
        like(inboxMessages.content, pattern),
        like(inboxMessages.sender, pattern),
      ),
      eq(inboxMessages.isFavorite, favoriteFlag),
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

export async function favoriteInboxMessage(id: string) {
  await db.update(inboxMessages).set({ isFavorite: 1 }).where(eq(inboxMessages.id, id));
  return { success: true };
}

export async function unfavoriteInboxMessage(id: string) {
  await db.update(inboxMessages).set({ isFavorite: 0 }).where(eq(inboxMessages.id, id));
  return { success: true };
}

export async function bulkArchiveInboxMessages(ids: string[]) {
  if (ids.length === 0) return { success: true, count: 0 };
  for (const batch of chunk(ids, ID_CHUNK_SIZE)) {
    await db.update(inboxMessages).set({ isArchived: 1 }).where(inArray(inboxMessages.id, batch));
  }
  return { success: true, count: ids.length };
}

export async function bulkDeleteInboxMessages(ids: string[]) {
  if (ids.length === 0) return { success: true, count: 0 };
  for (const batch of chunk(ids, ID_CHUNK_SIZE)) {
    await db.delete(inboxMessages).where(inArray(inboxMessages.id, batch));
  }
  return { success: true, count: ids.length };
}

export async function bulkMarkAsReadInboxMessages(ids: string[]) {
  if (ids.length === 0) return { success: true, count: 0 };
  for (const batch of chunk(ids, ID_CHUNK_SIZE)) {
    await db.update(inboxMessages).set({ isRead: 1 }).where(inArray(inboxMessages.id, batch));
  }
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
  const [row] = await db
    .update(inboxMessages)
    .set({ agentResponse: response })
    .where(eq(inboxMessages.id, messageId))
    .returning({ projectId: inboxMessages.projectId });

  // Broadcast so an open Inbox tab updates the message in place, live —
  // without this, the reply only appears after a manual reload/re-navigate.
  broadcastToWebview("inboxResponseUpdated", {
    messageId,
    projectId: row?.projectId ?? null,
    response,
  });
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
