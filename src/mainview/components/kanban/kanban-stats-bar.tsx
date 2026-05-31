import { useKanbanStore } from "../../stores/kanban-store";
import { cn } from "@/lib/utils";

interface StatIndicatorProps {
  label: string;
  count: number;
  dotClass: string;
  countClass: string;
}

function StatIndicator({ label, count, dotClass, countClass }: StatIndicatorProps) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={cn("w-2 h-2 rounded-full flex-shrink-0", dotClass)} />
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-xs font-semibold tabular-nums", countClass)}>
        {count}
      </span>
    </div>
  );
}

export function KanbanStatsBar({ projectId: _projectId }: { projectId?: string }) {
  const getColumnCount = useKanbanStore((s) => s.getColumnCount);
  const tasks = useKanbanStore((s) => s.tasks);

  const backlogCount = getColumnCount("backlog");
  const workingCount = getColumnCount("working");
  const reviewCount = getColumnCount("review");
  const doneCount = getColumnCount("done");
  const totalCount = tasks.length;

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-b bg-card">
      <StatIndicator label="Backlog" count={backlogCount} dotClass="bg-zinc-400" countClass="text-foreground" />
      <div className="w-px h-3 bg-border flex-shrink-0" aria-hidden="true" />
      <StatIndicator label="Working" count={workingCount} dotClass="bg-blue-400" countClass="text-foreground" />
      <div className="w-px h-3 bg-border flex-shrink-0" aria-hidden="true" />
      <StatIndicator label="Review" count={reviewCount} dotClass="bg-amber-400" countClass="text-foreground" />
      <div className="w-px h-3 bg-border flex-shrink-0" aria-hidden="true" />
      <StatIndicator label="Done" count={doneCount} dotClass="bg-emerald-400" countClass="text-foreground" />
      <div className="w-px h-3 bg-border flex-shrink-0" aria-hidden="true" />
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Total</span>
        <span className="text-xs font-semibold tabular-nums text-foreground">{totalCount}</span>
      </div>
    </div>
  );
}
