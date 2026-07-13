import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { rpc } from "@/lib/rpc";
import { Users, Send, Loader2, CheckCircle, Copy, Check, Download, BookmarkPlus } from "lucide-react";
import { useHeaderActions } from "@/lib/header-context";
import { toast } from "@/components/ui/toast";
import { MermaidDiagram } from "@/components/ui/mermaid-diagram";
import { CodeBlock } from "@/components/chat/code-block";
import { Tip } from "@/components/ui/tooltip";
import { SaveToCollectionModal } from "@/components/collections/save-to-collection-modal";
import { QuickAttachBar } from "@/components/dashboard/quick-attach-bar";
import { AttachFileTextButton } from "@/components/chat/attach-file-text-button";
import { useVoiceInput } from "@/lib/use-voice-input";
import { VoiceInputButton } from "@/components/chat/voice-input-button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionState = "idle" | "running" | "waiting-for-answer" | "done" | "error";
type AgentState = "idle" | "thinking" | "speaking" | "done";

interface AgentInfo {
  name: string;
  displayName: string;
  color: string;
}

interface Message {
  id: string;
  type:
    | "user-query"
    | "agent"
    | "final-answer"
    | "question"
    | "pm-thinking"
    | "round-divider"
    | "convergence-notice"
    | "session-error";
  agentName?: string;
  agentDisplayName?: string;
  agentColor?: string;
  content: string;
  streaming?: boolean;
  questionId?: string;
  round?: number;
  bordaScore?: number;
}

// ---------------------------------------------------------------------------
// Council event payload shapes
// ---------------------------------------------------------------------------

interface CouncilEvent {
  sessionId: string;
  type: string;
  query?: string;
  agents?: AgentInfo[];
  agentName?: string;
  token?: string;
  /** Authoritative final content for "agent-response-complete"/"final-answer-complete" —
   *  present so No Streaming mode (which never fires the token events) still
   *  has something to render instead of a permanently-empty message. */
  content?: string;
  turnsLeft?: number;
  questionId?: string;
  question?: string;
  message?: string;
  round?: number;
  scores?: Record<string, number>;
  converged?: boolean;
  summary?: string;
}

// ---------------------------------------------------------------------------
// Inline keyframe styles
// ---------------------------------------------------------------------------

const KEYFRAME_CSS = `
@keyframes council-breathe {
  from { opacity: 0.55; transform: scale(0.97); }
  to   { opacity: 1.0;  transform: scale(1.03); }
}
@keyframes council-dot-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
  40%           { transform: translateY(-4px); opacity: 1; }
}
@keyframes council-live-blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.3; }
}
`;


// ---------------------------------------------------------------------------
// Markdown components (shared, hoisted to avoid re-creation per render)
// ---------------------------------------------------------------------------

const MD_COMPONENTS = {
  code({ className, children, ref: _ref, ...props }: Record<string, unknown>) {
    const match = /language-(\w+)/.exec((className as string) ?? "");
    if (match?.[1] === "mermaid") {
      return (
        <MermaidDiagram
          code={String(children).trim()}
          fallbackClassName="text-[13px] font-mono whitespace-pre-wrap text-foreground/80 my-2"
        />
      );
    }
    const isInline = !match;
    if (isInline) {
      return (
        <code className="text-[13px] font-mono text-rose-600 bg-rose-50 dark:bg-rose-950/30 dark:text-rose-400 px-1 rounded" {...props}>
          {children as React.ReactNode}
        </code>
      );
    }
    return <CodeBlock language={match[1]} code={String(children).replace(/\n$/, "")} />;
  },
  p: ({ children }: { children: React.ReactNode }) => (
    <p className="mb-2 last:mb-0 text-[13.5px] text-foreground leading-relaxed">{children}</p>
  ),
  ul: ({ children }: { children: React.ReactNode }) => (
    <ul className="list-disc pl-4 mb-2 text-[13.5px] text-foreground">{children}</ul>
  ),
  ol: ({ children }: { children: React.ReactNode }) => (
    <ol className="list-decimal pl-4 mb-2 text-[13.5px] text-foreground">{children}</ol>
  ),
  li: ({ children }: { children: React.ReactNode }) => (
    <li className="mb-1 text-foreground">{children}</li>
  ),
  h1: ({ children }: { children: React.ReactNode }) => (
    <h1 className="text-xl font-semibold mb-2 mt-4 text-foreground">{children}</h1>
  ),
  h2: ({ children }: { children: React.ReactNode }) => (
    <h2 className="text-lg font-semibold mb-2 mt-3 text-foreground">{children}</h2>
  ),
  h3: ({ children }: { children: React.ReactNode }) => (
    <h3 className="text-base font-semibold mb-1 mt-3 text-foreground">{children}</h3>
  ),
  strong: ({ children }: { children: React.ReactNode }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="border-l-4 border-border pl-3 my-2 text-muted-foreground italic text-[13.5px]">
      {children}
    </blockquote>
  ),
  table: ({ children }: { children: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }: { children: React.ReactNode }) => (
    <thead className="bg-muted/50 border-b border-border">{children}</thead>
  ),
  th: ({ children }: { children: React.ReactNode }) => (
    <th className="px-3 py-1.5 text-left font-semibold text-foreground/80">{children}</th>
  ),
  td: ({ children }: { children: React.ReactNode }) => (
    <td className="px-3 py-1.5 text-foreground/80 border-t border-border">{children}</td>
  ),
};


