import { sqlite } from "../connection";

export const name = "freelance-wizard-block-kind";

// Adds `wizard_block_kind` to freelance_listings so a not_workable verdict's ORIGIN
// is persisted explicitly rather than re-derived from the reason string. Values:
//   "non_software" | "skill_gate" | "client_quality"  → deterministic pre-filter (UI: yellow)
//   "analysis"                                          → real Condition A/B verdict (UI: red/green)
//   NULL                                                → legacy row (pre-v44); classified by reason string
// Nullable, so existing rows are untouched and keep working via the reason-string fallback.
export function run() {
  const cols = (sqlite.prepare("PRAGMA table_info(freelance_listings)").all() as Array<{ name: string }>)
    .map((c) => c.name);

  if (!cols.includes("wizard_block_kind"))
    sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN wizard_block_kind TEXT");
}
