import { useState } from "react";
import { GitBranch, Plus, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { rpc } from "../../lib/rpc";

interface Branch { name: string; isCurrent: boolean; isRemote: boolean; }

interface BranchListProps {
  projectId: string;
  branches: Branch[];
  onRefresh: () => void;
}

export function BranchList({ projectId, branches, onRefresh }: BranchListProps) {
  const [newBranch, setNewBranch] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!newBranch.trim()) return;
    setCreating(true);
    await rpc.gitCreateBranch(projectId, newBranch.trim());
    setNewBranch("");
    setCreating(false);
    onRefresh();
  };

  const handleSwitch = async (name: string) => {
    await rpc.gitCheckout(projectId, name);
    onRefresh();
  };

  const handleDelete = async (e: React.MouseEvent, branchName: string) => {
    e.stopPropagation();
    setDeleteError(null);
    setDeleting(branchName);
    try {
      // Switch to main or master first so we're not on the branch being deleted
      const localBranches = branches.filter(b => !b.isRemote);
      const fallback = localBranches.find(b => b.name === "main") ?? localBranches.find(b => b.name === "master");
      if (fallback) {
        await rpc.gitCheckout(projectId, fallback.name);
      }
      const res = await rpc.gitDeleteBranch(projectId, branchName);
      if (!res.success) {
        setDeleteError(res.error ?? "Failed to delete branch");
      } else {
        onRefresh();
      }
    } finally {
      setDeleting(null);
    }
  };

  const localBranches = branches.filter(b => !b.isRemote);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          placeholder="New branch name..."
          className="flex-1 text-sm px-2 py-1 rounded border bg-background"
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        />
        <button onClick={handleCreate} disabled={creating || !newBranch.trim()} className="px-2 py-1 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50">
          <Plus className="w-4 h-4" />
        </button>
      </div>
      {deleteError && (
        <p className="text-xs text-red-500 px-1">{deleteError}</p>
      )}
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {localBranches.map((branch) => (
          <div
            key={branch.name}
            className={cn("group flex items-center gap-2 px-2 py-1 rounded text-sm", branch.isCurrent ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted cursor-pointer")}
            onClick={() => !branch.isCurrent && handleSwitch(branch.name)}
          >
            <GitBranch className="w-3 h-3 shrink-0" />
            <span className="truncate flex-1">{branch.name}</span>
            {branch.isCurrent
              ? <span className="text-xs text-muted-foreground">current</span>
              : (
                <button
                  onClick={(e) => handleDelete(e, branch.name)}
                  disabled={deleting === branch.name}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-red-500 transition-opacity disabled:opacity-50"
                  title="Delete branch"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )
            }
          </div>
        ))}
      </div>
    </div>
  );
}
