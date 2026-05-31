import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { rpc } from "../../lib/rpc";

interface Commit { hash: string; author: string; message: string; date: string; }
interface CommitFile { status: string; file: string; }

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  A: { label: "A", color: "text-green-600" },
  M: { label: "M", color: "text-blue-600" },
  D: { label: "D", color: "text-red-600" },
  R: { label: "R", color: "text-amber-600" },
  C: { label: "C", color: "text-purple-600" },
};

function CommitRow({ commit, projectId }: { commit: Commit; projectId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<CommitFile[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleToggle() {
    if (!expanded && files === null) {
      setLoading(true);
      try {
        const result = await rpc.getCommitFiles(projectId, commit.hash);
        setFiles(result.files);
      } catch {
        setFiles([]);
      } finally {
        setLoading(false);
      }
    }
    setExpanded((v) => !v);
  }

  return (
    <div className="rounded hover:bg-muted/50 transition-colors">
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-left"
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          : <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
        <code className="text-xs text-muted-foreground shrink-0">{commit.hash}</code>
        <span className="flex-1 truncate">{commit.message}</span>
        <span className="text-xs text-muted-foreground shrink-0">{commit.author}</span>
      </button>

      {expanded && (
        <div className="pb-1 pl-7 pr-2">
          {loading ? (
            <p className="text-xs text-muted-foreground py-1">Loading...</p>
          ) : files && files.length > 0 ? (
            <div className="space-y-0.5">
              {files.map((f, i) => {
                const s = STATUS_LABEL[f.status] ?? { label: f.status, color: "text-muted-foreground" };
                return (
                  <div key={i} className="flex items-center gap-2 py-0.5">
                    <span className={`text-xs font-mono font-medium w-3 flex-shrink-0 ${s.color}`}>{s.label}</span>
                    <span className="text-xs font-mono">{f.file}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground py-1">No file changes</p>
          )}
        </div>
      )}
    </div>
  );
}

interface CommitLogProps {
  commits: Commit[];
  projectId: string;
}

export function CommitLog({ commits, projectId }: CommitLogProps) {
  return (
    <div className="overflow-y-auto max-h-48">
      {commits.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No commits yet</p>
      ) : (
        <div className="space-y-0.5">
          {commits.map((c) => (
            <CommitRow key={c.hash} commit={c} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  );
}
