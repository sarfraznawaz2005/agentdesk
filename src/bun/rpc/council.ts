/**
 * Council RPC — Delphi + Borda multi-agent discussion system.
 *
 * Flow:
 *   Phase 1: PM selects 3–5 relevant agents
 *   Phase 2: Optional PM clarification question to user
 *   Phase 3: Round 1 — blind parallel responses (no peer context)
 *   Phase 4: Convergence check — PM anonymises positions and checks agreement
 *   Phase 5: Round 2 — informed parallel responses (only if not converged)
 *   Phase 6: Borda ranking — each agent ranks peers in parallel via generateText
 *   Phase 7: PM synthesises final answer weighted by Borda scores
 *
 * Events are broadcast via broadcastToWebview("councilEvent", {...}).
 * The frontend listens on the `agentdesk:council-event` window event.
 */

import { generateText, streamText } from "ai";
import { db } from "../db";
import { aiProviders } from "../db/schema";
import { eq } from "drizzle-orm";
import { createProviderAdapter, getDefaultModel } from "../providers";
import { isHaikuModel } from "../providers/claude-subscription";
import { getStreamingMode } from "../agents/streaming-mode";
import { createThrottledAccumulator } from "../agents/throttled-accumulator";
import { broadcastToWebview } from "../engine-manager";
import { sendDesktopNotification } from "../notifications/desktop";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 2 as const; // Hard cap: Round 1 (blind) + Round 2 (informed) only
void MAX_ROUNDS; // referenced in comments/docs — kept as documentation constant
const MAX_AGENTS = 5;
const AGENT_STREAM_TIMEOUT_MS = 120_000;
// Truncate agent responses when building peer context to avoid token explosion
const RESPONSE_TRUNCATE_CHARS = 1500;

const COUNCIL_AGENTS = [
  { name: "software-architect", displayName: "Software Architect", color: "#8b5cf6" },
  { name: "backend-engineer", displayName: "Backend Engineer", color: "#3b82f6" },
  { name: "frontend_engineer", displayName: "Frontend Engineer", color: "#06b6d4" },
  { name: "database-expert", displayName: "Database Expert", color: "#f59e0b" },
  { name: "security-expert", displayName: "Security Expert", color: "#ef4444" },
  { name: "api-designer", displayName: "API Designer", color: "#10b981" },
  { name: "ui-ux-designer", displayName: "UI/UX Designer", color: "#ec4899" },
  { name: "performance-expert", displayName: "Performance Expert", color: "#f97316" },
  { name: "devops-engineer", displayName: "DevOps Engineer", color: "#6366f1" },
  { name: "ml-engineer", displayName: "ML Engineer", color: "#14b8a6" },
] as const;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface CouncilSession {
  sessionId: string;
  abortController: AbortController;
  questionResolvers: Map<string, (answer: string) => void>;
}

const activeSessions = new Map<string, CouncilSession>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(sessionId: string, payload: Record<string, unknown>): void {
  broadcastToWebview("councilEvent", { sessionId, ...payload });
}

interface CouncilProvider {
  adapter: ReturnType<typeof createProviderAdapter>;
  providerType: string;
  modelId: string;
}

async function resolveProvider(): Promise<CouncilProvider> {
  const rows = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
  const providerRow = rows[0] ?? (await db.select().from(aiProviders).limit(1))[0];
  if (!providerRow) throw new Error("No AI provider configured");

  const modelId = providerRow.defaultModel || getDefaultModel(providerRow.providerType);
  const adapter = createProviderAdapter({
    id: providerRow.id,
    name: providerRow.name,
    providerType: providerRow.providerType,
    apiKey: providerRow.apiKey ?? "",
    baseUrl: providerRow.baseUrl ?? null,
    defaultModel: providerRow.defaultModel ?? null,
  });

  return { adapter, providerType: providerRow.providerType, modelId };
}

