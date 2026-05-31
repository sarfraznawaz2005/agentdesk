import { generateText } from "ai";
import { desc, eq, inArray, asc } from "drizzle-orm";
import { db } from "../db";
import { messages, conversationSummaries, messageParts } from "../db/schema";
import { createProviderAdapter } from "../providers";
import { getDefaultModel } from "../providers/models";
import { createSummary } from "../db/summaries";
import type { ProviderConfig } from "../providers/types";

/** Per-conversation lock to prevent concurrent summarization runs. */
const activeSummarizations = new Set<string>();

/** Number of most recent messages to keep after compaction. */
const KEEP_RECENT = 10;

/**
 * Max characters of transcript to feed to the summarizer in one call.
 * ~30k chars ≈ ~7.5k tokens — safe for all models, leaves room for
 * the system prompt + previous summary.
 */
const MAX_TRANSCRIPT_CHARS = 30_000;

const SUMMARIZER_SYSTEM_PROMPT =
  "You are a conversation compaction engine. Your job is to produce a single, " +
  "dense summary that preserves ALL information needed to continue the " +
  "conversation without loss of context.\n\n" +
  "Include:\n" +
  "- Project status: what has been completed, what is in progress, what remains\n" +
  "- Key decisions made and their rationale\n" +
  "- File paths created or modified\n" +
  "- Technical details: architecture, patterns, constraints\n" +
  "- Current requirements and acceptance criteria\n" +
  "- Any pending issues, blockers, or open questions\n" +
  "- Agent dispatches and their outcomes\n\n" +
  "Do NOT include pleasantries, meta-commentary, or filler. " +
  "Write in compact bullet/section format. Be thorough — anything you omit " +
  "will be permanently lost.";

/**
 * True conversation compaction — similar to Claude Code.
 *
 * 1. Loads the previous summary (if any) so context is carried forward
 * 2. Chunks large transcripts to avoid overflowing the summarizer's context
 * 3. Replaces old summaries with a single merged one
 * 4. Deletes compacted messages from the DB
 *
 * Keeps the most recent KEEP_RECENT messages intact so the PM still
 * has immediate context. Everything older is replaced by the summary.
 */
export async function summarizeConversation(options: {
  conversationId: string;
  providerConfig: ProviderConfig;
  modelId: string;
}): Promise<void> {
  const { conversationId, providerConfig, modelId } = options;

  // Skip if a summarization is already in progress for this conversation
  if (activeSummarizations.has(conversationId)) return;
  activeSummarizations.add(conversationId);

  try {
    // 1. Load ALL messages (newest first) so we know which to keep vs summarize
    const allRows = await db
      .select({ id: messages.id, role: messages.role, content: messages.content, hasParts: messages.hasParts })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt));

    if (allRows.length <= KEEP_RECENT) return;

    // The most recent KEEP_RECENT messages are kept — everything else is summarized + deleted
    const toSummarize = allRows.slice(KEEP_RECENT);
    toSummarize.reverse(); // chronological order

    if (toSummarize.length === 0) return;

    // 2. Load the previous summary so we can carry forward accumulated context
    const prevSummaries = await db
      .select({ id: conversationSummaries.id, summaryText: conversationSummaries.summaryText })
      .from(conversationSummaries)
      .where(eq(conversationSummaries.conversationId, conversationId))
      .orderBy(desc(conversationSummaries.createdAt));

    const previousSummary = prevSummaries.length > 0 ? prevSummaries[0].summaryText : "";

    // 3. Build transcript — prune verbose tool results for messages with parts
    const partsMessageIds = toSummarize.filter((m) => m.hasParts === 1).map((m) => m.id);
    const partsMap = new Map<string, Array<{ type: string; toolName: string | null; toolInput: string | null; toolOutput: string | null; content: string }>>();
    if (partsMessageIds.length > 0) {
      for (let i = 0; i < partsMessageIds.length; i += 50) {
        const batch = partsMessageIds.slice(i, i + 50);
        const rows = await db
          .select({ messageId: messageParts.messageId, type: messageParts.type, toolName: messageParts.toolName, toolInput: messageParts.toolInput, toolOutput: messageParts.toolOutput, content: messageParts.content })
          .from(messageParts)
          .where(inArray(messageParts.messageId, batch))
          .orderBy(asc(messageParts.sortOrder));
        for (const r of rows) {
          let arr = partsMap.get(r.messageId);
          if (!arr) { arr = []; partsMap.set(r.messageId, arr); }
          arr.push(r);
        }
      }
    }

    const transcriptLines = toSummarize.map((m) => {
      const roleLabel =
        m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
      const parts = partsMap.get(m.id);
      if (parts && parts.length > 0) {
        return `${roleLabel}: ${buildPrunedContent(parts)}`;
      }
      return `${roleLabel}: ${m.content}`;
    });

    const chunks = chunkTranscript(transcriptLines, MAX_TRANSCRIPT_CHARS);

    // 4. Create provider adapter and model
    const resolvedModelId = modelId || getDefaultModel(providerConfig.providerType);
    const adapter = createProviderAdapter(providerConfig);
    const model = adapter.createModel(resolvedModelId);

    // 5. Iterative summarization — each chunk builds on the running summary
    let runningSummary = previousSummary;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLast = i === chunks.length - 1;

      const parts: string[] = [];
      if (runningSummary) {
        parts.push(
          "## Existing Summary (from earlier in this conversation)\n" +
          runningSummary,
        );
      }
      parts.push(
        `## New Messages${chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : ""}\n` +
        chunk,
      );
      if (!isLast) {
        parts.push(
          "Merge the existing summary with these new messages into a single updated summary. " +
          "More chunks will follow — preserve all detail.",
        );
      } else {
        parts.push(
          "Merge the existing summary (if any) with these new messages into a single, " +
          "comprehensive summary. This is the final chunk — produce the definitive summary.",
        );
      }

      const result = await generateText({
        model,
        system: SUMMARIZER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: parts.join("\n\n") }],
      });

      const text = result.text.trim();
      if (text) runningSummary = text;
    }

    if (!runningSummary || runningSummary === previousSummary) return;

    // 6. Delete all old summaries for this conversation and create the new merged one
    if (prevSummaries.length > 0) {
      const oldIds = prevSummaries.map((s) => s.id);
      await db.delete(conversationSummaries).where(inArray(conversationSummaries.id, oldIds));
    }

    const earliestMessageId = toSummarize[0].id;
    await createSummary(conversationId, runningSummary, earliestMessageId);

    // 7. Delete the compacted messages
    const idsToDelete = toSummarize.map((m) => m.id);
    const BATCH_SIZE = 100;
    for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
      const batch = idsToDelete.slice(i, i + BATCH_SIZE);
      await db.delete(messages).where(inArray(messages.id, batch));
    }

    console.log(
      `[Summarizer] Compacted conversation ${conversationId}: ` +
      `deleted ${idsToDelete.length} messages, kept ${KEEP_RECENT}, ` +
      `${chunks.length} chunk(s), previous summary ${previousSummary ? "merged" : "none"}`,
    );
  } finally {
    activeSummarizations.delete(conversationId);
  }
}

