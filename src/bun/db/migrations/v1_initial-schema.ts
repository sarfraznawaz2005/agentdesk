import { sqlite } from "../connection";

export const name = "initial-schema";

export function run(): void {
	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id          TEXT PRIMARY KEY NOT NULL,
      key         TEXT NOT NULL UNIQUE,
      value       TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'general',
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_providers (
      id             TEXT PRIMARY KEY NOT NULL,
      name           TEXT NOT NULL,
      provider_type  TEXT NOT NULL,
      api_key        TEXT NOT NULL,
      base_url       TEXT,
      default_model  TEXT,
      is_default     INTEGER NOT NULL DEFAULT 0,
      is_valid       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id              TEXT PRIMARY KEY NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      workspace_path  TEXT NOT NULL,
      github_url      TEXT,
      working_branch  TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY NOT NULL,
      name            TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      color           TEXT NOT NULL,
      system_prompt   TEXT NOT NULL DEFAULT '',
      is_builtin      INTEGER NOT NULL DEFAULT 1,
      provider_id     TEXT,
      model_id        TEXT,
      temperature     TEXT,
      max_tokens      INTEGER,
      is_enabled      INTEGER NOT NULL DEFAULT 1,
      thinking_budget TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_tools (
      id          TEXT PRIMARY KEY NOT NULL,
      agent_id    TEXT NOT NULL REFERENCES agents(id),
      tool_name   TEXT NOT NULL,
      is_enabled  INTEGER NOT NULL DEFAULT 1,
      config      TEXT
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id           TEXT PRIMARY KEY NOT NULL,
      project_id   TEXT NOT NULL REFERENCES projects(id),
      title        TEXT NOT NULL DEFAULT 'New conversation',
      is_pinned    INTEGER NOT NULL DEFAULT 0,
      is_archived  INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id               TEXT PRIMARY KEY NOT NULL,
      conversation_id  TEXT NOT NULL REFERENCES conversations(id),
      role             TEXT NOT NULL,
      agent_id         TEXT,
      content          TEXT NOT NULL,
      metadata         TEXT,
      token_count      INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id                TEXT PRIMARY KEY NOT NULL,
      conversation_id   TEXT NOT NULL REFERENCES conversations(id),
      summary_text      TEXT NOT NULL,
      messages_up_to_id TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_summaries_conversation ON conversation_summaries(conversation_id);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id               TEXT PRIMARY KEY NOT NULL,
      project_id       TEXT NOT NULL REFERENCES projects(id),
      title            TEXT NOT NULL,
      content          TEXT NOT NULL,
      author_agent_id  TEXT,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS kanban_tasks (
      id                   TEXT PRIMARY KEY NOT NULL,
      project_id           TEXT NOT NULL REFERENCES projects(id),
      title                TEXT NOT NULL,
      description          TEXT,
      acceptance_criteria  TEXT,
      important_notes      TEXT,
      column               TEXT NOT NULL DEFAULT 'backlog',
      priority             TEXT NOT NULL DEFAULT 'medium',
      assigned_agent_id    TEXT,
      blocked_by           TEXT,
      due_date             TEXT,
      position             INTEGER NOT NULL DEFAULT 0,
      review_rounds        INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_project ON kanban_tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_column ON kanban_tasks(column);
    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_priority ON kanban_tasks(priority);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS kanban_task_activity (
      id          TEXT PRIMARY KEY NOT NULL,
      task_id     TEXT NOT NULL REFERENCES kanban_tasks(id),
      type        TEXT NOT NULL,
      actor_id    TEXT,
      data        TEXT,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_activity_task ON kanban_task_activity(task_id);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      version       TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      settings      TEXT DEFAULT '{}',
      installed_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id          TEXT PRIMARY KEY NOT NULL,
      project_id  TEXT REFERENCES projects(id),
      platform    TEXT NOT NULL DEFAULT 'discord',
      config      TEXT NOT NULL DEFAULT '{}',
      enabled     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_channels_platform ON channels(platform);
    CREATE INDEX IF NOT EXISTS idx_channels_project ON channels(project_id);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS deploy_environments (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name       TEXT NOT NULL,
      branch     TEXT,
      command    TEXT NOT NULL,
      url        TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_environments_project ON deploy_environments(project_id);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS deploy_history (
      id             TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL REFERENCES deploy_environments(id),
      status         TEXT NOT NULL DEFAULT 'pending',
      log_output     TEXT,
      triggered_by   TEXT NOT NULL DEFAULT 'human',
      duration_ms    INTEGER,
      created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_history_environment ON deploy_history(environment_id);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id          TEXT PRIMARY KEY NOT NULL,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'custom',
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id             TEXT PRIMARY KEY NOT NULL,
      project_id     TEXT REFERENCES projects(id),
      channel_id     TEXT,
      sender         TEXT NOT NULL,
      content        TEXT NOT NULL,
      is_read        INTEGER NOT NULL DEFAULT 0,
      agent_response TEXT,
      thread_id      TEXT,
      priority       INTEGER NOT NULL DEFAULT 0,
      category       TEXT NOT NULL DEFAULT 'chat',
      platform       TEXT NOT NULL DEFAULT 'chat',
      is_archived    INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      id         TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL,
      creds      TEXT NOT NULL DEFAULT '{}',
      keys       TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      id             TEXT PRIMARY KEY NOT NULL,
      platform       TEXT NOT NULL,
      project_id     TEXT REFERENCES projects(id),
      sound_enabled  INTEGER NOT NULL DEFAULT 1,
      badge_enabled  INTEGER NOT NULL DEFAULT 1,
      banner_enabled INTEGER NOT NULL DEFAULT 1,
      mute_until     TEXT,
      created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notif_prefs_platform ON notification_preferences(platform);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inbox_rules (
      id         TEXT PRIMARY KEY NOT NULL,
      project_id TEXT REFERENCES projects(id),
      name       TEXT NOT NULL,
      conditions TEXT NOT NULL DEFAULT '[]',
      actions    TEXT NOT NULL DEFAULT '[]',
      enabled    INTEGER NOT NULL DEFAULT 1,
      priority   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_rules_project ON inbox_rules(project_id);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id              TEXT PRIMARY KEY,
      project_id      TEXT,
      name            TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      timezone        TEXT NOT NULL DEFAULT 'UTC',
      task_type       TEXT NOT NULL,
      task_config     TEXT NOT NULL DEFAULT '{}',
      enabled         INTEGER NOT NULL DEFAULT 1,
      one_shot        INTEGER NOT NULL DEFAULT 0,
      last_run_at     TEXT,
      last_run_status TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS cron_job_history (
      id           TEXT PRIMARY KEY,
      job_id       TEXT NOT NULL,
      started_at   TEXT NOT NULL,
      completed_at TEXT,
      status       TEXT NOT NULL,
      output       TEXT,
      duration_ms  INTEGER,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cron_job_history_job_id ON cron_job_history(job_id);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id                TEXT PRIMARY KEY,
      project_id        TEXT,
      name              TEXT NOT NULL,
      trigger           TEXT NOT NULL,
      actions           TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      priority          INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TEXT,
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);


	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS cost_budgets (
      id              TEXT PRIMARY KEY NOT NULL,
      project_id      TEXT REFERENCES projects(id),
      period          TEXT NOT NULL DEFAULT 'monthly',
      limit_usd       TEXT NOT NULL,
      alert_threshold INTEGER NOT NULL DEFAULT 80,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pull_requests (
      id            TEXT PRIMARY KEY NOT NULL,
      project_id    TEXT NOT NULL REFERENCES projects(id),
      pr_number     INTEGER,
      title         TEXT NOT NULL,
      description   TEXT,
      source_branch TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      state         TEXT NOT NULL DEFAULT 'open',
      author_name   TEXT,
      linked_task_id TEXT,
      merge_strategy TEXT,
      merged_at     TEXT,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pr_comments (
      id          TEXT PRIMARY KEY NOT NULL,
      pr_id       TEXT NOT NULL REFERENCES pull_requests(id),
      file        TEXT,
      line_number INTEGER,
      content     TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_type TEXT NOT NULL DEFAULT 'human',
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS webhook_configs (
      id           TEXT PRIMARY KEY NOT NULL,
      project_id   TEXT NOT NULL REFERENCES projects(id),
      name         TEXT NOT NULL,
      events       TEXT NOT NULL DEFAULT '[]',
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_poll_at TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id              TEXT PRIMARY KEY NOT NULL,
      project_id      TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      title           TEXT NOT NULL,
      payload         TEXT NOT NULL DEFAULT '{}',
      status          TEXT NOT NULL DEFAULT 'pending',
      github_event_id TEXT,
      processed_at    TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS github_issues (
      id                   TEXT PRIMARY KEY NOT NULL,
      project_id           TEXT NOT NULL REFERENCES projects(id),
      github_issue_number  INTEGER NOT NULL,
      task_id              TEXT,
      title                TEXT NOT NULL,
      body                 TEXT,
      state                TEXT NOT NULL DEFAULT 'open',
      labels               TEXT NOT NULL DEFAULT '[]',
      github_created_at    TEXT,
      synced_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS branch_strategies (
      id                    TEXT PRIMARY KEY NOT NULL,
      project_id            TEXT NOT NULL UNIQUE REFERENCES projects(id),
      model                 TEXT NOT NULL DEFAULT 'github-flow',
      default_branch        TEXT NOT NULL DEFAULT 'main',
      feature_branch_prefix TEXT NOT NULL DEFAULT 'feature/',
      release_branch_prefix TEXT NOT NULL DEFAULT 'release/',
      hotfix_branch_prefix  TEXT NOT NULL DEFAULT 'hotfix/',
      naming_template       TEXT NOT NULL DEFAULT 'feature/{task-id}-{slug}',
      protected_branches    TEXT NOT NULL DEFAULT '["main","master"]',
      auto_cleanup          INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_messages_project_read_date ON inbox_messages(project_id, is_read, created_at DESC)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_events_project_type_date ON webhook_events(project_id, event_type, created_at DESC)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_pull_requests_project_state_date ON pull_requests(project_id, state, created_at DESC)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_github_issues_project_state_sync ON github_issues(project_id, state, synced_at DESC)`);
	sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issues_project_number ON github_issues(project_id, github_issue_number)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conv_date_asc ON messages(conversation_id, created_at ASC)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_tasks_project_col_updated ON kanban_tasks(project_id, "column", updated_at DESC)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_project_archived_updated ON conversations(project_id, is_archived, updated_at DESC)`);
	sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_github_event_id ON webhook_events(github_event_id)`);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT PRIMARY KEY NOT NULL,
      action      TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id   TEXT,
      details     TEXT,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
  `);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS keyboard_shortcuts (
      id          TEXT PRIMARY KEY NOT NULL,
      action      TEXT NOT NULL UNIQUE,
      shortcut    TEXT NOT NULL,
      category    TEXT NOT NULL,
      description TEXT NOT NULL,
      is_custom   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_tasks_project_column ON kanban_tasks(project_id, "column")`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id)`);

	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_task_results (
      id               TEXT PRIMARY KEY NOT NULL,
      conversation_id  TEXT NOT NULL REFERENCES conversations(id),
      agent_name       TEXT NOT NULL,
      task_description TEXT NOT NULL,
      result           TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'completed',
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agent_task_results_conversation ON agent_task_results(conversation_id, created_at ASC);
  `);

	// -----------------------------------------------------------------------
	// Additional indexes for columns used in WHERE/JOIN/ORDER BY
	// -----------------------------------------------------------------------
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_pr_comments_pr ON pr_comments(pr_id)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_settings_category ON settings(category)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cron_jobs_project_enabled ON cron_jobs(project_id, enabled)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_automation_rules_project_enabled ON automation_rules(project_id, enabled)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cost_budgets_project ON cost_budgets(project_id)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_tasks_assigned_agent ON kanban_tasks(assigned_agent_id)`);

	// -----------------------------------------------------------------------
	// FTS5 virtual tables for full-text search
	// -----------------------------------------------------------------------

	// Messages FTS — searchable content indexed by rowid link
	sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
		content, conversation_id UNINDEXED, role UNINDEXED,
		content='messages', content_rowid='rowid'
	)`);
	// Triggers to keep FTS in sync
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
		INSERT INTO messages_fts(rowid, content, conversation_id, role)
		VALUES (NEW.rowid, NEW.content, NEW.conversation_id, NEW.role);
	END`);
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
		INSERT INTO messages_fts(messages_fts, rowid, content, conversation_id, role)
		VALUES ('delete', OLD.rowid, OLD.content, OLD.conversation_id, OLD.role);
	END`);
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
		INSERT INTO messages_fts(messages_fts, rowid, content, conversation_id, role)
		VALUES ('delete', OLD.rowid, OLD.content, OLD.conversation_id, OLD.role);
		INSERT INTO messages_fts(rowid, content, conversation_id, role)
		VALUES (NEW.rowid, NEW.content, NEW.conversation_id, NEW.role);
	END`);

	// Notes FTS — searchable title + content
	sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
		title, content, project_id UNINDEXED,
		content='notes', content_rowid='rowid'
	)`);
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
		INSERT INTO notes_fts(rowid, title, content, project_id)
		VALUES (NEW.rowid, NEW.title, NEW.content, NEW.project_id);
	END`);
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
		INSERT INTO notes_fts(notes_fts, rowid, title, content, project_id)
		VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.project_id);
	END`);
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN
		INSERT INTO notes_fts(notes_fts, rowid, title, content, project_id)
		VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.project_id);
		INSERT INTO notes_fts(rowid, title, content, project_id)
		VALUES (NEW.rowid, NEW.title, NEW.content, NEW.project_id);
	END`);

	// Inbox messages FTS — searchable content + sender
	sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS inbox_fts USING fts5(
		content, sender, project_id UNINDEXED,
		content='inbox_messages', content_rowid='rowid'
	)`);
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS inbox_fts_ai AFTER INSERT ON inbox_messages BEGIN
		INSERT INTO inbox_fts(rowid, content, sender, project_id)
		VALUES (NEW.rowid, NEW.content, NEW.sender, NEW.project_id);
	END`);
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS inbox_fts_ad AFTER DELETE ON inbox_messages BEGIN
		INSERT INTO inbox_fts(inbox_fts, rowid, content, sender, project_id)
		VALUES ('delete', OLD.rowid, OLD.content, OLD.sender, OLD.project_id);
	END`);
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS inbox_fts_au AFTER UPDATE ON inbox_messages BEGIN
		INSERT INTO inbox_fts(inbox_fts, rowid, content, sender, project_id)
		VALUES ('delete', OLD.rowid, OLD.content, OLD.sender, OLD.project_id);
		INSERT INTO inbox_fts(rowid, content, sender, project_id)
		VALUES (NEW.rowid, NEW.content, NEW.sender, NEW.project_id);
	END`);

	// Rebuild FTS indexes from source tables (handles first run + schema upgrades)
	sqlite.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
	sqlite.exec(`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`);
	sqlite.exec(`INSERT INTO inbox_fts(inbox_fts) VALUES('rebuild')`);
}
