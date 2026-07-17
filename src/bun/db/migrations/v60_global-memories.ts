import { sqlite } from "../connection";

export const name = "global-memories";

/**
 * Creates the `global_memories` table — PM-only durable memory that is NOT
 * scoped to any project, written/read by the save_global_memory /
 * recall_global_memory / delete_global_memory PM tools.
 *
 * Distinct from `agent_memories` (per project + agent): this is for facts
 * about the USER that apply everywhere — name, habits, recurring preferences —
 * the way Claude Code's own cross-session memory works. The UNIQUE(title)
 * index is the dedup key — re-saving the same title updates in place.
 */
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS global_memories (
  id                TEXT PRIMARY KEY NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  content           TEXT NOT NULL,
  recall_count      INTEGER NOT NULL DEFAULT 0,
  last_recalled_at  TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_global_memories_title
  ON global_memories(title);

CREATE INDEX IF NOT EXISTS idx_global_memories_recent
  ON global_memories(updated_at DESC);
`);
}
