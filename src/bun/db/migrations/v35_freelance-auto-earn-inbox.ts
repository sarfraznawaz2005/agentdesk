import { sqlite } from "../connection";

export const name = "freelance-auto-earn-inbox";

// Auto-Earn read-only inbox: connected accounts + intercepted threads/messages
// + a client-identity cache. All CREATE TABLE IF NOT EXISTS — idempotent so the
// runner can also call run() defensively from ensureRuntimeSchema().
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS freelance_accounts (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL UNIQUE,
  self_user_id  TEXT,
  display_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'connected',
  last_sync_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS freelance_inbox_threads (
  id                TEXT PRIMARY KEY,
  platform          TEXT NOT NULL,
  thread_type       TEXT,
  owner_id          TEXT,
  member_ids        TEXT NOT NULL DEFAULT '[]',
  client_user_id    TEXT,
  context_type      TEXT,
  context_id        TEXT,
  title             TEXT,
  last_message_id   TEXT,
  last_message_text TEXT,
  last_message_from TEXT,
  last_message_at   INTEGER,
  unread            INTEGER NOT NULL DEFAULT 0,
  url               TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_freelance_inbox_threads_platform
  ON freelance_inbox_threads(platform, last_message_at);

CREATE TABLE IF NOT EXISTS freelance_inbox_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  from_user   TEXT,
  body        TEXT NOT NULL DEFAULT '',
  sent_at     INTEGER,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_freelance_inbox_messages_thread
  ON freelance_inbox_messages(thread_id, sent_at);

CREATE TABLE IF NOT EXISTS freelance_inbox_users (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,
  username      TEXT,
  display_name  TEXT,
  role          TEXT,
  country       TEXT,
  avatar        TEXT,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
}
