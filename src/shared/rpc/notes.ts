type NoteRow = {
  id: string;
  projectId: string;
  title: string;
  content: string;
  authorAgentId: string | null;
  createdAt: string;
  updatedAt: string;
};

type PromptRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  category: string;
  createdAt: string;
  updatedAt: string;
};

export type NotesRequests = {
  // Notes
  getProjectNotes: {
    params: { projectId: string };
    response: Array<NoteRow>;
  };
  getNote: {
    params: { id: string };
    response: NoteRow | null;
  };
  createNote: {
    params: { projectId: string; title: string; content: string; authorAgentId?: string };
    response: { success: boolean; id: string };
  };
  updateNote: {
    params: { id: string; title?: string; content?: string };
    response: { success: boolean };
  };
  deleteNote: {
    params: { id: string };
    response: { success: boolean };
  };
  searchNotes: {
    params: { projectId: string; query: string };
    response: Array<NoteRow>;
  };

  // Prompts
  getPrompts: {
    params: Record<string, never>;
    response: Array<PromptRow>;
  };
  savePrompt: {
    params: { id?: string; name: string; description: string; content: string; category?: string };
    response: { success: boolean; id: string };
  };
  deletePrompt: {
    params: { id: string };
    response: { success: boolean };
  };
  searchPrompts: {
    params: { query: string };
    response: Array<PromptRow>;
  };

  // Workspace plans
  getWorkspacePlans: {
    params: { projectId: string };
    response: Array<{ title: string; content: string; path: string; updatedAt: string }>;
  };
  deleteWorkspacePlan: {
    params: { path: string };
    response: { success: boolean };
  };

  // Global search
  globalSearch: {
    params: { query: string };
    response: Array<{ type: string; id: string; title: string; description: string; projectId?: string }>;
  };
};
