import type { AgentStatusValue, Message } from "./chat-types";
import { useChatStore, sortConversations } from "./chat-store";
import { toast } from "../components/ui/toast";

// ---------------------------------------------------------------------------
// Completed-stream guard
// ---------------------------------------------------------------------------

/**
 * Set of messageIds whose streams have completed (or errored).
 * Late `stream-token` events for any completed stream are dropped to prevent
 * the PM bubble from getting stuck in a streaming state.
 * Capped at 50 entries to avoid unbounded growth across a long session.
 */
const completedStreamIds = new Set<string>();
const COMPLETED_STREAM_IDS_MAX = 50;

function markStreamCompleted(messageId: string): void {
  completedStreamIds.add(messageId);
  if (completedStreamIds.size > COMPLETED_STREAM_IDS_MAX) {
    // Remove oldest entry (Sets preserve insertion order)
    const first = completedStreamIds.values().next().value;
    if (first !== undefined) completedStreamIds.delete(first);
  }
}

// ---------------------------------------------------------------------------
// Mutable buffer state — exported as a single object so the store's reset()
// can mutate individual fields through the reference (plain let-exports are
// bound by value at import time in ES modules and cannot be written from
// outside the declaring module).
// ---------------------------------------------------------------------------

export const buffers = {
  tokenBuffer: "",
  tokenFlushTimer: null as ReturnType<typeof setTimeout> | null,
  tokenStreamMeta: null as { conversationId: string; messageId: string } | null,
};

const TOKEN_FLUSH_INTERVAL = 32; // ms (~30 fps)

// ---------------------------------------------------------------------------
// Token flush helper
// ---------------------------------------------------------------------------

