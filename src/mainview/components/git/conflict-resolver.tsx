import { useState, useEffect, useCallback } from "react";
import { AlertTriangle, X, RefreshCw, ChevronRight, Sparkles } from "lucide-react";
import { rpc } from "../../lib/rpc";
import { Tip } from "@/components/ui/tooltip";
import { useChatStore } from "../../stores/chat-store";

interface ConflictResolverProps {
  projectId: string;
}

export function ConflictResolver({ projectId }: ConflictResolverProps) {
  const [conflictFiles, setConflictFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [loading, setLoading] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [resolving, setResolving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await rpc.getConflicts(projectId);
      setConflictFiles(res.files);
      if (res.files.length > 0 && !selectedFile) {
        setSelectedFile(res.files[0]);
      } else if (res.files.length === 0) {
        setSelectedFile(null);
        setDiff("");
      }
    } catch { /* empty */ } finally {
      setLoading(false);
    }
  }, [projectId, selectedFile]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!selectedFile) { setDiff(""); return; }
    rpc.getConflictDiff(projectId, selectedFile).then((r) => setDiff(r.diff)).catch(() => {});
  }, [projectId, selectedFile]);

  // Re-check conflicts whenever an agent run finishes — so after "Resolve with AI"
  // commits the merge, the conflict list clears without a manual refresh.
  useEffect(() => {
    const onStreamComplete = () => void refresh();
    window.addEventListener("agentdesk:stream-complete", onStreamComplete);
    return () => window.removeEventListener("agentdesk:stream-complete", onStreamComplete);
  }, [refresh]);

  const handleAbort = async () => {
    setAborting(true);
    try {
      await rpc.gitAbortMerge(projectId);
      await refresh();
    } finally {
      setAborting(false);
    }
  };

  // Hand the conflicts to the PM: open a fresh project-chat conversation seeded with a
  // prompt describing the conflicted files, then jump to the Chat tab. The agent team
  // resolves the conflicts (analysing both sides), stages, and commits the merge.
  const handleResolveWithAI = async () => {
    if (conflictFiles.length === 0) return;
    setResolving(true);
    try {
      const fileList = conflictFiles.map((f) => `- ${f}`).join("\n");
      const prompt = [
        "There are unresolved Git **merge conflicts** in this project's working tree that need to be resolved.",
        "",
        `Conflicted files (${conflictFiles.length}):`,
        fileList,
        "",
        "Please resolve every conflict correctly — do NOT just pick one side:",
        "1. Open each conflicted file and read both sides of each conflict (the `<<<<<<<` / `=======` / `>>>>>>>` markers).",
        "2. Produce the correct merged result, preserving the intended behaviour from BOTH branches where appropriate.",
        "3. Remove all conflict markers.",
        "4. Stage the resolved files (`git add`) and complete the merge with a commit.",
        "5. Verify the project still builds / tests pass if applicable.",
        "",
        "Do NOT abort the merge. If a conflict is genuinely ambiguous, explain the options before deciding.",
      ].join("\n");
      await useChatStore.getState().startConversationWithMessage(projectId, prompt);
      window.dispatchEvent(new CustomEvent("agentdesk:switch-tab", { detail: { tab: "chat" } }));
    } finally {
      setResolving(false);
    }
  };

  if (conflictFiles.length === 0) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-1 py-1">
        <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
        No merge conflicts
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-amber-500">
          <AlertTriangle className="w-4 h-4" />
          <span className="text-xs font-semibold">{conflictFiles.length} conflict{conflictFiles.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="flex items-center gap-1">
          <Tip content="Refresh conflicts">
            <button onClick={refresh} disabled={loading} className="p-1 rounded hover:bg-muted disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </Tip>
          <Tip content="Open a chat with the agent team to resolve these conflicts">
            <button
              onClick={handleResolveWithAI}
              disabled={resolving}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              <Sparkles className="w-3 h-3" />
              {resolving ? "Starting…" : "Resolve with AI"}
            </button>
          </Tip>
          <button
            onClick={handleAbort}
            disabled={aborting}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-red-500/30 text-red-700 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
          >
            <X className="w-3 h-3" />
            {aborting ? "Aborting…" : "Abort merge"}
          </button>
        </div>
      </div>

      <div className="flex gap-3 h-48">
        {/* File list */}
        <div className="w-40 shrink-0 border rounded overflow-y-auto">
          {conflictFiles.map((file) => (
            <button
              key={file}
              onClick={() => setSelectedFile(file)}
              className={`w-full text-left px-2 py-1.5 text-xs flex items-center gap-1 border-b last:border-b-0 ${
                selectedFile === file ? "bg-amber-500/15 text-amber-800 dark:text-amber-300" : "hover:bg-muted"
              }`}
            >
              <ChevronRight className="w-3 h-3 shrink-0" />
              <span className="truncate">{file.split("/").pop()}</span>
            </button>
          ))}
        </div>

        {/* Diff viewer */}
        <div className="flex-1 border rounded overflow-auto bg-muted/10">
          <pre className="text-xs font-mono p-3 whitespace-pre leading-relaxed">
            {diff ? colorizeConflictDiff(diff) : "(select a file to view conflicts)"}
          </pre>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Resolve conflicts in your editor, then stage the resolved files and commit.
      </p>
    </div>
  );
}

/** Returns the diff with conflict markers highlighted via inline spans */
function colorizeConflictDiff(diff: string): React.ReactNode {
  const lines = diff.split("\n");
  return lines.map((line, i) => {
    let cls = "";
    if (line.startsWith("<<<<<<<")) cls = "text-red-700 dark:text-red-400 font-bold";
    else if (line.startsWith("=======")) cls = "text-yellow-700 dark:text-yellow-300 font-bold";
    else if (line.startsWith(">>>>>>>")) cls = "text-green-700 dark:text-green-400 font-bold";
    else if (line.startsWith("+")) cls = "text-green-700 dark:text-green-400";
    else if (line.startsWith("-")) cls = "text-red-700 dark:text-red-400";
    return (
      <span key={i} className={cls || "text-muted-foreground"}>
        {line}
        {"\n"}
      </span>
    );
  });
}
