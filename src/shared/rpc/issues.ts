// ---------------------------------------------------------------------------
// Multi-source issue tracker contracts
//
// AgentDesk imports issues from several external trackers into one normalised
// `external_issues` table. GitHub is the original source (configured via the
// existing Project Settings repo URL + Settings › GitHub token); every other
// source stores its own per-project config (URL / API keys) in the settings
// table under category "issue_sources".
// ---------------------------------------------------------------------------

export type IssueSource = "github" | "jira" | "linear" | "gitlab" | "trello" | "kanboard";

/** A single config field an external source needs, used to render its setup form. */
export interface IssueSourceFieldDescriptor {
  key: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  required?: boolean;
  help?: string;
}

export interface IssueSourceCapabilities {
  /** Can close/resolve the issue when its linked kanban task moves to Done. */
  autoClose: boolean;
  /** Can push a kanban task out as a new issue/card. */
  createFromTask: boolean;
  /** Imports an assignee name. */
  assignee: boolean;
  /** Imports / maps a priority. */
  priority: boolean;
}

/**
 * Sources whose issues live in user-defined buckets (Kanboard columns, Trello
 * lists, Jira statuses) expose this so the configure dialog can let the user
 * pick which buckets to import after a successful connection test.
 */
export interface BucketSelectionSpec {
  /** Plural noun for the buckets, e.g. "Columns", "Lists", "Statuses". */
  label: string;
  /** Noun for the grouping level, e.g. "Project" (Kanboard). Omitted for single-group sources. */
  groupLabel?: string;
  /**
   * When true, ≥1 bucket must be selected to save (the buckets are the only
   * open/closed signal — Kanboard, Trello). When false the selection just
   * narrows an already-reliable default (Jira's statusCategory).
   */
  required: boolean;
}

export interface IssueSourceDescriptor {
  source: IssueSource;
  label: string;
  /** Short tag shown on issue cards (e.g. "GH", "JR"). */
  badge: string;
  /** When true the source reuses existing global/project settings — no inline config form. */
  usesGlobalConfig?: boolean;
  fields: IssueSourceFieldDescriptor[];
  capabilities: IssueSourceCapabilities;
  /** Present when the source supports import-by-bucket (column/list/status). */
  bucketSelection?: BucketSelectionSpec;
  /** One-line hint shown in the configure dialog. */
  configHint?: string;
  /** Link to where the user obtains credentials. */
  docsUrl?: string;
}

/**
 * Static descriptors shared by the renderer (to build config forms) and the
 * backend (to validate required fields). The actual fetch/sync logic lives in
 * the per-source adapters under src/bun/issue-sources/.
 */
export const ISSUE_SOURCE_DESCRIPTORS: IssueSourceDescriptor[] = [
  {
    source: "github",
    label: "GitHub",
    badge: "GH",
    usesGlobalConfig: true,
    fields: [],
    capabilities: { autoClose: true, createFromTask: true, assignee: false, priority: false },
    configHint:
      "GitHub uses the Repository URL from Project Settings › General and the Personal Access Token from Settings › GitHub.",
    docsUrl: "https://github.com/settings/tokens",
  },
  {
    source: "jira",
    label: "Jira",
    badge: "JR",
    fields: [
      { key: "baseUrl", label: "Jira Site URL", type: "text", placeholder: "https://your-team.atlassian.net", required: true, help: "Your Atlassian Cloud site URL." },
      { key: "email", label: "Account Email", type: "text", placeholder: "you@company.com", required: true },
      { key: "apiToken", label: "API Token", type: "password", required: true, help: "Create one at id.atlassian.com › Security › API tokens." },
      { key: "projectKey", label: "Project Key", type: "text", placeholder: "ENG", required: true, help: "The short key prefixing your issues, e.g. ENG-123." },
    ],
    capabilities: { autoClose: true, createFromTask: true, assignee: true, priority: true },
    bucketSelection: { label: "Statuses", required: false },
    configHint: "Imports open issues (anything not in the Done category). Optionally Test the connection to narrow to specific statuses.",
    docsUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
  },
  {
    source: "linear",
    label: "Linear",
    badge: "LN",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "lin_api_...", required: true, help: "Linear › Settings › API › Personal API keys." },
      { key: "teamId", label: "Team ID or Key", type: "text", placeholder: "ENG (optional)", required: false, help: "Optional. Limits sync to one team; leave blank to sync the whole workspace." },
    ],
    capabilities: { autoClose: true, createFromTask: true, assignee: true, priority: true },
    docsUrl: "https://linear.app/settings/api",
  },
  {
    source: "gitlab",
    label: "GitLab",
    badge: "GL",
    fields: [
      { key: "baseUrl", label: "GitLab URL", type: "text", placeholder: "https://gitlab.com", required: false, help: "Defaults to https://gitlab.com. Set for self-hosted instances." },
      { key: "projectPath", label: "Project Path or ID", type: "text", placeholder: "group/project", required: true, help: "The namespace/project path, or numeric Project ID." },
      { key: "token", label: "Personal Access Token", type: "password", required: true, help: "Scopes: read_api (or api to create/close). Profile › Access Tokens." },
    ],
    capabilities: { autoClose: true, createFromTask: true, assignee: true, priority: true },
    docsUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
  },
  {
    source: "trello",
    label: "Trello",
    badge: "TR",
    fields: [
      { key: "apiKey", label: "API Key", type: "text", required: true, help: "Generate at trello.com/power-ups/admin (a Power-Up API key)." },
      { key: "token", label: "API Token", type: "password", required: true, help: "Authorize the API key to mint a long-lived token." },
      { key: "boardId", label: "Board ID", type: "text", placeholder: "From the board URL", required: true, help: "The ID in https://trello.com/b/<boardId>/..." },
    ],
    capabilities: { autoClose: true, createFromTask: true, assignee: false, priority: false },
    bucketSelection: { label: "Lists", required: true },
    configHint: "After Testing the connection, pick which board lists to import. Only the latest 100 cards are synced.",
    docsUrl: "https://trello.com/power-ups/admin",
  },
  {
    source: "kanboard",
    label: "Kanboard",
    badge: "KB",
    fields: [
      { key: "url", label: "Kanboard URL", type: "text", placeholder: "https://kanboard.example.com", required: true, help: "Base URL of your Kanboard install (no trailing /jsonrpc.php)." },
      { key: "apiToken", label: "API Token", type: "password", required: true, help: "The application API token from Kanboard › Settings › API." },
      { key: "projectId", label: "Project IDs", type: "text", placeholder: "16, 11, 3", required: true, help: "One or more numeric project ids, comma-separated. Shown in each project's URL." },
    ],
    capabilities: { autoClose: true, createFromTask: true, assignee: true, priority: true },
    bucketSelection: { label: "Columns", groupLabel: "Project", required: true },
    configHint: "After Testing the connection, pick which board columns to import. Only the latest 100 open tasks are synced.",
    docsUrl: "https://docs.kanboard.org/v1/api/",
  },
];

