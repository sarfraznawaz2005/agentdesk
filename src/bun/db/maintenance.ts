/**
 * Phase 12 — Database maintenance utilities.
 *
 * Provides incremental and full vacuum operations, WAL checkpointing,
 * startup auto-maintenance, and old data pruning for high-volume tables.
 */
import { sqlite } from "./connection";

const LAST_VACUUM_KEY = "_agentdesk_last_vacuum";

/** Run lightweight maintenance suitable for periodic background calls. */
export function runIncrementalMaintenance(): void {
	sqlite.exec("PRAGMA optimize");
	sqlite.exec("PRAGMA wal_checkpoint(PASSIVE)");
	console.log("[maintenance] Incremental maintenance complete.");
}

/** Run a full VACUUM + optimize — reclaims disk space, rewrites the DB. */
export function runFullVacuum(): void {
	sqlite.exec("VACUUM");
	sqlite.exec("PRAGMA optimize");
	recordVacuumTimestamp();
	console.log("[maintenance] Full vacuum complete.");
}

/** Force a WAL checkpoint (TRUNCATE mode) to reclaim WAL space. */
export function checkpointWal(): void {
	sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	console.log("[maintenance] WAL checkpoint (TRUNCATE) complete.");
}

/** Auto-run at startup: full vacuum if >7 days since last, else incremental. */
export function maybeRunStartupMaintenance(): void {
	const last = getLastVacuumTimestamp();
	const daysSince = last ? (Date.now() - last) / 86_400_000 : Infinity;

	if (daysSince > 7) {
		console.log("[maintenance] >7 days since last vacuum — running full vacuum.");
		runFullVacuum();
	} else {
		runIncrementalMaintenance();
	}
}

/**
 * Prune old rows from high-volume log tables.
 *
 * @param days - Retention period in days (default 90). Rows older than
 *   this are deleted.
 * @returns Object with counts of deleted rows per table.
 */
export function pruneOldLogData(days = 90): Record<string, number> {
	const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

	const tables: Array<{ table: string; dateCol: string; cutoffDate: string }> = [
		{ table: "cron_job_history", dateCol: "created_at", cutoffDate: cutoff },
		{ table: "webhook_events", dateCol: "created_at", cutoffDate: cutoff },
		{ table: "kanban_task_activity", dateCol: "created_at", cutoffDate: cutoff },
		{ table: "deploy_history", dateCol: "created_at", cutoffDate: cutoff },
		{ table: "audit_log", dateCol: "created_at", cutoffDate: cutoff },
		{ table: "inbox_messages", dateCol: "created_at", cutoffDate: cutoff },
	];

	const result: Record<string, number> = {};
	for (const { table, dateCol, cutoffDate } of tables) {
		const info = sqlite.prepare(
			`DELETE FROM "${table}" WHERE "${dateCol}" < ?`
		).run(cutoffDate);
		result[table] = info.changes;
	}

	console.log("[maintenance] Pruned old log data:", result);
	return result;
}

// ── Internal helpers ──────────────────────────────────────────────────────

function getLastVacuumTimestamp(): number | null {
	try {
		const row = sqlite.prepare(
			`SELECT value FROM settings WHERE key = ?`
		).get(LAST_VACUUM_KEY) as { value: string } | undefined;
		if (row) return parseInt(row.value, 10);
	} catch {
		// settings table might not exist yet on first run
	}
	return null;
}

function recordVacuumTimestamp(): void {
	try {
		sqlite.prepare(`
			INSERT INTO settings (id, key, value, category)
			VALUES (?, ?, ?, 'system')
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
		`).run(crypto.randomUUID(), LAST_VACUUM_KEY, String(Date.now()));
	} catch {
		// Non-critical — don't crash if settings table isn't ready
	}
}
