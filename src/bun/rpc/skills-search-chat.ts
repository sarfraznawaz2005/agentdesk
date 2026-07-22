/**
 * Skills Search Chat — lets a human (not just agents) discover and install
 * skills from the open agent-skills ecosystem (skills.sh) via a chat modal on
 * the Skills page. Wraps the built-in `search-skills` skill in a dedicated
 * streaming conversation, same architecture as Freelance Chat
 * (src/bun/rpc/freelance-chat.ts) but in-memory only (no DB persistence),
 * mirroring the Dashboard PM chatbot (src/bun/rpc/dashboard.ts) — there is no
 * per-entity key here, just one global conversation.
 */
import { streamText, isStepCount, type ModelMessage } from "ai";
import type { Tool } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { aiProviders } from "../db/schema";
import { createProviderAdapter } from "../providers";
import { isHaikuModel } from "../providers/claude-subscription";
import { getStreamingMode } from "../agents/streaming-mode";
import { createThrottledAccumulator } from "../agents/throttled-accumulator";
import { broadcastToWebview } from "../engine-manager";
import { getAllTools } from "../agents/tools/index";
import { autoApprovedShellTool } from "../agents/tools/shell";
import { buildSkillsDescriptionSection, SECURITY_RULES_SECTION } from "../agents/prompts";
import { skillRegistry } from "../skills/registry";
import type { SkillsChatMessageDto } from "../../shared/rpc/skills";

// ---------------------------------------------------------------------------
// Tool subset — same as Freelance Chat's FREELANCE_TOOL_NAMES, plus
// validate_skill (needed for the search-skills skill's post-install check).
// ---------------------------------------------------------------------------

const SKILLS_CHAT_TOOL_NAMES = new Set([
  "read_file", "list_directory", "search_files", "search_content", "directory_tree",
  "run_shell",
  "web_search", "web_fetch", "http_request",
  "environment_info", "get_env", "get_agentdesk_paths", "sleep",
  "run_background", "check_process", "kill_process", "list_background_jobs",
  "read_skill", "read_skill_file", "find_skills", "list_skills", "validate_skill",
]);

function buildSkillsChatTools(): Record<string, Tool> {
  const all = getAllTools();
  const result: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(all)) {
    if (SKILLS_CHAT_TOOL_NAMES.has(name)) result[name] = t;
  }
  // Auto-approved variant — no shell-approval gate, same as freelance chat.
  result["run_shell"] = autoApprovedShellTool;
  return result;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const skillsSection = buildSkillsDescriptionSection(false);

  return `You are AgentDesk's skill-discovery assistant. You help the user find and install specialized skills — both ones already installed in AgentDesk, and new ones from the external open agent-skills ecosystem (skills.sh).

---

## How to help

1. First call \`find_skills\` to check whether an already-installed AgentDesk skill covers the request.
2. If nothing installed covers it, load the \`search-skills\` skill with \`read_skill({ name: "search-skills" })\` and follow its instructions EXACTLY — searching skills.sh, verifying install count/source reputation/license/security audit badges, and presenting the option to the user before installing anything.
3. Never install a skill without the user explicitly confirming in this chat first.
4. After you finish the install (copying the skill into the user skills directory and running \`validate_skill\`), the skill registry refreshes automatically — you do NOT need to tell the user to click "Refresh" or restart the app. Just confirm the skill is installed and ready to use.
5. If nothing matches even after searching, say so plainly and mention the user can write a custom skill with the \`skill-creator\` skill instead.

Be concise. Use tools to get accurate answers rather than guessing.

---

${SECURITY_RULES_SECTION}${skillsSection ? `

---

${skillsSection}` : ""}`;
}

// ---------------------------------------------------------------------------
// In-memory state — single global conversation, no DB, no per-entity key.
// ---------------------------------------------------------------------------

let history: SkillsChatMessageDto[] = [];
let activeController: AbortController | null = null;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("aborted"));
}

async function getDefaultProviderAndModel(): Promise<{ adapter: ReturnType<typeof createProviderAdapter>; providerType: string; modelId: string }> {
  const providerRows = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
  if (!providerRows[0]) throw new Error("No default AI provider configured");

  const p = providerRows[0];
  const adapter = createProviderAdapter({
    id: p.id,
    name: p.name,
    providerType: p.providerType,
    apiKey: p.apiKey,
    baseUrl: p.baseUrl ?? null,
    defaultModel: p.defaultModel ?? null,
  });

  return { adapter, providerType: p.providerType, modelId: p.defaultModel ?? "gpt-4o-mini" };
}

