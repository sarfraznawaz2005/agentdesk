import { useEffect, useRef, useState, useCallback, useMemo, useReducer, Component, type ReactNode } from "react";
import { ArrowDown, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageBubble, type Message } from "./message-bubble";
import { MessageActionsProvider } from "./message-actions-context";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { useChatStore } from "@/stores/chat-store";

// Error boundary that catches rendering errors in individual messages
// and shows a fallback instead of crashing the entire chat panel.
class MessageErrorBoundary extends Component<
  { children: ReactNode; messageId: string },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; messageId: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-red-500 bg-red-50 rounded-lg border border-red-200">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>Failed to render message</span>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Quick-start chips shown in the empty state
// ---------------------------------------------------------------------------

const QUICK_STARTS = [
  {
    label: "Explore the codebase",
    prompt:
      "Explore the project codebase and give me a high-level overview: the architecture, key components, main entry points, and tech stack. Flag anything that looks like it needs attention.",
  },
  {
    label: "Create plan for my approval",
    prompt:
      "Explore the codebase to understand the current state of the project, then ask me what I want to build or change. Once I describe the goal, create a detailed implementation plan broken into phases and tasks. Present the plan for my approval — do not start any work or create kanban tasks until I explicitly approve it.",
  },
  {
    label: "Run tests & check quality",
    prompt:
      "Run the full test suite and check for lint errors. Report the results clearly. If there are failures, investigate the root cause and suggest what needs to be fixed.",
  },
  {
    label: "Review recent changes",
    prompt:
      "Review the most recent code changes in this project. Check the git log and diff, assess code quality, spot any bugs or concerns, and suggest improvements.",
  },
] as const;

interface MessageListProps {
  projectId: string;
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  streamingMessageId: string | null;
  activeAgentCount?: number;
  highlightedMessageId?: string | null;
  searchQuery?: string;
  loading?: boolean;
  onSend?: (text: string) => void;
  fontSizePercent?: number;
}

