import { sqlite } from "./connection";
import { createBackup } from "../rpc/backup";
import * as v1 from "./migrations/v1_initial-schema";
import * as v2 from "./migrations/v2_plugin-prompt";
import * as v3 from "./migrations/v3_agent-sessions";
import * as v4 from "./migrations/v4_inline-agents";
import * as v5 from "./migrations/v5_message-parts-agent-name";
import * as v6 from "./migrations/v6_verification-status";
import * as v7 from "./migrations/v7_reviewer-tools";
import * as v8 from "./migrations/v8_perf-indexes";
import * as v9 from "./migrations/v9_fix-mcp-config-encoding";
import * as v10 from "./migrations/v10_disable-db-viewer-plugin";
import * as v11 from "./migrations/v11_free-provider";
import * as v12 from "./migrations/v12_freelance-listings";
import * as v13 from "./migrations/v13_freelance-is-deleted";
import * as v14 from "./migrations/v14_freelance-chat-messages";
import * as v15 from "./migrations/v15_decode-html-entities";
import * as v16 from "./migrations/v16_freelance-full-description";
import * as v17 from "./migrations/v17_freelance-wizard-verdict";
import * as v18 from "./migrations/v18_freelance-peopleperhour-default";
import * as v19 from "./migrations/v19_freelance-polling-interval-minutes";
import * as v20 from "./migrations/v20_freelance-wizard-analysis";
import * as v21 from "./migrations/v21_freelance-default-keywords";
import * as v22 from "./migrations/v22_freelance-seed-keywords";
import * as v23 from "./migrations/v23_agent-custom-flags";
import * as v24 from "./migrations/v24_agent-available-to-pm";
import * as v25 from "./migrations/v25_redisable-db-viewer-plugin";
import * as v26 from "./migrations/v26_remove-legacy-general-agent";
import * as v27 from "./migrations/v27_issue-fixer-tables";
import * as v28 from "./migrations/v28_project-activity";
import * as v29 from "./migrations/v29_remote-sync-tables";
import * as v30 from "./migrations/v30_remote-sync-security-excludes";
import * as v31 from "./migrations/v31_issue-fixer-notify-enabled";
import * as v32 from "./migrations/v32_custom-env-vars";

// ---------------------------------------------------------------------------
// Versioned Database Migration System
//
// Uses SQLite's PRAGMA user_version to track which migrations have been applied.
// Each migration lives in its own file under ./migrations/v<N>_<name>.ts and
// exports `name: string` and `run(): void`.
//
// To add a new migration:
//   1. Create src/bun/db/migrations/v<N>_<description>.ts
//   2. Export `name` and `run()` from that file
//   3. Add an entry to the `migrations` array below
//
// The runner auto-backs up before any migration that runs on an existing DB
// (i.e. when user_version > 0) using the VACUUM INTO backup system.
// ---------------------------------------------------------------------------

interface Migration {
	version: number;
	name: string;
	run: () => void;
}

const migrations: Migration[] = [
	{ version: 1, name: v1.name, run: v1.run },
	{ version: 2, name: v2.name, run: v2.run },
	{ version: 3, name: v3.name, run: v3.run },
	{ version: 4, name: v4.name, run: v4.run },
	{ version: 5, name: v5.name, run: v5.run },
	{ version: 6, name: v6.name, run: v6.run },
	{ version: 7, name: v7.name, run: v7.run },
	{ version: 8, name: v8.name, run: v8.run },
	{ version: 9, name: v9.name, run: v9.run },
	{ version: 10, name: v10.name, run: v10.run },
	{ version: 11, name: v11.name, run: v11.run },
	{ version: 12, name: v12.name, run: v12.run },
	{ version: 13, name: v13.name, run: v13.run },
	{ version: 14, name: v14.name, run: v14.run },
	{ version: 15, name: v15.name, run: v15.run },
	{ version: 16, name: v16.name, run: v16.run },
	{ version: 17, name: v17.name, run: v17.run },
	{ version: 18, name: v18.name, run: v18.run },
	{ version: 19, name: v19.name, run: v19.run },
	{ version: 20, name: v20.name, run: v20.run },
	{ version: 21, name: v21.name, run: v21.run },
	{ version: 22, name: v22.name, run: v22.run },
	{ version: 23, name: v23.name, run: v23.run },
	{ version: 24, name: v24.name, run: v24.run },
	{ version: 25, name: v25.name, run: v25.run },
	{ version: 26, name: v26.name, run: v26.run },
	{ version: 27, name: v27.name, run: v27.run },
	{ version: 28, name: v28.name, run: v28.run },
	{ version: 29, name: v29.name, run: v29.run },
	{ version: 30, name: v30.name, run: v30.run },
	{ version: 31, name: v31.name, run: v31.run },
	{ version: 32, name: v32.name, run: v32.run },
];

