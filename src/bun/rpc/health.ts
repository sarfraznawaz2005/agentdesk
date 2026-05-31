/**
 * Backend health check RPC handlers.
 *
 * Checks 7 subsystems and returns a single structured HealthStatus object.
 * Each subsystem is checked independently so a failure in one never blocks
 * the others from reporting their own state.
 *
 * Exported surface:
 *   getHealthStatus()       — run all checks, return HealthStatus
 *   restartScheduler()      — shut down and re-init the cron scheduler
 *   cleanupEngines()        — evict all idle engines from the engine map
 *   checkDatabase()         — run PRAGMA quick_check on demand
 *   setSchedulerRunning()   — called by index.ts after scheduler init/shutdown
 */

import { existsSync } from "fs";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { aiProviders, projects } from "../db/schema";
import { deleteProjectCascade } from "./projects";
import { engines, removeEngine, getRunningAgentCount } from "../engine-manager";
import { initCronScheduler, shutdownCronScheduler } from "../scheduler";
import { getChannelStatuses } from "../channels";
import { listBackups } from "./backup";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Tracks whether the cron scheduler is currently running.
 *  Set to true by index.ts after initCronScheduler() resolves,
 *  and back to false after shutdownCronScheduler() is called. */
let schedulerRunning = false;

/** Unix timestamp (ms) recorded when this module is first loaded.
 *  Used to compute process uptime for the backend subsystem report. */
const startTime = Date.now();

/**
 * Mirror of the private ENGINE_MAP_MAX_SIZE constant in engine-manager.ts.
 * Update this if that constant changes.
 */
const ENGINE_MAP_MAX_SIZE = 50;

// ---------------------------------------------------------------------------
// Public state setter
// ---------------------------------------------------------------------------

/**
 * Called by index.ts after initCronScheduler() resolves (pass true) and
 * after shutdownCronScheduler() is called (pass false) so that the health
 * check can accurately reflect scheduler liveness without polling.
 */
export function setSchedulerRunning(val: boolean): void {
	schedulerRunning = val;
}

// ---------------------------------------------------------------------------
// HealthStatus type
// ---------------------------------------------------------------------------

export interface HealthStatus {
	database: {
		status: "healthy" | "degraded" | "error";
		message?: string;
		hasBackups: boolean;
	};
	aiProvider: {
		status: "healthy" | "degraded" | "error";
		message?: string;
		providerCount: number;
		hasDefault: boolean;
	};
	workspace: {
		status: "healthy" | "degraded" | "error";
		message?: string;
		missingPaths: string[];
	};
	scheduler: {
		status: "healthy" | "stopped" | "error";
		message?: string;
		activeJobs: number;
	};
	integrations: {
		status: "healthy" | "degraded" | "disconnected";
		channels: Array<{ channelId: string; platform: string; status: string }>;
	};
	engines: {
		status: "healthy" | "warning";
		activeCount: number;
		idleCount: number;
		maxSize: number;
	};
	backend: {
		status: "healthy";
		uptime: number;
	};
}

// ---------------------------------------------------------------------------
// Individual subsystem checks
// ---------------------------------------------------------------------------

/**
 * Database — runs PRAGMA quick_check and a SELECT 1 heartbeat.
 * On failure, surfaces whether backups exist so the UI can offer a restore.
 */
async function checkDatabaseSubsystem(): Promise<HealthStatus["database"]> {
	let quickCheckOk = false;
	let heartbeatOk = false;
	let failureMessage: string | undefined;

	// PRAGMA quick_check (synchronous SQLite call via bun:sqlite)
	try {
		const rows = sqlite.query<{ quick_check: string }, []>(
			"PRAGMA quick_check",
		).all();
		// quick_check returns "ok" as the single row when the DB is healthy
		quickCheckOk = rows.length > 0 && rows[0].quick_check === "ok";
		if (!quickCheckOk) {
			failureMessage = `PRAGMA quick_check returned: ${rows.map((r) => r.quick_check).join(", ")}`;
		}
	} catch (err) {
		failureMessage = err instanceof Error ? err.message : String(err);
	}

	// SELECT 1 heartbeat (via Drizzle / bun:sqlite)
	if (quickCheckOk) {
		try {
			sqlite.query<{ one: number }, []>("SELECT 1 AS one").get();
			heartbeatOk = true;
		} catch (err) {
			heartbeatOk = false;
			failureMessage = err instanceof Error ? err.message : String(err);
		}
	}

	// Backup availability — always attempt regardless of check results
	let hasBackups = false;
	try {
		const backups = listBackups();
		hasBackups = backups.length > 0;
	} catch {
		// Non-fatal: backup listing failure doesn't affect DB status
	}

	if (quickCheckOk && heartbeatOk) {
		return { status: "healthy", hasBackups };
	}

	return {
		status: "error",
		message: failureMessage ?? "Database check failed",
		hasBackups,
	};
}

