export type AgentsRequests = {
  getAgents: {
    params: Record<string, never>;
    response: Array<{
      id: string;
      name: string;
      displayName: string;
      color: string;
      isBuiltin: boolean;
      systemPrompt: string;
      providerId: string | null;
      modelId: string | null;
      temperature: string | null;
      maxTokens: number | null;
      isEnabled: boolean;
      thinkingBudget: string | null;
      useSystemPromptOnly: boolean;
      chatEnabled: boolean;
      availableToPm: boolean;
    }>;
  };
  updateAgent: {
    params: {
      id: string;
      displayName?: string;
      color?: string;
      systemPrompt?: string;
      providerId?: string | null;
      modelId?: string | null;
      temperature?: string | null;
      maxTokens?: number | null;
      isEnabled?: boolean;
      thinkingBudget?: string | null;
      useSystemPromptOnly?: boolean;
      chatEnabled?: boolean;
      availableToPm?: boolean;
    };
    response: { success: boolean; error?: string };
  };
  resetAgent: {
    params: { id: string };
    response: { success: boolean; error?: string };
  };
  createAgent: {
    params: {
      name: string;
      displayName: string;
      color: string;
      systemPrompt: string;
      providerId?: string;
      modelId?: string;
      useSystemPromptOnly?: boolean;
      chatEnabled?: boolean;
      availableToPm?: boolean;
    };
    response: { success: boolean; id?: string; error?: string };
  };
  deleteAgent: {
    params: { id: string };
    response: { success: boolean; error?: string };
  };
  resumeAgent: {
    params: { projectId: string; agentId: string };
    response: { success: boolean };
  };
  redirectAgent: {
    params: { projectId: string; agentId: string; instructions: string };
    response: { success: boolean };
  };
  stopAgent: {
    params: { projectId: string; agentName: string; conversationId?: string };
    response: { success: boolean };
  };
  stopAllAgents: {
    params: { projectId: string };
    response: { success: boolean; stoppedCount: number };
  };
  getRunningAgents: {
    params: { projectId: string };
    response: Array<{ id: string; name: string; displayName: string; taskDescription: string; status: string }>;
  };
  getRunningAgentsForConversation: {
    params: { projectId: string; conversationId: string };
    response: Array<{ id: string; name: string; displayName: string; taskDescription: string; status: string }>;
  };
  getActiveProjectAgents: {
    params: Record<string, never>;
    response: Array<{ projectId: string; agentCount: number }>;
  };
  getPmStatus: {
    params: { projectId: string; conversationId?: string };
    response: { isStreaming: boolean; conversationId: string | null };
  };
  getAgentTools: {
    params: { agentId: string };
    response: Array<{ toolName: string; isEnabled: boolean }>;
  };
  setAgentTools: {
    params: { agentId: string; tools: Array<{ toolName: string; isEnabled: boolean }> };
    response: { success: boolean };
  };
  getAllToolDefinitions: {
    params: Record<string, never>;
    response: Array<{ name: string; category: string; description: string }>;
  };
  resetAgentTools: {
    params: { agentId: string };
    response: { success: boolean };
  };
};
