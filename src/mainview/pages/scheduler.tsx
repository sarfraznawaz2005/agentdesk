import { useState, useEffect, useCallback, useRef } from "react";
import {
  Clock,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  Zap,
  Play,
  Square,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { rpc } from "@/lib/rpc";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { cn } from "@/lib/utils";
import { formatDateTime, relativeTimeFuture as formatRelative } from "@/lib/date-utils";
import type { CronJob } from "@/components/scheduler/cron-job-form";
import { CronJobForm } from "@/components/scheduler/cron-job-form";
import type { AutomationRule } from "@/components/scheduler/automation-rule-card";
import { AutomationRuleCard } from "@/components/scheduler/automation-rule-card";
import { AutomationRuleForm } from "@/components/scheduler/automation-rule-form";
import { AutomationTemplates } from "@/components/scheduler/automation-templates";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CronJobHistoryEntry {
  id: string;
  jobId: string;
  status: string; // "success" | "error" | "running"
  startedAt: string;
  finishedAt: string | null;
  output: string | null;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function humanizeCron(expr: string): string {
  if (!expr) return "";
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [min, hr, dom, , dow] = parts;

  if (min === "*" && hr === "*") return "Every minute";
  if (hr === "*" && min !== "*") return `Every hour at :${min.padStart(2, "0")}`;
  if (dom === "*" && dow === "*" && min !== "*" && hr !== "*") {
    return `Daily at ${hr.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  if (dom === "*" && dow !== "*") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayLabels = dow
      .split(",")
      .map(Number)
      .filter((d) => d >= 0 && d <= 6)
      .map((d) => days[d])
      .join(", ");
    return `Weekly on ${dayLabels} at ${hr.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  if (dom !== "*" && dow === "*") {
    return `Monthly on day ${dom} at ${hr.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  return expr;
}

function getTaskTypeLabel(type: string): string {
  switch (type) {
    case "pm_prompt": return "PM Prompt";
    case "reminder": return "Reminder";
    case "shell": return "Shell Command";
    case "webhook": return "Webhook";
    case "agent_task": return "Agent Project Task";
    case "agent_task_simple": return "Agent Task";
    case "send_channel_message": return "Send Message";
    default: return type;
  }
}

// ---------------------------------------------------------------------------
// Skeleton loaders
// ---------------------------------------------------------------------------

function CronJobCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5 flex-1">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3.5 w-56" />
          </div>
          <Skeleton className="h-5 w-9 rounded-full" />
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        <Skeleton className="h-3 w-32" />
        <div className="flex gap-2">
          <Skeleton className="h-7 w-16 rounded-md" />
          <Skeleton className="h-7 w-16 rounded-md" />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function LastRunBadge({ status }: { status: string | null }) {
  if (!status || status === "never") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 bg-muted text-muted-foreground border-border">
        Never run
      </Badge>
    );
  }
  if (status === "success") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 bg-green-50 text-green-700 border-green-200">
        Success
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 bg-red-50 text-red-700 border-red-200">
        Error
      </Badge>
    );
  }
  if (status === "running") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 bg-blue-50 text-blue-700 border-blue-200">
        Running
      </Badge>
    );
  }
  if (status === "stopped") {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 bg-muted text-muted-foreground border-border">
        Stopped
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">
      {status}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// History section
// ---------------------------------------------------------------------------

interface HistorySectionProps {
  jobId: string;
  expanded: boolean;
  onCleared: () => void;
}

function HistorySection({ jobId, expanded, onCleared }: HistorySectionProps) {
  const [history, setHistory] = useState<CronJobHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!expanded || loaded) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const result = await rpc.getCronJobHistory(jobId, 10);
        if (!cancelled) {
          setHistory(Array.isArray(result) ? (result as unknown as CronJobHistoryEntry[]) : []);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) {
          toast("error", "Failed to load job history.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [expanded, loaded, jobId]);

  async function handleClear() {
    setClearing(true);
    try {
      await rpc.clearCronJobHistory(jobId);
      setHistory([]);
      setLoaded(true);
      onCleared();
    } catch {
      toast("error", "Failed to clear history.");
    } finally {
      setClearing(false);
    }
  }

  if (!expanded) return null;

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Last 10 runs
        </p>
        {history.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={handleClear}
            disabled={clearing}
          >
            {clearing ? "Clearing…" : "Clear"}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-1.5" aria-busy="true" aria-label="Loading history">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : history.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No runs recorded yet.</p>
      ) : (
        <ul className="space-y-1.5" aria-label="Run history">
          {history.map((entry) => (
            <li
              key={entry.id}
              className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
            >
              <span
                className={cn(
                  "mt-0.5 h-2 w-2 rounded-full flex-shrink-0",
                  entry.status === "success" ? "bg-green-500" :
                  entry.status === "error" ? "bg-red-500" :
                  entry.status === "running" ? "bg-blue-500" :
                  entry.status === "stopped" ? "bg-muted-foreground" :
                  "bg-muted-foreground/60"
                )}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <time className="text-xs font-medium" dateTime={entry.startedAt}>
                    {formatDateTime(entry.startedAt)}
                  </time>
                  <span
                    className={cn(
                      "text-[10px] font-medium capitalize",
                      entry.status === "success" ? "text-green-600" :
                      entry.status === "error" ? "text-red-600" :
                      "text-muted-foreground"
                    )}
                  >
                    {entry.status}
                  </span>
                </div>
                {entry.errorMessage && (
                  <p className="text-xs text-red-600 mt-0.5 truncate" title={entry.errorMessage}>
                    {entry.errorMessage}
                  </p>
                )}
                {entry.output && !entry.errorMessage && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate font-mono" title={entry.output}>
                    {entry.output}
                  </p>
                )}
              </div>
              {entry.finishedAt && (
                <span className="text-[10px] text-muted-foreground flex-shrink-0">
                  {formatRelative(entry.finishedAt)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cron Job Card
// ---------------------------------------------------------------------------

interface CronJobCardProps {
  job: CronJob;
  isRunning: boolean;
  onEdit: (job: CronJob) => void;
  onDelete: (job: CronJob) => void;
  onToggleEnabled: (job: CronJob, enabled: boolean) => void;
  onJobsReload: () => void;
}

function CronJobCard({ job, isRunning, onEdit, onDelete, onToggleEnabled, onJobsReload }: CronJobCardProps) {
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [stopping, setStopping] = useState(false);

  async function handleRunNow() {
    setTriggering(true);
    try {
      await rpc.triggerCronJob({ id: job.id });
      toast("success", `"${job.name}" triggered.`);
      onJobsReload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to trigger job.";
      toast("error", msg);
    } finally {
      setTriggering(false);
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      const result = (await rpc.stopCronJob({ id: job.id })) as { stopped: boolean };
      if (!result.stopped) {
        toast("error", "Job was no longer running.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to stop job.";
      toast("error", msg);
    } finally {
      setStopping(false);
    }
  }

  const isEnabled = job.enabled === 1;
  const humanSchedule = humanizeCron(job.cronExpression);

  async function handleToggle(checked: boolean) {
    setToggling(true);
    try {
      await onToggleEnabled(job, checked);
    } finally {
      setToggling(false);
    }
  }

  return (
    <Card className={cn("transition-opacity", !isEnabled && "opacity-60")}>
      <CardHeader className="pb-2">
        <div className="flex items-start gap-3">
          {/* Main info */}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-foreground">
                {job.name}
              </span>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-4 bg-muted text-muted-foreground"
              >
                {getTaskTypeLabel(job.taskType)}
              </Badge>
              {job.oneShot === 1 && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-4 bg-amber-50 text-amber-700 border-amber-200"
                >
                  One-shot
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
              <span className="font-mono">{job.cronExpression}</span>
              {humanSchedule && humanSchedule !== job.cronExpression && (
                <>
                  <span aria-hidden="true">—</span>
                  <span>{humanSchedule}</span>
                </>
              )}
            </div>
          </div>

          {/* Enable/disable switch */}
          <div className="relative flex items-center gap-1.5 flex-shrink-0 pt-0.5">
            <span className="text-xs text-muted-foreground sr-only">
              {isEnabled ? "Enabled" : "Disabled"}
            </span>
            <Switch
              checked={isEnabled}
              onCheckedChange={handleToggle}
              disabled={toggling}
              aria-label={`${isEnabled ? "Disable" : "Enable"} job ${job.name}`}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-2.5">
        {/* Next / last run info */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
          <span>
            <span className="font-medium">Next run:</span>{" "}
            {job.nextRunAt ? (
              <time dateTime={job.nextRunAt}>{formatRelative(job.nextRunAt)}</time>
            ) : (
              "—"
            )}
          </span>
          <span>
            <span className="font-medium">Last run:</span>{" "}
            {job.lastRunAt ? (
              <time dateTime={job.lastRunAt}>{formatRelative(job.lastRunAt)}</time>
            ) : (
              "—"
            )}
          </span>
          <LastRunBadge status={job.lastRunStatus} />
        </div>

        {/* Actions row */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1 text-xs"
            onClick={() => setHistoryExpanded((v) => !v)}
            aria-expanded={historyExpanded}
            aria-controls={`history-${job.id}`}
          >
            {historyExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            History
          </Button>

          <div className="ml-auto flex items-center gap-1.5">
            {isRunning && job.isStoppable ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 gap-1 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={handleStop}
                disabled={stopping}
                aria-label={`Stop job ${job.name}`}
              >
                <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            ) : isRunning ? (
              // Not individually cancellable (e.g. PM-dispatched tasks continue in
              // their own conversation after this cron run returns) — show a plain
              // status instead of a Stop button that wouldn't actually stop anything.
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 gap-1 text-xs text-muted-foreground"
                disabled
                aria-label={`Job ${job.name} is running`}
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                Running…
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 gap-1 text-xs text-green-700 hover:text-green-800 hover:bg-green-50"
                onClick={handleRunNow}
                disabled={triggering}
                aria-label={`Run job ${job.name} now`}
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                {triggering ? "Starting…" : "Run"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1 text-xs"
              onClick={() => onEdit(job)}
              aria-label={`Edit job ${job.name}`}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => onDelete(job)}
              aria-label={`Delete job ${job.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete
            </Button>
          </div>
        </div>

        {/* History section */}
        <div id={`history-${job.id}`}>
          <HistorySection jobId={job.id} expanded={historyExpanded} onCleared={onJobsReload} />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cron Jobs Tab content
// ---------------------------------------------------------------------------

interface CronJobsTabProps {
  jobs: CronJob[];
  loading: boolean;
  runningJobIds: Set<string>;
  onAdd: () => void;
  onEdit: (job: CronJob) => void;
  onDelete: (job: CronJob) => void;
  onToggleEnabled: (job: CronJob, enabled: boolean) => void;
  onJobsReload: () => void;
}

function CronJobsTab({
  jobs,
  loading,
  runningJobIds,
  onAdd,
  onEdit,
  onDelete,
  onToggleEnabled,
  onJobsReload,
}: CronJobsTabProps) {
  const [clearingAll, setClearingAll] = useState(false);

  async function handleClearAll() {
    setClearingAll(true);
    try {
      await rpc.clearCronJobHistory();
      toast("success", "All job history cleared.");
      onJobsReload();
    } catch {
      toast("error", "Failed to clear history.");
    } finally {
      setClearingAll(false);
    }
  }
  return (
    <div className="space-y-4">
      {/* Tab header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            {loading
              ? "Loading..."
              : `${jobs.length} job${jobs.length === 1 ? "" : "s"} configured`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {jobs.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground hover:text-destructive"
              onClick={handleClearAll}
              disabled={clearingAll}
            >
              {clearingAll ? "Clearing…" : "Clear all history"}
            </Button>
          )}
          <Button size="sm" onClick={onAdd} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add job
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading cron jobs">
          {Array.from({ length: 3 }).map((_, i) => (
            <CronJobCardSkeleton key={i} />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={<Clock className="h-6 w-6" aria-hidden="true" />}
          title="No cron jobs yet"
          description="Schedule recurring tasks like reports, reminders, shell commands, or webhooks."
          action={
            <Button size="sm" onClick={onAdd} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add first job
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3" aria-label="Cron jobs">
          {jobs.map((job) => (
            <li key={job.id}>
              <CronJobCard
                job={job}
                isRunning={runningJobIds.has(job.id)}
                onEdit={onEdit}
                onDelete={onDelete}
                onToggleEnabled={onToggleEnabled}
                onJobsReload={onJobsReload}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Automation Rules Tab
// ---------------------------------------------------------------------------

interface AutomationRulesTabProps {
  rules: AutomationRule[];
  loading: boolean;
  onAdd: () => void;
  onEdit: (rule: AutomationRule) => void;
  onDelete: (rule: AutomationRule) => void;
  onToggle: (rule: AutomationRule) => void;
  onUseTemplate: (template: { name: string; trigger: string; actions: string }) => void;
}

function AutomationRulesTab({
  rules,
  loading,
  onAdd,
  onEdit,
  onDelete,
  onToggle,
  onUseTemplate,
}: AutomationRulesTabProps) {
  return (
    <div className="space-y-6">
      {/* Tab header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            {loading
              ? "Loading..."
              : `${rules.length} rule${rules.length === 1 ? "" : "s"} configured`}
          </p>
        </div>
        <Button size="sm" onClick={onAdd} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add rule
        </Button>
      </div>

      {loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading automation rules">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : rules.length === 0 ? (
        <EmptyState
          icon={<Zap className="h-6 w-6" aria-hidden="true" />}
          title="No automation rules yet"
          description="Create event-driven automations or start from a template below."
          action={
            <Button size="sm" onClick={onAdd} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add first rule
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3" aria-label="Automation rules">
          {rules.map((rule) => (
            <li key={rule.id}>
              <AutomationRuleCard
                rule={rule}
                onEdit={() => onEdit(rule)}
                onDelete={() => onDelete(rule)}
                onToggle={() => onToggle(rule)}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Templates section */}
      <Separator />
      <div>
        <h3 className="text-sm font-semibold mb-3">Templates</h3>
        <AutomationTemplates onUseTemplate={onUseTemplate} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SchedulerPage
// ---------------------------------------------------------------------------

export function SchedulerPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("cron");
  const [runningJobIds, setRunningJobIds] = useState<Set<string>>(new Set());

  // Cron form state
  const [formOpen, setFormOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | undefined>(undefined);

  // Automation state
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | undefined>(undefined);
  const [templatePrefill, setTemplatePrefill] = useState<{ name: string; trigger: string; actions: string } | undefined>(undefined);

  // Delete confirmation dialog state
  const [deleteJobConfirmOpen, setDeleteJobConfirmOpen] = useState(false);
  const pendingDeleteJob = useRef<CronJob | null>(null);
  const [deleteRuleConfirmOpen, setDeleteRuleConfirmOpen] = useState(false);
  const pendingDeleteRule = useRef<AutomationRule | null>(null);

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadJobs = useCallback(async () => {
    setLoading(true);
    try {
      const result = await rpc.getCronJobs();
      const loaded = Array.isArray(result) ? (result as unknown as CronJob[]) : [];
      setJobs(loaded);
      setRunningJobIds(new Set(loaded.filter((j) => j.isRunning).map((j) => j.id)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load cron jobs.";
      toast("error", msg);
    } finally {
      setLoading(false);
    }
  }, []);

  // Live running-state — covers both manual (Run button) and automatic
  // (cron-fired) job runs, so Stop shows up regardless of trigger source.
  useEffect(() => {
    const handler = (e: Event) => {
      const { jobId, running } = (e as CustomEvent).detail as { jobId: string; running: boolean };
      setRunningJobIds((prev) => {
        const next = new Set(prev);
        if (running) next.add(jobId);
        else next.delete(jobId);
        return next;
      });
      // A run just finished — refresh so next/last-run info and the history
      // badge reflect the outcome without a manual reload.
      if (!running) loadJobs();
    };
    window.addEventListener("agentdesk:cron-run-state-changed", handler);
    return () => window.removeEventListener("agentdesk:cron-run-state-changed", handler);
  }, [loadJobs]);

  const loadRules = useCallback(async () => {
    setRulesLoading(true);
    try {
      const result = await rpc.getAutomationRules();
      setRules(Array.isArray(result) ? (result as unknown as AutomationRule[]) : []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load automation rules.";
      toast("error", msg);
    } finally {
      setRulesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();
    loadRules();
  }, [loadJobs, loadRules]);

  // ---------------------------------------------------------------------------
  // Cron Handlers
  // ---------------------------------------------------------------------------

  function handleAddJob() {
    setEditingJob(undefined);
    setFormOpen(true);
  }

  function handleEditJob(job: CronJob) {
    setEditingJob(job);
    setFormOpen(true);
  }

  function handleDeleteJob(job: CronJob) {
    pendingDeleteJob.current = job;
    setDeleteJobConfirmOpen(true);
  }

  async function confirmDeleteJob() {
    const job = pendingDeleteJob.current;
    if (!job) return;
    try {
      await rpc.deleteCronJob(job.id);
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
      toast("success", `Deleted "${job.name}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete cron job.";
      toast("error", msg);
    } finally {
      pendingDeleteJob.current = null;
    }
  }

  async function handleToggleEnabled(job: CronJob, enabled: boolean) {
    try {
      await rpc.updateCronJob({ id: job.id, enabled });
      setJobs((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, enabled: enabled ? 1 : 0 } : j))
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update job.";
      toast("error", msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Automation Handlers
  // ---------------------------------------------------------------------------

  function handleAddRule() {
    setEditingRule(undefined);
    setTemplatePrefill(undefined);
    setRuleFormOpen(true);
  }

  function handleEditRule(rule: AutomationRule) {
    setEditingRule(rule);
    setTemplatePrefill(undefined);
    setRuleFormOpen(true);
  }

  function handleDeleteRule(rule: AutomationRule) {
    pendingDeleteRule.current = rule;
    setDeleteRuleConfirmOpen(true);
  }

  async function confirmDeleteRule() {
    const rule = pendingDeleteRule.current;
    if (!rule) return;
    try {
      await rpc.deleteAutomationRule(rule.id);
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      toast("success", `Deleted "${rule.name}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete rule.";
      toast("error", msg);
    } finally {
      pendingDeleteRule.current = null;
    }
  }

  async function handleToggleRule(rule: AutomationRule) {
    const newEnabled = rule.enabled === 1 ? false : true;
    try {
      await rpc.updateAutomationRule({ id: rule.id, enabled: newEnabled });
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: newEnabled ? 1 : 0 } : r))
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to toggle rule.";
      toast("error", msg);
    }
  }

  function handleUseTemplate(template: { name: string; trigger: string; actions: string }) {
    setEditingRule(undefined);
    setTemplatePrefill(template);
    setRuleFormOpen(true);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-5">
          <TabsTrigger value="cron">Cron Jobs</TabsTrigger>
          <TabsTrigger value="automation">Automation Rules</TabsTrigger>
        </TabsList>

        <TabsContent value="cron">
          <CronJobsTab
            jobs={jobs}
            loading={loading}
            runningJobIds={runningJobIds}
            onAdd={handleAddJob}
            onEdit={handleEditJob}
            onDelete={handleDeleteJob}
            onToggleEnabled={handleToggleEnabled}
            onJobsReload={loadJobs}
          />
        </TabsContent>

        <TabsContent value="automation">
          <AutomationRulesTab
            rules={rules}
            loading={rulesLoading}
            onAdd={handleAddRule}
            onEdit={handleEditRule}
            onDelete={handleDeleteRule}
            onToggle={handleToggleRule}
            onUseTemplate={handleUseTemplate}
          />
        </TabsContent>
      </Tabs>

      {/* Cron job form dialog */}
      <CronJobForm
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={loadJobs}
        job={editingJob}
      />

      {/* Automation rule form dialog */}
      <AutomationRuleForm
        open={ruleFormOpen}
        onOpenChange={setRuleFormOpen}
        onSaved={loadRules}
        rule={editingRule}
        prefill={templatePrefill}
      />

      {/* Delete cron job confirmation */}
      <ConfirmationDialog
        open={deleteJobConfirmOpen}
        onOpenChange={setDeleteJobConfirmOpen}
        title="Delete Cron Job"
        description={`Delete cron job "${pendingDeleteJob.current?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDeleteJob}
      />

      {/* Delete automation rule confirmation */}
      <ConfirmationDialog
        open={deleteRuleConfirmOpen}
        onOpenChange={setDeleteRuleConfirmOpen}
        title="Delete Automation Rule"
        description={`Delete automation rule "${pendingDeleteRule.current?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDeleteRule}
      />
    </div>
  );
}
