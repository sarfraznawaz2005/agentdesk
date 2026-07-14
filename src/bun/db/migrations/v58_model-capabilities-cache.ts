import { sqlite } from "../connection";

export const name = "model-capabilities-cache";

// Classification cache backing the model-type badges on Settings → AI →
// Models (see docs/model-type-badges-plan.md). Separate from
// model_preferences (sparse user-preference data, not classification
// metadata).
//
// Sparse-by-design in the sense that it starts empty and lazily populates on
// first Models-tab view per provider — no backfill needed. Invalidated
// (rows deleted) on provider edit/delete; ON DELETE CASCADE handles delete,
// rpc/providers.ts explicitly clears rows on edit.
//
// Drizzle-managed table (see schema.ts:modelCapabilitiesCache). The CREATE
// here keeps the raw migration runner and the Drizzle schema in lock-step;
// idempotent via IF NOT EXISTS so it is safe on both fresh and existing
// databases.
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS model_capabilities_cache (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id     TEXT NOT NULL,
  model_type   TEXT NOT NULL,
  source       TEXT NOT NULL,
  computed_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_caps_provider_model
  ON model_capabilities_cache(provider_id, model_id);
`);
}
