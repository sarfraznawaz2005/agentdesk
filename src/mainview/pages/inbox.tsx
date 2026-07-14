import { useState, useEffect, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { relativeTime as formatTimestamp, parseDbDate } from "@/lib/date-utils";
import { useHeaderActions } from "@/lib/header-context";
import {
  ArrowLeft,
  Inbox,
  Mail,
  MailOpen,
  CheckCheck,
  MessageSquare,
  Settings2,
  Trash2,
  Search,
  Archive,
  ArchiveRestore,
  CheckSquare,
  Square,
  X,
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  Star,
  Download,
  BookmarkPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tip } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { InboxRulesEditor } from "@/components/inbox/inbox-rules-editor";
import { downloadMarkdown } from "@/lib/export-markdown";
import { SaveToCollectionModal } from "@/components/collections/save-to-collection-modal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InboxMessage {
  id: string;
  projectId: string | null;
  channelId: string | null;
  sender: string;
  content: string;
  isRead: number; // 0 = unread, 1 = read
  agentResponse: string | null;
  createdAt: string;
  threadId: string | null;
  priority: number;    // 0=normal, 1=high, 2=urgent
  category: string;    // "chat" | "work" | "status" | "reminder" | "other"
  platform: string;    // "chat" | "discord" | "whatsapp" | "email"
  isArchived: number;  // 0 = active, 1 = archived
  isFavorite: number;  // 0 = not favorited, 1 = favorited (independent of isArchived)
}

interface Project {
  id: string;
  name: string;
}

type ChannelFilter = "all" | "chat" | "discord" | "whatsapp" | "email";
type CategoryFilter = "all" | "work" | "chat" | "status" | "reminder" | "other";
type ReadFilter = "all" | "unread" | "read";
// The primary view selector. "favorites" is a cross-cutting view (like Gmail's
// Starred) — it shows favorited messages regardless of archive state, so it is
// NOT combined with isArchived the way "inbox"/"archived" are.
type ViewFilter = "inbox" | "favorites" | "archived";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getChannelSource(msg: InboxMessage): string {
  return msg.platform || (msg.channelId === "chat" ? "chat" : "unknown");
}

function getSourceBadgeStyle(source: string): string {
  switch (source) {
    case "chat": return "bg-blue-50 text-blue-700 border-blue-200";
    case "discord": return "bg-indigo-50 text-indigo-700 border-indigo-200";
    case "whatsapp": return "bg-green-50 text-green-700 border-green-200";
    case "email": return "bg-amber-50 text-amber-700 border-amber-200";
    case "scheduler": return "bg-purple-50 text-purple-700 border-purple-200";
    default: return "bg-muted/50 text-muted-foreground border-border";
  }
}

function getSourceLabel(source: string): string {
  switch (source) {
    case "chat": return "Chat";
    case "discord": return "Discord";
    case "whatsapp": return "WhatsApp";
    case "email": return "Email";
    case "scheduler": return "Scheduler";
    default: return source;
  }
}

// Markdown components for the agent-response preview (compact map, same idiom
// as notes-tab / freelance-chat-modal)
const MD_COMPONENTS = {
  code({ className, children, ref: _ref, ...props }: Record<string, unknown>) {
    const match = /language-(\w+)/.exec((className as string) ?? "");
    if (!match) {
      return (
        <code className="px-1 py-0.5 rounded text-[13px] font-mono bg-muted text-foreground" {...props}>
          {children as ReactNode}
        </code>
      );
    }
    return (
      <pre className="my-2 rounded-md bg-gray-900 text-gray-100 p-3 overflow-x-auto text-[13px] font-mono leading-relaxed">
        <code>{children as ReactNode}</code>
      </pre>
    );
  },
  p: ({ children }: { children: ReactNode }) => <p className="mb-2 last:mb-0 text-sm leading-relaxed">{children}</p>,
  ul: ({ children }: { children: ReactNode }) => <ul className="list-disc pl-4 mb-2 space-y-0.5 text-sm">{children}</ul>,
  ol: ({ children }: { children: ReactNode }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5 text-sm">{children}</ol>,
  li: ({ children }: { children: ReactNode }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }: { children: ReactNode }) => <h1 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
  h2: ({ children }: { children: ReactNode }) => <h2 className="text-sm font-bold mb-1.5 mt-3 first:mt-0">{children}</h2>,
  h3: ({ children }: { children: ReactNode }) => <h3 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{children}</h3>,
  strong: ({ children }: { children: ReactNode }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }: { children: ReactNode }) => (
    <blockquote className="border-l-2 border-border pl-3 italic mb-2 text-muted-foreground">{children}</blockquote>
  ),
  a: ({ href, children }: { href?: string; children: ReactNode }) => (
    <a
      href={href}
      className="text-primary hover:text-primary/80 underline cursor-pointer"
      onClick={(e) => { e.preventDefault(); if (href) rpc.openExternalUrl(href).catch(() => {}); }}
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children }: { children: ReactNode }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border">
      <table className="min-w-full text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }: { children: ReactNode }) => <thead className="bg-muted/50 border-b border-border">{children}</thead>,
  th: ({ children }: { children: ReactNode }) => <th className="px-3 py-1.5 text-left font-semibold">{children}</th>,
  td: ({ children }: { children: ReactNode }) => <td className="px-3 py-1.5 border-t border-border/50">{children}</td>,
};

