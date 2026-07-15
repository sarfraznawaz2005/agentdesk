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

  // AI Usage / Cost Analytics (§9.1) — sourced from ai_telemetry_events
  // (see telemetry-sink.ts, Phase 3.1). Replaces prompt-logger.ts's
  // regex-parsed stats view; token/cost/latency data, not raw prompt text.
  getTelemetryUsage: {
    params: { projectId?: string; agentName?: string; provider?: string; days?: number };
    response: {
      totals: {
        calls: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        reasoningTokens: number;
        cacheHitRate: number; // 0-1
      };
      tokensPerDay: Array<{
        day: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        reasoningTokens: number;
      }>;
      byProvider: Array<{ provider: string; totalTokens: number; calls: number }>;
      byAgent: Array<{ agentName: string; totalTokens: number; calls: number }>;
      latency: { p50Ms: number | null; p95Ms: number | null; avgTimeToFirstOutputMs: number | null };
      throughputByModel: Array<{ provider: string; modelId: string; avgTokensPerSecond: number }>;
      toolStats: Array<{ toolName: string; count: number; avgMs: number; failureRate: number }>;
      filters: { agents: string[]; providers: string[] };
      telemetrySince: string | null;
    };
  };

  // Provider health/status trend (§9.4) — same telemetry sink as above,
  // system-wide (not project/agent filtered): per-provider call volume,
  // finish-reason-derived error rate, and latency over time.
  getProviderHealth: {
    params: { days?: number };
    response: {
      perProvider: Array<{
        provider: string;
        calls: number;
        errors: number;
        errorRate: number;
        avgResponseTimeMs: number | null;
        callsPerDay: Array<{ day: string; calls: number; errors: number }>;
      }>;
    };
  };

};
