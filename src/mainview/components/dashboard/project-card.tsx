import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { relativeTimeVerbose } from "@/lib/date-utils";
import { Circle, CloudOff, FolderOpen, GitBranch, Github, Loader2, MoreVertical, RotateCcw, Trash2 } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";

import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import { IS_REMOTE } from "@/lib/remote-transport";
import { useUnreadStore, hasAnyUnread } from "@/stores/unread-store";
import { UnreadDot } from "@/components/ui/unread-dot";

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  workspacePath: string;
  githubUrl: string | null;
  workingBranch: string | null;
  createdAt: string;
  updatedAt: string;
  workspaceOffline?: boolean;
}

interface ProjectCardProps {
  project: Project;
  onDelete?: (id: string) => void;
  onRestore?: (id: string) => void;
  onPermanentDelete?: (id: string) => void;
  onStatusChange?: (id: string, status: string) => void;
  activeAgentCount?: number;
  taskStats?: { done: number; total: number };
  collapsed?: boolean;
  workspaceOffline?: boolean;
}

const STATUS_OPTIONS: { value: BadgeStatus; label: string; color: string }[] = [
  { value: "active", label: "Active", color: "text-green-500" },
  { value: "paused", label: "Paused", color: "text-yellow-500" },
  { value: "completed", label: "Completed", color: "text-blue-500" },
  { value: "archived", label: "Archived", color: "text-muted-foreground" },
];

const STATUS_DOT_COLOR: Record<string, string> = {
  active: "bg-green-500",
  paused: "bg-yellow-500",
  completed: "bg-blue-500",
  deleted: "bg-red-500",
  archived: "bg-muted-foreground",
};

type BadgeStatus = "active" | "paused" | "completed" | "archived" | "deleted";

function toStatus(raw: string): BadgeStatus {
  const allowed: BadgeStatus[] = ["active", "paused", "completed", "archived", "deleted"];
  return (allowed.includes(raw as BadgeStatus) ? raw : "active") as BadgeStatus;
}

