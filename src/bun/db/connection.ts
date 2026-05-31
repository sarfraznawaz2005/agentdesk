import { Database } from "bun:sqlite";
import type { Statement } from "bun:sqlite";
import { Utils } from "electrobun/bun";
import { mkdirSync, existsSync, appendFileSync } from "fs";
import { join } from "path";

const DB_FILENAME = "agentdesk.db";

// ---------------------------------------------------------------------------
// Standalone DB error logger — writes to error.log without importing from
// error-logger.ts (which depends on audit.ts → sqlite = circular).
// Also logs to console for backend visibility.
// ---------------------------------------------------------------------------
function logDbError(context: string, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	const stack = err instanceof Error ? err.stack : undefined;
	console.error(`[DB ERROR] [${context}] ${message}`);
	try {
		const logsDir = join(Utils.paths.userData, "logs");
		if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
		const ts = new Date().toISOString();
		const lines = [`[${ts}] [db] [${context}]`, `  ${message}`];
		if (stack) lines.push(...stack.split("\n").slice(0, 10).map((l) => `  ${l}`));
		lines.push("");
		appendFileSync(join(logsDir, "error.log"), lines.join("\n") + "\n");
	} catch { /* last resort — console.error above is our fallback */ }
}

// ---------------------------------------------------------------------------
// Wrap a bun:sqlite Statement to log errors on .run(), .all(), .get()
// ---------------------------------------------------------------------------
function wrapStatement<T extends Statement>(stmt: T): T {
	return new Proxy(stmt, {
		get(target, prop, receiver) {
			const val = Reflect.get(target, prop, receiver);
			if (typeof val !== "function") return val;
			if (prop === "run" || prop === "all" || prop === "get" || prop === "values") {
				return function (this: unknown, ...args: unknown[]) {
					try {
						return val.apply(target, args);
					} catch (err) {
						logDbError(`stmt.${String(prop)}`, err);
						throw err;
					}
				};
			}
			return val.bind(target);
		},
	}) as T;
}

// ---------------------------------------------------------------------------
// Wrap the Database instance to log errors on .exec(), .prepare(), .transaction()
// ---------------------------------------------------------------------------
function wrapDatabase(db: Database): Database {
	return new Proxy(db, {
		get(target, prop, receiver) {
			const val = Reflect.get(target, prop, receiver);
			if (typeof val !== "function") return val;

			if (prop === "exec") {
				return function (this: unknown, sql: string) {
					try {
						return val.call(target, sql);
					} catch (err) {
						logDbError("exec", err);
						throw err;
					}
				};
			}

			if (prop === "prepare") {
				return function (this: unknown, sql: string) {
					try {
						const stmt = val.call(target, sql);
						return wrapStatement(stmt);
					} catch (err) {
						logDbError("prepare", err);
						throw err;
					}
				};
			}

			if (prop === "transaction") {
				return function (this: unknown, fn: (...args: unknown[]) => unknown) {
					const wrapped = val.call(target, (...args: unknown[]) => {
						try {
							return fn(...args);
						} catch (err) {
							logDbError("transaction", err);
							throw err;
						}
					});
					return wrapped;
				};
			}

			return val.bind(target);
		},
	}) as Database;
}

function openDatabase(): Database {
	const userDataDir = Utils.paths.userData;

	// Create userData directory if it doesn't exist
	if (!existsSync(userDataDir)) {
		mkdirSync(userDataDir, { recursive: true });
	}

	const dbPath = join(userDataDir, DB_FILENAME);
	const raw = new Database(dbPath);

	// Enable WAL mode for better concurrent read performance
	raw.exec("PRAGMA journal_mode = WAL");

	// Reduce fsync frequency — safe for non-critical data with WAL
	raw.exec("PRAGMA synchronous = NORMAL");

	// Set in-memory page cache to 64MB (negative = kibibytes)
	raw.exec("PRAGMA cache_size = -64000");

	// Memory-mapped I/O for read-heavy analytics (256MB)
	raw.exec("PRAGMA mmap_size = 268435456");

	// Enforce foreign key constraints (SQLite disables them by default)
	raw.exec("PRAGMA foreign_keys = ON");

	// Use memory for temp tables (faster cascade deletes, complex queries)
	raw.exec("PRAGMA temp_store = MEMORY");

	// Wait up to 5 seconds when the database is locked before erroring
	raw.exec("PRAGMA busy_timeout = 5000");

	// Wrap after pragmas so pragma errors don't clutter the log
	return wrapDatabase(raw);
}

export const sqlite = openDatabase();

export function closeDatabase(): void {
	if (walCheckpointTimer) clearInterval(walCheckpointTimer);
	sqlite.close();
}

// ---------------------------------------------------------------------------
// Periodic WAL checkpoint — prevents unbounded WAL growth during long sessions
// ---------------------------------------------------------------------------
let walCheckpointTimer: ReturnType<typeof setInterval> | null = null;
const WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export function runWalCheckpoint(): void {
	try {
		sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch { /* non-critical */ }
}

export function startWalCheckpointTimer(): void {
	// Run once on startup
	runWalCheckpoint();
	// Then periodically
	walCheckpointTimer = setInterval(runWalCheckpoint, WAL_CHECKPOINT_INTERVAL_MS);
}
