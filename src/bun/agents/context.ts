import type { ModelMessage } from "ai";
import { db } from "../db";
import { messages, conversationSummaries } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { getContextLimit } from "../providers/models";

interface ContextOptions {
  conversationId: string;
  systemPrompt: string;
  constitution: string;
  modelId: string;
  maxRecentMessages?: number; // default 50
}

interface BuiltContext {
  system: string;
  messages: ModelMessage[];
  tokenCount: number;
  contextLimit: number;
  utilizationPercent: number;
}

// Rough token estimation: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function buildContext(options: ContextOptions): Promise<BuiltContext> {
  const { conversationId, systemPrompt, constitution, modelId } = options;
  const maxRecent = options.maxRecentMessages ?? 50;
  const contextLimit = getContextLimit(modelId);

  // 1. Load latest summary if exists
  const summaries = await db.select()
    .from(conversationSummaries)
    .where(eq(conversationSummaries.conversationId, conversationId))
    .orderBy(desc(conversationSummaries.createdAt))
    .limit(1);

  // 2. Load recent messages — sort in JS to handle mixed timestamp formats
  // (SQLite CURRENT_TIMESTAMP produces "YYYY-MM-DD HH:MM:SS" while JS
  // new Date().toISOString() produces "YYYY-MM-DDTHH:MM:SS.sssZ". Lexicographic
  // sort breaks because space < 'T', causing user/assistant messages to misordered.)
  const allMessages = await db.select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId));

  allMessages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const recentMessages = allMessages.slice(-maxRecent);

  // 3. Build system string (used via the dedicated `system` parameter in streamText)
  const systemParts = [systemPrompt];
  if (constitution) systemParts.push(`## Constitution\n${constitution}`);
  if (summaries.length > 0) {
    systemParts.push(`---\n\n## Previous Conversation Summary\n\n${summaries[0].summaryText}\n\n---`);
  }

  const systemContent = systemParts.join("\n\n");

  // 4. Build ModelMessage array — user/assistant turns only
  const coreMessages: ModelMessage[] = [];

  for (const msg of recentMessages) {
    if (msg.role === "system") continue; // skip any persisted system messages
    if (!msg.content) continue; // skip empty placeholder (assistant or user — an empty text block is rejected by every provider)
    if (msg.content.startsWith("[Generation failed]")) continue; // skip error messages — not useful context
    const role = msg.role === "assistant" ? "assistant" : "user";
    coreMessages.push({ role, content: msg.content });
  }

  // 5. Compute total tokens from content length (~4 chars/token).
  // We don't use messages.tokenCount because it stores API usage tokens
  // (prompt+completion) which wildly overestimates actual content size.
  const tokenCount =
    estimateTokens(systemContent) +
    coreMessages.reduce(
      (sum, m) => sum + estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content)),
      0,
    );

  return {
    instructions: systemContent,
    messages: coreMessages,
    tokenCount,
    contextLimit,
    utilizationPercent: Math.round((tokenCount / contextLimit) * 100),
  };
}

export function shouldSummarize(context: BuiltContext): boolean {
  return context.utilizationPercent >= 80;
}
