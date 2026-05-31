export type DeployRequests = {
  getEnvironments: {
    params: { projectId: string };
    response: Array<{
      id: string;
      projectId: string;
      name: string;
      branch: string | null;
      command: string;
      url: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  saveEnvironment: {
    params: {
      projectId: string;
      id?: string;
      name: string;
      branch?: string;
      command: string;
      url?: string;
    };
    response: { id: string };
  };
  deleteEnvironment: {
    params: { id: string };
    response: { success: boolean };
  };
  getDeployHistory: {
    params: { environmentId: string; limit?: number };
    response: Array<{
      id: string;
      environmentId: string;
      status: string;
      logOutput: string | null;
      triggeredBy: string;
      durationMs: number | null;
      createdAt: string;
    }>;
  };
  executeDeploy: {
    params: { environmentId: string };
    response: { success: boolean; historyId?: string; durationMs?: number; error?: string };
  };
};
