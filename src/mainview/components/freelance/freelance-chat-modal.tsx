import React, { useEffect, useRef, useState, useCallback } from "react";
import { Check, Copy, Download, Globe, Loader2, RefreshCw, Square, Trash2, X, BookmarkPlus } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { markdownSanitizeSchema, markdownUrlTransform } from "@/lib/markdown-sanitize-schema";
import { Button } from "@/components/ui/button";
import { Tip, TooltipProvider } from "@/components/ui/tooltip";
import { CodeBlock } from "@/components/chat/code-block";
import { toast } from "@/components/ui/toast";
import { buildChatMarkdown, exportChatMarkdown } from "@/lib/export-markdown";
import { TypingRow } from "@/components/chat/message-list";
import { ToolCallFeed } from "@/components/chat/tool-call-feed";
import type { ToolCallPartData } from "@/components/chat/tool-call-card";
import { rpc } from "@/lib/rpc";
import { SaveToCollectionModal } from "@/components/collections/save-to-collection-modal";
import { useVoiceInput } from "@/lib/use-voice-input";
import { VoiceInputButton } from "@/components/chat/voice-input-button";
import type { FreelanceChatMessageDto } from "../../../shared/rpc/freelance";
import type { FreelanceListingDto } from "../../../shared/rpc/freelance";

// ---------------------------------------------------------------------------
// Quick-start chips (shown in empty state, ChatGPT-style)
// ---------------------------------------------------------------------------