/**
 * One text completion, used for every Council phase (PM selection/
 * clarification/convergence/synthesis, per-agent round responses, per-agent
 * Borda ranking). Claude Subscription's direct-HTTP OAuth path 429s for
 * anything but Haiku, so non-Haiku models route through the official Agent
 * SDK instead — each call spawns its own `claude` subprocess (no tools
 * needed here, every Council phase is pure text), trading per-call overhead
 * for using the user's actual configured Sonnet/Opus rather than silently
 * downgrading to Haiku. onToken (if given) fires incrementally either way,
 * so streaming call sites (runParallelRound, the final synthesis) don't need
 * to branch themselves. Throws on failure, same contract generateText/
 * streamText's consuming code here already expects.
 */
async function councilComplete(opts: {
  provider: CouncilProvider;
  system: string;
  prompt: string;
  signal: AbortSignal;
  timeoutMs?: number;
  onToken?: (token: string) => void;
}): Promise<string> {
  const { provider, instructions: system, prompt, signal, onToken } = opts;
  const streamingMode = await getStreamingMode();

  if (provider.providerType === "claude-subscription" && !isHaikuModel(provider.modelId)) {
    const { runClaudeCliTask } = await import("../providers/claude-subscription-cli-runner");
    const isFullStreaming = streamingMode === "full";
    let fullText = "";
    // Full Streaming only — onToken is treated as a delta-append callback by
    // every caller (matches the non-CLI branch's per-chunk onToken(chunk)
    // below), so only the slice new since the last throttled flush is sent.
    let flushedLength = 0;
    const textAcc = isFullStreaming && onToken ? createThrottledAccumulator((acc) => {
      const delta = acc.slice(flushedLength);
      flushedLength = acc.length;
      if (delta) onToken(delta);
    }) : null;
    const cliResult = await runClaudeCliTask({
      task: prompt,
      systemPrompt: system,
      tools: {},
      modelId: provider.modelId,
      timeoutMs: opts.timeoutMs ?? AGENT_STREAM_TIMEOUT_MS,
      abortSignal: signal,
      verifyToolCall: false, // no tools offered — every Council phase is a pure text completion
      onText: (text) => { fullText += text; if (!isFullStreaming) onToken?.(text); },
      onReasoning: () => { /* Council doesn't surface reasoning today, same as the generateText/streamText path */ },
      onTextToken: (delta) => textAcc?.push(delta),
      onRetract: () => { textAcc?.cancel(); flushedLength = 0; },
      onToolCallStart: () => crypto.randomUUID(),
      onToolCallEnd: () => {},
    });
    textAcc?.flushNow();
    if (cliResult.status === "cancelled") throw new DOMException("Aborted", "AbortError");
    if (cliResult.status === "failed" || cliResult.status === "timeout") throw new Error(cliResult.summary);
    return fullText.trim() || cliResult.summary.trim();
  }

  const model = provider.adapter.createModel(provider.modelId);
  if (onToken) {
    const stream = streamText({ model, abortSignal: signal, instructions, messages: [{ role: "user", content: prompt }] });
    let fullText = "";
    for await (const chunk of stream.textStream) {
      if (signal.aborted) break;
      fullText += chunk;
      if (streamingMode !== "none") onToken(chunk);
    }
    return fullText;
  }
  const result = await generateText({ model, abortSignal: signal, instructions, messages: [{ role: "user", content: prompt }] });
  return result.text;
}