function flushTokenBuffer(): void {
  buffers.tokenFlushTimer = null;
  if (!buffers.tokenBuffer || !buffers.tokenStreamMeta) return;
  const buf = buffers.tokenBuffer;
  const meta = buffers.tokenStreamMeta;
  buffers.tokenBuffer = "";
  useChatStore.setState((prev) => {
    // Ensure PM placeholder exists in messages array on first token flush
    // so onStreamComplete can find it and update in place (preserving timestamp).
    const hasMsg = prev.messages.some((m) => m.id === meta.messageId);
    const messages = hasMsg ? prev.messages : [...prev.messages, {
      id: meta.messageId,
      conversationId: prev.activeConversationId ?? "",
      role: "assistant" as const,
      agentId: null,
      agentName: null,
      content: "",
      metadata: null,
      tokenCount: 0,
      hasParts: 0,
      createdAt: new Date().toISOString(),
    }];
    return {
      messages,
      isStreaming: true,
      pmPending: false,
      streamingMessageId: meta.messageId,
      streamingContent: prev.streamingContent + buf,
    };
  });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onStreamToken(e: Event): void {
  const { conversationId, messageId, token } = (e as CustomEvent<{
    conversationId: string;
    messageId: string;
    token: string;
    agentId: string | null;
  }>).detail;

  // Drop tokens for an already-completed stream
  if (completedStreamIds.has(messageId)) return;

  const state = useChatStore.getState();
  if (state.activeConversationId !== conversationId) return;

  buffers.tokenStreamMeta = { conversationId, messageId };
  buffers.tokenBuffer += token;

  if (!buffers.tokenFlushTimer) {
    buffers.tokenFlushTimer = setTimeout(flushTokenBuffer, TOKEN_FLUSH_INTERVAL);
  }
}

function onStreamReset(e: Event): void {
  const { conversationId, messageId } = (e as CustomEvent<{
    conversationId: string;
    messageId: string;
  }>).detail;

  const state = useChatStore.getState();
  if (state.activeConversationId !== conversationId) return;

  // Clear any pending token buffer
  if (buffers.tokenFlushTimer) {
    clearTimeout(buffers.tokenFlushTimer);
    buffers.tokenFlushTimer = null;
  }
  buffers.tokenBuffer = "";

  useChatStore.setState((prev) => {
    // Ensure PM's placeholder message exists in the messages array so
    // onStreamComplete can find it and update in place (preserving its
    // early timestamp). Without this, PM gets appended as new with a
    // late timestamp and sorts after agent messages.
    const hasPlaceholder = prev.messages.some((m) => m.id === messageId);
    const messages = hasPlaceholder ? prev.messages : [...prev.messages, {
      id: messageId,
      conversationId,
      role: "assistant" as const,
      agentId: null,
      agentName: null,
      content: "",
      metadata: null,
      tokenCount: 0,
      hasParts: 0,
      createdAt: new Date().toISOString(),
    }];
    return {
      messages,
      streamingContent: "",
      streamingMessageId: messageId,
      isStreaming: true,
    };
  });
}

function onStreamComplete(e: Event): void {
  // Event may be fired with no detail (e.g. to trigger UI refresh after a reset).
  const detail = (e as CustomEvent<{
    conversationId: string;
    messageId: string;
    content: string;
    metadata?: string | null;
    usage: { promptTokens: number; completionTokens: number };
  } | null>).detail;
  if (!detail) return;
  const { conversationId, messageId, content, metadata, usage } = detail;

  // Flush any pending token buffer before processing completion
  if (buffers.tokenFlushTimer) {
    clearTimeout(buffers.tokenFlushTimer);
    buffers.tokenFlushTimer = null;
  }
  flushTokenBuffer();
  buffers.tokenStreamMeta = null;

  // Record this as a completed stream so late tokens are dropped.
  markStreamCompleted(messageId);

  const state = useChatStore.getState();

  // Prefer the backend-delivered content; fall back to accumulated streaming content.
  const finalContent = content || state.streamingContent;

  useChatStore.setState((prev) => {
    const streaming = {
      isStreaming: false as const,
      streamingMessageId: null as string | null,
      streamingContent: "",
      pmThinkingText: "",
    };

    // Resolve metadata: prefer backend-supplied, but if it lacks reasoning
    // and we have live thinking text in the store, inject it client-side.
    const resolveMetadata = (existing?: string | null): string | null => {
      // Start with backend metadata or existing message metadata
      const base = metadata ?? existing ?? null;
      let parsed: Record<string, unknown> | null = null;
      try { parsed = base ? JSON.parse(base) : null; } catch { /* ignore */ }

      // If already has reasoning, use as-is
      if (parsed?.reasoning) return base;

      // Inject live thinking text from store as reasoning
      if (prev.pmThinkingText) {
        const merged = { ...(parsed ?? {}), reasoning: prev.pmThinkingText };
        return JSON.stringify(merged);
      }
      return base;
    };

    // Stale stream completion — a newer stream is active (e.g. user sent a
    // new message that aborted the previous PM stream). Don't clear streaming
    // state; just update the message content if applicable.
    if (prev.streamingMessageId && prev.streamingMessageId !== messageId) {
      if (!finalContent.trim()) return {};
      const existingIdx = prev.messages.findIndex((m) => m.id === messageId);
      if (existingIdx >= 0) {
        const updatedMessages = prev.messages.map((m, i) =>
          i === existingIdx ? { ...m, content: finalContent, metadata: resolveMetadata(m.metadata), createdAt: new Date().toISOString() } : m,
        );
        return { messages: updatedMessages };
      }
      return {};
    }

    // AI returned nothing — just clear streaming state.
    if (!finalContent.trim()) return streaming;

    // Only update the messages array if this conversation's messages are
    // currently loaded. If the user is on a completely different page,
    // don't pollute the store — loadMessages will fetch from DB (which the
    // backend has already updated) when the user navigates back.
    const convMessages = prev.messages.filter((m) => m.conversationId === conversationId);
    if (convMessages.length === 0) return streaming;

    const finalMetadata = resolveMetadata(null);

    const completedMessage: Message = {
      id: messageId,
      conversationId,
      role: "assistant",
      agentId: null,
      agentName: null,
      content: finalContent,
      metadata: finalMetadata,
      tokenCount: usage.completionTokens,
      hasParts: 0,
      createdAt: new Date().toISOString(),
    };

    const existingIdx = prev.messages.findIndex((m) => m.id === messageId);
    let updatedMessages: Message[];
    if (existingIdx >= 0) {
      // Bump createdAt to now so the PM's final response sorts AFTER any agent
      // messages it spawned (agents ran between T1 and completion time).
      const updated = { ...prev.messages[existingIdx], content: finalContent, tokenCount: usage.completionTokens, metadata: resolveMetadata(prev.messages[existingIdx].metadata), createdAt: new Date().toISOString() };
      updatedMessages = prev.messages.map((m, i) => i === existingIdx ? updated : m);
    } else {
      // PM placeholder wasn't in the array (no tokens were streamed before tool call).
      // Use a timestamp just after the last user message so PM sorts before any
      // agent messages it spawned.
      const lastUser = [...prev.messages].reverse().find(m => m.role === "user");
      if (lastUser) {
        completedMessage.createdAt = new Date(new Date(lastUser.createdAt).getTime() + 1).toISOString();
      }
      updatedMessages = [...prev.messages, completedMessage];
    }

    return {
      ...streaming,
      messages: updatedMessages,
      // Update live context tokens from PM's actual prompt usage
      ...(usage.promptTokens > 0 ? { liveContextTokens: usage.promptTokens, liveContextLimit: 0 } : {}),
    };
  });
}

function onStreamError(e: Event): void {
  const { conversationId, error } = (e as CustomEvent<{
    conversationId: string;
    error: string;
  }>).detail;

  const state = useChatStore.getState();

  // Mark the current stream as completed so late tokens are dropped.
  if (state.streamingMessageId) {
    markStreamCompleted(state.streamingMessageId);
  }

  useChatStore.setState({
    isStreaming: false,
    streamingMessageId: null,
    streamingContent: "",
    pmThinkingText: "",
  });

  // Add an error message to the list if the errored conversation is active.
  if (state.activeConversationId === conversationId) {
    const errorMessage: Message = {
      id: `error-${Date.now()}`,
      conversationId,
      role: "error",
      agentId: null,
      agentName: null,
      content: error || "Something went wrong. Please try again.",
      metadata: null,
      tokenCount: 0,
      hasParts: 0,
      createdAt: new Date().toISOString(),
    };
    useChatStore.setState((prev) => ({
      messages: [...prev.messages, errorMessage],
    }));
  }
}

function onAgentStatus(e: Event): void {
  const { agentId, status } = (e as CustomEvent<{
    projectId: string;
    agentId: string;
    status: AgentStatusValue;
  }>).detail;

  useChatStore.setState((prev) => ({
    activeAgents: { ...prev.activeAgents, [agentId]: status },
  }));
}

function onPlanPresented(e: Event): void {
  const { conversationId } = (e as CustomEvent<{
    projectId: string;
    conversationId: string;
    plan: { title: string; content: string };
  }>).detail;

  const state = useChatStore.getState();
  if (state.activeConversationId !== conversationId) return;

  // The plan message is persisted to DB and delivered via the newMessage event
  // (which fires just before planPresented). Clear all busy state so the input
  // becomes active while the user reviews the plan.
  // pmPending must also be cleared: when we auto-show the card and skip
  // onAgentDone, PM never restarts, so no stream token ever clears it.
  useChatStore.setState({
    isStreaming: false,
    streamingMessageId: null,
    streamingContent: "",
    pmPending: false,
  });
}


function onConversationTitleChanged(e: Event): void {
  const { conversationId, title } = (e as CustomEvent<{
    conversationId: string;
    title: string;
  }>).detail;

  useChatStore.setState((prev) => ({
    conversations: prev.conversations.map((c) =>
      c.id === conversationId ? { ...c, title } : c,
    ),
  }));
}

function onConversationUpdated(e: Event): void {
  const { conversationId, updatedAt, projectId } = (e as CustomEvent<{
    conversationId: string;
    updatedAt: string;
    projectId?: string;
  }>).detail;

  const store = useChatStore.getState();
  const conv = store.conversations.find((c) => c.id === conversationId);

  if (!conv) {
    // Conversation not in store yet (e.g. a new channel conversation just created).
    // Re-fetch the project's conversation list so it appears in the sidebar.
    if (projectId) {
      store.loadConversations(projectId).catch(() => {});
    }
    return;
  }

  useChatStore.setState((prev) => {
    // If the conversation has moved to a different project, remove it from
    // the current project's list so it no longer appears in the wrong sidebar.
    if (projectId && conv.projectId !== projectId) {
      return {
        conversations: sortConversations(
          prev.conversations.filter((c) => c.id !== conversationId),
        ),
      };
    }

    return {
      conversations: sortConversations(
        prev.conversations.map((c) =>
          c.id === conversationId ? { ...c, updatedAt } : c,
        ),
      ),
    };
  });
}

function onSwitchToConversation(e: Event): void {
  const { conversationId, projectId } = (e as CustomEvent<{
    conversationId: string;
    projectId: string;
  }>).detail;

  const store = useChatStore.getState();

  // Only switch if the user is currently viewing the same project
  const isOnProject = store.conversations.some((c) => c.projectId === projectId);
  if (!isOnProject) return;

  // Stamp updatedAt to now in the store so it immediately sorts to the top,
  // regardless of what the PM conversation's updatedAt is.
  const bumpToTop = () => {
    const now = new Date().toISOString();
    useChatStore.setState((prev) => ({
      conversations: sortConversations(
        prev.conversations.map((c) =>
          c.id === conversationId ? { ...c, updatedAt: now } : c,
        ),
      ),
    }));
  };

  const doSwitch = () => {
    bumpToTop();
    store.setActiveConversation(conversationId);
    store.loadMessages(conversationId).catch(() => {});
  };

  const alreadyLoaded = store.conversations.some((c) => c.id === conversationId);
  if (alreadyLoaded) {
    doSwitch();
  } else {
    store.loadConversations(projectId).then(doSwitch).catch(() => {});
  }
}

/**
 * Persist a shell approval decision into the stored event so the card
 * renders as already-responded after component remounts (e.g. tab navigation).
 */
export function persistShellApprovalDecision(requestId: string, decision: string): void {
  useChatStore.setState((prev) => ({
    shellApprovalRequests: prev.shellApprovalRequests.map((r) =>
      r.requestId === requestId ? { ...r, decision: decision as "allow" | "deny" | "always" } : r,
    ),
  }));
}

function onNewMessage(e: Event): void {
  const { conversationId, messageId, agentId, content, metadata } = (
    e as CustomEvent<{
      conversationId: string;
      messageId: string;
      agentId: string;
      agentName: string;
      content: string;
      metadata: string;
    }>
  ).detail;

  const state = useChatStore.getState();
  if (state.activeConversationId !== conversationId) return;

  useChatStore.setState((prev) => {
    const existingIdx = prev.messages.findIndex((m) => m.id === messageId);
    if (existingIdx >= 0) {
      // Move to end — so updated todo lists appear as the latest message
      const msg = { ...prev.messages[existingIdx], content, metadata, createdAt: new Date().toISOString() };
      const without = prev.messages.filter((_, i) => i !== existingIdx);
      return { messages: [...without, msg] };
    }
    // Detect agent messages (from inline agent-loop) — they have hasParts=1
    const parsedMeta = (() => { try { return JSON.parse(metadata || "{}"); } catch { return {}; } })();
    const isAgentMsg = parsedMeta.source === "agent";

    const newMsg = {
      id: messageId,
      conversationId,
      role: "assistant" as const,
      agentId,
      agentName: isAgentMsg ? agentId : null,
      content,
      metadata,
      tokenCount: 0,
      hasParts: isAgentMsg ? 1 : 0,
      createdAt: new Date().toISOString(),
    };

    // When an agent message arrives, commit PM's streaming content and clear
    // streaming state so the agent card appears as the latest item.
    if (isAgentMsg && prev.streamingMessageId && prev.streamingContent) {
      const pmIdx = prev.messages.findIndex((m) => m.id === prev.streamingMessageId);
      if (pmIdx >= 0) {
        const updatedMessages = prev.messages.map((m, i) =>
          i === pmIdx ? { ...m, content: prev.streamingContent } : m,
        );
        return {
          messages: [...updatedMessages, newMsg],
          streamingContent: "",
          isStreaming: false,
          streamingMessageId: null,
        };
      }
    }

    // Always append new messages at the end
    return { messages: [...prev.messages, newMsg] };
  });
}

function onShellApprovalRequest(e: Event): void {
  const { requestId, agentName, command, timestamp } = (
    e as CustomEvent<{
      requestId: string;
      projectId: string;
      agentId: string;
      agentName: string;
      command: string;
      timestamp: string;
    }>
  ).detail;

  // Add to shell approval requests (shown inline in chat)
  useChatStore.setState((prev) => ({
    shellApprovalRequests: [
      ...prev.shellApprovalRequests,
      { requestId, agentName, command, timestamp },
    ],
  }));
}

function onAgentInlineStart(e: Event): void {
  const { conversationId, messageId, agentName, agentDisplayName } = (
    e as CustomEvent<{
      conversationId: string;
      messageId: string;
      agentName: string;
      agentDisplayName: string;
      task: string;
    }>
  ).detail;

  const state = useChatStore.getState();
  if (state.activeConversationId !== conversationId) return;

  useChatStore.setState((prev) => ({
    activeInlineAgent: { agentName, agentDisplayName, messageId },
    runningAgentCount: prev.runningAgentCount + 1,
  }));
}

function onAgentInlineComplete(e: Event): void {
  const { conversationId, messageId, status, tokensUsed } = (
    e as CustomEvent<{
      conversationId: string;
      messageId: string;
      agentName: string;
      status: string;
      summary: string;
      tokensUsed?: { prompt: number; completion: number; contextLimit?: number };
    }>
  ).detail;

  const state = useChatStore.getState();
  if (state.activeConversationId !== conversationId) return;

  // PM only restarts for non-cancelled agents — don't set pmPending for user stops
  const willPMRestart = status !== "cancelled";

  useChatStore.setState((prev) => {
    const newCount = Math.max(0, prev.runningAgentCount - 1);
    // Clear the badge when the matching messageId ends OR when count drops to
    // zero (handles the case where activeInlineAgent was restored on page
    // re-entry with a synthetic messageId that won't match the real end event).
    const clearAgent = newCount === 0 || prev.activeInlineAgent?.messageId === messageId;
    return {
      runningAgentCount: newCount,
      ...(clearAgent ? { activeInlineAgent: null } : {}),
      pmPending: willPMRestart,
      ...(tokensUsed?.prompt ? { liveContextTokens: tokensUsed.prompt, liveContextLimit: tokensUsed.contextLimit ?? 0 } : {}),
    };
  });

  // Safety net: if PM is supposed to restart (pmPending=true) but its first
  // stream token never arrives (crash, error, or early-return path), the stop
  // button stays stuck. Clear pmPending after 8s if nothing has changed.
  if (willPMRestart) {
    setTimeout(() => {
      const s = useChatStore.getState();
      if (s.pmPending && s.runningAgentCount === 0 && !s.isStreaming) {
        useChatStore.setState({ pmPending: false });
      }
    }, 8000);
  }
}

function onCompactionStarted(e: Event): void {
  const { conversationId } = (e as CustomEvent<{ conversationId: string }>).detail;
  const state = useChatStore.getState();
  if (state.activeConversationId !== conversationId) return;
  useChatStore.setState({ isCompacting: true });
}

function onConversationCompacted(e: Event): void {
  const { conversationId, remainingTokens } = (e as CustomEvent<{ conversationId: string; remainingTokens?: number }>).detail;

  const state = useChatStore.getState();
  if (state.activeConversationId !== conversationId) return;

  // Clear compacting state
  useChatStore.setState({ isCompacting: false });

  // Reload messages from DB — the summarizer deleted old messages and created
  // a summary, so the in-memory list is stale.
  useChatStore.getState().loadMessages(conversationId);

  // Update live context tokens to reflect post-compaction state
  if (remainingTokens !== undefined && remainingTokens > 0) {
    useChatStore.setState({ liveContextTokens: remainingTokens });
  }

  toast("info", "Conversation compacted — older messages summarized.");
}

function onPmThinking(e: Event): void {
  const { conversationId, text } = (e as CustomEvent<{
    conversationId: string;
    text: string;
    isPartial: boolean;
  }>).detail;

  const state = useChatStore.getState();
  if (state.activeConversationId !== conversationId) return;

  // Always set the text (even non-partial) — onStreamComplete will read it
  // before clearing. Previously isPartial=false cleared it, causing a race
  // where onStreamComplete found pmThinkingText already empty.
  useChatStore.setState({ pmThinkingText: text });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// Guard against double-registration from HMR re-evaluating chat-store.ts
let handlersInitialized = false;

/**
 * Register all DOM event listeners for the chat store.
 * Called at module load time from chat-store.ts. Safe to call multiple times
 * (idempotent) — subsequent calls are no-ops, preventing HMR listener duplication.
 */
export function initChatEventHandlers(): void {
  if (handlersInitialized) return;
  handlersInitialized = true;
  window.addEventListener("agentdesk:stream-token", onStreamToken);
  window.addEventListener("agentdesk:stream-reset", onStreamReset);
  window.addEventListener("agentdesk:stream-complete", onStreamComplete);
  window.addEventListener("agentdesk:stream-error", onStreamError);
  window.addEventListener("agentdesk:agent-status", onAgentStatus);
  window.addEventListener("agentdesk:plan-presented", onPlanPresented);
  window.addEventListener("agentdesk:conversation-title-changed", onConversationTitleChanged);
  window.addEventListener("agentdesk:conversation-updated", onConversationUpdated);
  window.addEventListener("agentdesk:switch-to-conversation", onSwitchToConversation);
  window.addEventListener("agentdesk:compaction-started", onCompactionStarted);
  window.addEventListener("agentdesk:conversation-compacted", onConversationCompacted);
  window.addEventListener("agentdesk:shell-approval-request", onShellApprovalRequest);
  window.addEventListener("agentdesk:new-message", onNewMessage);
  window.addEventListener("agentdesk:agent-inline-start", onAgentInlineStart);
  window.addEventListener("agentdesk:agent-inline-complete", onAgentInlineComplete);
  window.addEventListener("agentdesk:pm-thinking", onPmThinking);
}
