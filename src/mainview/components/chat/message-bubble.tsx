import React, { useState, useMemo, useEffect, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Check, Copy, Trash2, ClipboardList, RefreshCw, GitBranch, GitCompare, ListChecks, CheckSquare, Square, Paperclip, BookmarkPlus } from "lucide-react";
import { cn, displayAgentName } from "@/lib/utils";
import { relativeTimeVerbose } from "@/lib/date-utils";
import type { Message } from "@/stores/chat-store";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { useMessageActions } from "./message-actions-context";
import { Tip } from "@/components/ui/tooltip";
import { CodeBlock } from "./code-block";
import { PlanDiff } from "./plan-diff";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { MessageParts, ThinkingBlock, type MessagePartData } from "./message-parts";
import { rpc } from "@/lib/rpc";
import { useChatStore } from "@/stores/chat-store";
import { MermaidDiagram } from "@/components/ui/mermaid-diagram";
import { SaveToCollectionModal } from "@/components/collections/save-to-collection-modal";

// Re-export so MessageList (and any other consumers) can import from here
export type { Message };

interface MessageBubbleProps {
  message: Message;
  projectId?: string;
  isStreaming?: boolean;
  /** All visible messages — passed from parent for plan diff lookup (avoids per-bubble store subscription). */
  allMessages?: Message[];
  searchQuery?: string;
  /** Live PM thinking text — rendered as a connected card above the bubble. */
  thinkingContent?: string;
  /** Whether this is the last message in the conversation — controls retry button visibility. */
  isLastMessage?: boolean;
}

// Highlight matching search terms in text
function SearchHighlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) =>
        re.test(part) ? (
          <mark key={i} className="bg-yellow-200 text-inherit rounded-sm px-px">{part}</mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function highlightChildren(children: React.ReactNode, query: string): React.ReactNode {
  if (!query.trim()) return children;
  if (typeof children === "string") return <SearchHighlight text={children} query={query} />;
  if (Array.isArray(children)) return children.map((c, i) => <React.Fragment key={i}>{highlightChildren(c, query)}</React.Fragment>);
  return children;
}

// ---------------------------------------------------------------------------
// Attachment previews in user messages
// ---------------------------------------------------------------------------

// User messages persist with the implicit AI context (attached file/note
// content, @mentioned file content) baked directly into `content` — the PM
// rebuilds its history straight from the DB, so that content has to stay in
// the row. But rendered raw through ReactMarkdown, the `<attached-file>`
// wrapper is an unrecognized tag that rehype-sanitize strips entirely
// (content included), which is why a reload showed an empty bubble instead of
// the "Attached: [name]" chip the pre-refresh optimistic render had. Extract
// the wrapped blocks back out into chip labels before markdown-rendering.
const ATTACHMENT_CONTEXT_PATTERNS = [
  /<attached-file name="([^"]*)"(?:\s+path="[^"]*")?>[\s\S]*?<\/attached-file>\n?/g,
  /\[Attached image: "([^"]*)" saved at "[^"]*"\.[^\]]*\]\n?/g,
  /\[Attached file: "([^"]*)" saved at "[^"]*"\.[^\]]*\]\n?/g,
];

function extractAttachmentChips(content: string): { chips: string[]; text: string } {
  const chips: string[] = [];
  let text = content;
  for (const pattern of ATTACHMENT_CONTEXT_PATTERNS) {
    text = text.replace(pattern, (_match, name: string) => {
      chips.push(name);
      return "";
    });
  }
  return { chips, text: text.trim() };
}

