import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";
import { KanbanCard } from "./kanban-card";
import type { KanbanTask } from "../../stores/kanban-store";

const columnStyles: Record<string, { bg: string; accent: string; dot: string }> = {
  backlog: { bg: "bg-zinc-500/5", accent: "text-zinc-400", dot: "bg-zinc-400" },
  working: { bg: "bg-blue-500/5", accent: "text-blue-400", dot: "bg-blue-400" },
  review: { bg: "bg-amber-500/5", accent: "text-amber-500", dot: "bg-amber-400" },
  done: { bg: "bg-emerald-500/5", accent: "text-emerald-400", dot: "bg-emerald-400" },
};

const columnLabels: Record<string, string> = {
  backlog: "Backlog",
  working: "Working",
  review: "Review",
  done: "Done",
};

interface KanbanColumnProps {
  columnId: string;
  tasks: KanbanTask[];
  onTaskClick?: (taskId: string) => void;
  onCreateTask?: () => void;
}

export function KanbanColumn({
  columnId,
  tasks,
  onTaskClick,
  onCreateTask,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId });
  const style = columnStyles[columnId] ?? columnStyles.backlog;
  const label = columnLabels[columnId] ?? columnId;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-col rounded-xl border min-h-[200px] flex-1",
        style.bg,
        isOver && "ring-2 ring-primary/40",
      )}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-3 border-b">
        <div className="flex items-center gap-2">
          <div className={cn("w-2.5 h-2.5 rounded-full", style.dot)} />
          <h3 className={cn("text-base font-semibold", style.accent)}>
            {label}
          </h3>
          <span className="text-sm font-semibold text-foreground tabular-nums">
            {tasks.length}
          </span>
        </div>
        {onCreateTask && (
          <Tip content={`Add task to ${label}`} side="bottom">
            <button
              onClick={onCreateTask}
              className="text-lg font-medium text-muted-foreground hover:text-foreground transition-colors px-2 py-0.5 rounded hover:bg-muted"
            >
              +
            </button>
          </Tip>
        )}
      </div>

      {/* Sortable task list */}
      <SortableContext
        items={tasks.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-col gap-2 p-2 flex-1 overflow-y-auto">
          {tasks.map((task) => (
            <KanbanCard
              key={task.id}
              task={task}
              onClick={() => onTaskClick?.(task.id)}
            />
          ))}
          {tasks.length === 0 && (
            <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">
              No tasks
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}
