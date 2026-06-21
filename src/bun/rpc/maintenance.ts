/**
 * Phase 12 — Maintenance RPC handlers.
 *
 * Thin wrappers around the maintenance module that expose
 * database maintenance operations to the renderer.
 */
import {
	runIncrementalMaintenance,
	runFullVacuum,
	pruneOldLogData,
} from "../db/maintenance";
import { getMaintenanceState, runWithMaintenanceOverlay } from "../db/maintenance-state";

export async function optimizeDatabase(): Promise<{ success: boolean }> {
	await runWithMaintenanceOverlay("Optimizing the database — this will finish momentarily.", runIncrementalMaintenance);
	return { success: true };
}

export async function vacuumDatabase(): Promise<{ success: boolean }> {
	// Full VACUUM is synchronous and blocks every query — definitely overlay-worthy.
	await runWithMaintenanceOverlay("Compacting the database — this can take a minute. Please keep the app open.", runFullVacuum);
	return { success: true };
}

export async function pruneDatabase(days?: number): Promise<{ success: boolean; pruned: Record<string, number> }> {
	const pruned = await runWithMaintenanceOverlay("Cleaning up old data — this will finish momentarily.", () => pruneOldLogData(days));
	return { success: true, pruned };
}

/** Current maintenance overlay state — lets a freshly-loaded view sync up. */
export function getMaintenanceStatus(): { active: boolean; message: string } {
	return getMaintenanceState();
}