const QUICK_STARTS = [
  {
    label: "What's this project",
    prompt: "Explain what this project is actually about in plain terms: what the client wants built, the expected deliverables, the technologies involved, and anything that is ambiguous or unstated in the listing.",
  },
  {
    label: "Create Project Timelines",
    prompt: `Create a detailed project timeline for delivering this project using an autonomous AI agent system. The system has specialized agents for backend, frontend, database, DevOps, QA, UI/UX, and research.

Break the work into phases and present the timeline as a markdown table with these exact columns:

| Phase | Tasks | Estimated Duration | Agents Involved | Dependencies |
|---|---|---|---|---|

After the table, include:

## Milestones
List the key deliverables and when they would be ready.

## Risks & Buffers
Identify any tasks that could cause delays and suggest contingency time.

## Total Estimate
Give a realistic end-to-end delivery estimate (optimistic, realistic, pessimistic).

Base your estimates on the complexity of the listed requirements and skills. Assume AI agents work continuously without human bottlenecks except for the final client approval.`,
  },
  {
    label: "Should we bid?",
    prompt: `Give me a go/no-go recommendation on bidding for this project. The work would be built by an autonomous AI agent system that can read/write files, run shell commands, use git, browse the web, and call APIs, and the user can install any software, libraries, or tools the agents need.

The verdict must be based on ONE question only: **can the AI agents create/develop/code 100% of what the client asked for, on their own?**

A human operator works alongside the agents and will ALWAYS handle the non-coding parts, so NONE of the following count against the verdict — do not list them as blockers or concerns:
- Client communication, requirements clarification, vague specs, undefined success criteria, missing timelines
- Client-owned accounts, credentials, API keys, datasets, or platform access (the human will obtain and provide them)
- Deployment, rollout, monitoring, on-call, incident response, operations
- Design sign-off, stakeholder feedback, demos, delivery
- Budget, pricing, effort-vs-reward, seniority/experience requirements in the posting (agents don't have a salary — years-of-experience asks are irrelevant)
- Ongoing-ownership or full-time-role wording

Start with a clear verdict: **BID** or **SKIP** — followed by a one-sentence reason.

Then cover:

## What agents will build
The concrete development work the agents would deliver end-to-end.

## True blockers (if any)
ONLY things that make the development work itself impossible for AI agents — e.g. physical hardware the code must run on that can't be simulated, proprietary closed systems with no API or docs, or work that is fundamentally not software (on-site installation, video presenting, etc.). If there are none, say "None."

## Notes for the human
A short FYI list of what the human operator will need to handle (credentials, clarifications, deployment, communication). Informational only — these do NOT affect the verdict.

## Verdict recap
Restate the verdict and your confidence that agents can build everything the client asked for.`,
  },
  {
    label: "How would we build it?",
    prompt: `Outline how an autonomous AI agent system would actually build this project. The system has specialized agents for backend, frontend, database, DevOps, QA, UI/UX, and research.

Cover:

## Recommended tech stack
The languages, frameworks, libraries, and services you'd use, with a one-line reason for each non-obvious choice.

## Architecture overview
The main components and how they fit together. Keep it high level — a short description per component.

## Agent task breakdown
The concrete tasks, in execution order, and which agent role handles each.

## Hardest parts
The 2-3 riskiest or most complex pieces and how you'd de-risk them.`,
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

type DisplayMessage = FreelanceChatMessageDto | StreamingMessage | ErrorMessage;

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
// Fetching indicator bubble (visible tool-call step in chat)
// ---------------------------------------------------------------------------

function FetchingBubble() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/50 border border-border text-xs text-muted-foreground">
        <Globe className="size-3.5 shrink-0 text-indigo-500" />
        <span>Fetching full listing details…</span>
        <Loader2 className="size-3 animate-spin shrink-0" />
      </div>
    </div>
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
  listing,
}: {
  message: DisplayMessage;
  onRegenerate?: () => void;
  isLastAssistant: boolean;
  isStreaming: boolean;
  listing: FreelanceListingDto;
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
            rehypePlugins={[[rehypeSanitize, markdownSanitizeSchema]]}
            urlTransform={markdownUrlTransform}
            components={MD_COMPONENTS as never}
          >
            {message.content + (streaming ? "▍" : "")}
          </ReactMarkdown>
        )}

        {/* Action buttons for assistant messages */}
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
        sourceType="freelance_chat"
        sourceRef={{ projectName: listing.title, taskId: listing.id }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// FreelanceChatModal
// ---------------------------------------------------------------------------

interface FreelanceChatModalProps {
  listing: FreelanceListingDto;
  open: boolean;
  onClose: () => void;
}

export function FreelanceChatModal({ listing, open, onClose }: FreelanceChatModalProps) {
  const [messages, setMessages] = useState<FreelanceChatMessageDto[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [toolCalls, setToolCalls] = useState<Map<string, ToolCallPartData>>(new Map());
  const [errorState, setErrorState] = useState<{ id: string; content: string } | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [stoppedIndicator, setStoppedIndicator] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingContentRef = useRef("");

  const voice = useVoiceInput(inputValue, setInputValue, () => requestAnimationFrame(() => inputRef.current?.focus()));

  // ── Auto-scroll to bottom ──────────────────────────────────────────────────

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, isFetching, errorState, scrollToBottom]);

  // Re-focus input whenever isSending ends (textarea is disabled while sending)
  useEffect(() => {
    if (!isSending) requestAnimationFrame(() => inputRef.current?.focus());
  }, [isSending]);

  // ── Load messages on open ──────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;

    setIsLoading(true);
    rpc
      .freelanceChatGetMessages(listing.id)
      .then(({ messages: msgs }) => {
        setMessages(msgs);
      })
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, [open, listing.id]);

  // ── Reset state on close or listing change ────────────────────────────────
  // Also resets when listing.id changes so stale tool-call state from a
  // previous listing doesn't bleed through when the modal is reused.

  useEffect(() => {
    if (!open) {
      // Keep streaming state intact while AI is still responding so it's
      // visible when the user reopens the modal before the response finishes.
      if (!isSending) {
        setStreamingId(null);
        setStreamingContent("");
        streamingContentRef.current = "";
        setIsFetching(false);
        setToolCalls(new Map());
      }
      setErrorState(null);
      setStoppedIndicator(false);
    }
  }, [open, isSending]);

  useEffect(() => {
    setToolCalls(new Map());
    setStreamingId(null);
    setStreamingContent("");
    streamingContentRef.current = "";
    setIsFetching(false);
    setErrorState(null);
    setStoppedIndicator(false);
  }, [listing.id]);

  // ── Streaming event listeners ──────────────────────────────────────────────

  useEffect(() => {
    const onFetching = (e: Event) => {
      const { listingId } = (e as CustomEvent<{ listingId: string }>).detail;
      if (listingId !== listing.id) return;
      setIsFetching(true);
    };

    const onFetchDone = (e: Event) => {
      const { listingId } = (e as CustomEvent<{ listingId: string }>).detail;
      if (listingId !== listing.id) return;
      setIsFetching(false);
    };

    const onToolStart = (e: Event) => {
      const { listingId, toolCallId, toolName, toolInput, timeStart } =
        (e as CustomEvent<{ listingId: string; toolCallId: string; toolName: string; toolInput: string; timeStart: string }>).detail;
      if (listingId !== listing.id) return;
      setToolCalls((prev) => {
        const next = new Map(prev);
        next.set(toolCallId, { id: toolCallId, toolName, toolInput, toolOutput: null, toolState: "running", content: "", timeStart, timeEnd: null });
        return next;
      });
    };

    const onToolDone = (e: Event) => {
      const { listingId, toolCallId, toolOutput, isError, timeStart, timeEnd } =
        (e as CustomEvent<{ listingId: string; toolCallId: string; toolName: string; toolOutput: string; isError: boolean; timeStart: string | null; timeEnd: string }>).detail;
      if (listingId !== listing.id) return;
      setToolCalls((prev) => {
        const next = new Map(prev);
        const existing = next.get(toolCallId);
        if (existing) next.set(toolCallId, { ...existing, toolOutput, toolState: isError ? "error" : "success", timeStart: timeStart ?? existing.timeStart, timeEnd });
        return next;
      });
    };

    const onToken = (e: Event) => {
      const { listingId, messageId, token } = (e as CustomEvent<{ listingId: string; messageId: string; token: string }>).detail;
      if (listingId !== listing.id) return;

      streamingContentRef.current += token;
      setStreamingId(messageId);
      setStreamingContent(streamingContentRef.current);
    };

    const onComplete = (e: Event) => {
      const { listingId, messageId, content } = (e as CustomEvent<{ listingId: string; messageId: string; content: string }>).detail;
      if (listingId !== listing.id) return;

      const now = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        { id: messageId, role: "assistant" as const, content, createdAt: now },
      ]);
      setStreamingId(null);
      setStreamingContent("");
      streamingContentRef.current = "";
      setIsFetching(false);
      setIsSending(false);
      setToolCalls(new Map());
    };

    const onError = (e: Event) => {
      const { listingId, error } = (e as CustomEvent<{ listingId: string; error: string }>).detail;
      if (listingId !== listing.id) return;

      setStreamingId(null);
      setStreamingContent("");
      streamingContentRef.current = "";
      setIsFetching(false);
      setIsSending(false);
      setErrorState({ id: crypto.randomUUID(), content: error });
    };

    const onStopped = (e: Event) => {
      const { listingId } = (e as CustomEvent<{ listingId: string }>).detail;
      if (listingId !== listing.id) return;

      setStreamingId(null);
      setStreamingContent("");
      streamingContentRef.current = "";
      setIsFetching(false);
      setIsSending(false);
      setToolCalls(new Map());
      setStoppedIndicator(true);
    };

    window.addEventListener("agentdesk:freelance-chat-fetching", onFetching);
    window.addEventListener("agentdesk:freelance-chat-fetch-done", onFetchDone);
    window.addEventListener("agentdesk:freelance-chat-tool-start", onToolStart);
    window.addEventListener("agentdesk:freelance-chat-tool-done", onToolDone);
    window.addEventListener("agentdesk:freelance-chat-token", onToken);
    window.addEventListener("agentdesk:freelance-chat-complete", onComplete);
    window.addEventListener("agentdesk:freelance-chat-error", onError);
    window.addEventListener("agentdesk:freelance-chat-stopped", onStopped);
    return () => {
      window.removeEventListener("agentdesk:freelance-chat-fetching", onFetching);
      window.removeEventListener("agentdesk:freelance-chat-fetch-done", onFetchDone);
      window.removeEventListener("agentdesk:freelance-chat-tool-start", onToolStart);
      window.removeEventListener("agentdesk:freelance-chat-tool-done", onToolDone);
      window.removeEventListener("agentdesk:freelance-chat-token", onToken);
      window.removeEventListener("agentdesk:freelance-chat-complete", onComplete);
      window.removeEventListener("agentdesk:freelance-chat-error", onError);
      window.removeEventListener("agentdesk:freelance-chat-stopped", onStopped);
    };
  }, [listing.id]);

  // ── Send message ───────────────────────────────────────────────────────────

  const handleSend = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || isSending) return;

      voice.stop();
      const userMsg: FreelanceChatMessageDto = {
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
        await rpc.freelanceChatSendMessage(listing.id, text);
      } catch (err) {
        console.error("[freelance-chat] Send failed:", err);
        setIsSending(false);
        setErrorState({
          id: crypto.randomUUID(),
          content: err instanceof Error ? err.message : "Failed to send message",
        });
      }
    },
    [listing.id, isSending, voice],
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

    // Optimistically remove last assistant message from display
    setMessages((prev) => {
      const idx = [...prev].reverse().findIndex((m) => m.role === "assistant");
      if (idx === -1) return prev;
      const actualIdx = prev.length - 1 - idx;
      return prev.filter((_, i) => i !== actualIdx);
    });

    try {
      await rpc.freelanceChatRegenerate(listing.id);
    } catch (err) {
      console.error("[freelance-chat] Regenerate failed:", err);
      setIsSending(false);
      setErrorState({
        id: crypto.randomUUID(),
        content: err instanceof Error ? err.message : "Failed to regenerate response",
      });
    }
  }, [listing.id, isSending]);

  // ── Clear conversation ─────────────────────────────────────────────────────

  const handleClear = async () => {
    setIsClearing(true);
    try {
      await rpc.freelanceChatClearMessages(listing.id);
      setMessages([]);
      setStreamingId(null);
      setStreamingContent("");
      streamingContentRef.current = "";
      setIsFetching(false);
      setToolCalls(new Map());
      setErrorState(null);
      setShowClearConfirm(false);
    } catch (err) {
      console.error("[freelance-chat] Clear failed:", err);
    } finally {
      setIsClearing(false);
    }
  };

  // ── Export conversation as Markdown ─────────────────────────────────────────
  // Mirrors the dashboard chat widgets: one heading per turn, listing title as
  // the document title. Only enabled once a real exchange exists (> 1 message).

  const handleExportMarkdown = useCallback(() => {
    const ok = exportChatMarkdown({
      title: listing.title || "Freelance Chat",
      messages,
      assistantLabel: "Assistant",
    });
    if (ok) toast("success", "Chat exported as Markdown.");
  }, [messages, listing.title]);

  const [copiedAll, setCopiedAll] = useState(false);
  const handleCopyConversation = useCallback(() => {
    const md = buildChatMarkdown({
      title: listing.title || "Freelance Chat",
      messages,
      assistantLabel: "Assistant",
    });
    if (!md) return;
    void navigator.clipboard.writeText(md).then(() => {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    });
  }, [messages, listing.title]);

  // ── Derived state ──────────────────────────────────────────────────────────

  const isEmpty = messages.length === 0 && !streamingId && !isFetching && !errorState && toolCalls.size === 0;

  // Keep historical messages separate from the live streaming bubble so tool
  // calls always render between committed messages and the streaming response.
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
                {listing.title}
              </DialogPrimitive.Title>
              <p className="text-xs text-muted-foreground mt-0.5">Freelance Chat</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {/* Copy whole conversation — enabled only once a real exchange exists */}
              {!showClearConfirm && (
                <Tip content={copiedAll ? "Copied!" : "Copy conversation"} side="bottom">
                  <button
                    type="button"
                    onClick={handleCopyConversation}
                    disabled={messages.length <= 1}
                    aria-label="Copy conversation"
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {copiedAll ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </button>
                </Tip>
              )}
              {/* Export as markdown — enabled only once a real exchange exists */}
              {!showClearConfirm && (
                <Tip content="Export as markdown" side="bottom">
                  <button
                    type="button"
                    onClick={handleExportMarkdown}
                    disabled={messages.length <= 1}
                    aria-label="Export chat as markdown"
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Download className="size-4" />
                  </button>
                </Tip>
              )}
              {/* Clear button */}
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
              /* Empty state with quick-start chips */
              <div className="flex flex-col items-center justify-center h-full gap-6 px-4">
                <div className="text-center">
                  <p className="text-base font-medium text-foreground">Chat about this listing</p>
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
                    listing={listing}
                  />
                ))}
                {isFetching && <FetchingBubble />}
                {isSending && !isFetching && !streamingId && toolCalls.size === 0 && (
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
                    listing={listing}
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
                    listing={listing}
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
              {voice.supported && (
                <VoiceInputButton listening={voice.listening} error={voice.error} onClick={voice.toggle} disabled={isSending} />
              )}
              {isSending ? (
                <Button
                  onClick={() => { rpc.freelanceChatStop(listing.id).catch(() => {}); }}
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