/**
 * AI Provider — validates DB state only (no live API ping).
 * Reports degraded if providers exist but none is marked as default,
 * and error if the table cannot be queried.
 */
async function checkAiProviderSubsystem(): Promise<HealthStatus["aiProvider"]> {
	try {
		const rows = await db.select().from(aiProviders);
		const providerCount = rows.length;
		const hasDefault = rows.some((r) => r.isDefault === 1);

		if (providerCount === 0) {
			return {
				status: "degraded",
				message: "No AI providers configured",
				providerCount: 0,
				hasDefault: false,
			};
		}

		if (!hasDefault) {
			return {
				status: "degraded",
				message: "No default AI provider set",
				providerCount,
				hasDefault: false,
			};
		}

		return { status: "healthy", providerCount, hasDefault: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			message: `Failed to query AI providers: ${message}`,
			providerCount: 0,
			hasDefault: false,
		};
	}
}

/**
 * Workspace paths — checks fs.existsSync for every project's workspacePath.
 * If a path is missing (folder deleted from disk), the project is silently
 * cascade-deleted from the DB so it never surfaces as a warning again.
 */
async function checkWorkspaceSubsystem(): Promise<HealthStatus["workspace"]> {
	try {
		const rows = await db
			.select({ id: projects.id, workspacePath: projects.workspacePath })
			.from(projects)
			.where(eq(projects.status, "active"));

		for (const row of rows) {
			if (!existsSync(row.workspacePath)) {
				console.log(`[health] Workspace path missing, auto-removing project ${row.id}: ${row.workspacePath}`);
				await deleteProjectCascade(row.id).catch((err) => {
					console.warn(`[health] Failed to auto-delete project ${row.id}:`, err);
				});
			}
		}

		return { status: "healthy", missingPaths: [] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			message: `Failed to check workspace paths: ${message}`,
			missingPaths: [],
		};
	}
}

/**
 * Cron scheduler — reports running state from the module-level boolean.
 * activeJobs is derived from the scheduler's own internal count, which is
 * not exported; we report 0 when stopped and -1 (unknown) isn't needed
 * because the UI treats "stopped" as actionable regardless of job count.
 */
function checkSchedulerSubsystem(): HealthStatus["scheduler"] {
	if (!schedulerRunning) {
		return {
			status: "stopped",
			message: "Scheduler is not running",
			activeJobs: 0,
		};
	}
	// Scheduler is running — we cannot read activeJobs from the outside
	// without exporting it from cron-scheduler.ts, so report 0 as a safe
	// lower bound. The "healthy" status is the meaningful signal here.
	return { status: "healthy", activeJobs: 0 };
}

/**
 * Channel integrations — delegates to getChannelStatuses() which queries
 * each live adapter for its current connection state.
 */
function checkIntegrationsSubsystem(): HealthStatus["integrations"] {
	try {
		const channels = getChannelStatuses();

		if (channels.length === 0) {
			return { status: "healthy", channels: [] };
		}

		// "connecting" is transient — treat it the same as "connected" for health purposes
		const allConnected = channels.every((c) => c.status === "connected" || c.status === "connecting");
		const allDisconnected = channels.every((c) => c.status === "disconnected");

		let status: HealthStatus["integrations"]["status"];
		if (allConnected) {
			status = "healthy";
		} else if (allDisconnected) {
			status = "disconnected";
		} else {
			status = "degraded";
		}

		return { status, channels };
	} catch (err) {
		// If the channel manager itself errors, report degraded rather than
		// crashing the whole health check.
		const message = err instanceof Error ? err.message : String(err);
		console.error("[health] getChannelStatuses failed:", message);
		return { status: "degraded", channels: [] };
	}
}

