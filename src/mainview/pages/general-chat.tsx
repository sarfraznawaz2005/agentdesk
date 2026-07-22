import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { markdownSanitizeSchema, markdownUrlTransform } from "@/lib/markdown-sanitize-schema";
import { ArrowUp, Square, Check, Copy, Server, RefreshCw, WifiOff, Loader2, AlertCircle, X, Paperclip, Library, Music, FileText as FileTextIcon, Trash2, GitBranch, BookmarkPlus, PanelLeft, ZoomIn, ZoomOut, Search, Download, Plus, Settings } from "lucide-react";
import { useHeaderActions } from "@/lib/header-context";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import { relativeTimeVerbose } from "@/lib/date-utils";
import { CodeBlock } from "@/components/chat/code-block";
import { ToolCallFeed } from "@/components/chat/tool-call-feed";
import { ConversationSidebar } from "@/components/chat/conversation-sidebar";
import { ModelSelector } from "@/components/chat/model-selector";
import { VoiceInputButton } from "@/components/chat/voice-input-button";
import { useVoiceInput } from "@/lib/use-voice-input";
import { PromptsDropdown } from "@/components/chat/prompts-dropdown";
import { AttachNoteModal } from "@/components/collections/attach-note-modal";
import { SaveToCollectionModal } from "@/components/collections/save-to-collection-modal";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { ACCEPT_ALL, processFiles, type AttachmentFile } from "@/components/chat/chat-input";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tip, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { SLASH_COMMANDS, useInputPopover, type PopoverItem } from "@/components/chat/chat-input-popover";
import { DeepResearchToggle } from "@/components/general-chat/deep-research-toggle";
import { GeneralChatStreamingSettings } from "@/components/general-chat/general-chat-settings";
import { MessageSearch } from "@/components/chat/message-search";
import { useConvFontSize } from "@/lib/use-conv-font-size";
import { toast } from "@/components/ui/toast";
import { useChatStore, type Message as ChatStoreMessage, type Conversation } from "@/stores/chat-store";
import type { GeneralChatConversationDto } from "../../shared/rpc/general-chat";

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK_SIZE = 0x8000; // 32KB
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

// Strip the implicit-context wrapper (attached file/note content baked into
// the persisted message text, same mechanism project chat's message-bubble.tsx
// uses) back out into plain "Attached: [name]" chip labels for display —
// mirrors message-bubble.tsx's ATTACHMENT_CONTEXT_PATTERNS/extractAttachmentChips
// exactly, duplicated here for the same reason MD_COMPONENTS is: avoids
// pulling in that file's full useChatStore/useMessageActions coupling.
const ATTACHMENT_CONTEXT_PATTERNS = [
  /<attached-file name="([^"]*)"(?:\s+path="[^"]*")?>[\s\S]*?<\/attached-file>\n?/g,
  /\[Attached image: "([^"]*)" saved at "[^"]*"\.[^\]]*\]\n?/g,
  /\[Attached audio: "([^"]*)" saved at "[^"]*"\.[^\]]*\]\n?/g,
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

// Images the assistant generated (generate_image) are embedded
// directly into the persisted assistant message as <generated-image> blocks —
// general_chat_messages has no parts table to persist live tool-call activity
// into, unlike project chat's message_parts (see orchestrator.ts's sendMessage).
// Extracted back out into real <img> elements here, same pattern as
// extractAttachmentChips.
const GENERATED_IMAGE_PATTERN = /<generated-image mime="([^"]*)">([\s\S]*?)<\/generated-image>\n?/g;

function extractGeneratedImages(content: string): { images: Array<{ mime: string; base64: string }>; text: string } {
  const images: Array<{ mime: string; base64: string }> = [];
  const text = content.replace(GENERATED_IMAGE_PATTERN, (_match, mime: string, base64: string) => {
    images.push({ mime, base64 });
    return "";
  });
  return { images, text: text.trim() };
}

function GeneratedImages({ images }: { images: Array<{ mime: string; base64: string }> }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2 mb-2">
        {images.map((img, i) => {
          const src = `data:${img.mime};base64,${img.base64}`;
          return (
            <button key={i} type="button" onClick={() => setLightboxSrc(src)} className="block rounded-lg overflow-hidden border border-border hover:border-indigo-400 transition-colors">
              <img src={src} alt="Generated" className="max-h-[240px] max-w-[320px] object-contain" />
            </button>
          );
        })}
      </div>
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm cursor-pointer"
          onClick={() => setLightboxSrc(null)}
        >
          <img src={lightboxSrc} alt="Generated, full size" className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl" />
        </div>
      )}
    </>
  );
}

// General Chat offers 4 of the main chat's slash commands — no @-mention
// file/kanban commands apply here (no project, no workspace files to browse),
// and no /mcp — the persistent "N MCP servers" toolbar button (mcpDialogOpen)
// already covers that. "compact" is filtered further at render time (hidden
// below 50% context utilization), mirroring chat-input.tsx's visibleSlashCommands.
const GENERAL_CHAT_SLASH_IDS = new Set(["clear", "compact", "fork", "new"]);
const GENERAL_CHAT_SLASH_COMMANDS: PopoverItem[] = SLASH_COMMANDS.filter((c) => GENERAL_CHAT_SLASH_IDS.has(c.id));

// Fallback only — used for the brief window before getGeneralChatContextLimit's
// first response lands (real per-model limit, same number sendMessage's own
// auto-compaction threshold checks against; see rpc/general-chat.ts).
const CONTEXT_LIMIT_FALLBACK = 1_000_000;

