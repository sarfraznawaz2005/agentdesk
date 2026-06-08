import { sqlite } from "../connection";

export const name = "freelance-expert-pipeline";

// Tables backing the autonomous freelance-expert pipeline: job state machine,
// encrypted credential vault, per-job audit timeline, and the escalation queue.
// All CREATE TABLE IF NOT EXISTS — idempotent (also called from ensureRuntimeSchema).
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS freelance_jobs (
  id                  TEXT PRIMARY KEY,
  platform            TEXT NOT NULL,
  thread_id           TEXT,
  listing_id          TEXT,
  listing_external_id TEXT,
  project_id          TEXT,
  client_user_id      TEXT,
  title               TEXT,
  state               TEXT NOT NULL DEFAULT 'lead',
  bid_amount          INTEGER,
  currency            TEXT,
  earned              INTEGER NOT NULL DEFAULT 0,
  awarded_at          TEXT,
  delivered_at        TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_freelance_jobs_thread
  ON freelance_jobs(platform, thread_id);
CREATE INDEX IF NOT EXISTS idx_freelance_jobs_state
  ON freelance_jobs(platform, state);

CREATE TABLE IF NOT EXISTS freelance_credentials (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  label       TEXT,
  host        TEXT,
  port        INTEGER,
  username    TEXT,
  secret_enc  TEXT NOT NULL DEFAULT '',
  meta        TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_freelance_credentials_job
  ON freelance_credentials(job_id);

CREATE TABLE IF NOT EXISTS freelance_job_log (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  outcome     TEXT NOT NULL DEFAULT 'ok',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_freelance_job_log_job
  ON freelance_job_log(job_id, created_at);

CREATE TABLE IF NOT EXISTS freelance_escalations (
  id          TEXT PRIMARY KEY,
  job_id      TEXT,
  platform    TEXT,
  thread_id   TEXT,
  reason      TEXT NOT NULL,
  detail      TEXT,
  severity    TEXT NOT NULL DEFAULT 'info',
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_freelance_escalations_status
  ON freelance_escalations(status, created_at);
`);
}
