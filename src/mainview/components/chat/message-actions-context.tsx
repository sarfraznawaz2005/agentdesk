/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo } from "react";
import { useChatStore } from "@/stores/chat-store";

/**
 * Context that provides stable store action references to all MessageBubble
 * instances, avoiding per-bubble Zustand subscriptions. Actions are stable
 * function references that never change, so this context value is memoized
 * once and never triggers re-renders in consumers.
 */

interface MessageActions {
  deleteMessage: (id: string) => void;
  retryLastMessage: (projectId: string, conversationId: string) => Promise<void>;
  branchConversation: (projectId: string, conversationId: string, messageId: string) => Promise<string>;
  setActiveConversation: (id: string) => void;
  loadMessages: (conversationId: string) => Promise<void>;
}

const MessageActionsContext = createContext<MessageActions | null>(null);

export function MessageActionsProvider({ children }: { children: React.ReactNode }) {
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const retryLastMessage = useChatStore((s) => s.retryLastMessage);
  const branchConversation = useChatStore((s) => s.branchConversation);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const loadMessages = useChatStore((s) => s.loadMessages);

  const value = useMemo(
    () => ({ deleteMessage, retryLastMessage, branchConversation, setActiveConversation, loadMessages }),
    [deleteMessage, retryLastMessage, branchConversation, setActiveConversation, loadMessages],
  );

  return (
    <MessageActionsContext.Provider value={value}>
      {children}
    </MessageActionsContext.Provider>
  );
}

export function useMessageActions(): MessageActions {
  const ctx = useContext(MessageActionsContext);
  if (!ctx) throw new Error("useMessageActions must be used within MessageActionsProvider");
  return ctx;
}
