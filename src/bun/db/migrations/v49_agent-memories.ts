import { sqlite } from "../connection";

export const name = "agent-memories";

/**
 * Creates the `agent_memories` table — per-(agent + project) durable memory
 * written/read by the save_memory / recall_memory / delete_memory agent tools.
 *
 * Distinct from `notes` (project docs) and DECISIONS.md (architectural
 * decisions): these are an agent's own learnings and things the user asked it to
 * remember. The UNIQUE(project_id, agent_name, title) index is the dedup key —
 * re-saving the same title within a scope updates in place rather than piling up
 * duplicates. The (project_id, agent_name, updated_at) index backs the always-on
 * memory index injected into the system prompt and LRU eviction at the cap.
 */
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS agent_memories (
  id                TEXT PRIMARY KEY NOT NULL,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  agent_name        TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  content           TEXT NOT NULL,
  recall_count      INTEGER NOT NULL DEFAULT 0,
  last_recalled_at  TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memories_scope_title
  ON agent_memories(project_id, agent_name, title);

CREATE INDEX IF NOT EXISTS idx_agent_memories_scope_recent
  ON agent_memories(project_id, agent_name, updated_at DESC);
`);
}
