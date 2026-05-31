type KanbanTaskRow = {
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
};

export type KanbanRequests = {
  getKanbanTasks: {
    params: { projectId: string };
    response: Array<KanbanTaskRow>;
  };
  getKanbanTask: {
    params: { id: string };
    response: KanbanTaskRow | null;
  };
  createKanbanTask: {
    params: {
      projectId: string;
      title: string;
      description?: string;
      acceptanceCriteria?: string;
      importantNotes?: string;
      column?: string;
      priority?: string;
      assignedAgentId?: string;
      blockedBy?: string;
      dueDate?: string;
    };
    response: { success: boolean; id: string };
  };
  updateKanbanTask: {
    params: {
      id: string;
      title?: string;
      description?: string;
      acceptanceCriteria?: string;
      importantNotes?: string;
      column?: string;
      priority?: string;
      assignedAgentId?: string;
      blockedBy?: string;
      dueDate?: string;
      position?: number;
    };
    response: { success: boolean };
  };
  moveKanbanTask: {
    params: { id: string; column: string; position?: number };
    response: { success: boolean };
  };
  deleteKanbanTask: {
    params: { id: string };
    response: { success: boolean };
  };
  getProjectTaskStats: {
    params: Record<string, never>;
    response: Array<{ projectId: string; done: number; total: number }>;
  };
};
