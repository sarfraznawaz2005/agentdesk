export type SystemRequests = {
  // App info
  selectDirectory: {
    params: Record<string, never>;
    response: { queued: boolean };
  };
  getAppInfo: {
    params: Record<string, never>;
    response: { version: string; platform: string; dataDir: string };
  };
  checkInternet: {
    params: Record<string, never>;
    response: { online: boolean };
  };
  isFirstLaunch: {
    params: Record<string, never>;
    response: boolean;
  };
  markOnboardingComplete: {
    params: Record<string, never>;
    response: { success: boolean };
  };

  // Health
  getHealthStatus: {
    params: Record<string, never>;
    response: {
      database: { status: "healthy" | "degraded" | "error"; message?: string; hasBackups: boolean };
      aiProvider: { status: "healthy" | "degraded" | "error"; message?: string; providerCount: number; hasDefault: boolean };
      workspace: { status: "healthy" | "degraded" | "error"; message?: string; missingPaths: string[] };
      scheduler: { status: "healthy" | "stopped" | "error"; message?: string; activeJobs: number };
      integrations: { status: "healthy" | "degraded" | "disconnected"; channels: Array<{ channelId: string; platform: string; status: string }> };
      engines: { status: "healthy" | "warning"; activeCount: number; idleCount: number; maxSize: number };
      backend: { status: "healthy"; uptime: number };
    };
  };
  checkDatabase: {
    params: Record<string, never>;
    response: { healthy: boolean; message?: string };
  };
  restartScheduler: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  cleanupEngines: {
    params: Record<string, never>;
    response: { cleaned: number };
  };
  resetApplication: {
    params: Record<string, never>;
    response: { success: boolean };
  };

  // Database maintenance
  optimizeDatabase: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  vacuumDatabase: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  pruneDatabase: {
    params: { days?: number };
    response: { success: boolean; pruned: Record<string, number> };
  };
  /** Current maintenance overlay state (so a freshly-loaded view can sync up). */
  getMaintenanceStatus: {
    params: Record<string, never>;
    response: { active: boolean; message: string };
  };

  // Backup / restore
  createBackup: {
    params: Record<string, never>;
    response: { filename: string; size: number };
  };
  listBackups: {
    params: Record<string, never>;
    response: Array<{ filename: string; size: number; date: string }>;
  };
  deleteBackup: {
    params: { filename: string };
    response: { success: boolean };
  };
  restoreBackup: {
    params: { filename: string };
    response: { success: boolean; requiresRestart: boolean };
  };

  // Export / import
  exportProjectData: {
    params: { projectId: string };
    response: { data: string };
  };
  importProjectData: {
    params: { projectId: string; data: string; mode: "merge" | "replace" };
    response: { success: boolean; counts: Record<string, number> };
  };

  // Audit log
  getAuditLog: {
    params: { action?: string; entityType?: string; limit?: number; offset?: number; before?: string; after?: string };
    response: { entries: Array<{ id: string; action: string; entityType: string; entityId: string | null; details: string | null; createdAt: string }>; total: number };
  };
  clearAuditLog: {
    params: { before?: string };
    response: { success: boolean; deleted: number };
  };

  // MCP
  getMcpConfig: {
    params: Record<string, never>;
    response: {
      raw: string;
      servers: Record<string, { command: string; args?: string[]; env?: Record<string, string>; disabled?: boolean }>;
    };
  };
  saveMcpConfig: {
    params: { configJson: string };
    response: { success: boolean; error?: string };
  };
  getMcpStatus: {
    params: Record<string, never>;
    response: Record<string, "connected" | "connecting" | "failed" | "disabled">;
  };
  reconnectMcpServer: {
    params: { name?: string };
    response: { success: boolean };
  };
  disconnectMcpServer: {
    params: { name: string };
    response: { success: boolean };
  };

  // Prompt debug log
  clearPromptLog: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  openPromptLog: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  getPromptLogStats: {
    params: { limit?: number };
    response: {
      entries: Array<{
        timestamp: string;
        agent: string;
        model: string;
        totalTokens: number;
        systemTokens: number;
        messagesTokens: number;
      }>;
      fileSize: number;
    };
  };
  getPromptLogEntry: {
    params: { timestamp: string };
    response: {
      timestamp: string;
      agent: string;
      model: string;
      totalTokens: number;
      systemTokens: number;
      messagesTokens: number;
      systemPrompt: string;
      messages: string;
    } | null;
  };

  // Prompt enhancer
  enhancePrompt: {
    params: { projectId: string; text: string; providerId?: string; modelId?: string };
    response: { enhanced: string };
  };

  // File attachments
  saveAttachment: {
    params: { projectId: string; fileName: string; dataBase64: string; type: "text" | "image" | "binary" };
    response: { success: boolean; path: string; name: string; type: string; size: number };
  };

  // Shell approval
  respondShellApproval: {
    params: { requestId: string; decision: "allow" | "deny" | "always" };
    response: { success: boolean };
  };

  // User question response
  respondUserQuestion: {
    params: { requestId: string; answer: string };
    response: { success: boolean };
  };

  // Re-fetch still-pending shell approvals + user questions for a project, so a
  // reconnecting web client can re-render cards/dialogs it missed while offline
  // (TASK-478 durability). Returns the original broadcast payloads.
  getPendingApprovals: {
    params: { projectId: string };
    response: { shell: unknown[]; question: unknown[] };
  };

  // Test OS notification
  testOsNotification: {
    params: Record<string, never>;
    response: { success: boolean };
  };

  // Open a URL in the system default browser
  openExternalUrl: {
    params: { url: string };
    response: { success: boolean };
  };

  // Open a local folder path in the OS file explorer
  openInExplorer: {
    params: { path: string };
    response: { success: boolean };
  };

  // Get the absolute path to the app's data directory (where the DB, logs,
  // and backups live). Resolved at runtime from Electrobun's userData path —
  // never hardcoded, so it tracks the app identifier/channel automatically.
  getDataPath: {
    params: Record<string, never>;
    response: { path: string };
  };

  // Search workspace files (recursive, for @ mentions)
  searchWorkspaceFiles: {
    params: { projectId: string; query?: string };
    response: string[];
  };

  // Execute shell command directly (for ! mode)
  executeShellCommand: {
    params: { projectId: string; command: string; timeout?: number };
    response: { stdout: string; stderr: string; exitCode: number | null };
  };

  // Manual conversation compaction (for /compact)
  compactConversation: {
    params: { projectId: string; conversationId: string };
    response: { success: boolean; message?: string };
  };

  // Open system terminal at workspace (for /terminal)
  openTerminal: {
    params: { projectId: string };
    response: { success: boolean };
  };

  // Database viewer
  dbViewerGetTables: {
    params: Record<string, never>;
    response: Array<{ name: string; displayName: string; deletable: boolean }>;
  };
  dbViewerGetRows: {
    params: { table: string; page: number; pageSize?: number };
    response: { rows: Record<string, unknown>[]; total: number; columns: string[] };
  };
  dbViewerDeleteRow: {
    params: { table: string; id: string };
    response: { success: boolean };
  };
};

export type BunMessages = {
  log: { level: string; message: string };
  logClientError: { type: string; message: string; stack?: string };
};