// The SDK's query() takes a single prompt, not a ModelMessage[] — flatten the
// conversation history into a text transcript, same approach engine.ts uses
// for the PM's own CLI/SDK-routed transcript.
function flattenHistoryForCli(history: ModelMessage[]): string {
  return history.map((m) => {
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => (p && typeof p === "object" && "text" in p ? (p as { text?: string }).text ?? "" : "")).filter(Boolean).join("\n")
        : "";
    return `[${m.role}]\n${text}`;
  }).join("\n\n");
}

// ---------------------------------------------------------------------------
// Shared: run a streaming turn and append to in-memory history
// ---------------------------------------------------------------------------

async function streamAndAppend(messageId: string, modelHistory: ModelMessage[], signal: AbortSignal): Promise<void> {
  let fullContent = "";
  try {
    const { adapter, providerType, modelId } = await getDefaultProviderAndModel();
    const tools = buildSkillsChatTools();
    const systemPrompt = buildSystemPrompt();
    const streamingMode = await getStreamingMode();
    const isFullStreaming = streamingMode === "full";
    const isNoStreaming = streamingMode === "none";

    // Claude Subscription's direct-HTTP OAuth path 429s for anything but
    // Haiku — non-Haiku models route through the official Agent SDK instead
    // (see providers/claude-subscription.ts / claude-subscription-cli-runner.ts).
    if (providerType === "claude-subscription" && !isHaikuModel(modelId)) {
      const { runClaudeCliTask } = await import("../providers/claude-subscription-cli-runner");
      const toolStartTimes = new Map<string, string>();
      // Full Streaming only — broadcastToWebview appends client-side, so only
      // the slice new since the last throttled flush is ever sent.
      let flushedLength = 0;
      const textAcc = isFullStreaming ? createThrottledAccumulator((acc) => {
        const delta = acc.slice(flushedLength);
        flushedLength = acc.length;
        if (delta) broadcastToWebview("skillsChat.token", { messageId, token: delta });
      }) : null;

      const cliResult = await runClaudeCliTask({
        task: flattenHistoryForCli(modelHistory),
        systemPrompt,
        tools,
        modelId,
        timeoutMs: 900_000,
        abortSignal: signal,
        verifyToolCall: false, // skills chat is Q&A/search-driven — a turn may legitimately need zero tool calls
        onText: (text) => {
          fullContent += text;
          if (!isFullStreaming) broadcastToWebview("skillsChat.token", { messageId, token: text });
        },
        onReasoning: () => { /* skills chat doesn't surface reasoning today (same as the streamText path, which never handled 'reasoning' parts) */ },
        onTextToken: (delta) => textAcc?.push(delta),
        onRetract: () => { textAcc?.cancel(); flushedLength = 0; },
        onToolCallStart: (toolName, args) => {
          const callId = crypto.randomUUID();
          const timeStart = new Date().toISOString();
          toolStartTimes.set(callId, timeStart);
          broadcastToWebview("skillsChat.toolStart", {
            toolCallId: callId,
            toolName,
            toolInput: JSON.stringify(args),
            timeStart,
          });
          return callId;
        },
        onToolCallEnd: (callId, resultText, isError) => {
          const timeStart = toolStartTimes.get(callId) ?? null;
          toolStartTimes.delete(callId);
          broadcastToWebview("skillsChat.toolDone", {
            toolCallId: callId,
            toolName: "",
            toolOutput: resultText,
            isError: isError ?? false,
            timeStart,
            timeEnd: new Date().toISOString(),
          });
        },
      });
      textAcc?.flushNow();

      if (signal.aborted || cliResult.status === "cancelled") {
        broadcastToWebview("skillsChat.stopped", {});
        return;
      }
      if (cliResult.status === "timeout") {
        throw Object.assign(new Error("This request hit the 15-minute time limit and was stopped. Send a follow-up to continue."), { name: "TimeoutError" });
      }
      if (cliResult.status === "failed") {
        throw new Error(cliResult.summary);
      }
      if (!fullContent.trim()) fullContent = cliResult.summary;
    } else {
      const model = adapter.createModel(modelId);

      const result = streamText({
        model,
        instructions: systemPrompt,
        messages: modelHistory,
        tools,
        // run_shell (autoApprovedShellTool) declares a contextSchema — even though every
        // field is optional, the AI SDK still requires the top-level toolsContext entry to
        // be an object (undefined fails validation). See shell.ts's SHELL_CONTEXT_SCHEMA.
        toolsContext: { run_shell: {} } as never,
        stopWhen: [isStepCount(100)],
        abortSignal: signal,
      });

      const toolStartTimes = new Map<string, string>();

      for await (const part of result.stream) {
        if (part.type === "text-delta") {
          const token = (part as { text?: string }).text ?? "";
          fullContent += token;
          if (!isNoStreaming) broadcastToWebview("skillsChat.token", { messageId, token });
        } else if (part.type === "tool-call") {
          const tc = part as unknown as { toolCallId: string; toolName: string; input: Record<string, unknown> };
          const timeStart = new Date().toISOString();
          toolStartTimes.set(tc.toolCallId, timeStart);
          broadcastToWebview("skillsChat.toolStart", {
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            toolInput: JSON.stringify(tc.input),
            timeStart,
          });
        } else if (part.type === "tool-result") {
          const tr = part as unknown as { toolCallId: string; toolName: string; output: unknown; isError?: boolean };
          const timeStart = toolStartTimes.get(tr.toolCallId) ?? null;
          const timeEnd = new Date().toISOString();
          toolStartTimes.delete(tr.toolCallId);
          const toolOutput = typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output);
          broadcastToWebview("skillsChat.toolDone", {
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            toolOutput,
            isError: tr.isError ?? false,
            timeStart,
            timeEnd,
          });
        } else if (part.type === "error") {
          throw (part as { error: unknown }).error;
        }
      }
    }

    if (signal.aborted) {
      broadcastToWebview("skillsChat.stopped", {});
      return;
    }

    history.push({ id: messageId, role: "assistant", content: fullContent, createdAt: new Date().toISOString() });
    broadcastToWebview("skillsChat.complete", { messageId, content: fullContent });

    // Auto-refresh the skill registry after every turn — cheap idempotent
    // rescan, so a freshly installed skill shows up on the Skills page
    // without the user having to click Refresh.
    skillRegistry.reload();
    broadcastToWebview("skillsChat.registryRefreshed", {});
  } catch (err) {
    if (isAbortError(err)) {
      broadcastToWebview("skillsChat.stopped", {});
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[skills-search-chat] Stream error:", err);
      broadcastToWebview("skillsChat.error", { error: errorMsg });
    }
  } finally {
    activeController = null;
  }
}

