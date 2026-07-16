export type ProvidersRequests = {
  getProviders: {
    params: Record<string, never>;
    response: Array<{
      id: string;
      name: string;
      providerType: string;
      baseUrl: string | null;
      defaultModel: string | null;
      isDefault: boolean;
      isValid: boolean;
    }>;
  };
  saveProvider: {
    params: {
      id?: string;
      name: string;
      providerType: string;
      apiKey: string;
      baseUrl?: string;
      defaultModel?: string;
      isDefault?: boolean;
    };
    response: { success: boolean; id: string; error?: string };
  };
  testProvider: {
    params: { id: string };
    response: { queued: boolean };
  };
  listProviderModels: {
    params: { providerType: string; apiKey: string; baseUrl?: string; defaultModel?: string };
    response: { success: boolean; models: string[]; error?: string };
  };
  listProviderModelsById: {
    params: { providerId: string };
    response: { success: boolean; models: string[]; error?: string };
  };
  deleteProvider: {
    params: { id: string };
    response: { success: boolean };
  };
  getProviderApiKey: {
    params: { id: string };
    response: { apiKey: string };
  };
  testProviderWithCredentials: {
    params: { providerType: string; apiKey: string; baseUrl?: string; defaultModel?: string };
    response: { success: boolean; error?: string };
  };
  getConnectedProviderModels: {
    params: Record<string, never>;
    response: Array<{
      providerId: string;
      providerName: string;
      providerType: string;
      models: string[];
    }>;
  };
  getModelTypes: {
    params: Record<string, never>;
    response: Record<string, Record<string, string>>;
  };
  checkModelToolSupport: {
    params: { providerType: string; apiKey?: string; providerId?: string; modelId: string };
    response: { supportsToolChoice: boolean; warning?: string };
  };
  getClaudeSubscriptionEnabled: {
    params: Record<string, never>;
    response: { enabled: boolean };
  };
  getModelPreferences: {
    params: Record<string, never>;
    response: Array<{
      providerId: string;
      modelId: string;
      isEnabled: boolean;
      isFavorite: boolean;
      lastUsedAt: string | null;
    }>;
  };
  setModelEnabled: {
    params: { providerId: string; modelId: string; enabled: boolean };
    response: { success: boolean };
  };
  setModelsEnabled: {
    params: { providerId: string; modelIds: string[]; enabled: boolean };
    response: { success: boolean };
  };
  setModelFavorite: {
    params: { providerId: string; modelId: string; favorite: boolean };
    response: { success: boolean };
  };
  recordModelUsage: {
    params: { providerId: string; modelId: string };
    response: { success: boolean };
  };
};
