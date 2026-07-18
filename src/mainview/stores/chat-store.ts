import { create } from "zustand";
import { rpc } from "../lib/rpc";
import type {
  ActiveInlineAgent,
  AgentStatusValue,
  Conversation,
  Message,
  ShellApprovalRequest,
} from "./chat-types";
import { buffers, initChatEventHandlers, resurfacePendingApprovals } from "./chat-event-handlers";

// Re-export types so existing consumers don't need to change their imports
export type {
  ActiveInlineAgent,
  AgentStatusValue,
  Conversation,
  Message,
  ShellApprovalRequest,
} from "./chat-types";

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface ChatState {
  // Data
  // The project currently open in ProjectPage. Broadcasts are global (one
  // window, all projects), so cross-project events must be gated on this —
  // never inferred from the loaded conversations, which those very events
  // can replace.
  activeProjectId: string | null;
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Message[];

  // Set by a cross-project "needs your attention" toast's Open button (shell
  // approval / plan approval waiting in a project the user isn't viewing) —
  // consumed by ProjectPage's conversation auto-select effect once that
  // project's conversations finish loading, so navigation + conversation
  // switch land in the right order instead of racing. Cleared once consumed
  // (or if it doesn't match the project that ends up loading).
  pendingConversationTarget: { projectId: string; conversationId: string } | null;

  // Loading
  messagesLoading: boolean;

  // Streaming
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingContent: string;

  // Agent status
  activeAgents: Record<string, AgentStatusValue>;

  // Currently running inline agents in the active conversation, keyed by
  // messageId. This is the source of truth — activeInlineAgent/
  // runningAgentCount below are both derived from it (see
  // deriveInlineAgentDisplay) so they can never drift out of sync with each
  // other, which is what let the badge go blank while a sibling parallel
  // agent was still running (one finishing agent nulled a single shared
  // scalar instead of removing just its own entry).
  runningInlineAgents: Record<string, ActiveInlineAgent>;

  // Currently displayed inline agent badge — derived from runningInlineAgents
  // (an arbitrary still-running entry, or null when none are running).
  activeInlineAgent: ActiveInlineAgent | null;

  // Number of currently running inline agents in this conversation — derived
  // from runningInlineAgents (PM-dispatched + workflow-dispatched).
  runningAgentCount: number;

  // PM thinking/reasoning text (streamed live, cleared on stream complete)
  pmThinkingText: string;

  // PM's own direct tool calls for the current turn — ephemeral, shown live
  // under the "Thinking…" indicator (only the most recent call is displayed,
  // replacing the previous one — see ToolCallFeed) and cleared on stream
  // reset/complete/error.
  pmActivityLog: Array<{ id: string; toolName: string; isSkill: boolean }>;

  // Pending shell approval requests (shown inline in chat)
  shellApprovalRequests: ShellApprovalRequest[];

  // PM is about to restart after agent completed (bridges gap for stop button)
  pmPending: boolean;

  // Conversation is being compacted — disables input and shows indicator
  isCompacting: boolean;

  // Live context window usage from backend (updated on agent/PM completion)
  liveContextTokens: number;
  liveContextLimit: number;

  // Live streaming throughput (§9.2) — most recent completed language-model call
  liveTokensPerSecond: number;
  liveTimeToFirstOutputMs: number | null;

  // Collapsed agent blocks — keyed by message part id (persists across tab switches)
  collapsedAgentBlocks: Record<string, true>;

  // Unsent chat-input drafts — keyed by conversationId, mirrored to localStorage so a
  // typed-but-unsent message survives navigation, tab switches, and app restart.
  drafts: Record<string, string>;


  // Actions
  /** Record which project ProjectPage is showing (null when none is open). */
  setActiveProject: (projectId: string | null) => void;
  /** Request that ProjectPage jump straight to a specific conversation once
   * this project's conversations finish loading (see pendingConversationTarget). */
  setPendingConversationTarget: (target: { projectId: string; conversationId: string } | null) => void;
  loadConversations: (projectId: string) => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  setActiveConversation: (id: string | null) => void;
  sendMessage: (
    projectId: string,
    conversationId: string,
    content: string,
  ) => Promise<void>;
  stopGeneration: (projectId: string) => Promise<void>;
  stopAgent: (projectId: string, agentName: string) => Promise<void>;
  createConversation: (projectId: string) => Promise<string>;
  /** Create a fresh conversation, seed it with a user message, and send it to the PM. Returns the new conversation id. */
  startConversationWithMessage: (projectId: string, content: string) => Promise<string>;
  deleteConversation: (id: string) => Promise<void>;
  clearMessages: (conversationId: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  retryLastMessage: (projectId: string, conversationId: string) => Promise<void>;
  branchConversation: (projectId: string, conversationId: string, upToMessageId: string) => Promise<string>;
  renameConversation: (id: string, title: string) => Promise<void>;
  pinConversation: (id: string, pinned: boolean) => Promise<void>;
  toggleCollapsedAgent: (id: string) => void;
  /** Save (or, when value is empty, delete) the unsent draft for a conversation. */
  setDraft: (conversationId: string, value: string) => void;
  /** Remove a conversation's unsent draft (e.g. after send or on delete). */
  clearDraft: (conversationId: string) => void;
  clearActivity: () => void;
  syncRunningAgents: (projectId: string) => Promise<void>;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Unsent-draft persistence. Drafts are mirrored to localStorage (keyed by
 * conversationId) so a typed-but-unsent message survives navigation and a full
 * app restart. All access is wrapped — localStorage can throw (quota/privacy
 * modes) and a draft is never important enough to break the chat over.
 */
const DRAFTS_KEY = "agentdesk:chat-drafts";

function loadDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    // Keep only string values — guard against a corrupted/old payload shape.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveDrafts(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* ignore — localStorage unavailable or over quota */
  }
}

