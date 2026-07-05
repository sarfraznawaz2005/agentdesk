type ConversationRow = {
  id: string;
  projectId: string;
  title: string;
  isPinned: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type QueuedMessageRow = {
  id: string;
  conversationId: string;
  content: string;
  queuedAt: number;
};

export type ConversationsRequests = {
  // Conversations
  getConversations: {
    params: { projectId: string };
    response: Array<ConversationRow>;
  };
  createConversation: {
    params: { projectId: string; title?: string };
    response: { id: string; title: string; reused: boolean };
  };
  deleteConversation: {
    params: { id: string };
    response: { success: boolean };
  };
  renameConversation: {
    params: { id: string; title: string };
    response: { success: boolean };
  };
  pinConversation: {
    params: { id: string; pinned: boolean };
    response: { success: boolean };
  };
  archiveConversation: {
    params: { id: string };
    response: { success: boolean };
  };
  restoreConversation: {
    params: { id: string };
    response: { success: boolean };
  };
  archiveOldConversations: {
    params: { projectId: string; daysOld?: number };
    response: { archived: number };
  };
  getArchivedConversations: {
    params: { projectId: string };
    response: Array<ConversationRow>;
  };

  clearConversationMessages: {
    params: { id: string };
    response: { success: boolean };
  };
  deleteMessage: {
    params: { id: string };
    response: { success: boolean };
  };

  // Messages
  getMessages: {
    params: { conversationId: string; limit?: number; before?: string };
    response: Array<{
      id: string;
      conversationId: string;
      role: string;
      agentId: string | null;
      agentName: string | null;
      content: string;
      metadata: string | null;
      tokenCount: number;
      hasParts: number;
      createdAt: string;
      // Monotonic insertion-order key (SQLite rowid). Used to order messages
      // on reload so PM messages and the sub-agents they spawn keep their true
      // insertion order regardless of wall-clock createdAt collisions/mutations.
      seq: number;
    }>;
  };
  sendMessage: {
    params: {
      projectId: string;
      conversationId: string;
      content: string;
      metadata?: {
        source?: "app" | "discord" | "whatsapp" | "email";
        channelId?: string;
        username?: string;
      };
    };
    response: { messageId: string; userMessageId: string };
  };
  stopGeneration: {
    params: { projectId: string };
    response: { success: boolean };
  };
  retryAgent: {
    params: {
      projectId: string;
      conversationId: string;
      agentName: string;
      task: string;
    };
    response: { success: boolean; error?: string };
  };
  setAppFocused: {
    params: { focused: boolean };
    response: { success: boolean };
  };

  // Message queue — messages typed while the PM/agents are busy on a
  // conversation. Held server-side (keyed by projectId+conversationId) so
  // they still get delivered to the right project/conversation once idle,
  // regardless of what the user is currently viewing in the frontend.
  enqueueMessage: {
    params: { projectId: string; conversationId: string; content: string };
    response: { success: boolean; queue: QueuedMessageRow[] };
  };
  removeQueuedMessage: {
    params: { projectId: string; conversationId: string; messageId: string };
    response: { success: boolean; queue: QueuedMessageRow[] };
  };
  clearQueuedMessages: {
    params: { projectId: string; conversationId: string };
    response: { success: boolean };
  };
  getQueuedMessages: {
    params: { projectId: string; conversationId: string };
    response: QueuedMessageRow[];
  };

  branchConversation: {
    params: { conversationId: string; upToMessageId: string };
    response: { id: string; title: string };
  };

  // Message parts (inline agent execution)
  getMessageParts: {
    params: { messageId: string };
    response: Array<{
      id: string;
      messageId: string;
      type: string;
      content: string;
      toolName: string | null;
      toolInput: string | null;
      toolOutput: string | null;
      toolState: string | null;
      sortOrder: number;
      timeStart: string | null;
      timeEnd: string | null;
      createdAt: string;
    }>;
  };

};
