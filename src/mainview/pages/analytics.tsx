import { useState, useEffect, useCallback } from "react";
import { BarChart2, RefreshCw } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { LineChart, BarChart, DonutChart, ActivityHeatmap, StatCard } from "@/components/analytics/charts";

type ProjectStats = Awaited<ReturnType<typeof rpc.getProjectStats>>;
type TelemetryUsage = Awaited<ReturnType<typeof rpc.getTelemetryUsage>>;
type ProviderHealth = Awaited<ReturnType<typeof rpc.getProviderHealth>>;

type SubTab = "dashboard" | "usage" | "providers";

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
  if (n < 1000) return `~${n}`;
  return `~${(n / 1000).toFixed(1)}k`;
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
        <button onClick={load} disabled={loading} className="ml-auto p-1.5 rounded hover:bg-muted">
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
        ) : (
          <DashboardTab projects={projects} />
        )}
      </div>
    </div>
  );
}
