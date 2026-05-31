import { eq, desc } from "drizzle-orm";
import { db } from "./index";
import { conversationSummaries } from "./schema";

/**
 * Insert a new summary row for the given conversation.
 * Returns the ID of the newly created summary.
 */
export async function createSummary(
  conversationId: string,
  summaryText: string,
  messagesUpToId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(conversationSummaries).values({
    id,
    conversationId,
    summaryText,
    messagesUpToId,
  });
  return id;
}

/**
 * Get the most recent summary for a conversation.
 * Returns null if no summaries exist for the given conversation.
 */
export async function getLatestSummary(
  conversationId: string,
): Promise<{
  id: string;
  summaryText: string;
  messagesUpToId: string;
  createdAt: string;
} | null> {
  const rows = await db
    .select()
    .from(conversationSummaries)
    .where(eq(conversationSummaries.conversationId, conversationId))
    .orderBy(desc(conversationSummaries.createdAt))
    .limit(1);

  return rows.length > 0 ? rows[0] : null;
}

/**
 * Delete all summaries for a conversation.
 * Used when a conversation is deleted to avoid orphaned rows.
 */
export async function deleteSummariesForConversation(
  conversationId: string,
): Promise<void> {
  await db
    .delete(conversationSummaries)
    .where(eq(conversationSummaries.conversationId, conversationId));
}
