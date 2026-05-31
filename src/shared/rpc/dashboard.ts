export type DashboardRequests = {
  sendDashboardMessage: {
    params: {
      sessionId: string;
      content: string;
    };
    response: { messageId: string };
  };
  abortDashboardMessage: {
    params: { sessionId: string };
    response: { success: boolean };
  };
  clearDashboardSession: {
    params: { sessionId: string };
    response: { success: boolean };
  };

  // Custom-agent chat (dashboard floating widget — one per chat-enabled custom agent)
  getChatEnabledAgents: {
    params: Record<string, never>;
    response: Array<{ id: string; name: string; displayName: string; color: string }>;
  };
  sendDashboardAgentMessage: {
    params: {
      sessionId: string;
      agentName: string;
      content: string;
    };
    response: { messageId: string };
  };
  abortDashboardAgentMessage: {
    params: { sessionId: string };
    response: { success: boolean };
  };
  clearDashboardAgentSession: {
    params: { sessionId: string };
    response: { success: boolean };
  };
};
