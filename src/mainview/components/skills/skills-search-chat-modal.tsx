import React, { useEffect, useRef, useState, useCallback } from "react";
import { Check, Copy, Loader2, RefreshCw, Square, Trash2, X, BookmarkPlus } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Button } from "@/components/ui/button";
import { Tip, TooltipProvider } from "@/components/ui/tooltip";
import { CodeBlock } from "@/components/chat/code-block";
import { TypingRow } from "@/components/chat/message-list";
import { ToolCallFeed } from "@/components/chat/tool-call-feed";
import type { ToolCallPartData } from "@/components/chat/tool-call-card";
import { rpc } from "@/lib/rpc";
import { SaveToCollectionModal } from "@/components/collections/save-to-collection-modal";
import type { SkillsChatMessageDto } from "../../../shared/rpc/skills";

// ---------------------------------------------------------------------------
// Quick-start chips (shown in empty state)
// ---------------------------------------------------------------------------

const QUICK_STARTS = [
  {
    label: "Find a changelog skill",
    prompt: "Is there a skill that can automatically generate a changelog from git commits or PRs?",
  },
  {
    label: "What's already installed?",
    prompt: "What skills do I have installed already, and what does each one do?",
  },
  {
    label: "PDF form filling",
    prompt: "Is there a skill for filling out PDF forms programmatically?",
  },
  {
    label: "Web scraping skill",
    prompt: "Is there a skill for scraping and parsing websites?",
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StreamingMessage {
  id: string;
  role: "assistant";
  content: string;
  streaming: true;
}

interface ErrorMessage {
  id: string;
  role: "error";
  content: string;
}

type DisplayMessage = SkillsChatMessageDto | StreamingMessage | ErrorMessage;

function isStreaming(m: DisplayMessage): m is StreamingMessage {
  return "streaming" in m && m.streaming === true;
}

function isError(m: DisplayMessage): m is ErrorMessage {
  return m.role === "error";
}

// ---------------------------------------------------------------------------
// Markdown component overrides for assistant messages
// ---------------------------------------------------------------------------

const MD_COMPONENTS = {
  code({ className, children, ref: _ref, ...props }: Record<string, unknown>) {
    const match = /language-(\w+)/.exec((className as string) ?? "");
    if (!match) {
      return (
        <code {...props} className="text-[13px] font-mono text-rose-600 dark:text-orange-300">
          {children as React.ReactNode}
        </code>
      );
    }
    return <CodeBlock language={match[1]} code={String(children).replace(/\n$/, "")} />;
  },
  p: ({ children }: { children: React.ReactNode }) => <p className="mb-2 last:mb-0 text-sm text-foreground">{children}</p>,
  ul: ({ children }: { children: React.ReactNode }) => <ul className="list-disc pl-4 mb-2 text-sm text-foreground">{children}</ul>,
  ol: ({ children }: { children: React.ReactNode }) => <ol className="list-decimal pl-4 mb-2 text-sm text-foreground">{children}</ol>,
  li: ({ children }: { children: React.ReactNode }) => <li className="mb-1 text-sm text-foreground">{children}</li>,
  h1: ({ children }: { children: React.ReactNode }) => <h1 className="text-xl font-semibold mb-2 mt-4 text-foreground">{children}</h1>,
  h2: ({ children }: { children: React.ReactNode }) => <h2 className="text-lg font-semibold mb-2 mt-3 text-foreground">{children}</h2>,
  h3: ({ children }: { children: React.ReactNode }) => <h3 className="text-base font-semibold mb-1 mt-3 text-foreground">{children}</h3>,
  h4: ({ children }: { children: React.ReactNode }) => <h4 className="text-sm font-semibold mb-1 mt-2 text-foreground">{children}</h4>,
  strong: ({ children }: { children: React.ReactNode }) => <strong className="font-semibold text-foreground">{children}</strong>,
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="border-l-2 border-border pl-3 italic mb-2 text-muted-foreground">{children}</blockquote>
  ),
  a: ({ href, children }: { href?: string; children: React.ReactNode }) => (
    <a
      href={href}
      className="text-blue-800 hover:text-blue-600 font-semibold underline cursor-pointer"
      onClick={(e) => { e.preventDefault(); if (href) rpc.openExternalUrl(href).catch(() => {}); }}
    >
      {children}
    </a>
  ),
  table: ({ children }: { children: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }: { children: React.ReactNode }) => <thead className="bg-muted/50 border-b border-border">{children}</thead>,
  th: ({ children }: { children: React.ReactNode }) => <th className="px-3 py-1.5 text-left font-semibold text-foreground/80">{children}</th>,
  td: ({ children }: { children: React.ReactNode }) => <td className="px-3 py-1.5 text-foreground/80 border-t border-border/50">{children}</td>,
  hr: () => <hr className="my-3 border-t border-border" />,
};

// ---------------------------------------------------------------------------
// Copy button with check feedback
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Tip content={copied ? "Copied!" : "Copy to clipboard"} side="top">
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy message"
        className="p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </Tip>
  );
}

