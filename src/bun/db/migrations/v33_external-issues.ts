import { sqlite } from "../connection";

export const name = "external-issues";

/**
 * Creates the unified `external_issues` table that supersedes `github_issues`,
 * and copies any existing GitHub issues into it as source='github'. The old
 * `github_issues` table is left in place (read-only / deprecated) so the
 * upgrade is reversible and nothing is lost.
 */
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS external_issues (
  id                 TEXT PRIMARY KEY NOT NULL,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  source             TEXT NOT NULL,
  source_id          TEXT NOT NULL,
  task_id            TEXT,
  title              TEXT NOT NULL,
  body               TEXT,
  state              TEXT NOT NULL DEFAULT 'open',
  url                TEXT,
  labels             TEXT NOT NULL DEFAULT '[]',
  assignee           TEXT,
  priority           TEXT,
  source_created_at  TEXT,
  synced_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata           TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_external_issues_project_source_sid
  ON external_issues(project_id, source, source_id);

CREATE INDEX IF NOT EXISTS idx_external_issues_project_source_state
  ON external_issues(project_id, source, state, synced_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_issues_task
  ON external_issues(task_id);
`);

	// Copy existing github_issues rows in, preserving their UUIDs (so any external
	// references stay valid) and their task links. Guarded by the unique index +
	// NOT EXISTS so re-running (defensive schema-fixup) is idempotent.
	const hasGithubIssues = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='github_issues'")
		.get();
	if (hasGithubIssues) {
		sqlite.exec(`
INSERT INTO external_issues (
  id, project_id, source, source_id, task_id, title, body, state,
  url, labels, assignee, priority, source_created_at, synced_at, metadata
)
SELECT
  g.id, g.project_id, 'github', CAST(g.github_issue_number AS TEXT), g.task_id,
  g.title, g.body, g.state, NULL, g.labels, NULL, NULL,
  g.github_created_at, g.synced_at, '{}'
FROM github_issues g
WHERE NOT EXISTS (SELECT 1 FROM external_issues e WHERE e.id = g.id);
`);
	}
}