// ---------------------------------------------------------------------------
// ThinkingDots
// ---------------------------------------------------------------------------

function ThinkingDots({ color }: { color: string }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: 7,
            height: 7,
            borderRadius: "50%",
            backgroundColor: color,
            animation: `council-dot-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// QuestionCard
// ---------------------------------------------------------------------------

function QuestionCard({
  message,
  onAnswer,
  disabled,
}: {
  message: Message;
  onAnswer: (questionId: string, answer: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");

  function handleSubmit() {
    if (!value.trim() || !message.questionId) return;
    onAnswer(message.questionId, value.trim());
    setValue("");
  }

  return (
    <div className="border border-amber-400 dark:border-amber-600 rounded-lg p-3 bg-amber-50 dark:bg-amber-950/20 mb-3">
      <div className="font-semibold text-amber-700 dark:text-amber-400 mb-2 text-[13px]">
        PM needs clarification
      </div>
      <div className="text-foreground mb-2.5 whitespace-pre-wrap text-sm">
        {message.content}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
          placeholder="Your answer..."
          disabled={disabled}
          className="flex-1 border border-border rounded-md px-2.5 py-1.5 text-[13px] outline-none bg-background text-foreground placeholder:text-muted-foreground disabled:bg-muted disabled:cursor-not-allowed"
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          className="bg-amber-500 hover:bg-amber-600 text-white rounded-md px-3.5 py-1.5 text-[13px] font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Answer
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({
  message,
  onAnswer,
  sessionState,
}: {
  message: Message;
  onAnswer: (questionId: string, answer: string) => void;
  sessionState: SessionState;
}) {
  const [copied, setCopied] = useState(false);
  const [saveToCollectionOpen, setSaveToCollectionOpen] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleDownload() {
    const blob = new Blob([message.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "council-decision.md";
    a.click();
    URL.revokeObjectURL(url);
    toast("success", "Decision downloaded as council-decision.md");
  }

  // Memoize markdown so it doesn't re-render on every parent state change
  const mdContent = useMemo(
    () =>
      message.content ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSanitize]}
          components={MD_COMPONENTS as never}
        >
          {message.content}
        </ReactMarkdown>
      ) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message.content, message.streaming],
  );

  // ── round divider ─────────────────────────────────────────────────────────
  if (message.type === "round-divider") {
    return (
      <div className="flex items-center gap-2 my-4">
        <div className="flex-1 h-px bg-orange-200 dark:bg-orange-900/50" />
        <span className="text-[11px] font-bold text-orange-600 dark:text-orange-400 uppercase tracking-widest">
          {message.content}
        </span>
        <div className="flex-1 h-px bg-orange-200 dark:bg-orange-900/50" />
      </div>
    );
  }

  // ── convergence notice ────────────────────────────────────────────────────
  if (message.type === "convergence-notice") {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-md text-xs text-green-700 dark:text-green-400 mb-3">
        <CheckCircle size={13} />
        {message.content}
      </div>
    );
  }

  // ── user query ────────────────────────────────────────────────────────────
  if (message.type === "user-query") {
    return (
      <div className="flex justify-end mb-4">
        <div className="bg-green-500 text-white rounded-[16px_16px_4px_16px] px-4 py-2.5 text-sm max-w-[80%] leading-relaxed shadow-sm">
          {message.content}
        </div>
      </div>
    );
  }

  // ── question card ─────────────────────────────────────────────────────────
  if (message.type === "question") {
    return (
      <QuestionCard
        message={message}
        onAnswer={onAnswer}
        disabled={sessionState !== "waiting-for-answer"}
      />
    );
  }

  // ── pm-thinking ───────────────────────────────────────────────────────────
  if (message.type === "pm-thinking") {
    return (
      <div
        className="flex items-center gap-2 text-muted-foreground text-[13px] py-2 mb-1"
      >
        <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
        <span>{message.content}</span>
      </div>
    );
  }

  // ── final answer ──────────────────────────────────────────────────────────
  if (message.type === "final-answer") {
    return (
      <div style={{ marginBottom: 12 }}>
        <div className="border-2 border-green-500 rounded-[10px] p-[14px_18px] bg-green-50 dark:bg-green-950/20">
          <div className="flex items-center gap-2 font-bold text-green-700 dark:text-green-400 text-sm mb-2.5">
            <Users size={15} />
            Council Decision
            {message.streaming && (
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor: "#22c55e",
                  display: "inline-block",
                  animation: "council-live-blink 1s ease-in-out infinite",
                  marginLeft: 4,
                }}
              />
            )}
          </div>
          <div className="text-sm text-foreground leading-relaxed">
            {mdContent}
            {message.streaming && !message.content && <ThinkingDots color="#22c55e" />}
          </div>
        </div>
        {!message.streaming && message.content && (
          <div className="flex items-center gap-1 mt-1 ml-1">
            <Tip content={copied ? "Copied!" : "Copy"} side="top">
              <button
                onClick={handleCopy}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label={copied ? "Copied" : "Copy decision"}
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </Tip>
            <Tip content="Download as Markdown" side="top">
              <button
                onClick={handleDownload}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Download decision as markdown"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            </Tip>
            <Tip content="Save to Collection" side="top">
              <button
                onClick={() => setSaveToCollectionOpen(true)}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Save to Collection"
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
              </button>
            </Tip>
          </div>
        )}
        <SaveToCollectionModal
          open={saveToCollectionOpen}
          onOpenChange={setSaveToCollectionOpen}
          contentMarkdown={message.content}
          sourceType="council"
        />
      </div>
    );
  }

  // ── session error ─────────────────────────────────────────────────────────
  if (message.type === "session-error") {
    return (
      <div className="flex items-start gap-2 px-3.5 py-2.5 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg text-[13px] text-red-600 dark:text-red-400 mb-3">
        <span style={{ fontWeight: 700, flexShrink: 0 }}>Council error:</span>
        <span style={{ wordBreak: "break-word" }}>{message.content}</span>
      </div>
    );
  }

  // ── agent message ─────────────────────────────────────────────────────────
  const color = message.agentColor ?? "#6b7280";
  return (
    <div
      style={{
        borderLeft: `3px solid ${color}`,
        paddingLeft: 12,
        marginBottom: 14,
      }}
    >
      {/* Agent header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <span style={{ fontWeight: 700, color, fontSize: 12 }}>
          {message.agentDisplayName ?? message.agentName}
        </span>
        {message.bordaScore !== undefined && (
          <span
            style={{
              fontSize: 10,
              color: "#fff",
              backgroundColor: color,
              borderRadius: 10,
              padding: "1px 6px",
              fontWeight: 700,
            }}
          >
            ★{message.bordaScore}
          </span>
        )}
        {message.streaming && (
          <>
            {message.content ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 10,
                  color: color,
                  fontWeight: 600,
                  opacity: 0.85,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: color,
                    display: "inline-block",
                    animation: "council-live-blink 0.9s ease-in-out infinite",
                  }}
                />
                live
              </span>
            ) : null}
          </>
        )}
      </div>

      {/* Content */}
      <div className="text-sm text-foreground leading-relaxed">
        {!message.content && message.streaming ? (
          <ThinkingDots color={color} />
        ) : (
          mdContent
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main CouncilPage
// ---------------------------------------------------------------------------

export function CouncilPage() {
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentStates, setAgentStates] = useState<Map<string, AgentState>>(new Map());
  const [bordaScores, setBordaScores] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const insertText = useCallback((text: string) => {
    setQuery((prev) => (prev ? `${prev}\n\n${text}` : text));
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  const voice = useVoiceInput(query, setQuery, () => requestAnimationFrame(() => inputRef.current?.focus()));
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Keep a ref to agents so event handler callbacks don't capture stale closure
  const agentsRef = useRef<AgentInfo[]>([]);
  useLayoutEffect(() => {
    agentsRef.current = agents;
  });

  // Auto-scroll feed to bottom
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages]);

  // Council event handler
  const handleCouncilEvent = useCallback((event: Event) => {
    const { detail } = event as CustomEvent<CouncilEvent>;
    if (!detail) return;

    const { type } = detail;

    switch (type) {
      case "session-started": {
        // Messages are already set by handleSend before startCouncil is called.
        // Just reset per-round state so the new session starts clean visually.
        setAgents([]);
        setAgentStates(new Map());
        setBordaScores({});
        break;
      }

      case "pm-status": {
        // Replace any existing pm-status message (don't accumulate)
        setMessages((prev) => {
          const withoutStatus = prev.filter((m) => m.id !== "pm-status");
          return [
            ...withoutStatus,
            {
              id: "pm-status",
              type: "pm-thinking" as const,
              content: detail.message ?? "",
            },
          ];
        });
        break;
      }

      case "agents-selected": {
        const incoming = detail.agents ?? [];
        setAgents(incoming);
        agentsRef.current = incoming;
        setAgentStates(new Map(incoming.map((a) => [a.name, "idle"])));
        break;
      }

      case "round-start": {
        const round = detail.round ?? 1;
        const label =
          round === 1 ? "Round 1 · Independent Positions" : "Round 2 · Revised Positions";
        setMessages((prev) => [
          ...prev,
          {
            id: `round-divider-${round}`,
            type: "round-divider" as const,
            content: label,
            round,
          },
        ]);
        break;
      }

      case "convergence": {
        setMessages((prev) => [
          ...prev,
          {
            id: "convergence-notice",
            type: "convergence-notice" as const,
            content: "Council converged after Round 1 — skipping Round 2",
          },
        ]);
        break;
      }

      case "borda-scores": {
        const scores = detail.scores ?? {};
        setBordaScores(scores);
        setMessages((prev) =>
          prev.map((m) =>
            m.type === "agent" && m.agentName && scores[m.agentName] !== undefined
              ? { ...m, bordaScore: scores[m.agentName] }
              : m,
          ),
        );
        break;
      }

      case "agent-thinking": {
        const name = detail.agentName ?? "";
        const round = detail.round;
        // Remove pm-status once actual agent content starts
        setMessages((prev) => prev.filter((m) => m.id !== "pm-status"));
        // If this agent isn't in the known list, add them with a fallback color
        setAgents((prev) => {
          if (prev.some((a) => a.name === name)) return prev;
          const fallback: AgentInfo = {
            name,
            displayName: name
              .split(/[-_]/)
              .map((w) => w[0].toUpperCase() + w.slice(1))
              .join(" "),
            color: "#9ca3af",
          };
          const updated = [...prev, fallback];
          agentsRef.current = updated;
          return updated;
        });
        setAgentStates((prev) => {
          const next = new Map(prev);
          next.set(name, "thinking");
          return next;
        });
        setMessages((prev) => {
          // Each round gets its own streaming message for the agent
          // Identify existing streaming message for this agent in the same round
          const existingIdx = prev.findIndex(
            (m) => m.agentName === name && m.streaming && m.round === round,
          );
          if (existingIdx >= 0) return prev;
          const agentInfo = agentsRef.current.find((a) => a.name === name);
          return [
            ...prev,
            {
              id: `${name}-r${round ?? 1}-${Date.now()}`,
              type: "agent" as const,
              agentName: name,
              agentDisplayName: agentInfo?.displayName ?? name,
              agentColor: agentInfo?.color,
              content: "",
              streaming: true,
              round,
            },
          ];
        });
        break;
      }

      case "agent-token": {
        const name = detail.agentName ?? "";
        const token = detail.token ?? "";
        const round = detail.round;
        setAgentStates((prev) => {
          const next = new Map(prev);
          next.set(name, "speaking");
          return next;
        });
        setMessages((prev) =>
          prev.map((m) =>
            m.agentName === name && m.streaming && m.round === round
              ? { ...m, content: m.content + token }
              : m,
          ),
        );
        break;
      }

      case "agent-response-complete": {
        const name = detail.agentName ?? "";
        const round = detail.round;
        setAgentStates((prev) => {
          const next = new Map(prev);
          next.set(name, "done");
          return next;
        });
        setMessages((prev) =>
          prev.map((m) =>
            m.agentName === name && m.streaming && m.round === round
              // No Streaming mode never fires "agent-token" — content stays
              // authoritative here rather than relying only on prior appends.
              ? { ...m, content: detail.content ?? m.content, streaming: false }
              : m,
          ),
        );
        break;
      }

      case "question": {
        setSessionState("waiting-for-answer");
        setMessages((prev) => [
          ...prev,
          {
            id: `question-${detail.questionId}`,
            type: "question" as const,
            content: detail.question ?? "",
            questionId: detail.questionId,
          },
        ]);
        break;
      }

      case "pm-synthesizing": {
        setMessages((prev) => [
          ...prev,
          {
            id: `pm-synth-${Date.now()}`,
            type: "pm-thinking" as const,
            content: "PM is synthesizing the council's final decision...",
          },
        ]);
        break;
      }

      case "final-answer-token": {
        const token = detail.token ?? "";
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const base = last?.type === "pm-thinking" ? prev.slice(0, -1) : prev;
          const existing = base.findIndex((m) => m.type === "final-answer" && m.streaming);
          if (existing >= 0) {
            return base.map((m, i) =>
              i === existing ? { ...m, content: m.content + token } : m,
            );
          }
          return [
            ...base,
            {
              id: `final-${Date.now()}`,
              type: "final-answer" as const,
              content: token,
              streaming: true,
            },
          ];
        });
        break;
      }

      case "final-answer-complete": {
        setMessages((prev) => {
          const withoutThinking = prev.filter((m) => m.type !== "pm-thinking");
          const hasFinal = withoutThinking.some((m) => m.type === "final-answer");
          // No Streaming mode never fires "final-answer-token" — the message
          // may not exist yet (it's normally created on the first token).
          if (!hasFinal) {
            return [
              ...withoutThinking,
              { id: `final-${Date.now()}`, type: "final-answer" as const, content: detail.content ?? "", streaming: false },
            ];
          }
          return withoutThinking.map((m) =>
            m.type === "final-answer" && m.streaming
              ? { ...m, content: detail.content ?? m.content, streaming: false }
              : m,
          );
        });
        break;
      }

      case "session-ended": {
        setSessionState("done");
        setMessages((prev) => prev.filter((m) => m.type !== "pm-thinking"));
        setAgentStates((prev) => {
          const next = new Map(prev);
          for (const key of next.keys()) next.set(key, "done");
          return next;
        });
        break;
      }

      case "error": {
        setSessionState("error");
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            type: "session-error" as const,
            content: detail.message ?? "Unknown error",
          },
        ]);
        break;
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener("agentdesk:council-event", handleCouncilEvent);
    return () => {
      window.removeEventListener("agentdesk:council-event", handleCouncilEvent);
    };
  }, [handleCouncilEvent]);

  // Stop session on unmount if still running
  useEffect(() => {
    return () => {
      if (sessionId) {
        rpc.stopCouncil(sessionId).catch(() => {});
      }
    };
  }, [sessionId]);

  async function handleSend() {
    const trimmed = query.trim();
    if (!trimmed || sessionState === "running") return;

    voice.stop();
    const isFollowUp = sessionState === "done";
    setQuery("");
    setSessionState("running");

    // Build prior context from existing messages for follow-up queries
    let context: string | undefined;
    if (isFollowUp) {
      const parts: string[] = [];
      let currentQ = "";
      for (const m of messages) {
        if (m.type === "user-query") currentQ = m.content;
        if (m.type === "final-answer" && m.content) {
          parts.push(`Q: ${currentQ}\n\nCouncil Decision:\n${m.content}`);
        }
      }
      if (parts.length > 0) context = parts.join("\n\n---\n\n");
    }

    if (isFollowUp) {
      // Append new query to existing feed — preserve history
      setMessages((prev) => [
        ...prev,
        { id: `user-query-${Date.now()}`, type: "user-query", content: trimmed },
      ]);
    } else {
      // Fresh start — clear feed
      setMessages([{ id: "user-query", type: "user-query", content: trimmed }]);
      setAgents([]);
      setAgentStates(new Map());
      setBordaScores({});
    }

    try {
      const result = (await rpc.startCouncil(trimmed, context)) as { sessionId: string };
      setSessionId(result.sessionId);
    } catch (err) {
      setSessionState("error");
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [
        ...prev,
        { id: "err-start", type: "session-error" as const, content: `Failed to start council: ${msg}` },
      ]);
    }
  }

  function handleAnswer(questionId: string, answer: string) {
    if (!sessionId) return;
    setSessionState("running");
    setMessages((prev) => prev.filter((m) => m.questionId !== questionId));
    rpc.answerCouncilQuestion(sessionId, questionId, answer).catch(() => {});
  }

  async function handleStop() {
    if (!sessionId) return;
    try {
      await rpc.stopCouncil(sessionId);
    } catch {
      // ignore
    }
    setSessionState("idle");
    setSessionId(null);
  }

  const isRunning = sessionState === "running";
  const isWaiting = sessionState === "waiting-for-answer";
  const inputDisabled = isRunning;
  const placeholder = isRunning
    ? "Council is in session..."
    : isWaiting
      ? "Answer the PM's question above..."
      : "Ask the council...";

  useHeaderActions(
    () => (isRunning || isWaiting) ? (
      <div className="flex items-center gap-2.5">
        {isRunning && (
          <span className="text-[11px] text-green-500 dark:text-green-400 font-medium flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 dark:bg-green-400 inline-block" style={{ animation: "council-live-blink 1s ease-in-out infinite" }} />
            In session
          </span>
        )}
        <button
          onClick={handleStop}
          className="text-xs text-red-500 border border-red-500 rounded-md px-2.5 py-0.5 font-medium cursor-pointer hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
        >
          Stop
        </button>
      </div>
    ) : null,
    [isRunning, isWaiting],
  );

  return (
    <>
      <style>{KEYFRAME_CSS}</style>
      <div className="flex flex-col h-full bg-background">
        {/* Body: main column (feed + input) + right sidebar */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* Main column */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Feed */}
          <div
            ref={feedRef}
            style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}
          >
          {messages.length === 0 && !isRunning && (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
              <Users size={40} color="#d1fae5" />
              <p style={{ fontSize: 14, textAlign: "center", maxWidth: 320 }}>
                Ask a technical question and the council of AI experts will discuss it and present a unified answer.
              </p>
            </div>
          )}

          {messages.map((message, idx) => {
            const prev = messages[idx - 1];
            const showSeparator =
              message.type === "agent" &&
              prev?.type === "agent" &&
              !prev.streaming;
            return (
              <div key={message.id}>
                {showSeparator && (
                  <div className="h-px bg-border my-3.5" />
                )}
                <MessageBubble
                  message={message}
                  onAnswer={handleAnswer}
                  sessionState={sessionState}
                />
              </div>
            );
          })}
          </div>{/* end feed */}

          {/* Input area */}
          <div className="border-t border-border bg-background shrink-0 p-3 flex gap-2">
          <div className="flex flex-1 items-center gap-0.5 rounded-lg border border-border bg-background pl-1 pr-2 py-1 transition-colors focus-within:border-green-500">
            <AttachFileTextButton onInsertText={insertText} disabled={inputDisabled} />
            <QuickAttachBar onInsertText={insertText} disabled={inputDisabled} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !inputDisabled) handleSend();
              }}
              placeholder={placeholder}
              disabled={inputDisabled}
              className="flex-1 min-w-0 bg-transparent px-1.5 py-1 text-sm outline-none text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed"
            />
            {voice.supported && (
              <VoiceInputButton listening={voice.listening} error={voice.error} onClick={voice.toggle} disabled={inputDisabled} />
            )}
          </div>
          <button
            onClick={handleSend}
            disabled={inputDisabled || !query.trim()}
            className="bg-green-500 hover:bg-green-600 text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? (
              <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              <Send size={16} />
            )}
            Send
          </button>
          </div>{/* end input area */}

          </div>{/* end main column */}

        {/* Right sidebar — avatar-only participants */}
        {agents.length > 0 && (
          <aside className="w-[140px] border-l border-border bg-background shrink-0 flex flex-col">
            {/* Header */}
            <div className="py-2.5 text-xs font-bold text-muted-foreground uppercase tracking-wide border-b border-border shrink-0 text-center flex items-center justify-center gap-1.5">
              Participants
              <span className="bg-muted text-muted-foreground rounded-full text-xs font-bold px-1.5 py-px normal-case tracking-normal">
                {agents.length}
              </span>
            </div>

            {/* Avatars vertically centered as a group */}
            <div style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              justifyContent: "center",
              gap: 32,
            }}>
              {(() => {
                const anyoneSpeaking = Array.from(agentStates.values()).some((s) => s === "speaking");
                return agents.map((agent) => {
                  const state = agentStates.get(agent.name) ?? "idle";
                  const score = bordaScores[agent.name];
                  const initials = agent.displayName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
                  const isSpeaking = state === "speaking";
                  const isThinking = state === "thinking";
                  const isDimmed = anyoneSpeaking && !isSpeaking;
                  const showBubble = isThinking || isSpeaking;

                  return (
                    // Full-width row — centers avatar+badge as a combined unit
                    <div key={agent.name} style={{ display: "flex", justifyContent: "center" }}>
                      <Tip content={agent.displayName} side="left">
                        {/* Flex row: avatar + optional badge in-flow so they center together */}
                        <div style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          opacity: isDimmed ? 0.35 : 1,
                          transition: "opacity 0.25s",
                          cursor: "default",
                        }}>
                          {/* Avatar circle */}
                          <div style={{
                            width: 48,
                            height: 48,
                            borderRadius: "50%",
                            backgroundColor: agent.color,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#fff",
                            fontWeight: 700,
                            fontSize: 15,
                            flexShrink: 0,
                            transition: "transform 0.25s ease, box-shadow 0.25s ease",
                            transform: isSpeaking ? "scale(1.12)" : "scale(1)",
                            boxShadow: isSpeaking
                              ? `0 0 10px 3px ${agent.color}66`
                              : state === "done" ? `0 0 4px 1px ${agent.color}44` : "none",
                            outline: isSpeaking ? `2px solid ${agent.color}` : "none",
                            outlineOffset: 2,
                            animation: isThinking ? "council-breathe 1.6s ease-in-out infinite alternate" : "none",
                          }}>
                            {initials}
                          </div>

                          {/* Typing bubble — in-flow to the right, tail points left */}
                          {showBubble && (
                            <div style={{
                              position: "relative",
                              backgroundColor: agent.color,
                              borderRadius: 999,
                              padding: "9px 12px",
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                            }}>
                              {/* Triangle tail pointing left toward the avatar */}
                              <div style={{
                                position: "absolute",
                                right: "100%",
                                top: "50%",
                                transform: "translateY(-50%)",
                                width: 0,
                                height: 0,
                                borderTop: "5px solid transparent",
                                borderBottom: "5px solid transparent",
                                borderRight: `6px solid ${agent.color}`,
                              }} />
                              {[0, 1, 2].map((i) => (
                                <span key={i} style={{
                                  display: "inline-block",
                                  width: 6,
                                  height: 6,
                                  borderRadius: "50%",
                                  backgroundColor: "#fff",
                                  animation: `council-dot-bounce 1.1s ease-in-out ${i * 0.18}s infinite`,
                                }} />
                              ))}
                            </div>
                          )}

                          {/* Score badge — in-flow to the right */}
                          {score !== undefined && !showBubble && (
                            <div style={{
                              backgroundColor: agent.color,
                              color: "#fff",
                              borderRadius: 10,
                              padding: "2px 7px",
                              fontSize: 10,
                              fontWeight: 700,
                              whiteSpace: "nowrap",
                            }}>
                              ★{score}
                            </div>
                          )}
                        </div>
                      </Tip>
                    </div>
                  );
                });
              })()}
            </div>
          </aside>
        )}

        </div>{/* end body: flex row */}

      </div>
    </>
  );
}