export function ProjectCard({ project, onDelete, onRestore, onPermanentDelete, onStatusChange, activeAgentCount = 0, taskStats, collapsed = false, workspaceOffline = false }: ProjectCardProps) {
  const navigate = useNavigate();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmPermanentDeleteOpen, setConfirmPermanentDeleteOpen] = useState(false);
  // Unread agent activity anywhere in this project (chat, issue fixer, …).
  const unread = useUnreadStore(hasAnyUnread(project.id));

  const isDeleted = project.status === "deleted";

  function handleCardClick() {
    if (isDeleted) return;
    navigate({ to: "/project/$projectId", params: { projectId: project.id } });
  }

  function handleDeleteClick(event: React.MouseEvent) {
    event.stopPropagation();
    setConfirmDeleteOpen(true);
  }

  function handleConfirmDelete() {
    onDelete?.(project.id);
  }

  const updatedAgo = relativeTimeVerbose(project.updatedAt);
  const hasTasks = taskStats && taskStats.total > 0;
  const taskPct = hasTasks ? Math.round((taskStats.done / taskStats.total) * 100) : 0;

  return (
    <>
      <div
        className={cn(
          "group relative flex w-full min-w-0 flex-1 flex-col rounded-xl border-2 bg-card transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          isDeleted
            ? "opacity-50 cursor-default"
            : workspaceOffline
              ? "cursor-pointer border-amber-400/60 hover:border-amber-400"
              : "cursor-pointer hover:border-primary/40",
        )}
        role="article"
        tabIndex={0}
        aria-label={`Project: ${project.name}`}
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (!isDeleted && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            handleCardClick();
          }
        }}
      >
        {/* Card body */}
        <div className={cn("flex flex-1 flex-col gap-3 px-4", collapsed ? "pt-2.5 pb-1.5" : "pt-2.5 pb-4")}>
          {/* Top row: status + name + menu */}
          <div className="flex items-start gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1 pt-0.5">
              {collapsed && (
                <span className={cn("shrink-0 w-2 h-2 rounded-full", STATUS_DOT_COLOR[project.status] ?? "bg-muted-foreground")} aria-hidden="true" />
              )}
              <h3 className="text-sm font-semibold leading-snug line-clamp-1 min-w-0">
                {project.name}{collapsed && hasTasks && ` (${taskPct}%)`}
              </h3>
              {unread && !isDeleted && <UnreadDot />}
              {workspaceOffline && (
                <Tip content="Workspace folder is temporarily unreachable (cloud or network path offline). The project is safe — it will reappear normally once the path is available again." side="top">
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    <CloudOff className="h-2.5 w-2.5" />
                    Offline
                  </span>
                </Tip>
              )}
            </div>
            <div className="shrink-0 -mt-0.5 -mr-1.5" onClick={(e) => e.stopPropagation()}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Project options"
                  >
                    <MoreVertical className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {isDeleted ? (
                    <>
                      <DropdownMenuItem onClick={() => onRestore?.(project.id)}>
                        <RotateCcw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                        Restore Project
                      </DropdownMenuItem>
                      {!IS_REMOTE && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => rpc.openInExplorer(project.workspacePath).catch(() => {})}
                          >
                            <FolderOpen aria-hidden="true" />
                            Show in Explorer
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={(e) => { e.stopPropagation(); setConfirmPermanentDeleteOpen(true); }}
                      >
                        <Trash2 aria-hidden="true" />
                        Permanently Delete
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Circle className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                          Change Status
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {STATUS_OPTIONS.map((opt) => (
                            <DropdownMenuItem
                              key={opt.value}
                              disabled={project.status === opt.value}
                              onClick={() => onStatusChange?.(project.id, opt.value)}
                            >
                              <Circle className={cn("mr-2 h-2.5 w-2.5 fill-current", opt.color)} aria-hidden="true" />
                              {opt.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      {!IS_REMOTE && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => rpc.openInExplorer(project.workspacePath).catch(() => {})}
                          >
                            <FolderOpen aria-hidden="true" />
                            Show in Explorer
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={handleDeleteClick}
                      >
                        <Trash2 aria-hidden="true" />
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Description + meta — hidden when collapsed */}
          <div className={cn("flex flex-1 flex-col justify-center gap-3", collapsed && "hidden")}>
          {project.description ? (
            <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
              {project.description}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground/50 italic">No description</p>
          )}

          {/* Meta chips: branch, github */}
          {(project.workingBranch || project.githubUrl) && (
            <div className="flex items-center gap-2 flex-wrap">
              {project.workingBranch && (
                <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  <GitBranch className="h-2.5 w-2.5" aria-hidden="true" />
                  {project.workingBranch}
                </span>
              )}
              {project.githubUrl && (
                <Tip content={project.githubUrl} side="bottom">
                  <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground max-w-[180px]">
                    <Github className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{project.githubUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}</span>
                  </span>
                </Tip>
              )}
            </div>
          )}

          {/* Task progress */}
          {hasTasks && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                {taskStats.done}/{taskStats.total}
              </span>
              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${taskPct}%` }}
                />
              </div>
              <span className="text-[11px] font-medium text-muted-foreground shrink-0 tabular-nums">
                {taskPct}%
              </span>
            </div>
          )}
          </div>
        </div>

        {/* Footer — hidden when collapsed */}
        <div className={cn("flex items-center border-t px-4 py-2 mt-auto", collapsed && "hidden")}>
          <StatusBadge status={toStatus(project.status)} size="sm" />
          {activeAgentCount > 0 && (
            <div className="flex-1 flex justify-center">
              <div className="flex items-center gap-1.5 rounded-full bg-emerald-600 pl-2 pr-2.5 py-1">
                <Loader2 className="h-2.5 w-2.5 animate-spin text-white" aria-hidden="true" />
                <span className="text-[11px] font-medium text-white tabular-nums leading-none">
                  {activeAgentCount} Agent{activeAgentCount !== 1 ? "s" : ""}
                </span>
              </div>
            </div>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">
            {updatedAgo}
          </span>
        </div>
      </div>

      <ConfirmationDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="Delete project"
        description={`Are you sure you want to delete "${project.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />

      <ConfirmationDialog
        open={confirmPermanentDeleteOpen}
        onOpenChange={setConfirmPermanentDeleteOpen}
        title="Permanently delete project"
        description={`This will permanently delete "${project.name}" including all chats, tasks, notes, and its entire source code folder on disk. This cannot be undone. Are you sure?`}
        confirmLabel="Yes, Delete Everything"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => onPermanentDelete?.(project.id)}
      />
    </>
  );
}
