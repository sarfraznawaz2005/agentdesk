export type SettingsRequests = {
  getSettings: {
    params: { category?: string };
    response: Record<string, unknown>;
  };
  getSetting: {
    params: { key: string; category?: string };
    response: string | null;
  };
  saveSetting: {
    params: { key: string; value: unknown; category: string };
    response: { success: boolean };
  };
  exportSettings: {
    params: Record<string, never>;
    response: { data: string };
  };
  importSettings: {
    params: { data: string };
    response: { success: boolean; error?: string };
  };
};
