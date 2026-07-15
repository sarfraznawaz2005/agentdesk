import { streamText, isStepCount } from "ai";
import type { Tool } from "ai";
import { eq, asc } from "drizzle-orm";
import { db } from "../db";
import { freelanceChatMessages, freelanceListings, aiProviders } from "../db/schema";
import { createProviderAdapter } from "../providers";
import { isHaikuModel } from "../providers/claude-subscription";
import { getStreamingMode } from "../agents/streaming-mode";
import { createThrottledAccumulator } from "../agents/throttled-accumulator";
import { broadcastToWebview } from "../engine-manager";
import { getAllTools } from "../agents/tools/index";
import { autoApprovedShellTool } from "../agents/tools/shell";
import { buildSkillsDescriptionSection } from "../agents/prompts";
import { getFreelanceSettings } from "../freelance/settings";
import { ensureFullDescription } from "../freelance/description";
import { FREELANCE_EVENTS } from "../freelance/events";
import { formatBudget } from "../freelance/budget";
import type { FreelanceChatMessageDto } from "../../shared/rpc/freelance";

// ---------------------------------------------------------------------------
// Tool subset available to the freelance chat agent
// ---------------------------------------------------------------------------

const FREELANCE_TOOL_NAMES = new Set([
  "read_file", "list_directory", "search_files", "search_content", "directory_tree",
  "run_shell",
  "web_search", "web_fetch", "http_request",
  "environment_info", "get_env", "get_agentdesk_paths", "sleep",
  "run_background", "check_process", "kill_process", "list_background_jobs",
  "read_skill", "read_skill_file", "find_skills",
]);

