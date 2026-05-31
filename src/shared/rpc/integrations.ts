type ChannelRow = {
  id: string;
  projectId: string | null;
  platform: string;
  config: string;
  enabled: number;
  createdAt: string;
  updatedAt: string;
};

export type IntegrationsRequests = {
  // Discord
  getDiscordConfigs: {
    params: Record<string, never>;
    response: Array<ChannelRow>;
  };
  saveDiscordConfig: {
    params: {
      id?: string;
      projectId?: string;
      token: string;
      serverId: string;
      channelId: string;
      enabled?: boolean;
    };
    response: { success: boolean; id: string };
  };
  deleteDiscordConfig: {
    params: { id: string };
    response: { success: boolean };
  };
  testDiscordConnection: {
    params: { token: string };
    response: {
      success: boolean;
      error?: string;
      botName?: string;
      servers?: Array<{ id: string; name: string }>;
    };
  };
  getDiscordStatus: {
    params: Record<string, never>;
    response: { status: "connected" | "disconnected" | "reconnecting" | "error" };
  };

  // WhatsApp
  getWhatsAppConfigs: {
    params: Record<string, never>;
    response: Array<ChannelRow>;
  };
  saveWhatsAppConfig: {
    params: { id?: string; projectId?: string; enabled?: boolean };
    response: { success: boolean; id: string };
  };
  deleteWhatsAppConfig: {
    params: { id: string };
    response: { success: boolean };
  };
  getWhatsAppStatus: {
    params: { id: string };
    response: { status: string; phoneNumber?: string };
  };
  connectWhatsApp: {
    params: { id: string };
    response: { success: boolean; error?: string };
  };
  getDefaultChannelProject: {
    params: Record<string, never>;
    response: { projectId: string | null };
  };
  setDefaultChannelProject: {
    params: { projectId: string | null };
    response: { success: boolean };
  };

  // Email
  getEmailConfigs: {
    params: Record<string, never>;
    response: Array<ChannelRow>;
  };
  saveEmailConfig: {
    params: {
      id?: string;
      projectId?: string;
      imapHost: string;
      imapPort: number;
      imapUser: string;
      imapPass: string;
      imapTls: boolean;
      smtpHost: string;
      smtpPort: number;
      smtpUser: string;
      smtpPass: string;
      smtpTls: boolean;
      enabled?: boolean;
    };
    response: { success: boolean; id: string };
  };
  deleteEmailConfig: {
    params: { id: string };
    response: { success: boolean };
  };
  testEmailConnection: {
    params: {
      imapHost: string;
      imapPort: number;
      imapUser: string;
      imapPass: string;
      imapTls: boolean;
      smtpHost: string;
      smtpPort: number;
      smtpUser: string;
      smtpPass: string;
      smtpTls: boolean;
    };
    response: { success: boolean; error?: string };
  };
};
