/**
 * Phase 12 — Database maintenance utilities.
 *
 * Provides incremental and full vacuum operations, WAL checkpointing,
 * startup auto-maintenance, and old data pruning for high-volume tables.
 */
import { sqlite, dbFilePath } from "./connection";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL } from "url";
import { setMaintenance } from "./maintenance-state";

const LAST_VACUUM_KEY = "_agentdesk_last_vacuum";
const VACUUM_INTERVAL_DAYS = 7;

/** Run lightweight maintenance suitable for periodic background calls. Never throws —
 *  a failed PRAGMA (e.g. a transient lock) must never crash the app. */
export function runIncrementalMaintenance(): void {
	try { sqlite.exec("PRAGMA optimize"); } catch (e) { console.error("[maintenance] optimize failed:", e); }
	try { sqlite.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch (e) { console.error("[maintenance] checkpoint failed:", e); }
	console.log("[maintenance] Incremental maintenance complete.");
}

/**
 * Run a full VACUUM + optimize — reclaims disk space by rewriting the DB. This is
 * SYNCHRONOUS and blocking, so it is only ever invoked **manually** (Settings →
 * maintenance via `vacuumDatabase`), never automatically at startup. Never throws.
 */
export function runFullVacuum(): void {
	try {
		sqlite.exec("VACUUM");
		sqlite.exec("PRAGMA optimize");
		recordVacuumTimestamp();
		console.log("[maintenance] Full vacuum complete.");
	} catch (e) {
		console.error("[maintenance] full vacuum failed:", e);
	}
}

/** Force a WAL checkpoint (TRUNCATE mode) to reclaim WAL space. Never throws. */
export function checkpointWal(): void {
	try {
		sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		console.log("[maintenance] WAL checkpoint (TRUNCATE) complete.");
	} catch (e) {
		console.error("[maintenance] wal checkpoint failed:", e);
	}
}

/**
 * Auto-run at startup:
 *  1. Lightweight incremental maintenance (sync, fast, safe).
 *  2. If it's been >7 days since the last full vacuum, reclaim disk space via a
 *     background Bun worker thread (its own connection, off the main thread) so the
 *     UI/backend are never blocked. Fire-and-forget; failures are logged, not fatal.
 * Never throws. The main-thread `runFullVacuum` remains available for manual use.
 */
export function maybeRunStartupMaintenance(): void {
	// Show the global "maintenance underway" overlay so the user isn't left staring
	// at skeleton loaders while queries stall. Defer the blocking PRAGMA optimize one
	// tick so the overlay actually paints before the main thread stalls; then run the
	// (possibly long) background vacuum. The overlay is always cleared at the end.
	setMaintenance(true, "Tuning up the local database — this will finish momentarily.");
	setTimeout(() => {
		void (async () => {
			try {
				runIncrementalMaintenance();
				await maybeVacuumInBackground();
			} finally {
				setMaintenance(false);
			}
		})();
	}, 80);
}

/** Run a full vacuum in a worker thread if the 7-day cadence is due. Never throws. */
export async function maybeVacuumInBackground(): Promise<void> {
	try {
		const last = getLastVacuumTimestamp();
		const daysSince = last ? (Date.now() - last) / 86_400_000 : Infinity;
		if (daysSince <= VACUUM_INTERVAL_DAYS) return;
		// Vacuum holds a DB lock; keep the overlay up with a vacuum-specific message
		// (the caller owns clearing it).
		setMaintenance(true, "Reclaiming database space — this can take a minute. Please keep the app open.");
		await runVacuumInWorker();
	} catch (e) {
		console.error("[maintenance] background vacuum failed:", e);
	}
}

// Worker script (plain ESM, written to disk at runtime so it works in both flat-file
// dev and the production bundle without depending on bundler worker-detection). Opens
// its OWN connection, VACUUMs, then posts the result back. Runs on a separate thread.
function buildVacuumWorkerSrc(targetDbPath: string): string {
	return [
		'import { Database } from "bun:sqlite";',
		`const dbPath = ${JSON.stringify(targetDbPath)};`,
		"try {",
		"  const db = new Database(dbPath);",
		"  try {",
		'    db.exec("PRAGMA busy_timeout = 60000");',
		'    db.exec("VACUUM");',
		'    db.exec("PRAGMA optimize");',
		"  } finally { db.close(); }",
		"  postMessage({ ok: true });",
		"} catch (err) {",
		"  postMessage({ ok: false, error: String((err && err.message) || err) });",
		"}",
	].join("\n");
}

/**
 * Spawn a one-shot Bun worker that VACUUMs the database on its own connection and
 * thread, so the main event loop is never blocked. Resolves on success (records the
 * vacuum timestamp), rejects on error/timeout. The worker is always terminated.
 */
function runVacuumInWorker(): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let worker: Worker;
		try {
			const workerFile = join(dirname(dbFilePath), "vacuum-worker.mjs");
			writeFileSync(workerFile, buildVacuumWorkerSrc(dbFilePath));
			worker = new Worker(pathToFileURL(workerFile).href, { type: "module" });
		} catch (e) {
			reject(e instanceof Error ? e : new Error(String(e)));
			return;
		}

		const done = (fn: () => void) => {
			clearTimeout(timer);
			try { worker.terminate(); } catch { /* already gone */ }
			fn();
		};
		// Hard cap so a stuck vacuum (e.g. perpetual lock contention) never leaks a worker.
		const timer = setTimeout(() => done(() => reject(new Error("vacuum worker timed out"))), 10 * 60_000);

		worker.onmessage = (ev) => {
			const data = ev.data as { ok?: boolean; error?: string } | undefined;
			if (data && data.ok) {
				done(() => {
					recordVacuumTimestamp();
					console.log("[maintenance] Background vacuum complete.");
					resolve();
				});
			} else {
				done(() => reject(new Error(data?.error || "vacuum failed")));
			}
		};
		worker.onerror = (err) => {
			const e = err as { error?: unknown; message?: string };
			done(() => reject(e.error instanceof Error ? e.error : new Error(e.message || "vacuum worker error")));
		};
	});
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
