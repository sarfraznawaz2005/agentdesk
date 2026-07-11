import { sqliteTable, text, integer, real, uniqueIndex, blob } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
// Generic key/value store for application configuration. Values are stored as
// JSON-serialized strings so any serializable type can be persisted.
export const settings = sqliteTable("settings", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	key: text("key").notNull().unique(),
	value: text("value").notNull(),
	category: text("category").notNull().default("general"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// ai_providers
// ---------------------------------------------------------------------------
// Stores configured AI provider credentials and preferences. The apiKey is
// stored in plain text for Phase 1; encryption is planned for a later phase.
export const aiProviders = sqliteTable("ai_providers", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	// "anthropic" | "openai" | "custom"
	providerType: text("provider_type").notNull(),
	// Plain text for now; will be encrypted in a future phase
	apiKey: text("api_key").notNull(),
	// Optional override for providers that expose a custom base URL
	baseUrl: text("base_url"),
	// e.g. "claude-sonnet-4-20250514"
	defaultModel: text("default_model"),
	// Boolean stored as 0/1 — only one provider should have isDefault = 1
	isDefault: integer("is_default").notNull().default(0),
	// Cached result of the last API key validation attempt
	isValid: integer("is_valid").notNull().default(0),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------
// A project maps to a local workspace directory and optionally a GitHub repo.
// status: "active" | "idle" | "paused" | "completed" | "archived"
// A case-insensitive UNIQUE index on `name` (idx_projects_name_nocase, COLLATE
// NOCASE) is created in migration v51 — not expressible via Drizzle `.unique()`,
// which would be case-sensitive. v51 skips it if pre-existing dupes are present.
export const projects = sqliteTable("projects", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	description: text("description"),
	// "active" | "idle" | "paused" | "completed" | "archived"
	status: text("status").notNull().default("active"),
	workspacePath: text("workspace_path").notNull(),
	githubUrl: text("github_url"),
	workingBranch: text("working_branch"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------
// Defines the built-in and user-created AI agents available in the app.
// isBuiltin = 1 for agents shipped with the application, 0 for custom ones.
// Case-insensitive UNIQUE indexes on `name` and `display_name`
// (idx_agents_name_nocase / idx_agents_display_name_nocase, COLLATE NOCASE) are
// created in migration v51 (skipped if pre-existing dupes are present).
export const agents = sqliteTable("agents", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	// Internal identifier (e.g. "orchestrator", "coder")
	name: text("name").notNull(),
	// Human-readable label shown in the UI
	displayName: text("display_name").notNull(),
	// Hex color string used to visually distinguish the agent in the UI
	color: text("color").notNull(),
	systemPrompt: text("system_prompt").notNull().default(""),
	// 1 = shipped with the app, 0 = user-defined
	isBuiltin: integer("is_builtin").notNull().default(1),
	// Per-agent AI provider override (null = use project/global default)
	providerId: text("provider_id"),
	// Per-agent model override (null = use provider default)
	modelId: text("model_id"),
	// Per-agent generation parameters
	temperature: text("temperature"),
	maxTokens: integer("max_tokens"),
	// 1 = agent is active, 0 = agent is disabled
	isEnabled: integer("is_enabled").notNull().default(1),
	// Per-agent thinking budget override: null = use default, "low" | "medium" | "high"
	thinkingBudget: text("thinking_budget"),
	// Custom-agent flags (only meaningful when isBuiltin = 0)
	// 1 = skip AgentDesk's internal code-related prompt prefix; use only the user's system prompt as-is.
	useSystemPromptOnly: integer("use_system_prompt_only").notNull().default(0),
	// 1 = expose this custom agent in the chat picker (semantics defined separately).
	chatEnabled: integer("chat_enabled").notNull().default(0),
	// 1 = include this custom agent in the PM's system prompt so it can be
	// orchestrated. Default 1 preserves the historical "all custom agents are
	// visible to PM" behavior on upgrade. Ignored for built-in agents.
	availableToPm: integer("available_to_pm").notNull().default(1),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// agent_tools
// ---------------------------------------------------------------------------
// Associates tools with agents and tracks whether each tool is enabled.
// The optional config column holds JSON-encoded tool-specific configuration.
export const agentTools = sqliteTable("agent_tools", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	agentId: text("agent_id")
		.notNull()
		.references(() => agents.id),
	toolName: text("tool_name").notNull(),
	// 1 = enabled, 0 = disabled
	isEnabled: integer("is_enabled").notNull().default(1),
	// JSON-encoded tool configuration; null when not applicable
	config: text("config"),
});

// conversations
export const conversations = sqliteTable("conversations", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").notNull().references(() => projects.id),
	title: text("title").notNull().default("New conversation"),
	isPinned: integer("is_pinned").notNull().default(0),
	isArchived: integer("is_archived").notNull().default(0),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// messages
export const messages = sqliteTable("messages", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	conversationId: text("conversation_id").notNull().references(() => conversations.id),
	role: text("role").notNull(), // "user" | "assistant" | "system" | "tool"
	agentId: text("agent_id"), // null for user messages
	agentName: text("agent_name"), // sub-agent name for inline rendering
	content: text("content").notNull(),
	metadata: text("metadata"), // JSON: tool calls, usage stats, model
	tokenCount: integer("token_count").notNull().default(0),
	hasParts: integer("has_parts").notNull().default(0), // 1 if message_parts exist
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// conversation_summaries
export const conversationSummaries = sqliteTable("conversation_summaries", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	conversationId: text("conversation_id").notNull().references(() => conversations.id),
	summaryText: text("summary_text").notNull(),
	messagesUpToId: text("messages_up_to_id").notNull(),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------
// Agent-created or user-created notes/documents within a project.
export const notes = sqliteTable("notes", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id),
	title: text("title").notNull(),
	content: text("content").notNull(),
	authorAgentId: text("author_agent_id"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// agent_memories
// ---------------------------------------------------------------------------
// Per-(agent + project) durable memory. Distinct from `notes` (project docs) and
// DECISIONS.md (architectural decisions): these are an agent's own learnings and
// things the USER asked it to remember. A compact index (title + description) is
// auto-injected into the agent's system prompt every run; full `content` is
// pulled on demand via the recall_memory tool. Size is bounded by caps in
// agents/tools/memory.ts (content length, soft/hard count caps with LRU evict).
// Indexes (incl. the UNIQUE(project_id, agent_name, title) dedup key) are
// created in migration v49 — matching the codebase convention of defining
// indexes in raw-SQL migrations rather than inline in the Drizzle schema.
export const agentMemories = sqliteTable("agent_memories", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id),
	agentName: text("agent_name").notNull(),
	title: text("title").notNull(),
	// One-line relevance hook shown in the always-on index (drives recall).
	description: text("description").notNull().default(""),
	content: text("content").notNull(),
	// LRU bookkeeping for eviction at the hard cap.
	recallCount: integer("recall_count").notNull().default(0),
	lastRecalledAt: text("last_recalled_at"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// kanban_tasks
// ---------------------------------------------------------------------------
// Kanban board tasks within a project, managed by agents and humans.
export const kanbanTasks = sqliteTable("kanban_tasks", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id),
	title: text("title").notNull(),
	description: text("description"),
	// JSON array of { text: string; checked: boolean }
	acceptanceCriteria: text("acceptance_criteria"),
	importantNotes: text("important_notes"),
	// "backlog" | "working" | "review" | "done"
	column: text("column").notNull().default("backlog"),
	// Number of code-review rounds this task has gone through (per-task review model)
	reviewRounds: integer("review_rounds").notNull().default(0),
	// "critical" | "high" | "medium" | "low"
	priority: text("priority").notNull().default("medium"),
	assignedAgentId: text("assigned_agent_id"),
	// JSON array of task IDs that block this task
	blockedBy: text("blocked_by"),
	dueDate: text("due_date"),
	// Position within column for ordering
	position: integer("position").notNull().default(0),
	// "passed" | "failed" | null — set by verify_implementation tool
	verificationStatus: text("verification_status"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// kanban_task_activity
// ---------------------------------------------------------------------------
// Activity log for kanban task changes (moves, edits, comments).
export const kanbanTaskActivity = sqliteTable("kanban_task_activity", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	taskId: text("task_id")
		.notNull()
		.references(() => kanbanTasks.id),
	// "created" | "moved" | "updated" | "comment" | "assigned" | "completed"
	type: text("type").notNull(),
	// Who performed the action: agent ID or "human"
	actorId: text("actor_id"),
	// JSON details about the change (e.g. { from: "backlog", to: "working" })
	data: text("data"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------
export const plugins = sqliteTable("plugins", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull().unique(),
	version: text("version").notNull(),
	enabled: integer("enabled").notNull().default(1),
	settings: text("settings").default("{}"),
	/** Optional prompt snippet injected into agent system prompts when plugin is enabled */
	prompt: text("prompt"),
	installedAt: text("installed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// Channels (Discord, future platforms)
// ---------------------------------------------------------------------------
export const channels = sqliteTable("channels", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").references(() => projects.id),
	platform: text("platform").notNull().default("discord"),
	config: text("config").notNull().default("{}"),
	enabled: integer("enabled").notNull().default(0),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

export const deployEnvironments = sqliteTable("deploy_environments", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").notNull().references(() => projects.id),
	name: text("name").notNull(),
	branch: text("branch"),
	command: text("command").notNull(),
	url: text("url"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const deployHistory = sqliteTable("deploy_history", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	environmentId: text("environment_id").notNull().references(() => deployEnvironments.id),
	status: text("status").notNull().default("pending"),
	logOutput: text("log_output"),
	triggeredBy: text("triggered_by").notNull().default("human"),
	durationMs: integer("duration_ms"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------
// User-created and built-in prompt templates for reuse in chat.
// category: "builtin" for shipped templates, "custom" for user-created ones.
export const prompts = sqliteTable("prompts", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	description: text("description").notNull().default(""),
	content: text("content").notNull(),
	category: text("category").notNull().default("custom"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// inbox_messages
// ---------------------------------------------------------------------------
export const inboxMessages = sqliteTable("inbox_messages", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").references(() => projects.id),
  channelId: text("channel_id"),
  sender: text("sender").notNull(),
  content: text("content").notNull(),
  isRead: integer("is_read").notNull().default(0),
  agentResponse: text("agent_response"),
	threadId: text("thread_id"),
	priority: integer("priority").notNull().default(0),
	category: text("category").notNull().default("chat"),
	platform: text("platform").notNull().default("chat"),
	isArchived: integer("is_archived").notNull().default(0),
	isFavorite: integer("is_favorite").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const whatsappSessions = sqliteTable("whatsapp_sessions", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	channelId: text("channel_id").notNull(),
	creds: text("creds").notNull().default("{}"),
	keys: text("keys").notNull().default("{}"),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const notificationPreferences = sqliteTable("notification_preferences", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	platform: text("platform").notNull(),
	projectId: text("project_id").references(() => projects.id),
	soundEnabled: integer("sound_enabled").notNull().default(1),
	badgeEnabled: integer("badge_enabled").notNull().default(1),
	bannerEnabled: integer("banner_enabled").notNull().default(1),
	muteUntil: text("mute_until"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const inboxRules = sqliteTable("inbox_rules", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").references(() => projects.id),
	name: text("name").notNull(),
	conditions: text("conditions").notNull().default("[]"),
	actions: text("actions").notNull().default("[]"),
	enabled: integer("enabled").notNull().default(1),
	priority: integer("priority").notNull().default(0),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// cron_jobs — scheduled tasks
// ---------------------------------------------------------------------------
export const cronJobs = sqliteTable("cron_jobs", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").references(() => projects.id),
	name: text("name").notNull(),
	cronExpression: text("cron_expression").notNull(),
	timezone: text("timezone").notNull().default("UTC"),
	taskType: text("task_type").notNull(),
	taskConfig: text("task_config").notNull().default("{}"),
	enabled: integer("enabled").notNull().default(1),
	oneShot: integer("one_shot").notNull().default(0),
	lastRunAt: text("last_run_at"),
	lastRunStatus: text("last_run_status"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// cron_job_history — execution log
// ---------------------------------------------------------------------------
export const cronJobHistory = sqliteTable("cron_job_history", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	jobId: text("job_id").notNull(),
	startedAt: text("started_at").notNull(),
	completedAt: text("completed_at"),
	status: text("status").notNull(),
	output: text("output"),
	durationMs: integer("duration_ms"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// automation_rules — event-triggered automations
// ---------------------------------------------------------------------------
export const automationRules = sqliteTable("automation_rules", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").references(() => projects.id),
	name: text("name").notNull(),
	trigger: text("trigger").notNull(),
	actions: text("actions").notNull(),
	enabled: integer("enabled").notNull().default(1),
	priority: integer("priority").notNull().default(0),
	lastTriggeredAt: text("last_triggered_at"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// pull_requests — local PR tracking (GitHub-synced or local-only)
// ---------------------------------------------------------------------------
export const pullRequests = sqliteTable("pull_requests", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").notNull().references(() => projects.id),
	prNumber: integer("pr_number"), // GitHub PR number when synced
	title: text("title").notNull(),
	description: text("description"),
	sourceBranch: text("source_branch").notNull(),
	targetBranch: text("target_branch").notNull(),
	// "open" | "review" | "merged" | "closed"
	state: text("state").notNull().default("open"),
	authorName: text("author_name"),
	linkedTaskId: text("linked_task_id"),
	mergeStrategy: text("merge_strategy"), // "merge" | "squash" | "rebase"
	mergedAt: text("merged_at"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// pr_comments — code review comment threads on PRs
// ---------------------------------------------------------------------------
export const prComments = sqliteTable("pr_comments", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	prId: text("pr_id").notNull().references(() => pullRequests.id),
	file: text("file"), // null = general PR comment
	lineNumber: integer("line_number"),
	content: text("content").notNull(),
	authorName: text("author_name").notNull(),
	authorType: text("author_type").notNull().default("human"), // "human" | "agent"
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// webhook_configs — GitHub webhook polling configuration
// ---------------------------------------------------------------------------
export const webhookConfigs = sqliteTable("webhook_configs", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").notNull().references(() => projects.id),
	name: text("name").notNull(),
	// JSON array of event types: "push" | "pull_request" | "issues" | "release"
	events: text("events").notNull().default("[]"),
	enabled: integer("enabled").notNull().default(1),
	lastPollAt: text("last_poll_at"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// webhook_events — event log from GitHub polling
// ---------------------------------------------------------------------------
export const webhookEvents = sqliteTable("webhook_events", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").notNull(),
	// "push" | "pull_request" | "issues" | "release" | "workflow_run"
	eventType: text("event_type").notNull(),
	title: text("title").notNull(),
	// JSON payload summary
	payload: text("payload").notNull().default("{}"),
	// "pending" | "processed" | "ignored"
	status: text("status").notNull().default("pending"),
	processedAt: text("processed_at"),
	// GitHub event ID for O(1) dedup
	githubEventId: text("github_event_id"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// github_issues — GitHub issues synced to/from kanban tasks
// ---------------------------------------------------------------------------
export const githubIssues = sqliteTable("github_issues", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").notNull().references(() => projects.id),
	githubIssueNumber: integer("github_issue_number").notNull(),
	taskId: text("task_id"), // linked kanban task (null if not linked)
	title: text("title").notNull(),
	body: text("body"),
	state: text("state").notNull().default("open"), // "open" | "closed"
	// JSON array of label names
	labels: text("labels").notNull().default("[]"),
	githubCreatedAt: text("github_created_at"),
	syncedAt: text("synced_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// external_issues — issues imported from any external tracker (GitHub, Jira,
// Linear, GitLab, Trello, Kanboard) normalised into one table. Supersedes
// github_issues (migration v33 copies that table's rows in with source='github').
// ---------------------------------------------------------------------------
export const externalIssues = sqliteTable("external_issues", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").notNull().references(() => projects.id),
	// "github" | "jira" | "linear" | "gitlab" | "trello" | "kanboard"
	source: text("source").notNull(),
	// platform-specific identifier (GitHub issue #, Jira key, Linear id, card id…)
	sourceId: text("source_id").notNull(),
	taskId: text("task_id"), // linked kanban task (null if not linked)
	title: text("title").notNull(),
	body: text("body"),
	state: text("state").notNull().default("open"), // normalised "open" | "closed"
	url: text("url"), // deep-link back to the original issue
	labels: text("labels").notNull().default("[]"), // JSON array of label names
	assignee: text("assignee"),
	priority: text("priority"), // "critical" | "high" | "medium" | "low" | null
	dueDate: text("due_date"), // ISO date if the source provides one
	sourceCreatedAt: text("source_created_at"),
	syncedAt: text("synced_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	// JSON blob of source-specific extras (sprint, story points, list name…)
	metadata: text("metadata").notNull().default("{}"),
});

// ---------------------------------------------------------------------------
// issue_fixer_config — per-project Issue Fixer configuration (one row/project)
// ---------------------------------------------------------------------------
export const issueFixerConfig = sqliteTable("issue_fixer_config", {
	projectId: text("project_id").primaryKey().references(() => projects.id),
	enabled: integer("enabled").notNull().default(0),
	// JSON array of agentdesk-* trigger keywords
	keywords: text("keywords").notNull().default("[]"),
	// JSON array of agentdesk-* trigger labels
	labels: text("labels").notNull().default("[]"),
	// "collab" | "label" | "both"
	authMode: text("auth_mode").notNull().default("both"),
	pollIntervalMin: integer("poll_interval_min").notNull().default(60),
	// "branch_pr" | "draft"
	autonomy: text("autonomy").notNull().default("branch_pr"),
	testCommand: text("test_command"),
	customInstructions: text("custom_instructions"),
	// "global" | "custom" (custom token stored in settings as project:<id>:githubToken)
	tokenSource: text("token_source").notNull().default("global"),
	cooldownSec: integer("cooldown_sec").notNull().default(0),
	maxPerHour: integer("max_per_hour").notNull().default(5),
	// JSON array of channel ids to notify on success/failure
	notifyChannels: text("notify_channels").notNull().default("[]"),
	// Whether to broadcast run results to connected channels (Discord/email/etc.)
	notifyEnabled: integer("notify_enabled").notNull().default(0),
	// ISO timestamp — only issues/comments at or after this are considered
	cursorAt: text("cursor_at"),
	lastPolledAt: text("last_polled_at"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// issue_fix_runs — history/log of Issue Fixer runs
// ---------------------------------------------------------------------------
export const issueFixRuns = sqliteTable("issue_fix_runs", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").notNull().references(() => projects.id),
	issueNumber: integer("issue_number").notNull(),
	issueTitle: text("issue_title").notNull().default(""),
	issueUrl: text("issue_url"),
	// "title" | "comment" | "pr_comment" | "label"
	triggerType: text("trigger_type").notNull(),
	triggerKeyword: text("trigger_keyword"),
	// GitHub comment id for comment/pr_comment triggers (null for title/label) — used for dedup
	triggerCommentId: text("trigger_comment_id"),
	intent: text("intent").notNull(),
	author: text("author"),
	authorized: integer("authorized").notNull().default(0),
	// "queued" | "fixing" | "testing" | "pushing" | "pr_created" | "pr_updated" | "failed" | "ignored" | "cancelled"
	status: text("status").notNull().default("queued"),
	branchName: text("branch_name"),
	prNumber: integer("pr_number"),
	prUrl: text("pr_url"),
	testPassed: integer("test_passed"), // nullable boolean (0/1)
	conversationId: text("conversation_id"),
	summary: text("summary"),
	error: text("error"),
	startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	finishedAt: text("finished_at"),
});

// ---------------------------------------------------------------------------
// branch_strategies — per-project branching model configuration
// ---------------------------------------------------------------------------
export const branchStrategies = sqliteTable("branch_strategies", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").notNull().unique().references(() => projects.id),
	// "gitflow" | "github-flow" | "trunk"
	model: text("model").notNull().default("github-flow"),
	defaultBranch: text("default_branch").notNull().default("main"),
	featureBranchPrefix: text("feature_branch_prefix").notNull().default("feature/"),
	releaseBranchPrefix: text("release_branch_prefix").notNull().default("release/"),
	hotfixBranchPrefix: text("hotfix_branch_prefix").notNull().default("hotfix/"),
	// Template: "feature/{task-id}-{slug}"
	namingTemplate: text("naming_template").notNull().default("feature/{task-id}-{slug}"),
	// JSON array of protected branch names
	protectedBranches: text("protected_branches").notNull().default('["main","master"]'),
	autoCleanup: integer("auto_cleanup").notNull().default(0),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// cost_budgets — monthly spend alerts per project
// ---------------------------------------------------------------------------
export const costBudgets = sqliteTable("cost_budgets", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId: text("project_id").references(() => projects.id), // null = global
	// "daily" | "weekly" | "monthly"
	period: text("period").notNull().default("monthly"),
	limitUsd: text("limit_usd").notNull(), // stored as string to avoid float precision
	alertThreshold: integer("alert_threshold").notNull().default(80), // % of limit
	enabled: integer("enabled").notNull().default(1),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// audit_log — Phase 13: track user/system actions
// ---------------------------------------------------------------------------
export const auditLog = sqliteTable("audit_log", {
	id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	action: text("action").notNull(),
	entityType: text("entity_type").notNull(),
	entityId: text("entity_id"),
	details: text("details"), // JSON
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// message_parts — decomposed message content for inline agent rendering
// ---------------------------------------------------------------------------
// Each message can have multiple parts: text, tool_call, tool_result, reasoning,
// agent_start, agent_end. Enables rich inline rendering of sub-agent execution.
export const messageParts = sqliteTable("message_parts", {
	id: text("id").primaryKey().notNull(),
	messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
	type: text("type").notNull(), // 'text' | 'tool_call' | 'tool_result' | 'reasoning' | 'agent_start' | 'agent_end'
	content: text("content").notNull().default(""),
	toolName: text("tool_name"),
	toolInput: text("tool_input"), // JSON
	toolOutput: text("tool_output"),
	toolState: text("tool_state").default("pending"), // 'pending' | 'running' | 'success' | 'error'
	sortOrder: integer("sort_order").notNull().default(0),
	timeStart: text("time_start"),
	timeEnd: text("time_end"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ---------------------------------------------------------------------------
// freelance_listings — scraped/fetched listings from freelance platforms
// ---------------------------------------------------------------------------
// Stores job listings fetched from platforms like Upwork, Freelancer, etc.
// skills is a JSON array of skill strings.
// budget_type: "fixed" | "hourly"
// status: "new" | "reviewed" | "applied" | "ignored"
export const freelanceListings = sqliteTable("freelance_listings", {
	id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	platform:    text("platform").notNull(),
	externalId:  text("external_id").notNull(),
	title:       text("title").notNull(),
	description: text("description").notNull(),
	skills:      text("skills").notNull().default("[]"),
	budgetType:  text("budget_type").notNull().default("fixed"),
	budgetMin:   integer("budget_min"),
	budgetMax:   integer("budget_max"),
	currency:    text("currency").notNull().default("USD"),
	url:               text("url").notNull(),
	fullDescription:   text("full_description"),
	wizardVerdict:     text("wizard_verdict"),    // "workable" | "not_workable" | null
	wizardAnalyzedAt:  text("wizard_analyzed_at"), // ISO timestamp of last wizard analysis
	wizardReason:      text("wizard_reason"),      // one-sentence AI verdict reason
	wizardBlockers:    text("wizard_blockers"),    // JSON array of blocker strings
	wizardAnalysisText: text("wizard_analysis_text"), // full AI analysis text from Phase 1
	wizardBlockKind:   text("wizard_block_kind"),  // origin of a not_workable verdict: "non_software"|"skill_gate"|"client_quality" (filter → yellow) | "analysis" (red/green) | null (legacy)
	clientRating:          real("client_rating"),          // extracted from listing page (0.0–5.0)
	clientReviewCount:     integer("client_review_count"), // number of reviews the client has
	clientMemberSince:     text("client_member_since"),    // e.g. "Jun 11, 2026"
	clientPaymentVerified: integer("client_payment_verified").notNull().default(0),
	clientCountry:         text("client_country"),         // e.g. "India" — for country-block filter
	postedAt:          text("posted_at"),
	status:      text("status").notNull().default("new"),
	isDeleted:   integer("is_deleted").notNull().default(0),
	projectId:   text("project_id").references(() => projects.id),
	fetchedAt:   text("fetched_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	createdAt:   text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt:   text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const freelanceChatMessages = sqliteTable("freelance_chat_messages", {
	id:        text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	listingId: text("listing_id").notNull().references(() => freelanceListings.id),
	role:      text("role").notNull(),
	content:   text("content").notNull(),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// Auto-Earn — connected freelance accounts + intercepted inbox (read-only v1)
// ---------------------------------------------------------------------------
// These tables are populated by passively intercepting the platform's OWN
// authenticated JSON calls inside the embedded session webview (never replayed
// from Bun). One account row per platform. Sensitive fields (email, device
// tokens, payment info) are deliberately NOT stored — only what the inbox needs.

export const freelanceAccounts = sqliteTable("freelance_accounts", {
	id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	platform:    text("platform").notNull().unique(),   // "freelancer"
	selfUserId:  text("self_user_id"),                  // platform id of the logged-in user
	displayName: text("display_name"),
	profileSkills: text("profile_skills"),              // JSON array of the user's profile skills ("jobs"); used to pre-filter unbiddable projects
	profileSkillsUpdatedAt: text("profile_skills_updated_at"),
	status:      text("status").notNull().default("connected"), // connected | logged_out | error
	autonomyMode: text("autonomy_mode").notNull().default("assisted"), // assisted | full_auto
	lastSyncAt:  text("last_sync_at"),
	createdAt:   text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt:   text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const freelanceInboxThreads = sqliteTable("freelance_inbox_threads", {
	id:              text("id").primaryKey(),            // platform thread id (globally unique)
	platform:        text("platform").notNull(),
	threadType:      text("thread_type"),
	ownerId:         text("owner_id"),
	memberIds:       text("member_ids").notNull().default("[]"),  // JSON array of user ids
	clientUserId:    text("client_user_id"),             // resolved "other party" (member != self)
	contextType:     text("context_type"),               // support_session | project | ...
	contextId:       text("context_id"),                 // project id — correlation key
	title:           text("title"),                      // resolved project/job title (when known)
	listingId:       text("listing_id"),                 // resolved internal freelance_listings.id (§4a)
	listingExternalId: text("listing_external_id"),      // platform project/job id from thread JSON
	linkConfidence:  text("link_confidence"),            // certain | probable | none
	lastMessageId:   text("last_message_id"),
	lastMessageText: text("last_message_text"),
	lastMessageFrom: text("last_message_from"),
	lastMessageAt:   integer("last_message_at"),          // unix seconds
	unread:          integer("unread").notNull().default(0),
	url:             text("url"),
	createdAt:       text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt:       text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const freelanceInboxMessages = sqliteTable("freelance_inbox_messages", {
	id:        text("id").primaryKey(),                  // platform message id
	threadId:  text("thread_id").notNull(),
	fromUser:  text("from_user"),
	body:      text("body").notNull().default(""),
	sentAt:    integer("sent_at"),                       // unix seconds
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Lightweight identity cache so the inbox can render client names instead of
// raw user ids. Populated from the platform's /users payloads.
export const freelanceInboxUsers = sqliteTable("freelance_inbox_users", {
	id:          text("id").primaryKey(),                // platform user id
	platform:    text("platform").notNull(),
	username:    text("username"),
	displayName: text("display_name"),
	role:        text("role"),                           // employer | freelancer
	country:     text("country"),
	avatar:      text("avatar"),
	updatedAt:   text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Approval queue: drafted/queued replies & bids. Assisted = user edits + sends;
// full-auto = governor-paced auto-send. finalBody captures what was actually sent.
export const freelanceOutbox = sqliteTable("freelance_outbox", {
	id:           text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	platform:     text("platform").notNull(),
	kind:         text("kind").notNull(),                // reply | bid
	threadId:     text("thread_id"),                     // for replies
	listingId:    text("listing_id"),                    // for bids
	draftBody:    text("draft_body").notNull().default(""),
	finalBody:    text("final_body"),                    // what was actually sent (post-edit)
	status:       text("status").notNull().default("draft"), // draft|approved|sending|sent|failed|rejected
	autonomyMode: text("autonomy_mode").notNull().default("assisted"),
	scheduledFor: text("scheduled_for"),                 // governor's earliest-send time (ISO)
	sentAt:       text("sent_at"),
	error:        text("error"),
	createdAt:    text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt:    text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Audit trail powering the Behavior Governor's rate-limit decisions + forensics.
export const freelanceActionLog = sqliteTable("freelance_action_log", {
	id:        text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	platform:  text("platform").notNull(),
	action:    text("action").notNull(),                 // login|inbox_sync|send_reply|submit_bid|blocked
	outcome:   text("outcome").notNull().default("ok"),  // ok|blocked|error
	detail:    text("detail"),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// Auto-Earn — freelance-expert autonomous job pipeline (Full-auto)
// ---------------------------------------------------------------------------

// One row per job/opportunity. The state machine drives what the freelance-expert
// agent does next. Idempotent on (platform, thread_id).
export const freelanceJobs = sqliteTable("freelance_jobs", {
	id:           text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	platform:     text("platform").notNull(),
	threadId:     text("thread_id"),                     // platform thread id (correlation)
	listingId:    text("listing_id"),                    // internal freelance_listings.id
	listingExternalId: text("listing_external_id"),      // platform project id
	projectId:    text("project_id"),                    // AgentDesk project once bootstrapped
	clientUserId: text("client_user_id"),
	title:        text("title"),
	// state: lead | negotiating | awarded | in_progress | delivered | revisions | complete | parked
	state:        text("state").notNull().default("lead"),
	bidAmount:    integer("bid_amount"),
	currency:     text("currency"),
	earned:       integer("earned").notNull().default(0), // amount actually earned (delivered)
	awardedAt:    text("awarded_at"),
	deliveredAt:  text("delivered_at"),
	lastError:    text("last_error"),
	createdAt:    text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt:    text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Encrypted vault for client-provided access (FTP/SFTP/git tokens/CMS logins).
// secretEnc is AES-256-GCM via lib/secret-crypto; never logged or returned raw.
export const freelanceCredentials = sqliteTable("freelance_credentials", {
	id:        text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	jobId:     text("job_id").notNull(),
	kind:      text("kind").notNull(),                   // ftp|sftp|git|cms|other
	label:     text("label"),
	host:      text("host"),
	port:      integer("port"),
	username:  text("username"),
	secretEnc: text("secret_enc").notNull().default(""), // encrypted password/token/key
	meta:      text("meta"),                              // JSON (e.g. repo url, protocol, path)
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Per-job audit timeline: every autonomous action the agent takes.
export const freelanceJobLog = sqliteTable("freelance_job_log", {
	id:        text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	jobId:     text("job_id").notNull(),
	action:    text("action").notNull(),                 // reply|bid|clone|download|create_project|deliver|escalate|state|...
	detail:    text("detail"),
	outcome:   text("outcome").notNull().default("ok"),  // ok|error|info
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Important client/project facts the agent learns from the conversation (NOT
// secrets — those go in freelance_credentials). E.g. communication rules, where
// to talk, repo/links, preferences, requirements. Injected into the agent's
// system context so every reply is well-informed.
export const freelanceJobFacts = sqliteTable("freelance_job_facts", {
	id:        text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	jobId:     text("job_id").notNull(),
	category:  text("category").notNull().default("other"), // rule|contact|access|preference|requirement|other
	detail:    text("detail").notNull(),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Needs-attention queue: things the agent escalated to the human.
export const freelanceEscalations = sqliteTable("freelance_escalations", {
	id:         text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	jobId:      text("job_id"),
	platform:   text("platform"),
	threadId:   text("thread_id"),
	reason:     text("reason").notNull(),
	detail:     text("detail"),
	severity:   text("severity").notNull().default("info"), // info|warn|blocker
	status:     text("status").notNull().default("open"),   // open|resolved
	createdAt:  text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	resolvedAt: text("resolved_at"),
});

// ---------------------------------------------------------------------------
// project_activity — per-project "unread agent activity" tracking
// ---------------------------------------------------------------------------
// One row per (project, location). `location` is a leaf UI spot where an agent
// produced work, e.g. "chat" or "issue-fixer:history". Unread when
// lastActivityAt > lastSeenAt. The backend bumps lastActivityAt on agent
// completion; the frontend bumps lastSeenAt when the user opens that view.
// A UNIQUE(project_id, location) index (created in migration v28) backs the
// upserts. Drives the unread dots on dashboard cards and project tabs.
export const projectActivity = sqliteTable("project_activity", {
	id:             text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId:      text("project_id").notNull(),
	location:       text("location").notNull(),
	lastActivityAt: text("last_activity_at"),
	lastSeenAt:     text("last_seen_at"),
});

// ---------------------------------------------------------------------------
// remote_sync_config — per-project SFTP/FTP connection + selection (Remote tab)
// ---------------------------------------------------------------------------
// One row per project. Credentials (password / private key / passphrase) are
// stored ENCRYPTED at rest (AES-256-GCM) — the master key lives in a file under
// userData, separate from this SQLite DB. See src/bun/remote-sync/crypto.ts.
export const remoteSyncConfig = sqliteTable("remote_sync_config", {
	projectId:      text("project_id").primaryKey().references(() => projects.id),
	enabled:        integer("enabled").notNull().default(0),
	// "sftp" | "ftp" | "ftps"
	protocol:       text("protocol").notNull().default("sftp"),
	host:           text("host").notNull().default(""),
	port:           integer("port").notNull().default(22),
	username:       text("username").notNull().default(""),
	// "password" | "key"  (key applies to SFTP only)
	authType:       text("auth_type").notNull().default("password"),
	// Encrypted blobs ("enc:v1:…"); empty string when unset.
	passwordEnc:    text("password_enc").notNull().default(""),
	privateKeyEnc:  text("private_key_enc").notNull().default(""),
	passphraseEnc:  text("passphrase_enc").notNull().default(""),
	// Remote directory that selected paths are relative to (e.g. /var/www/app).
	remoteBasePath: text("remote_base_path").notNull().default("/"),
	// Optional subfolder under the project workspace to land files in ("" = root).
	localSubdir:    text("local_subdir").notNull().default(""),
	// JSON array of { path: string (relative to base), type: "dir" | "file" }.
	selections:     text("selections").notNull().default("[]"),
	// FTPS only: 1 = reject invalid/self-signed TLS certs; 0 = tolerate them.
	rejectUnauthorized: integer("reject_unauthorized").notNull().default(0),
	// SFTP only: pinned server host-key fingerprint ("SHA256:…"), trust-on-first-use.
	hostKeyFingerprint: text("host_key_fingerprint"),
	// JSON array of glob exclude patterns applied to pull + push (e.g. "node_modules", "*.log").
	excludePatterns: text("exclude_patterns").notNull().default("[]"),
	lastPulledAt:   text("last_pulled_at"),
	lastPushedAt:   text("last_pushed_at"),
	createdAt:      text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt:      text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// remote_sync_items — local↔remote manifest (drives push diff detection)
// ---------------------------------------------------------------------------
// One row per file synced for a project. Records the remote size/mtime and the
// local content hash captured at the last pull/push, so a Push can show exactly
// what changed and upload only modified/new files.
export const remoteSyncItems = sqliteTable("remote_sync_items", {
	id:           text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId:    text("project_id").notNull().references(() => projects.id),
	// Path relative to remote_base_path (POSIX separators).
	remotePath:   text("remote_path").notNull(),
	// Path relative to the project workspace (POSIX separators).
	localPath:    text("local_path").notNull(),
	size:         integer("size").notNull().default(0),
	// Remote mtime (epoch ms) recorded at last sync; null if unknown.
	remoteMtime:  integer("remote_mtime"),
	// SHA-256 of the local file content at last sync (hex).
	sha256:       text("sha256").notNull().default(""),
	lastSyncedAt: text("last_synced_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// custom_env_vars — user-defined environment variables managed from Settings
// ---------------------------------------------------------------------------
export const customEnvVars = sqliteTable("custom_env_vars", {
	id:        text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	name:      text("name").notNull().unique(),
	value:     text("value").notNull(),
	createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// remote_sync_runs — history/log of remote-sync operations (Activity tab)
// ---------------------------------------------------------------------------
export const remoteSyncRuns = sqliteTable("remote_sync_runs", {
	id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
	projectId:   text("project_id").notNull().references(() => projects.id),
	// "pull" | "push" | "test"
	direction:   text("direction").notNull(),
	// "running" | "success" | "error" | "partial" | "cancelled"
	status:      text("status").notNull().default("running"),
	totalFiles:  integer("total_files").notNull().default(0),
	okFiles:     integer("ok_files").notNull().default(0),
	failedFiles: integer("failed_files").notNull().default(0),
	bytes:       integer("bytes").notNull().default(0),
	summary:     text("summary"),
	error:       text("error"),
	startedAt:   text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	finishedAt:  text("finished_at"),
});

// ---------------------------------------------------------------------------
// model_preferences — global, app-wide per-model state (v52)
// ---------------------------------------------------------------------------
// Enabled/disabled, favourite, and last-used timestamp per model. Sparse by
// design — a row exists only when a model deviates from the defaults (enabled,
// not favourite, never used). Existing users with no rows transparently get
// "all models enabled, no favourites, no recents". Drives the chat model
// picker's Latest/Favorites sections and the Settings → AI → Models page.
export const modelPreferences = sqliteTable(
	"model_preferences",
	{
		id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
		providerId: text("provider_id")
			.notNull()
			.references(() => aiProviders.id, { onDelete: "cascade" }),
		modelId: text("model_id").notNull(),
		// Boolean stored as 0/1 — absence of a row implies enabled (1)
		isEnabled: integer("is_enabled").notNull().default(1),
		// Boolean stored as 0/1
		isFavorite: integer("is_favorite").notNull().default(0),
		// ISO timestamp of the most recent chat turn that actually ran on this
		// model; NULL = never used. Powers the "Latest" section (sorted desc).
		lastUsedAt: text("last_used_at"),
		createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(t) => ({
		uniqProviderModel: uniqueIndex("idx_model_prefs_provider_model").on(
			t.providerId,
			t.modelId,
		),
	}),
);

// ---------------------------------------------------------------------------
// collections (v56) — personal, cross-project knowledge base
// ---------------------------------------------------------------------------
// Deliberately separate from `notes` (project docs, above): a collection is a
// user-organized category of personal notes that lives outside any single
// project. See docs/collections-plan.md for the full feature plan. Indexes,
// the collection_notes_fts virtual table, and the seeded Default collection
// are created in migration v56, per this file's convention of keeping indexes
// in raw-SQL migrations rather than inline here (see the note above
// `agent_memories`).
export const collections = sqliteTable("collections", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	color: text("color").notNull(),
	icon: text("icon"),
	// Marks the single seeded "Default" collection — blocks delete, not rename.
	isDefault: integer("is_default").notNull().default(0),
	sortOrder: integer("sort_order").notNull().default(0),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// collection_notes (v56)
// ---------------------------------------------------------------------------
// Note content is stored as raw GFM markdown (contentMarkdown), never HTML or
// rich-text JSON. `embedding` is a packed little-endian Float32Array BLOB
// (see docs/collections-plan.md §7); `embeddingModel` records which model
// produced it so a future model change can detect staleness. "Favorites" is
// a virtual view over isFavorite — there is no separate favorites table/row.
// Trash reuses `updatedAt` as the 30-day purge clock instead of adding a
// second deletedAt column, matching the plain isDeleted-flag convention used
// elsewhere in this file (see freelanceListings.isDeleted).
export const collectionNotes = sqliteTable("collection_notes", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	collectionId: text("collection_id")
		.notNull()
		.references(() => collections.id),
	title: text("title").notNull(),
	contentMarkdown: text("content_markdown").notNull().default(""),
	// JSON-serialized string[]
	tags: text("tags").notNull().default("[]"),
	isFavorite: integer("is_favorite").notNull().default(0),
	isDeleted: integer("is_deleted").notNull().default(0),
	// 'pm_chat' | 'council' | 'freelance_chat' | 'skills_chat' | 'freelance_inbox' | 'inbox_message' | 'manual'
	sourceType: text("source_type"),
	// JSON: { projectId?, projectName?, taskId? } — powers the provenance chip
	sourceRef: text("source_ref"),
	embedding: blob("embedding", { mode: "buffer" }),
	embeddingModel: text("embedding_model"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// collection_note_attachments (v56)
// ---------------------------------------------------------------------------
// Files live on disk under Utils.paths.userData/collections/<noteId>/, never
// inlined into the DB. Download-only by design — never previewed in-app.
export const collectionNoteAttachments = sqliteTable("collection_note_attachments", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	noteId: text("note_id")
		.notNull()
		.references(() => collectionNotes.id),
	fileName: text("file_name").notNull(),
	// Relative path under the collections storage dir
	filePath: text("file_path").notNull(),
	fileSize: integer("file_size").notNull(),
	mimeType: text("mime_type"),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// collection_note_links (v56) — resolved [[wiki-links]] between notes
// ---------------------------------------------------------------------------
// Populated by parsing contentMarkdown on save (src/bun/collections/links.ts).
// Resolution is global (across all collections), not scoped to one.
export const collectionNoteLinks = sqliteTable("collection_note_links", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	sourceNoteId: text("source_note_id")
		.notNull()
		.references(() => collectionNotes.id),
	targetNoteId: text("target_note_id")
		.notNull()
		.references(() => collectionNotes.id),
	createdAt: text("created_at")
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});