// ---------------------------------------------------------------------------
// Message Row Skeleton
// ---------------------------------------------------------------------------

function MessageRowSkeleton() {
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-border last:border-0">
      <div className="mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-4 w-12 rounded-md" />
        </div>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
      <Skeleton className="h-3 w-12 mt-0.5 flex-shrink-0" />
    </div>
  );
}

/**
 * Collapsible original-prompt block — collapsed by default, toggled by the user.
 * Mirrors the PM-thinking collapse pattern used in the main project chat (see
 * `ThinkingBlock` in chat/message-parts.tsx): chevron toggle + italic content.
 */
function PromptBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors leading-none"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        Prompt
      </button>
      {expanded && (
        <p className="mt-2 text-sm italic leading-relaxed whitespace-pre-wrap break-words">
          {content}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message Detail Pane (right side of the master-detail split)
// ---------------------------------------------------------------------------

interface MessageDetailPaneProps {
  message: InboxMessage;
  threadMessages: InboxMessage[];
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onFavorite: (id: string) => void;
  onBack: () => void;
  projectName?: string;
  runningJobId?: string;
}

function MessageDetailPane({
  message,
  threadMessages,
  onDelete,
  onArchive,
  onFavorite,
  onBack,
  projectName,
  runningJobId,
}: MessageDetailPaneProps) {
  const source = getChannelSource(message);
  const senderLabel = message.sender || "Unknown";
  const hasThread = threadMessages.length > 1;
  const [responseCopied, setResponseCopied] = useState(false);
  const [saveToCollectionOpen, setSaveToCollectionOpen] = useState(false);
  const [stopping, setStopping] = useState(false);

  async function handleStop() {
    if (!runningJobId) return;
    setStopping(true);
    try {
      const result = (await rpc.stopCronJob({ id: runningJobId })) as { stopped: boolean };
      if (!result.stopped) toast("error", "Job was no longer running.");
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Failed to stop job.");
    } finally {
      setStopping(false);
    }
  }

  function handleExportResponse() {
    if (!message.agentResponse) return;
    const date = parseDbDate(message.createdAt).toISOString().slice(0, 10);
    downloadMarkdown(`${senderLabel} response ${date}`, message.agentResponse);
    toast("success", "Response exported as markdown.");
  }

  function handleCopyResponse() {
    if (!message.agentResponse) return;
    navigator.clipboard.writeText(message.agentResponse);
    setResponseCopied(true);
    setTimeout(() => setResponseCopied(false), 2000);
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header: sender + actions */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0 bg-background">
        {/* Back to the list (mobile single-pane) */}
        <button
          type="button"
          onClick={onBack}
          className="md:hidden shrink-0 -ml-1 p-1 text-muted-foreground hover:text-foreground rounded"
          aria-label="Back to message list"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <MessageSquare
          className={cn(
            "h-4 w-4 flex-shrink-0",
            source === "chat"
              ? "text-blue-500"
              : source === "discord"
                ? "text-indigo-500"
                : source === "whatsapp"
                  ? "text-green-500"
                  : source === "email"
                    ? "text-amber-500"
                    : "text-muted-foreground"
          )}
          aria-hidden="true"
        />
        <h2 className="text-base font-semibold text-foreground truncate">{senderLabel}</h2>
        {runningJobId && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 gap-1 text-xs text-destructive border-destructive/40 hover:bg-destructive/10 shrink-0"
            onClick={handleStop}
            disabled={stopping}
            aria-label="Stop scheduled job"
          >
            <Square className="h-3 w-3 fill-current" aria-hidden="true" />
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <Tip content={message.agentResponse ? (responseCopied ? "Copied!" : "Copy response") : "No agent response to copy"} side="top">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-foreground"
              onClick={handleCopyResponse}
              disabled={!message.agentResponse}
            >
              {responseCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </Tip>
          <Tip content={message.agentResponse ? "Save to Collection" : "No agent response to save"} side="top">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-foreground"
              onClick={() => setSaveToCollectionOpen(true)}
              disabled={!message.agentResponse}
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
            </Button>
          </Tip>
          <Tip content={message.agentResponse ? "Export response as markdown" : "No agent response to export"} side="top">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-foreground"
              onClick={handleExportResponse}
              disabled={!message.agentResponse}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </Tip>
          <Tip content={message.isFavorite ? "Remove from favorites" : "Add to favorites (hides from Inbox)"} side="top">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-foreground"
              onClick={() => onFavorite(message.id)}
            >
              <Star className={cn("h-3.5 w-3.5", message.isFavorite && "fill-amber-400 text-amber-500")} />
            </Button>
          </Tip>
          <Tip content={message.isArchived ? "Unarchive" : "Archive"} side="top">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-foreground"
              onClick={() => onArchive(message.id)}
            >
              {message.isArchived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
            </Button>
          </Tip>
          <Tip content="Delete" side="top">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(message.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </Tip>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Metadata badges */}
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
          <Badge
            variant="outline"
            className={cn("text-xs", getSourceBadgeStyle(source))}
          >
            {getSourceLabel(source)}
          </Badge>

          {message.priority > 0 && (
            <Badge
              variant="outline"
              className={cn(
                "text-xs",
                message.priority === 2
                  ? "bg-red-50 text-red-700 border-red-200"
                  : "bg-orange-50 text-orange-700 border-orange-200"
              )}
            >
              {message.priority === 2 ? "Urgent" : "High"}
            </Badge>
          )}

          {message.category && message.category !== "other" && (
            <Badge
              variant="outline"
              className="text-xs bg-muted/50 text-muted-foreground border-border capitalize"
            >
              {message.category}
            </Badge>
          )}

          {projectName && (
            <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">
              {projectName}
            </Badge>
          )}

          <span aria-label="Received at">
            {parseDbDate(message.createdAt).toLocaleString()}
          </span>
        </div>

        {/* Message content — collapsed by default, user can toggle to view */}
        <PromptBlock key={message.id} content={message.content} />

        {/* Agent response */}
        {message.agentResponse && (
          <>
            <Separator />
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Agent Response</p>
              <div className="text-sm leading-relaxed break-words bg-muted/50 rounded-md p-3">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeSanitize]}
                  components={MD_COMPONENTS as never}
                >
                  {message.agentResponse}
                </ReactMarkdown>
              </div>
            </div>
          </>
        )}

        {/* Thread messages */}
        {hasThread && (
          <>
            <Separator />
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Thread ({threadMessages.length} messages)
              </p>
              {threadMessages
                .filter((m) => m.id !== message.id)
                .map((m) => {
                  const mSender = m.sender || "Unknown";
                  return (
                    <div
                      key={m.id}
                      className="flex gap-2.5 pl-3 border-l-2 border-border"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="text-xs font-medium text-foreground">
                            {mSender}
                          </span>
                          <time
                            dateTime={m.createdAt}
                            className="text-[10px] text-muted-foreground"
                          >
                            {formatTimestamp(m.createdAt)}
                          </time>
                        </div>
                        <p className="text-sm text-muted-foreground leading-snug whitespace-pre-wrap break-words">
                          {m.content}
                        </p>
                      </div>
                    </div>
                  );
                })}
            </div>
          </>
        )}
      </div>

      <SaveToCollectionModal
        open={saveToCollectionOpen}
        onOpenChange={setSaveToCollectionOpen}
        contentMarkdown={message.agentResponse ?? ""}
        suggestedTitle={senderLabel}
        sourceType="inbox_message"
        sourceRef={{ projectName, taskId: message.threadId ?? message.id }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk Action Bar
// ---------------------------------------------------------------------------

interface BulkActionBarProps {
  selectedCount: number;
  totalFilteredCount: number;
  onMarkRead: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClearSelection: () => void;
  onSelectAllFiltered: () => void;
}

function BulkActionBar({
  selectedCount,
  totalFilteredCount,
  onMarkRead,
  onArchive,
  onDelete,
  onClearSelection,
  onSelectAllFiltered,
}: BulkActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="flex items-center gap-3 px-6 py-2 bg-indigo-50 border-b border-indigo-200 shrink-0">
      <span className="text-sm font-medium text-indigo-700">
        {selectedCount} selected
      </span>
      {selectedCount < totalFilteredCount && (
        <button
          type="button"
          onClick={onSelectAllFiltered}
          className="text-xs font-medium text-indigo-700 underline hover:no-underline"
        >
          Select all {totalFilteredCount} messages
        </button>
      )}
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onMarkRead}>
          <CheckCheck className="h-3 w-3 mr-1" /> Mark Read
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onArchive}>
          <Archive className="h-3 w-3 mr-1" /> Archive
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 className="h-3 w-3 mr-1" /> Delete
        </Button>
      </div>
      <Button variant="ghost" size="sm" className="h-7 text-xs ml-auto" onClick={onClearSelection}>
        <X className="h-3 w-3 mr-1" /> Clear
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inbox Page
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;

export function InboxPage() {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [markingAllRead, setMarkingAllRead] = useState(false);

  // Filters
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [viewFilter, setViewFilter] = useState<ViewFilter>("inbox");

  // Pagination
  const [page, setPage] = useState(1);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<InboxMessage[] | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Rules editor
  const [rulesOpen, setRulesOpen] = useState(false);

  // Detail pane selection (message shown in the right-side preview)
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Suppresses auto-select after the mobile back button clears the selection
  // (otherwise the effect would immediately re-select and hide the list again).
  const suppressAutoSelectRef = useRef(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Scheduler messages whose job is still running (manual or auto-fired) —
  // messageId -> jobId, drives the header Stop button.
  const [runningSchedulerJobs, setRunningSchedulerJobs] = useState<Map<string, string>>(new Map());

  // ---------------------------------------------------------------------------
  // Project name map
  // ---------------------------------------------------------------------------

  const projectMap = new Map(projects.map((p) => [p.id, p.name]));

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadUnreadCount = useCallback(async () => {
    try {
      const result = await rpc.getUnreadCount();
      setUnreadCount((result as { count: number }).count ?? 0);
    } catch {
      // non-critical — silently ignore
    }
  }, []);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const filters: { projectId?: string; isRead?: boolean; isArchived?: boolean; isFavorite?: boolean; limit?: number } = {};
      if (projectFilter !== "all") filters.projectId = projectFilter;
      if (readFilter === "unread") filters.isRead = false;
      if (readFilter === "read") filters.isRead = true;
      if (viewFilter === "favorites") {
        // Favorites spans both active and archived messages — leave isArchived unset.
        filters.isFavorite = true;
      } else {
        filters.isArchived = viewFilter === "archived";
      }

      const [msgResult, projectsResult] = await Promise.all([
        rpc.getInboxMessages(filters),
        rpc.getProjects(),
      ]);

      const rawMessages = msgResult as unknown as InboxMessage[];
      const rawProjects = projectsResult as unknown as Project[];

      setMessages(Array.isArray(rawMessages) ? rawMessages : []);
      setProjects(Array.isArray(rawProjects) ? rawProjects : []);
      await loadUnreadCount();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load inbox.";
      toast("error", message);
    } finally {
      setLoading(false);
    }
  }, [projectFilter, readFilter, viewFilter, loadUnreadCount]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Listen for real-time inbox updates
  useEffect(() => {
    const handler = () => {
      loadMessages();
      loadUnreadCount();
    };
    window.addEventListener("agentdesk:inbox-message-received", handler);
    return () => window.removeEventListener("agentdesk:inbox-message-received", handler);
  }, [loadMessages, loadUnreadCount]);

  // Live-patch a message's agentResponse as soon as an agent replies — this is
  // the only way a reply becomes visible without leaving the tab and coming
  // back, since replying never inserts a new inbox row (loadMessages alone
  // wouldn't pick it up on its own schedule).
  useEffect(() => {
    const handler = (e: Event) => {
      const { messageId, response } = (e as CustomEvent).detail as { messageId: string; response: string };
      const patch = (prev: InboxMessage[]) =>
        prev.map((m) => (m.id === messageId ? { ...m, agentResponse: response } : m));
      setMessages(patch);
      setSearchResults((prev) => (prev ? patch(prev) : prev));
    };
    window.addEventListener("agentdesk:inbox-response-updated", handler);
    return () => window.removeEventListener("agentdesk:inbox-response-updated", handler);
  }, []);

  // Seed + live-track scheduler jobs still running — covers messages from
  // auto-fired runs that started before this tab was opened.
  useEffect(() => {
    rpc.getRunningSchedulerMessages()
      .then((result) => {
        const entries = result as unknown as Array<{ messageId: string; jobId: string }>;
        setRunningSchedulerJobs(new Map(entries.map((e) => [e.messageId, e.jobId])));
      })
      .catch(() => {});

    const handler = (e: Event) => {
      const { messageId, jobId, running } = (e as CustomEvent).detail as { messageId: string; jobId: string; running: boolean };
      setRunningSchedulerJobs((prev) => {
        const next = new Map(prev);
        if (running) next.set(messageId, jobId);
        else next.delete(messageId);
        return next;
      });
    };
    window.addEventListener("agentdesk:scheduler-inbox-run-state", handler);
    return () => window.removeEventListener("agentdesk:scheduler-inbox-run-state", handler);
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }

    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const projectId = projectFilter !== "all" ? projectFilter : undefined;
        // Search must respect the same favorite-exclusivity as the list view —
        // otherwise a favorited message could surface in an Inbox/Archived
        // search and get bulk-deleted from there.
        const results = await rpc.searchInboxMessages(searchQuery.trim(), projectId, viewFilter === "favorites");
        setSearchResults(results as unknown as InboxMessage[]);
      } catch {
        // fall back to client-side filter
        setSearchResults(null);
      }
    }, 300);

    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [searchQuery, projectFilter, viewFilter]);

  // Reset to page 1 whenever any filter or search changes
  useEffect(() => {
    setPage(1);
  }, [projectFilter, channelFilter, categoryFilter, readFilter, viewFilter, searchQuery]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function handleMarkAsRead(msg: InboxMessage) {
    if (msg.isRead === 1) return;
    try {
      await rpc.markAsRead(msg.id);
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, isRead: 1 } : m))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
      window.dispatchEvent(new CustomEvent("agentdesk:inbox-unread-changed"));
    } catch {
      toast("error", "Failed to mark message as read.");
    }
  }

  function handleRowClick(msg: InboxMessage) {
    suppressAutoSelectRef.current = false;
    setSelectedId(msg.id);
  }

  async function handleDeleteMessage(id: string) {
    const wasUnread = messages.find((m) => m.id === id)?.isRead === 0;
    setMessages((prev) => prev.filter((m) => m.id !== id));
    if (wasUnread) setUnreadCount((c) => Math.max(0, c - 1));
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    try {
      await rpc.deleteInboxMessage(id);
    } catch {
      toast("error", "Failed to delete message.");
      loadMessages();
      loadUnreadCount();
    }
  }

  async function handleArchiveMessage(id: string) {
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;
    const isCurrentlyArchived = msg.isArchived === 1;
    if (viewFilter === "favorites") {
      // Favorites spans both archive states — flip the flag in place instead
      // of removing the message, since it should stay visible either way.
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, isArchived: isCurrentlyArchived ? 0 : 1 } : m)));
    } else {
      // Optimistic: remove from current view
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
    try {
      if (isCurrentlyArchived) {
        await rpc.unarchiveInboxMessage(id);
        toast("success", "Message restored.");
      } else {
        await rpc.archiveInboxMessage(id);
        toast("success", "Message archived.");
      }
    } catch {
      toast("error", "Failed to archive/restore message.");
      loadMessages();
    }
  }

  async function handleToggleFavorite(id: string) {
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;
    const wasFavorite = msg.isFavorite === 1;
    // Favoriting/unfavoriting always removes the message from whatever view
    // it's currently shown in: Inbox/Archived only ever show isFavorite=0
    // rows (favoriting pulls a message out of them, into Favorites-only, so
    // it can't be caught by a bulk action performed elsewhere), and
    // Favorites only ever shows isFavorite=1 rows (unfavoriting removes it).
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    try {
      if (wasFavorite) {
        await rpc.unfavoriteInboxMessage(id);
        toast("success", "Removed from favorites.");
      } else {
        await rpc.favoriteInboxMessage(id);
        toast("success", "Added to favorites — hidden from Inbox until unstarred.");
      }
      loadUnreadCount();
    } catch {
      toast("error", "Failed to update favorite.");
      loadMessages();
    }
  }

  async function handleMarkAllRead() {
    setMarkingAllRead(true);
    try {
      const projectId = projectFilter !== "all" ? projectFilter : undefined;
      await rpc.markAllAsRead(projectId);
      setMessages((prev) => prev.map((m) => ({ ...m, isRead: 1 })));
      setUnreadCount(0);
      window.dispatchEvent(new CustomEvent("agentdesk:inbox-unread-changed"));
      toast("success", "All messages marked as read.");
    } catch {
      toast("error", "Failed to mark all as read.");
    } finally {
      setMarkingAllRead(false);
    }
  }

  // Bulk actions
  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const pageIds = pagedMessages.map((m) => m.id);
    const allPageSelected = pageIds.every((id) => selectedIds.has(id));
    if (allPageSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        pageIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((prev) => new Set([...prev, ...pageIds]));
    }
  }

  // Selects every message matching the current filters, not just the visible
  // page — bypasses the PAGE_SIZE cap that otherwise limits bulk actions to 25
  // items at a time. displayMessages is computed later in this render but is
  // in scope by the time this closure actually runs (on click).
  function selectAllFiltered() {
    setSelectedIds(new Set(displayMessages.map((m) => m.id)));
  }

  async function handleBulkMarkRead() {
    const ids = Array.from(selectedIds);
    try {
      await rpc.bulkMarkAsReadInboxMessages(ids);
      setMessages((prev) => prev.map((m) => selectedIds.has(m.id) ? { ...m, isRead: 1 } : m));
      setSelectedIds(new Set());
      loadUnreadCount();
      window.dispatchEvent(new CustomEvent("agentdesk:inbox-unread-changed"));
      toast("success", `Marked ${ids.length} messages as read.`);
    } catch {
      toast("error", "Failed to mark messages as read.");
    }
  }

  async function handleBulkArchive() {
    const ids = Array.from(selectedIds);
    setMessages((prev) => prev.filter((m) => !selectedIds.has(m.id)));
    setSelectedIds(new Set());
    try {
      await rpc.bulkArchiveInboxMessages(ids);
      toast("success", `Archived ${ids.length} messages.`);
      loadUnreadCount();
    } catch {
      toast("error", "Failed to archive messages.");
      loadMessages();
    }
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    const unreadDeleted = messages.filter((m) => selectedIds.has(m.id) && m.isRead === 0).length;
    setMessages((prev) => prev.filter((m) => !selectedIds.has(m.id)));
    setSelectedIds(new Set());
    setUnreadCount((c) => Math.max(0, c - unreadDeleted));
    try {
      await rpc.bulkDeleteInboxMessages(ids);
      toast("success", `Deleted ${ids.length} messages.`);
    } catch {
      toast("error", "Failed to delete messages.");
      loadMessages();
      loadUnreadCount();
    }
  }

  // ---------------------------------------------------------------------------
  // Filtered view (channel + category filters are client-side)
  // ---------------------------------------------------------------------------

  const baseMessages = searchResults ?? messages;

  const filteredMessages = baseMessages.filter((m) => {
    const source = getChannelSource(m);
    if (channelFilter !== "all" && source !== channelFilter) return false;
    if (categoryFilter !== "all" && m.category !== categoryFilter) return false;
    return true;
  });

  // This is the final display list used for rendering and bulk operations
  const displayMessages = filteredMessages;

  // Pagination
  const totalPages = Math.max(1, Math.ceil(displayMessages.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pagedMessages = displayMessages.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  // Build thread groups from all filtered messages (not just current page, for thread detail)
  const threadGroups = new Map<string, InboxMessage[]>();
  for (const msg of displayMessages) {
    if (msg.threadId) {
      const existing = threadGroups.get(msg.threadId) || [];
      existing.push(msg);
      threadGroups.set(msg.threadId, existing);
    }
  }

  const visibleUnread = displayMessages.filter((m) => m.isRead === 0).length;

  // Message shown in the detail pane — derived from the filtered list so
  // deletes/archives/filter changes automatically clear the pane when the
  // message leaves the visible set.
  const selectedMessage = selectedId
    ? (displayMessages.find((m) => m.id === selectedId) ?? null)
    : null;

  // Auto-select the first message so the preview pane isn't empty (mirrors the
  // Docs tab). displayMessages is recomputed each render (not memoized), so the
  // guards below (not the deps) are what prevent redundant setState calls.
  useEffect(() => {
    if (loading || suppressAutoSelectRef.current) return;
    if (displayMessages.length === 0) return;
    if (!selectedId || !displayMessages.some((m) => m.id === selectedId)) {
      setSelectedId(displayMessages[0].id);
    }
  }, [loading, displayMessages, selectedId]);

  // Mark a message read the instant it's opened in the detail pane — whether
  // it got there via an explicit row click or auto-selection (first load,
  // filter change). Keyed on the id (not the object) so the isRead:1 patch
  // this triggers doesn't cause a second run.
  useEffect(() => {
    if (selectedMessage && selectedMessage.isRead === 0) {
      handleMarkAsRead(selectedMessage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMessage?.id]);

  const hasActiveFilter =
    channelFilter !== "all" ||
    categoryFilter !== "all" ||
    readFilter !== "all" ||
    projectFilter !== "all" ||
    searchQuery.trim() !== "";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const hasUnread = messages.some((m) => m.isRead === 0);

  useHeaderActions(
    () => (
      <>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRulesOpen(true)}
          className="flex items-center gap-1.5"
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          Rules
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleMarkAllRead}
          disabled={markingAllRead || loading || !hasUnread}
          className="flex items-center gap-1.5"
        >
          <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
          {markingAllRead ? "Marking..." : "Mark All Read"}
        </Button>
      </>
    ),
    [markingAllRead, loading, hasUnread],
  );

  return (
    <div className="flex h-full flex-col gap-0 min-h-0">
      {/* Sub-header: unread count + archive toggle */}
      <div className="flex items-center justify-between px-6 pt-4 pb-4 shrink-0">
        <div>
          {!loading && (
            <p className="text-sm text-muted-foreground">
              {unreadCount === 0
                ? "All caught up"
                : `${unreadCount} unread ${unreadCount === 1 ? "message" : "messages"}`}
            </p>
          )}
        </div>

        {/* View toggle: Inbox / Favorites / Archived */}
        <div className="flex items-center gap-1" role="group" aria-label="View filter">
          <Button
            variant={viewFilter === "inbox" ? "default" : "outline"}
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => setViewFilter("inbox")}
          >
            <Inbox className="h-3 w-3 mr-1" /> Inbox
          </Button>
          <Button
            variant={viewFilter === "favorites" ? "default" : "outline"}
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => setViewFilter("favorites")}
          >
            <Star className="h-3 w-3 mr-1" /> Favorites
          </Button>
          <Button
            variant={viewFilter === "archived" ? "default" : "outline"}
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => setViewFilter("archived")}
          >
            <Archive className="h-3 w-3 mr-1" /> Archived
          </Button>
        </div>
      </div>

      <Separator />

      {/* Filters bar */}
      <div className="flex flex-col gap-2 px-6 py-3 shrink-0 bg-background border-b border-border">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search input */}
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search messages..."
              className="w-full h-8 rounded-md border border-input bg-background pl-8 pr-8 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Project filter */}
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="w-44 h-8 text-sm">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Channel type filter */}
          <div className="flex items-center gap-1" role="group" aria-label="Filter by channel type">
            {(["all", "chat", "discord", "whatsapp", "email"] as ChannelFilter[]).map((f) => (
              <Button
                key={f}
                variant={channelFilter === f ? "default" : "outline"}
                size="sm"
                className="h-8 px-3 text-xs capitalize"
                onClick={() => setChannelFilter(f)}
              >
                {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
              </Button>
            ))}
          </div>

          {/* Read/Unread toggle */}
          <div className="flex items-center gap-1" role="group" aria-label="Filter by read status">
            {(["all", "unread", "read"] as ReadFilter[]).map((f) => (
              <Button
                key={f}
                variant={readFilter === f ? "default" : "outline"}
                size="sm"
                className="h-8 px-3 text-xs capitalize"
                onClick={() => setReadFilter(f)}
              >
                {f === "all" ? "All" : f === "unread" ? "Unread" : "Read"}
              </Button>
            ))}
          </div>

          {/* Live filter count + select all */}
          {!loading && (
            <div className="ml-auto flex items-center gap-2">
              <Tip content={pagedMessages.length > 0 && pagedMessages.every((m) => selectedIds.has(m.id)) ? "Deselect page" : "Select page"} side="bottom">
              <button
                type="button"
                onClick={toggleSelectAll}
                className="text-muted-foreground hover:text-foreground"
              >
                {pagedMessages.length > 0 && pagedMessages.every((m) => selectedIds.has(m.id)) ? (
                  <CheckSquare className="h-4 w-4" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
              </button>
              </Tip>
              <span className="text-xs text-muted-foreground">
                {displayMessages.length}{" "}
                {displayMessages.length === 1 ? "message" : "messages"}
                {visibleUnread > 0 && (
                  <span className="ml-1 text-indigo-600 font-medium">
                    ({visibleUnread} unread)
                  </span>
                )}
                {searchResults && (
                  <span className="ml-1 text-amber-600 font-medium">
                    (search results)
                  </span>
                )}
              </span>
            </div>
          )}
        </div>

        {/* Category filter */}
        <div className="flex items-center gap-1" role="group" aria-label="Filter by category">
          {(["all", "work", "chat", "status", "reminder", "other"] as CategoryFilter[]).map((f) => (
            <Button
              key={f}
              variant={categoryFilter === f ? "default" : "outline"}
              size="sm"
              className="h-8 px-3 text-xs capitalize"
              onClick={() => setCategoryFilter(f)}
            >
              {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            </Button>
          ))}
        </div>
      </div>

      {/* Bulk action bar */}
      <BulkActionBar
        selectedCount={selectedIds.size}
        totalFilteredCount={displayMessages.length}
        onMarkRead={handleBulkMarkRead}
        onArchive={handleBulkArchive}
        onDelete={handleBulkDelete}
        onClearSelection={() => setSelectedIds(new Set())}
        onSelectAllFiltered={selectAllFiltered}
      />

      {/* Master-detail split: message list (left) | detail pane (right) */}
      <div className="flex flex-1 min-h-0">
        {/* Left column — message list. Mobile: full-width single pane, hidden
            once a message is selected (the detail pane takes over). */}
        <div
          className={cn(
            "w-full md:w-[280px] lg:w-[320px] shrink-0 md:border-r border-border flex flex-col min-h-0",
            selectedMessage && "max-md:hidden",
          )}
        >
          <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div aria-busy="true" aria-label="Loading messages">
            {Array.from({ length: 8 }).map((_, i) => (
              <MessageRowSkeleton key={i} />
            ))}
          </div>
        ) : displayMessages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center h-full py-16">
            <EmptyState
              icon={
                readFilter === "unread" ? (
                  <Mail className="h-6 w-6" aria-hidden="true" />
                ) : viewFilter === "archived" ? (
                  <Archive className="h-6 w-6" aria-hidden="true" />
                ) : viewFilter === "favorites" ? (
                  <Star className="h-6 w-6" aria-hidden="true" />
                ) : (
                  <MailOpen className="h-6 w-6" aria-hidden="true" />
                )
              }
              title={
                searchResults
                  ? "No messages match your search"
                  : readFilter === "unread"
                    ? "No unread messages"
                    : viewFilter === "archived"
                      ? "No archived messages"
                      : viewFilter === "favorites"
                        ? "No favorites yet"
                        : hasActiveFilter
                          ? "No messages match your filters"
                          : "Your inbox is empty"
              }
              description={
                searchResults
                  ? "Try a different search term."
                  : viewFilter === "favorites"
                    ? "Star a message to pin it here — it's hidden from Inbox and Archived until you unstar it."
                    : hasActiveFilter
                      ? "Try adjusting your filters to see more messages."
                      : "Messages from Chat, Discord, WhatsApp, and Email channels will appear here."
              }
              action={
                hasActiveFilter && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setChannelFilter("all");
                      setCategoryFilter("all");
                      setReadFilter("all");
                      setProjectFilter("all");
                      setSearchQuery("");
                    }}
                  >
                    Clear filters
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <ul aria-label="Inbox messages">
            {pagedMessages.map((msg) => {
              const isUnread = msg.isRead === 0;
              const source = getChannelSource(msg);
              const senderLabel = msg.sender || "Unknown";
              const threadCount = msg.threadId
                ? (threadGroups.get(msg.threadId)?.length ?? 0)
                : 0;
              const pName = msg.projectId ? projectMap.get(msg.projectId) : undefined;
              const isSelected = selectedIds.has(msg.id);
              const isViewing = selectedId === msg.id;

              return (
                <li key={msg.id}>
                  <div
                    className={cn(
                      "w-full flex items-start gap-3 px-4 py-3",
                      "border-b border-border last:border-0",
                      "hover:bg-muted/50 transition-colors",
                      isSelected && "bg-indigo-50/50",
                      isViewing && "bg-indigo-50",
                      isUnread
                        ? "border-l-2 border-l-indigo-500 pl-[14px]"
                        : "border-l-2 border-l-transparent pl-[14px]"
                    )}
                  >
                    {/* Checkbox */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleSelect(msg.id); }}
                      className="mt-1 text-muted-foreground hover:text-foreground flex-shrink-0"
                    >
                      {isSelected ? (
                        <CheckSquare className="h-4 w-4 text-indigo-600" />
                      ) : (
                        <Square className="h-4 w-4" />
                      )}
                    </button>

                    {/* Favorite toggle */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleToggleFavorite(msg.id); }}
                      className="mt-1 text-muted-foreground hover:text-amber-500 flex-shrink-0"
                      aria-label={msg.isFavorite ? "Remove from favorites" : "Add to favorites"}
                    >
                      <Star className={cn("h-4 w-4", msg.isFavorite && "fill-amber-400 text-amber-500")} />
                    </button>

                    {/* Clickable message content area */}
                    <button
                      type="button"
                      onClick={() => handleRowClick(msg)}
                      className={cn(
                        "flex-1 min-w-0 text-left",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-inset rounded-sm",
                      )}
                      aria-label={`Message from ${senderLabel}${isUnread ? ", unread" : ""}${msg.priority === 2 ? ", urgent" : msg.priority === 1 ? ", high priority" : ""}`}
                    >
                      {/* Sender + badges row */}
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        {/* Unread dot */}
                        <span
                          className={cn(
                            "h-2 w-2 rounded-full flex-shrink-0 transition-colors",
                            isUnread ? "bg-indigo-500" : "bg-transparent"
                          )}
                          aria-hidden="true"
                        />

                        <span
                          className={cn(
                            "text-sm truncate",
                            isUnread
                              ? "font-semibold text-foreground"
                              : "font-medium text-foreground"
                          )}
                        >
                          {senderLabel}
                        </span>

                        {/* Platform badge */}
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] px-1.5 py-0 h-4 flex-shrink-0",
                            getSourceBadgeStyle(source)
                          )}
                        >
                          {getSourceLabel(source)}
                        </Badge>

                        {/* Priority badge */}
                        {msg.priority > 0 && (
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] px-1.5 py-0 h-4 flex-shrink-0",
                              msg.priority === 2
                                ? "bg-red-50 text-red-700 border-red-200"
                                : "bg-orange-50 text-orange-700 border-orange-200"
                            )}
                          >
                            {msg.priority === 2 ? "Urgent" : "High"}
                          </Badge>
                        )}

                        {/* Project name */}
                        {pName && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 h-4 flex-shrink-0 bg-purple-50 text-purple-700 border-purple-200"
                          >
                            {pName}
                          </Badge>
                        )}

                        {/* Agent responded indicator */}
                        {msg.agentResponse && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 h-4 flex-shrink-0 bg-emerald-50 text-emerald-700 border-emerald-200"
                          >
                            Replied
                          </Badge>
                        )}
                      </div>

                      {/* Content preview */}
                      <p className="text-sm text-muted-foreground truncate leading-snug">
                        {msg.content}
                      </p>
                    </button>

                    {/* Right side: timestamp + thread badge */}
                    <div className="flex flex-col items-end gap-1 flex-shrink-0 mt-0.5">
                      <time
                        dateTime={msg.createdAt}
                        className="text-xs text-muted-foreground whitespace-nowrap"
                      >
                        {formatTimestamp(msg.createdAt)}
                      </time>

                      {msg.threadId && threadCount > 1 && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 h-4 flex-shrink-0 bg-muted/50 text-muted-foreground border-border"
                        >
                          {threadCount} in thread
                        </Badge>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
          </div>

          {/* Pagination */}
          {!loading && totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 px-4 py-3 border-t border-border shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 text-xs"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={clampedPage === 1}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {clampedPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 text-xs"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={clampedPage === totalPages}
              >
                Next
              </Button>
            </div>
          )}
        </div>

        {/* Right pane — message detail preview */}
        <div
          className={cn(
            "flex-1 flex flex-col min-w-0 min-h-0",
            !selectedMessage && "max-md:hidden",
          )}
        >
          {selectedMessage ? (
            <MessageDetailPane
              key={selectedMessage.id}
              message={selectedMessage}
              threadMessages={
                selectedMessage.threadId
                  ? (threadGroups.get(selectedMessage.threadId) ?? [selectedMessage])
                  : [selectedMessage]
              }
              onDelete={handleDeleteMessage}
              onArchive={handleArchiveMessage}
              onFavorite={handleToggleFavorite}
              onBack={() => {
                suppressAutoSelectRef.current = true;
                setSelectedId(null);
              }}
              projectName={selectedMessage.projectId ? projectMap.get(selectedMessage.projectId) : undefined}
              runningJobId={runningSchedulerJobs.get(selectedMessage.id)}
            />
          ) : (
            !loading &&
            displayMessages.length > 0 && (
              <div className="flex flex-1 items-center justify-center">
                <EmptyState
                  icon={<MessageSquare className="h-6 w-6" aria-hidden="true" />}
                  title="Select a message"
                  description="Choose a message from the list to read it here."
                />
              </div>
            )
          )}
        </div>
      </div>

      {/* Inbox rules editor */}
      <InboxRulesEditor open={rulesOpen} onOpenChange={setRulesOpen} />
    </div>
  );
}
