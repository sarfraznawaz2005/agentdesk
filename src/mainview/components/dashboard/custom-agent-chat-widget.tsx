import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { MessageSquare, X, Send, Trash2, Loader2, Wrench, Sparkles, RefreshCw, Check, Copy, Download, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { useConvFontSize } from "@/lib/use-conv-font-size";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { UnreadDot } from "@/components/ui/unread-dot";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Markdown components for assistant bubbles (kept in sync with PmChatWidget)
// ---------------------------------------------------------------------------

const MD_COMPONENTS = {
  code({ className, children, ref: _ref, ...props }: Record<string, unknown>) {
    const isBlock = /language-/.test((className as string) ?? "");
    if (isBlock) {
      return (
        <pre className="my-3 max-w-full overflow-x-auto rounded-md bg-muted/80 px-3 py-2 text-xs font-mono">
          <code {...props}>{children as React.ReactNode}</code>
        </pre>
      );
    }
    return (
      <code className="break-all rounded bg-muted/80 px-1 py-0.5 text-xs font-mono" {...props}>
        {children as React.ReactNode}
      </code>
    );
  },
  p:  ({ children }: { children: React.ReactNode }) => <p  className="mb-3 break-words last:mb-0">{children}</p>,
  ul: ({ children }: { children: React.ReactNode }) => <ul className="mb-3 list-disc pl-5 space-y-1 last:mb-0">{children}</ul>,
  ol: ({ children }: { children: React.ReactNode }) => <ol className="mb-3 list-decimal pl-5 space-y-1 last:mb-0">{children}</ol>,
  li: ({ children }: { children: React.ReactNode }) => <li className="break-words leading-relaxed">{children}</li>,
  h1: ({ children }: { children: React.ReactNode }) => <h1 className="mt-4 mb-2 text-base font-bold first:mt-0">{children}</h1>,
  h2: ({ children }: { children: React.ReactNode }) => <h2 className="mt-4 mb-2 text-sm font-bold first:mt-0">{children}</h2>,
  h3: ({ children }: { children: React.ReactNode }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>,
  a:  ({ href, children }: { href?: string; children: React.ReactNode }) => (
    <a
      href={href}
      className="break-all text-blue-800 hover:text-blue-600 font-semibold underline cursor-pointer"
      onClick={(e) => {
        e.preventDefault();
        if (href) rpc.openExternalUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  ),
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="my-3 border-l-2 border-muted-foreground/30 pl-3 italic text-muted-foreground last:mb-0">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }: { children: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto">
      <table className="min-w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }: { children: React.ReactNode }) => (
    <th className="border border-border bg-muted/50 px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }: { children: React.ReactNode }) => (
    <td className="border border-border px-2 py-1">{children}</td>
  ),
};

// ---------------------------------------------------------------------------
// Persistence — one session id + message log per (agent name)
// ---------------------------------------------------------------------------

function sessionStorageKey(agentName: string)  { return `dashboard-agent-session-${agentName}-v1`; }
function messagesStorageKey(agentName: string) { return `dashboard-agent-messages-${agentName}-v1`; }
function unreadStorageKey(agentName: string)   { return `dashboard-agent-unread-${agentName}-v1`; }

function loadPersistedUnread(agentName: string): boolean {
  try { return localStorage.getItem(unreadStorageKey(agentName)) === "1"; } catch { return false; }
}

function persistUnread(agentName: string, v: boolean) {
  try {
    if (v) localStorage.setItem(unreadStorageKey(agentName), "1");
    else localStorage.removeItem(unreadStorageKey(agentName));
  } catch { /* ignore */ }
}

function loadPersistedSession(agentName: string): { sessionId: string; messages: ChatMessage[] } {
  const sKey = sessionStorageKey(agentName);
  const mKey = messagesStorageKey(agentName);
  try {
    let sid = localStorage.getItem(sKey);
    if (!sid) {
      sid = `dashboard-agent-${agentName}-${crypto.randomUUID()}`;
      localStorage.setItem(sKey, sid);
    }
    const raw = localStorage.getItem(mKey);
    const messages: ChatMessage[] = raw
      ? (JSON.parse(raw) as ChatMessage[]).map((m) => ({ ...m, streaming: false }))
      : [];
    return { sessionId: sid, messages };
  } catch {
    const sid = `dashboard-agent-${agentName}-${crypto.randomUUID()}`;
    try { localStorage.setItem(sKey, sid); } catch { /* ignore */ }
    return { sessionId: sid, messages: [] };
  }
}

function persistMessages(agentName: string, messages: ChatMessage[]) {
  try { localStorage.setItem(messagesStorageKey(agentName), JSON.stringify(messages)); }
  catch { /* quota exceeded — ignore */ }
}

function persistSessionId(agentName: string, sessionId: string) {
  try { localStorage.setItem(sessionStorageKey(agentName), sessionId); }
  catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CustomAgentChatWidgetProps {
  agentName:   string;
  displayName: string;
  color:       string;
  visible?:    boolean;
}

export function CustomAgentChatWidget({ agentName, displayName, color, visible = true }: CustomAgentChatWidgetProps) {
  const { percent: fontSizePercent, zoomIn, zoomOut, atMin: zoomAtMin, atMax: zoomAtMax } = useConvFontSize(`conv-font-size-agent-${agentName}`);
  const [showZoomHint, setShowZoomHint] = useState(false);
  const zoomHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerZoomHint = useCallback(() => {
    setShowZoomHint(true);
    if (zoomHintTimer.current) clearTimeout(zoomHintTimer.current);
    zoomHintTimer.current = setTimeout(() => setShowZoomHint(false), 1500);
  }, []);

  const [open, setOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [input, setInput] = useState("");
  const [lastSent, setLastSent] = useState("");
  const [toolCalls, setToolCalls] = useState<Array<{ id: string; toolName: string; isSkill: boolean }>>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Unread = a reply arrived while the panel was closed. Cleared on open.
  const [unread, setUnread] = useState(false);
  const openRef = useRef(open);

  const sessionId    = useRef("");
  const initialised  = useRef(false);
  const messagesRef  = useRef<ChatMessage[]>(messages);

  const [expandedOpen, setExpandedOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modalMessagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);
  const modalInputRef  = useRef<HTMLTextAreaElement>(null);
  const expandedOpenRef = useRef(false);
  const widgetRef      = useRef<HTMLDivElement>(null);

  // Mirror the latest messages into a ref so async callbacks / event handlers
  // read current state without capturing a stale closure. Synced in an effect
  // (not during render) per React's rules-of-refs.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Initialise from localStorage once on mount. The launcher gives every widget
  // a stable agent-id key, so when the agent set changes a fresh component
  // mounts instead of re-running this effect — safe to use [] deps here.
  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    const { sessionId: sid, messages: msgs } = loadPersistedSession(agentName);
    sessionId.current = sid;
    // One-time hydration from localStorage on mount — intentional setState in effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages(msgs);
    setUnread(loadPersistedUnread(agentName));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a ref of `open` so the stream listeners read the current value.
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => { expandedOpenRef.current = expandedOpen; }, [expandedOpen]);

  // Opening the panel or popup marks everything read.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUnread(false);
      persistUnread(agentName, false);
    }
  }, [open, agentName]);
  useEffect(() => {
    if (expandedOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUnread(false);
      persistUnread(agentName, false);
    }
  }, [expandedOpen, agentName]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (widgetRef.current && !widgetRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Auto-scroll (widget + modal)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    modalMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open, expandedOpen]);

  // Focus input on open
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Re-focus input whenever streaming ends (textarea is disabled while streaming)
  useEffect(() => {
    if (!isStreaming) requestAnimationFrame(() => (expandedOpenRef.current ? modalInputRef : inputRef).current?.focus());
  }, [isStreaming]);

  // Listen for streaming events — filter by sessionId AND agentName
  useEffect(() => {
    const onChunk = (e: Event) => {
      const { sessionId: sid, agentName: an, messageId, token } =
        (e as CustomEvent<{ sessionId: string; agentName: string; messageId: string; token: string }>).detail;
      if (sid !== sessionId.current || an !== agentName) return;
      setIsStreaming(true);
      setMessages((prev) => {
        const existing = prev.find((m) => m.id === messageId);
        if (existing) return prev.map((m) => m.id === messageId ? { ...m, content: m.content + token } : m);
        return [...prev, { id: messageId, role: "assistant", content: token, streaming: true }];
      });
    };

    const onToolCall = (e: Event) => {
      const { sessionId: sid, agentName: an, toolName } =
        (e as CustomEvent<{ sessionId: string; agentName: string; toolName: string }>).detail;
      if (sid !== sessionId.current || an !== agentName) return;
      setIsStreaming(true);
      const isSkill = toolName === "read_skill" || toolName === "find_skills" || toolName === "read_skill_file";
      setToolCalls((prev) => [...prev, { id: crypto.randomUUID(), toolName, isSkill }]);
    };

    const onComplete = (e: Event) => {
      const { sessionId: sid, agentName: an, messageId } =
        (e as CustomEvent<{ sessionId: string; agentName: string; messageId: string }>).detail;
      if (sid !== sessionId.current || an !== agentName) return;
      setMessages((prev) => {
        const next = prev.map((m) => m.id === messageId ? { ...m, streaming: false } : m);
        persistMessages(agentName, next);
        return next;
      });
      setToolCalls([]);
      setIsStreaming(false);
      // A reply finished while the panel was closed → flag it as unread.
      if (!openRef.current && !expandedOpenRef.current) { setUnread(true); persistUnread(agentName, true); }
    };

    const onError = (e: Event) => {
      const { sessionId: sid, agentName: an, error } =
        (e as CustomEvent<{ sessionId: string; agentName: string; error: string }>).detail;
      if (sid !== sessionId.current || an !== agentName) return;
      setMessages((prev) => {
        const next = [
          ...prev.filter((m) => !m.streaming),
          { id: crypto.randomUUID(), role: "assistant" as const, content: `Error: ${error}`, isError: true },
        ];
        persistMessages(agentName, next);
        return next;
      });
      setIsStreaming(false);
      if (!openRef.current && !expandedOpenRef.current) { setUnread(true); persistUnread(agentName, true); }
    };

    window.addEventListener("agentdesk:dashboard-agent-chunk",     onChunk);
    window.addEventListener("agentdesk:dashboard-agent-tool-call", onToolCall);
    window.addEventListener("agentdesk:dashboard-agent-complete",  onComplete);
    window.addEventListener("agentdesk:dashboard-agent-error",     onError);
    return () => {
      window.removeEventListener("agentdesk:dashboard-agent-chunk",     onChunk);
      window.removeEventListener("agentdesk:dashboard-agent-tool-call", onToolCall);
      window.removeEventListener("agentdesk:dashboard-agent-complete",  onComplete);
      window.removeEventListener("agentdesk:dashboard-agent-error",     onError);
    };
  }, [agentName]);

  const retryLastMessage = useCallback(async () => {
    if (isStreaming) return;
    const lastUserMsg = [...messagesRef.current].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return;

    // Strip the trailing error message then re-send the last user message
    setMessages((prev) => {
      const next = prev.filter((m) => !m.isError);
      persistMessages(agentName, next);
      return next;
    });
    setIsStreaming(true);
    setToolCalls([]);

    try {
      await rpc.sendDashboardAgentMessage(sessionId.current, agentName, lastUserMsg.content);
    } catch {
      setMessages((prev) => {
        const next = [...prev, { id: crypto.randomUUID(), role: "assistant" as const, content: "Failed to send message. Please try again.", isError: true }];
        persistMessages(agentName, next);
        return next;
      });
      setIsStreaming(false);
    }
  }, [isStreaming, agentName]);

  const sendMessage = useCallback(async () => {
    const content = input.trim();
    if (!content || isStreaming) return;

    setInput("");
    requestAnimationFrame(() => (expandedOpenRef.current ? modalInputRef : inputRef).current?.focus());
    setLastSent(content);
    setIsStreaming(true);
    setToolCalls([]);

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content };
    setMessages((prev) => {
      const next = [...prev, userMsg];
      persistMessages(agentName, next);
      return next;
    });

    try {
      await rpc.sendDashboardAgentMessage(sessionId.current, agentName, content);
    } catch {
      setMessages((prev) => {
        const next = [...prev, { id: crypto.randomUUID(), role: "assistant" as const, content: "Failed to send message. Please try again." }];
        persistMessages(agentName, next);
        return next;
      });
      setIsStreaming(false);
    }
  }, [input, isStreaming, agentName]);

  const handleCopy = useCallback((id: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1500);
    });
  }, []);

  const handleRegenerate = useCallback(async () => {
    if (isStreaming) return;
    const lastUserMsg = [...messagesRef.current].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return;

    setMessages((prev) => {
      const lastAssistIdx = [...prev].reverse().findIndex((m) => m.role === "assistant" && !m.isError);
      const actualIdx = lastAssistIdx === -1 ? -1 : prev.length - 1 - lastAssistIdx;
      const next = actualIdx === -1 ? prev : prev.filter((_, i) => i !== actualIdx);
      persistMessages(agentName, next);
      return next;
    });
    setIsStreaming(true);
    setToolCalls([]);

    try {
      await rpc.sendDashboardAgentMessage(sessionId.current, agentName, lastUserMsg.content);
    } catch {
      setMessages((prev) => {
        const next = [...prev, { id: crypto.randomUUID(), role: "assistant" as const, content: "Failed to regenerate response. Please try again.", isError: true }];
        persistMessages(agentName, next);
        return next;
      });
      setIsStreaming(false);
    }
  }, [isStreaming, agentName]);

  const handleExportMarkdown = useCallback(() => {
    const exportable = messages.filter((m) => !m.isError && m.content.trim());
    if (exportable.length === 0) return;
    const title = `${displayName} Chat`;
    const lines = [`# ${title}\n`];
    for (const msg of exportable) {
      lines.push(`## ${msg.role === "user" ? "User" : displayName}\n`);
      lines.push(msg.content);
      lines.push("");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${displayName.replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "chat"}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast("success", "Chat exported as Markdown.");
  }, [messages, displayName]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
      return;
    }
    if (e.key === "ArrowUp" && input === "" && lastSent) {
      e.preventDefault();
      setInput(lastSent);
    }
  };

  const handleClear = async () => {
    if (isStreaming) {
      await rpc.abortDashboardAgentMessage(sessionId.current);
      setIsStreaming(false);
    }
    rpc.clearDashboardAgentSession(sessionId.current).catch(() => {});
    // Rotate session so backend starts fresh
    const newSid = `dashboard-agent-${agentName}-${crypto.randomUUID()}`;
    sessionId.current = newSid;
    persistSessionId(agentName, newSid);
    try { localStorage.removeItem(messagesStorageKey(agentName)); } catch { /* ignore */ }
    setMessages([]);
    setUnread(false);
    persistUnread(agentName, false);
  };

  if (!visible) return null;

  return (
    <>
      {/* Trigger button — positioned by the parent flex container in app-shell */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{ backgroundColor: color }}
          className={cn(
            "relative flex items-center gap-2 px-4 py-2.5 rounded-full",
            "text-white shadow-lg whitespace-nowrap",
            "hover:brightness-110 transition-[filter,transform] duration-150",
            "text-sm font-medium",
          )}
        >
          <MessageSquare className="h-4 w-4" strokeWidth={3.5} aria-hidden="true" />
          {displayName}
          {unread && <UnreadDot className="absolute -top-1 -right-1" />}
        </button>
      )}

      {/* Chat panel — z-[60] so it sits above the row of floating trigger
          buttons (z-50) when opened. Sits ~5px lower than the buttons. */}
      {open && !expandedOpen && (
        <div
          ref={widgetRef}
          className={cn(
            "fixed bottom-[19px] right-6 z-[60]",
            "flex flex-col w-[480px] h-[530px]",
            "bg-background border border-border rounded-xl shadow-2xl",
          )}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0 rounded-t-xl"
            style={{ backgroundColor: color }}
          >
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-white" strokeWidth={3.5} aria-hidden="true" />
              <span className="text-sm font-semibold text-white">{displayName}</span>
              {isStreaming && (
                <Loader2 className="h-3.5 w-3.5 text-white/70 animate-spin" strokeWidth={3.5} aria-hidden="true" />
              )}
            </div>
            <div className="flex items-center gap-1">
              {/* Zoom controls */}
              <div className="relative flex items-center">
                <div className={cn(
                  "absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-0.5 rounded-full text-[11px] font-mono font-medium bg-foreground text-background shadow-md pointer-events-none transition-opacity duration-300 whitespace-nowrap z-50",
                  showZoomHint ? "opacity-100" : "opacity-0",
                )}>
                  {fontSizePercent}%
                </div>
                <Tip content="Decrease font size" side="bottom">
                  <button type="button" onClick={() => { zoomOut(); triggerZoomHint(); }} disabled={zoomAtMin}
                    className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                    <ZoomOut className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
                  </button>
                </Tip>
                <Tip content="Increase font size" side="bottom">
                  <button type="button" onClick={() => { zoomIn(); triggerZoomHint(); }} disabled={zoomAtMax}
                    className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                    <ZoomIn className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
                  </button>
                </Tip>
              </div>
              <Tip content="Expand conversation" side="bottom">
                <button type="button" onClick={() => setExpandedOpen(true)}
                  className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/20 transition-colors">
                  <Maximize2 className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
                </button>
              </Tip>
              <Tip content="Export as markdown" side="bottom">
                <button
                  type="button"
                  onClick={handleExportMarkdown}
                  disabled={messages.length === 0}
                  className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Download className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
                </button>
              </Tip>
              <Tip content="Clear conversation" side="bottom">
                <button
                  type="button"
                  onClick={handleClear}
                  className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/20 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
                </button>
              </Tip>
              <Tip content="Close" side="bottom">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/20 transition-colors"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
                </button>
              </Tip>
            </div>
          </div>

          {/* Messages */}
          <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 gap-3"
            style={fontSizePercent !== 100 ? { zoom: fontSizePercent / 100 } : undefined}
          >
            {messages.length === 0 && !isStreaming && (
              <div className="flex flex-col items-center justify-center flex-1 text-center gap-2">
                <MessageSquare className="h-8 w-8 text-muted-foreground/40" strokeWidth={3.5} aria-hidden="true" />
                <p className="text-sm text-muted-foreground">
                  Chat with {displayName}.
                </p>
              </div>
            )}
            {(() => {
              const assistantMsgs = messages.filter((m) => m.role === "assistant" && !m.isError && !m.streaming);
              const lastAssistantId = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].id : null;
              return messages.map((msg, index) => (
                <div
                  key={msg.id}
                  className={cn("flex flex-col group gap-0.5", msg.role === "user" ? "items-end" : "items-start")}
                >
                  {msg.role === "user" ? (
                    <div
                      className="max-w-[85%] rounded-2xl rounded-br-sm px-3 py-2 text-sm leading-relaxed text-white whitespace-pre-wrap break-words"
                      style={{ backgroundColor: color }}
                    >
                      {msg.content}
                    </div>
                  ) : msg.isError ? (
                    <div className="w-full rounded-2xl rounded-bl-sm bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm leading-relaxed text-destructive overflow-hidden">
                      <div>{msg.content}</div>
                      {index === messages.length - 1 && (
                        <button
                          type="button"
                          onClick={retryLastMessage}
                          disabled={isStreaming}
                          className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-destructive bg-destructive/10 hover:bg-destructive/20 border border-destructive/30 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <RefreshCw className={cn("w-3 h-3", isStreaming && "animate-spin")} strokeWidth={3.5} aria-hidden="true" />
                          {isStreaming ? "Retrying…" : "Retry"}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="font-arabic-aware w-full rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-foreground overflow-hidden">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeSanitize]}
                        components={MD_COMPONENTS as never}
                      >
                        {msg.content + (msg.streaming ? "▍" : "")}
                      </ReactMarkdown>
                    </div>
                  )}
                  {/* Copy + regenerate buttons (hidden until hover) */}
                  {!msg.isError && !msg.streaming && (
                    <div className="flex items-center gap-0.5 px-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Tip content={copiedId === msg.id ? "Copied!" : "Copy"} side="top">
                        <button
                          type="button"
                          onClick={() => handleCopy(msg.id, msg.content)}
                          aria-label="Copy message"
                          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          {copiedId === msg.id ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                        </button>
                      </Tip>
                      {msg.role === "assistant" && msg.id === lastAssistantId && (
                        <Tip content="Regenerate response" side="top">
                          <button
                            type="button"
                            onClick={handleRegenerate}
                            disabled={isStreaming}
                            aria-label="Regenerate response"
                            className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <RefreshCw className="size-3.5" />
                          </button>
                        </Tip>
                      )}
                    </div>
                  )}
                </div>
              ));
            })()}

            {isStreaming && toolCalls.length > 0 && (
              <div className="flex flex-col gap-1">
                {toolCalls.map((tc) => (
                  <div key={tc.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {tc.isSkill ? (
                      <Sparkles className="h-3 w-3 text-indigo-400 shrink-0" />
                    ) : (
                      <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                    <span className="font-mono truncate">{tc.toolName}</span>
                  </div>
                ))}
              </div>
            )}

            {isStreaming && !messages.some((m) => m.streaming) && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm bg-muted px-4 py-3">
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-3 pb-3 pt-2 border-t border-border shrink-0">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${displayName}…`}
                rows={1}
                className={cn(
                  "flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2",
                  "text-sm placeholder:text-muted-foreground",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "max-h-28 overflow-y-auto",
                )}
                style={{ minHeight: "2.25rem" }}
                disabled={isStreaming}
              />
              <Button
                type="button"
                size="icon"
                onClick={sendMessage}
                disabled={!input.trim() || isStreaming}
                className="shrink-0 h-9 w-9"
                style={{ backgroundColor: color }}
              >
                <Send className="h-4 w-4" strokeWidth={3.5} aria-hidden="true" />
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 px-1">
              Enter to send · Shift+Enter for newline
            </p>
          </div>
        </div>
      )}

      {/* Expanded modal */}
      <Dialog open={expandedOpen} onOpenChange={setExpandedOpen}>
        <DialogContent className="p-0 gap-0 overflow-hidden flex flex-col max-w-4xl w-full h-[82vh] border-0 [&>button:last-child]:hidden">
          {/* Header */}
          <div className="flex items-center px-4 py-3 border-b border-border shrink-0 rounded-t-lg"
            style={{ backgroundColor: color }}
          >
            <div className="flex items-center gap-2 flex-1">
              <MessageSquare className="h-4 w-4 text-white" strokeWidth={3.5} aria-hidden="true" />
              <span className="text-sm font-semibold text-white">{displayName}</span>
              {isStreaming && <Loader2 className="h-3.5 w-3.5 text-white/70 animate-spin" strokeWidth={3.5} aria-hidden="true" />}
            </div>
            <button type="button" onClick={() => setExpandedOpen(false)}
              className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/20 transition-colors">
              <X className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
            </button>
          </div>
          {/* Messages */}
          <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 gap-3"
            style={fontSizePercent !== 100 ? { zoom: fontSizePercent / 100 } : undefined}
          >
            {messages.length === 0 && !isStreaming && (
              <div className="flex flex-col items-center justify-center flex-1 text-center gap-2">
                <MessageSquare className="h-8 w-8 text-muted-foreground/40" strokeWidth={3.5} aria-hidden="true" />
                <p className="text-sm text-muted-foreground">Chat with {displayName}.</p>
              </div>
            )}
            {(() => {
              const assistantMsgs = messages.filter((m) => m.role === "assistant" && !m.isError && !m.streaming);
              const lastAssistantId = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].id : null;
              return messages.map((msg, index) => (
                <div key={msg.id} className={cn("flex flex-col group gap-0.5", msg.role === "user" ? "items-end" : "items-start")}>
                  {msg.role === "user" ? (
                    <div className="max-w-[80%] rounded-2xl rounded-br-sm px-3 py-2 text-sm leading-relaxed text-white whitespace-pre-wrap break-words"
                      style={{ backgroundColor: color }}>
                      {msg.content}
                    </div>
                  ) : msg.isError ? (
                    <div className="w-full rounded-2xl rounded-bl-sm bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm leading-relaxed text-destructive overflow-hidden">
                      <div>{msg.content}</div>
                      {index === messages.length - 1 && (
                        <button type="button" onClick={retryLastMessage} disabled={isStreaming}
                          className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-destructive bg-destructive/10 hover:bg-destructive/20 border border-destructive/30 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                          <RefreshCw className={cn("w-3 h-3", isStreaming && "animate-spin")} strokeWidth={3.5} aria-hidden="true" />
                          {isStreaming ? "Retrying…" : "Retry"}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="font-arabic-aware w-full rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-foreground overflow-hidden">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={MD_COMPONENTS as never}>
                        {msg.content + (msg.streaming ? "▍" : "")}
                      </ReactMarkdown>
                    </div>
                  )}
                  {!msg.isError && !msg.streaming && (
                    <div className="flex items-center gap-0.5 px-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Tip content={copiedId === msg.id ? "Copied!" : "Copy"} side="top">
                        <button type="button" onClick={() => handleCopy(msg.id, msg.content)} aria-label="Copy message"
                          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors">
                          {copiedId === msg.id ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                        </button>
                      </Tip>
                      {msg.role === "assistant" && msg.id === lastAssistantId && (
                        <Tip content="Regenerate response" side="top">
                          <button type="button" onClick={handleRegenerate} disabled={isStreaming} aria-label="Regenerate response"
                            className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                            <RefreshCw className="size-3.5" />
                          </button>
                        </Tip>
                      )}
                    </div>
                  )}
                </div>
              ));
            })()}
            {isStreaming && toolCalls.length > 0 && (
              <div className="flex flex-col gap-1">
                {toolCalls.map((tc) => (
                  <div key={tc.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {tc.isSkill ? <Sparkles className="h-3 w-3 text-indigo-400 shrink-0" /> : <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />}
                    <span className="font-mono truncate">{tc.toolName}</span>
                  </div>
                ))}
              </div>
            )}
            {isStreaming && !messages.some((m) => m.streaming) && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm bg-muted px-4 py-3">
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}
            <div ref={modalMessagesEndRef} />
          </div>
          {/* Input */}
          <div className="px-4 pb-4 pt-2 border-t border-border shrink-0">
            <div className="flex items-end gap-2">
              <textarea
                ref={modalInputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${displayName}…`}
                rows={1}
                className={cn(
                  "flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2",
                  "text-sm placeholder:text-muted-foreground",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "max-h-28 overflow-y-auto",
                )}
                style={{ minHeight: "2.25rem" }}
                disabled={isStreaming}
              />
              <Button type="button" size="icon" onClick={sendMessage} disabled={!input.trim() || isStreaming}
                className="shrink-0 h-9 w-9" style={{ backgroundColor: color }}>
                <Send className="h-4 w-4" strokeWidth={3.5} aria-hidden="true" />
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 px-1">Enter to send · Shift+Enter for newline</p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