function AttachmentPreviews({ attachments }: { attachments: Array<{ name: string; type: string; path?: string; dataUrl?: string }> }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const images = attachments.filter(a => a.type === "image");
  const docs = attachments.filter(a => a.type !== "image");

  return (
    <>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {images.map((img, i) => {
            const src = img.dataUrl || "";
            return (
              <button
                key={i}
                onClick={() => setLightboxSrc(src)}
                className="block rounded-lg overflow-hidden border border-white/30 hover:border-white/60 transition-colors"
              >
                <img
                  src={src}
                  alt={img.name}
                  className="max-h-[200px] max-w-[300px] object-contain"
                />
              </button>
            );
          })}
        </div>
      )}
      {docs.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {docs.map((doc, i) => (
            <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/20 text-xs text-white/90 border border-white/20">
              <Paperclip className="w-3 h-3" />
              {doc.name}
            </span>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm cursor-pointer"
          onClick={() => setLightboxSrc(null)}
        >
          <img src={lightboxSrc} alt="Full size" className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl" />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Plan approval footer — Approve / Reject buttons
// ---------------------------------------------------------------------------

function PlanApprovalFooter({ projectId, previousPlanContent, showDiff, setShowDiff }: {
  projectId?: string;
  previousPlanContent: string | null;
  showDiff: boolean;
  setShowDiff: (fn: (v: boolean) => boolean) => void;
}) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const sendMessage = useChatStore((s) => s.sendMessage);
  const activeConversationId = useChatStore((s) => s.activeConversationId);

  const handleApprove = () => {
    if (!activeConversationId || !projectId) return;
    sendMessage(projectId, activeConversationId, "approve");
  };

  const handleReject = () => {
    if (!activeConversationId || !projectId) return;
    const msg = feedback.trim() ? `reject ${feedback.trim()}` : "reject";
    sendMessage(projectId, activeConversationId, msg);
    setRejectOpen(false);
    setFeedback("");
  };

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-amber-200 dark:border-amber-700/50 bg-amber-100/40 dark:bg-amber-900/20">
        <button
          onClick={handleApprove}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
        >
          <Check className="w-3.5 h-3.5" />
          Approve
        </button>
        <button
          onClick={() => setRejectOpen((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-background text-red-600 border border-red-200 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
        >
          Reject
        </button>

        <div className="flex-1" />

        {previousPlanContent && (
          <Tip content={showDiff ? "Hide changes" : "Show changes from previous plan"} side="top">
            <button onClick={() => setShowDiff((v: boolean) => !v)} className={cn("flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors shrink-0", showDiff ? "bg-amber-300 text-amber-900 hover:bg-amber-400" : "bg-amber-200 text-amber-800 hover:bg-amber-300")}>
              <GitCompare className="w-3 h-3" aria-hidden="true" />
              {showDiff ? "Hide changes" : "Show changes"}
            </button>
          </Tip>
        )}
      </div>

      {rejectOpen && (
        <div className="px-4 py-3 border-t border-amber-200 dark:border-amber-700/50 bg-amber-50/50 dark:bg-amber-950/20 space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Optional feedback — what should change?"
            className="w-full px-3 py-2 text-xs rounded-md border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-red-300"
            rows={2}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleReject}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
            >
              {feedback.trim() ? "Reject with Feedback" : "Reject"}
            </button>
            <button
              onClick={() => { setRejectOpen(false); setFeedback(""); }}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared markdown component overrides (hoisted to avoid re-creation per render)
// ---------------------------------------------------------------------------

const PLAN_MD_COMPONENTS = {
   
  code({ className, children, ref: _ref, ...props }: Record<string, unknown>) {
    const match = /language-(\w+)/.exec((className as string) ?? "");
    if (match?.[1] === "mermaid") {
      return <MermaidDiagram code={String(children).trim()} fallbackClassName="text-[13px] font-mono whitespace-pre-wrap text-foreground/80 my-2" />;
    }
    const isInline = !match;
    if (isInline) {
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
  li: ({ children }: { children: React.ReactNode }) => <li className="mb-1 text-foreground">{children}</li>,
  h1: ({ children }: { children: React.ReactNode }) => <h1 className="text-xl font-semibold mb-2 mt-4 text-foreground">{children}</h1>,
  h2: ({ children }: { children: React.ReactNode }) => <h2 className="text-lg font-semibold mb-2 mt-3 text-foreground">{children}</h2>,
  h3: ({ children }: { children: React.ReactNode }) => <h3 className="text-base font-semibold mb-1 mt-3 text-foreground">{children}</h3>,
  strong: ({ children }: { children: React.ReactNode }) => <strong className="font-semibold text-foreground">{children}</strong>,
  a: ({ href, children }: { href?: string; children: React.ReactNode }) => (
    <a
      href={href}
      className="text-blue-800 hover:text-blue-600 font-semibold underline cursor-pointer"
      onClick={(e) => {
        e.preventDefault();
        if (href) rpc.openExternalUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  ),
  table: ({ children }: { children: React.ReactNode }) => <div className="my-2 overflow-x-auto rounded-lg border border-border"><table className="min-w-full text-xs">{children}</table></div>,
  thead: ({ children }: { children: React.ReactNode }) => <thead className="bg-muted/50 border-b border-border">{children}</thead>,
  th: ({ children }: { children: React.ReactNode }) => <th className="px-3 py-1.5 text-left font-semibold text-foreground/80">{children}</th>,
  td: ({ children }: { children: React.ReactNode }) => <td className="px-3 py-1.5 text-foreground/80 border-t border-border/50">{children}</td>,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const MessageBubble = memo(function MessageBubble({ message, projectId, isStreaming = false, allMessages, searchQuery = "", thinkingContent, isLastMessage = false }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isBranching, setIsBranching] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [parts, setParts] = useState<MessagePartData[] | null>(null);
  const [saveToCollectionOpen, setSaveToCollectionOpen] = useState(false);

  const { deleteMessage, retryLastMessage, branchConversation, setActiveConversation, loadMessages } = useMessageActions();
  const stopAgent = useChatStore((s) => s.stopAgent);
  const runningAgentCount = useChatStore((s) => s.runningAgentCount);

  const handleStopAgent = useMemo(() => {
    if (!projectId) return undefined;
    return (agentName: string) => stopAgent(projectId, agentName);
  }, [projectId, stopAgent]);

  const handleRetryAgent = useMemo(() => {
    if (!projectId) return undefined;
    return async (agentName: string, task: string): Promise<void> => {
      await rpc.retryAgent(projectId, message.conversationId, agentName, task);
    };
  }, [projectId, message.conversationId]);

  // Load message parts when hasParts flag is set
  useEffect(() => {
    if (!message.hasParts) return;
    let cancelled = false;
    rpc.getMessageParts(message.id).then((raw) => {
      if (cancelled) return;
      // Inject agentName from parent message into each part
      const enriched: MessagePartData[] = raw.map((p) => ({
        ...p,
        agentName: message.agentName ?? undefined,
      }));
      setParts(enriched);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [message.id, message.hasParts, message.agentName]);

  // Listen for live part created/updated events
  useEffect(() => {
    const onPartCreated = (e: Event) => {
      const { messageId, part } = (e as CustomEvent).detail;
      if (messageId !== message.id) return;
      const newPart: MessagePartData = {
        id: part.id,
        messageId,
        type: part.type,
        content: part.content ?? "",
        toolName: part.toolName ?? null,
        toolInput: part.toolInput ?? null,
        toolOutput: part.toolOutput ?? null,
        toolState: part.toolState ?? null,
        sortOrder: part.sortOrder ?? 0,
        timeStart: part.timeStart ?? null,
        timeEnd: part.timeEnd ?? null,
        createdAt: new Date().toISOString(),
        agentName: part.agentName ?? message.agentName ?? undefined,
      };
      setParts((prev) => prev ? [...prev, newPart] : [newPart]);
    };
    const onPartUpdated = (e: Event) => {
      const { messageId, partId, updates } = (e as CustomEvent).detail;
      if (messageId !== message.id) return;
      setParts((prev) =>
        prev?.map((p) =>
          p.id === partId ? { ...p, ...updates } : p,
        ) ?? null,
      );
    };
    window.addEventListener("agentdesk:part-created", onPartCreated);
    window.addEventListener("agentdesk:part-updated", onPartUpdated);
    return () => {
      window.removeEventListener("agentdesk:part-created", onPartCreated);
      window.removeEventListener("agentdesk:part-updated", onPartUpdated);
    };
  }, [message.id, message.agentName]);

  const isUser = message.role === "user";
  const isError = message.role === "error" || message.content.startsWith("[Generation failed]");
  const isAgentCard = !!message.hasParts;

  // Only user messages ever carry the embedded attachment/mention context tags.
  const { chips: attachmentChips, text: displayContent } = useMemo(
    () => (isUser ? extractAttachmentChips(message.content) : { chips: [], text: message.content }),
    [isUser, message.content],
  );

  // Parse plan metadata if present (memoized to avoid repeated JSON.parse)
  const parsedMeta = useMemo(() => {
    try {
      return message.metadata ? JSON.parse(message.metadata) : null;
    } catch {
      return null;
    }
  }, [message.metadata]);
  const isPlan = parsedMeta?.type === "plan";
  // For plan messages: find the previous plan in the same conversation so we
  // can offer a diff view. Uses allMessages prop from parent (no store subscription).
  const previousPlanContent = useMemo(() => {
    if (!isPlan || !allMessages) return null;
    // Walk backwards from the current message's position to find the most
    // recent earlier plan message in the same conversation.
    const currentIndex = allMessages.findIndex((m) => m.id === message.id);
    const searchFrom = currentIndex === -1 ? allMessages.length - 1 : currentIndex - 1;
    for (let i = searchFrom; i >= 0; i--) {
      const m = allMessages[i];
      if (m.conversationId !== message.conversationId) continue;
      try {
        const meta = m.metadata ? JSON.parse(m.metadata) : null;
        if (meta?.type === "plan") return m.content;
      } catch {
        // ignore
      }
    }
    return null;
  }, [isPlan, allMessages, message.id, message.conversationId]);

  const handleCopy = () => {
    navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDeleteClick = () => setShowDeleteDialog(true);

  const handleRetry = async () => {
    if (!projectId || isRetrying) return;
    setIsRetrying(true);
    try {
      await retryLastMessage(projectId, message.conversationId);
    } finally {
      setIsRetrying(false);
    }
  };

  const handleBranch = async () => {
    if (!projectId || isBranching) return;
    setIsBranching(true);
    try {
      const newId = await branchConversation(projectId, message.conversationId, message.id);
      setActiveConversation(newId);
      await loadMessages(newId);
    } finally {
      setIsBranching(false);
    }
  };

  // Memoize role-dependent markdown components with search highlighting
  const mdComponents = useMemo(() => {
    const h = (children: React.ReactNode) => highlightChildren(children, searchQuery);
    return {
       
      code({ className, children, ref: _ref, ...props }: Record<string, unknown>) {
        const match = /language-(\w+)/.exec((className as string) ?? "");
        if (match?.[1] === "mermaid") {
          return <MermaidDiagram code={String(children).trim()} />;
        }
        const isInline = !match;
        if (isInline) {
          return (
            <code
              {...props}
              className={cn(
                "text-[13px] font-mono",
                isUser ? "text-yellow-200 font-semibold" : "text-rose-600 dark:text-orange-300"
              )}
            >
              {children as React.ReactNode}
            </code>
          );
        }
        return <CodeBlock language={match[1]} code={String(children).replace(/\n$/, "")} />;
      },
      p: ({ children }: { children: React.ReactNode }) => <p className="mb-2 last:mb-0">{h(children)}</p>,
      ul: ({ children }: { children: React.ReactNode }) => <ul className="list-disc pl-4 mb-2">{children}</ul>,
      ol: ({ children }: { children: React.ReactNode }) => <ol className="list-decimal pl-4 mb-2">{children}</ol>,
      li: ({ children }: { children: React.ReactNode }) => <li className="mb-1">{h(children)}</li>,
      h1: ({ children }: { children: React.ReactNode }) => <h1 className={cn("text-xl font-semibold mb-2 mt-4", isUser ? "text-white" : "text-foreground")}>{h(children)}</h1>,
      h2: ({ children }: { children: React.ReactNode }) => <h2 className={cn("text-lg font-semibold mb-2 mt-3", isUser ? "text-white" : "text-foreground")}>{h(children)}</h2>,
      h3: ({ children }: { children: React.ReactNode }) => <h3 className={cn("text-base font-semibold mb-1 mt-3", isUser ? "text-white" : "text-foreground")}>{h(children)}</h3>,
      blockquote: ({ children }: { children: React.ReactNode }) => (
        <blockquote className={cn("border-l-2 pl-3 italic mb-2", isUser ? "border-indigo-300 text-indigo-100" : "border-border text-muted-foreground")}>
          {h(children)}
        </blockquote>
      ),
      a: ({ href, children }: { href?: string; children: React.ReactNode }) => (
        <a
          href={href}
          className={cn("font-semibold underline cursor-pointer", isUser ? "text-blue-200 hover:text-white" : "text-blue-800 hover:text-blue-600")}
          onClick={(e) => {
            e.preventDefault();
            if (href) rpc.openExternalUrl(href).catch(() => {});
          }}
        >
          {h(children)}
        </a>
      ),
      table: ({ children }: { children: React.ReactNode }) => (
        <div className={cn("my-2 overflow-x-auto rounded-lg border", isUser ? "border-indigo-400/40" : "border-border")}><table className="min-w-full text-xs">{children}</table></div>
      ),
      thead: ({ children }: { children: React.ReactNode }) => (
        <thead className={cn("border-b", isUser ? "bg-indigo-500/30 border-indigo-400/40" : "bg-muted/50 border-border")}>{children}</thead>
      ),
      th: ({ children }: { children: React.ReactNode }) => (
        <th className={cn("px-3 py-1.5 text-left font-semibold", isUser ? "text-indigo-100" : "text-foreground/80")}>{h(children)}</th>
      ),
      td: ({ children }: { children: React.ReactNode }) => (
        <td className={cn("px-3 py-1.5 border-t", isUser ? "text-indigo-100 border-indigo-400/30" : "text-foreground/80 border-border/50")}>{h(children)}</td>
      ),
      img: ({ src, alt }: { src?: string; alt?: string }) => (
        <img src={src} alt={alt ?? ""} className="max-w-full rounded-lg my-2 border border-border" loading="lazy" />
      ),
      hr: () => <hr className={cn("my-3 border-t", isUser ? "border-indigo-400/40" : "border-border")} />,
      h4: ({ children }: { children: React.ReactNode }) => <h4 className={cn("text-sm font-semibold mb-1 mt-2 first:mt-0", isUser ? "text-white" : "text-foreground")}>{h(children)}</h4>,
      h5: ({ children }: { children: React.ReactNode }) => <h5 className={cn("text-sm font-medium mb-1 mt-2", isUser ? "text-white" : "text-foreground")}>{h(children)}</h5>,
      strong: ({ children }: { children: React.ReactNode }) => <strong className={cn("font-semibold", isUser ? "text-white" : "text-foreground")}>{children}</strong>,
    };
  }, [isUser, searchQuery]);

  // Render todo_list messages as a live checklist card
  const isTodoList = parsedMeta?.type === "todo_list";
  if (isTodoList) {
    const items: Array<{ id: string; title: string; status: "pending" | "in_progress" | "done" }> =
      parsedMeta?.items ?? [];
    const doneCount = items.filter((i) => i.status === "done").length;

    return (
      <div className="flex items-start gap-2">
        <AgentAvatar name="project-manager" size="sm" />
        <div className="min-w-0 max-w-[90%]">
          <div className="rounded-2xl rounded-bl-md border border-border bg-background overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-muted/50">
              <ListChecks className="w-3.5 h-3.5 text-muted-foreground shrink-0" strokeWidth={2.5} />
              <span className="text-xs font-semibold text-foreground/80 uppercase tracking-wide">
                {doneCount}/{items.length} tasks
              </span>
            </div>
            {/* Items */}
            <div className="px-3 py-2.5 space-y-1.5">
              {items.map((item) => (
                <div key={item.id} className="flex items-center gap-2">
                  {item.status === "done" ? (
                    <CheckSquare className="w-5 h-5 shrink-0 text-emerald-800" />
                  ) : item.status === "in_progress" ? (
                    <CheckSquare className="w-5 h-5 shrink-0 text-blue-600" />
                  ) : (
                    <Square className="w-5 h-5 shrink-0 text-muted-foreground/40" />
                  )}
                  <span
                    className={cn(
                      "text-sm leading-snug",
                      item.status === "done"
                        ? "text-emerald-800"
                        : item.status === "in_progress"
                        ? "text-foreground font-medium"
                        : "text-muted-foreground",
                    )}
                  >
                    {item.title}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-1 ml-1">
            <span className="text-xs text-muted-foreground/60">{relativeTimeVerbose(message.createdAt)}</span>
          </div>
        </div>
      </div>
    );
  }

  // Render plan messages with a distinct card layout
  if (isPlan) {
    return (
      <div className="flex items-start gap-2">
        <AgentAvatar name="task-planner" size="sm" />
        <div className="flex-1 min-w-0 max-w-[90%]">
          <div className="rounded-2xl rounded-bl-md border border-amber-200 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-950/30 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-200 dark:border-amber-700/50 bg-amber-100/60 dark:bg-amber-900/20">
              <ClipboardList className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0" aria-hidden="true" />
              <span className="text-sm font-semibold text-amber-900 dark:text-amber-300 truncate">
                Plan: {parsedMeta.title ?? "Review Required"}
              </span>
            </div>
            <div className="px-4 py-3 max-h-[60vh] overflow-y-auto">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSanitize]}
                components={PLAN_MD_COMPONENTS as never}
              >
                {message.content}
              </ReactMarkdown>
            </div>

            {/* Diff view — only shown when a previous plan exists and user toggled it */}
            {previousPlanContent && showDiff && (
              <div className="px-4 pb-3">
                <PlanDiff
                  oldContent={previousPlanContent}
                  newContent={message.content}
                />
              </div>
            )}

            <PlanApprovalFooter
              projectId={projectId}
              previousPlanContent={previousPlanContent}
              showDiff={showDiff}
              setShowDiff={setShowDiff}
            />
          </div>
          <div className="mt-1 ml-1">
            <span className="text-xs text-muted-foreground/60">{relativeTimeVerbose(message.createdAt)}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-end gap-2",
        isUser ? "flex-row-reverse" : "flex-row"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Agent avatar — visible only while streaming, same lifecycle as amber border. Hidden for agent cards. */}
      {!isUser && !isError && !isAgentCard && (
        <div className={cn("transition-all duration-200", isStreaming ? "opacity-100" : "opacity-0 pointer-events-none w-0 overflow-hidden")}>
          <AgentAvatar
            name={message.agentId ?? "project-manager"}
            size="sm"
          />
        </div>
      )}

      <div className={cn("flex flex-col gap-1 min-w-0", isUser ? "items-end max-w-[80%]" : "items-start w-full px-4")}>
        {/* Agent name badge — visible only while streaming, same lifecycle as amber border */}
        {!isUser && !isError && !isAgentCard && (
          <span className={cn(
            "text-[11px] font-semibold ml-1 transition-opacity duration-200",
            isStreaming ? "text-muted-foreground opacity-100" : "opacity-0 h-0 overflow-hidden"
          )}>
            {displayAgentName(message.agentId ?? "project-manager")}
          </span>
        )}
        {/* Parts-based messages render directly without a bubble wrapper */}
        {parts && parts.length > 0 ? (
          <div className="min-w-0 w-full">
            <MessageParts parts={parts} onStopAgent={handleStopAgent} hasRunningAgents={runningAgentCount > 0} onRetryAgent={handleRetryAgent} />
          </div>
        ) : (
          <div className="min-w-0">
            {/* Thinking card — separate element above bubble, visually connected */}
            {thinkingContent && !isUser && (
              <div
                className={cn(
                  "bg-background border px-4 pt-2 pb-2.5 rounded-t-lg",
                  isStreaming ? "border-amber-500 border-b-border" : "border-border",
                )}
              >
                <ThinkingBlock content={thinkingContent} defaultExpanded pulse />
              </div>
            )}
            {/* Bubble */}
            <div
              className={cn(
                "px-4 py-2.5 text-sm leading-relaxed min-w-0 overflow-hidden break-words",
                isError
                  ? "bg-red-50 border border-red-200 text-red-700 rounded-2xl"
                  : isUser
                  ? "bg-indigo-600 text-white rounded-2xl rounded-br-md"
                  : cn(
                      "bg-background border text-foreground",
                      isStreaming ? "border-amber-500" : "border-border",
                      thinkingContent
                        ? "rounded-b-lg border-t-0"
                        : "rounded-lg",
                    )
              )}
            >
              {!isUser && !thinkingContent && parsedMeta?.reasoning && (
                <>
                  <div className="-mx-4 -mt-2.5 px-4 pt-3 pb-3 mb-4 bg-muted/50 border-b border-border">
                    <ThinkingBlock content={parsedMeta.reasoning} label="Thought for a moment" />
                  </div>
                </>
              )}
              {/* Attachment previews — rich (with image thumbnails) when the in-memory
                  metadata is still around; otherwise (e.g. after a reload, since
                  attachment metadata isn't persisted) fall back to plain name chips
                  recovered from the embedded context tags. */}
              {isUser && parsedMeta?.attachments ? (
                <AttachmentPreviews attachments={parsedMeta.attachments} />
              ) : isUser && attachmentChips.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {attachmentChips.map((name, i) => (
                    <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/20 text-xs text-white/90 border border-white/20">
                      <Paperclip className="w-3 h-3" />
                      {name}
                    </span>
                  ))}
                </div>
              ) : null}
              {(() => {
                const c = displayContent?.trim();
                if (c?.startsWith("{") && c.includes('"stdout"')) {
                  try {
                    const parsed = JSON.parse(c);
                    if (parsed && typeof parsed === "object" && ("stdout" in parsed || "stderr" in parsed)) {
                      const stdout = typeof parsed.stdout === "string" ? parsed.stdout : "";
                      const stderr = typeof parsed.stderr === "string" ? parsed.stderr : "";
                      const output = stderr ? (stdout ? stdout + "\n" + stderr : stderr) : stdout;
                      const exitCode = parsed.exitCode;
                      return (
                        <div className="w-full rounded-lg overflow-hidden border border-gray-700">
                          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 border-b border-gray-700">
                            <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
                            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
                            <span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
                            <span className="text-[10px] text-gray-500 ml-1.5 font-mono">terminal</span>
                            {exitCode != null && (
                              <span className={cn("text-[10px] ml-auto font-mono font-semibold", exitCode === 0 ? "text-green-400" : "text-red-400")}>
                                exit {exitCode}
                              </span>
                            )}
                          </div>
                          <pre className="text-[11px] bg-gray-900 text-gray-100 font-mono px-3 py-2 whitespace-pre-wrap break-words max-h-64 overflow-auto leading-[1.6]">
                            {output || "(no output)"}
                          </pre>
                        </div>
                      );
                    }
                  } catch { /* not JSON */ }
                }
                return (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeSanitize]}
                    components={mdComponents as never}
                  >
                    {displayContent + (isStreaming ? "▍" : "")}
                  </ReactMarkdown>
                );
              })()}
              {isError && projectId && (
                <button
                  onClick={handleRetry}
                  disabled={isRetrying}
                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-red-700 bg-red-100 hover:bg-red-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RefreshCw className={cn("w-3 h-3", isRetrying && "animate-spin")} />
                  {isRetrying ? "Retrying..." : "Retry"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Hover action row */}
        <div
          className={cn(
            "flex items-center gap-1 transition-opacity duration-150",
            isHovered ? "opacity-100" : "opacity-0",
            isUser ? "flex-row-reverse" : "flex-row"
          )}
          aria-hidden={!isHovered}
        >
          {isUser ? (
            <>
              {/* User: visual order (left→right) = timestamp, fork, copy, delete */}
              {/* flex-row-reverse flips DOM order, so DOM = delete, copy, fork, timestamp */}
              <Tip content="Delete" side="top">
                <button
                  onClick={handleDeleteClick}
                  className="p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-muted transition-colors"
                  aria-label="Delete message"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </Tip>
              <Tip content={copied ? "Copied!" : "Copy"} side="top">
                <button
                  onClick={handleCopy}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  aria-label={copied ? "Copied" : "Copy message"}
                >
                  {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                </button>
              </Tip>
              {projectId && (
                <Tip content="Fork from here" side="top">
                  <button
                    onClick={handleBranch}
                    disabled={isBranching || isStreaming}
                    className="p-1 rounded text-muted-foreground hover:text-indigo-500 hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Fork conversation from this message"
                  >
                    <GitBranch className={cn("w-3.5 h-3.5", isBranching && "animate-pulse")} aria-hidden="true" />
                  </button>
                </Tip>
              )}
              <span className="text-xs text-muted-foreground/60 mr-1">{relativeTimeVerbose(message.createdAt)}</span>
            </>
          ) : (
            <>
              {/* Assistant: visual order (left→right) = copy, retry, fork, delete, timestamp */}
              <Tip content={copied ? "Copied!" : "Copy"} side="top">
                <button
                  onClick={handleCopy}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  aria-label={copied ? "Copied" : "Copy message"}
                >
                  {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                </button>
              </Tip>
              <Tip content="Save to Collection" side="top">
                <button
                  onClick={() => setSaveToCollectionOpen(true)}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  aria-label="Save to Collection"
                >
                  <BookmarkPlus className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </Tip>
              {projectId && isLastMessage && (
                <Tip content="Retry" side="top">
                  <button
                    onClick={handleRetry}
                    disabled={isRetrying || isStreaming}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Retry — regenerate this response"
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5", isRetrying && "animate-spin")} aria-hidden="true" />
                  </button>
                </Tip>
              )}
              <Tip content="Delete" side="top">
                <button
                  onClick={handleDeleteClick}
                  className="p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-muted transition-colors"
                  aria-label="Delete message"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </Tip>
              <span className="text-xs text-muted-foreground/60 ml-1">{relativeTimeVerbose(message.createdAt)}</span>
            </>
          )}
        </div>
      </div>

      <ConfirmationDialog
        open={showDeleteDialog}
        onOpenChange={(open) => { if (!open) setShowDeleteDialog(false); }}
        title="Delete message"
        description="This message will be permanently deleted. This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => { deleteMessage(message.id); setShowDeleteDialog(false); }}
        onCancel={() => setShowDeleteDialog(false)}
      />

      <SaveToCollectionModal
        open={saveToCollectionOpen}
        onOpenChange={setSaveToCollectionOpen}
        contentMarkdown={message.content}
        sourceType="pm_chat"
        sourceRef={projectId ? { projectId } : undefined}
      />
    </div>
  );
});

