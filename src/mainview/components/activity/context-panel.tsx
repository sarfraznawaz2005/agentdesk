import { useState, useRef, useCallback, useEffect } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";
import { IS_REMOTE } from "@/lib/remote-transport";
import { rpc } from "@/lib/rpc";
import { DocsTab, type DocsTabHandle } from "./docs-tab";
import { FilesTab, type FilesTabHandle } from "./files-tab";

type ContextTabId = "docs" | "files";

interface ContextPanelProps {
  projectId?: string;
  runningAgentCount?: number;
}

export function ContextPanel({ projectId }: ContextPanelProps) {
  const [activeTab, setActiveTab] = useState<ContextTabId>("files");
  const [isSpinning, setIsSpinning] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string | undefined>(undefined);
  const filesRef = useRef<FilesTabHandle>(null);
  const docsRef = useRef<DocsTabHandle>(null);

  // TopNav already shows this icon for the normal project chrome, but the
  // Quick Chat window (src/mainview/pages/quick-chat.tsx) mounts no TopNav at
  // all, so this pane is the only place it can offer "open in Explorer".
  useEffect(() => {
    let ignore = false;
    Promise.resolve(projectId ? rpc.getProject(projectId) : null).then((p) => {
      if (ignore) return;
      const project = p as { workspacePath?: string } | null;
      setWorkspacePath(project?.workspacePath ?? undefined);
    }).catch(() => {});
    return () => { ignore = true; };
  }, [projectId]);

  const tabs: Array<{ id: ContextTabId; label: string }> = [
    { id: "files", label: "Files" },
    { id: "docs", label: "Docs" },
  ];

  // Refresh both tabs so the user always gets fresh data regardless of which is active.
  // Brief spin animation gives the user visual confirmation that the click registered.
  const handleRefresh = useCallback(() => {
    filesRef.current?.refresh();
    docsRef.current?.refresh();
    setIsSpinning(true);
    setTimeout(() => setIsSpinning(false), 600);
  }, []);

  return (
    <div className="flex flex-col h-full bg-muted/50">
      {/* Tab header */}
      <div className="h-12 flex items-center border-b border-border px-3 shrink-0">
        <div className="flex items-center gap-4 flex-1" role="tablist" aria-label="Context panel tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "text-xs border-b-2 transition-colors",
                activeTab === tab.id
                  ? "border-indigo-500 text-indigo-600 font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {!IS_REMOTE && workspacePath && (
          <Tip content="Open Workspace in Explorer" side="bottom">
            <button
              type="button"
              onClick={() => rpc.openInExplorer(workspacePath).catch(() => {})}
              className="p-1.5 mr-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              aria-label="Open project folder in explorer"
            >
              <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </Tip>
        )}
        <Tip content="Refresh Files and Docs" side="bottom">
          <button
            type="button"
            onClick={(e) => {
              handleRefresh();
              // Drop focus so the focus-ring/outline doesn't linger after a mouse click.
              e.currentTarget.blur();
            }}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            aria-label="Refresh Files and Docs"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isSpinning && "animate-spin")} aria-hidden="true" />
          </button>
        </Tip>
      </div>

      {/* Tab content */}
      <div className={activeTab === "docs" ? "flex flex-col flex-1 min-h-0" : "hidden"}>
        <DocsTab ref={docsRef} projectId={projectId} />
      </div>
      <div className={activeTab === "files" ? "flex flex-col flex-1 min-h-0" : "hidden"}>
        <FilesTab ref={filesRef} projectId={projectId} />
      </div>
    </div>
  );
}
