import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { rpc } from "../../lib/rpc";

function PushDialog({ output, ok, onClose }: { output: string; ok: boolean; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className={`bg-background border rounded-lg shadow-lg w-full max-w-2xl mx-4 p-5 ${ok ? "" : "border-red-500/40"}`} onClick={(e) => e.stopPropagation()}>
        <h3 className={`text-sm font-semibold mb-3 flex items-center gap-2 ${ok ? "text-foreground" : "text-red-500"}`}>
          {ok
            ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
            : <XCircle className="w-4 h-4 shrink-0" />}
          {ok ? "Push complete" : "Push failed"}
        </h3>
        <pre className={`text-xs font-mono rounded p-3 whitespace-pre overflow-x-auto max-h-64 overflow-y-auto ${ok ? "bg-muted/40" : "bg-red-500/10 text-red-700 dark:text-red-300"}`}>
          {output}
        </pre>
        <button onClick={onClose} className="mt-4 w-full px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm">
          Close
        </button>
      </div>
    </div>
  );
}

interface FileStatus { status: string; file: string; }

interface StagedFilesProps {
  projectId: string;
  files: FileStatus[];
  onRefresh: () => void;
}

export function StagedFiles({ projectId, files, onRefresh }: StagedFilesProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [pushDialog, setPushDialog] = useState<{ output: string; ok: boolean } | null>(null);

  const toggle = (file: string) => {
    const next = new Set(selected);
    if (next.has(file)) next.delete(file); else next.add(file);
    setSelected(next);
  };

  const showFeedback = (ok: boolean, msg: string) => {
    setFeedback({ ok, msg });
    setTimeout(() => setFeedback(null), 4000);
  };

  const handleCommit = async () => {
    if (!message.trim() || selected.size === 0) return;
    setLoading(true);
    try {
      await rpc.gitStageFiles(projectId, Array.from(selected));
      const res = await rpc.gitCommit(projectId, message.trim());
      if (res.success) {
        setMessage("");
        setSelected(new Set());
        showFeedback(true, "Committed successfully");
        onRefresh();
      } else {
        showFeedback(false, res.error ?? "Commit failed");
      }
    } catch (e: unknown) {
      showFeedback(false, e instanceof Error ? e.message : "Commit failed");
    } finally {
      setLoading(false);
    }
  };

  const handlePush = async () => {
    setLoading(true);
    try {
      // Silent pull before push to reduce conflicts
      await rpc.gitPull(projectId).catch(() => {});
      const res = await rpc.gitPush(projectId);
      const raw = res.output ?? res.error ?? (res.success ? "Push complete." : "Push failed.");
      setPushDialog({ output: raw, ok: res.success });
      if (res.success) onRefresh();
    } catch (e: unknown) {
      setPushDialog({ output: e instanceof Error ? e.message : "Push failed", ok: false });
    } finally {
      setLoading(false);
    }
  };

  const allSelected = files.length > 0 && files.every((f) => selected.has(f.file));
  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(files.map((f) => f.file)));
    }
  };

  return (
    <div className="space-y-2">
      <div className="max-h-32 overflow-y-auto space-y-1">
        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-2">No modified files</p>
        ) : (
          <>
            <label className="flex items-center px-2 py-0.5 hover:bg-muted rounded cursor-pointer text-sm border-b border-border pb-1 mb-0.5">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="w-3 h-3 flex-shrink-0 mr-2" />
              <span className="text-xs text-muted-foreground">Select all</span>
            </label>
            {files.map((f) => (
              <label key={f.file} className="flex items-center px-2 py-0.5 hover:bg-muted rounded cursor-pointer text-sm">
                <input type="checkbox" checked={selected.has(f.file)} onChange={() => toggle(f.file)} className="w-3 h-3 flex-shrink-0 mr-2" />
                <span className="text-xs text-muted-foreground mr-1">{f.status}</span>
                <span className="text-xs">{f.file}</span>
              </label>
            ))}
          </>
        )}
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Commit message..."
        rows={2}
        className="w-full text-sm px-2 py-1 rounded border bg-background resize-none"
      />
      <div className="flex gap-2">
        <button onClick={handleCommit} disabled={loading || !message.trim() || selected.size === 0}
          className="flex-1 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50">
          {loading ? "Working…" : "Commit"}
        </button>
        <button onClick={handlePush} disabled={loading}
          className="px-3 py-1.5 rounded border text-sm hover:bg-muted disabled:opacity-50">
          Push
        </button>
      </div>
      {feedback && (
        <p className={`text-xs px-2 py-1.5 rounded border ${feedback.ok ? "border-green-500/30 text-green-700 dark:text-green-300 bg-green-500/10" : "border-red-500/30 text-red-600 dark:text-red-400 bg-red-500/10"}`}>
          {feedback.msg}
        </p>
      )}
      {pushDialog && <PushDialog output={pushDialog.output} ok={pushDialog.ok} onClose={() => setPushDialog(null)} />}
    </div>
  );
}
