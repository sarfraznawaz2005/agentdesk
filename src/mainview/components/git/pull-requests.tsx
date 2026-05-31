import { useState, useEffect, useCallback } from "react";
import { GitPullRequest, Plus, Merge, MessageSquare, RefreshCw, ChevronDown, ChevronUp, X } from "lucide-react";
import { rpc } from "../../lib/rpc";
import { Tip } from "@/components/ui/tooltip";
import { Dialog, DialogContent } from "../ui/dialog";

type PR = Awaited<ReturnType<typeof rpc.getPullRequests>>[number];
type Comment = Awaited<ReturnType<typeof rpc.getPrComments>>[number];

interface PullRequestsProps {
  projectId: string;
  branches: Array<{ name: string; isCurrent: boolean; isRemote: boolean }>;
  onBranchChange?: () => void;
}

// ── PR List ───────────────────────────────────────────────────────────────────

function stateColor(state: string) {
  if (state === "open") return "bg-green-500/20 text-green-700 dark:text-green-300 border-green-500/30";
  if (state === "merged") return "bg-purple-500/20 text-purple-700 dark:text-purple-300 border-purple-500/30";
  if (state === "closed") return "bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/30";
  return "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300 border-yellow-500/30";
}

// ── PR Detail ─────────────────────────────────────────────────────────────────

