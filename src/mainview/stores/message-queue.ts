import { create } from "zustand";
import { rpc } from "../lib/rpc";

export const MESSAGE_QUEUE_MAX = 3;

export interface QueuedMessage {
  id: string;
  conversationId: string;
  /** Raw visible text the user typed (no attachment context injected yet). */
  content: string;
  queuedAt: number;
}

/**
 * Messages typed while the PM/agents are busy on a conversation. The queue
 * itself lives server-side (see src/bun/message-queue-manager.ts) — this
 * store is a thin, staleness-guarded mirror of whatever project+conversation
 * is currently displayed. Delivery is driven entirely from the backend's own
 * idle-check (engine-manager.ts), NOT from any effect in this frontend store,
 * so a queued message reaches the right project+conversation once idle even
 * if the user has since switched to a different project/conversation —
 * previously (frontend-only queue, no project/conversation tag) switching
 * away silently discarded whatever was queued.
 */
interface MessageQueueState {
  queue: QueuedMessage[];
  /** Project+conversation the current `queue` snapshot belongs to — used to
   * ignore an RPC response or broadcast that arrives after the user has
   * already switched to a different project/conversation. */
  activeProjectId: string | null;
  activeConversationId: string | null;
  /** Queue a message server-side. Returns false (queue unchanged) if already at capacity. */
  enqueue: (projectId: string, conversationId: string, content: string) => Promise<boolean>;
  /** Remove one queued message before it's sent. */
  remove: (projectId: string, conversationId: string, messageId: string) => Promise<void>;
  /** Discard every queued message for a conversation (e.g. Stop button). */
  clear: (projectId: string, conversationId: string) => Promise<void>;
  /** Fetch and display the queue for whichever project+conversation is now active.
   * Call on mount and on every conversation switch — a falsy conversationId
   * (not loaded/selected yet) just shows an empty queue rather than erroring. */
  loadQueue: (projectId: string, conversationId: string | null | undefined) => Promise<void>;
  /** Apply a messageQueueUpdated broadcast — a no-op if it's for a
   * project+conversation other than the one currently displayed. */
  applyBroadcast: (projectId: string, conversationId: string, queue: QueuedMessage[]) => void;
}

export const useMessageQueueStore = create<MessageQueueState>()((set, get) => ({
  queue: [],
  activeProjectId: null,
  activeConversationId: null,

  enqueue: async (projectId, conversationId, content) => {
    const result = await rpc.enqueueMessage(projectId, conversationId, content);
    if (get().activeProjectId === projectId && get().activeConversationId === conversationId) {
      set({ queue: result.queue });
    }
    return result.success;
  },

  remove: async (projectId, conversationId, messageId) => {
    const result = await rpc.removeQueuedMessage(projectId, conversationId, messageId);
    if (get().activeProjectId === projectId && get().activeConversationId === conversationId) {
      set({ queue: result.queue });
    }
  },

  clear: async (projectId, conversationId) => {
    // Optimistic local clear for immediate UI feedback (e.g. Stop button) —
    // guarded the same way, so it can't blank a DIFFERENT conversation's
    // queue if this resolves after the user has already switched away.
    if (get().activeProjectId === projectId && get().activeConversationId === conversationId) {
      set({ queue: [] });
    }
    await rpc.clearQueuedMessages(projectId, conversationId);
  },

  loadQueue: async (projectId, conversationId) => {
    if (!conversationId) {
      set({ activeProjectId: projectId, activeConversationId: null, queue: [] });
      return;
    }
    set({ activeProjectId: projectId, activeConversationId: conversationId });
    try {
      const queue = await rpc.getQueuedMessages(projectId, conversationId);
      // The user may have switched again before this resolved.
      if (get().activeProjectId !== projectId || get().activeConversationId !== conversationId) return;
      set({ queue });
    } catch {
      if (get().activeProjectId === projectId && get().activeConversationId === conversationId) set({ queue: [] });
    }
  },

  applyBroadcast: (projectId, conversationId, queue) => {
    if (get().activeProjectId === projectId && get().activeConversationId === conversationId) {
      set({ queue });
    }
  },
}));
