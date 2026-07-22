import { useState, useEffect, useCallback, useMemo } from "react";
import { BarChart2, RefreshCw, Info, FileText, Trash2 } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { LineChart, BarChart, DonutChart, ActivityHeatmap, StatCard } from "@/components/analytics/charts";
import { formatCompact } from "@/components/analytics/format";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type ProjectStats = Awaited<ReturnType<typeof rpc.getProjectStats>>;
type TelemetryUsage = Awaited<ReturnType<typeof rpc.getTelemetryUsage>>;
type ProviderHealth = Awaited<ReturnType<typeof rpc.getProviderHealth>>;

type SubTab = "dashboard" | "usage" | "providers" | "prompts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// ── Project Dashboard Tab ─────────────────────────────────────────────────────

function DashboardTab({ projects }: { projects: Array<{ id: string; name: string }> }) {
  const [projectId, setProjectId] = useState("all");
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setStats(await rpc.getProjectStats(projectId, days)); }
    catch { /* empty */ } finally { setLoading(false); }
  }, [projectId, days]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Loading />;
  if (!stats) return <NoData />;

  const totalDone = stats.byStatus.find((s) => s.status === "done")?.count ?? 0;
  const totalTasks = stats.byStatus.reduce((s, r) => s + r.count, 0);

  // Merge created/completed series onto the same dates
  const allDays = Array.from(
    new Set([...stats.createdPerDay.map((d) => d.day), ...stats.completedPerDay.map((d) => d.day)])
  ).sort();
  const createdMap = new Map(stats.createdPerDay.map((d) => [d.day, d.count]));
  const doneMap = new Map(stats.completedPerDay.map((d) => [d.day, d.count]));
  const createdSeries = allDays.map((day) => ({ label: day, value: createdMap.get(day) ?? 0 }));
  const doneSeries = allDays.map((day) => ({ label: day, value: doneMap.get(day) ?? 0 }));

  return (
    <div className="space-y-6">
      {/* Period selector + project filter */}
      <div className="flex items-center gap-2">
        {[7, 14, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`text-xs px-2 py-1 rounded border ${days === d ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted"}`}
          >
            {d}d
          </button>
        ))}
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="ml-auto text-xs px-2 py-1 rounded border bg-background"
        >
          <option value="all">All Projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button onClick={load} disabled={loading} className="p-1.5 rounded hover:bg-muted">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total tasks" value={totalTasks} />
        <StatCard label="Completed" value={totalDone} accent="text-green-500" />
        <StatCard label="Avg completion" value={fmtHours(stats.avgCompletionHours)} sub="per task" />
        <StatCard label="Completion rate" value={`${totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0}%`} />
      </div>

      {/* Tasks over time */}
      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Tasks over time</h3>
        <div className="border rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-indigo-500 inline-block" /> Created</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-green-500 inline-block" /> Completed</span>
          </div>
          <LineChart data={createdSeries} color="#6366f1" height={100} showDots={false} />
          <LineChart data={doneSeries} color="#10b981" height={100} showDots={false} />
        </div>
      </section>

      {/* Status + Priority */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">By status</h3>
          <div className="border rounded-lg p-3">
            <DonutChart
              data={stats.byStatus.map((s) => ({
                label: s.status,
                value: s.count,
                color: s.status === "done" ? "#10b981" : s.status === "working" ? "#6366f1" : "#94a3b8",
              }))}
              size={110}
            />
          </div>
        </section>
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">By priority</h3>
          <div className="border rounded-lg p-3">
            <DonutChart
              data={stats.byPriority.map((s) => ({
                label: s.priority,
                value: s.count,
                color: s.priority === "critical" ? "#ef4444" : s.priority === "high" ? "#f59e0b" : s.priority === "medium" ? "#6366f1" : "#94a3b8",
              }))}
              size={110}
            />
          </div>
        </section>
      </div>

      {/* Activity heatmap */}
      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Agent activity heatmap</h3>
        <div className="border rounded-lg p-3">
          <ActivityHeatmap data={stats.activityHeatmap} />
        </div>
      </section>
    </div>
  );
}

// ── Prompts Tab (raw per-call prompt inspection — complements AI Usage's
// aggregate telemetry with the exact system prompt + messages actually sent
// for one specific call) ──────────────────────────────────────────────────

