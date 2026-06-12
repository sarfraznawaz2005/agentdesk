import { statSync } from "fs";

/**
 * Check whether a path is accessible on disk, with automatic retry for
 * cloud-synced and network paths (OneDrive, Dropbox, Google Drive, NAS)
 * that may be temporarily unavailable during app startup or sync operations.
 *
 * Uses statSync rather than existsSync so it validates the path is readable,
 * not just that a placeholder entry exists in the filesystem.
 *
 * @param path     - absolute path to check
 * @param retries  - number of additional attempts after the first failure (default 2)
 * @param delayMs  - ms to wait between attempts (default 400)
 */
export async function isPathAccessible(
	path: string,
	retries = 2,
	delayMs = 400,
): Promise<boolean> {
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			statSync(path);
			return true;
		} catch {
			if (attempt < retries) await Bun.sleep(delayMs);
		}
	}
	return false;
}

/**
 * Synchronous single-attempt version — use only where async is not possible.
 * Prefer isPathAccessible() for all new code.
 */
export function isPathAccessibleSync(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}
