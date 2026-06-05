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
}

export const useMessageQueueStore = create<MessageQueueState>()((set, get) => ({
  queue: [],

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
}));
