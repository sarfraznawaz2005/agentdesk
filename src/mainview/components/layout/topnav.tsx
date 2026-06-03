import type { ReactNode } from "react";
import { FolderOpen, HardDrive } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";
import { rpc } from "@/lib/rpc";

interface TopNavProps {
  title: string;
  workspacePath?: string;
  /** When set, shows a button that opens the app's data directory in the file explorer. */
  dataPath?: string;
  phrase?: string;
  /** Rendered immediately after the title + folder buttons (e.g. the live branch badge). */
  afterTitle?: ReactNode;
  children?: ReactNode;
}

export function TopNav({ title, workspacePath, dataPath, phrase, afterTitle, children }: TopNavProps) {
  return (
    <header
      className={cn(
        "relative h-14 shrink-0 flex items-center justify-between px-6",
        "border-b border-border bg-background"
      )}
    >
      {phrase && (
        <style>{`
          @keyframes gradientSweep {
            0%   { background-position: 150% center; }
            100% { background-position: -50% center; }
          }
        `}</style>
      )}
      <div className="flex items-center gap-2 min-w-0">
        <h1 className="text-lg font-semibold text-foreground truncate">
          {title}
        </h1>
        {workspacePath && (
          <Tip content="Open Workspace in Explorer" side="bottom">
            <button
              onClick={() => rpc.openInExplorer(workspacePath).catch(() => {})}
              className="shrink-0 p-1 rounded text-muted-foreground/60 hover:text-foreground/80 hover:bg-muted transition-colors translate-y-px"
              aria-label="Open project folder in explorer"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
          </Tip>
        )}
        {dataPath && (
          <Tip content="Open data folder in Explorer" side="bottom">
            <button
              onClick={() => rpc.openInExplorer(dataPath).catch(() => {})}
              className="shrink-0 p-1 rounded text-muted-foreground/60 hover:text-foreground/80 hover:bg-muted transition-colors translate-y-px"
              aria-label="Open app data folder in explorer"
            >
              <HardDrive className="w-4 h-4" />
            </button>
          </Tip>
        )}
        {afterTitle}
      </div>
      {phrase && (
        <span
          className="absolute left-1/2 -translate-x-1/2 text-lg font-bold pointer-events-none select-none whitespace-nowrap"
          style={{
            backgroundImage: "linear-gradient(90deg, #3b82f6 0%, #ec4899 35%, #a855f7 65%, #3b82f6 100%)",
            backgroundSize: "200% auto",
            backgroundClip: "text",
            WebkitBackgroundClip: "text",
            color: "transparent",
            animation: "gradientSweep 3s linear infinite",
          }}
        >
          {phrase}
        </span>
      )}
      {children && (
        <div className="flex items-center gap-3 shrink-0 ml-4">
          {children}
        </div>
      )}
    </header>
  );
}
