/**
 * Maintenance overlay state.
 *
 * Some DB maintenance operations (PRAGMA optimize on the main thread, a full or
 * background VACUUM that holds a database lock) stall queries app-wide for a
 * while — long enough that every page just shows skeleton loaders with no
 * explanation. This module tracks a single "maintenance is underway" flag and
 * broadcasts it to the webview (and any remote clients), so the UI can show one
 * clear overlay instead of leaving the user staring at skeletons.
 *
 * The broadcast goes out via `broadcastToWebview` (lazily imported to avoid a
 * static import cycle between the low-level db layer and engine-manager).
 */

interface MaintenanceState {
	active: boolean;
	message: string;
}

const state: MaintenanceState = { active: false, message: "" };

export function getMaintenanceState(): MaintenanceState {
	return { active: state.active, message: state.message };
}

/** Set the maintenance flag and broadcast it to all connected views. */
export function setMaintenance(active: boolean, message = ""): void {
	state.active = active;
	state.message = active ? message : "";
	const payload = { active: state.active, message: state.message };
	void import("../engine-manager")
		.then(({ broadcastToWebview }) => broadcastToWebview("maintenance", payload))
		.catch(() => {
			/* window not ready / closed — nothing to notify */
		});
}

/**
 * Run a (possibly blocking) maintenance op with the overlay shown.
 *
 * Shows the overlay, then yields the event loop briefly so the "active"
 * broadcast actually flushes to the webview process BEFORE a synchronous op
 * (e.g. VACUUM) stalls the main thread — otherwise the overlay would only paint
 * after the stall it was meant to cover. Always clears the flag afterwards.
 */
export async function runWithMaintenanceOverlay<T>(message: string, fn: () => T): Promise<T> {
	setMaintenance(true, message);
	await new Promise((resolve) => setTimeout(resolve, 80));
	try {
		return fn();
	} finally {
		setMaintenance(false);
	}
}
