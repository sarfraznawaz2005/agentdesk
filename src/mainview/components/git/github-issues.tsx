import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Link, ChevronRight, ChevronDown } from "lucide-react";
import { rpc } from "../../lib/rpc";
import { Tip } from "@/components/ui/tooltip";

type GhIssue = Awaited<ReturnType<typeof rpc.getGithubIssues>>[number];

interface GithubIssuesProps {
  projectId: string;
}

function IssueCard({ issue }: { issue: GhIssue }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border rounded-lg hover:bg-muted/30 transition-colors">
      <button
        type="button"
        onClick={() => issue.body ? setExpanded((v) => !v) : undefined}
        className={`w-full flex items-start gap-2 p-3 text-left ${issue.body ? "cursor-pointer" : "cursor-default"}`}
      >
        {issue.body ? (
          expanded ? <ChevronDown className="w-3 h-3 mt-0.5 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="w-3 h-3 mt-0.5 text-muted-foreground flex-shrink-0" />
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs px-1.5 py-0.5 rounded border ${stateColor(issue.state)}`}>{issue.state}</span>
            <span className="text-xs text-muted-foreground">#{issue.githubIssueNumber}</span>
            {issue.taskId && (
              <span className="text-xs bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-500/30 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                <Link className="w-2.5 h-2.5" /> Linked
              </span>
            )}
          </div>
          <p className="text-sm font-medium truncate">{issue.title}</p>
          {issue.labels.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {issue.labels.map((label) => (
                <span key={label} className="text-xs bg-muted px-1.5 py-0.5 rounded">{label}</span>
              ))}
            </div>
          )}
        </div>
      </button>
      {expanded && issue.body && (
        <div className="px-3 pb-3 pl-8">
          <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words border-t pt-2">{issue.body}</p>
        </div>
      )}
    </div>
  );
}

function stateColor(state: string) {
  return state === "open"
    ? "bg-green-500/20 text-green-700 dark:text-green-300 border-green-500/30"
    : "bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/30";
}

export function GithubIssues({ projectId }: GithubIssuesProps) {
  const [issues, setIssues] = useState<GhIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState("open");
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await rpc.getGithubIssues(projectId, filter === "all" ? undefined : filter);
      setIssues(res);
    } catch { /* empty */ } finally {
      setLoading(false);
    }
  }, [projectId, filter]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await rpc.syncGithubIssues(projectId);
      if (res.error) {
        setSyncResult(`Error: ${res.error}`);
      } else {
        setSyncResult(`Synced ${res.synced} issues (${res.created} new, ${res.closed} closed)`);
        await refresh();
      }
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
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
        <div className="flex items-center gap-1">
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
            {syncing ? "Syncing…" : "Sync from GitHub"}
          </button>
        </div>
      </div>

      {syncResult && (
        <div className={`text-xs px-3 py-2 rounded border ${syncResult.startsWith("Error") ? "border-red-500/30 text-red-400 bg-red-500/10" : "border-green-500/30 text-foreground bg-green-500/10"}`}>
          {syncResult}
        </div>
      )}

      {issues.length === 0 && !loading && !syncResult && (
        <div className="text-center py-6 text-sm text-muted-foreground">
          <p className="mb-1">No {filter !== "all" ? filter : ""} GitHub issues synced</p>
          <p className="text-xs">Click "Sync from GitHub" to fetch issues from your repository.</p>
          <p className="text-xs mt-2 opacity-70">Requires: GitHub Repository URL in Project Settings › General and a Personal Access Token in Settings › GitHub.</p>
        </div>
      )}
      {issues.length === 0 && !loading && syncResult && !syncResult.startsWith("Error") && (
        <div className="text-center py-4 text-sm text-muted-foreground">
          <p>No {filter !== "all" ? filter : ""} issues found in this repository.</p>
        </div>
      )}

      <div className="space-y-1.5">
        {issues.map((issue) => <IssueCard key={issue.id} issue={issue} />)}
      </div>
    </div>
  );
}
