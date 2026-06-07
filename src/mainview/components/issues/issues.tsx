import { useState, useEffect, useCallback, useMemo } from "react";
import {
  RefreshCw,
  Link as LinkIcon,
  ChevronRight,
  ChevronDown,
  Settings2,
  Plus,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Trash2,
  Loader2,
  Search,
  ListPlus,
  SquareKanban,
} from "lucide-react";
import { rpc } from "../../lib/rpc";
import { useKanbanStore, type KanbanTask } from "../../stores/kanban-store";
import { Tip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { toast } from "@/components/ui/toast";
import {
  ISSUE_SOURCE_DESCRIPTORS,
  getIssueSourceDescriptor,
  requireIssueSourceDescriptor,
  type IssueSource,
  type ExternalIssue,
  type IssueSourceStatus,
} from "../../../shared/rpc/issues";

// Tasks are sourced from the Zustand kanban store so create/delete/rename reflect
// here instantly (no manual refresh / tab round-trip needed).
type TaskLite = KanbanTask;

// ── HTML → plain text (some trackers, e.g. Kanboard, store rich-HTML bodies) ────
function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][\s\S]*?>/i.test(s);
}

function stripHtml(s: string): string {
  const text = s
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n") // block ends → newline
    .replace(/<[^>]+>/g, "") // drop remaining tags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Body shown to the user: stripped to plain text only when it contains HTML. */
function displayBody(body: string | null): string {
  if (!body) return "";
  return looksLikeHtml(body) ? stripHtml(body) : body;
}

interface IssuesProps {
  projectId: string;
}

// ── badge colours per source ────────────────────────────────────────────────
const SOURCE_BADGE_CLASS: Record<IssueSource, string> = {
  github: "bg-zinc-500/20 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
  jira: "bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-500/30",
  linear: "bg-violet-500/20 text-violet-700 dark:text-violet-300 border-violet-500/30",
  gitlab: "bg-orange-500/20 text-orange-700 dark:text-orange-300 border-orange-500/30",
  trello: "bg-sky-500/20 text-sky-700 dark:text-sky-300 border-sky-500/30",
  kanboard: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
};

const PRIORITY_CLASS: Record<string, string> = {
  critical: "bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/30",
  high: "bg-orange-500/20 text-orange-700 dark:text-orange-300 border-orange-500/30",
  medium: "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300 border-yellow-500/30",
  low: "bg-slate-500/20 text-slate-600 dark:text-slate-300 border-slate-500/30",
};

function stateColor(state: string) {
  return state === "open"
    ? "bg-green-500/20 text-green-700 dark:text-green-300 border-green-500/30"
    : "bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/30";
}

// ── individual issue card ─────────────────────────────────────────────────────

function IssueCard({
  projectId,
  issue,
  tasks,
  onChanged,
}: {
  projectId: string;
  issue: ExternalIssue;
  tasks: TaskLite[];
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [linking, setLinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const descriptor = getIssueSourceDescriptor(issue.source);
  const url = issue.url; // captured const so the open-in-browser handler keeps narrowing
  const createKanbanTask = useKanbanStore((s) => s.createTask);
  const selectKanbanTask = useKanbanStore((s) => s.selectTask);

  // The task this issue is linked to, only if it still exists (a deleted task
  // leaves a dangling taskId — treat that as unlinked so we offer "Create" again).
  const linkedTask = tasks.find((t) => t.id === issue.taskId) ?? null;

  // Only offer real, named tasks for linking — hide untouched "New task" placeholders
  // created by the kanban + button (but keep the currently-linked one so the select stays valid).
  const linkableTasks = tasks.filter((t) => t.title !== "New task" || t.id === issue.taskId);

  async function onSelectTask(taskId: string) {
    setLinking(true);
    try {
      await rpc.linkExternalIssueToTask(issue.id, taskId || null); // "" ⇒ unlink
      onChanged();
    } finally {
      setLinking(false);
    }
  }

  // Create a kanban task pre-filled from this issue, link them, and open the
  // (auto-saving) detail dialog. If already linked, just open the linked task.
  async function onCreateKanbanTask() {
    if (linkedTask) {
      selectKanbanTask(linkedTask.id);
      return;
    }
    setCreating(true);
    try {
      const parts: string[] = [];
      const body = displayBody(issue.body);
      if (body) parts.push(body);
      if (issue.url) {
        parts.push(`---\nSource (${descriptor?.label ?? issue.source} ${formatSourceId(issue)}): ${issue.url}`);
      }
      const newId = await createKanbanTask({
        projectId,
        title: issue.title,
        description: parts.join("\n\n"),
        priority: issue.priority ?? "medium",
        // Kanban due dates are calendar days — normalise full ISO timestamps to YYYY-MM-DD.
        dueDate: issue.dueDate ? issue.dueDate.slice(0, 10) : undefined,
        column: "backlog",
      });
      await rpc.linkExternalIssueToTask(issue.id, newId);
      onChanged();
      selectKanbanTask(newId);
      toast("success", "Kanban task created and linked — edit it in the dialog (changes save automatically).");
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Failed to create kanban task.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="border rounded-lg hover:bg-muted/30 transition-colors">
      <button
        type="button"
        onClick={() => (issue.body ? setExpanded((v) => !v) : undefined)}
        className={`w-full flex items-start gap-2 p-3 text-left ${issue.body ? "cursor-pointer" : "cursor-default"}`}
      >
        {issue.body ? (
          expanded ? (
            <ChevronDown className="w-3 h-3 mt-0.5 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 mt-0.5 text-muted-foreground flex-shrink-0" />
          )
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${SOURCE_BADGE_CLASS[issue.source]}`}>
              {descriptor?.badge ?? issue.source}
            </span>
            <span className={`text-xs px-1.5 py-0.5 rounded border ${stateColor(issue.state)}`}>{issue.state}</span>
            {issue.priority && (
              <span className={`text-xs px-1.5 py-0.5 rounded border capitalize ${PRIORITY_CLASS[issue.priority] ?? ""}`}>
                {issue.priority}
              </span>
            )}
            <span className="text-xs text-muted-foreground">{formatSourceId(issue)}</span>
            {issue.assignee && (
              <span className="text-xs text-muted-foreground">· {issue.assignee}</span>
            )}
            {linkedTask && (
              <span className="text-xs bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-500/30 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                <LinkIcon className="w-2.5 h-2.5" /> Linked
              </span>
            )}
          </div>
          <p className="text-sm font-medium truncate">{issue.title}</p>
          {issue.labels.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {issue.labels.map((label) => (
                <span key={label} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="flex items-center gap-3 flex-shrink-0 mt-0.5">
          {linkedTask ? (
            <Tip content="Open linked kanban task">
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  selectKanbanTask(linkedTask.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    selectKanbanTask(linkedTask.id);
                  }
                }}
                className="text-blue-600 dark:text-blue-400 hover:text-blue-500 cursor-pointer"
              >
                <SquareKanban className="w-[18px] h-[18px]" />
              </span>
            </Tip>
          ) : (
            <Tip content="Create kanban task from this issue">
              <span
                role="button"
                tabIndex={0}
                aria-disabled={creating}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!creating) onCreateKanbanTask();
                }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !creating) {
                    e.preventDefault();
                    e.stopPropagation();
                    onCreateKanbanTask();
                  }
                }}
                className="text-muted-foreground hover:text-foreground cursor-pointer"
              >
                {creating ? <Loader2 className="w-[18px] h-[18px] animate-spin" /> : <ListPlus className="w-[18px] h-[18px]" />}
              </span>
            </Tip>
          )}
          {url && (
            <Tip content="Open in browser">
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  rpc.openExternalUrl(url).catch(() => {});
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    rpc.openExternalUrl(url).catch(() => {});
                  }
                }}
                className="text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <ExternalLink className="w-[18px] h-[18px]" />
              </span>
            </Tip>
          )}
        </span>
      </button>
      {expanded && issue.body && (
        <div className="px-3 pb-3 pl-8">
          <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words border-t pt-2">{displayBody(issue.body)}</p>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t">
        <span className="text-xs text-muted-foreground shrink-0">Kanban task:</span>
        <select
          value={issue.taskId ?? ""}
          onChange={(e) => onSelectTask(e.target.value)}
          disabled={linking || linkableTasks.length === 0}
          className="text-xs px-2 py-1 rounded border bg-background max-w-[60%] truncate disabled:opacity-50"
        >
          <option value="">{linkableTasks.length === 0 ? "No tasks yet" : "— Not linked —"}</option>
          {linkableTasks.map((tk) => (
            <option key={tk.id} value={tk.id}>
              {tk.title}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function formatSourceId(issue: ExternalIssue): string {
  // GitHub / GitLab use numeric ids → show "#123". Others show their key/identifier.
  if (issue.source === "github" || issue.source === "gitlab") return `#${issue.sourceId}`;
  return issue.sourceId;
}

// ── configure dialog (dynamic per-source form) ─────────────────────────────────

function ConfigureDialog({
  projectId,
  source,
  onClose,
  onSaved,
}: {
  projectId: string;
  source: IssueSource;
  onClose: () => void;
  onSaved: () => void;
}) {
  const descriptor = requireIssueSourceDescriptor(source);
  const bucketSpec = descriptor.bucketSelection; // present ⇒ source supports column/list/status picking
  const docsUrl = descriptor.docsUrl; // captured const so the onClick handler keeps narrowing
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Bucket selection (columns/lists/statuses), populated after a successful Test.
  type BucketGroupT = { groupId: string; groupName: string; buckets: Array<{ id: string; title: string }> };
  const [bucketGroups, setBucketGroups] = useState<BucketGroupT[] | null>(null);
  const [selectedBuckets, setSelectedBuckets] = useState<Set<string>>(new Set());
  const [connectionOk, setConnectionOk] = useState(false);

  const requiredFilled = (cfg: Record<string, string>) =>
    descriptor.fields.filter((f) => f.required).every((f) => (cfg[f.key] ?? "").trim());

  // Discover the source's buckets for the current config (also serves as the test).
  const discoverBuckets = useCallback(
    async (cfg: Record<string, string>) => {
      setTesting(true);
      setTestResult(null);
      try {
        const res = await rpc.getSourceBuckets(source, cfg);
        if (res.ok && res.groups) {
          setBucketGroups(res.groups);
          setConnectionOk(true);
          const total = res.groups.reduce((n, g) => n + g.buckets.length, 0);
          const noun = (bucketSpec?.label ?? "items").toLowerCase();
          setTestResult({ ok: true, message: `Connected — ${total} ${noun} found. Select which to import.` });
        } else {
          setBucketGroups(null);
          setConnectionOk(false);
          setTestResult({ ok: false, message: res.error ?? "Connection failed." });
        }
      } catch (err) {
        setConnectionOk(false);
        setTestResult({ ok: false, message: err instanceof Error ? err.message : "Connection failed." });
      } finally {
        setTesting(false);
      }
    },
    [source, bucketSpec],
  );

  useEffect(() => {
    let cancelled = false;
    rpc
      .getIssueSourceConfig(projectId, source)
      .then((res) => {
        if (cancelled) return;
        const cfg = res.config ?? {};
        setConfig(cfg);
        setLoading(false);
        if (bucketSpec) {
          // Preselect saved buckets and auto-discover if creds are already present.
          try {
            const saved = JSON.parse(cfg.buckets ?? cfg.columns ?? "[]");
            if (Array.isArray(saved)) setSelectedBuckets(new Set(saved.map(String)));
          } catch { /* ignore */ }
          if (requiredFilled(cfg)) discoverBuckets(cfg);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, source]); // eslint-disable-line react-hooks/exhaustive-deps

  const setField = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
    if (bucketSpec) {
      // Credentials changed — force a re-test before buckets/Save are valid again.
      setConnectionOk(false);
      setBucketGroups(null);
    }
  };

  const toggleBucket = (bucketId: string) => {
    setSelectedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(bucketId)) next.delete(bucketId);
      else next.add(bucketId);
      return next;
    });
  };

  const toggleGroupBuckets = (group: BucketGroupT, select: boolean) => {
    setSelectedBuckets((prev) => {
      const next = new Set(prev);
      for (const b of group.buckets) {
        if (select) next.add(b.id);
        else next.delete(b.id);
      }
      return next;
    });
  };

  const handleTest = async () => {
    if (bucketSpec) {
      await discoverBuckets(config);
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await rpc.testIssueSource(projectId, source, config);
      setTestResult({ ok: res.ok, message: res.ok ? res.detail ?? "Connection successful." : res.error ?? "Connection failed." });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : "Connection failed." });
    } finally {
      setTesting(false);
    }
  };

  // Save gating: a *required* bucket source needs a working connection AND ≥1 selection.
  const saveDisabled = saving || (!!bucketSpec?.required && (!connectionOk || selectedBuckets.size === 0));

  const handleSave = async () => {
    setSaving(true);
    try {
      const toSave = bucketSpec
        ? { ...config, buckets: JSON.stringify([...selectedBuckets]) }
        : config;
      const res = await rpc.saveIssueSourceConfig(projectId, source, toSave);
      if (res.success) {
        toast("success", `${descriptor.label} configured.`);
        onSaved();
        onClose();
      } else {
        toast("error", res.error ?? "Failed to save configuration.");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setSaving(true);
    try {
      await rpc.deleteIssueSourceConfig(projectId, source);
      toast("success", `${descriptor.label} disconnected.`);
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-background border rounded-lg shadow-lg w-full max-w-lg mx-4 p-5 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${SOURCE_BADGE_CLASS[source]}`}>
            {descriptor.badge}
          </span>
          <h3 className="text-sm font-semibold">Connect {descriptor.label}</h3>
        </div>
        {descriptor.configHint && <p className="text-xs text-muted-foreground mb-4">{descriptor.configHint}</p>}

        {loading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
        ) : (
          <div className="space-y-3">
            {descriptor.fields.map((field) => (
              <div key={field.key}>
                <label className="text-xs font-medium block mb-1">
                  {field.label}
                  {field.required && <span className="text-red-500 ml-0.5">*</span>}
                </label>
                {field.type === "password" ? (
                  <PasswordInput
                    value={config[field.key] ?? ""}
                    onChange={(e) => setField(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="text-sm"
                  />
                ) : (
                  <Input
                    value={config[field.key] ?? ""}
                    onChange={(e) => setField(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="text-sm"
                  />
                )}
                {field.help && <p className="text-[11px] text-muted-foreground mt-1">{field.help}</p>}
              </div>
            ))}

            {docsUrl && (
              <button
                type="button"
                onClick={() => rpc.openExternalUrl(docsUrl).catch(() => {})}
                className="text-xs text-primary inline-flex items-center gap-1 hover:underline"
              >
                <ExternalLink className="w-3 h-3" /> Where do I find these?
              </button>
            )}

            {testResult && (
              <div className={`text-xs px-3 py-2 rounded border flex items-start gap-2 ${testResult.ok ? "border-green-500/30 text-green-600 dark:text-green-300 bg-green-500/10" : "border-red-500/30 text-red-500 bg-red-500/10"}`}>
                {testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                <span>{testResult.message}</span>
              </div>
            )}

            {/* Bucket picker (columns/lists/statuses) — appears after a successful Test. */}
            {bucketSpec && bucketGroups && bucketGroups.length > 0 && (
              <div className="border rounded-lg p-3 space-y-3 bg-muted/20">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">
                    {bucketSpec.label} to import
                    {!bucketSpec.required && <span className="text-muted-foreground font-normal"> (optional)</span>}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{selectedBuckets.size} selected</span>
                </div>
                {!bucketSpec.required && (
                  <p className="text-[11px] text-muted-foreground">Leave all unchecked to import every open issue.</p>
                )}
                {bucketGroups.map((group) => {
                  const allSelected = group.buckets.length > 0 && group.buckets.every((b) => selectedBuckets.has(b.id));
                  return (
                    <div key={group.groupId} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-foreground">{group.groupName}</span>
                        <button
                          type="button"
                          onClick={() => toggleGroupBuckets(group, !allSelected)}
                          className="text-[11px] text-primary hover:underline"
                        >
                          {allSelected ? "Clear all" : "Select all"}
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        {group.buckets.map((b) => (
                          <label key={b.id} className="flex items-center gap-2 text-xs cursor-pointer">
                            <input
                              type="checkbox"
                              className="w-3.5 h-3.5"
                              checked={selectedBuckets.has(b.id)}
                              onChange={() => toggleBucket(b.id)}
                            />
                            <span className="truncate">{b.title}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex items-center gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={handleTest} disabled={testing || saving}>
                {testing ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
                Test connection
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saveDisabled} title={bucketSpec?.required && !connectionOk ? `Test the connection and select ${bucketSpec.label.toLowerCase()} first` : undefined}>
                {saving ? "Saving…" : "Save"}
              </Button>
              <div className="ml-auto">
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleRemove} disabled={saving}>
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Disconnect
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── connect-a-tracker picker ────────────────────────────────────────────────────

function ConnectPicker({
  statuses,
  onPick,
  onClose,
}: {
  statuses: IssueSourceStatus[];
  onPick: (source: IssueSource) => void;
  onClose: () => void;
}) {
  const configuredSet = new Set(statuses.filter((s) => s.configured).map((s) => s.source));
  // GitHub is configured via global settings, so never offer it here.
  const connectable = ISSUE_SOURCE_DESCRIPTORS.filter((d) => !d.usesGlobalConfig);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-background border rounded-lg shadow-lg w-full max-w-md mx-4 p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold mb-3">Connect a tracker</h3>
        <div className="space-y-1.5">
          {connectable.map((d) => (
            <button
              key={d.source}
              onClick={() => onPick(d.source)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border hover:bg-muted/50 text-left transition-colors"
            >
              <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${SOURCE_BADGE_CLASS[d.source]}`}>{d.badge}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{d.label}</div>
                <div className="text-[11px] text-muted-foreground truncate">{d.configHint}</div>
              </div>
              {configuredSet.has(d.source) ? (
                <span className="text-[10px] text-green-600 dark:text-green-400">Connected</span>
              ) : (
                <Plus className="w-4 h-4 text-muted-foreground" />
              )}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" className="w-full mt-4" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

// ── main panel ───────────────────────────────────────────────────────────────

export function Issues({ projectId }: IssuesProps) {
  const [statuses, setStatuses] = useState<IssueSourceStatus[]>([]);
  const [activeSource, setActiveSource] = useState<IssueSource>("github");
  const [issues, setIssues] = useState<ExternalIssue[]>([]);
  // Live from the kanban store — reflects create/delete/rename instantly.
  const tasks = useKanbanStore((s) => s.tasks);
  const loadKanbanTasks = useKanbanStore((s) => s.loadTasks);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState("open");
  const [search, setSearch] = useState("");
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [configureSource, setConfigureSource] = useState<IssueSource | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  const activeDescriptor = getIssueSourceDescriptor(activeSource);
  const activeConfigured = useMemo(
    () => statuses.find((s) => s.source === activeSource)?.configured ?? false,
    [statuses, activeSource],
  );

  const loadStatuses = useCallback(async () => {
    try {
      const res = await rpc.listIssueSources(projectId);
      setStatuses(res);
    } catch {
      /* empty */
    }
  }, [projectId]);

  // Tabs to show: GitHub (always) + any configured source.
  const visibleSources = useMemo<IssueSource[]>(() => {
    const configured = statuses.filter((s) => s.configured).map((s) => s.source);
    const set = new Set<IssueSource>(["github", ...configured]);
    return ISSUE_SOURCE_DESCRIPTORS.filter((d) => set.has(d.source)).map((d) => d.source);
  }, [statuses]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await rpc.getExternalIssues(projectId, activeSource, filter === "all" ? undefined : filter);
      setIssues(res);
    } catch {
      setIssues([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, activeSource, filter]);

  useEffect(() => {
    loadStatuses();
  }, [loadStatuses]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Ensure the kanban store has this project's tasks loaded (the store is the
  // single source of truth, so deletes/creates elsewhere reflect here live).
  useEffect(() => {
    loadKanbanTasks(projectId);
  }, [projectId, loadKanbanTasks]);

  // After a card action, refresh the issue list (link badges). Task changes are
  // already reactive via the kanban store, so no manual task reload is needed.
  const handleChanged = useCallback(() => {
    refresh();
  }, [refresh]);

  // Client-side search across the currently-loaded issues for this source.
  const filteredIssues = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return issues;
    return issues.filter((i) => {
      const haystack = [
        i.title,
        displayBody(i.body),
        i.assignee ?? "",
        i.sourceId,
        i.labels.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [issues, search]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await rpc.syncIssueSource(projectId, activeSource);
      if (res.error) {
        setSyncResult(`Error: ${res.error}`);
      } else {
        setSyncResult(`Synced ${res.synced} (${res.created} new, ${res.closed} closed)`);
        await refresh();
      }
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Source tabs */}
      <div className="flex items-center gap-1 border-b pb-2 overflow-x-auto">
        {visibleSources.map((source) => {
          const d = requireIssueSourceDescriptor(source);
          return (
            <button
              key={source}
              onClick={() => {
                setActiveSource(source);
                setSyncResult(null);
              }}
              className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap ${
                activeSource === source
                  ? "border-primary bg-primary/10 text-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              <span className={`text-[9px] px-1 py-0 rounded border font-semibold ${SOURCE_BADGE_CLASS[source]}`}>{d.badge}</span>
              {d.label}
            </button>
          );
        })}
        <button
          onClick={() => setShowPicker(true)}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors whitespace-nowrap"
          title="Connect another tracker"
        >
          <Plus className="w-3.5 h-3.5" /> Connect
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 shrink-0">
          {["open", "closed", "all"].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`text-xs px-2 py-0.5 rounded capitalize ${filter === s ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search issues…"
            className="w-full text-xs pl-7 pr-2 py-1 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!activeDescriptor?.usesGlobalConfig && (
            <Tip content={`Configure ${activeDescriptor?.label}`}>
              <button onClick={() => setConfigureSource(activeSource)} className="p-1 rounded hover:bg-muted">
                <Settings2 className="w-3.5 h-3.5" />
              </button>
            </Tip>
          )}
          <Tip content="Reload from local database">
            <button onClick={refresh} disabled={loading} className="p-1 rounded hover:bg-muted disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </Tip>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : `Sync ${activeDescriptor?.label ?? ""}`}
          </button>
        </div>
      </div>

      {syncResult && (
        <div className={`text-xs px-3 py-2 rounded border ${syncResult.startsWith("Error") ? "border-red-500/30 text-red-400 bg-red-500/10" : "border-green-500/30 text-foreground bg-green-500/10"}`}>
          {syncResult}
        </div>
      )}

      {/* Empty / unconfigured states */}
      {!activeConfigured && !activeDescriptor?.usesGlobalConfig && (
        <div className="text-center py-6 text-sm text-muted-foreground">
          <p className="mb-2">{activeDescriptor?.label} isn't connected yet.</p>
          <Button size="sm" variant="outline" onClick={() => setConfigureSource(activeSource)}>
            <Settings2 className="w-3.5 h-3.5 mr-1" /> Configure {activeDescriptor?.label}
          </Button>
        </div>
      )}

      {issues.length === 0 && !loading && !syncResult && (activeConfigured || activeDescriptor?.usesGlobalConfig) && (
        <div className="text-center py-6 text-sm text-muted-foreground">
          <p className="mb-1">No {filter !== "all" ? filter : ""} issues synced</p>
          <p className="text-xs">Click "Sync {activeDescriptor?.label}" to fetch issues.</p>
          {activeSource === "github" && (
            <p className="text-xs mt-2 opacity-70">
              Requires: GitHub Repository URL in Project Settings › General and a Personal Access Token in Settings › GitHub.
            </p>
          )}
        </div>
      )}

      {/* Search returned nothing (but there are issues loaded). */}
      {issues.length > 0 && filteredIssues.length === 0 && (
        <div className="text-center py-6 text-sm text-muted-foreground">
          No issues match "{search}".
        </div>
      )}

      <div className="space-y-1.5">
        {filteredIssues.map((issue) => (
          <IssueCard key={issue.id} projectId={projectId} issue={issue} tasks={tasks} onChanged={handleChanged} />
        ))}
      </div>

      {configureSource && (
        <ConfigureDialog
          projectId={projectId}
          source={configureSource}
          onClose={() => setConfigureSource(null)}
          onSaved={() => {
            loadStatuses();
            refresh();
          }}
        />
      )}

      {showPicker && (
        <ConnectPicker
          statuses={statuses}
          onPick={(source) => {
            setShowPicker(false);
            setActiveSource(source);
            setConfigureSource(source);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
