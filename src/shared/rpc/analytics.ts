export type AnalyticsRequests = {
  // Project stats
  getProjectStats: {
    params: { projectId: string; days?: number };
    response: {
      completedPerDay: Array<{ day: string; count: number }>;
      createdPerDay: Array<{ day: string; count: number }>;
      byStatus: Array<{ status: string; count: number }>;
      byPriority: Array<{ priority: string; count: number }>;
      avgCompletionHours: number;
      activityHeatmap: Array<{ dow: number; hour: number; count: number }>;
      codeChurn: { added: number; removed: number };
    };
  };
  getAnalyticsSummary: {
    params: { projectId: string };
    response: { totalTasks: number; doneTasks: number; totalTokens: number };
  };

};