// ---------------------------------------------------------------------------
// Individual message bubble
// ---------------------------------------------------------------------------

function MessageBubble({
  message,
  onRegenerate,
  isLastAssistant,
  isStreaming: streaming,
}: {
  message: DisplayMessage;
  onRegenerate?: () => void;
  isLastAssistant: boolean;
  isStreaming: boolean;
}) {
  const isUser = message.role === "user";
  const isErr = isError(message);
  const [saveToCollectionOpen, setSaveToCollectionOpen] = useState(false);

  if (isErr) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm leading-relaxed bg-red-50 border border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-800 dark:text-red-400">
          <p className="font-medium mb-1">Something went wrong</p>
          <p className="text-xs opacity-80 break-words">{message.content}</p>
          {onRegenerate && (
            <button
              type="button"
              onClick={onRegenerate}
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-red-700 bg-red-100 hover:bg-red-200 dark:text-red-400 dark:bg-red-900/40 dark:hover:bg-red-900/60 rounded-lg transition-colors"
            >
              <RefreshCw className="size-3" />
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} group`}>
      <div
        className={`relative max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-muted text-foreground rounded-bl-sm"
        }`}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap break-words text-sm">
            {message.content}
          </div>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            components={MD_COMPONENTS as never}
          >
            {message.content + (streaming ? "▍" : "")}
          </ReactMarkdown>
        )}

        {!isUser && !streaming && (
          <div className="flex items-center gap-0.5 mt-1.5 -mb-0.5">
            <CopyButton text={message.content} />
            <Tip content="Save to Collection" side="top">
              <button
                type="button"
                onClick={() => setSaveToCollectionOpen(true)}
                aria-label="Save to Collection"
                className="p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <BookmarkPlus className="size-3.5" />
              </button>
            </Tip>
            {isLastAssistant && onRegenerate && (
              <Tip content="Regenerate response" side="top">
                <button
                  type="button"
                  onClick={onRegenerate}
                  aria-label="Regenerate response"
                  className="p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <RefreshCw className="size-3.5" />
                </button>
              </Tip>
            )}
          </div>
        )}
      </div>
      <SaveToCollectionModal
        open={saveToCollectionOpen}
        onOpenChange={setSaveToCollectionOpen}
        contentMarkdown={message.content}
        sourceType="skills_chat"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SkillsSearchChatModal
// ---------------------------------------------------------------------------

interface SkillsSearchChatModalProps {
  open: boolean;
  onClose: () => void;
}

export function SkillsSearchChatModal({ open, onClose }: SkillsSearchChatModalProps) {
  const [messages, setMessages] = useState<SkillsChatMessageDto[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [toolCalls, setToolCalls] = useState<Map<string, ToolCallPartData>>(new Map());
  const [errorState, setErrorState] = useState<{ id: string; content: string } | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [stoppedIndicator, setStoppedIndicator] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingContentRef = useRef("");

  // ── Auto-scroll to bottom ──────────────────────────────────────────────────

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, errorState, scrollToBottom]);

  useEffect(() => {
    if (!isSending) requestAnimationFrame(() => inputRef.current?.focus());
  }, [isSending]);

  // ── Load messages on open ──────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;

    setIsLoading(true);
    rpc
      .getSkillsChatMessages()
      .then(({ messages: msgs }) => {
        setMessages(msgs);
      })
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, [open]);

  // ── Reset transient state on close ─────────────────────────────────────────

  useEffect(() => {
    if (!open) {
      if (!isSending) {
        setStreamingId(null);
        setStreamingContent("");
        streamingContentRef.current = "";
        setToolCalls(new Map());
      }
      setErrorState(null);
      setStoppedIndicator(false);
    }
  }, [open, isSending]);

  // ── Streaming event listeners ──────────────────────────────────────────────

  useEffect(() => {
    const onToolStart = (e: Event) => {
      const { toolCallId, toolName, toolInput, timeStart } =
        (e as CustomEvent<{ toolCallId: string; toolName: string; toolInput: string; timeStart: string }>).detail;
      setToolCalls((prev) => {
        const next = new Map(prev);
        next.set(toolCallId, { id: toolCallId, toolName, toolInput, toolOutput: null, toolState: "running", content: "", timeStart, timeEnd: null });
        return next;
      });
    };

    const onToolDone = (e: Event) => {
      const { toolCallId, toolOutput, isError, timeStart, timeEnd } =
        (e as CustomEvent<{ toolCallId: string; toolName: string; toolOutput: string; isError: boolean; timeStart: string | null; timeEnd: string }>).detail;
      setToolCalls((prev) => {
        const next = new Map(prev);
        const existing = next.get(toolCallId);
        if (existing) next.set(toolCallId, { ...existing, toolOutput, toolState: isError ? "error" : "success", timeStart: timeStart ?? existing.timeStart, timeEnd });
        return next;
      });
    };

    const onToken = (e: Event) => {
      const { messageId, token } = (e as CustomEvent<{ messageId: string; token: string }>).detail;
      streamingContentRef.current += token;
      setStreamingId(messageId);
      setStreamingContent(streamingContentRef.current);
    };

    const onComplete = (e: Event) => {
      const { messageId, content } = (e as CustomEvent<{ messageId: string; content: string }>).detail;
      const now = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        { id: messageId, role: "assistant" as const, content, createdAt: now },
      ]);
      setStreamingId(null);
      setStreamingContent("");
      streamingContentRef.current = "";
      setIsSending(false);
      setToolCalls(new Map());
    };

    const onError = (e: Event) => {
      const { error } = (e as CustomEvent<{ error: string }>).detail;
      setStreamingId(null);
      setStreamingContent("");
      streamingContentRef.current = "";
      setIsSending(false);
      setErrorState({ id: crypto.randomUUID(), content: error });
    };

    const onStopped = () => {
      setStreamingId(null);
      setStreamingContent("");
      streamingContentRef.current = "";
      setIsSending(false);
      setToolCalls(new Map());
      setStoppedIndicator(true);
    };

    window.addEventListener("agentdesk:skills-chat-tool-start", onToolStart);
    window.addEventListener("agentdesk:skills-chat-tool-done", onToolDone);
    window.addEventListener("agentdesk:skills-chat-token", onToken);
    window.addEventListener("agentdesk:skills-chat-complete", onComplete);
    window.addEventListener("agentdesk:skills-chat-error", onError);
    window.addEventListener("agentdesk:skills-chat-stopped", onStopped);
    return () => {
      window.removeEventListener("agentdesk:skills-chat-tool-start", onToolStart);
      window.removeEventListener("agentdesk:skills-chat-tool-done", onToolDone);
      window.removeEventListener("agentdesk:skills-chat-token", onToken);
      window.removeEventListener("agentdesk:skills-chat-complete", onComplete);
      window.removeEventListener("agentdesk:skills-chat-error", onError);
      window.removeEventListener("agentdesk:skills-chat-stopped", onStopped);
    };
  }, []);

  // ── Send message ───────────────────────────────────────────────────────────

  const handleSend = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || isSending) return;

      const userMsg: SkillsChatMessageDto = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setInputValue("");
      setIsSending(true);
      setErrorState(null);
      setStoppedIndicator(false);
      setToolCalls(new Map());
      streamingContentRef.current = "";

      try {
        await rpc.sendSkillsChatMessage(text);
      } catch (err) {
        console.error("[skills-search-chat] Send failed:", err);
        setIsSending(false);
        setErrorState({
          id: crypto.randomUUID(),
          content: err instanceof Error ? err.message : "Failed to send message",
        });
      }
    },
    [isSending],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend(inputValue);
    }
  };

  // ── Regenerate / Retry ─────────────────────────────────────────────────────

  const handleRegenerate = useCallback(async () => {
    if (isSending) return;

    setIsSending(true);
    setErrorState(null);
    setStoppedIndicator(false);
    setToolCalls(new Map());
    streamingContentRef.current = "";

    setMessages((prev) => {
      const idx = [...prev].reverse().findIndex((m) => m.role === "assistant");
      if (idx === -1) return prev;
      const actualIdx = prev.length - 1 - idx;
      return prev.filter((_, i) => i !== actualIdx);
    });

    try {
      await rpc.regenerateSkillsChat();
    } catch (err) {
      console.error("[skills-search-chat] Regenerate failed:", err);
      setIsSending(false);
      setErrorState({
        id: crypto.randomUUID(),
        content: err instanceof Error ? err.message : "Failed to regenerate response",
      });
    }
  }, [isSending]);

  // ── Clear conversation ─────────────────────────────────────────────────────

  const handleClear = async () => {
    setIsClearing(true);
    try {
      await rpc.clearSkillsChatMessages();
      setMessages([]);
      setStreamingId(null);
      setStreamingContent("");
      streamingContentRef.current = "";
      setToolCalls(new Map());
      setErrorState(null);
      setShowClearConfirm(false);
    } catch (err) {
      console.error("[skills-search-chat] Clear failed:", err);
    } finally {
      setIsClearing(false);
    }
  };

  // ── Derived state ──────────────────────────────────────────────────────────

  const isEmpty = messages.length === 0 && !streamingId && !errorState && toolCalls.size === 0;

  const displayMessages: DisplayMessage[] = messages;

  const lastAssistantId = [...displayMessages]
    .reverse()
    .find((m) => m.role === "assistant" && !isStreaming(m))?.id ?? null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <TooltipProvider>
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] w-[min(90vw,900px)] h-[80vh] flex flex-col bg-background border border-border rounded-xl shadow-2xl overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-sm font-semibold text-foreground leading-snug truncate">
                Search Remote Skills
              </DialogPrimitive.Title>
              <p className="text-xs text-muted-foreground mt-0.5">Find and install skills from the open agent-skills ecosystem</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {messages.length > 0 && !showClearConfirm && (
                <Tip content="Clear conversation" side="bottom">
                  <button
                    type="button"
                    onClick={() => setShowClearConfirm(true)}
                    aria-label="Clear conversation"
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </Tip>
              )}
              {showClearConfirm && (
                <div className="flex items-center gap-1.5 mr-1">
                  <span className="text-xs text-muted-foreground">Clear all messages?</span>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={handleClear}
                    disabled={isClearing}
                    className="h-6 px-2 text-xs"
                  >
                    {isClearing ? <Loader2 className="size-3 animate-spin" /> : "Clear"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowClearConfirm(false)}
                    disabled={isClearing}
                    className="h-6 px-2 text-xs"
                  >
                    Cancel
                  </Button>
                </div>
              )}
              <DialogPrimitive.Close
                className="p-1.5 rounded-md opacity-70 hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Close chat"
              >
                <X className="size-4" />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* Messages area */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
          >
            {isLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : isEmpty ? (
              <div className="flex flex-col items-center justify-center h-full gap-6 px-4">
                <div className="text-center">
                  <p className="text-base font-medium text-foreground">Search & install a skill</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Ask me anything or pick a quick start below
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 w-full max-w-md">
                  {QUICK_STARTS.map((qs) => (
                    <button
                      key={qs.label}
                      type="button"
                      onClick={() => void handleSend(qs.prompt)}
                      className="text-left px-3 py-2.5 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {qs.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {displayMessages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    onRegenerate={handleRegenerate}
                    isLastAssistant={msg.id === lastAssistantId}
                    isStreaming={false}
                  />
                ))}
                {isSending && !streamingId && toolCalls.size === 0 && (
                  <div className="overflow-hidden">
                    <TypingRow />
                  </div>
                )}
                {toolCalls.size > 0 && (
                  <ToolCallFeed
                    toolCalls={[...toolCalls.values()].map((tc) => ({
                      id: tc.id,
                      toolName: tc.toolName ?? "",
                      isSkill: tc.toolName === "read_skill" || tc.toolName === "find_skills",
                    }))}
                  />
                )}
                {streamingId && (
                  <MessageBubble
                    key={streamingId}
                    message={{ id: streamingId, role: "assistant" as const, content: streamingContent, streaming: true as const }}
                    onRegenerate={handleRegenerate}
                    isLastAssistant={false}
                    isStreaming={true}
                  />
                )}
                {stoppedIndicator && (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-red-500 dark:text-red-400">
                      <Square className="size-2.5 fill-current" />
                      Stopped
                    </div>
                  </div>
                )}
                {errorState && (
                  <MessageBubble
                    key={errorState.id}
                    message={{ id: errorState.id, role: "error", content: errorState.content }}
                    onRegenerate={handleRegenerate}
                    isLastAssistant={false}
                    isStreaming={false}
                  />
                )}
              </>
            )}
          </div>

          {/* Input area */}
          <div className="shrink-0 border-t border-border px-4 py-3 bg-background">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Message… (Enter to send, Shift+Enter for new line)"
                rows={1}
                disabled={isSending}
                className="flex-1 resize-none rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50 min-h-[38px] max-h-[120px] overflow-y-auto leading-relaxed"
                style={{ height: "auto" }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
                }}
              />
              {isSending ? (
                <Button
                  onClick={() => { rpc.stopSkillsChat().catch(() => {}); }}
                  size="sm"
                  variant="outline"
                  className="shrink-0 h-[38px] px-4 border-red-500 text-red-500 hover:bg-red-50 hover:text-red-600 dark:border-red-500 dark:text-red-400 dark:hover:bg-red-950/30"
                  aria-label="Stop generation"
                >
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button
                  onClick={() => void handleSend(inputValue)}
                  disabled={!inputValue.trim()}
                  size="sm"
                  className="shrink-0 h-[38px] px-4"
                  aria-label="Send message"
                >
                  Send
                </Button>
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
    </TooltipProvider>
  );
}