async function buildFreelanceTools(): Promise<Record<string, Tool>> {
  const all = getAllTools();
  const result: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(all)) {
    if (FREELANCE_TOOL_NAMES.has(name)) result[name] = tool;
  }
  // Replace run_shell with the auto-approved variant — no global state, no gate.
  result["run_shell"] = autoApprovedShellTool;
  // Merge in any connected MCP tools configured in settings
  try {
    const { getMcpTools } = await import("../mcp/client");
    Object.assign(result, getMcpTools());
  } catch { /* MCP unavailable — continue without */ }
  return result;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildSystemPrompt(
  listing: typeof freelanceListings.$inferSelect,
  fullDescription: string | null,
): Promise<string> {
  const skillsSection = buildSkillsDescriptionSection(false);
  let skills: string[] = [];
  try { skills = JSON.parse(listing.skills) as string[]; } catch { /* ignore */ }

  const platformName = listing.platform === "upwork" ? "Upwork" : "Freelancer.com";
  // null = not yet fetched, "" = fetch attempted but failed → both fall back to RSS description
  const hasFullDescription = Boolean(fullDescription && fullDescription.length > 0);
  const descriptionToUse = hasFullDescription ? fullDescription : listing.description;

  let prompt = `You are a seasoned freelance strategist helping a developer evaluate and bid on a ${platformName} listing.

Active Listing:
Title: ${listing.title}
Platform: ${platformName}
Budget: ${formatBudget(listing.budgetMin, listing.budgetMax, listing.budgetType, listing.currency)}
Skills: ${skills.length > 0 ? skills.join(", ") : "Not specified"}
${listing.postedAt ? `Posted: ${listing.postedAt}` : ""}
URL: ${listing.url}

Description:
${descriptionToUse}

${hasFullDescription
    ? "The Description above is the COMPLETE project description, already fetched and extracted from the listing page. It is everything the page shows. Do NOT re-fetch the listing URL — no http_request, no web_fetch, no browser/chrome-devtools tools — answer from the description you already have."
    : "The Description above is the short RSS preview; the full listing page could not be fetched automatically. If you need more detail, you may fetch the listing URL once with http_request — never open a browser for it."}

Your role: You are expert freelancer and communication expert. Help the user craft compelling proposals, analyze this opportunity, estimate timelines and pricing, spot red flags, and draft bid responses they can copy-paste directly to the client.

---

DELIVERY MODEL — how the user actually delivers projects (this changes how you evaluate listings):

The user does not do the development work personally. Projects are built by an autonomous AI agent system (specialized agents for backend, frontend, database, DevOps, QA, UI/UX, research) that can read/write files, run shell commands, use git, browse the web, and call APIs. The user can install any software, libraries, or tools the agents need.

The user (human operator) handles everything that is not coding: client communication, requirements clarification, obtaining credentials/accounts/datasets/platform access, deployment, demos, delivery, design sign-off, and ongoing operations. These are routine parts of the workflow, not obstacles.

Therefore, when the user asks whether a project is feasible or worth bidding on, judge ONE thing: can the AI agents create/develop/code 100% of what the client asked for? NEVER count any of the following against a listing, as blockers, red flags, or reasons to skip:
- Budget, pricing, effort-vs-reward, or rate-vs-market comparisons (AI agents have no salary; cost-of-labor math doesn't apply)
- Seniority or years-of-experience requirements, "full-time role" or "end-to-end ownership" wording, job-description framing
- Vague scope, undefined success criteria, missing timelines, unclear deliverables (the human clarifies these with the client)
- Client-owned credentials, accounts, datasets, existing codebases, or platform access (the human obtains them)
- Deployment, rollout, monitoring, on-call, operations, design sign-off, stakeholder communication

The only true blockers are things that make the development work itself impossible for AI agents: physical hardware the code must run on that can't be simulated or accessed remotely, proprietary closed systems with no API or documentation, or work that is fundamentally not software (on-site presence, video presenting, etc.).

---

CRITICAL RULES — never break these:

CONFIDENTIALITY:
- The "Additional Notes" section contains private context provided by the user. Never quote, paraphrase, summarize, reference, or reveal any part of it in your responses under any circumstances.

HONESTY:
- Never invent past projects, past clients, portfolio items, metrics, or experience the user hasn't told you about. If you need their background to write a strong proposal, ask for it first.
- If writing a bid proposal and the user hasn't shared their relevant experience, write it based on the technical approach and understanding of the project only — no fabricated "I did this before" claims.
- Placeholders are fine: use [Your Name], [your portfolio link], [mention your relevant experience here] rather than making things up.

PROPOSALS:
- Always open a bid proposal with a salutation. Use "Hi," or "Hi [Client Name]," as the opener since the client's name is usually not known.
- Keep the opening line focused on the client's problem, not on you.

---

WRITING RULES — follow all 29 of these without exception. The user may copy your output directly to clients. It must read as written by a real person.

CONTENT:
1. No significance inflation. Don't frame things as "a pivotal moment" or "a game-changing opportunity." State facts.
2. No vague name-dropping. If you cite something, be specific — no "experts say" or "studies show."
3. No hollow -ing analysis. Don't write "showcasing their expertise" or "reflecting a commitment to quality." Say the actual thing.
4. No promotional fluff. Cut "breathtaking," "nestled," "innovative," "passionate," "dedicated."
5. No vague attributions. Cite real specifics or drop the claim entirely.
6. No formulaic challenge framing. Don't write "Despite challenges, X continues to thrive." Give real details or skip it.

LANGUAGE:
7. No AI vocabulary. Never use: utilize, leverage, delve, seamlessly, groundbreaking, revolutionize, comprehensive, robust, streamline, synergy, paradigm shift, cutting-edge, game-changing, facilitate, testament, landscape, boasts, showcases, underscores, pivotal, vibrant, thriving, foster, spearhead, embark, unleash, unlock.
8. No copula avoidance. Write "is" and "has" — not "serves as," "boasts," "stands as," "acts as."
9. No negative parallelisms. Don't write "It's not just X, it's Y." Just say Y.
10. No forced rule of three. Don't pad lists to three items. Use as many as needed.
11. No synonym cycling. Use the clearest word every time, even if repeated.
12. No false ranges. Don't write "from A to B" when you can just list the things.
13. Name the actor. Prefer active voice: "I built" not "it was built."

STYLE:
14. No em dash overuse. Use commas or periods instead of — dashes — everywhere.
15. No unnecessary bold. Only bold something if it would be bolded in a real email or proposal.
16. No inline-header lists. Write prose, not "Reliability: I deliver on time."
17. No title case in headings. Use sentence case.
18. No emojis.
19. Use straight quotes, not curly/smart quotes.
26. No hyphenated word pairs unless standard (e.g., "full-stack" is fine, "result-driven" is not).
27. No persuasive authority tropes. Don't write "As a seasoned professional..." Just make the point.
28. No signposting. Don't write "Let's dive in," "Let's break this down," "Here's what I found."
29. Headings stand alone. Don't follow a heading with a sentence that repeats it.

COMMUNICATION:
20. No chatbot artifacts. Never write "I hope this helps!", "Happy to assist!", "Feel free to ask," "Let me know if you need anything else."
21. No hedge disclaimers. Don't caveat with knowledge cutoff dates or "I can't be certain." Give the best answer or say nothing.
22. No sycophancy. Don't open with "Great question!" or "That's a really interesting challenge." Just answer.

FILLER AND HEDGING:
23. No filler phrases. "To" not "In order to." "Because" not "Due to the fact that."
24. No excessive hedging. One qualifier is enough. Not "it's possible that it might perhaps be worth considering."
25. No generic conclusions. End with a specific fact, number, or next step — not "Overall, this is a promising opportunity."

VOICE:
- Use contractions: don't, can't, I'll, you'd, it's, we're, wouldn't.
- Mix sentence lengths. Short ones hit harder.
- Have opinions. Say "skip this one" when you mean it — but only for the true blockers defined in the DELIVERY MODEL section, never for budget or scope vagueness.
- When writing a bid proposal or client message, write it as final copy the user sends as-is.
- Stop when done. No trailing sign-off.${skillsSection ? `

---

${skillsSection}` : ""}`;

  // Append user's additional notes if set
  try {
    const fs = await getFreelanceSettings();
    if (fs.additionalNotes.trim()) {
      prompt += `\n\n---\n\n## Additional Notes\n\n${fs.additionalNotes.trim()}`;
    }
  } catch { /* ignore */ }

  // Append MCP tool names if any are connected
  try {
    const { getMcpTools } = await import("../mcp/client");
    const mcpNames = Object.keys(getMcpTools());
    if (mcpNames.length > 0) {
      prompt += "\n\n---\n\n## MCP Tools\n\nYou have access to the following MCP server tools:\n" +
        mcpNames.map((n) => `- \`${n}\``).join("\n") +
        "\n\nUse these tools directly when the task requires them.";
    }
  } catch { /* MCP unavailable */ }

  return prompt;
}