type LogEntry = {
  timestamp: string;
  agent: string;
  model: string;
  totalTokens: number;
  systemTokens: number;
  messagesTokens: number;
};

type LogEntryFull = LogEntry & {
  systemPrompt: string;
  messages: string;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

// -- Token bar chart --

function TokenBarChart({
  entries,
  onBarClick,
}: {
  entries: LogEntry[];
  onBarClick: (entry: LogEntry) => void;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const chronological = useMemo(() => [...entries].reverse(), [entries]);
  const maxTokens = useMemo(
    () => Math.max(...chronological.map((e) => e.totalTokens), 1),
    [chronological],
  );

  const chartWidth = 600;
  const chartHeight = 140;
  const topPadding = 20;
  const bottomPadding = 4;
  const barAreaHeight = chartHeight - topPadding - bottomPadding;
  const barCount = chronological.length;
  const gap = Math.max(1, Math.min(3, Math.floor(chartWidth / barCount / 6)));
  const barWidth = Math.max(3, (chartWidth - gap * (barCount + 1)) / barCount);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
      >
        {[0.25, 0.5, 0.75, 1].map((frac) => {
          const y = topPadding + barAreaHeight * (1 - frac);
          return (
            <g key={frac}>
              <line x1={0} x2={chartWidth} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.07} strokeDasharray="4 4" />
              <text x={chartWidth - 2} y={y - 2} textAnchor="end" className="fill-muted-foreground" fontSize={8} opacity={0.5}>
                {formatTokens(Math.round(maxTokens * frac))}
              </text>
            </g>
          );
        })}
        {chronological.map((entry, i) => {
          const x = gap + i * (barWidth + gap);
          const systemH = (entry.systemTokens / maxTokens) * barAreaHeight;
          const messagesH = (entry.messagesTokens / maxTokens) * barAreaHeight;
          const totalH = systemH + messagesH;
          const y = topPadding + barAreaHeight - totalH;
          const isHovered = hoveredIdx === i;
          const color = agentColor(entry.agent);
          return (
            <g
              key={`${entry.timestamp}-${i}`}
              className="cursor-pointer"
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              onClick={() => onBarClick(entry)}
            >
              <rect x={x} y={y + systemH} width={barWidth} height={Math.max(0, messagesH)} rx={barWidth > 6 ? 1.5 : 0.5} fill={color} opacity={isHovered ? 0.5 : 0.3} />
              <rect x={x} y={y} width={barWidth} height={Math.max(0, systemH)} rx={barWidth > 6 ? 1.5 : 0.5} fill={color} opacity={isHovered ? 1 : 0.75} />
              <rect x={x} y={topPadding} width={barWidth} height={barAreaHeight} fill="transparent" />
            </g>
          );
        })}
      </svg>
      {hoveredIdx !== null && chronological[hoveredIdx] && (
        <div
          className="absolute z-10 pointer-events-none rounded-md border border-border bg-popover px-2.5 py-1.5 shadow-md text-xs"
          style={{
            left: `${Math.min(85, Math.max(5, ((hoveredIdx + 0.5) / barCount) * 100))}%`,
            top: 0,
            transform: "translateX(-50%)",
          }}
        >
          <div className="font-medium" style={{ color: agentColor(chronological[hoveredIdx].agent) }}>
            {chronological[hoveredIdx].agent}
          </div>
          <div className="text-muted-foreground">
            {formatTokens(chronological[hoveredIdx].totalTokens)} tokens
            <span className="mx-1">&middot;</span>
            {formatTime(chronological[hoveredIdx].timestamp)}
          </div>
          <div className="text-muted-foreground/70 text-[10px] mt-0.5">Click to view prompt</div>
        </div>
      )}
    </div>
  );
}

// -- Conversation view (parses the raw JSON messages array into role-colored
// cards instead of a flat JSON dump) --

type MessageContentPart = { type: string; [key: string]: unknown };
interface ParsedMessage { role: string; content: string | MessageContentPart[]; }

const ROLE_STYLES: Record<string, { label: string; badge: string; container: string }> = {
  user: { label: "User", badge: "bg-indigo-600 text-white", container: "border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/50 dark:bg-indigo-950/20" },
  assistant: { label: "Assistant", badge: "bg-emerald-600 text-white", container: "border-border bg-background" },
  tool: { label: "Tool", badge: "bg-amber-500 text-white", container: "border-amber-200 dark:border-amber-700/50 bg-amber-50/40 dark:bg-amber-950/20" },
  instructions: { label: "System", badge: "bg-gray-500 text-white", container: "border-border bg-muted/30" },
};

