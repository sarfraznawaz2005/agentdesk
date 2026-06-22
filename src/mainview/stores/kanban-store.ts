import { create } from "zustand";
import { rpc } from "../lib/rpc";
import { createCoalescer } from "../lib/coalesce";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KanbanTask {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  importantNotes: string | null;
  column: string;
  priority: string;
  assignedAgentId: string | null;
  blockedBy: string | null;
  dueDate: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export type KanbanColumn = "backlog" | "working" | "review" | "done";
export type TaskPriority = "critical" | "high" | "medium" | "low";

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface KanbanState {
  tasks: KanbanTask[];
  isLoading: boolean;
  activeProjectId: string | null;
  selectedTaskId: string | null;

  // Derived getters
  getTasksByColumn: (column: KanbanColumn) => KanbanTask[];
  getColumnCount: (column: KanbanColumn) => number;

  // Actions
  loadTasks: (projectId: string) => Promise<void>;
  createTask: (params: {
    projectId: string;
    title: string;
    description?: string;
    column?: string;
    priority?: string;
    assignedAgentId?: string;
    dueDate?: string;
  }) => Promise<string>;
  updateTask: (params: {
    id: string;
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
    importantNotes?: string;
    priority?: string;
    assignedAgentId?: string;
    blockedBy?: string;
    dueDate?: string;
  }) => Promise<void>;
  moveTask: (id: string, column: KanbanColumn, position?: number) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  selectTask: (id: string | null) => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortTasksByPosition(tasks: KanbanTask[]): KanbanTask[] {
  return [...tasks].sort((a, b) => a.position - b.position);
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const initialState = {
  tasks: [] as KanbanTask[],
  isLoading: false,
  activeProjectId: null as string | null,
  selectedTaskId: null as string | null,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useKanbanStore = create<KanbanState>((set, get) => ({
  ...initialState,

  getTasksByColumn: (column: KanbanColumn) => {
    return sortTasksByPosition(
      get().tasks.filter((t) => t.column === column),
    );
  },

  getColumnCount: (column: KanbanColumn) => {
    return get().tasks.filter((t) => t.column === column).length;
  },

  loadTasks: async (projectId: string) => {
    set({ isLoading: true, activeProjectId: projectId });
    try {
      const tasks = await rpc.getKanbanTasks(projectId);
      set({ tasks: tasks as KanbanTask[], isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  createTask: async (params) => {
    const result = await rpc.createKanbanTask(params);
    // Reload tasks to get the full task object with server-assigned fields
    const state = get();
    if (state.activeProjectId) {
      const tasks = await rpc.getKanbanTasks(state.activeProjectId);
      set({ tasks: tasks as KanbanTask[] });
    }
    return result.id;
  },

  updateTask: async (params) => {
    await rpc.updateKanbanTask(params);
    // Optimistic update
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === params.id
          ? { ...t, ...params, updatedAt: new Date().toISOString() }
          : t,
      ),
    }));
  },

  moveTask: async (id, column, position) => {
    // Optimistic update
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id
          ? { ...t, column, ...(position !== undefined ? { position } : {}), updatedAt: new Date().toISOString() }
          : t,
      ),
    }));
    await rpc.moveKanbanTask(id, column, position);
  },

  deleteTask: async (id) => {
    await rpc.deleteKanbanTask(id);
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
      selectedTaskId: state.selectedTaskId === id ? null : state.selectedTaskId,
    }));
  },

  selectTask: (id) => {
    set({ selectedTaskId: id });
  },

  reset: () => {
    set({ ...initialState });
  },
}));

// ---------------------------------------------------------------------------
// DOM event subscription — real-time sync from backend
// ---------------------------------------------------------------------------

// A single orchestration run moves many tasks (PM + reviewers), firing a burst of
// kanban-task-updated events. moveTask/updateTask already apply optimistic in-place
// updates, so the authoritative full reload here only needs to reconcile ONCE after
// the burst settles — coalesce it instead of refetching + re-rendering the whole
// board per event. (maxWaitMs still flushes periodically during a long run.)
let pendingReloadProjectId: string | null = null;
const coalescedReloadTasks = createCoalescer(() => {
  const pid = pendingReloadProjectId;
  if (pid) void useKanbanStore.getState().loadTasks(pid);
});

window.addEventListener("agentdesk:kanban-task-updated", (e: Event) => {
  const { projectId } = (e as CustomEvent<{
    projectId: string;
    taskId: string;
    action: string;
  }>).detail;

  const state = useKanbanStore.getState();
  // Only reload if the update is for the active project
  if (state.activeProjectId === projectId) {
    pendingReloadProjectId = projectId;
    coalescedReloadTasks();
  }
});
