import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Tip } from "../ui/tooltip";
import { AgentAvatar } from "../ui/agent-avatar";
import { useAgentColorMap } from "../../lib/use-agent-colors";
import type { KanbanTask } from "../../stores/kanban-store";

const priorityColors: Record<string, string> = {
  critical: "bg-red-500/15 text-red-400 border-red-500/30",
  high: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  medium: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  low: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

interface KanbanCardProps {
  task: KanbanTask;
  onClick?: () => void;
}

export function KanbanCard({ task, onClick }: KanbanCardProps) {
  const agentColors = useAgentColorMap();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Parse acceptance criteria to compute progress
  let criteriaProgress: string | null = null;
  if (task.acceptanceCriteria) {
    try {
      const criteria = JSON.parse(task.acceptanceCriteria) as Array<{
        text: string;
        checked: boolean;
      }>;
      if (criteria.length > 0) {
        const checked = criteria.filter((c) => c.checked).length;
        criteriaProgress = `${checked}/${criteria.length}`;
      }
    } catch {
      // Invalid JSON — skip
    }
  }

  // Parse blockedBy to check if task is blocked
  let isBlocked = false;
  if (task.blockedBy) {
    try {
      const blockers = JSON.parse(task.blockedBy) as string[];
      isBlocked = blockers.length > 0;
    } catch {
      // Invalid JSON — skip
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={cn(
        "group rounded-lg border bg-card p-3 shadow-sm cursor-grab active:cursor-grabbing",
        "hover:border-zinc-600 hover:shadow-md transition-all",
        isDragging && "opacity-50 shadow-lg ring-2 ring-primary/50",
        isBlocked && "border-dashed border-yellow-500/50",
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <h4 className="text-sm font-medium text-foreground leading-tight line-clamp-2">
          {isBlocked && (
            <Tip content="Blocked">
              <span className="inline-block mr-1 text-yellow-500">🔒</span>
            </Tip>
          )}
          {task.title}
        </h4>
      </div>

      {task.description && (
        <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
          {task.description}
        </p>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge
          className={cn(
            "text-[10px] px-1.5 py-0",
            priorityColors[task.priority] ?? priorityColors.medium,
          )}
        >
          {task.priority}
        </Badge>

        {criteriaProgress && (
          <span className="text-[10px] text-muted-foreground">
            ✓ {criteriaProgress}
          </span>
        )}

        {task.dueDate && (
          <span className="text-[10px] text-muted-foreground">
            📅 {task.dueDate}
          </span>
        )}

        {task.assignedAgentId && (
          <span className="ml-auto">
            <AgentAvatar
              name={task.assignedAgentId}
              color={agentColors.get(task.assignedAgentId)}
              size="sm"
            />
          </span>
        )}
      </div>
    </div>
  );
}
