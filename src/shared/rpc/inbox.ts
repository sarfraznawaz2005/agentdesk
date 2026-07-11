export type InboxRequests = {
  // Inbox messages
  getInboxMessages: {
    params: { projectId?: string; isRead?: boolean; limit?: number; isArchived?: boolean; isFavorite?: boolean };
    response: Array<{
      id: string;
      projectId: string | null;
      channelId: string | null;
      sender: string;
      content: string;
      isRead: number;
      agentResponse: string | null;
      createdAt: string;
      threadId: string | null;
      priority: number;
      category: string;
      platform: string;
      isArchived: number;
      isFavorite: number;
    }>;
  };
  markAsRead: {
    params: { id: string };
    response: { success: boolean };
  };
  markAsUnread: {
    params: { id: string };
    response: { success: boolean };
  };
  markAllAsRead: {
    params: { projectId?: string };
    response: { success: boolean };
  };
  getUnreadCount: {
    params: { projectId?: string };
    response: { count: number };
  };
  deleteInboxMessage: {
    params: { id: string };
    response: { success: boolean };
  };
  searchInboxMessages: {
    params: { query: string; projectId?: string; isFavorite?: boolean };
    response: Array<{
      id: string;
      projectId: string | null;
      channelId: string | null;
      sender: string;
      content: string;
      isRead: number;
      agentResponse: string | null;
      createdAt: string;
      threadId: string | null;
      priority: number;
      category: string;
      platform: string;
      isArchived: number;
      isFavorite: number;
    }>;
  };
  archiveInboxMessage: {
    params: { id: string };
    response: { success: boolean };
  };
  unarchiveInboxMessage: {
    params: { id: string };
    response: { success: boolean };
  };
  favoriteInboxMessage: {
    params: { id: string };
    response: { success: boolean };
  };
  unfavoriteInboxMessage: {
    params: { id: string };
    response: { success: boolean };
  };
  bulkArchiveInboxMessages: {
    params: { ids: string[] };
    response: { success: boolean; count: number };
  };
  bulkDeleteInboxMessages: {
    params: { ids: string[] };
    response: { success: boolean; count: number };
  };
  bulkMarkAsReadInboxMessages: {
    params: { ids: string[] };
    response: { success: boolean; count: number };
  };
  replyToInboxMessage: {
    params: { id: string; content: string };
    response: { success: boolean };
  };

  // Inbox rules
  getInboxRules: {
    params: { projectId?: string };
    response: Array<{ id: string; projectId: string | null; name: string; conditions: string; actions: string; enabled: number; priority: number; createdAt: string }>;
  };
  createInboxRule: {
    params: { projectId?: string; name: string; conditions: string; actions: string; priority?: number };
    response: { id: string };
  };
  updateInboxRule: {
    params: { id: string; name?: string; conditions?: string; actions?: string; enabled?: boolean; priority?: number };
    response: { success: boolean };
  };
  deleteInboxRule: {
    params: { id: string };
    response: { success: boolean };
  };

  // Notifications
  getNotificationPreferences: {
    params: { platform?: string; projectId?: string };
    response: Array<{ id: string; platform: string; projectId: string | null; soundEnabled: number; badgeEnabled: number; bannerEnabled: number; muteUntil: string | null; createdAt: string }>;
  };
  saveNotificationPreference: {
    params: { id?: string; platform: string; projectId?: string; soundEnabled?: boolean; badgeEnabled?: boolean; bannerEnabled?: boolean; muteUntil?: string | null };
    response: { success: boolean; id: string };
  };

  // Cron jobs
  getCronJobs: {
    params: { projectId?: string };
    response: Array<{ id: string; projectId: string | null; name: string; cronExpression: string; timezone: string; taskType: string; taskConfig: string; enabled: number; oneShot: number; lastRunAt: string | null; lastRunStatus: string | null; createdAt: string; updatedAt: string; isRunning: boolean; isStoppable: boolean }>;
  };
  createCronJob: {
    params: { projectId?: string; name: string; cronExpression: string; timezone?: string; taskType: string; taskConfig: string; enabled?: boolean; oneShot?: boolean };
    response: { id: string };
  };
  updateCronJob: {
    params: { id: string; name?: string; cronExpression?: string; timezone?: string; taskType?: string; taskConfig?: string; enabled?: boolean; oneShot?: boolean };
    response: { success: boolean };
  };
  deleteCronJob: {
    params: { id: string };
    response: { success: boolean };
  };
  getCronJobHistory: {
    params: { jobId: string; limit?: number };
    response: Array<{ id: string; jobId: string; startedAt: string; completedAt: string | null; status: string; output: string | null; durationMs: number | null; createdAt: string }>;
  };
  previewCronSchedule: {
    params: { cronExpression: string; timezone?: string; count?: number };
    response: { runs: string[] };
  };
  clearCronJobHistory: {
    params: { jobId?: string };
    response: { success: boolean };
  };
  triggerCronJob: {
    params: { id: string };
    response: { success: boolean };
  };
  stopCronJob: {
    params: { id: string };
    response: { stopped: boolean };
  };
  getRunningSchedulerMessages: {
    params: Record<string, never>;
    response: Array<{ messageId: string; jobId: string }>;
  };

  // Automation rules
  getAutomationRules: {
    params: { projectId?: string };
    response: Array<{ id: string; projectId: string | null; name: string; trigger: string; actions: string; enabled: number; priority: number; lastTriggeredAt: string | null; createdAt: string }>;
  };
  createAutomationRule: {
    params: { projectId?: string; name: string; trigger: string; actions: string; priority?: number };
    response: { id: string };
  };
  updateAutomationRule: {
    params: { id: string; name?: string; trigger?: string; actions?: string; enabled?: boolean; priority?: number };
    response: { success: boolean };
  };
  deleteAutomationRule: {
    params: { id: string };
    response: { success: boolean };
  };
  getAutomationTemplates: {
    params: Record<string, never>;
    response: Array<{ name: string; trigger: string; actions: string }>;
  };
};