function estimateTokens(messages: DisplayMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Local, self-contained equivalent of ModelSelector's ContextIndicator
// ("inline" variant) — deliberately NOT the shared component, which reads
// useChatStore's global liveContextTokens/liveTokensPerSecond. That store is
// shared with project chat inside the same webview, so reusing it here could
// show a stale token count left over from whichever project conversation was
// open last. contextLimit/liveContextTokens are General Chat's OWN real
// numbers instead — contextLimit from getGeneralChatContextLimit (the actual
// model's context window), liveContextTokens from the backend's own per-step
// usage (generalChatContextUsage/generalChatComplete) — falling back to the
// local char/4 estimate only until the first real figure arrives.
function GeneralChatContextIndicator({
  messages,
  tokensPerSecond,
  contextLimit,
  liveContextTokens,
}: {
  messages: DisplayMessage[];
  tokensPerSecond?: number;
  contextLimit: number;
  liveContextTokens: number;
}) {
  if (messages.length === 0) return null;
  const tokens = liveContextTokens > 0 ? liveContextTokens : estimateTokens(messages);
  const utilization = Math.min((tokens / contextLimit) * 100, 100);
  const barColor = utilization > 80 ? "bg-red-500" : utilization > 60 ? "bg-amber-500" : "bg-indigo-500";
  const textColor = utilization > 80 ? "text-red-500" : utilization > 60 ? "text-amber-500" : "text-muted-foreground";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="inline-flex items-center gap-1.5 px-2 py-1 cursor-default">
          <span className={cn("text-[11px] tabular-nums whitespace-nowrap", textColor)}>~{formatTokens(tokens)}</span>
          <div className="w-44 h-1 bg-muted rounded-full overflow-hidden">
            <div className={cn("h-full rounded-full transition-all duration-500", barColor)} style={{ width: `${utilization}%` }} />
          </div>
          <span className={cn("text-[11px] tabular-nums whitespace-nowrap", textColor)}>{utilization.toFixed(0)}%</span>
          {!!tokensPerSecond && tokensPerSecond > 0 && (
            <span className="text-[11px] font-semibold text-blue-800 dark:text-blue-400 tabular-nums whitespace-nowrap">
              {Math.round(tokensPerSecond)} tokens/s
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">Conversation auto-compacts on the next turn when context reaches the model's context window</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Markdown rendering — copied (not imported) from message-bubble.tsx's
// PLAN_MD_COMPONENTS, same pattern skills-search-chat-modal.tsx already uses
// for its own standalone chat surface: identical visual result (ReactMarkdown +
// remarkGfm + rehypeSanitize + the same code/table/list treatment) without
// pulling in MessageBubble's full useChatStore/useMessageActions coupling.
// ---------------------------------------------------------------------------

// Search-match highlighting — duplicated from message-bubble.tsx's
// SearchHighlight/highlightChildren (same reasoning as MD_COMPONENTS itself:
// identical visual result without pulling in that file's store coupling).
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
  if (Array.isArray(children)) return children.map((c, i) => <Fragment key={i}>{highlightChildren(c, query)}</Fragment>);
  return children;
}

function buildMdComponents(query: string) {
  const h = (children: React.ReactNode) => highlightChildren(children, query);
  return {
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
    p: ({ children }: { children: React.ReactNode }) => <p className="mb-2 last:mb-0 text-sm text-foreground">{h(children)}</p>,
    ul: ({ children }: { children: React.ReactNode }) => <ul className="list-disc pl-4 mb-2 text-sm text-foreground">{children}</ul>,
    ol: ({ children }: { children: React.ReactNode }) => <ol className="list-decimal pl-4 mb-2 text-sm text-foreground">{children}</ol>,
    li: ({ children }: { children: React.ReactNode }) => <li className="mb-1 text-sm text-foreground">{h(children)}</li>,
    h1: ({ children }: { children: React.ReactNode }) => <h1 className="text-xl font-semibold mb-2 mt-4 text-foreground">{h(children)}</h1>,
    h2: ({ children }: { children: React.ReactNode }) => <h2 className="text-lg font-semibold mb-2 mt-3 text-foreground">{h(children)}</h2>,
    h3: ({ children }: { children: React.ReactNode }) => <h3 className="text-base font-semibold mb-1 mt-3 text-foreground">{h(children)}</h3>,
    h4: ({ children }: { children: React.ReactNode }) => <h4 className="text-sm font-semibold mb-1 mt-2 text-foreground">{h(children)}</h4>,
    strong: ({ children }: { children: React.ReactNode }) => <strong className="font-semibold text-foreground">{children}</strong>,
    img: ({ src, alt }: { src?: string; alt?: string }) => (
      <img src={src} alt={alt ?? ""} className="max-w-full rounded-lg my-2 border border-border" loading="lazy" />
    ),
    blockquote: ({ children }: { children: React.ReactNode }) => (
      <blockquote className="border-l-2 border-border pl-3 italic mb-2 text-muted-foreground">{h(children)}</blockquote>
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
    th: ({ children }: { children: React.ReactNode }) => <th className="px-3 py-1.5 text-left font-semibold text-foreground/80">{h(children)}</th>,
    td: ({ children }: { children: React.ReactNode }) => <td className="px-3 py-1.5 text-foreground/80 border-t border-border/50">{h(children)}</td>,
    hr: () => <hr className="my-3 border-t border-border" />,
  };
}

// ---------------------------------------------------------------------------
// Message bubble — flat (no plan/todo-list cards; General Chat never persists
// tool-call activity), but the hover action row mirrors project chat's
// MessageBubble: user = fork/copy/delete/timestamp, assistant =
// copy/save-to-collection/retry(last message only)/delete/timestamp/model.
// ---------------------------------------------------------------------------

interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** JSON-encoded, e.g. {"modelId": "claude-sonnet-5", "durationMs": 7200} — set on assistant replies only. */
  metadata?: string | null;
  createdAt: string;
}

/** "Worked 7s" / "Worked 3m 20s" — mirrors message-parts.tsx's agent-card duration format. */
function formatWorkedDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  const dur = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `Worked ${dur}`;
}

function GeneralChatBubble({
  message,
  isStreaming,
  isLastMessage,
  busy,
  searchQuery,
  onDelete,
  onFork,
  onRetry,
}: {
  message: DisplayMessage;
  isStreaming?: boolean;
  /** Whether this is the last message in the conversation — controls Retry visibility (assistant only). */
  isLastMessage?: boolean;
  /** True while a turn/fork/retry is already in flight elsewhere — disables fork/retry/delete to avoid racing it. */
  busy?: boolean;
  /** Search-in-conversation query — matched text is wrapped in <mark>, mirrors message-bubble.tsx. */
  searchQuery?: string;
  onDelete: (id: string) => void | Promise<void>;
  onFork: (id: string) => void | Promise<void>;
  onRetry: () => void | Promise<void>;
}) {
  const isUser = message.role === "user";
  const { chips, text } = isUser ? extractAttachmentChips(message.content) : { chips: [], text: message.content };
  const { images, text: assistantText } = !isUser ? extractGeneratedImages(text) : { images: [], text };
  const mdComponents = useMemo(() => buildMdComponents(searchQuery ?? ""), [searchQuery]);
  const parsedMeta = useMemo(() => {
    if (isUser || !message.metadata) return null;
    try {
      return JSON.parse(message.metadata);
    } catch {
      return null;
    }
  }, [isUser, message.metadata]);
  const modelName: string | null = typeof parsedMeta?.modelId === "string" ? parsedMeta.modelId : null;
  const workedLabel: string | null = typeof parsedMeta?.durationMs === "number" ? formatWorkedDuration(parsedMeta.durationMs) : null;
  // Set by orchestrator.ts's sendMessage on the persisted assistant row — General
  // Chat always persists a real row even on failure (unlike project chat's PM loop,
  // which keeps a failed turn as a purely client-side, never-persisted bubble), so
  // this flag is what distinguishes a normal reply from a failed one.
  const isError = !isUser && parsedMeta?.status === "failed";

  const [copied, setCopied] = useState(false);
  const [isForking, setIsForking] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [saveToCollectionOpen, setSaveToCollectionOpen] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(isUser ? text : assistantText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleFork = async () => {
    if (isForking || busy) return;
    setIsForking(true);
    try {
      await onFork(message.id);
    } finally {
      setIsForking(false);
    }
  };

  const handleRetryClick = async () => {
    if (isRetrying || busy) return;
    setIsRetrying(true);
    try {
      await onRetry();
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div className={cn("flex group", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("flex flex-col gap-1 min-w-0", isUser ? "max-w-[80%]" : "w-full")} style={isUser ? { alignItems: "flex-end" } : { alignItems: "flex-start" }}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed min-w-0 overflow-hidden break-words",
            isError
              ? "bg-red-50 border border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-900 dark:text-red-400"
              : isUser
              ? "bg-indigo-600 text-white rounded-br-md"
              : "bg-background border border-border rounded-bl-md text-foreground",
          )}
        >
          {isUser ? (
            <>
              {chips.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {chips.map((name, i) => (
                    <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/20 text-xs text-white/90 border border-white/20">
                      <Paperclip className="w-3 h-3" />
                      {name}
                    </span>
                  ))}
                </div>
              )}
              {text && <div className="whitespace-pre-wrap break-words">{highlightChildren(text, searchQuery ?? "")}</div>}
            </>
          ) : isError ? (
            <>
              {/* Plain text, not markdown — buildMdComponents hardcodes text-foreground
                  on every element, which would override the red inherited from the
                  wrapper above; error content is never markdown-formatted anyway. */}
              <div className="whitespace-pre-wrap break-words">{assistantText}</div>
              <button
                type="button"
                onClick={handleRetryClick}
                disabled={isRetrying || busy}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-red-700 bg-red-100 hover:bg-red-200 dark:text-red-400 dark:bg-red-950/50 dark:hover:bg-red-950/80 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw className={cn("w-3 h-3", isRetrying && "animate-spin")} aria-hidden="true" />
                {isRetrying ? "Retrying..." : "Retry"}
              </button>
            </>
          ) : (
            <>
              <GeneratedImages images={images} />
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, markdownSanitizeSchema]]} urlTransform={markdownUrlTransform} components={mdComponents as never}>
                {assistantText + (isStreaming ? "▍" : "")}
              </ReactMarkdown>
            </>
          )}
        </div>
        {!isStreaming && (
          <div
            className={cn(
              "flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150",
              isUser && "flex-row-reverse",
            )}
          >
            {isUser ? (
              <>
                {/* User: visual order (left→right) = timestamp, fork, copy, delete — mirrors message-bubble.tsx */}
                <Tip content="Delete" side="top">
                  <button
                    type="button"
                    onClick={() => setShowDeleteDialog(true)}
                    aria-label="Delete message"
                    className="p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-muted transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </Tip>
                <Tip content={copied ? "Copied!" : "Copy"} side="top">
                  <button
                    type="button"
                    onClick={handleCopy}
                    aria-label={copied ? "Copied" : "Copy message"}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </Tip>
                <Tip content="Fork from here" side="top">
                  <button
                    type="button"
                    onClick={handleFork}
                    disabled={isForking || busy}
                    aria-label="Fork conversation from this message"
                    className="p-1 rounded text-muted-foreground hover:text-indigo-500 hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <GitBranch className={cn("w-3.5 h-3.5", isForking && "animate-pulse")} />
                  </button>
                </Tip>
                <span className="text-xs text-muted-foreground/60 mr-1">{relativeTimeVerbose(message.createdAt)}</span>
              </>
            ) : (
              <>
                {/* Assistant: visual order (left→right) = copy, save, retry, delete, timestamp, model — mirrors message-bubble.tsx */}
                <Tip content={copied ? "Copied!" : "Copy"} side="top">
                  <button
                    type="button"
                    onClick={handleCopy}
                    aria-label={copied ? "Copied" : "Copy message"}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </Tip>
                <Tip content="Save to Collection" side="top">
                  <button
                    type="button"
                    onClick={() => setSaveToCollectionOpen(true)}
                    aria-label="Save to Collection"
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    <BookmarkPlus className="w-3.5 h-3.5" />
                  </button>
                </Tip>
                {isLastMessage && (
                  <Tip content="Retry" side="top">
                    <button
                      type="button"
                      onClick={handleRetryClick}
                      disabled={isRetrying || busy}
                      aria-label="Retry — regenerate this response"
                      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <RefreshCw className={cn("w-3.5 h-3.5", isRetrying && "animate-spin")} />
                    </button>
                  </Tip>
                )}
                <Tip content="Delete" side="top">
                  <button
                    type="button"
                    onClick={() => setShowDeleteDialog(true)}
                    aria-label="Delete message"
                    className="p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-muted transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </Tip>
                <span className="text-xs text-muted-foreground/60 ml-1">{relativeTimeVerbose(message.createdAt)}</span>
                {workedLabel && (
                  <span className="text-xs text-muted-foreground/60 ml-1.5 shrink-0">{workedLabel}</span>
                )}
                {modelName && (
                  <span className="text-xs text-muted-foreground/60 font-mono ml-1.5 truncate max-w-[180px]" title={modelName}>
                    {modelName}
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <ConfirmationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title="Delete message"
        description="This message will be permanently deleted. This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => onDelete(message.id)}
      />

      {!isUser && (
        <SaveToCollectionModal
          open={saveToCollectionOpen}
          onOpenChange={setSaveToCollectionOpen}
          contentMarkdown={assistantText}
          sourceType="general_chat"
        />
      )}
    </div>
  );
}

// "Thinking…" indicator — mirrors message-list.tsx's shared TypingRow (same
// rainbow-animated bordered bubble, lightbulb icon, typewriter reveal) but
// with <AgentAvatar name="general-chat-assistant"> instead of TypingRow's hardcoded
// "project-manager" badge, since Assistant has no PM/project identity.
function AssistantTypingRow() {
  const text = "Thinking...";
  const [charCount, setCharCount] = useState(0);
  const done = charCount >= text.length;

  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setCharCount((c) => Math.min(c + 1, text.length)), 60);
    return () => clearInterval(id);
  }, [done]);

  return (
    <div className="flex items-start gap-2">
      <style>{`
        @keyframes ga-rainbow-border {
          0%   { border-color: #38bdf8; }
          25%  { border-color: #818cf8; }
          50%  { border-color: #e879f9; }
          75%  { border-color: #818cf8; }
          100% { border-color: #38bdf8; }
        }
        @keyframes ga-rainbow-text {
          0%   { color: #38bdf8; }
          25%  { color: #818cf8; }
          50%  { color: #e879f9; }
          75%  { color: #818cf8; }
          100% { color: #38bdf8; }
        }
      `}</style>
      <AgentAvatar name="general-chat-assistant" label="AI" size="sm" />
      <div
        className="px-4 py-2.5 bg-background border-2 rounded-2xl rounded-bl-md"
        style={done ? { animation: "ga-rainbow-border 3s linear infinite" } : { borderColor: "#e5e7eb" }}
      >
        <div
          className="flex items-center gap-1.5 text-xs font-bold"
          style={done ? { animation: "ga-rainbow-text 3s linear infinite" } : { color: "#6b7280" }}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
            <path d="M10 21h4" />
            <path d="M9 17h6" />
          </svg>
          <span>
            {text.slice(0, charCount)}
            {!done && <span className="inline-block w-[1px] h-3 align-middle ml-px" style={{ backgroundColor: "currentColor" }} />}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GeneralChatPage() {
  const [conversations, setConversations] = useState<GeneralChatConversationDto[]>([]);
  const [archivedConversations, setArchivedConversations] = useState<GeneralChatConversationDto[]>([]);
  const [activeConversationId, setActiveConversationIdState] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [deepResearchMode, setDeepResearchMode] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [toolCalls, setToolCalls] = useState<Map<string, { id: string; toolName: string; isSkill: boolean }>>(new Map());
  const [liveTokensPerSecond, setLiveTokensPerSecond] = useState(0);
  // Real per-model context window + real usage — see GeneralChatContextIndicator's
  // own comment for why these replace a flat hardcoded estimate.
  const [contextLimit, setContextLimit] = useState(CONTEXT_LIMIT_FALLBACK);
  const [liveContextTokens, setLiveContextTokens] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachmentFile[]>([]);
  const [attachNoteOpen, setAttachNoteOpen] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  // MCP server status — mirrors chat-input.tsx's own MCP row/dialog.
  const [mcpServers, setMcpServers] = useState<Record<string, { command: string; args?: string[]; disabled?: boolean }>>({});
  const [mcpLiveStatus, setMcpLiveStatus] = useState<Record<string, "connected" | "connecting" | "failed" | "disabled">>({});
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [mcpActionLoading, setMcpActionLoading] = useState<string | null>(null);

  // Header bar — mirrors chat-layout.tsx's own header, minus Focus mode and
  // the activity pane toggle (General Chat has neither sub-agents nor an
  // activity pane to hide).
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // General Chat's own streaming preference dialog (gear icon in the header) —
  // independent of the global Settings → AI → Streaming.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const { percent: fontSizePercent, zoomIn, zoomOut, atMin: zoomAtMin, atMax: zoomAtMax } = useConvFontSize("conv-font-size-general-chat");

  const activeConversationIdRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Auto-resize reactively to inputValue (not just the textarea's own native
  // "input" event) — a programmatic clear (send, retry, /clear) sets inputValue
  // via React state, which never fires "input", so the element's imperatively-set
  // style.height would otherwise stay at its last expanded size after sending a
  // long multi-line message. Mirrors chat-input.tsx's adjustHeight/useEffect pattern.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [inputValue]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingTextRef = useRef("");
  // Id of the in-progress live "text" message part (Full Streaming / Hybrid,
  // which the backend treats as Full for General Chat — see orchestrator.ts).
  // Lets onPartUpdated apply only the matching part's content updates, since
  // that broadcast doesn't carry the part's type, only its id.
  const streamingTextPartIdRef = useRef<string | null>(null);
  // Text already finalized from an EARLIER part this same turn — a multi-step
  // turn (e.g. "let me check that" → tool call → final answer) gets a fresh
  // part per step, so without this, a new part starting would blank out
  // whatever the previous step already displayed instead of building on it.
  const streamingCommittedTextRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setActiveConversationId = useCallback((id: string | null) => {
    activeConversationIdRef.current = id;
    setActiveConversationIdState(id);
    // Lets CrossProjectApprovalToast (mounted globally in AppShell) suppress a
    // shell/plan request for the conversation already open here — General Chat
    // broadcasts those with this conversationId standing in for projectId.
    useChatStore.getState().setActiveGeneralChatConversationId(id);
  }, []);

  // Clear on unmount so navigating away doesn't leave a stale conversationId
  // suppressing a genuine future cross-conversation toast.
  useEffect(() => {
    return () => useChatStore.getState().setActiveGeneralChatConversationId(null);
  }, []);

  // ── Load conversation list ─────────────────────────────────────────────

  const reloadConversations = useCallback(async () => {
    const [active, archived] = await Promise.all([
      rpc.listGeneralChatConversations(),
      rpc.listArchivedGeneralChatConversations(),
    ]);
    setConversations(active);
    setArchivedConversations(archived);
    return active;
  }, []);

  useEffect(() => {
    reloadConversations().then(async (active) => {
      if (active.length > 0) {
        setActiveConversationId(active[0].id);
        setDeepResearchMode(active[0].deepResearchMode);
      } else {
        const created = await rpc.createGeneralChatConversation();
        setActiveConversationId(created.id);
        await reloadConversations();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load messages when the active conversation changes ────────────────

  useEffect(() => {
    if (!activeConversationId) return;
    setMessages([]);
    setStreamingText("");
    streamingTextRef.current = "";
    streamingTextPartIdRef.current = null;
    streamingCommittedTextRef.current = "";
    setToolCalls(new Map());
    setErrorText(null);
    setLiveTokensPerSecond(0);
    setLiveContextTokens(0);
    // Reset first, THEN let the getGeneralChatStatus lookup below re-derive the
    // real value — otherwise isSending carries over from whichever conversation
    // was active before, showing a stray "Thinking…"/Stop button on an already
    // idle conversation whenever you switch away while a turn is still running
    // elsewhere (that background turn's own onComplete/onError can't clear it —
    // both are gated on isActive(conversationId), so they no-op for a
    // conversation you've since navigated away from).
    setIsSending(false);
    // Same leak, no status-lookup equivalent to re-derive from (compaction has
    // no getGeneralChatStatus-style RPC) — handleCompact's own finally block
    // only clears this if you're still on the same conversation it started on,
    // so switching away mid-compaction left it stuck true forever, showing
    // "Compacting conversation…" on every conversation you visited after.
    // Accepts the same brief-staleness trade-off isSending already does if you
    // switch back before the real compaction finishes.
    setCompacting(false);
    // A draft (typed text, staged attachments) is tied to whatever
    // conversation you were composing it for — carrying it over would attach
    // it to a different conversation's message if you send after switching
    // (mirrors cross-project-issues.md §6's chat-input.tsx fix for
    // attachedFiles/mentionedFiles not being cleared on a conversation switch).
    setInputValue("");
    setAttachedFiles([]);
    setAttachError(null);
    // A pending "Confirm?" state visually belongs to whatever conversation's
    // Clear Chat button was clicked — don't let it silently carry over onto a
    // different conversation's Clear Chat button within the 3s window.
    setConfirmClear(false);
    rpc.getGeneralChatMessages(activeConversationId).then((rows) => {
      if (activeConversationIdRef.current !== activeConversationId) return;
      setMessages(rows.map((m) => ({ id: m.id, role: m.role, content: m.content, metadata: m.metadata, createdAt: m.createdAt })));
    });
    // Re-derive "still working" after a mount/refresh that missed the live
    // stream (backend keeps running regardless of what the page does) — only
    // ever turns isSending ON here, never off, so it can't race a send that
    // starts locally while this lookup is in flight. No historical tool-call
    // reconstruction by design — just the busy state + Stop button; the live
    // listeners below pick up seamlessly once the turn actually completes.
    rpc.getGeneralChatStatus(activeConversationId).then((status) => {
      if (activeConversationIdRef.current !== activeConversationId) return;
      if (status.isRunning) setIsSending(true);
    });
    const conv = [...conversations, ...archivedConversations].find((c) => c.id === activeConversationId);
    if (conv) setDeepResearchMode(conv.deepResearchMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);

  // ── Real context window for the active conversation's model ───────────
  // Mirrors context-indicator.tsx's own load-on-mount + "settings-changed"
  // refresh — ModelSelector's saveProjectSetting fires that event when the
  // user switches models, so the meter's denominator stays correct instead
  // of drifting once a differently-sized model is picked mid-conversation.

  useEffect(() => {
    if (!activeConversationId) return;
    const convId = activeConversationId;
    const load = () =>
      rpc
        .getGeneralChatContextLimit(convId)
        .then((res) => {
          if (activeConversationIdRef.current !== convId) return;
          setContextLimit(res.contextLimit);
        })
        .catch(() => {});
    load();
    window.addEventListener("agentdesk:settings-changed", load);
    return () => window.removeEventListener("agentdesk:settings-changed", load);
  }, [activeConversationId]);

  // ── Auto-scroll ─────────────────────────────────────────────────────────

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, toolCalls, errorText]);

  // ── Live event listeners (scoped to the active conversation) ──────────

  useEffect(() => {
    const isActive = (conversationId: string) => conversationId === activeConversationIdRef.current;

    const onPart = (e: Event) => {
      const { conversationId, part } = (e as CustomEvent).detail;
      if (!isActive(conversationId)) return;
      if (part.type === "tool_call") {
        setToolCalls((prev) => {
          const next = new Map(prev);
          next.set(part.id, { id: part.id, toolName: part.toolName ?? "", isSkill: part.toolName === "read_skill" || part.toolName === "find_skills" });
          return next;
        });
        return;
      }
      // "text" part — Full Streaming's live-updating part (agent-loop.ts's
      // pushLiveDelta), which the backend also uses for Hybrid mode here (see
      // orchestrator.ts). Created once with the first chunk, then patched via
      // onPartUpdated below as more arrives — no separate token-delta callback
      // fires for runInlineAgent-based callers like General Chat. A later step
      // in the same turn gets a brand-new part id — commit what's already
      // showing first so it isn't blanked out by the new part starting empty.
      if (part.type === "text") {
        if (streamingTextPartIdRef.current && streamingTextPartIdRef.current !== part.id) {
          streamingCommittedTextRef.current = streamingTextRef.current;
        }
        streamingTextPartIdRef.current = part.id;
        streamingTextRef.current = streamingCommittedTextRef.current + (part.content ?? "");
        setStreamingText(streamingTextRef.current);
      }
    };
    const onPartUpdated = (e: Event) => {
      const { conversationId, partId, updates } = (e as CustomEvent).detail;
      if (!isActive(conversationId) || partId !== streamingTextPartIdRef.current) return;
      if (typeof updates.content !== "string") return;
      streamingTextRef.current = streamingCommittedTextRef.current + updates.content;
      setStreamingText(streamingTextRef.current);
    };
    // Dead broadcast today — runInlineAgent (General Chat/Playground/sub-agent
    // path) never actually calls InlineAgentCallbacks.onTextDelta, only PM
    // chat's own separate streamText loop does. Kept wired (harmless no-op)
    // rather than removed, since fixing that is a separate, wider concern
    // beyond General Chat's streaming-mode compliance.
    const onTextDelta = (e: Event) => {
      const { conversationId, delta } = (e as CustomEvent).detail;
      if (!isActive(conversationId)) return;
      streamingTextRef.current += delta;
      setStreamingText(streamingTextRef.current);
    };
    const onComplete = (e: Event) => {
      const { conversationId, assistantText, userMessageId, assistantMessageId, modelId, status, promptTokens, contextLimit: turnContextLimit, durationMs } = (e as CustomEvent).detail;
      if (!isActive(conversationId)) return;
      if (typeof promptTokens === "number") setLiveContextTokens(promptTokens);
      if (typeof turnContextLimit === "number") setContextLimit(turnContextLimit);
      setMessages((prev) => {
        // Patch the optimistic user bubble (added with a client-generated id in
        // handleSend/sendToConversation) to the real, persisted DB id — delete/
        // fork/retry on that bubble need the actual row id, not a placeholder.
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === "user") {
            next[i] = { ...next[i], id: userMessageId };
            break;
          }
        }
        next.push({
          id: assistantMessageId,
          role: "assistant",
          content: assistantText,
          metadata: JSON.stringify({ modelId, status, durationMs }),
          createdAt: new Date().toISOString(),
        });
        return next;
      });
      setStreamingText("");
      streamingTextRef.current = "";
      streamingTextPartIdRef.current = null;
      streamingCommittedTextRef.current = "";
      setToolCalls(new Map());
      setIsSending(false);
    };
    const onError = (e: Event) => {
      const { conversationId, error } = (e as CustomEvent).detail;
      if (!isActive(conversationId)) return;
      setStreamingText("");
      streamingTextRef.current = "";
      streamingTextPartIdRef.current = null;
      streamingCommittedTextRef.current = "";
      setToolCalls(new Map());
      setIsSending(false);
      setErrorText(error);
    };

    const onCompacted = (e: Event) => {
      const { conversationId } = (e as CustomEvent).detail;
      if (!isActive(conversationId)) return;
      rpc.getGeneralChatMessages(conversationId).then((rows) => {
        if (activeConversationIdRef.current !== conversationId) return;
        setMessages(rows.map((m) => ({ id: m.id, role: m.role, content: m.content, metadata: m.metadata, createdAt: m.createdAt })));
      });
    };

    // Auto-title fires from the backend right as a turn starts (not gated on
    // this being the active conversation — a background conversation can title
    // itself too), so patch the sidebar/header title in place instead of a
    // full reloadConversations() round-trip.
    const onRenamed = (e: Event) => {
      const { conversationId, title } = (e as CustomEvent).detail;
      const patch = (list: GeneralChatConversationDto[]) =>
        list.map((c) => (c.id === conversationId ? { ...c, title } : c));
      setConversations(patch);
      setArchivedConversations(patch);
    };

    // Live tokens/sec readout — mirrors chat-event-handlers.ts's onStreamPerformance.
    const onStreamPerformance = (e: Event) => {
      const { conversationId, tokensPerSecond } = (e as CustomEvent).detail;
      if (!isActive(conversationId)) return;
      setLiveTokensPerSecond(tokensPerSecond);
    };

    // Live context-bar updates during a turn — real usage from the backend's
    // own step (InlineAgentCallbacks.onStepUsage), not a char/4 guess.
    const onContextUsage = (e: Event) => {
      const { conversationId, promptTokens, contextLimit: usageContextLimit } = (e as CustomEvent).detail;
      if (!isActive(conversationId)) return;
      setLiveContextTokens(promptTokens);
      setContextLimit(usageContextLimit);
    };

    window.addEventListener("agentdesk:general-chat-part", onPart);
    window.addEventListener("agentdesk:general-chat-part-updated", onPartUpdated);
    window.addEventListener("agentdesk:general-chat-text-delta", onTextDelta);
    window.addEventListener("agentdesk:general-chat-complete", onComplete);
    window.addEventListener("agentdesk:general-chat-run-error", onError);
    window.addEventListener("agentdesk:general-chat-compacted", onCompacted);
    window.addEventListener("agentdesk:general-chat-conversation-renamed", onRenamed);
    window.addEventListener("agentdesk:general-chat-stream-performance", onStreamPerformance);
    window.addEventListener("agentdesk:general-chat-context-usage", onContextUsage);
    return () => {
      window.removeEventListener("agentdesk:general-chat-part", onPart);
      window.removeEventListener("agentdesk:general-chat-part-updated", onPartUpdated);
      window.removeEventListener("agentdesk:general-chat-text-delta", onTextDelta);
      window.removeEventListener("agentdesk:general-chat-complete", onComplete);
      window.removeEventListener("agentdesk:general-chat-run-error", onError);
      window.removeEventListener("agentdesk:general-chat-compacted", onCompacted);
      window.removeEventListener("agentdesk:general-chat-conversation-renamed", onRenamed);
      window.removeEventListener("agentdesk:general-chat-stream-performance", onStreamPerformance);
      window.removeEventListener("agentdesk:general-chat-context-usage", onContextUsage);
    };
  }, []);

  // Auto-focus the input — mirrors chat-input.tsx's own effect exactly (same
  // requestAnimationFrame-deferred focus, needed so a brand-new window's
  // WebView2 keyboard routing has settled by the time focus() lands). Keyed on
  // activeConversationId too (not just isSending) since the textarea starts
  // disabled until the first conversation finishes loading — without it, this
  // effect's very first run fires while disabled and the call is a no-op.
  useEffect(() => {
    if (!isSending && activeConversationId) requestAnimationFrame(() => textareaRef.current?.focus());
  }, [isSending, activeConversationId]);

  // ── MCP server status (row above input + dialog) ───────────────────────

  const refreshMcpStatus = useCallback(() => {
    rpc.getMcpStatus().then(setMcpLiveStatus).catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([rpc.getMcpConfig(), rpc.getMcpStatus()]).then(([cfg, status]) => {
      setMcpServers(cfg.servers);
      setMcpLiveStatus(status);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!mcpDialogOpen) return;
    const id = setInterval(refreshMcpStatus, 5_000);
    return () => clearInterval(id);
  }, [mcpDialogOpen, refreshMcpStatus]);

  const handleMcpReconnect = useCallback(async (name: string) => {
    setMcpActionLoading(name);
    await rpc.reconnectMcpServer(name).catch(() => {});
    setTimeout(() => { refreshMcpStatus(); setMcpActionLoading(null); }, 2_000);
  }, [refreshMcpStatus]);

  const handleMcpDisconnect = useCallback(async (name: string) => {
    setMcpActionLoading(name);
    await rpc.disconnectMcpServer(name).catch(() => {});
    setTimeout(() => { refreshMcpStatus(); setMcpActionLoading(null); }, 500);
  }, [refreshMcpStatus]);

  const mcpConnectedCount = useMemo(
    () => Object.values(mcpLiveStatus).filter((s) => s === "connected").length,
    [mcpLiveStatus],
  );

  // ── Attachments (file/note) ─────────────────────────────────────────────

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    const newAttachments = await processFiles(files);
    if (newAttachments.length > 0) setAttachedFiles((prev) => [...prev, ...newAttachments]);
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAttachNote = useCallback((note: { id: string; title: string; contentMarkdown: string }) => {
    setAttachedFiles((prev) => [
      ...prev,
      { name: `${note.title || "Untitled note"}.md`, type: "text", content: note.contentMarkdown, size: note.contentMarkdown.length },
    ]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // ── Send ────────────────────────────────────────────────────────────────

  // Optimistically appends a user bubble and kicks off a turn — shared by
  // handleSend (fresh input, possibly with attachments already folded into
  // fullContent) and handleRetry (resending a prior user message verbatim).
  const sendToConversation = useCallback(async (conversationId: string, fullContent: string) => {
    // Guard both the optimistic append and the error-branch state below —
    // handleSend can reach this after an attachment-saving await loop, during
    // which the user may have already switched to a different conversation;
    // without this check the optimistic bubble/busy-state/error would land on
    // whatever conversation is now on screen instead of the one this message
    // actually belongs to (mirrors cross-project-issues.md §6's chat-layout.tsx
    // handleSend fix). The send itself still goes to the real `conversationId`
    // either way — this only guards local UI state.
    const isTargetActive = () => activeConversationIdRef.current === conversationId;
    if (isTargetActive()) {
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: fullContent, createdAt: new Date().toISOString() }]);
      setIsSending(true);
      setErrorText(null);
      streamingTextRef.current = "";
      streamingTextPartIdRef.current = null;
      streamingCommittedTextRef.current = "";
      setStreamingText("");
      setToolCalls(new Map());
      setLiveTokensPerSecond(0);
    }

    const result = await rpc.sendGeneralChatMessage(conversationId, fullContent);
    if (!result.ok) {
      if (isTargetActive()) {
        setIsSending(false);
        setErrorText(result.error ?? "Failed to send message");
      }
      return;
    }
    // Conversation now has content — refresh the sidebar order/title state.
    reloadConversations();
  }, [reloadConversations]);

  // Mirrors chat-layout.tsx's handleSend: attachments are saved to disk via
  // the same saveAttachment RPC (conversationId stands in for projectId —
  // safe, since saveAttachment only reads its projectId param in the
  // fallback branch when the global workspace path isn't configured), then
  // folded into an "implicit context" block prepended to the message text
  // the model sees. The user's own bubble shows a clean "Attached: [name]"
  // chip line instead (extractAttachmentChips strips the wrapper back out on
  // render — same mechanism message-bubble.tsx uses for project chat).

  const handleSend = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if ((!trimmed && attachedFiles.length === 0) || isSending || !activeConversationId) return;
    const conversationId = activeConversationId;
    const attachments = attachedFiles;

    setAttachedFiles([]);
    setInputValue("");
    setAttachError(null);

    let implicitContext = "";
    for (const att of attachments) {
      try {
        let base64: string;
        if (att.type === "text") {
          base64 = btoa(unescape(encodeURIComponent(att.content)));
        } else if (att.type === "image" && att.content.startsWith("data:")) {
          base64 = att.content.split(",")[1] ?? "";
        } else if (att.file) {
          base64 = await fileToBase64(att.file);
        } else {
          continue;
        }

        const saved = await rpc.saveAttachment(conversationId, att.name, base64, att.type);

        if (att.type === "text") {
          implicitContext += `\n<attached-file name="${saved.name}" path="${saved.path}">\n${att.content}\n</attached-file>\n`;
        } else if (att.type === "image") {
          implicitContext += `\n[Attached image: "${saved.name}" saved at "${saved.path}". Call read_image with this path to view it. If the current model cannot interpret the returned image, say so.]\n`;
        } else if (att.type === "audio") {
          implicitContext += `\n[Attached audio: "${saved.name}" saved at "${saved.path}". Call read_audio with this path to hear it. Only WAV and MP3 are supported — if the file is another format, say so. If the current model cannot interpret the returned audio, say so.]\n`;
        } else {
          implicitContext += `\n[Attached file: "${saved.name}" saved at "${saved.path}". This is a binary file (${att.name.split(".").pop()}). Use available tools or skills to read/extract content from this file before responding.]\n`;
        }
      } catch (err) {
        // Only surface this if still viewing the conversation the attachment
        // belongs to — a slow upload can outlast a conversation switch, and
        // the error is about conversationId's attachment, not whatever's now
        // on screen.
        if (activeConversationIdRef.current === conversationId) {
          setAttachError(`Failed to attach "${att.name}" — ${err instanceof Error ? err.message : "unknown error"}`);
          setTimeout(() => setAttachError(null), 4000);
        }
      }
    }

    const fullContent = implicitContext ? `${implicitContext}\n${trimmed}` : trimmed;
    if (!fullContent.trim()) return;

    // Stored (and shown) verbatim as `fullContent` — GeneralChatBubble strips
    // the implicit-context wrapper back into chip labels at render time, so
    // the optimistic bubble and a post-reload bubble render identically from
    // the same persisted string, with no separate "visible vs. full" split.
    await sendToConversation(conversationId, fullContent);
  }, [isSending, activeConversationId, attachedFiles, sendToConversation]);

  const handleStop = useCallback(() => {
    if (!activeConversationId) return;
    rpc.stopGeneralChatGeneration(activeConversationId).catch(() => {});
  }, [activeConversationId]);

  // ── Per-message actions (hover row) ────────────────────────────────────

  const handleDeleteMessage = useCallback(async (id: string) => {
    const conversationId = activeConversationIdRef.current;
    await rpc.deleteGeneralChatMessage(id);
    if (activeConversationIdRef.current === conversationId) {
      setMessages((prev) => prev.filter((m) => m.id !== id));
    }
  }, []);

  // Copies the conversation up to and including this message into a new
  // conversation and switches to it — same semantics as project chat's
  // "Fork from here" (chat-store.ts's branchConversation).
  const handleForkFromMessage = useCallback(async (messageId: string) => {
    if (!activeConversationId) return;
    const result = await rpc.forkGeneralChatConversation(activeConversationId, messageId);
    await reloadConversations();
    setActiveConversationId(result.id);
  }, [activeConversationId, reloadConversations, setActiveConversationId]);

  // Regenerates the reply for the last user message — mirrors chat-store.ts's
  // retryLastMessage. The backend deletes the trailing assistant row and re-runs
  // the turn against the EXISTING last user message; no new user row is created
  // (re-sending the text would silently duplicate the user's message each retry).
  const handleRetry = useCallback(async () => {
    if (!activeConversationId || isSending) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    const userMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!userMsg) return;
    const conversationId = activeConversationId;

    // Optimistically drop the old assistant bubble and enter the streaming state
    // (same prep sendToConversation does, minus the optimistic user bubble).
    if (activeConversationIdRef.current === conversationId) {
      setMessages((prev) => prev.filter((m) => m.id !== last.id));
      setIsSending(true);
      setErrorText(null);
      streamingTextRef.current = "";
      streamingTextPartIdRef.current = null;
      streamingCommittedTextRef.current = "";
      setStreamingText("");
      setToolCalls(new Map());
      setLiveTokensPerSecond(0);
    }

    const result = await rpc.retryGeneralChatMessage(conversationId);
    if (!result.ok) {
      if (activeConversationIdRef.current === conversationId) {
        setIsSending(false);
        setErrorText(result.error ?? "Failed to retry");
      }
      return;
    }
    reloadConversations();
  }, [activeConversationId, isSending, messages, reloadConversations]);

  // ── Conversation sidebar handlers ──────────────────────────────────────

  const handleCreateConversation = useCallback(async () => {
    const created = await rpc.createGeneralChatConversation();
    await reloadConversations();
    setActiveConversationId(created.id);
  }, [reloadConversations, setActiveConversationId]);

  // Lives in the main app navbar (far right, opposite the "General Chat"
  // title) rather than the sidebar — ConversationSidebar's own built-in
  // button is hidden for this page via hideCreateButton (below).
  useHeaderActions(
    () => (
      <button
        type="button"
        onClick={handleCreateConversation}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
      >
        <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="max-md:hidden">New conversation</span>
      </button>
    ),
    [handleCreateConversation],
  );

  const handleDeleteConversation = useCallback(async (id: string) => {
    await rpc.deleteGeneralChatConversation(id);
    const active = await reloadConversations();
    if (activeConversationIdRef.current === id) {
      setActiveConversationId(active[0]?.id ?? null);
    }
  }, [reloadConversations, setActiveConversationId]);

  const handleRenameConversation = useCallback(async (id: string, title: string) => {
    await rpc.renameGeneralChatConversation(id, title);
    await reloadConversations();
  }, [reloadConversations]);

  const handlePinConversation = useCallback(async (id: string, pinned: boolean) => {
    await rpc.pinGeneralChatConversation(id, pinned);
    await reloadConversations();
  }, [reloadConversations]);

  const handleArchiveConversation = useCallback(async (id: string) => {
    await rpc.archiveGeneralChatConversation(id, true);
    const active = await reloadConversations();
    if (activeConversationIdRef.current === id) setActiveConversationId(active[0]?.id ?? null);
  }, [reloadConversations, setActiveConversationId]);

  const handleRestoreConversation = useCallback(async (id: string) => {
    await rpc.archiveGeneralChatConversation(id, false);
    await reloadConversations();
  }, [reloadConversations]);

  // ── Header bar ──────────────────────────────────────────────────────────

  const handleSearchHighlight = useCallback((messageId: string | null) => {
    setHighlightedMessageId(messageId);
    if (messageId) {
      const el = document.getElementById(`msg-${messageId}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
    setHighlightedMessageId(null);
    setSearchQuery("");
  }, []);

  const handleExportMarkdown = useCallback(() => {
    if (!activeConversationId || messages.length === 0) return;
    const conv = conversations.find((c) => c.id === activeConversationId);
    const title = conv?.title ?? "Conversation";
    const lines = [`# ${title}\n`];
    for (const msg of messages) {
      if (!msg.content.trim()) continue;
      lines.push(`## ${msg.role === "user" ? "User" : "Assistant"} — ${new Date(msg.createdAt).toLocaleString()}\n`);
      lines.push(msg.content);
      lines.push("");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "conversation"}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast("success", "Chat exported as Markdown.");
  }, [activeConversationId, messages, conversations]);

  // ── Slash commands ──────────────────────────────────────────────────────

  const handleClear = useCallback(async () => {
    if (!activeConversationId) return;
    const conversationId = activeConversationId;
    await rpc.clearGeneralChatConversation(conversationId);
    if (activeConversationIdRef.current === conversationId) setMessages([]);
  }, [activeConversationId]);

  const handleClearChatClick = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    handleClear();
  }, [confirmClear, handleClear]);

  const handleFork = useCallback(async () => {
    if (!activeConversationId) return;
    const forked = await rpc.forkGeneralChatConversation(activeConversationId);
    await reloadConversations();
    setActiveConversationId(forked.id);
  }, [activeConversationId, reloadConversations, setActiveConversationId]);

  const handleCompact = useCallback(async () => {
    if (!activeConversationId || compacting) return;
    const conversationId = activeConversationId;
    setCompacting(true);
    setCompactError(null);
    try {
      const result = await rpc.compactGeneralChatConversation(conversationId);
      if (activeConversationIdRef.current !== conversationId) return;
      if (!result.success) {
        setCompactError(result.message ?? "Compaction failed");
        setTimeout(() => setCompactError(null), 3000);
        return;
      }
      const rows = await rpc.getGeneralChatMessages(conversationId);
      if (activeConversationIdRef.current !== conversationId) return;
      setMessages(rows.map((m) => ({ id: m.id, role: m.role, content: m.content, metadata: m.metadata, createdAt: m.createdAt })));
    } finally {
      if (activeConversationIdRef.current === conversationId) setCompacting(false);
    }
  }, [activeConversationId, compacting]);

  // ── Slash popover ───────────────────────────────────────────────────────

  const slashActive = inputValue.startsWith("/") && !inputValue.includes(" ");
  const slashQuery = slashActive ? inputValue.slice(1) : "";

  // /compact only shows once there's meaningful context to compact, mirroring
  // chat-input.tsx's visibleSlashCommands (hidden below 50% utilization there).
  const contextUtilization = useMemo(
    () => Math.min(((liveContextTokens > 0 ? liveContextTokens : estimateTokens(messages)) / contextLimit) * 100, 100),
    [messages, liveContextTokens, contextLimit],
  );
  const visibleSlashCommands = useMemo(
    () => GENERAL_CHAT_SLASH_COMMANDS.filter((c) => c.id !== "compact" || contextUtilization >= 50),
    [contextUtilization],
  );

  const runSlashCommand = useCallback((item: PopoverItem) => {
    setInputValue("");
    switch (item.id) {
      case "clear": handleClear(); break;
      case "compact": handleCompact(); break;
      case "fork": handleFork(); break;
      case "new": handleCreateConversation(); break;
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [handleClear, handleCompact, handleFork, handleCreateConversation]);

  const { popoverElement, handleKeyDown: popoverKeyDown } = useInputPopover({
    items: visibleSlashCommands,
    visible: slashActive,
    query: slashQuery,
    onSelect: runSlashCommand,
    onClose: () => setInputValue(""),
  });

  const voice = useVoiceInput(inputValue, setInputValue, () => requestAnimationFrame(() => textareaRef.current?.focus()));

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (popoverKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      voice.stop();
      handleSend(inputValue);
    }
  };

  // ModelSelector needs a Message[] for its optional inline ContextIndicator —
  // General Chat's flat DisplayMessage shape doesn't carry the fields that
  // type requires, so it's passed an empty array (indicator simply doesn't
  // render; model selection/thinking-level/shell-approval still work fully).
  const emptyMessages = useMemo<ChatStoreMessage[]>(() => [], []);

  const sidebarConversations: Conversation[] = conversations.map((c) => ({
    id: c.id, projectId: "", title: c.title, isPinned: c.isPinned, isArchived: c.isArchived,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  }));
  const sidebarArchived: Conversation[] = archivedConversations.map((c) => ({
    id: c.id, projectId: "", title: c.title, isPinned: c.isPinned, isArchived: c.isArchived,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  }));

  const isEmpty = messages.length === 0 && !streamingText && toolCalls.size === 0 && !isSending;

  return (
    <div className="flex h-full overflow-hidden bg-background">
      {/* Conversation sidebar — toggleable via the header bar's PanelLeft button. Wider than
          chat-layout.tsx's own w-[220px] since it has no per-project chrome competing for space. */}
      <div
        className={cn(
          "flex-shrink-0 border-r border-border overflow-hidden h-full",
          "transition-all duration-200 ease-in-out",
          sidebarOpen ? "w-[230px]" : "w-0",
        )}
        aria-hidden={!sidebarOpen}
      >
        <ConversationSidebar
          conversations={sidebarConversations}
          archivedConversations={sidebarArchived}
          activeConversationId={activeConversationId}
          onSelect={setActiveConversationId}
          onCreate={handleCreateConversation}
          hideCreateButton
          onDelete={handleDeleteConversation}
          onRename={handleRenameConversation}
          onPin={handlePinConversation}
          onArchive={handleArchiveConversation}
          onRestore={handleRestoreConversation}
        />
      </div>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header bar — mirrors chat-layout.tsx's, minus Focus mode and the activity pane toggle */}
        <div className="h-12 flex items-center px-2 sm:px-4 border-b border-border gap-1 sm:gap-2 shrink-0">
          <Tip content={sidebarOpen ? "Hide conversations" : "Show conversations"} side="bottom">
            <button
              type="button"
              onClick={() => setSidebarOpen((prev) => !prev)}
              aria-label={sidebarOpen ? "Hide conversations" : "Show conversations"}
              aria-pressed={sidebarOpen}
              className={cn(
                "inline-flex items-center justify-center rounded-md p-1.5",
                "text-muted-foreground hover:text-foreground hover:bg-muted",
                "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                sidebarOpen && "text-indigo-600 bg-indigo-50 hover:bg-indigo-100 hover:text-indigo-700",
              )}
            >
              <PanelLeft className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tip>

          <span
            className="font-medium text-foreground text-sm truncate cursor-pointer"
            title="Click to copy conversation ID"
            onClick={() => { if (activeConversationId) navigator.clipboard.writeText(activeConversationId); }}
          >
            {conversations.find((c) => c.id === activeConversationId)?.title ?? "Chat"}
          </span>

          <div className="flex-1 flex justify-center">
            {activeConversationId && messages.length > 0 && !isSending && (
              <Tip content={confirmClear ? "Click again to confirm" : "Clear chat messages"} side="bottom">
                <button
                  type="button"
                  onClick={handleClearChatClick}
                  className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors",
                    confirmClear ? "text-red-600 bg-red-50 hover:bg-red-100" : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  <Trash2 className="w-3 h-3" />
                  <span>{confirmClear ? "Confirm?" : "Clear Chat"}</span>
                </button>
              </Tip>
            )}
          </div>

          <div className="flex items-center gap-0.5">
            <Tip content="Decrease font size" side="bottom">
              <button
                type="button"
                onClick={zoomOut}
                disabled={zoomAtMin}
                aria-label="Decrease conversation font size"
                className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ZoomOut className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tip>
            <Tip content="Increase font size" side="bottom">
              <button
                type="button"
                onClick={zoomIn}
                disabled={zoomAtMax}
                aria-label="Increase conversation font size"
                className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ZoomIn className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tip>
          </div>

          <Tip content="Search messages" side="bottom">
            <button
              type="button"
              onClick={() => setSearchOpen((o) => !o)}
              aria-label="Search messages"
              className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tip>

          {activeConversationId && messages.length > 0 && (
            <Tip content="Export as markdown" side="bottom">
              <button
                type="button"
                onClick={handleExportMarkdown}
                aria-label="Export as markdown"
                className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tip>
          )}

          <Tip content="General Chat settings" side="bottom">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="General Chat settings"
              className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Settings className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tip>
        </div>

        {/* Search bar */}
        {searchOpen && (
          <MessageSearch
            messages={messages}
            onHighlight={handleSearchHighlight}
            onQueryChange={setSearchQuery}
            onClose={handleCloseSearch}
          />
        )}

        <div className="relative flex-1 overflow-hidden">
          <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-4 space-y-3">
            {isEmpty ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
                <p className="text-base font-medium text-foreground">Ask Assistant Anything</p>
                <p className="text-sm text-muted-foreground max-w-sm">
                  A general-purpose chat — ask questions, research, writing, or a quick task, answered directly here.
                </p>
              </div>
            ) : (
              <div style={fontSizePercent !== 100 ? { zoom: fontSizePercent / 100 } : undefined} className="space-y-3">
                {messages.map((m, i) => (
                  <div
                    key={m.id}
                    id={`msg-${m.id}`}
                    className={cn(
                      "rounded-lg transition-all duration-300",
                      highlightedMessageId === m.id && "ring-2 ring-indigo-400 ring-offset-2 bg-indigo-50/30",
                    )}
                  >
                  <GeneralChatBubble
                    message={m}
                    isLastMessage={i === messages.length - 1 && !isSending}
                    busy={isSending || compacting}
                    searchQuery={searchQuery}
                    onDelete={handleDeleteMessage}
                    onFork={handleForkFromMessage}
                    onRetry={handleRetry}
                  />
                  </div>
                ))}
                {isSending && !streamingText && <AssistantTypingRow />}
                {toolCalls.size > 0 && (
                  <div className="pl-8">
                    <ToolCallFeed toolCalls={[...toolCalls.values()]} />
                  </div>
                )}
                {streamingText && (
                  <GeneralChatBubble
                    message={{ id: "streaming", role: "assistant", content: streamingText, createdAt: new Date().toISOString() }}
                    isStreaming
                    onDelete={handleDeleteMessage}
                    onFork={handleForkFromMessage}
                    onRetry={handleRetry}
                  />
                )}
                {errorText && (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm bg-red-50 border border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-800 dark:text-red-400">
                      {errorText}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Streaming / compaction indicator — fixed at bottom, mirrors message-list.tsx */}
          {(isSending || compacting) && (
            <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center py-1.5 pointer-events-none">
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-background/90 border border-border shadow-sm backdrop-blur-sm">
                <Loader2 className="w-3 h-3 text-indigo-500 animate-spin shrink-0" />
                <span className="text-[11px] text-muted-foreground font-medium">{compacting ? "Compacting conversation…" : "Responding…"}</span>
              </div>
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="shrink-0 border-t border-border">
          <div className="px-4 pt-3 pb-1">
            {/* MCP status row */}
            {Object.keys(mcpServers).length > 0 && (
              <div className="flex items-center mb-1.5 px-1">
                <button
                  onClick={() => setMcpDialogOpen(true)}
                  className="inline-flex items-center gap-1 text-xs text-foreground/75 font-semibold hover:text-foreground transition-colors cursor-pointer"
                >
                  <Server className="w-3 h-3" />
                  {mcpConnectedCount}/{Object.keys(mcpServers).length} MCP server{Object.keys(mcpServers).length !== 1 ? "s" : ""}
                </button>
              </div>
            )}

            {/* MCP servers dialog */}
            <Dialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen}>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Server className="w-4 h-4" />
                    MCP Servers
                  </DialogTitle>
                </DialogHeader>
                <ul className="space-y-3 mt-1 min-w-0">
                  {Object.entries(mcpServers).map(([name, cfg]) => {
                    const status = mcpLiveStatus[name] ?? (cfg.disabled ? "disabled" : "failed");
                    const isLoading = mcpActionLoading === name;
                    const isConnected = status === "connected";
                    const isConnecting = status === "connecting";
                    return (
                      <li key={name} className="flex items-center gap-3">
                        <span className={cn(
                          "h-2 w-2 rounded-full shrink-0",
                          isConnected ? "bg-green-500" : isConnecting ? "bg-yellow-400 animate-pulse" : status === "failed" ? "bg-red-500" : "bg-muted-foreground/50",
                        )} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{name}</p>
                          <p className="text-xs text-muted-foreground truncate">{cfg.command} {(cfg.args ?? []).join(" ")}</p>
                        </div>
                        <span className={cn(
                          "text-xs shrink-0",
                          isConnected ? "text-green-600" : isConnecting ? "text-yellow-600" : status === "failed" ? "text-red-500" : "text-muted-foreground",
                        )}>
                          {isConnecting ? "connecting…" : status}
                        </span>
                        {isConnected ? (
                          <button
                            onClick={() => handleMcpDisconnect(name)}
                            disabled={isLoading}
                            className="shrink-0 flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted transition-colors disabled:opacity-50"
                          >
                            {isLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <WifiOff className="w-3 h-3" />}
                            Disconnect
                          </button>
                        ) : (
                          <button
                            onClick={() => handleMcpReconnect(name)}
                            disabled={isLoading || isConnecting || cfg.disabled}
                            className="shrink-0 flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted transition-colors disabled:opacity-50"
                          >
                            {isLoading || isConnecting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            Connect
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </DialogContent>
            </Dialog>

            {/* Compacting indicator */}
            {compacting && (
              <div className="flex items-center gap-2 mb-1.5 px-2 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="font-semibold">Compacting conversation...</span>
              </div>
            )}

            {/* Hidden file input */}
            <input ref={fileInputRef} type="file" multiple accept={ACCEPT_ALL} className="hidden" onChange={handleFileSelect} />

            {/* Attach a note dialog */}
            <AttachNoteModal open={attachNoteOpen} onOpenChange={setAttachNoteOpen} onAttach={handleAttachNote} />

            {/* Main input container — pill-shaped bordered row, matches project chat's ChatInput */}
            <div className="relative">
              {popoverElement}
              <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-1.5 transition-colors focus-within:ring-1 focus-within:ring-indigo-400 focus-within:border-indigo-400">
                <Tip content="Attach file" side="top">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isSending || !activeConversationId}
                    className="flex-shrink-0 p-1.5 text-muted-foreground/60 hover:text-muted-foreground rounded-lg hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Paperclip className="w-4 h-4" />
                  </button>
                </Tip>

                <Tip content="Attach a note" side="top">
                  <button
                    type="button"
                    onClick={() => setAttachNoteOpen(true)}
                    disabled={isSending || !activeConversationId}
                    className="flex-shrink-0 p-1.5 text-muted-foreground/60 hover:text-muted-foreground rounded-lg hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Library className="w-4 h-4" />
                  </button>
                </Tip>

                <PromptsDropdown
                  onSelect={(content) => setInputValue((prev) => prev + content)}
                  disabled={isSending || !activeConversationId}
                />

                {attachedFiles.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {attachedFiles.map((f, i) => (
                      <span key={i} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-indigo-50 border border-indigo-200 text-xs text-indigo-700 max-w-[200px] dark:bg-indigo-950/30 dark:border-indigo-800 dark:text-indigo-300">
                        {f.type === "image" && f.content ? (
                          <img src={f.content} alt={f.name} className="w-6 h-6 rounded object-cover shrink-0" />
                        ) : f.type === "audio" ? (
                          <Music className="w-3.5 h-3.5 shrink-0" />
                        ) : f.type === "binary" ? (
                          <FileTextIcon className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <Paperclip className="w-3 h-3 shrink-0" />
                        )}
                        <span className="truncate">{f.name}</span>
                        <button type="button" onClick={() => removeAttachment(i)} aria-label={`Remove ${f.name}`} className="shrink-0 hover:text-indigo-900">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                <textarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleTextareaKeyDown}
                  placeholder="Message Assistant… (Enter to send, Shift+Enter for new line, / for commands)"
                  rows={1}
                  disabled={isSending || !activeConversationId}
                  className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none min-h-[24px] max-h-[160px] py-0.5 disabled:opacity-50 min-w-[80px]"
                />

                {voice.supported && (
                  <VoiceInputButton
                    listening={voice.listening}
                    error={voice.error}
                    onClick={voice.toggle}
                    disabled={isSending || !activeConversationId}
                  />
                )}

                {isSending ? (
                  <Tip content="Stop generation" side="top">
                    <button
                      type="button"
                      onClick={handleStop}
                      aria-label="Stop generation"
                      className="flex-shrink-0 p-1.5 rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors"
                    >
                      <Square className="w-4 h-4" fill="currentColor" />
                    </button>
                  </Tip>
                ) : (
                  <Tip content="Send message" side="top">
                    <button
                      type="button"
                      onClick={() => { voice.stop(); handleSend(inputValue); }}
                      disabled={(!inputValue.trim() && attachedFiles.length === 0) || !activeConversationId}
                      aria-label="Send message"
                      className={cn(
                        "flex-shrink-0 p-1.5 rounded-full transition-colors",
                        (inputValue.trim() || attachedFiles.length > 0) && activeConversationId
                          ? "bg-indigo-600 text-white hover:bg-indigo-700"
                          : "bg-muted text-muted-foreground/60 cursor-not-allowed",
                      )}
                    >
                      <ArrowUp className="w-4 h-4" />
                    </button>
                  </Tip>
                )}
              </div>
            </div>

            {/* Attach error */}
            {attachError && (
              <div className="flex items-center gap-2 mx-1 mt-2 px-3 py-1.5 rounded-lg bg-red-50 border border-red-200">
                <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                <span className="text-xs text-red-700 flex-1">{attachError}</span>
                <button type="button" onClick={() => setAttachError(null)} className="shrink-0 p-0.5 text-red-400 hover:text-red-600 rounded">
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            {/* Compact error */}
            {compactError && (
              <div className="flex items-center gap-2 mx-1 mt-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200">
                <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span className="text-xs text-amber-700 flex-1">{compactError}</span>
                <button
                  type="button"
                  onClick={() => setCompactError(null)}
                  className="shrink-0 p-0.5 text-amber-400 hover:text-amber-600 rounded"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          {activeConversationId && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2 mb-1.5">
              <ModelSelector projectId={activeConversationId} messages={emptyMessages} hideBuildPlanToggle hideShellApproval compact globalThinkingKey="generalChatThinkingLevel" />
              <DeepResearchToggle conversationId={activeConversationId} enabled={deepResearchMode} onChange={setDeepResearchMode} />
              <div className="ml-auto">
                <GeneralChatContextIndicator
                  messages={messages}
                  tokensPerSecond={liveTokensPerSecond}
                  contextLimit={contextLimit}
                  liveContextTokens={liveContextTokens}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* General Chat streaming settings — opened via the header gear icon */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>General Chat Settings</DialogTitle>
          </DialogHeader>
          <GeneralChatStreamingSettings />
        </DialogContent>
      </Dialog>
    </div>
  );
}