// ---------------------------------------------------------------------------
// RPC: getMessages
// ---------------------------------------------------------------------------

export function getMessages(): { messages: SkillsChatMessageDto[] } {
  return { messages: history };
}

// ---------------------------------------------------------------------------
// RPC: clearMessages
// ---------------------------------------------------------------------------

export function clearMessages(): { success: boolean } {
  history = [];
  return { success: true };
}

// ---------------------------------------------------------------------------
// RPC: sendMessage
// ---------------------------------------------------------------------------

export async function sendMessage(params: { content: string }): Promise<{ success: boolean; messageId: string }> {
  const userMsgId = crypto.randomUUID();
  history.push({ id: userMsgId, role: "user", content: params.content, createdAt: new Date().toISOString() });

  const modelHistory: ModelMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

  const assistantMsgId = crypto.randomUUID();
  const controller = new AbortController();
  activeController = controller;
  streamAndAppend(assistantMsgId, modelHistory, controller.signal).catch(() => {});

  return { success: true, messageId: assistantMsgId };
}

// ---------------------------------------------------------------------------
// RPC: regenerate — remove last assistant message and re-stream
// ---------------------------------------------------------------------------

export async function regenerate(): Promise<{ success: boolean; messageId: string }> {
  const lastAssistantIdx = [...history].reverse().findIndex((m) => m.role === "assistant");
  if (lastAssistantIdx !== -1) {
    const actualIdx = history.length - 1 - lastAssistantIdx;
    history = history.filter((_, i) => i !== actualIdx);
  }

  const modelHistory: ModelMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

  const newMessageId = crypto.randomUUID();
  const controller = new AbortController();
  activeController = controller;
  streamAndAppend(newMessageId, modelHistory, controller.signal).catch(() => {});

  return { success: true, messageId: newMessageId };
}

// ---------------------------------------------------------------------------
// RPC: stopChat — abort the in-flight stream
// ---------------------------------------------------------------------------

export function stopChat(): { success: boolean } {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  return { success: true };
}