/**
 * Engine map — counts active vs idle engines and reports a warning when the
 * map is approaching or at the max size cap.
 */
function checkEnginesSubsystem(): HealthStatus["engines"] {
	let activeCount = 0;
	let idleCount = 0;

	for (const [projectId, engine] of engines) {
		const isActive = engine.isProcessing() || getRunningAgentCount(projectId) > 0;
		if (isActive) {
			activeCount++;
		} else {
			idleCount++;
		}
	}

	const total = engines.size;
	const status: HealthStatus["engines"]["status"] =
		total >= ENGINE_MAP_MAX_SIZE ? "warning" : "healthy";

	return {
		status,
		activeCount,
		idleCount,
		maxSize: ENGINE_MAP_MAX_SIZE,
	};
}

/**
 * Backend process — this IS the process, so it is always healthy by definition.
 * Uptime is computed from the module-load timestamp.
 */
function checkBackendSubsystem(): HealthStatus["backend"] {
	return {
		status: "healthy",
		uptime: Date.now() - startTime,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all 7 subsystem checks in parallel and return the aggregated result.
 * Each check is isolated: an unhandled exception in one subsystem will not
 * prevent the others from completing.
 */
export async function getHealthStatus(): Promise<HealthStatus> {
	const [database, aiProvider, workspace] = await Promise.all([
		checkDatabaseSubsystem(),
		checkAiProviderSubsystem(),
		checkWorkspaceSubsystem(),
	]);

	// Synchronous checks don't need Promise.all, but run after async ones
	// to avoid blocking the await unnecessarily.
	const scheduler = checkSchedulerSubsystem();
	const integrations = checkIntegrationsSubsystem();
	const engineStatus = checkEnginesSubsystem();
	const backend = checkBackendSubsystem();

	return {
		database,
		aiProvider,
		workspace,
		scheduler,
		integrations,
		engines: engineStatus,
		backend,
	};
}

/**
 * Run PRAGMA quick_check specifically (on-demand, no heartbeat).
 * Intended for explicit "check now" actions triggered from the UI.
 */
export function checkDatabase(): { healthy: boolean; message?: string } {
	try {
		const rows = sqlite.query<{ quick_check: string }, []>(
			"PRAGMA quick_check",
		).all();
		const ok = rows.length > 0 && rows[0].quick_check === "ok";
		if (ok) {
			return { healthy: true };
		}
		return {
			healthy: false,
			message: `PRAGMA quick_check: ${rows.map((r) => r.quick_check).join(", ")}`,
		};
	} catch (err) {
		return {
			healthy: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Shut down the cron scheduler and re-initialise it from the DB.
 * Updates the module-level schedulerRunning flag on both sides of the cycle.
 */
export async function restartScheduler(): Promise<{ success: boolean }> {
	try {
		shutdownCronScheduler();
		setSchedulerRunning(false);
		await initCronScheduler();
		setSchedulerRunning(true);
		return { success: true };
	} catch (err) {
		console.error("[health] restartScheduler failed:", err);
		return { success: false };
	}
}

/**
 * Evict all idle engines from the engine map.
 * Engines that are actively processing or have running sub-agents are left
 * untouched. Returns the number of engines that were cleaned up.
 */
export function cleanupEngines(): { cleaned: number } {
	let cleaned = 0;

	// Collect idle project IDs first to avoid mutating the map during iteration
	const idleProjectIds: string[] = [];
	for (const [projectId, engine] of engines) {
		const isActive = engine.isProcessing() || getRunningAgentCount(projectId) > 0;
		if (!isActive) {
			idleProjectIds.push(projectId);
		}
	}

	for (const projectId of idleProjectIds) {
		removeEngine(projectId);
		cleaned++;
	}

	return { cleaned };
}
