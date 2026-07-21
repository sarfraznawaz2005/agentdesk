import { sqlite } from "../connection";

export const name = "general-chat";

/**
 * Creates the General Chat tables — a standalone, project-independent chat
 * surface backed by the "assistant" agent. `general_chat_messages` is flat
 * (role/content only): tool-call parts are never persisted, only the final
 * text of each turn. `general_chat_memories` mirrors `global_memories` in
 * shape but is a distinct table exclusive to the Assistant agent.
 */
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS general_chat_conversations (
  id                  TEXT PRIMARY KEY NOT NULL,
  title               TEXT NOT NULL DEFAULT 'New conversation',
  is_pinned           INTEGER NOT NULL DEFAULT 0,
  is_archived         INTEGER NOT NULL DEFAULT 0,
  deep_research_mode  INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS general_chat_messages (
  id                TEXT PRIMARY KEY NOT NULL,
  conversation_id   TEXT NOT NULL REFERENCES general_chat_conversations(id),
  role              TEXT NOT NULL,
  content           TEXT NOT NULL,
  token_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_general_chat_messages_conversation
  ON general_chat_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS general_chat_memories (
  id                TEXT PRIMARY KEY NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  content           TEXT NOT NULL,
  recall_count      INTEGER NOT NULL DEFAULT 0,
  last_recalled_at  TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_general_chat_memories_title
  ON general_chat_memories(title);

CREATE INDEX IF NOT EXISTS idx_general_chat_memories_recent
  ON general_chat_memories(updated_at DESC);
`);
}
