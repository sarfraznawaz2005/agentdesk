// RPC contract for the General Chat feature (standalone "Assistant" agent).
//
// Every method is prefixed with "generalChat"/"GeneralChat" — the semantic
// operations mirror ConversationsRequests (createConversation, getMessages,
// sendMessage, stopGeneration, ...) but MUST use distinct names: Electrobun's
// RPC schema is one flat namespace (BunRequests intersects every rpc-group's
// Requests type), so reusing those exact names would collide with the
// existing project-chat methods. Mirrors how playground.ts prefixes its own
// methods ("playgroundSend", "getPlaygroundState", ...) for the same reason.

export type GeneralChatConversationDto = {
  id: string;
  title: string;
  isPinned: boolean;
  isArchived: boolean;
  deepResearchMode: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GeneralChatMessageDto = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  tokenCount: number;
  /** JSON-encoded, e.g. {"modelId": "claude-sonnet-5"} — set on assistant replies only. */
  metadata: string | null;
  createdAt: string;
};

export type GeneralChatRequests = {
  /** Non-archived conversations, most recently updated first. */
  listGeneralChatConversations: {
    params: Record<string, never>;
    response: GeneralChatConversationDto[];
  };
  /** Archived conversations, most recently updated first. */
  listArchivedGeneralChatConversations: {
    params: Record<string, never>;
    response: GeneralChatConversationDto[];
  };
  createGeneralChatConversation: {
    params: { title?: string };
    response: { id: string; title: string };
  };
  renameGeneralChatConversation: {
    params: { id: string; title: string };
    response: { success: boolean };
  };
  deleteGeneralChatConversation: {
    params: { id: string };
    response: { success: boolean };
  };
  pinGeneralChatConversation: {
    params: { id: string; pinned: boolean };
    response: { success: boolean };
  };
  archiveGeneralChatConversation: {
    params: { id: string; archived: boolean };
    response: { success: boolean };
  };
  /** Copy a conversation's messages (up to and including upToMessageId, or all if omitted) into a new conversation. */
  forkGeneralChatConversation: {
    params: { id: string; upToMessageId?: string };
    response: { id: string; title: string };
  };
  getGeneralChatMessages: {
    params: { conversationId: string };
    response: GeneralChatMessageDto[];
  };
  /** Whether a turn is still in flight for this conversation — lets the page
   * re-derive "still working" state (Stop button, busy indicator) after a
   * mount/refresh that missed the live stream. */
  getGeneralChatStatus: {
    params: { conversationId: string };
    response: { isRunning: boolean };
  };
  /** Delete a single message (mirrors project chat's deleteMessage). */
  deleteGeneralChatMessage: {
    params: { id: string };
    response: { success: boolean };
  };
  /** Delete all messages in a conversation without deleting the conversation itself (the /clear slash command). */
  clearGeneralChatConversation: {
    params: { id: string };
    response: { success: boolean };
  };
  /** Fire-and-forget — the reply streams via generalChatPart / generalChatComplete broadcasts. */
  sendGeneralChatMessage: {
    params: { conversationId: string; content: string };
    response: { ok: boolean; error?: string };
  };
  stopGeneralChatGeneration: {
    params: { conversationId: string };
    response: { success: boolean };
  };
  setGeneralChatDeepResearchMode: {
    params: { conversationId: string; enabled: boolean };
    response: { success: boolean };
  };
  /** AI-summarize everything but the most recent messages, replacing them with one condensed message (the /compact slash command). */
  compactGeneralChatConversation: {
    params: { conversationId: string };
    response: { success: boolean; message?: string };
  };
  /** The real context window for the conversation's currently resolved model — same number the backend's own auto-compaction threshold checks against. Call on mount and whenever the model selection changes. */
  getGeneralChatContextLimit: {
    params: { conversationId: string };
    response: { contextLimit: number; modelId: string };
  };
};
