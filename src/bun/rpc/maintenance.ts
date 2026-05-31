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

export function optimizeDatabase(): { success: boolean } {
	runIncrementalMaintenance();
	return { success: true };
}

export function vacuumDatabase(): { success: boolean } {
	runFullVacuum();
	return { success: true };
}

export function pruneDatabase(days?: number): { success: boolean; pruned: Record<string, number> } {
	const pruned = pruneOldLogData(days);
	return { success: true, pruned };
}