export function MessageList({
  projectId,
  messages,
  isStreaming,
  streamingContent,
  streamingMessageId,
  activeAgentCount = 0,
  highlightedMessageId,
  searchQuery,
  loading = false,
  onSend,
  fontSizePercent = 100,
}: MessageListProps) {
  const isCompacting = useChatStore((s) => s.isCompacting);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const isAtBottomRef = useRef(true);

  // Bumped on stream-complete so relative timestamps re-render
  const [, bumpRenderEpoch] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const handler = () => bumpRenderEpoch();
    window.addEventListener("agentdesk:stream-complete", handler);
    return () => window.removeEventListener("agentdesk:stream-complete", handler);
  }, []);

  // Memoize visible messages — avoids re-filtering + JSON.parse on every render
  const visibleMessages = useMemo(
    () => messages.filter((msg) => {
      if (!msg.content.trim()) return false;
      try {
        const meta = msg.metadata ? JSON.parse(msg.metadata) : null;
        if (meta?.type === "sub_agent_result") return false;
        if (meta?.type === "agent_report") return false;
      } catch { /* ignore parse errors */ }
      return true;
    }).sort((a, b) => {
      // Order by the DB insertion-order key (seq/rowid) when both messages are
      // persisted. The backend repositions a PM message's rowid to just after the
      // sub-agents it spawned, so seq order places it BELOW them (latest at the
      // bottom) on reload. Live/optimistic messages have no seq yet; treat them as
      // newest (sorted last) and break ties by createdAt — which onStreamComplete
      // finalizes to the PM's finish time, keeping the same below-the-agents order live.
      const sa = a.seq ?? Number.MAX_SAFE_INTEGER;
      const sb = b.seq ?? Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    }),
    [messages],
  );

  // ID of the last assistant/agent message — used to show retry button only there
  const lastAssistantMessageId = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const m = visibleMessages[i];
      if (m.role === "assistant" || m.role === "agent") return m.id;
    }
    return null;
  }, [visibleMessages]);

  // Build streaming/waiting state
  const agentRunning = activeAgentCount > 0;
  // PM no longer waits for agents — it ends its stream and restarts when agent completes
  const showWaitingRow = false;
  const showTypingDots = isStreaming && !streamingContent && !agentRunning;
  const streamingMessage: Message | null =
    isStreaming && streamingContent && !agentRunning
      ? {
          id: streamingMessageId ?? "streaming",
          conversationId: "",
          role: "assistant",
          agentId: null,
          agentName: null,
          content: streamingContent,
          metadata: null,
          tokenCount: 0,
          hasParts: 0,
          createdAt: new Date().toISOString(),
        }
      : null;

  // Guard: ignore handleScroll events triggered by programmatic scrolls
  const programmingScrollRef = useRef(false);
  // Set to true after the initial load scroll completes so it only fires once per mount
  const initialScrollDoneRef = useRef(false);

  const doScrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    programmingScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => { programmingScrollRef.current = false; }));
  }, []);

  // Auto-scroll to bottom when new messages arrive or streaming grows
  const itemCount = visibleMessages.length + (streamingMessage ? 1 : 0) + (showTypingDots ? 1 : 0) + (showWaitingRow ? 1 : 0);
  useEffect(() => {
    if (isAtBottomRef.current && itemCount > 0) {
      doScrollToBottom();
    }
  }, [itemCount, streamingContent, doScrollToBottom]);

  // After initial message load completes, force-scroll to bottom and do one
  // delayed retry so that progressively-rendered content (syntax highlighting,
  // Mermaid diagrams, images that affect layout) doesn't leave us mid-page.
  // Only fires once per MessageList instance (keyed by conversationId).
  useEffect(() => {
    if (loading || visibleMessages.length === 0 || initialScrollDoneRef.current) return;
    initialScrollDoneRef.current = true;
    isAtBottomRef.current = true;
    doScrollToBottom();
    const t = setTimeout(() => {
      isAtBottomRef.current = true;
      doScrollToBottom();
    }, 300);
    return () => clearTimeout(t);
  }, [loading, visibleMessages.length, doScrollToBottom]);

  // Auto-scroll when content changes after initial render:
  // - childList: catches code-block syntax highlighting, tool card expansion,
  //   Mermaid diagram injection (all insert/replace DOM nodes)
  // - characterData: catches streaming text token updates
  // - load (capture): catches <img> and other media finishing load
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let rafId = 0;

    const scrollIfAtBottom = () => {
      if (!isAtBottomRef.current) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (!isAtBottomRef.current) return;
        programmingScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => requestAnimationFrame(() => { programmingScrollRef.current = false; }));
      });
    };

    const mo = new MutationObserver(scrollIfAtBottom);
    mo.observe(el, { subtree: true, childList: true, characterData: true });

    // Image / media load events bubble differently — use capture to intercept
    // them before they reach the element (load doesn't bubble natively)
    el.addEventListener("load", scrollIfAtBottom, { capture: true, passive: true });

    return () => {
      mo.disconnect();
      cancelAnimationFrame(rafId);
      el.removeEventListener("load", scrollIfAtBottom, { capture: true });
    };
  }, []);

  // Track whether the user has scrolled away from the bottom
  const handleScroll = useCallback(() => {
    if (programmingScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    isAtBottomRef.current = atBottom;
    setShowScrollButton(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    doScrollToBottom();
    isAtBottomRef.current = true;
    setShowScrollButton(false);
  }, [doScrollToBottom]);

  return (
    <MessageActionsProvider>
      <div className="relative h-full">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto relative"
          style={{ overflowAnchor: "auto" }}
          role="log"
          aria-live="polite"
          aria-label="Conversation messages"
        >
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                <span className="text-sm text-muted-foreground font-medium">Loading conversation…</span>
              </div>
            </div>
          )}

          {visibleMessages.length === 0 && !isStreaming && !loading && onSend && (
            <div className="flex flex-col items-center justify-center h-full gap-6 px-6 py-12">
              <div className="text-center">
                <p className="text-base font-medium text-foreground">What would you like to do?</p>
                <p className="text-sm text-muted-foreground mt-1">Pick a quick start or type a message below</p>
              </div>
              <div className="grid grid-cols-2 gap-2 w-full max-w-lg">
                {QUICK_STARTS.map((qs) => (
                  <button
                    key={qs.label}
                    type="button"
                    onClick={() => onSend(qs.prompt)}
                    className="text-left px-3 py-2.5 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {qs.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={fontSizePercent !== 100 ? { zoom: fontSizePercent / 100 } : undefined}>
          {visibleMessages.map((msg) => (
            <div
              key={msg.id}
              className="px-4 py-2 overflow-hidden"
            >
              <div
                id={`msg-${msg.id}`}
                className={cn(
                  "rounded-lg transition-all duration-300",
                  highlightedMessageId === msg.id && "ring-2 ring-indigo-400 ring-offset-2 bg-indigo-50/30",
                )}
              >
                <MessageErrorBoundary messageId={msg.id}>
                  <MessageBubble
                    message={msg}
                    projectId={projectId}
                    allMessages={visibleMessages}
                    searchQuery={searchQuery}
                    isLastMessage={msg.id === lastAssistantMessageId}
                  />
                </MessageErrorBoundary>
              </div>
            </div>
          ))}

          {streamingMessage && (
            <div className="px-4 py-2 overflow-hidden">
              <StreamingBubble message={streamingMessage} />
            </div>
          )}

          {showTypingDots && (
            <div className="px-4 py-2 overflow-hidden">
              <TypingRow />
            </div>
          )}

          {showWaitingRow && (
            <div className="px-4 py-2 overflow-hidden">
              <WaitingRow />
            </div>
          )}

          {/* Scroll anchor — browser keeps this in view when content above changes */}
          <div style={{ overflowAnchor: "auto", height: 1 }} />
          </div>{/* end zoom wrapper */}
        </div>

        {/* Streaming / compaction indicator — fixed at bottom */}
        {(isStreaming || isCompacting) && (
          <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center py-1.5 pointer-events-none">
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-background/90 border border-border shadow-sm backdrop-blur-sm">
              <Loader2 className="w-3 h-3 text-indigo-500 animate-spin shrink-0" />
              <span className="text-[11px] text-muted-foreground font-medium">{isCompacting ? "Compacting conversation…" : "Responding…"}</span>
            </div>
          </div>
        )}

        {/* Floating scroll-to-bottom button */}
        {showScrollButton && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 bg-background shadow-md rounded-full border border-border text-xs text-muted-foreground hover:bg-muted/50 transition-colors z-10"
            aria-label="Scroll to bottom"
          >
            <ArrowDown className="w-3 h-3" aria-hidden="true" />
            Scroll to bottom
          </button>
        )}
      </div>
    </MessageActionsProvider>
  );
}

// ---------------------------------------------------------------------------
// Streaming bubble — subscribes to pmThinkingText and passes it as a prop
// ---------------------------------------------------------------------------

function StreamingBubble({ message }: { message: Message }) {
  const pmThinkingText = useChatStore((s) => s.pmThinkingText);
  return <MessageBubble message={message} isStreaming thinkingContent={pmThinkingText || undefined} />;
}

// ---------------------------------------------------------------------------
// Typing dots — shown before the first text token arrives
// ---------------------------------------------------------------------------

export function TypingRow() {
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
        @keyframes rainbow-border {
          0%   { border-color: #38bdf8; }
          25%  { border-color: #818cf8; }
          50%  { border-color: #e879f9; }
          75%  { border-color: #818cf8; }
          100% { border-color: #38bdf8; }
        }
        @keyframes rainbow-text {
          0%   { color: #38bdf8; }
          25%  { color: #818cf8; }
          50%  { color: #e879f9; }
          75%  { color: #818cf8; }
          100% { color: #38bdf8; }
        }
      `}</style>
      <AgentAvatar name="project-manager" size="sm" />
      <div
        className="px-4 py-2.5 bg-background border-2 rounded-2xl rounded-bl-md"
        style={done ? { animation: "rainbow-border 3s linear infinite" } : { borderColor: "#e5e7eb" }}
      >
        <div
          className="flex items-center gap-1.5 text-xs font-bold"
          style={done ? { animation: "rainbow-text 3s linear infinite" } : { color: "#6b7280" }}
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

/** Compact "PM waiting for agent" indicator — types once then pulsates. */
function WaitingRow() {
  const text = "Waiting for agent...";
  const [charCount, setCharCount] = useState(0);
  const done = charCount >= text.length;

  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setCharCount((c) => Math.min(c + 1, text.length)), 60);
    return () => clearInterval(id);
  }, [done]);

  return (
    <div className="flex items-center gap-2 py-1">
      <AgentAvatar name="project-manager" size="sm" />
      <div className={cn("px-3 py-1.5 text-xs text-indigo-600 font-bold", done && "animate-pulse")}>
        {text.slice(0, charCount)}
        {!done && <span className="inline-block w-[1px] h-3 bg-indigo-500 align-middle ml-px animate-pulse" />}
      </div>
    </div>
  );
}
