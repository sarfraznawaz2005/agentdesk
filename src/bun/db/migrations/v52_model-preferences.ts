import { sqlite } from "../connection";

export const name = "model-preferences";

// Global, app-wide per-model state for the chat model picker and the
// Settings → AI → Models management page.
//
// Sparse table: a row exists only when a model deviates from the defaults
// (enabled, not favourite, never used). Existing users have zero rows, so they
// transparently get "all models enabled, no favourites, no recents" — no
// backfill required.
//
// Drizzle-managed table (see schema.ts:modelPreferences). The CREATE here keeps
// the raw migration runner and the Drizzle schema in lock-step; it is idempotent
// via IF NOT EXISTS so it is safe on both fresh and existing databases.
export function run(): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS model_preferences (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id     TEXT NOT NULL,
  is_enabled   INTEGER NOT NULL DEFAULT 1,   -- 0/1; absence of a row = enabled
  is_favorite  INTEGER NOT NULL DEFAULT 0,   -- 0/1
  last_used_at TEXT,                          -- ISO timestamp; NULL = never used
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_prefs_provider_model
  ON model_preferences(provider_id, model_id);
`);
}
