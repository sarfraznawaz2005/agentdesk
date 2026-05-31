export type PluginsRequests = {
  getPlugins: {
    params: Record<string, never>;
    response: Array<{
      id: string;
      name: string;
      displayName: string;
      version: string;
      description: string;
      author: string;
      permissions: string[];
      enabled: boolean;
      settings: Record<string, unknown>;
      toolCount: number;
      isLoaded: boolean;
      prompt: string | null;
      defaultPrompt: string | null;
    }>;
  };
  togglePlugin: {
    params: { name: string; enabled: boolean };
    response: { success: boolean };
  };
  getPluginSettings: {
    params: { name: string };
    response: Record<string, unknown>;
  };
  savePluginSettings: {
    params: { name: string; settings: Record<string, unknown> };
    response: { success: boolean };
  };
  savePluginPrompt: {
    params: { name: string; prompt: string | null };
    response: { success: boolean };
  };
  getPluginExtensions: {
    params: Record<string, never>;
    response: {
      sidebarItems: Array<{ id: string; label: string; icon: string; href: string; pluginName: string }>;
      projectTabs: Array<{ id: string; label: string; description?: string; pluginName: string }>;
      settingsSections: Array<{
        id: string;
        title: string;
        description?: string;
        pluginName: string;
        fields: Array<{ key: string; label: string; type: string; description?: string; default?: unknown }>;
      }>;
      chatCommands: Array<{ name: string; description: string; pattern?: string; pluginName: string }>;
      themes: Array<{ tokens: Record<string, string>; css?: string; pluginName: string }>;
    };
  };
};
