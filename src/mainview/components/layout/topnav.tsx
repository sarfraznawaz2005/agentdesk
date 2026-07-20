import type { ReactNode } from "react";
import { FolderOpen, HardDrive, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";
import { rpc } from "@/lib/rpc";
import { IS_REMOTE } from "@/lib/remote-transport";

interface TopNavProps {
  title: string;
  workspacePath?: string;
  /** When set, shows a button that opens the app's data directory in the file explorer. */
  dataPath?: string;
  phrase?: string;
  /** Rendered immediately before the title (e.g. the project avatar). */
  beforeTitle?: ReactNode;
  /** Rendered immediately after the title + folder buttons (e.g. the live branch badge). */
  afterTitle?: ReactNode;
  /** Opens the off-canvas sidebar on mobile (TASK-487). Renders a hamburger when set. */
  onMenuClick?: () => void;
  children?: ReactNode;
}

export function TopNav({ title, workspacePath, dataPath, phrase, beforeTitle, afterTitle, onMenuClick, children }: TopNavProps) {
  return (
    <header
      className={cn(
        "relative h-14 shrink-0 grid grid-cols-[1fr_minmax(0,1fr)_1fr] items-center gap-4 px-4 md:px-6",
        "border-b border-border bg-background/60 backdrop-blur-sm"
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
      <div className="flex items-center gap-2 min-w-0 justify-self-start">
        {onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label="Open navigation menu"
            className="md:hidden shrink-0 -ml-1 mr-0.5 flex items-center justify-center w-8 h-8 rounded-md hover:bg-accent"
          >
            <Menu className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
        {beforeTitle}
        <h1 className="text-lg font-semibold text-foreground truncate">
          {title}
        </h1>
        {!IS_REMOTE && workspacePath && (
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
        {!IS_REMOTE && dataPath && (
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
      <div className="min-w-0 text-center">
        {phrase && (
          <span
            className="max-md:hidden inline-block max-w-full truncate align-middle text-lg font-bold pointer-events-none select-none"
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
      </div>
      <div className="flex items-center gap-3 justify-self-end min-w-0">
        {children}
      </div>
    </header>
  );
}
