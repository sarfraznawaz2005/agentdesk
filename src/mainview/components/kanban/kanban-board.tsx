import { useCallback, useEffect, useMemo, useState } from "react";
import { rpc } from "@/lib/rpc";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useKanbanStore, type KanbanTask, type KanbanColumn as KanbanCol } from "../../stores/kanban-store";
import { KanbanColumn } from "./kanban-column";
import { KanbanCard } from "./kanban-card";
import { KanbanStatsBar } from "./kanban-stats-bar";
import { KanbanFilters } from "./kanban-filters";

const COLUMNS: KanbanCol[] = ["backlog", "working", "review", "done"];

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

interface KanbanBoardProps {
  projectId: string;
  onTaskClick?: (taskId: string) => void;
  onCreateTask?: (column: KanbanCol) => void;
}

export function KanbanBoard({ projectId, onTaskClick, onCreateTask }: KanbanBoardProps) {
  const tasks = useKanbanStore((s) => s.tasks);
  const loadTasks = useKanbanStore((s) => s.loadTasks);
  const moveTask = useKanbanStore((s) => s.moveTask);
  const deleteTask = useKanbanStore((s) => s.deleteTask);
  const isLoading = useKanbanStore((s) => s.isLoading);

  const [activeTask, setActiveTask] = useState<KanbanTask | null>(null);

  // Filter / search / sort state
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"priority" | "due_date" | "created_at">("priority");
  const [filterPriority, setFilterPriority] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState<string | null>(null);
  const [newConvPerTask, setNewConvPerTask] = useState(false);

  // Apply filtering and sorting
  const filteredTasks = useMemo(() => {
    let result = tasks;

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q),
      );
    }

    // Priority filter
    if (filterPriority) {
      result = result.filter((t) => t.priority === filterPriority);
    }

    // Agent filter
    if (filterAgent) {
      result = result.filter((t) => t.assignedAgentId === filterAgent);
    }

    // Sort
    result = [...result].sort((a, b) => {
      if (sortBy === "priority") {
        return (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
      }
      if (sortBy === "due_date") {
        return (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
      }
      return a.createdAt.localeCompare(b.createdAt);
    });

    return result;
  }, [tasks, searchQuery, sortBy, filterPriority, filterAgent]);

  const getFilteredTasksByColumn = useCallback(
    (column: KanbanCol) => filteredTasks.filter((t) => t.column === column),
    [filteredTasks],
  );

  // Require minimum drag distance to avoid accidental drags
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  useEffect(() => {
    loadTasks(projectId);
  }, [projectId, loadTasks]);

  // Load the per-project "new conversation per task" setting
  useEffect(() => {
    rpc.getSetting(`project:${projectId}:newConvPerTask`, "project")
      .then((res) => { if (res) setNewConvPerTask(true); })
      .catch(() => {});
  }, [projectId]);

  const handleNewConvPerTaskChange = useCallback((value: boolean) => {
    setNewConvPerTask(value);
    rpc.saveSetting(`project:${projectId}:newConvPerTask`, value, "project").catch(() => {});
  }, [projectId]);

  const handleDeleteAll = useCallback(async () => {
    const ids = tasks.map((t) => t.id);
    await Promise.all(ids.map((id) => deleteTask(id)));
  }, [tasks, deleteTask]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const task = tasks.find((t) => t.id === event.active.id);
      setActiveTask(task ?? null);
    },
    [tasks],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTask(null);

      const { active, over } = event;
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      // Determine the target column
      const overTask = tasks.find((t) => t.id === overId);
      const targetColumn = overTask
        ? overTask.column
        : COLUMNS.includes(overId as KanbanCol)
          ? overId
          : null;

      if (!targetColumn) return;

      const sourceTask = tasks.find((t) => t.id === activeId);
      if (!sourceTask) return;

      // If same column and same position, nothing to do
      if (sourceTask.column === targetColumn && activeId === overId) return;

      // Compute new position
      const columnTasks = tasks
        .filter((t) => t.column === targetColumn && t.id !== activeId)
        .sort((a, b) => a.position - b.position);

      let newPosition: number;
      if (overTask && overTask.column === targetColumn) {
        const overIndex = columnTasks.findIndex((t) => t.id === overId);
        newPosition = overIndex >= 0 ? overIndex : columnTasks.length;
      } else {
        newPosition = columnTasks.length;
      }

      moveTask(activeId, targetColumn as KanbanCol, newPosition);
    },
    [tasks, moveTask],
  );

  if (isLoading && tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading kanban board...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <KanbanStatsBar projectId={projectId} />
      <KanbanFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        sortBy={sortBy}
        onSortChange={setSortBy}
        filterPriority={filterPriority}
        onFilterPriorityChange={setFilterPriority}
        filterAgent={filterAgent}
        onFilterAgentChange={setFilterAgent}
        onDeleteAll={tasks.length > 0 ? handleDeleteAll : undefined}
        newConvPerTask={newConvPerTask}
        onNewConvPerTaskChange={handleNewConvPerTaskChange}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-3 flex-1 p-4 overflow-x-auto min-h-0">
          {COLUMNS.map((col) => (
            <KanbanColumn
              key={col}
              columnId={col}
              tasks={getFilteredTasksByColumn(col)}
              onTaskClick={onTaskClick}
              onCreateTask={onCreateTask ? () => onCreateTask(col) : undefined}
            />
          ))}
        </div>

        <DragOverlay>
          {activeTask ? (
            <div className="opacity-90 rotate-2 scale-105">
              <KanbanCard task={activeTask} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
