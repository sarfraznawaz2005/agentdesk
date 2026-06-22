import { sqlite } from "../connection";

export const name = "unique-name-indexes";

// ---------------------------------------------------------------------------
// Case-insensitive UNIQUE indexes for agent + project names.
//
// These back the duplicate checks the RPC handlers already perform with
// `lower(name) = lower(?)` (createAgent/updateAgent, createProject/updateProject).
// `COLLATE NOCASE` folds the same ASCII range `lower()` does, so the DB-level
// guard matches the app-level semantics exactly — turning a check-then-write
// race from a silent duplicate into a catchable constraint violation.
//
// EXISTING DATA IS LEFT UNTOUCHED BY DESIGN. If a table already holds a
// case-insensitive duplicate (possible via the historical check-then-insert
// race, a DB restore, or manual edits), creating the index would fail and — in
// the migration transaction — abort app startup. So we PRE-CHECK each column
// and SKIP the index when duplicates exist rather than renaming rows or
// bricking the app. Those users keep the app-layer check (no regression); the
// index self-heals on a later launch once the duplicate is gone, because this
// idempotent run() is also invoked from ensureRuntimeSchema().
// ---------------------------------------------------------------------------

/** True if `table.column` contains two rows whose values match case-insensitively. */
function hasCaseInsensitiveDupes(table: string, column: string): boolean {
	const row = sqlite
		.prepare(
			`SELECT 1 FROM ${table}
			 WHERE ${column} IS NOT NULL
			 GROUP BY lower(${column})
			 HAVING COUNT(*) > 1
			 LIMIT 1`,
		)
		.get();
	return row !== undefined && row !== null;
}

/** Create a case-insensitive UNIQUE index, unless pre-existing duplicates block it. */
function createUniqueNocaseIndex(table: string, column: string, indexName: string): void {
	// Skip silently if the table doesn't exist yet (defensive-path call on a
	// not-fully-migrated DB) — the versioned run always has it (v1 created it).
	const tableExists = sqlite
		.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
		.get(table);
	if (!tableExists) return;

	if (hasCaseInsensitiveDupes(table, column)) {
		console.warn(
			`[migrate] unique-name-indexes: ${table}.${column} has existing case-insensitive ` +
				`duplicates — skipping ${indexName}. Existing data left untouched; the app-layer ` +
				`check still prevents new collisions, and the index self-heals once dupes are gone.`,
		);
		return;
	}

	sqlite.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${table}(${column} COLLATE NOCASE)`,
	);
}

export function run(): void {
	createUniqueNocaseIndex("projects", "name", "idx_projects_name_nocase");
	createUniqueNocaseIndex("agents", "name", "idx_agents_name_nocase");
	createUniqueNocaseIndex("agents", "display_name", "idx_agents_display_name_nocase");
}
