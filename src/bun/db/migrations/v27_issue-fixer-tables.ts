import { sqlite } from "../connection";

export const name = "issue-fixer-tables";

export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS issue_fixer_config (
  project_id          TEXT PRIMARY KEY REFERENCES projects(id),
  enabled             INTEGER NOT NULL DEFAULT 0,
  keywords            TEXT NOT NULL DEFAULT '[]',
  labels              TEXT NOT NULL DEFAULT '[]',
  auth_mode           TEXT NOT NULL DEFAULT 'both',
  poll_interval_min   INTEGER NOT NULL DEFAULT 60,
  autonomy            TEXT NOT NULL DEFAULT 'branch_pr',
  test_command        TEXT,
  custom_instructions TEXT,
  token_source        TEXT NOT NULL DEFAULT 'global',
  cooldown_sec        INTEGER NOT NULL DEFAULT 0,
  max_per_hour        INTEGER NOT NULL DEFAULT 5,
  notify_channels     TEXT NOT NULL DEFAULT '[]',
  cursor_at           TEXT,
  last_polled_at      TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS issue_fix_runs (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  issue_number       INTEGER NOT NULL,
  issue_title        TEXT NOT NULL DEFAULT '',
  issue_url          TEXT,
  trigger_type       TEXT NOT NULL,
  trigger_keyword    TEXT,
  trigger_comment_id TEXT,
  intent             TEXT NOT NULL,
  author             TEXT,
  authorized         INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'queued',
  branch_name        TEXT,
  pr_number          INTEGER,
  pr_url             TEXT,
  test_passed        INTEGER,
  conversation_id    TEXT,
  summary            TEXT,
  error              TEXT,
  started_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at        TEXT
);

-- Dedup: a given (issue, comment-trigger) is processed once. NULL trigger_comment_id
-- (title/label triggers) are treated as distinct by SQLite, so title/label dedup is
-- handled in app logic (triggers.ts) via the cursor + existing-run checks.
CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_fix_runs_dedup
  ON issue_fix_runs(project_id, issue_number, trigger_comment_id);

CREATE INDEX IF NOT EXISTS idx_issue_fix_runs_project
  ON issue_fix_runs(project_id, started_at);
`);
}
