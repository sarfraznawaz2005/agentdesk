// Bridge for the Quick Chat pull-based route-recovery fallback (see App.tsx's
// one-time getQuickChatRoute check and src/bun/quick-chat/window.ts). When
// that check has to self-correct via router.navigate(), it already has the
// conversationId in hand from the same RPC response that gave it the
// projectId — no need to round-trip it through the URL hash the way the
// normal, preload-delivered path does (quick-chat.tsx's own "?c=" parser).
// A plain module-level variable is enough: it's set immediately before
// navigate() and consumed once by QuickChatPage's mount effect right after.
let pendingConversationId: string | null = null;

export function setPendingQuickChatConversationId(id: string): void {
  pendingConversationId = id;
}

/** Consumes (and clears) the pending id — only non-null right after the fallback path set it. */
export function takePendingQuickChatConversationId(): string | null {
  const id = pendingConversationId;
  pendingConversationId = null;
  return id;
}