/** Truncate a response string for use as peer context. */
function truncate(text: string): string {
  if (text.length <= RESPONSE_TRUNCATE_CHARS) return text;
  return text.slice(0, RESPONSE_TRUNCATE_CHARS) + "\n[...truncated]";
}


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startCouncilSession(query: string, context?: string): Promise<{ sessionId: string }> {
  const sessionId = `council-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const abortController = new AbortController();
  const session: CouncilSession = {
    sessionId,
    abortController,
    questionResolvers: new Map(),
  };
  activeSessions.set(sessionId, session);

  // Run the session asynchronously — return the sessionId immediately
  runSession(session, query, context).catch((err: unknown) => {
    // Only suppress actual user-triggered aborts (DOMException name === "AbortError")
    const isAbort =
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError");
    if (!isAbort) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Council] session error:", message, err);
      emit(sessionId, { type: "error", message });
    }
    emit(sessionId, { type: "session-ended" });
    activeSessions.delete(sessionId);
  });

  return { sessionId };
}

export function stopCouncilSession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.abortController.abort();
    activeSessions.delete(sessionId);
  }
}

export function answerCouncilQuestion(
  sessionId: string,
  questionId: string,
  answer: string,
): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  const resolve = session.questionResolvers.get(questionId);
  if (resolve) {
    resolve(answer);
    session.questionResolvers.delete(questionId);
  }
}

// ---------------------------------------------------------------------------
// Core session logic
// ---------------------------------------------------------------------------

type AgentEntry = (typeof COUNCIL_AGENTS)[number];

interface RoundResponse {
  agentName: string;
  displayName: string;
  content: string;
}

/**
 * Run one round of parallel agent responses.
 * Each agent stream runs concurrently inside Promise.all.
 * Per-agent timeout via Promise.race — timed-out agents are skipped gracefully.
 */
async function runParallelRound(
  sessionId: string,
  signal: AbortSignal,
  provider: CouncilProvider,
  round: number,
  agents: AgentEntry[],
  buildMessages: (agent: AgentEntry) => Array<{ role: "user"; content: string }>,
  buildSystem: (agent: AgentEntry) => string,
): Promise<RoundResponse[]> {
  emit(sessionId, { type: "round-start", round });

  const results = await Promise.all(
    agents.map(async (agent): Promise<RoundResponse | null> => {
      if (signal.aborted) return null;

      emit(sessionId, { type: "agent-thinking", agentName: agent.name, round });

      let agentResponse = "";

      const streamPromise = (async () => {
        const messages = buildMessages(agent);
        const prompt = messages.map((m) => m.content).join("\n\n");
        // The return value is the sole source of truth for the agent's
        // response — onToken is a UI-only side channel that councilComplete
        // itself may legitimately suppress (No Streaming mode never calls it
        // at all), so accumulating agentResponse from onToken would silently
        // drop the whole response in that mode.
        agentResponse = await councilComplete({
          provider,
          instructions: buildSystem(agent),
          prompt,
          signal,
          onToken: (chunk) => {
            if (signal.aborted) return;
            emit(sessionId, { type: "agent-token", agentName: agent.name, token: chunk, round });
          },
        });
      })();

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("agent-timeout")), AGENT_STREAM_TIMEOUT_MS),
      );

      try {
        await Promise.race([streamPromise, timeoutPromise]);
      } catch (err) {
        // Re-throw user aborts so the session stops cleanly
        const isAbort =
          (err instanceof DOMException && err.name === "AbortError") ||
          (err instanceof Error && err.name === "AbortError");
        if (isAbort) throw err;

        // Timeout or any other agent-level error — skip this agent gracefully
        const isTimeout = err instanceof Error && err.message === "agent-timeout";
        console.warn(
          `[Council] agent ${agent.name} ${isTimeout ? "timed out" : "errored"} in round ${round}:`,
          isTimeout ? "(120s)" : err,
        );
        emit(sessionId, { type: "agent-response-complete", agentName: agent.name, round, content: agentResponse.trim() });
        return agentResponse.trim()
          ? { agentName: agent.name, displayName: agent.displayName, content: agentResponse.trim() }
          : null;
      }

      emit(sessionId, { type: "agent-response-complete", agentName: agent.name, round, content: agentResponse.trim() });

      if (!agentResponse.trim()) return null;
      return { agentName: agent.name, displayName: agent.displayName, content: agentResponse.trim() };
    }),
  );

  emit(sessionId, { type: "round-complete", round });

  return results.filter((r): r is RoundResponse => r !== null);
}

/**
 * Borda ranking phase.
 * Each agent ranks all other agents' responses via parallel generateText calls.
 * Returns a map of agentName → cumulative Borda score.
 */
async function runBordaRanking(
  signal: AbortSignal,
  provider: CouncilProvider,
  responses: RoundResponse[],
): Promise<Record<string, number>> {
  const scores: Record<string, number> = {};
  for (const r of responses) scores[r.agentName] = 0;

  if (responses.length < 2) return scores;

  await Promise.all(
    responses.map(async (ranker) => {
      // Build the numbered list of OTHER agents' responses (no names)
      const others = responses.filter((r) => r.agentName !== ranker.agentName);
      if (others.length === 0) return;

      const numbered = others
        .map((r, i) => `[${i + 1}] ${truncate(r.content)}`)
        .join("\n\n---\n\n");

      let rankingText: string;
      try {
        rankingText = (await councilComplete({
          provider,
          signal,
          instructions: `You are ${ranker.displayName}. Rank the following peer responses from best (most insightful and accurate) to worst. Reply with ONLY a JSON array of 1-indexed positions from best to worst. e.g. [2,1,3]`,
          prompt: `Peer responses to rank:\n\n${numbered}`,
        })).trim();
      } catch {
        // If ranking fails for this agent, skip — don't crash the whole phase
        return;
      }

      // Parse the ranking array
      let ranking: number[];
      try {
        const match = rankingText.match(/\[[\s\S]*?\]/);
        const parsed: unknown = JSON.parse(match ? match[0] : rankingText);
        if (!Array.isArray(parsed)) return; // Valid JSON but not an array — skip
        ranking = parsed as number[];
      } catch {
        return; // Unparseable — skip
      }

      const numOthers = others.length;
      ranking.forEach((pos, kIndex) => {
        const idx = pos - 1; // convert 1-indexed to 0-indexed
        if (idx >= 0 && idx < others.length) {
          const agentName = others[idx].agentName;
          // kIndex=0 means ranked best → gets (numOthers - 0 - 1) = numOthers-1 points
          scores[agentName] = (scores[agentName] ?? 0) + (numOthers - 1 - kIndex);
        }
      });
    }),
  );

  return scores;
}

async function runSession(session: CouncilSession, query: string, context?: string): Promise<void> {
  const { sessionId, abortController } = session;
  const signal = abortController.signal;

  // If this is a follow-up, enrich the query with prior context so every
  // phase (agent selection, prompts, synthesis) is naturally aware of it.
  const effectiveQuery = context
    ? `[Prior Council Discussion]:\n${context}\n\n[Follow-up Question]: ${query}`
    : query;

  emit(sessionId, { type: "session-started", query });
  emit(sessionId, { type: "pm-status", message: "PM is assembling the council..." });

  const provider = await resolveProvider();

  // ── Phase 1: PM selects 3–5 relevant agents ────────────────────────────
  const agentListStr = COUNCIL_AGENTS.map((a) => a.name).join(", ");

  const selectionText = await councilComplete({
    provider,
    signal,
    instructions: `You are the Project Manager for a council of AI experts. Select the most relevant experts to answer the user's question. Default target is 3 agents; select up to 5 for complex multi-domain questions. Respond with ONLY a valid JSON array of agent names, e.g.: ["backend-engineer","security-expert"]. No markdown, no explanation.`,
    prompt: `Available agents: ${agentListStr}\n\nUser question: ${effectiveQuery}\n\nWhich 3-5 agents should participate in this council?`,
  });

  let selectedNames: string[];
  try {
    const raw = selectionText.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    selectedNames = JSON.parse(match ? match[0] : raw) as string[];
  } catch {
    selectedNames = [COUNCIL_AGENTS[0].name, COUNCIL_AGENTS[1].name, COUNCIL_AGENTS[2].name];
  }

  // Validate names and cap at MAX_AGENTS
  const selectedAgents = selectedNames
    .map((name) => COUNCIL_AGENTS.find((a) => a.name === name))
    .filter((a): a is AgentEntry => a !== undefined)
    .slice(0, MAX_AGENTS);

  // Ensure at least 2 agents
  if (selectedAgents.length < 2) {
    selectedAgents.push(...COUNCIL_AGENTS.slice(0, 2 - selectedAgents.length));
  }

  emit(sessionId, {
    type: "agents-selected",
    agents: selectedAgents.map((a) => ({ name: a.name, displayName: a.displayName, color: a.color })),
  });
  emit(sessionId, { type: "pm-status", message: "PM is reviewing your question..." });

  // ── Phase 2: Optional PM clarification ────────────────────────────────
  const clarificationText = (await councilComplete({
    provider,
    signal,
    instructions: `You are the Project Manager facilitating an expert council discussion. Determine if the user's question is missing a critical technical detail that would meaningfully change the experts' recommendations. Ask ONLY about technical or domain constraints (e.g. scale, existing infrastructure, specific requirements) — never about team size, budget, or process. If a useful clarification exists, respond with "QUESTION: <one concise technical question>". If the question is sufficiently clear, respond with "PROCEED". When in doubt, prefer PROCEED.`,
    prompt: `User question: ${effectiveQuery}`,
  })).trim();

  // Use a mutable local so clarification answers augment the effective query
  let activeQuery = effectiveQuery;

  if (clarificationText.startsWith("QUESTION:")) {
    const questionText = clarificationText.replace(/^QUESTION:\s*/, "").trim();
    const questionId = `q-${Date.now()}`;

    emit(sessionId, { type: "question", questionId, question: questionText });

    const userAnswer = await new Promise<string>((resolve, reject) => {
      session.questionResolvers.set(questionId, resolve);
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });

    activeQuery = `${effectiveQuery}\n\nAdditional context from user: ${userAnswer}`;
  }

  emit(sessionId, {
    type: "pm-status",
    message: `Council assembled: ${selectedAgents.map((a) => a.displayName).join(", ")}. Starting discussion...`,
  });

  // ── Phase 3: Round 1 — Blind parallel responses ────────────────────────
  const round1Responses = await runParallelRound(
    sessionId,
    signal,
    provider,
    1,
    selectedAgents,
    (agent) => [
      {
        role: "user" as const,
        content: `Question: ${activeQuery}\n\nPlease share your expert perspective as ${agent.displayName}.`,
      },
    ],
    (agent) =>
      `You are ${agent.displayName}. Answer this question with your genuine expert perspective. Do not hedge — give your clearest recommendation and the top 2–3 reasons for it. 3 paragraphs max.`,
  );

  if (signal.aborted) return;

  // ── Phase 4: Convergence check ─────────────────────────────────────────
  emit(sessionId, { type: "pm-status", message: "PM is checking for convergence..." });

  // Build anonymised position labels: Position A, B, C …
  const positionLabels = ["A", "B", "C", "D", "E"];
  const anonymisedPositions = round1Responses
    .map((r, i) => `Position ${positionLabels[i] ?? i + 1}: ${truncate(r.content)}`)
    .join("\n\n---\n\n");

  const convergenceText = await councilComplete({
    provider,
    signal,
    instructions: `You are the Project Manager reviewing anonymous expert positions. Determine whether these positions agree on the core recommendation. Reply with ONLY valid JSON: {"converged": true/false, "summary": "<brief anonymized summary of all positions for agents to review>"}`,
    prompt: `User question: ${activeQuery}\n\nAnonymous positions:\n${anonymisedPositions}`,
  });

  let converged: boolean;
  let anonymisedSummary = anonymisedPositions;

  try {
    const raw = convergenceText.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as {
      converged: boolean;
      summary: string;
    };
    converged = Boolean(parsed.converged);
    if (parsed.summary) anonymisedSummary = parsed.summary;
  } catch {
    // Default to not converged on parse failure
    converged = false;
  }

  emit(sessionId, {
    type: "pm-status",
    message: converged
      ? "Positions converged after Round 1. Skipping Round 2."
      : "Positions diverged. Starting Round 2 for revised positions...",
    summary: anonymisedSummary,
  });

  // ── Phase 4b: Emit convergence or proceed ─────────────────────────────
  let finalResponses: RoundResponse[] = round1Responses;

  if (converged) {
    emit(sessionId, { type: "convergence", converged: true, summary: anonymisedSummary });
  } else {
    // ── Phase 5: Round 2 — Informed parallel responses ──────────────────
    if (signal.aborted) return;

    const round2Responses = await runParallelRound(
      sessionId,
      signal,
      provider,
      2,
      selectedAgents,
      (agent) => [
        {
          role: "user" as const,
          content: `Original question: ${activeQuery}\n\nAnonymous peer positions from Round 1:\n${anonymisedSummary}\n\nPlease give your revised or maintained final position as ${agent.displayName}.`,
        },
      ],
      (agent) =>
        `You are ${agent.displayName}. You've seen the anonymous positions of your peers (above). Do you revise your position or maintain it? State your final position clearly and explain whether/why you changed your view. 2–3 paragraphs.`,
    );

    if (round2Responses.length > 0) {
      finalResponses = round2Responses;
    }
    // If round 2 yielded no results (all timed out), fall back to round 1
  }

  if (signal.aborted) return;

  // Guard: need at least 2 responses to run Borda ranking and produce a meaningful synthesis
  if (finalResponses.length < 2) {
    const got = finalResponses.length;
    const msg = got === 1
      ? "Only 1 agent responded — need at least 2 for a meaningful council decision. Please try again."
      : "No agents responded successfully. Please check your AI provider and try again.";
    // Throw so the catch handler in startCouncilSession emits error + session-ended and cleans up.
    throw new Error(msg);
  }

  // ── Phase 6: Borda ranking ─────────────────────────────────────────────
  emit(sessionId, { type: "pm-status", message: "Agents are peer-ranking responses..." });

  const bordaScores = await runBordaRanking(signal, provider, finalResponses);

  // Agents that timed out / errored get a score of 0 so the sidebar shows ★0 for them
  for (const agent of selectedAgents) {
    if (bordaScores[agent.name] === undefined) {
      bordaScores[agent.name] = 0;
    }
  }

  emit(sessionId, { type: "borda-scores", scores: bordaScores });

  if (signal.aborted) return;

  // ── Phase 7: PM synthesises final answer ──────────────────────────────
  emit(sessionId, { type: "pm-synthesizing" });

  // Build the full discussion context for the PM (with agent names, unlike Borda phase)
  const discussionContext = finalResponses
    .map((r) => {
      const scoreLabel =
        bordaScores[r.agentName] !== undefined ? ` (Borda score: ${bordaScores[r.agentName]})` : "";
      return `[${r.displayName}${scoreLabel}]: ${r.content}`;
    })
    .join("\n\n---\n\n");

  const scoresStr = Object.entries(bordaScores)
    .map(([name, score]) => {
      const agent = COUNCIL_AGENTS.find((a) => a.name === name);
      return `${agent?.displayName ?? name}: ${score}`;
    })
    .join(", ");

  const didConverge = converged;

  // The return value is the sole source of truth — onToken is a UI-only side
  // channel councilComplete may legitimately suppress (No Streaming mode
  // never calls it at all), so the final answer must not depend on it firing.
  const finalAnswer = await councilComplete({
    provider,
    signal,
    instructions: `You are the Project Manager synthesizing a council discussion. The peer-ranked scores are: ${scoresStr}. The highest-scoring position should anchor your recommendation. ${
      !didConverge
        ? "If agents disagreed and did NOT converge, explicitly surface the disagreement: describe both positions and give a conditional recommendation."
        : ""
    } Use markdown with headers, bullet points, and code blocks where helpful.`,
    prompt: `User question: ${activeQuery}\n\nExpert discussion${didConverge ? " (converged after Round 1)" : " (two rounds)"}:\n${discussionContext}\n\nPlease provide the final council decision and recommendation.`,
    onToken: (chunk) => {
      if (signal.aborted) return;
      emit(sessionId, { type: "final-answer-token", token: chunk });
    },
  });

  emit(sessionId, { type: "final-answer-complete", content: finalAnswer });

  // OS-level desktop notification so the user knows the council has reached a decision
  sendDesktopNotification(
    "Council Decision Ready",
    "The council has reached a final decision.",
  ).catch(() => {});

  emit(sessionId, { type: "session-ended" });

  activeSessions.delete(sessionId);
}