function roleStyle(role: string) {
  return ROLE_STYLES[role] ?? { label: role, badge: "bg-gray-400 text-white", container: "border-border bg-muted/20" };
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function MessagePartView({ part }: { part: MessageContentPart }) {
  switch (part.type) {
    case "text":
      return <p className="whitespace-pre-wrap break-words">{String(part.text ?? "")}</p>;
    case "reasoning":
      return <div className="italic text-muted-foreground whitespace-pre-wrap break-words">{String(part.text ?? stringifyValue(part))}</div>;
    case "tool-call":
      return (
        <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11px]">
          <div className="font-semibold text-foreground/80 mb-1">🔧 {String(part.toolName ?? "tool")}</div>
          <pre className="whitespace-pre-wrap break-words">{stringifyValue(part.input ?? part.args)}</pre>
        </div>
      );
    case "tool-result":
      return (
        <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11px]">
          <div className="font-semibold text-foreground/80 mb-1">↩ {String(part.toolName ?? "result")}</div>
          <pre className="whitespace-pre-wrap break-words">{stringifyValue(part.output ?? part.result)}</pre>
        </div>
      );
    default:
      return <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">{stringifyValue(part)}</pre>;
  }
}

function ConversationView({ raw }: { raw: string }) {
  let parsed: ParsedMessage[] | null = null;
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) parsed = data as ParsedMessage[];
  } catch { /* fall back to raw below */ }

  if (!parsed) {
    return (
      <pre className="text-xs font-mono whitespace-pre-wrap break-words p-3 bg-muted/30 rounded-md select-all leading-relaxed">
        {raw}
      </pre>
    );
  }

  return (
    <div className="space-y-3 p-3">
      {parsed.map((msg, i) => {
        const style = roleStyle(msg.role);
        return (
          <div key={i} className={`rounded-lg border p-3 ${style.container}`}>
            <span className={`inline-block text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded mb-2 ${style.badge}`}>
              {style.label}
            </span>
            <div className="text-xs leading-relaxed space-y-2">
              {typeof msg.content === "string" ? (
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
              ) : Array.isArray(msg.content) ? (
                msg.content.map((part, j) => <MessagePartView key={j} part={part} />)
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">{stringifyValue(msg.content)}</pre>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -- Prompt detail dialog --

function PromptDetailDialog({
  entry,
  onClose,
}: {
  entry: LogEntry | null;
  onClose: () => void;
}) {
  const [full, setFull] = useState<LogEntryFull | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"system" | "messages">("system");

  useEffect(() => {
    if (!entry) { setFull(null); return; } // eslint-disable-line react-hooks/set-state-in-effect
    setLoading(true);
    setTab("system");
    rpc.getPromptLogEntry(entry.timestamp)
      .then((result) => { if (result) setFull(result as LogEntryFull); else toast("error", "Entry not found in log file."); })
      .catch(() => toast("error", "Failed to load prompt entry."))
      .finally(() => setLoading(false));
  }, [entry]);

  const systemLines = full ? full.systemPrompt.split("\n").length : 0;
  const messagesLines = full ? full.messages.split("\n").length : 0;

  return (
    <Dialog open={!!entry} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-6xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: entry ? agentColor(entry.agent) : DEFAULT_COLOR }} />
            {entry?.agent}
            <span className="text-muted-foreground font-normal text-sm ml-1">{entry && formatTime(entry.timestamp)}</span>
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex items-center gap-3 text-xs">
              <span>Model: <span className="font-mono">{entry?.model}</span></span>
              <span>System: {entry && formatTokens(entry.systemTokens)}</span>
              <span>Messages: {entry && formatTokens(entry.messagesTokens)}</span>
              <span className="font-medium">Total: {entry && formatTokens(entry.totalTokens)}</span>
              {full && <span>{systemLines + messagesLines} lines</span>}
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 border-b border-border -mx-6 px-6">
          <button
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${tab === "system" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            onClick={() => setTab("system")}
          >
            System Prompt
            {full && entry && <span className="ml-1 text-muted-foreground">({formatTokens(entry.systemTokens)} &middot; {systemLines} lines)</span>}
          </button>
          <button
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${tab === "messages" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            onClick={() => setTab("messages")}
          >
            Messages
            {full && entry && <span className="ml-1 text-muted-foreground">({formatTokens(entry.messagesTokens)} &middot; {messagesLines} lines)</span>}
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32"><p className="text-sm text-muted-foreground">Loading...</p></div>
          ) : full ? (
            tab === "messages" ? (
              <ConversationView raw={full.messages} />
            ) : (
              <pre className="text-xs font-mono whitespace-pre p-3 bg-muted/30 rounded-md select-all leading-relaxed">
                {full.systemPrompt}
              </pre>
            )
          ) : (
            <div className="flex items-center justify-center h-32"><p className="text-sm text-muted-foreground">No content available.</p></div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// -- Prompts tab --

function PromptsTab() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [fileSize, setFileSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedEntry, setSelectedEntry] = useState<LogEntry | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const result = await rpc.getPromptLogStats(50);
      setEntries(result.entries);
      setFileSize(result.fileSize);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    async function init() {
      try {
        const aiSettings = await rpc.getSettings("ai");
        const data = aiSettings as Record<string, unknown> ?? {};
        const isEnabled = data.debug_prompts === true || data.debug_prompts === "true";
        setEnabled(isEnabled);
        if (isEnabled) await loadStats();
      } catch { /* ignore */ }
      finally { setLoading(false); }
    }
    init();
  }, [loadStats]);

  if (loading) return <Loading />;

  if (!enabled) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground">
        <Info className="w-8 h-8 mb-3 opacity-30" />
        <p>Prompt logging is disabled.</p>
        <p className="text-xs mt-1">Enable it in <span className="font-medium text-foreground">Settings &gt; AI &gt; Debug</span> to see token usage and prompt details here.</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground">
        <BarChart2 className="w-8 h-8 mb-3 opacity-30" />
        <p>No prompt entries yet.</p>
        <p className="text-xs mt-1">Send a message to an AI agent to see token usage here.</p>
      </div>
    );
  }

  const totalTokensAll = entries.reduce((sum, e) => sum + e.totalTokens, 0);

  return (
    <div className="space-y-5">
      {/* Summary bar */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>Log size: {formatSize(fileSize)}</span>
          <span>Entries: {entries.length}</span>
          <span>Total: {formatTokens(totalTokensAll)} tokens</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={async () => {
              try { const r = await rpc.openPromptLog(); if (!r.success) toast("error", "Failed to open log."); }
              catch { toast("error", "Failed to open log."); }
            }}
            className="flex items-center gap-1 px-2 py-1 rounded border text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <FileText className="w-3 h-3" /> View Log
          </button>
          <button
            onClick={async () => {
              try {
                const r = await rpc.clearPromptLog();
                if (r.success) { toast("success", "Log cleared."); loadStats(); }
                else toast("error", "Failed to clear log.");
              } catch { toast("error", "Failed to clear log."); }
            }}
            className="flex items-center gap-1 px-2 py-1 rounded border text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Trash2 className="w-3 h-3" /> Clear Log
          </button>
          <button onClick={loadStats} className="p-1.5 rounded hover:bg-muted">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Bar chart */}
      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Token usage over time</h3>
        <div className="border rounded-lg p-3 bg-muted/10">
          <TokenBarChart entries={entries} onBarClick={setSelectedEntry} />
          <div className="flex items-center justify-between mt-2">
            <p className="text-[10px] text-muted-foreground">Older</p>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-foreground/60" /> System</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-foreground/25" /> Messages</span>
            </div>
            <p className="text-[10px] text-muted-foreground">Newer</p>
          </div>
        </div>
      </section>

      {/* Table */}
      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Prompt log</h3>
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left font-medium px-3 py-2">Time</th>
                <th className="text-left font-medium px-3 py-2">Agent</th>
                <th className="text-left font-medium px-3 py-2">Model</th>
                <th className="text-right font-medium px-3 py-2">System</th>
                <th className="text-right font-medium px-3 py-2">Messages</th>
                <th className="text-right font-medium px-3 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr
                  key={`${entry.timestamp}-${i}`}
                  className="border-b border-border last:border-0 hover:bg-muted/30 cursor-pointer"
                  onClick={() => setSelectedEntry(entry)}
                >
                  <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{timeAgo(entry.timestamp)}</td>
                  <td className="px-3 py-1.5 font-mono">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: agentColor(entry.agent) }} />
                      {entry.agent}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground font-mono truncate max-w-[160px]">{entry.model}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{formatTokens(entry.systemTokens)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{formatTokens(entry.messagesTokens)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium">{formatTokens(entry.totalTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <PromptDetailDialog entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
    </div>
  );
}

// ── AI Usage Tab (§9.1 — sourced from ai_telemetry_events) ───────────────────

const AGENT_COLORS: Record<string, string> = {
  PM: "#6366f1",
  "project-manager": "#6366f1",
  "code-explorer": "#06b6d4",
  "explore": "#06b6d4",
  "research-expert": "#06b6d4",
  "task-planner": "#f59e0b",
  "software-architect": "#8b5cf6",
  "frontend_engineer": "#10b981",
  "backend-engineer": "#3b82f6",
  "code-reviewer": "#ef4444",
  "qa-engineer": "#f97316",
  "devops-engineer": "#64748b",
  "debugging-specialist": "#ec4899",
  "security-expert": "#dc2626",
};
const DEFAULT_COLOR = "#94a3b8";

function agentColor(agent: string): string {
  return AGENT_COLORS[agent] ?? DEFAULT_COLOR;
}

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  return `~${formatCompact(n)}`;
}

function formatUsd(n: number | null): string {
  if (n == null) return "—";
  if (n < 0.01 && n > 0) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

const DAY_OPTIONS = [7, 14, 30, 90];

function UsageTab({ projects }: { projects: Array<{ id: string; name: string }> }) {
  const [projectId, setProjectId] = useState("all");
  const [agentName, setAgentName] = useState("all");
  const [provider, setProvider] = useState("all");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<TelemetryUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await rpc.getTelemetryUsage({
        projectId: projectId === "all" ? undefined : projectId,
        agentName: agentName === "all" ? undefined : agentName,
        provider: provider === "all" ? undefined : provider,
        days,
      }));
    } catch { /* empty */ } finally { setLoading(false); }
  }, [projectId, agentName, provider, days]);

  const handleClear = async () => {
    setClearing(true);
    try {
      const r = await rpc.clearTelemetryUsage();
      toast("success", `Usage data cleared — ${r.deleted.toLocaleString()} events removed.`);
      setConfirmClear(false);
      await load();
    } catch {
      toast("error", "Failed to clear usage data.");
    } finally {
      setClearing(false);
    }
  };

  useEffect(() => { load(); }, [load]);

  if (loading && !data) return <Loading />;
  if (!data) return <NoData />;

  if (data.totals.calls === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground">
        <BarChart2 className="w-8 h-8 mb-3 opacity-30" />
        <p>No AI usage recorded {data.telemetrySince ? "for this filter" : "yet"}.</p>
        <p className="text-xs mt-1">Telemetry starts recording the moment an agent turn runs.</p>
      </div>
    );
  }

  const tokensSeries = (key: keyof TelemetryUsage["tokensPerDay"][number]) =>
    data.tokensPerDay.map((d) => ({ label: d.day, value: Number(d[key]) }));

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {DAY_OPTIONS.map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`text-xs px-2 py-1 rounded border ${days === d ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted"}`}
          >
            {d}d
          </button>
        ))}
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="text-xs px-2 py-1 rounded border bg-background">
          <option value="all">All Projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={agentName} onChange={(e) => setAgentName(e.target.value)} className="text-xs px-2 py-1 rounded border bg-background">
          <option value="all">All Agents</option>
          {data.filters.agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} className="text-xs px-2 py-1 rounded border bg-background">
          <option value="all">All Providers</option>
          {data.filters.providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          onClick={() => setConfirmClear(true)}
          className="ml-auto flex items-center gap-1 px-2 py-1 rounded border text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Delete all recorded AI usage telemetry (also resets the Providers tab)"
        >
          <Trash2 className="w-3 h-3" /> Clear usage data
        </button>
        <button onClick={load} disabled={loading} className="p-1.5 rounded hover:bg-muted">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Est. cost"
          value={formatUsd(data.totals.costUsd)}
          sub={data.totals.costCoveragePct < 0.99 ? `${Math.round(data.totals.costCoveragePct * 100)}% of tokens priced` : undefined}
          accent="text-foreground"
        />
        <StatCard label="Calls" value={data.totals.calls} />
        <StatCard label="Input tokens" value={formatTokens(data.totals.inputTokens)} />
        <StatCard label="Output tokens" value={formatTokens(data.totals.outputTokens)} />
        <StatCard label="Cache hit rate" value={`${Math.round(data.totals.cacheHitRate * 100)}%`} accent="text-green-500" />
        <StatCard label="Saved by caching" value={formatUsd(data.totals.costSavedUsd)} accent="text-green-500" />
        <StatCard label="Reasoning tokens" value={formatTokens(data.totals.reasoningTokens)} />
        <StatCard label="Latency p50" value={formatMs(data.latency.p50Ms)} />
        <StatCard label="Latency p95" value={formatMs(data.latency.p95Ms)} />
        <StatCard label="Avg time-to-first-output" value={formatMs(data.latency.avgTimeToFirstOutputMs)} />
      </div>
      {data.totals.costCoveragePct < 0.99 && (
        <p className="text-[10px] text-muted-foreground -mt-4">
          Cost pricing{data.pricingAsOf ? ` as of ${new Date(data.pricingAsOf).toLocaleDateString()}` : ""} from models.dev. Ollama is free (local); custom/OpenAI-compatible providers and unrecognized models have no known rate and are excluded from the total, not counted as $0.
        </p>
      )}

      {/* Tokens over time */}
      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Token usage over time</h3>
        <div className="border rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-4 text-xs flex-wrap">
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-indigo-500 inline-block" /> Input</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-green-500 inline-block" /> Output</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-amber-500 inline-block" /> Cache read</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-purple-500 inline-block" /> Reasoning</span>
          </div>
          <LineChart data={tokensSeries("inputTokens")} color="#6366f1" height={90} showDots={false} />
          <LineChart data={tokensSeries("outputTokens")} color="#10b981" height={90} showDots={false} />
          <LineChart data={tokensSeries("cacheReadTokens")} color="#f59e0b" height={90} showDots={false} />
          <LineChart data={tokensSeries("reasoningTokens")} color="#8b5cf6" height={90} showDots={false} />
        </div>
        {data.telemetrySince && (
          <p className="text-[10px] text-muted-foreground mt-2">
            Telemetry recording began {new Date(data.telemetrySince).toLocaleDateString()} — usage from before that date isn't tracked here (sub-agent turns before this date have no historical cost data at all; it's absent, not zero).
          </p>
        )}
      </section>

      {/* By provider / By agent */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Tokens by provider</h3>
          <div className="border rounded-lg p-3">
            <DonutChart data={data.byProvider.map((p) => ({ label: p.provider, value: p.totalTokens }))} size={110} />
          </div>
        </section>
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Tokens by agent</h3>
          <div className="border rounded-lg p-3">
            <DonutChart
              data={data.byAgent.map((a) => ({ label: a.agentName, value: a.totalTokens, color: agentColor(a.agentName) }))}
              size={110}
            />
          </div>
        </section>
      </div>

      {/* Cost by model */}
      {data.byModel.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Cost by model</h3>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="text-left font-medium px-3 py-2">Provider</th>
                  <th className="text-left font-medium px-3 py-2">Model</th>
                  <th className="text-right font-medium px-3 py-2">Tokens</th>
                  <th className="text-right font-medium px-3 py-2">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {[...data.byModel].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1)).map((m) => (
                  <tr key={`${m.provider}-${m.modelId}`} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 font-mono">{m.provider}</td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground truncate max-w-[220px]">{m.modelId}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{formatTokens(m.totalTokens)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-medium">{formatUsd(m.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Throughput */}
      {data.throughputByModel.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Throughput (output tokens/sec)</h3>
          <div className="border rounded-lg p-3">
            <BarChart
              data={data.throughputByModel.map((m) => ({ label: `${m.provider}/${m.modelId}`, value: Math.round(m.avgTokensPerSecond) }))}
              horizontal
              height={Math.max(60, data.throughputByModel.length * 26)}
            />
          </div>
        </section>
      )}

      {/* Tool stats */}
      {data.toolStats.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Tool execution stats</h3>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="text-left font-medium px-3 py-2">Tool</th>
                  <th className="text-right font-medium px-3 py-2">Calls</th>
                  <th className="text-right font-medium px-3 py-2">Avg duration</th>
                  <th className="text-right font-medium px-3 py-2">Failure rate</th>
                </tr>
              </thead>
              <tbody>
                {data.toolStats.map((t) => (
                  <tr key={t.toolName} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 font-mono">{t.toolName}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{t.count}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{formatMs(t.avgMs)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${t.failureRate > 0.1 ? "text-red-500" : "text-muted-foreground"}`}>
                      {Math.round(t.failureRate * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Dialog open={confirmClear} onOpenChange={(o) => { if (!o) setConfirmClear(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Clear all AI usage data?</DialogTitle>
            <DialogDescription>
              This permanently deletes all recorded AI telemetry — token counts, cost, latency and provider health — across every project.
              The AI Usage and Providers tabs will both reset to zero. Your tasks, projects and prompt log are not affected. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-2">
            <button
              onClick={() => setConfirmClear(false)}
              disabled={clearing}
              className="px-3 py-1.5 rounded border text-sm hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleClear}
              disabled={clearing}
              className="px-3 py-1.5 rounded bg-red-600 text-white text-sm hover:bg-red-700 disabled:opacity-50"
            >
              {clearing ? "Clearing…" : "Clear data"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Provider Health Tab (§9.4) ────────────────────────────────────────────────

function ProvidersTab() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<ProviderHealth | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await rpc.getProviderHealth(days)); }
    catch { /* empty */ } finally { setLoading(false); }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) return <Loading />;
  if (!data || data.perProvider.length === 0) {
    return <NoData message="No provider activity recorded yet." />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        {DAY_OPTIONS.map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`text-xs px-2 py-1 rounded border ${days === d ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted"}`}
          >
            {d}d
          </button>
        ))}
        <button onClick={load} disabled={loading} className="ml-auto p-1.5 rounded hover:bg-muted">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="space-y-4">
        {data.perProvider.map((p) => (
          <section key={p.provider} className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">{p.provider}</h3>
              <span className={`text-xs font-medium ${p.errorRate > 0.05 ? "text-red-500" : "text-green-500"}`}>
                {p.errorRate > 0.05 ? "Degraded" : "Healthy"}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Calls" value={p.calls} />
              <StatCard label="Error rate" value={`${(p.errorRate * 100).toFixed(1)}%`} accent={p.errorRate > 0.05 ? "text-red-500" : "text-foreground"} />
              <StatCard label="Avg response time" value={formatMs(p.avgResponseTimeMs)} />
            </div>
            <LineChart data={p.callsPerDay.map((d) => ({ label: d.day, value: d.calls }))} color="#6366f1" height={70} showDots={false} />
          </section>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground">
        Error rate reflects finish-reason="error" on completed calls per provider. Errors that abort before a provider/model is known aren't attributable and are excluded.
      </p>
    </div>
  );
}

// ── Shared components ─────────────────────────────────────────────────────────

const TABS: { id: SubTab; label: string }[] = [
  { id: "dashboard", label: "Project Dashboard" },
  { id: "usage", label: "AI Usage" },
  { id: "providers", label: "Providers" },
  { id: "prompts", label: "Prompts" },
];

function Loading() {
  return (
    <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
      <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading...
    </div>
  );
}

function NoData({ message = "No data available yet." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-sm text-muted-foreground">
      <BarChart2 className="w-8 h-8 mb-2 opacity-30" />
      {message}
    </div>
  );
}

export function AnalyticsPage() {
  const [tab, setTab] = useState<SubTab>("dashboard");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    rpc.getProjects().then(setProjects).catch(() => {});
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tabs */}
      <div className="px-6 pt-5 pb-0 border-b shrink-0">
        {/* Sub-tabs */}
        <div className="flex gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`text-sm px-4 py-2 rounded-t border-b-2 transition-colors ${
                tab === t.id
                  ? "border-primary text-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "usage" ? (
          <UsageTab projects={projects} />
        ) : tab === "providers" ? (
          <ProvidersTab />
        ) : tab === "prompts" ? (
          <PromptsTab />
        ) : (
          <DashboardTab projects={projects} />
        )}
      </div>
    </div>
  );
}
