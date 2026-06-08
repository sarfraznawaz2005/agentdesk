import { sqlite } from "../connection";

export const name = "freelance-auto-earn-outbox";

// Adds the approval queue (freelance_outbox), governor audit (freelance_action_log),
// per-account autonomy mode, and thread↔listing correlation columns.
// All steps are idempotent (CREATE IF NOT EXISTS + PRAGMA-guarded ADD COLUMN) so
// the runner can also call run() defensively from ensureRuntimeSchema().
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS freelance_outbox (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  thread_id     TEXT,
  listing_id    TEXT,
  draft_body    TEXT NOT NULL DEFAULT '',
  final_body    TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  autonomy_mode TEXT NOT NULL DEFAULT 'assisted',
  scheduled_for TEXT,
  sent_at       TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_freelance_outbox_status
  ON freelance_outbox(platform, status, scheduled_for);

CREATE TABLE IF NOT EXISTS freelance_action_log (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL,
  action      TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT 'ok',
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_freelance_action_log_recent
  ON freelance_action_log(platform, action, created_at);
`);

	addColumn("freelance_accounts", "autonomy_mode", "TEXT NOT NULL DEFAULT 'assisted'");
	addColumn("freelance_inbox_threads", "listing_id", "TEXT");
	addColumn("freelance_inbox_threads", "listing_external_id", "TEXT");
	addColumn("freelance_inbox_threads", "link_confidence", "TEXT");
}

function addColumn(table: string, column: string, decl: string): void {
	const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (cols.length === 0) return; // table not created yet — nothing to alter
	if (cols.some((c) => c.name === column)) return; // already present
	sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
