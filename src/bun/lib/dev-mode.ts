import { Updater } from "electrobun/bun";

/**
 * Cached "dev" channel check, synchronous after the first (fire-and-forget)
 * resolution kicked off at module load. `Updater.localInfo.channel()` is async,
 * but nothing that reads `isDevChannel()` runs until well after app startup
 * (agents/tools only execute once the engine is in use), so the promise below
 * has always settled by then. Defaults to `false` (production-safe) until it does.
 */
let cached = false;
(async () => {
	try {
		cached = (await Updater.localInfo.channel()) === "dev";
	} catch {
		cached = false;
	}
})();

/** True only in the "dev" channel (i.e. running via `run.ps1`), never in production/canary. */
export function isDevChannel(): boolean {
	return cached;
}
