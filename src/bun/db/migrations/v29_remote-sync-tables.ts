import { sqlite } from "../connection";

export const name = "remote-sync-tables";

export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS remote_sync_config (
  project_id        TEXT PRIMARY KEY REFERENCES projects(id),
  enabled           INTEGER NOT NULL DEFAULT 0,
  protocol          TEXT NOT NULL DEFAULT 'sftp',
  host              TEXT NOT NULL DEFAULT '',
  port              INTEGER NOT NULL DEFAULT 22,
  username          TEXT NOT NULL DEFAULT '',
  auth_type         TEXT NOT NULL DEFAULT 'password',
  password_enc      TEXT NOT NULL DEFAULT '',
  private_key_enc   TEXT NOT NULL DEFAULT '',
  passphrase_enc    TEXT NOT NULL DEFAULT '',
  remote_base_path  TEXT NOT NULL DEFAULT '/',
  local_subdir      TEXT NOT NULL DEFAULT '',
  selections        TEXT NOT NULL DEFAULT '[]',
  reject_unauthorized INTEGER NOT NULL DEFAULT 0,
  host_key_fingerprint TEXT,
  exclude_patterns  TEXT NOT NULL DEFAULT '[]',
  last_pulled_at    TEXT,
  last_pushed_at    TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS remote_sync_items (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  remote_path     TEXT NOT NULL,
  local_path      TEXT NOT NULL,
  size            INTEGER NOT NULL DEFAULT 0,
  remote_mtime    INTEGER,
  sha256          TEXT NOT NULL DEFAULT '',
  last_synced_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A given remote path is tracked once per project.
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_sync_items_path
  ON remote_sync_items(project_id, remote_path);

CREATE TABLE IF NOT EXISTS remote_sync_runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  direction     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  total_files   INTEGER NOT NULL DEFAULT 0,
  ok_files      INTEGER NOT NULL DEFAULT 0,
  failed_files  INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL DEFAULT 0,
  summary       TEXT,
  error         TEXT,
  started_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_remote_sync_runs_project
  ON remote_sync_runs(project_id, started_at);
`);
}
