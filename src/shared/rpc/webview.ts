import type { RPCSchema } from "electrobun/bun";

export type WebviewSchema = RPCSchema<{
  requests: {
    getViewState: {
      params: Record<string, never>;
      response: { route: string };
    };
  };
  messages: {
    navigateTo: { route: string };
    showToast: {
      type: "success" | "error" | "warning" | "info";
      message: string;
    };
    settingsChanged: { key: string; value: unknown };

    // Streaming
    streamToken: {
      conversationId: string;
      messageId: string;
      token: string;
      agentId: string | null;
    };
    streamComplete: {
      conversationId: string;
      messageId: string;
      content: string;
      metadata?: string | null;
      usage: { promptTokens: number; completionTokens: number };
    };
    streamReset: {
      conversationId: string;
      messageId: string;
    };
    streamError: {
      conversationId: string;
      error: string;
    };

    // Plan approval
    presentPlan: {
      projectId: string;
      conversationId: string;
      plan: { title: string; content: string };
    };

    // Provider test result (fire-and-forget — result pushed back from Bun)
    providerTestResult: {
      id: string;
      success: boolean;
      error?: string;
    };

    // Provider list mutated (created/updated/deleted) — lets any open view
    // refresh its provider list/count, including across windows.
    providersChanged: {
      reason: "saved" | "deleted";
    };

    // Per-model preferences mutated (enabled/favourite) — lets any open view
    // refresh the chat model picker / Models settings page.
    modelPreferencesChanged: {
      reason: "enabled" | "favorite";
    };

    // Directory selected from native picker (fire-and-forget)
    directorySelected: {
      path: string | null;
    };

    // WhatsApp real-time events
    whatsappQR: {
      channelId: string;
      qr: string; // base64 PNG data URL
    };
    whatsappStatus: {
      channelId: string;
      status: "connected" | "connecting" | "disconnected" | "error";
      phoneNumber?: string;
    };

    // Inbox real-time updates
    inboxMessageReceived: {
      messageId: string;
      projectId: string | null;
      sender: string;
      platform: string;
    };

    // Kanban real-time updates
    kanbanTaskUpdated: {
      projectId: string;
      taskId: string;
      action: "created" | "updated" | "moved" | "deleted";
    };

    // A project's PM went idle with no agents running or queued — i.e. an entire
    // dispatch session finished, not just one kanban task. Fired from the same
    // idle-check in engine-manager.ts that already drives the "Session Complete"
    // desktop notification, so the UI can toast this for a project the user is
    // not currently viewing. Only fires if at least one agent actually ran
    // during the session (a plain PM chat reply with zero dispatches is not a
    // "session"); see the session-had-agent-activity tracking in engine-manager.ts.
    agentSessionComplete: {
      projectId: string;
      projectName: string;
    };

    // Shell approval request (agent wants to run a command)
    shellApprovalRequest: {
      requestId: string;
      projectId: string;
      agentId: string;
      agentName: string;
      command: string;
      timestamp: string;
    };

    // A pending shell approval expired (5-min timeout, or orphaned by a desktop
    // restart) — the frontend marks the stale card as expired so the user can
    // re-request instead of staring at a dead spinner (TASK-478 durability).
    shellApprovalExpired: {
      requestId: string;
      projectId: string;
      reason: "timeout" | "restart";
    };

    // User question request (PM asks user a question via modal dialog)
    userQuestionRequest: {
      requestId: string;
      question: string;
      inputType: "choice" | "text" | "confirm" | "multi_select";
      options?: string[];
      placeholder?: string;
      defaultValue?: string;
      context?: string;
      projectId: string;
      agentId: string;
      agentName: string;
      timestamp: string;
    };

    // Auto-close a stale question dialog (the agent timed out waiting and moved on)
    userQuestionCancel: {
      requestId: string;
    };

    // Inline agent execution — message parts streaming
    partCreated: {
      conversationId: string;
      messageId: string;
      part: {
        id: string;
        type: "text" | "tool_call" | "tool_result" | "reasoning" | "agent_start" | "agent_end";
        content: string;
        toolName?: string;
        toolInput?: string;
        toolOutput?: string;
        toolState?: "pending" | "running" | "success" | "error";
        sortOrder: number;
        agentName?: string;
        timeStart?: string;
        timeEnd?: string;
      };
    };
    partUpdated: {
      conversationId: string;
      messageId: string;
      partId: string;
      updates: {
        content?: string;
        toolOutput?: string;
        toolState?: "pending" | "running" | "success" | "error";
        timeEnd?: string;
      };
    };
    agentInlineStart: {
      conversationId: string;
      messageId: string;
      agentName: string;
      agentDisplayName: string;
      task: string;
    };
    agentInlineComplete: {
      conversationId: string;
      messageId: string;
      agentName: string;
      status: string;
      summary: string;
      filesModified: string[];
      tokensUsed: { prompt: number; completion: number };
    };
    // Live context-window usage, emitted per step by the PM or a sub-agent so the
    // context meter climbs in real time (numerator = real prompt tokens).
    contextUsage: {
      conversationId: string;
      promptTokens: number;
      contextLimit: number;
    };

    // Conversation title auto-generated
    conversationTitleChanged: {
      conversationId: string;
      title: string;
    };
    conversationUpdated: {
      conversationId: string;
      updatedAt: string;
      // Required on every emitter: the frontend gates cross-project sidebar
      // updates on this (chat store activeProjectId guard).
      projectId: string;
    };
    switchToConversation: {
      conversationId: string;
      projectId: string;
    };
    compactionStarted: {
      conversationId: string;
    };
    conversationCompacted: {
      conversationId: string;
    };
    newMessage: {
      conversationId: string;
      messageId: string;
      agentId: string;
      agentName: string;
      content: string;
      metadata: string;
    };

    // PM thinking/reasoning (streamed from PM engine)
    pmThinking: {
      conversationId: string;
      text: string;
      isPartial: boolean;
    };

    // Dashboard PM chat (floating widget)
    dashboardPMChunk: {
      sessionId: string;
      messageId: string;
      token: string;
    };
    dashboardPMComplete: {
      sessionId: string;
      messageId: string;
      content: string;
    };
    dashboardPMToolCall: {
      sessionId: string;
      toolName: string;
      args: Record<string, unknown>;
    };
    dashboardPMError: {
      sessionId: string;
      error: string;
    };

    // Dashboard custom-agent chat (one floating widget per chat-enabled custom agent)
    dashboardAgentChunk: {
      sessionId: string;
      agentName: string;
      messageId: string;
      token: string;
    };
    dashboardAgentComplete: {
      sessionId: string;
      agentName: string;
      messageId: string;
      content: string;
    };
    dashboardAgentToolCall: {
      sessionId: string;
      agentName: string;
      toolName: string;
      args: Record<string, unknown>;
    };
    dashboardAgentError: {
      sessionId: string;
      agentName: string;
      error: string;
    };

    // App update progress (streamed from Bun during download/check)
    updateStatus: {
      status: string;
      message: string;
      progress?: number;
    };

    // DB maintenance underway — drives a global "please wait" overlay so the user
    // isn't left staring at skeleton loaders while queries stall app-wide.
    maintenance: {
      active: boolean;
      message: string;
    };

    // Freelance wizard (Find Workable Projects)
    "freelance.wizard.progress": {
      current: number;
      total: number;
      listingId: string;
      title: string;
      phase: "fetching" | "analyzing" | "done";
      workable?: boolean;
    };
    "freelance.wizard.complete": {
      workableListings: Array<{ id: string; title: string; budgetMin: number | null; budgetMax: number | null; budgetType: string; currency: string }>;
      failedListings: Array<{ id: string; title: string; reason: string; blockers: string[] }>;
    };
    "freelance.wizard.error": { error: string };
    "freelance.wizard.stopped": {
      workableListings: Array<{ id: string; title: string; budgetMin: number | null; budgetMax: number | null; budgetType: string; currency: string }>;
      failedListings: Array<{ id: string; title: string; reason: string; blockers: string[] }>;
    };

    // Freelance real-time updates
    "freelance.fetchStarted": { source: string };
    "freelance.listingsUpdated": {
      count: number;
      source?: string;
      errors?: number;
    };

    // Auto-Earn inbox (read-only v1)
    "freelance.inbox.updated": { threads: number; messages: number };
    "freelance.inbox.newMessage": { threadId: string; messageId: string };
    "freelance.outbox.updated": { count?: number };
    "freelance.governor.blocked": { platform: string; reason: string; retryAfterMs: number | null };
    "freelance.account.statusChanged": { platform: string; status: string };
    "freelance.escalation.created": { id: string; severity: string; reason: string };
    "freelance.escalation.resolved": { id: string };
    "freelance.job.updated": { jobId?: string };

    // Freelance chat streaming
    "freelance.chat.fetching": { listingId: string };
    "freelance.chat.fetch_done": { listingId: string };
    "freelance.chat.tool_start": { listingId: string; toolCallId: string; toolName: string; toolInput: string; timeStart: string };
    "freelance.chat.tool_done": { listingId: string; toolCallId: string; toolName: string; toolOutput: string; isError: boolean; timeStart: string | null; timeEnd: string };
    "freelance.chat.token": { listingId: string; messageId: string; token: string };
    "freelance.chat.complete": { listingId: string; messageId: string; content: string };
    "freelance.chat.error": { listingId: string; error: string };
    "freelance.chat.stopped": { listingId: string };

    // ── Playground (Artifacts-style page) ──
    playgroundRunStarted: { message: string };
    playgroundPart: {
      part: {
        id: string;
        type: "text" | "tool_call" | "tool_result" | "reasoning" | "agent_start" | "agent_end";
        content: string;
        toolName?: string;
        toolInput?: string;
        toolOutput?: string;
        toolState?: "pending" | "running" | "success" | "error";
        sortOrder: number;
        agentName?: string;
        timeStart?: string;
        timeEnd?: string;
      };
    };
    playgroundPartUpdated: {
      partId: string;
      updates: {
        content?: string;
        toolOutput?: string;
        toolState?: "pending" | "running" | "success" | "error";
        timeEnd?: string;
      };
    };
    playgroundAgentStart: { task: string };
    playgroundAgentComplete: {
      status: string;
      summary: string;
      filesModified: string[];
      tokensUsed: { prompt: number; completion: number; contextLimit?: number };
    };
    playgroundRunComplete: Record<string, never>;
    playgroundRunError: { error: string };
    playgroundPreviewReady: {
      kind: "static" | "devserver" | "file";
      url: string;
      title: string;
      description?: string;
      createdAt: string;
    };
    playgroundRejected: { reason: string; guidance: string; createdAt: string };
    playgroundReset: Record<string, never>;
    playgroundFilesChanged: Record<string, never>;

    // ── Issue Fixer ──
    issueFixerRunStarted: {
      projectId: string;
      runId: string;
      issueNumber: number;
      issueTitle: string;
      intent: string;
    };
    issueFixerPart: {
      projectId: string;
      runId: string;
      part: {
        id: string;
        type: "text" | "tool_call" | "tool_result" | "reasoning" | "agent_start" | "agent_end";
        content: string;
        toolName?: string;
        toolInput?: string;
        toolOutput?: string;
        toolState?: "pending" | "running" | "success" | "error";
        sortOrder: number;
        agentName?: string;
        timeStart?: string;
        timeEnd?: string;
      };
    };
    issueFixerPartUpdated: {
      projectId: string;
      runId: string;
      partId: string;
      updates: {
        content?: string;
        toolOutput?: string;
        toolState?: "pending" | "running" | "success" | "error";
        timeEnd?: string;
      };
    };
    issueFixerRunComplete: {
      projectId: string;
      runId: string;
      status: string;
      prNumber: number | null;
      prUrl: string | null;
    };
    issueFixerRunError: { projectId: string; runId: string; error: string };

    // ── Remote Sync (SFTP/FTP) ──
    remoteSyncRunStarted: {
      projectId: string;
      runId: string;
      direction: "pull" | "push";
      totalFiles: number;
    };
    remoteSyncProgress: {
      projectId: string;
      runId: string;
      direction: "pull" | "push";
      file: string;
      status: "start" | "ok" | "error";
      index: number;
      total: number;
      error?: string;
    };
    remoteSyncRunComplete: {
      projectId: string;
      runId: string;
      direction: "pull" | "push";
      status: string;
      okFiles: number;
      failedFiles: number;
      bytes: number;
      summary: string;
    };
    remoteSyncRunError: { projectId: string; runId: string; error: string };
    remoteSyncLog: {
      projectId: string;
      level: "info" | "warn" | "error";
      message: string;
      at: string;
    };

    // A project was created (incl. background creators: channel auto-create, workspace sync)
    // so open views (dashboard, project switcher) can refresh their list live.
    projectsUpdated: { id: string; name: string };

    // Per-project unread agent activity changed (recorded or marked seen).
    activityUpdated: { projectId: string; location: string };

    // Dependency install completion (from recommendations tab)
    recommendationStatusChanged: {
      dependencyId: string;
      installed: boolean;
      version?: string;
    };

    // Council multi-agent discussion events
    councilEvent: {
      sessionId: string;
      type: string;
      // Typed per event type — extras passed as optional fields
      query?: string;
      agents?: Array<{ name: string; displayName: string; color: string }>;
      agentName?: string;
      token?: string;
      turnsLeft?: number;
      questionId?: string;
      question?: string;
      message?: string;
      round?: number;
      scores?: Record<string, number>;
      converged?: boolean;
      summary?: string;
    };
  };
}>;