// ---------------------------------------------------------------------------
// Load default provider + model
// ---------------------------------------------------------------------------

async function getDefaultProviderAndModel(): Promise<{ adapter: ReturnType<typeof createProviderAdapter>; providerType: string; modelId: string }> {
  const providerRows = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.isDefault, 1))
    .limit(1);

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

  const modelId = p.defaultModel ?? "gpt-4o-mini";
  return { adapter, providerType: p.providerType, modelId };
}

// The SDK's query() takes a single prompt, not a message array — flatten the
// conversation history into a text transcript, same approach engine.ts uses
// for the PM's own CLI/SDK-routed transcript.
function flattenHistoryForCli(history: Array<{ role: "user" | "assistant"; content: string }>): string {
  return history.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// RPC: getMessages
// ---------------------------------------------------------------------------

export async function getMessages(params: { listingId: string }): Promise<{ messages: FreelanceChatMessageDto[] }> {
  const rows = await db
    .select()
    .from(freelanceChatMessages)
    .where(eq(freelanceChatMessages.listingId, params.listingId))
    .orderBy(asc(freelanceChatMessages.createdAt));

  return {
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role as "user" | "assistant",
      content: r.content,
      createdAt: r.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// RPC: clearMessages
// ---------------------------------------------------------------------------

export async function clearMessages(params: { listingId: string }): Promise<{ success: boolean }> {
  await db
    .delete(freelanceChatMessages)
    .where(eq(freelanceChatMessages.listingId, params.listingId));
  return { success: true };
}

// ---------------------------------------------------------------------------
// Per-listing AbortController registry — allows stopChat to cancel a stream
// ---------------------------------------------------------------------------

const activeStreams = new Map<string, AbortController>();

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("aborted"))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Shared: start a streaming response and persist on completion
// ---------------------------------------------------------------------------

async function streamAndPersist(
  listingId: string,
  messageId: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  listing: typeof freelanceListings.$inferSelect,
  signal: AbortSignal,
): Promise<void> {
  let fullContent = "";
  try {
    const { adapter, providerType, modelId } = await getDefaultProviderAndModel();

    // Fetch + cache the full description on first use (shared with the bid
    // pipeline via ensureFullDescription). "" → fall back to RSS description.
    const fullDescription = await ensureFullDescription(listing, adapter, modelId, {
      onFetchStart: () => broadcastToWebview(FREELANCE_EVENTS.CHAT_FETCHING, { listingId }),
      onFetchDone: () => broadcastToWebview(FREELANCE_EVENTS.CHAT_FETCH_DONE, { listingId }),
    }, providerType);

    const systemPrompt = await buildSystemPrompt(listing, fullDescription);
    const tools = await buildFreelanceTools();

    // Track tool call start times for duration reporting
    const toolStartTimes = new Map<string, string>();
    const streamingMode = await getStreamingMode();
    const isFullStreaming = streamingMode === "full";
    const isNoStreaming = streamingMode === "none";

    // Claude Subscription's direct-HTTP OAuth path 429s for anything but
    // Haiku — non-Haiku models route through the official Agent SDK instead
    // (see providers/claude-subscription.ts / claude-subscription-cli-runner.ts).
    if (providerType === "claude-subscription" && !isHaikuModel(modelId)) {
      const { runClaudeCliTask } = await import("../providers/claude-subscription-cli-runner");
      // Full Streaming only — broadcastToWebview appends client-side, so only
      // the slice new since the last throttled flush is ever sent.
      let flushedLength = 0;
      const textAcc = isFullStreaming ? createThrottledAccumulator((acc) => {
        const delta = acc.slice(flushedLength);
        flushedLength = acc.length;
        if (delta) broadcastToWebview(FREELANCE_EVENTS.CHAT_TOKEN, { listingId, messageId, token: delta });
      }) : null;
      const cliResult = await runClaudeCliTask({
        task: flattenHistoryForCli(history),
        systemPrompt,
        tools,
        modelId,
        timeoutMs: 900_000,
        abortSignal: signal,
        verifyToolCall: false, // freelance chat is advisory Q&A — a turn may legitimately need zero tool calls
        onText: (text) => {
          fullContent += text;
          if (!isFullStreaming) broadcastToWebview(FREELANCE_EVENTS.CHAT_TOKEN, { listingId, messageId, token: text });
        },
        onReasoning: () => { /* freelance chat doesn't surface reasoning today (same as the streamText path, which never handled 'reasoning' parts) */ },
        onTextToken: (delta) => textAcc?.push(delta),
        onRetract: () => { textAcc?.cancel(); flushedLength = 0; },
        onToolCallStart: (toolName, args) => {
          const callId = crypto.randomUUID();
          const timeStart = new Date().toISOString();
          toolStartTimes.set(callId, timeStart);
          broadcastToWebview(FREELANCE_EVENTS.CHAT_TOOL_START, {
            listingId,
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
          broadcastToWebview(FREELANCE_EVENTS.CHAT_TOOL_DONE, {
            listingId,
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
        broadcastToWebview(FREELANCE_EVENTS.CHAT_STOPPED, { listingId });
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
        messages: history,
        tools,
        stopWhen: [isStepCount(100)],
        abortSignal: signal,
      });

      for await (const part of result.stream) {
        if (part.type === "text-delta") {
          const token = (part as { text?: string }).text ?? "";
          fullContent += token;
          if (!isNoStreaming) broadcastToWebview(FREELANCE_EVENTS.CHAT_TOKEN, { listingId, messageId, token });
        } else if (part.type === "tool-call") {
          const tc = (part as unknown) as { toolCallId: string; toolName: string; input: Record<string, unknown> };
          const timeStart = new Date().toISOString();
          toolStartTimes.set(tc.toolCallId, timeStart);
          broadcastToWebview(FREELANCE_EVENTS.CHAT_TOOL_START, {
            listingId,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            toolInput: JSON.stringify(tc.input),
            timeStart,
          });
        } else if (part.type === "tool-result") {
          const tr = (part as unknown) as { toolCallId: string; toolName: string; output: unknown; isError?: boolean };
          const timeStart = toolStartTimes.get(tr.toolCallId) ?? null;
          const timeEnd = new Date().toISOString();
          toolStartTimes.delete(tr.toolCallId);
          const toolOutput = typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output);
          broadcastToWebview(FREELANCE_EVENTS.CHAT_TOOL_DONE, {
            listingId,
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

    // If the signal was aborted (stream drained with 0 parts instead of throwing),
    // treat as a user-initiated stop — do not persist the empty message.
    if (signal.aborted) {
      broadcastToWebview(FREELANCE_EVENTS.CHAT_STOPPED, { listingId });
      return;
    }

    // Persist completed message
    await db.insert(freelanceChatMessages).values({
      id: messageId,
      listingId,
      role: "assistant",
      content: fullContent,
    });

    broadcastToWebview(FREELANCE_EVENTS.CHAT_COMPLETE, { listingId, messageId, content: fullContent });
  } catch (err) {
    if (isAbortError(err)) {
      broadcastToWebview(FREELANCE_EVENTS.CHAT_STOPPED, { listingId });
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[freelance-chat] Stream error:", err);
      broadcastToWebview(FREELANCE_EVENTS.CHAT_ERROR, { listingId, error: errorMsg });
    }
  } finally {
    activeStreams.delete(listingId);
  }
}

// ---------------------------------------------------------------------------
// RPC: sendMessage
// ---------------------------------------------------------------------------

export async function sendMessage(params: { listingId: string; content: string }): Promise<{ success: boolean; messageId: string }> {
  // Load listing for context
  const listingRows = await db
    .select()
    .from(freelanceListings)
    .where(eq(freelanceListings.id, params.listingId))
    .limit(1);

  if (!listingRows[0]) throw new Error(`Listing ${params.listingId} not found`);
  const listing = listingRows[0];

  // Insert user message
  const userMsgId = crypto.randomUUID();
  await db.insert(freelanceChatMessages).values({
    id: userMsgId,
    listingId: params.listingId,
    role: "user",
    content: params.content,
  });

  // Load full history for context
  const prior = await db
    .select()
    .from(freelanceChatMessages)
    .where(eq(freelanceChatMessages.listingId, params.listingId))
    .orderBy(asc(freelanceChatMessages.createdAt));

  const history = prior.map((r) => ({
    role: r.role as "user" | "assistant",
    content: r.content,
  }));

  // Kick off stream (fire-and-forget — RPC returns immediately)
  const assistantMsgId = crypto.randomUUID();
  const controller = new AbortController();
  activeStreams.set(params.listingId, controller);
  streamAndPersist(params.listingId, assistantMsgId, history, listing, controller.signal).catch(() => {});

  return { success: true, messageId: assistantMsgId };
}

// ---------------------------------------------------------------------------
// RPC: regenerate — remove last assistant message and re-stream
// ---------------------------------------------------------------------------

export async function regenerate(params: { listingId: string }): Promise<{ success: boolean; messageId: string }> {
  // Load listing (fresh from DB — includes fullDescription if already fetched)
  const listingRows = await db
    .select()
    .from(freelanceListings)
    .where(eq(freelanceListings.id, params.listingId))
    .limit(1);

  if (!listingRows[0]) throw new Error(`Listing ${params.listingId} not found`);
  const listing = listingRows[0];

  // Load all messages ordered ascending
  const all = await db
    .select()
    .from(freelanceChatMessages)
    .where(eq(freelanceChatMessages.listingId, params.listingId))
    .orderBy(asc(freelanceChatMessages.createdAt));

  // Find and delete the last assistant message
  const lastAssistant = [...all].reverse().find((m) => m.role === "assistant");
  if (lastAssistant) {
    await db
      .delete(freelanceChatMessages)
      .where(eq(freelanceChatMessages.id, lastAssistant.id));
  }

  // Build history without the deleted message
  const history = all
    .filter((m) => m.id !== lastAssistant?.id)
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));

  const newMessageId = crypto.randomUUID();
  const controller = new AbortController();
  activeStreams.set(params.listingId, controller);
  streamAndPersist(params.listingId, newMessageId, history, listing, controller.signal).catch(() => {});

  return { success: true, messageId: newMessageId };
}

// ---------------------------------------------------------------------------
// RPC: stopChat — abort an in-flight stream for a listing
// ---------------------------------------------------------------------------

export async function stopChat(params: { listingId: string }): Promise<{ success: boolean }> {
  const controller = activeStreams.get(params.listingId);
  if (controller) {
    controller.abort();
    activeStreams.delete(params.listingId);
  }
  return { success: true };
}
