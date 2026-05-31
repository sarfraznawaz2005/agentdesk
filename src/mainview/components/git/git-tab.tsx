import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Download, CheckCircle2, XCircle } from "lucide-react";
import { rpc } from "../../lib/rpc";
import { Tip } from "@/components/ui/tooltip";
import { BranchList } from "./branch-list";
import { CommitLog } from "./commit-log";
import { DiffViewer } from "./diff-viewer";
import { StagedFiles } from "./staged-files";
import { PullRequests } from "./pull-requests";
import { ConflictResolver } from "./conflict-resolver";
import { GithubIssues } from "./github-issues";
import { WebhookEvents } from "./webhook-events";

type GitSubTab = "overview" | "pull-requests" | "conflicts" | "issues" | "webhooks";

interface GitTabProps { projectId: string; }

const GIT_SUBTABS: { id: GitSubTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "pull-requests", label: "Pull Requests" },
  { id: "conflicts", label: "Conflicts" },
  { id: "issues", label: "GitHub Issues" },
  { id: "webhooks", label: "Webhooks" },
];

export function GitTab({ projectId }: GitTabProps) {
  const [branches, setBranches] = useState<Array<{ name: string; isCurrent: boolean; isRemote: boolean }>>([]);
  const [commits, setCommits] = useState<Array<{ hash: string; author: string; message: string; date: string }>>([]);
  const [diff, setDiff] = useState("");
  const [files, setFiles] = useState<Array<{ status: string; file: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullDialog, setPullDialog] = useState<{ output: string; ok: boolean } | null>(null);
  const [pullBranchDialog, setPullBranchDialog] = useState<{ currentBranch: string } | null>(null);
  const [pullBranchInput, setPullBranchInput] = useState("");
  const [subTab, setSubTab] = useState<GitSubTab>("overview");

  // Auto-commit settings state
  const [autoCommitEnabled, setAutoCommitEnabled] = useState(false);
  const [commitMessageFormat, setCommitMessageFormat] = useState("feat: {task}");
  const [savingSettings, setSavingSettings] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, branchRes, logRes, diffRes] = await Promise.all([
        rpc.getGitStatus(projectId),
        rpc.getGitBranches(projectId),
        rpc.getGitLog(projectId, 20),
        rpc.getGitDiff(projectId),
      ]);
      setFiles(statusRes.files);
      setBranches(branchRes.branches);
      setCommits(logRes.commits);
      setDiff(diffRes.diff);
    } catch {
      // git not available in this workspace — show empty state
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    rpc.getSetting("autoCommitEnabled", "git").then((val) => {
      if (val !== null) setAutoCommitEnabled(val === "true");
    });
    rpc.getSetting("commitMessageFormat", "git").then((val) => {
      if (val) setCommitMessageFormat(val);
    });
  }, []);

  const saveAutoCommitSettings = async () => {
    setSavingSettings(true);
    await Promise.all([
      rpc.saveSetting("autoCommitEnabled", String(autoCommitEnabled), "git"),
      rpc.saveSetting("commitMessageFormat", commitMessageFormat, "git"),
    ]);
    setSavingSettings(false);
  };

  const handlePull = async (remoteBranch?: string) => {
    setPulling(true);
    try {
      const res = await rpc.gitPull(projectId, remoteBranch);
      if (res.noTracking) {
        // No upstream set — ask user which remote branch to pull from
        const current = branches.find((b) => b.isCurrent)?.name ?? "";
        setPullBranchInput(current);
        setPullBranchDialog({ currentBranch: current });
        return;
      }
      const raw = res.output ?? res.error ?? (res.success ? "Already up to date." : "Pull failed.");
      setPullDialog({ output: raw, ok: res.success });
      if (res.success) await refresh();
    } catch (e: unknown) {
      setPullDialog({ output: e instanceof Error ? e.message : "Pull failed", ok: false });
    } finally {
      setPulling(false);
    }
  };

  const handlePullWithBranch = async () => {
    const branch = pullBranchInput.trim();
    if (!branch) return;
    setPullBranchDialog(null);
    await handlePull(branch);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Sub-navigation */}
      <div className="flex items-center gap-0.5 px-4 pt-3 pb-0 border-b overflow-x-auto shrink-0">
        {GIT_SUBTABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setSubTab(tab.id)}
            className={`text-xs px-3 py-1.5 rounded-t border-b-2 transition-colors whitespace-nowrap ${
              subTab === tab.id
                ? "border-primary text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
        {subTab === "overview" && (
          <div className="ml-auto flex items-center gap-1">
            <Tip content="Pull from remote">
              <button onClick={() => handlePull()} disabled={pulling || loading} className="p-1 rounded hover:bg-muted disabled:opacity-50">
                <Download className={`w-3.5 h-3.5 ${pulling ? "animate-pulse" : ""}`} />
              </button>
            </Tip>
            <div className="w-px h-3.5 bg-border mx-1.5" />
            <Tip content="Refresh git status">
              <button onClick={refresh} disabled={loading} className="p-1 rounded hover:bg-muted disabled:opacity-50">
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </Tip>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* Overview */}
        {subTab === "overview" && (
          <div className="flex flex-col gap-4">
            <section>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Branches</h3>
              <BranchList projectId={projectId} branches={branches} onRefresh={refresh} />
            </section>

            <section>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Changes</h3>
              <StagedFiles projectId={projectId} files={files} onRefresh={refresh} />
            </section>

            <section>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Diff</h3>
              <DiffViewer diff={diff} />
            </section>

            <section>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Commit Log</h3>
              <CommitLog commits={commits} projectId={projectId} />
            </section>

            <section>
              <details className="group">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 list-none flex items-center gap-1">
                  <svg className="w-3 h-3 transition-transform group-open:rotate-90" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M6 4l4 4-4 4V4z"/>
                  </svg>
                  Auto-Commit Settings
                </summary>
                <div className="mt-3 space-y-3 p-3 border rounded-lg bg-muted/30">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={autoCommitEnabled}
                      onChange={(e) => setAutoCommitEnabled(e.target.checked)}
                      className="w-4 h-4"
                    />
                    <span className="text-sm">Commit on task completion</span>
                  </label>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Commit message format</label>
                    <input
                      type="text"
                      value={commitMessageFormat}
                      onChange={(e) => setCommitMessageFormat(e.target.value)}
                      placeholder="feat: {task} - {description}"
                      className="w-full text-sm px-2 py-1 rounded border bg-background"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {"Variables: {task}, {description}, {date}"}
                    </p>
                  </div>
                  <button
                    onClick={saveAutoCommitSettings}
                    disabled={savingSettings}
                    className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
                  >
                    Save Settings
                  </button>
                </div>
              </details>
            </section>
          </div>
        )}

        {/* Pull Requests */}
        {subTab === "pull-requests" && (
          <PullRequests projectId={projectId} branches={branches} onBranchChange={refresh} />
        )}

        {/* Conflict Resolver */}
        {subTab === "conflicts" && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Merge Conflicts</h3>
            <ConflictResolver projectId={projectId} />
          </div>
        )}

        {/* GitHub Issues */}
        {subTab === "issues" && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">GitHub Issues Sync</h3>
            <GithubIssues projectId={projectId} />
          </div>
        )}

        {/* Webhook Events */}
        {subTab === "webhooks" && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">GitHub Events</h3>
            <WebhookEvents projectId={projectId} />
          </div>
        )}

      </div>

      {/* Pull branch prompt — shown when current branch has no upstream tracking */}
      {pullBranchDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPullBranchDialog(null)}>
          <div className="bg-background border rounded-lg shadow-lg w-full max-w-md mx-4 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold mb-1">Specify remote branch</h3>
            <p className="text-xs text-muted-foreground mb-3">
              <span className="font-mono text-foreground">{pullBranchDialog.currentBranch}</span> has no upstream tracking branch.
              Enter the remote branch name to pull from:
            </p>
            <input
              autoFocus
              type="text"
              value={pullBranchInput}
              onChange={(e) => setPullBranchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handlePullWithBranch(); if (e.key === "Escape") setPullBranchDialog(null); }}
              placeholder="e.g. main or feature/my-branch"
              className="w-full text-sm px-3 py-1.5 rounded border bg-background mb-4 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex gap-2">
              <button
                onClick={handlePullWithBranch}
                disabled={!pullBranchInput.trim()}
                className="flex-1 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
              >
                Pull
              </button>
              <button
                onClick={() => setPullBranchDialog(null)}
                className="px-3 py-1.5 rounded border text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pull result dialog */}
      {pullDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPullDialog(null)}>
          <div className={`bg-background border rounded-lg shadow-lg w-full max-w-2xl mx-4 p-5 ${pullDialog.ok ? "" : "border-red-500/40"}`} onClick={(e) => e.stopPropagation()}>
            <h3 className={`text-sm font-semibold mb-3 flex items-center gap-2 ${pullDialog.ok ? "text-foreground" : "text-red-500"}`}>
              {pullDialog.ok
                ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                : <XCircle className="w-4 h-4 shrink-0" />}
              {pullDialog.ok ? "Pull complete" : "Pull failed"}
            </h3>
            <pre className={`text-xs font-mono rounded p-3 whitespace-pre overflow-x-auto max-h-64 overflow-y-auto ${pullDialog.ok ? "bg-muted/40" : "bg-red-500/10 text-red-700 dark:text-red-300"}`}>
              {pullDialog.output}
            </pre>
            <button
              onClick={() => setPullDialog(null)}
              className="mt-4 w-full px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