function PrDetail({ pr, onClose, onRefresh }: { pr: PR; onClose: () => void; onRefresh: () => void }) {
  const [diff, setDiff] = useState("");
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState("");
  const [merging, setMerging] = useState(false);
  const [mergeStrategy, setMergeStrategy] = useState<"merge" | "squash" | "rebase">("merge");
  const [deleteBranchAfterMerge, setDeleteBranchAfterMerge] = useState(true);
  const [showDiff, setShowDiff] = useState(false);
  const [addingComment, setAddingComment] = useState(false);

  useEffect(() => {
    rpc.getPrDiff(pr.id).then((r) => setDiff(r.diff)).catch(() => {});
    rpc.getPrComments(pr.id).then(setComments).catch(() => {});
  }, [pr.id]);

  const handleMerge = async () => {
    setMerging(true);
    try {
      const result = await rpc.mergePullRequest(pr.id, mergeStrategy, deleteBranchAfterMerge);
      if (result.success) {
        onRefresh();
        onClose();
      }
    } finally {
      setMerging(false);
    }
  };

  const handleAddComment = async () => {
    if (!newComment.trim()) return;
    setAddingComment(true);
    try {
      await rpc.addPrComment({ prId: pr.id, content: newComment.trim(), authorName: "You" });
      setNewComment("");
      const updated = await rpc.getPrComments(pr.id);
      setComments(updated);
    } finally {
      setAddingComment(false);
    }
  };

  const handleDeleteComment = async (id: string) => {
    await rpc.deletePrComment(id);
    setComments((prev) => prev.filter((c) => c.id !== id));
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs px-2 py-0.5 rounded border font-medium ${stateColor(pr.state)}`}>
                {pr.state}
              </span>
              {pr.prNumber && (
                <span className="text-xs text-muted-foreground">#{pr.prNumber}</span>
              )}
            </div>
            <h2 className="text-base font-semibold leading-tight">{pr.title}</h2>
            <p className="text-xs text-muted-foreground mt-1">
              <code className="bg-muted px-1 rounded">{pr.sourceBranch}</code>
              {" → "}
              <code className="bg-muted px-1 rounded">{pr.targetBranch}</code>
            </p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Description */}
          {pr.description && (
            <div className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed border rounded-lg p-3 bg-muted/20">
              {pr.description}
            </div>
          )}

          {/* Merge controls */}
          {pr.state === "open" && (
            <div className="p-3 border rounded-lg bg-muted/10 space-y-2.5">
              <div className="flex items-center gap-3">
                <select
                  value={mergeStrategy}
                  onChange={(e) => setMergeStrategy(e.target.value as "merge" | "squash" | "rebase")}
                  className="text-sm px-2 py-1.5 rounded border bg-background"
                >
                  <option value="merge">Merge commit</option>
                  <option value="squash">Squash and merge</option>
                  <option value="rebase">Rebase and merge</option>
                </select>
                <button
                  onClick={handleMerge}
                  disabled={merging}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-purple-600 text-white text-sm hover:bg-purple-700 disabled:opacity-50"
                >
                  <Merge className="w-3.5 h-3.5" />
                  {merging ? "Merging…" : "Merge"}
                </button>
                <button
                  onClick={async () => {
                    await rpc.updatePullRequest({ id: pr.id, state: "closed" });
                    onRefresh();
                    onClose();
                  }}
                  className="px-3 py-1.5 rounded border text-sm hover:bg-muted"
                >
                  Close PR
                </button>
              </div>
              {pr.sourceBranch !== pr.targetBranch && (
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input
                    type="checkbox"
                    checked={deleteBranchAfterMerge}
                    onChange={(e) => setDeleteBranchAfterMerge(e.target.checked)}
                    className="w-3.5 h-3.5"
                  />
                  <span className="text-xs text-muted-foreground">Delete branch after merge</span>
                </label>
              )}
            </div>
          )}

          {/* Diff viewer */}
          <div>
            <button
              onClick={() => setShowDiff((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground"
            >
              {showDiff ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              Diff
            </button>
            {showDiff && (
              <pre className="mt-2 text-xs font-mono bg-muted/30 border rounded p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre">
                {diff || "(no diff available)"}
              </pre>
            )}
          </div>

          {/* Comments */}
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1">
              <MessageSquare className="w-3 h-3" />
              Comments ({comments.length})
            </h3>
            <div className="space-y-2">
              {comments.map((c) => (
                <div key={c.id} className="border rounded-lg p-3 text-sm group relative">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-xs">{c.authorName}</span>
                    {c.file && (
                      <code className="text-xs bg-muted px-1 rounded">{c.file}{c.lineNumber ? `:${c.lineNumber}` : ""}</code>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto">{new Date(c.createdAt).toLocaleString()}</span>
                    <button
                      onClick={() => handleDeleteComment(c.id)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">{c.content}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add a comment…"
                className="flex-1 text-sm px-3 py-2 rounded border bg-background resize-none"
                rows={2}
              />
              <button
                onClick={handleAddComment}
                disabled={!newComment.trim() || addingComment}
                className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm self-end disabled:opacity-50"
              >
                {addingComment ? "…" : "Comment"}
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Create PR Form ─────────────────────────────────────────────────────────────

function CreatePrForm({
  projectId,
  branches,
  existingPrs,
  onCreated,
  onCancel,
}: {
  projectId: string;
  branches: Array<{ name: string; isCurrent: boolean; isRemote: boolean }>;
  existingPrs: PR[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const localBranches = branches.filter((b) => !b.isRemote);
  const currentBranch = localBranches.find((b) => b.isCurrent);

  // Branches that already have an open or merged PR — exclude from source dropdown
  const usedAsSources = new Set(
    existingPrs
      .filter((p) => p.state === "open" || p.state === "merged")
      .map((p) => p.sourceBranch),
  );
  const availableSourceBranches = localBranches.filter((b) => !usedAsSources.has(b.name));

  const defaultTarget =
    localBranches.find((b) => b.name === "main")?.name ??
    localBranches.find((b) => b.name === "master")?.name ??
    localBranches[0]?.name ??
    "";

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Default source: current branch if available as a source, else first available
  const defaultSource =
    (currentBranch && !usedAsSources.has(currentBranch.name) ? currentBranch.name : null) ??
    availableSourceBranches[0]?.name ??
    "";
  const [sourceBranch, setSourceBranch] = useState(defaultSource);
  const [targetBranch, setTargetBranch] = useState(defaultTarget);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [generatingDesc, setGeneratingDesc] = useState(false);

  const handleGenerate = async () => {
    if (!sourceBranch || !targetBranch) return;
    setGeneratingDesc(true);
    try {
      const res = await rpc.generatePrDescription(projectId, sourceBranch, targetBranch);
      setDescription(res.description);
    } finally {
      setGeneratingDesc(false);
    }
  };

  const handleCreate = async () => {
    if (!title.trim() || !sourceBranch || !targetBranch) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await rpc.createPullRequest({ projectId, title: title.trim(), description, sourceBranch, targetBranch });
      if (res.error) {
        setCreateError(res.error);
      } else {
        onCreated();
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="border rounded-lg p-4 bg-muted/10 space-y-3">
      <h3 className="text-sm font-semibold">New Pull Request</h3>
      <input
        type="text"
        value={title}
        onChange={(e) => { setTitle(e.target.value); setCreateError(null); }}
        placeholder="PR title"
        className={`w-full text-sm px-3 py-2 rounded border bg-background ${createError ? "border-red-500" : ""}`}
      />
      {createError && (
        <p className="text-xs text-red-500">{createError}</p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Source branch</label>
          {availableSourceBranches.length === 0 ? (
            <p className="text-xs text-muted-foreground px-2 py-1.5 border rounded bg-muted/30">
              All branches already have open or merged PRs
            </p>
          ) : (
            <select
              value={sourceBranch}
              onChange={(e) => setSourceBranch(e.target.value)}
              className="w-full text-sm px-2 py-1.5 rounded border bg-background"
            >
              {availableSourceBranches.map((b) => (
                <option key={b.name} value={b.name}>{b.name}</option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Target branch</label>
          <select
            value={targetBranch}
            onChange={(e) => setTargetBranch(e.target.value)}
            className="w-full text-sm px-2 py-1.5 rounded border bg-background"
          >
            {localBranches.map((b) => (
              <option key={b.name} value={b.name}>{b.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-muted-foreground">Description</label>
          <button
            onClick={handleGenerate}
            disabled={generatingDesc || !sourceBranch || !targetBranch}
            className="text-xs px-2 py-0.5 rounded border hover:bg-muted disabled:opacity-50"
          >
            {generatingDesc ? "Generating…" : "✨ Auto-generate"}
          </button>
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the changes in this PR…"
          className="w-full text-sm px-3 py-2 rounded border bg-background resize-none"
          rows={4}
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleCreate}
          disabled={creating || !title.trim() || !sourceBranch || !targetBranch || availableSourceBranches.length === 0}
          className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create PR"}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 rounded border text-sm hover:bg-muted">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function PullRequests({ projectId, branches, onBranchChange }: PullRequestsProps) {
  const [prs, setPrs] = useState<PR[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedPr, setSelectedPr] = useState<PR | null>(null);
  const [filter, setFilter] = useState<string>("open");
  const [featureBranches, setFeatureBranches] = useState(false);

  useEffect(() => {
    rpc.getSetting("featureBranchWorkflow", `project:${projectId}`).then((v) => {
      if (v !== null) setFeatureBranches(v === "true");
    }).catch(() => {});
  }, [projectId]);

  const toggleFeatureBranches = async (enabled: boolean) => {
    setFeatureBranches(enabled);
    await rpc.saveSetting("featureBranchWorkflow", String(enabled), `project:${projectId}`);
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await rpc.getPullRequests(projectId, filter === "all" ? undefined : filter);
      setPrs(res);
    } catch { /* empty */ }
    finally { setLoading(false); }
  }, [projectId, filter]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {["open", "merged", "closed", "all"].map((s) => (
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
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="w-3 h-3" /> New PR
          </button>
        </div>
      </div>

      {showCreate && (
        <CreatePrForm
          projectId={projectId}
          branches={branches}
          existingPrs={prs}
          onCreated={() => { setShowCreate(false); refresh(); }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {prs.length === 0 && !loading && (
        <div className="text-center py-6 text-sm text-muted-foreground">
          <GitPullRequest className="w-8 h-8 mx-auto mb-2 opacity-30" />
          No {filter !== "all" ? filter : ""} pull requests
        </div>
      )}

      <div className="space-y-2">
        {prs.map((pr) => (
          <button
            key={pr.id}
            onClick={() => setSelectedPr(pr)}
            className="w-full text-left border rounded-lg p-3 hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-start gap-2">
              <GitPullRequest className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{pr.title}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${stateColor(pr.state)}`}>
                    {pr.state}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  <code className="bg-muted px-1 rounded">{pr.sourceBranch}</code>
                  {" → "}
                  <code className="bg-muted px-1 rounded">{pr.targetBranch}</code>
                  {pr.prNumber && <span className="ml-2">#{pr.prNumber}</span>}
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>

      {selectedPr && (
        <PrDetail
          pr={selectedPr}
          onClose={() => setSelectedPr(null)}
          onRefresh={() => { refresh(); onBranchChange?.(); }}
        />
      )}

      <div className="border-t pt-3 mt-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={featureBranches}
            onChange={(e) => toggleFeatureBranches(e.target.checked)}
            className="w-4 h-4 mt-0.5 flex-shrink-0"
          />
          <div>
            <span className="text-sm">Feature branch workflow</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              When enabled, agents will create a feature branch before starting work on a task, then open a PR when done instead of committing directly to the main branch.
            </p>
          </div>
        </label>
      </div>
    </div>
  );
}
