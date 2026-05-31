import { create } from "zustand";
import { rpc } from "../lib/rpc";
import type {
  ActiveInlineAgent,
  AgentStatusValue,
  Conversation,
  Message,
  ShellApprovalRequest,
} from "./chat-types";
import { buffers, initChatEventHandlers } from "./chat-event-handlers";

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
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Message[];

  // Loading
  messagesLoading: boolean;

  // Streaming
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingContent: string;

  // Agent status
  activeAgents: Record<string, AgentStatusValue>;

  // Currently running inline agent (set by agentInlineStart, cleared by agentInlineComplete)
  activeInlineAgent: ActiveInlineAgent | null;

  // Number of currently running inline agents (PM-dispatched + workflow-dispatched)
  runningAgentCount: number;

  // PM thinking/reasoning text (streamed live, cleared on stream complete)
  pmThinkingText: string;

  // Pending shell approval requests (shown inline in chat)
  shellApprovalRequests: ShellApprovalRequest[];

  // PM is about to restart after agent completed (bridges gap for stop button)
  pmPending: boolean;

  // Conversation is being compacted — disables input and shows indicator
  isCompacting: boolean;

  // Live context window usage from backend (updated on agent/PM completion)
  liveContextTokens: number;
  liveContextLimit: number;


  // Actions
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
  deleteConversation: (id: string) => Promise<void>;
  clearMessages: (conversationId: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  retryLastMessage: (projectId: string, conversationId: string) => Promise<void>;
  branchConversation: (projectId: string, conversationId: string, upToMessageId: string) => Promise<string>;
  renameConversation: (id: string, title: string) => Promise<void>;
  pinConversation: (id: string, pinned: boolean) => Promise<void>;
  clearActivity: () => void;
  syncRunningAgents: (projectId: string) => Promise<void>;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Initial state (extracted so reset() can reuse it)
// ---------------------------------------------------------------------------

const initialState = {
  conversations: [] as Conversation[],
  activeConversationId: null as string | null,
  messages: [] as Message[],
  messagesLoading: false,
  isStreaming: false,
  streamingMessageId: null as string | null,
  streamingContent: "",
  activeAgents: {} as Record<string, AgentStatusValue>,
  activeInlineAgent: null as ActiveInlineAgent | null,
  runningAgentCount: 0,
  pmThinkingText: "",
  shellApprovalRequests: [] as ShellApprovalRequest[],
  pmPending: false,
  isCompacting: false,
  liveContextTokens: 0,
  liveContextLimit: 0,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useChatStore = create<ChatState>((set) => ({
  ...initialState,

  // ---- Conversations -------------------------------------------------------

  loadConversations: async (projectId: string) => {
    const raw = await rpc.getConversations(projectId);
    const conversations = sortConversations(raw as Conversation[]);
    // Drop result if a later navigation already loaded a different project.
    // (Each conversation row carries its projectId so we can detect staleness.)
    if (conversations.length > 0 && conversations[0].projectId !== projectId) return;
    set({ conversations });
  },

  setActiveConversation: (id: string | null) => {
    set({ activeConversationId: id, liveContextTokens: 0, liveContextLimit: 0 });
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

  deleteConversation: async (id: string) => {
    await rpc.deleteConversation(id);
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
    const state = useChatStore.getState();
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
    await useChatStore.getState().sendMessage(projectId, conversationId, userMsg.content);
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
    const raw = await rpc.getMessages(conversationId);
    // Filter out empty-content assistant rows — these are in-flight stream
    // placeholders inserted by the backend before streaming starts. If the
    // stream is still running, onStreamComplete will add the full message
    // directly. If already finished, the DB row will have content and passes.
    const messages = (raw as Message[]).filter(
      (m) => m.role !== "assistant" || m.content.trim() !== "",
    );
    set({ messages, messagesLoading: false });
  },

  sendMessage: async (
    projectId: string,
    conversationId: string,
    content: string,
  ) => {
    set({ isStreaming: true, streamingContent: "", streamingMessageId: null });
    const result = await rpc.sendMessage(projectId, conversationId, content);
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
    await rpc.stopGeneration(projectId);
    set({ isStreaming: false, streamingMessageId: null, streamingContent: "", activeAgents: {}, runningAgentCount: 0, activeInlineAgent: null, pmThinkingText: "", pmPending: false });
  },

  stopAgent: async (projectId: string, agentName: string) => {
    await rpc.stopAgent(projectId, agentName);
    // Sync running state — if this was the last agent, clear busy indicators
    try {
      const [agents, pmStatus] = await Promise.all([
        rpc.getRunningAgents(projectId),
        rpc.getPmStatus(projectId),
      ]);
      const updates: Partial<ChatState> = { runningAgentCount: agents.length };
      if (agents.length === 0 && !pmStatus.isStreaming) {
        updates.isStreaming = false;
        updates.activeInlineAgent = null;
      }
      set(updates);
    } catch { /* non-critical */ }
  },

  // ---- Activity ------------------------------------------------------------

  clearActivity: () => {
    set({ activeAgents: {}, activeInlineAgent: null, runningAgentCount: 0, shellApprovalRequests: [], pmThinkingText: "", pmPending: false, isCompacting: false, liveContextTokens: 0, liveContextLimit: 0 });
  },

  // Re-sync activeAgents from backend — called after navigation back to a project page.
  syncRunningAgents: async (projectId: string) => {
    try {
      const [agents, pmStatus] = await Promise.all([
        rpc.getRunningAgents(projectId),
        rpc.getPmStatus(projectId),
      ]);
      const activeAgents: Record<string, AgentStatusValue> = {};
      for (const a of agents) {
        activeAgents[a.id] = (a.status as AgentStatusValue) ?? "running";
      }
      const updates: Partial<ChatState> = { activeAgents, runningAgentCount: agents.length };
      // Restore the agent name badge if an agent is running.
      // Use a synthetic messageId so the agentEnded handler (which clears by
      // messageId match) falls back to the count-drops-to-zero path instead.
      if (agents.length > 0) {
        const first = agents[0];
        updates.activeInlineAgent = {
          agentName: first.name,           // internal name — used for badge colour lookup
          agentDisplayName: first.displayName, // real display name from DB e.g. "Task Planner"
          messageId: `sync-${first.name}`,
        };
      }
      if (pmStatus.isStreaming) {
        // Restore PM streaming indicator if PM is mid-response
        updates.isStreaming = true;
      } else if (agents.length === 0) {
        // Nothing is running and PM is idle — clear any stuck busy state that
        // may have been left over (e.g. pmPending never cleared, isStreaming
        // stuck from a stale stream completion race in production).
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
    set({ ...initialState });
  },
}));

// ---------------------------------------------------------------------------
// DOM event subscriptions — registered once at module load time
// ---------------------------------------------------------------------------

initChatEventHandlers();