const LATEST_VERSION = migrations[migrations.length - 1].version;

export function runMigrations(): void {
	const currentVersion: number =
		(sqlite.prepare("PRAGMA user_version").get() as { user_version: number } | null)
			?.user_version ?? 0;

	if (currentVersion >= LATEST_VERSION) {
		console.log(`[migrate] Schema is up-to-date (v${currentVersion}).`);
		// Even when fully migrated, run the defensive schema sanity check —
		// catches cases where a column-add migration ran on someone else's
		// database but not yet on this one (e.g. shared dev DB pulled between
		// branches), or where a hot-reload skipped the migration without
		// rolling back user_version.
		ensureRuntimeSchema();
		return;
	}

	const pending = migrations.filter((m) => m.version > currentVersion);
	let backedUp = false;

	for (const migration of pending) {
		// Auto-backup before applying to an existing database, once per session
		if (currentVersion > 0 && !backedUp) {
			console.log("[migrate] Creating backup before schema upgrade...");
			try {
				const result = createBackup();
				console.log(`[migrate] Backup created: ${result.filename}`);
				backedUp = true;
			} catch (err) {
				throw new Error(`[migrate] Backup failed — aborting migration. ${err}`, { cause: err });
			}
		}

		console.log(`[migrate] Running migration v${migration.version}: ${migration.name}...`);

		sqlite.exec("BEGIN");
		try {
			migration.run();
			sqlite.exec("COMMIT");
		} catch (err) {
			sqlite.exec("ROLLBACK");
			throw new Error(
				`[migrate] Migration v${migration.version} (${migration.name}) failed: ${err}`,
				{ cause: err },
			);
		}

		// PRAGMA user_version must be set outside a transaction
		sqlite.exec(`PRAGMA user_version = ${migration.version}`);
		console.log(`[migrate] Completed v${migration.version}.`);
	}

	console.log("[migrate] All migrations applied.");

	// Defensive schema sanity check — runs unconditionally on every startup,
	// not gated on user_version. Catches cases where a migration was skipped
	// (e.g. dev hot-reload picked up new schema code without restarting the
	// Bun process that runs migrations) so the DB schema can't lag behind
	// what the running code expects. Idempotent: each branch checks before
	// altering.
	ensureRuntimeSchema();
}

function ensureRuntimeSchema(): void {
	// Defensive: ensure the Issue Fixer tables exist even if migration v27 was skipped
	// (e.g. user_version raced ahead of the actual schema, or a dev DB was pulled between
	// branches). v27.run() is CREATE TABLE IF NOT EXISTS — idempotent and cheap.
	try {
		v27.run();
	} catch (err) {
		console.error("[migrate] schema-fixup: issue-fixer tables failed:", err);
	}

	// Defensive: ensure the Remote Sync tables exist even if migration v29 was skipped.
	// v29.run() is CREATE TABLE IF NOT EXISTS — idempotent and cheap.
	try {
		v29.run();
	} catch (err) {
		console.error("[migrate] schema-fixup: remote-sync tables failed:", err);
	}

	// Defensive: ensure the v30 columns (TLS verify, host-key pin, excludes) exist.
	// v30.run() guards each ADD COLUMN with a PRAGMA check — idempotent.
	try {
		v30.run();
	} catch (err) {
		console.error("[migrate] schema-fixup: remote-sync security/excludes columns failed:", err);
	}

	// Defensive: ensure custom_env_vars table exists (v32 is CREATE TABLE IF NOT EXISTS).
	try {
		v32.run();
	} catch (err) {
		console.error("[migrate] schema-fixup: custom-env-vars table failed:", err);
	}

	const agentCols = sqlite.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
	if (agentCols.length === 0) return; // agents table not created yet — nothing to backfill

	if (!agentCols.some((c) => c.name === "use_system_prompt_only")) {
		console.log("[migrate] schema-fixup: adding agents.use_system_prompt_only");
		sqlite.exec("ALTER TABLE agents ADD COLUMN use_system_prompt_only INTEGER NOT NULL DEFAULT 0");
	}
	if (!agentCols.some((c) => c.name === "chat_enabled")) {
		console.log("[migrate] schema-fixup: adding agents.chat_enabled");
		sqlite.exec("ALTER TABLE agents ADD COLUMN chat_enabled INTEGER NOT NULL DEFAULT 0");
	}
	if (!agentCols.some((c) => c.name === "available_to_pm")) {
		console.log("[migrate] schema-fixup: adding agents.available_to_pm");
		sqlite.exec("ALTER TABLE agents ADD COLUMN available_to_pm INTEGER NOT NULL DEFAULT 1");
	}
}
