type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  workspacePath: string;
  githubUrl: string | null;
  workingBranch: string | null;
  createdAt: string;
  updatedAt: string;
  /** True when the workspace folder could not be reached (cloud/network path temporarily offline). Project is NOT deleted. */
  workspaceOffline?: boolean;
};

export type ProjectsRequests = {
  getProjects: {
    params: Record<string, never>;
    response: Array<ProjectRow>;
  };
  createProject: {
    params: {
      name: string;
      description?: string;
      workspacePath: string;
      githubUrl?: string;
      workingBranch?: string;
    };
    response: { success: boolean; id: string; error?: string };
  };
  deleteProject: {
    params: { id: string };
    response: { success: boolean; error?: string };
  };
  getProject: {
    params: { id: string };
    response: ProjectRow | null;
  };
  updateProject: {
    params: {
      id: string;
      name?: string;
      description?: string;
      status?: string;
      workspacePath?: string;
      githubUrl?: string;
      workingBranch?: string;
    };
    response: { success: boolean; error?: string };
  };
  deleteProjectCascade: {
    params: { id: string };
    response: { success: boolean };
  };
  permanentDeleteProject: {
    params: { id: string };
    response: { success: boolean; error?: string };
  };
  resetProjectData: {
    params: { id: string };
    response: { success: boolean };
  };
  saveProjectSetting: {
    params: { projectId: string; key: string; value: string };
    response: { success: boolean };
  };
  getProjectSettings: {
    params: { projectId: string };
    response: Record<string, string>;
  };
  listWorkspaceFiles: {
    params: { projectId: string; subPath?: string };
    response: Array<{
      name: string;
      path: string;
      isDirectory: boolean;
      size: number;
      updatedAt: string;
    }>;
  };
  readWorkspaceFile: {
    params: { projectId: string; filePath: string };
    response: { content: string; error?: string };
  };
  readWorkspaceImageFile: {
    params: { projectId: string; filePath: string };
    response: { data: string; mimeType: string; error?: string };
  };
  syncWorkspaceFolders: {
    params: Record<string, never>;
    response: { synced: number };
  };
  /** Whether the project's workspace already contains a `.git` directory. */
  getProjectRepoState: {
    params: { projectId: string };
    response: { hasGit: boolean };
  };
  /** Clone the project's configured GitHub URL into its (empty) workspace path. */
  cloneProjectRepo: {
    params: { projectId: string };
    response: { success: boolean; error?: string };
  };
};
