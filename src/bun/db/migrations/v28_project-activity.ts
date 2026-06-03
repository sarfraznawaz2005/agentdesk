import { sqlite } from "../connection";

export const name = "project-activity";

// Per-project "unread agent activity" tracking. One row per (project, location);
// unread when last_activity_at > last_seen_at. Idempotent so it's safe for both
// fresh installs and existing users on upgrade.
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS project_activity (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  location         TEXT NOT NULL,
  last_activity_at TEXT,
  last_seen_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_activity_unique
  ON project_activity(project_id, location);
`);
}
