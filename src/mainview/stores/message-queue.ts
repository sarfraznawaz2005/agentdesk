import { create } from "zustand";

export const MESSAGE_QUEUE_MAX = 3;

export interface QueuedMessage {
  id: string;
  /** Raw visible text the user typed (no attachment context injected yet). */
  content: string;
  queuedAt: number;
}

interface MessageQueueState {
  queue: QueuedMessage[];
  /**
   * Conversation the current queue belongs to. Lives here (not in a component
   * ref/effect) so it survives ChatLayout unmounting when the user navigates
   * away and back — only a genuine conversation switch should drop the queue,
   * not a remount of the same conversation.
   */
  activeConversationId: string | null;
  /**
   * Add a message to the tail of the queue.
   * Returns false (and does not mutate) when the queue is already at capacity.
   */
  enqueue: (content: string) => boolean;
  /** Remove and return the oldest queued message, or null if empty. */
  dequeue: () => QueuedMessage | null;
  /** Remove a specific message by id. */
  remove: (id: string) => void;
  /** Remove all queued messages (e.g. on conversation switch or stop). */
  clear: () => void;
  /**
   * Call on every render of the chat page with the current conversation id.
   * Clears the queue only when a *concrete* conversation id differs from the
   * last concrete one seen. A falsy id (conversation not loaded/selected yet
   * — e.g. mid-reload right after navigating back to the project) is ignored
   * rather than treated as "switched away from everything": ChatLayout can
   * render with activeConversationId momentarily undefined while the chat
   * store reloads, and reacting to that transient state would clear the
   * queue even though it settles back on the same conversation a tick later.
   */
  syncActiveConversation: (conversationId: string | undefined | null) => void;
}

export const useMessageQueueStore = create<MessageQueueState>()((set, get) => ({
  queue: [],
  activeConversationId: null,

  enqueue: (content: string) => {
    if (get().queue.length >= MESSAGE_QUEUE_MAX) return false;
    const msg: QueuedMessage = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      content,
      queuedAt: Date.now(),
    };
    set((s) => ({ queue: [...s.queue, msg] }));
    return true;
  },

  dequeue: () => {
    const [first, ...rest] = get().queue;
    if (!first) return null;
    set({ queue: rest });
    return first;
  },

  remove: (id: string) => set((s) => ({ queue: s.queue.filter((m) => m.id !== id) })),

  clear: () => set({ queue: [] }),

  syncActiveConversation: (conversationId) => {
    // Ignore transient "nothing selected yet" states — only a genuine switch
    // between two concrete conversations should drop the queue.
    if (!conversationId) return;
    if (get().activeConversationId === conversationId) return;
    set({ activeConversationId: conversationId, queue: [] });
  },
}));
