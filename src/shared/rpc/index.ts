import type { RPCSchema } from "electrobun/bun";

import type { SettingsRequests } from "./settings";
import type { ProvidersRequests } from "./providers";
import type { ProjectsRequests } from "./projects";
import type { ConversationsRequests } from "./conversations";
import type { AgentsRequests } from "./agents";
import type { KanbanRequests } from "./kanban";
import type { NotesRequests } from "./notes";
import type { DeployRequests } from "./deploy";
import type { GitRequests } from "./git";
import type { IntegrationsRequests } from "./integrations";
import type { InboxRequests } from "./inbox";
import type { AnalyticsRequests } from "./analytics";
import type { SystemRequests, BunMessages } from "./system";
import type { PluginsRequests } from "./plugins";
import type { LspRequests } from "./lsp";
import type { DashboardRequests } from "./dashboard";
import type { SkillsRequests } from "./skills";
import type { CouncilRequests } from "./council";
import type { UpdaterRequests } from "./updater";
import type { FreelanceRequests, FreelanceListingDto, FreelanceChatMessageDto } from "./freelance";
import type { WebviewSchema } from "./webview";

type BunRequests =
  & SettingsRequests
  & ProvidersRequests
  & ProjectsRequests
  & ConversationsRequests
  & AgentsRequests
  & KanbanRequests
  & NotesRequests
  & DeployRequests
  & GitRequests
  & IntegrationsRequests
  & InboxRequests
  & AnalyticsRequests
  & SystemRequests
  & PluginsRequests
  & LspRequests
  & DashboardRequests
  & SkillsRequests
  & CouncilRequests
  & UpdaterRequests
  & FreelanceRequests;

export type AgentDeskRPC = {
  bun: RPCSchema<{
    requests: BunRequests;
    messages: BunMessages;
  }>;
  webview: WebviewSchema;
};

// Re-export domain types for consumers that need them directly
export type {
  SettingsRequests,
  ProvidersRequests,
  ProjectsRequests,
  ConversationsRequests,
  AgentsRequests,
  KanbanRequests,
  NotesRequests,
  DeployRequests,
  GitRequests,
  IntegrationsRequests,
  InboxRequests,
  AnalyticsRequests,
  SystemRequests,
  BunMessages,
  PluginsRequests,
  LspRequests,
  DashboardRequests,
  SkillsRequests,
  CouncilRequests,
  UpdaterRequests,
  FreelanceRequests,
  FreelanceListingDto,
  FreelanceChatMessageDto,
  WebviewSchema,
};