/**
 * Sort conversations: pinned first, then descending by updatedAt.
 */
export function sortConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => {
    if (a.isPinned !== b.isPinned) {
      return a.isPinned ? -1 : 1;
    }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

/**
 * Fetches the currently running agents scoped to one conversation — the
 * correct source for the per-conversation running-agent badge/count.
 * Returns [] with no conversationId rather than falling back to the
 * project-wide RPC, since "no conversation selected" genuinely has nothing
 * to show for a per-conversation indicator.
 */
async function fetchRunningAgentsForConversation(
  projectId: string,
  conversationId: string | null,
): ReturnType<typeof rpc.getRunningAgentsForConversation> {
  if (!conversationId) return [];
  return rpc.getRunningAgentsForConversation(projectId, conversationId);
}

/**
 * Derives the badge-display fields from the running-inline-agents map — the
 * single place that decides "which one to show" and "how many are running",
 * so the two values can never disagree with each other.
 */
export function deriveInlineAgentDisplay(
  runningInlineAgents: Record<string, ActiveInlineAgent>,
): { activeInlineAgent: ActiveInlineAgent | null; runningAgentCount: number } {
  const entries = Object.values(runningInlineAgents);
  return {
    activeInlineAgent: entries.length > 0 ? entries[entries.length - 1] : null,
    runningAgentCount: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Initial state (extracted so reset() can reuse it)
// ---------------------------------------------------------------------------

const initialState = {
  activeProjectId: null as string | null,
  conversations: [] as Conversation[],
  activeConversationId: null as string | null,
  messages: [] as Message[],
  pendingConversationTarget: null as { projectId: string; conversationId: string } | null,
  messagesLoading: false,
  isStreaming: false,
  streamingMessageId: null as string | null,
  streamingContent: "",
  activeAgents: {} as Record<string, AgentStatusValue>,
  runningInlineAgents: {} as Record<string, ActiveInlineAgent>,
  activeInlineAgent: null as ActiveInlineAgent | null,
  runningAgentCount: 0,
  pmThinkingText: "",
  pmActivityLog: [] as Array<{ id: string; toolName: string; isSkill: boolean }>,
  shellApprovalRequests: [] as ShellApprovalRequest[],
  pmPending: false,
  isCompacting: false,
  liveContextTokens: 0,
  liveContextLimit: 0,
  liveTokensPerSecond: 0,
  liveTimeToFirstOutputMs: null,
  collapsedAgentBlocks: {} as Record<string, true>,
  drafts: loadDrafts(),
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useChatStore = create<ChatState>()((set, get) => ({
  ...initialState,

  // ---- Conversations -------------------------------------------------------

  setActiveProject: (projectId: string | null) => {
    set({ activeProjectId: projectId });
  },

  setPendingConversationTarget: (target) => {
    set({ pendingConversationTarget: target });
  },

  loadConversations: async (projectId: string) => {
    const raw = await rpc.getConversations(projectId);
    const conversations = sortConversations(raw as Conversation[]);
    // Drop the result unless the user is still viewing this project — a slow
    // fetch from a previous project, or a background-project broadcast that
    // slipped past a handler guard, must never replace the visible sidebar.
    const activeProjectId = get().activeProjectId;
    if (activeProjectId !== null && activeProjectId !== projectId) return;
    // Drop result if a later navigation already loaded a different project.
    // (Each conversation row carries its projectId so we can detect staleness.)
    if (conversations.length > 0 && conversations[0].projectId !== projectId) return;
    set({ conversations });
    // Re-surface any approvals that arrived while disconnected / before reload
    // (TASK-478 durability). Fire-and-forget so it never blocks the chat view.
    void resurfacePendingApprovals(projectId);
  },

  setActiveConversation: (id: string | null) => {
    const prevId = get().activeConversationId;
    if (id === prevId) {
      set({ liveContextTokens: 0, liveContextLimit: 0, liveTokensPerSecond: 0, liveTimeToFirstOutputMs: null });
      return;
    }
    // A genuine switch: any in-flight streaming state (buffered-but-unflushed
    // tokens, streamingContent, the "PM is mid-reply" flags) belongs to the
    // OUTGOING conversation. Left uncleared, a still-pending token-buffer
    // flush (up to TOKEN_FLUSH_INTERVAL late, chat-event-handlers.ts) or a
    // delayed onStreamComplete for that conversation attributes content to
    // whichever conversation is active BY THEN — mixing one conversation's
    // reply into another's, since streamingContent/isStreaming/
    // streamingMessageId are single global fields, not keyed per conversation.
    // reset() already does this for a project switch; this extends the same
    // guarantee to same-project conversation switches (sidebar click,
    // switch-to-conversation broadcast, auto-select on mount), which never
    // routed through reset().
    if (buffers.tokenFlushTimer) { clearTimeout(buffers.tokenFlushTimer); buffers.tokenFlushTimer = null; }
    buffers.tokenBuffer = "";
    buffers.tokenStreamMeta = null;
    set({
      activeConversationId: id,
      liveContextTokens: 0,
      liveContextLimit: 0,
      liveTokensPerSecond: 0,
      liveTimeToFirstOutputMs: null,
      isStreaming: false,
      streamingMessageId: null,
      streamingContent: "",
      pmThinkingText: "",
      pmActivityLog: [],
      // Same leak this whole block guards against, applied to the agent
      // badge/count: runningInlineAgents is gated on activeConversationId in
      // chat-event-handlers.ts, so switching away from a conversation with
      // agents still running (no message sent, so nothing aborted them)
      // freezes their entries — the next conversation would otherwise
      // inherit the outgoing one's stale badge/count. Resync below re-derives
      // truth for whichever conversation is now active.
      runningInlineAgents: {},
      activeInlineAgent: null,
      runningAgentCount: 0,
    });
    // Resync via the conversation-scoped RPC (fetchRunningAgentsForConversation)
    // so this only ever reflects the conversation just switched to — sending a
    // message to one conversation no longer aborts another conversation's
    // agents or PM turn (see AgentEngine.sendMessage's per-conversation abort
    // scoping and busy-conversation queue guard), so two conversations in the
    // same project can genuinely both have work in flight at once.
    const projectId = get().activeProjectId;
    if (id && projectId) void get().syncRunningAgents(projectId);
  },

  createConversation: async (projectId: string) => {
    const result = await rpc.createConversation(projectId);
    const now = new Date().toISOString();
    if (result.reused) {
      // Bump updatedAt on the existing conversation so it sorts to the top
      set((state) => ({
        conversations: sortConversations(
          state.conversations.map((c) =>
            c.id === result.id ? { ...c, updatedAt: now } : c
          ),
        ),
      }));
    } else {
      const newConversation: Conversation = {
        id: result.id,
        projectId,
        title: result.title,
        isPinned: false,
        isArchived: false,
        createdAt: now,
        updatedAt: now,
      };
      set((state) => ({
        conversations: sortConversations([
          newConversation,
          ...state.conversations,
        ]),
      }));
    }
    return result.id;
  },

  startConversationWithMessage: async (projectId: string, content: string) => {
    const id = await get().createConversation(projectId);
    get().setActiveConversation(id);
    // Load existing messages first (empty for a fresh conversation, or a reused empty
    // one) so the optimistic message we append below isn't clobbered by a later load.
    await get().loadMessages(id);
    const userMsg = {
      id: `temp-${Date.now()}`,
      conversationId: id,
      role: "user",
      agentId: null,
      agentName: null,
      content,
      metadata: null,
      tokenCount: 0,
      hasParts: 0,
      createdAt: new Date().toISOString(),
    };
    set((prev) => ({ messages: [...prev.messages, userMsg] }));
    await get().sendMessage(projectId, id, content);
    return id;
  },

  deleteConversation: async (id: string) => {
    await rpc.deleteConversation(id);
    get().clearDraft(id);
    set((state) => {
      const conversations = state.conversations.filter((c) => c.id !== id);
      const activeConversationId =
        state.activeConversationId === id ? null : state.activeConversationId;
      const messages =
        state.activeConversationId === id ? [] : state.messages;
      return { conversations, activeConversationId, messages };
    });
  },

  clearMessages: async (conversationId: string) => {
    await rpc.clearConversationMessages(conversationId);
    set((state) =>
      state.activeConversationId === conversationId ? { messages: [] } : {},
    );
  },

  deleteMessage: async (messageId: string) => {
    await rpc.deleteMessage(messageId);
    set((state) => ({ messages: state.messages.filter((m) => m.id !== messageId) }));
  },

  retryLastMessage: async (projectId: string, conversationId: string) => {
    const state = get();
    const msgs = state.messages;

    // Remove trailing error messages (ephemeral, not in DB) and find the
    // last assistant message so we can delete it and resend the user message.
    const idsToRemove: string[] = [];
    let targetIdx = msgs.length - 1;

    // Walk backwards, collecting error messages to remove
    while (targetIdx >= 0 && msgs[targetIdx].role === "error") {
      idsToRemove.push(msgs[targetIdx].id);
      targetIdx--;
    }

    // Now targetIdx should point to the last assistant or [Generation failed] message
    if (targetIdx < 0) return;
    const assistantMsg = msgs[targetIdx];
    if (assistantMsg.role === "assistant") {
      idsToRemove.push(assistantMsg.id);
      // Delete the persisted assistant message from DB
      await rpc.deleteMessage(assistantMsg.id);
    }

    // Find the last user message before the assistant/error messages
    const userMsg = msgs.slice(0, targetIdx + 1).reverse().find((m) => m.role === "user");
    if (!userMsg) return;

    // Remove all collected messages from the store
    set((s) => ({ messages: s.messages.filter((m) => !idsToRemove.includes(m.id)) }));

    // Resend the user message content
    await get().sendMessage(projectId, conversationId, userMsg.content);
  },

  branchConversation: async (projectId: string, conversationId: string, upToMessageId: string) => {
    const result = await rpc.branchConversation(conversationId, upToMessageId);
    const branchedConversation: Conversation = {
      id: result.id,
      projectId,
      title: result.title,
      isPinned: false,
      isArchived: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    set((state) => ({
      conversations: sortConversations([branchedConversation, ...state.conversations]),
    }));
    return result.id;
  },

  renameConversation: async (id: string, title: string) => {
    await rpc.renameConversation(id, title);
    set((state) => ({
      conversations: sortConversations(
        state.conversations.map((c) =>
          c.id === id
            ? { ...c, title, updatedAt: new Date().toISOString() }
            : c,
        ),
      ),
    }));
  },

  pinConversation: async (id: string, pinned: boolean) => {
    await rpc.pinConversation(id, pinned);
    set((state) => ({
      conversations: sortConversations(
        state.conversations.map((c) =>
          c.id === id
            ? { ...c, isPinned: pinned, updatedAt: new Date().toISOString() }
            : c,
        ),
      ),
    }));
  },

  // ---- Messages ------------------------------------------------------------

  loadMessages: async (conversationId: string) => {
    set({ messagesLoading: true });
    try {
      const raw = await rpc.getMessages(conversationId);
      // Drop the result unless the user is still viewing this conversation —
      // a slower fetch from a conversation switched away from (rapid clicking
      // across conversations/projects while multiple fetches are in flight)
      // must never overwrite whichever conversation is actually being viewed
      // now. Whichever fetch resolves last for the CURRENT activeConversationId
      // is the one that gets applied, regardless of call order — same pattern
      // as loadConversations' activeProjectId guard.
      if (get().activeConversationId !== conversationId) return;
      // Filter out empty-content assistant rows — these are in-flight stream
      // placeholders inserted by the backend before streaming starts. If the
      // stream is still running, onStreamComplete will add the full message
      // directly. If already finished, the DB row will have content and passes.
      const messages = (raw as Message[]).filter(
        (m) => m.role !== "assistant" || m.content.trim() !== "",
      );
      set({ messages });
    } finally {
      // Only this conversation's own (possibly stale) call may clear the flag
      // for itself — if the user has since switched again, a NEWER fetch for
      // the now-current conversation may still be in flight, and this stale
      // call's finally must not prematurely hide its loading overlay.
      if (get().activeConversationId === conversationId) set({ messagesLoading: false });
    }
  },

  sendMessage: async (
    projectId: string,
    conversationId: string,
    content: string,
  ) => {
    set({ isStreaming: true, streamingContent: "", streamingMessageId: null });
    const result = await rpc.sendMessage(projectId, conversationId, content);
    if (result.queued) {
      // A different conversation in this project is genuinely still mid-turn
      // — the backend queued this message server-side instead of aborting
      // that other turn (see AgentEngine.sendMessage's busy-conversation
      // guard). It'll be sent automatically once that turn finishes; the
      // queue UI updates itself via the existing messageQueueUpdated
      // broadcast. Nothing is actually streaming for THIS conversation yet,
      // so undo the optimistic flag set above — and there's no real
      // userMessageId yet (nothing was persisted), so don't touch the temp-
      // message.
      set({ isStreaming: false });
      return;
    }
    // Replace the temp user message ID with the real DB ID so that
    // delete/branch operations target the correct persisted row.
    // Only replace the *last* temp message to avoid collisions.
    set((prev) => {
      let replaced = false;
      const msgs = [...prev.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].id.startsWith("temp-") && msgs[i].role === "user" && msgs[i].conversationId === conversationId) {
          msgs[i] = { ...msgs[i], id: result.userMessageId };
          replaced = true;
          break;
        }
      }
      return { streamingMessageId: result.messageId, messages: replaced ? msgs : prev.messages };
    });
  },

  stopGeneration: async (projectId: string) => {
    // Scoped to the conversation actually being viewed — omitting this would
    // abort every sub-agent in the whole project (scheduler runs, other
    // conversations, review-cycle/issue-fixer agents included).
    const conversationId = get().activeConversationId ?? undefined;
    await rpc.stopGeneration(projectId, conversationId);
    set({ isStreaming: false, streamingMessageId: null, streamingContent: "", activeAgents: {}, runningInlineAgents: {}, runningAgentCount: 0, activeInlineAgent: null, pmThinkingText: "", pmActivityLog: [], pmPending: false });
  },

  stopAgent: async (projectId: string, agentName: string) => {
    const conversationId = get().activeConversationId;
    await rpc.stopAgent(projectId, agentName, conversationId ?? undefined);
    // Sync running state — if this was the last agent, clear busy indicators
    try {
      const [agents, pmStatus] = await Promise.all([
        fetchRunningAgentsForConversation(projectId, conversationId),
        rpc.getPmStatus(projectId, conversationId ?? undefined),
      ]);
      // Rebuild the running-agents map fresh from backend truth rather than
      // trying to remove just the stopped one — simpler and self-correcting.
      const runningInlineAgents: Record<string, ActiveInlineAgent> = {};
      for (const a of agents) {
        const messageId = `sync-${a.id}`;
        runningInlineAgents[messageId] = { agentName: a.name, agentDisplayName: a.displayName, messageId };
      }
      const updates: Partial<ChatState> = { runningInlineAgents, ...deriveInlineAgentDisplay(runningInlineAgents) };
      if (agents.length === 0 && !pmStatus.isStreaming) {
        updates.isStreaming = false;
      }
      set(updates);
    } catch { /* non-critical */ }
  },

  // ---- Activity ------------------------------------------------------------

  toggleCollapsedAgent: (id: string) => {
    set((state) => {
      if (id in state.collapsedAgentBlocks) {
        const { [id]: _omit, ...rest } = state.collapsedAgentBlocks;
        return { collapsedAgentBlocks: rest };
      }
      return { collapsedAgentBlocks: { ...state.collapsedAgentBlocks, [id]: true } };
    });
  },

  setDraft: (conversationId: string, value: string) => {
    set((state) => {
      // Empty draft → drop the key so the map (and localStorage) stays bounded.
      if (!value) {
        if (!(conversationId in state.drafts)) return {};
        const { [conversationId]: _omit, ...rest } = state.drafts;
        saveDrafts(rest);
        return { drafts: rest };
      }
      if (state.drafts[conversationId] === value) return {};
      const next = { ...state.drafts, [conversationId]: value };
      saveDrafts(next);
      return { drafts: next };
    });
  },

  clearDraft: (conversationId: string) => {
    get().setDraft(conversationId, "");
  },

  clearActivity: () => {
    set({ activeAgents: {}, runningInlineAgents: {}, activeInlineAgent: null, runningAgentCount: 0, shellApprovalRequests: [], pmThinkingText: "", pmActivityLog: [], pmPending: false, isCompacting: false, liveContextTokens: 0, liveContextLimit: 0, liveTokensPerSecond: 0, liveTimeToFirstOutputMs: null });
  },

  // Re-sync activeAgents from backend — called after navigation back to a project page,
  // and after every conversation switch (see setActiveConversation).
  // Scoped to the active conversation (not the whole project) so this never
  // shows a sibling conversation's or a background scheduler run's agents.
  syncRunningAgents: async (projectId: string) => {
    const conversationId = get().activeConversationId;
    try {
      const [agents, pmStatus] = await Promise.all([
        fetchRunningAgentsForConversation(projectId, conversationId),
        rpc.getPmStatus(projectId, conversationId ?? undefined),
      ]);
      // Bail if the user already switched to a different conversation while
      // this request was in flight — applying a stale response here would
      // reintroduce the exact leak this scoping is meant to prevent.
      if (get().activeConversationId !== conversationId) return;

      const activeAgents: Record<string, AgentStatusValue> = {};
      for (const a of agents) {
        activeAgents[a.id] = (a.status as AgentStatusValue) ?? "running";
      }
      // Restore an entry for every currently running agent (not just the
      // first) — a mid-parallel-dispatch refresh must show all of them, not
      // silently drop to one. Synthetic per-agent messageId (keyed by the
      // backend's own agent id, not name, so two same-named agents running
      // in parallel don't collide) so agentInlineComplete's real messageId
      // won't match it directly, but its own remove-by-key + recount logic
      // still self-corrects as real completion events arrive.
      const runningInlineAgents: Record<string, ActiveInlineAgent> = {};
      for (const a of agents) {
        const messageId = `sync-${a.id}`;
        runningInlineAgents[messageId] = { agentName: a.name, agentDisplayName: a.displayName, messageId };
      }
      const updates: Partial<ChatState> = { activeAgents, runningInlineAgents, ...deriveInlineAgentDisplay(runningInlineAgents) };
      // getPmStatus is now scoped to conversationId (each conversation runs its
      // own independent PM turn) so isStreaming already answers exactly for
      // THIS conversation — no more comparing against pmStatus.conversationId.
      if (pmStatus.isStreaming) {
        updates.isStreaming = true;
      } else if (agents.length === 0) {
        // Nothing is running here and PM isn't mid-response for THIS
        // conversation — clear any stuck busy state that may have been left
        // over (e.g. pmPending never cleared, isStreaming stuck from a
        // stale stream completion race in production).
        updates.isStreaming = false;
        updates.pmPending = false;
      }
      set(updates);
    } catch {
      // Non-critical — UI will catch up as new agent-status events arrive
    }
  },

  // ---- Reset ---------------------------------------------------------------

  reset: () => {
    // Cancel pending flush timers and clear buffers to prevent stale
    // tokens/events from leaking into the next conversation.
    if (buffers.tokenFlushTimer) { clearTimeout(buffers.tokenFlushTimer); buffers.tokenFlushTimer = null; }
    buffers.tokenBuffer = "";
    buffers.tokenStreamMeta = null;
    // Preserve drafts across project switches — they're keyed by conversationId
    // and globally unique, and initialState carries the app-launch snapshot only.
    // activeProjectId is preserved too: reset() clears conversation *data*, not
    // which project is open — ProjectPage owns that via setActiveProject (it
    // nulls it on unmount and sets the new id before reloading), and callers
    // like the project-settings reset stay on the same project.
    set({
      ...initialState,
      collapsedAgentBlocks: {},
      drafts: get().drafts,
      activeProjectId: get().activeProjectId,
      // Also preserved — this reset() is exactly what runs when ProjectPage
      // mounts for the project a cross-project toast just navigated to; wiping
      // it here would clear the target before the auto-select effect ever
      // gets a chance to consume it.
      pendingConversationTarget: get().pendingConversationTarget,
    });
  },
}));

// ---------------------------------------------------------------------------
// DOM event subscriptions — registered once at module load time
// ---------------------------------------------------------------------------

initChatEventHandlers();