export function getIssueSourceDescriptor(source: IssueSource): IssueSourceDescriptor | undefined {
  return ISSUE_SOURCE_DESCRIPTORS.find((d) => d.source === source);
}

/** Like getIssueSourceDescriptor but asserts presence — every IssueSource has a descriptor. */
export function requireIssueSourceDescriptor(source: IssueSource): IssueSourceDescriptor {
  const descriptor = getIssueSourceDescriptor(source);
  if (!descriptor) throw new Error(`Unknown issue source: ${source}`);
  return descriptor;
}

/** A normalised external issue as stored and returned to the renderer. */
export interface ExternalIssue {
  id: string;
  projectId: string;
  source: IssueSource;
  sourceId: string;
  taskId: string | null;
  title: string;
  body: string | null;
  state: string; // "open" | "closed"
  url: string | null;
  labels: string[];
  assignee: string | null;
  priority: string | null;
  dueDate: string | null;
  sourceCreatedAt: string | null;
  syncedAt: string;
}

export interface IssueSourceStatus {
  source: IssueSource;
  configured: boolean;
}

export type IssuesRequests = {
  /** Per-project configured/unconfigured status for every supported source. */
  listIssueSources: {
    params: { projectId: string };
    response: IssueSourceStatus[];
  };
  /** Get the saved config (field values) for a source, or {} if none. */
  getIssueSourceConfig: {
    params: { projectId: string; source: IssueSource };
    response: { config: Record<string, string> };
  };
  saveIssueSourceConfig: {
    params: { projectId: string; source: IssueSource; config: Record<string, string> };
    response: { success: boolean; error?: string };
  };
  deleteIssueSourceConfig: {
    params: { projectId: string; source: IssueSource };
    response: { success: boolean };
  };
  /** Validate a (possibly unsaved) config against the live API. */
  testIssueSource: {
    params: { projectId: string; source: IssueSource; config?: Record<string, string> };
    response: { ok: boolean; error?: string; detail?: string };
  };
  getExternalIssues: {
    params: { projectId: string; source?: IssueSource; state?: string };
    response: ExternalIssue[];
  };
  syncIssueSource: {
    params: { projectId: string; source: IssueSource };
    response: { synced: number; created: number; closed: number; error?: string };
  };
  linkExternalIssueToTask: {
    params: { issueId: string; taskId: string | null };
    response: { success: boolean };
  };
  createExternalIssueFromTask: {
    params: { taskId: string; projectId: string; source: IssueSource };
    response: { success: boolean; url?: string; error?: string };
  };
  /** Validate the connection and list a source's selectable buckets (columns/lists/statuses). */
  getSourceBuckets: {
    params: { source: IssueSource; config: Record<string, string> };
    response: {
      ok: boolean;
      error?: string;
      groups?: Array<{ groupId: string; groupName: string; buckets: Array<{ id: string; title: string }> }>;
    };
  };
};