/**
 * Split transcript lines into chunks that each fit within maxChars.
 * Splits on message boundaries — never mid-message.
 */
function chunkTranscript(lines: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const entry = line + "\n\n";
    if (current.length + entry.length > maxChars && current.length > 0) {
      chunks.push(current.trimEnd());
      current = "";
    }
    current += entry;
  }
  if (current.trim()) chunks.push(current.trimEnd());

  return chunks.length > 0 ? chunks : ["(empty conversation)"];
}

// ---------------------------------------------------------------------------
// Tool result pruning — reduces verbose outputs before summarization
// ---------------------------------------------------------------------------

interface PartRow {
  type: string;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  content: string;
}

function buildPrunedContent(parts: PartRow[]): string {
  const sections: string[] = [];
  for (const p of parts) {
    if (p.type === "text" || p.type === "reasoning") {
      if (p.content.trim()) sections.push(p.content.trim());
    } else if (p.type === "tool_call") {
      sections.push(`[Tool: ${p.toolName ?? "unknown"}]`);
    } else if (p.type === "tool_result") {
      sections.push(pruneToolResult(p.toolName, p.toolInput, p.toolOutput ?? p.content));
    } else if (p.type === "agent_start") {
      sections.push(`[Agent started: ${p.content || "sub-agent"}]`);
    } else if (p.type === "agent_end") {
      sections.push(`[Agent finished: ${p.content || "sub-agent"}]`);
    }
  }
  return sections.join("\n");
}

function pruneToolResult(toolName: string | null, toolInput: string | null, output: string): string {
  if (!toolName) return truncate(output, 200);

  const args = safeParseJson(toolInput);
  const lines = output.split("\n");
  const lineCount = lines.length;

  switch (toolName) {
    case "read_file": {
      const path = args?.file_path ?? args?.path ?? "file";
      if (lineCount > 50) return `Read ${path} (${lineCount} lines)`;
      return truncate(output, 500);
    }
    case "write_file":
    case "edit_file":
    case "multi_edit_file":
    case "append_file": {
      const path = args?.file_path ?? args?.path ?? "file";
      return `Wrote ${path} (${lineCount} lines changed)`;
    }
    case "run_shell": {
      if (lineCount > 20) {
        const head = lines.slice(0, 5).join("\n");
        const tail = lines.slice(-2).join("\n");
        return `Shell output:\n${head}\n... (${lineCount - 7} more lines)\n${tail}`;
      }
      return `Shell output:\n${output}`;
    }
    case "directory_tree":
    case "list_directory": {
      const path = args?.path ?? args?.directory ?? ".";
      return `Listed ${path} (${lineCount} entries)`;
    }
    case "search_content":
    case "search_files": {
      const query = args?.query ?? args?.pattern ?? "";
      const matchCount = (output.match(/\n/g) || []).length + 1;
      return `Found ${matchCount} matches for "${truncate(query, 40)}"`;
    }
    case "git_diff": {
      if (lineCount > 30) {
        const added = (output.match(/^\+[^+]/gm) || []).length;
        const removed = (output.match(/^-[^-]/gm) || []).length;
        const files = (output.match(/^diff --git/gm) || []).length;
        return `Diff: ${files} file(s) changed, +${added} -${removed} lines`;
      }
      return `Diff:\n${output}`;
    }
    case "web_fetch": {
      const url = args?.url ?? "";
      return `Fetched ${truncate(url, 80)} (${output.length} chars)`;
    }
    case "web_search":
    case "enhanced_web_search": {
      const query = args?.query ?? "";
      return `Searched: "${truncate(query, 50)}" (${lineCount} lines of results)`;
    }
    case "http_request": {
      const method = args?.method ?? "GET";
      const url = args?.url ?? "";
      return `${method} ${truncate(url, 80)} → ${truncate(output, 200)}`;
    }
    default:
      return truncate(output, 300);
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "...";
}

function safeParseJson(s: string | null): Record<string, string> | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
