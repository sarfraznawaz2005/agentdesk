import pkg from "../../../package.json";
import releaseNotes from "../../../release-notes.json";
import { sqlite } from "../db/connection";
import type { ReleaseEntry } from "../../shared/rpc/whats-new";

const CURRENT_VERSION: string = pkg.version;

function isNewerVersion(v1: string, v2: string): boolean {
  const [a1 = 0, b1 = 0, c1 = 0] = v1.split(".").map(Number);
  const [a2 = 0, b2 = 0, c2 = 0] = v2.split(".").map(Number);
  if (a1 !== a2) return a1 > a2;
  if (b1 !== b2) return b1 > b2;
  return c1 > c2;
}

function getLastSeen(): string | null {
  const row = sqlite
    .prepare(`SELECT value FROM settings WHERE key = 'lastSeenVersion'`)
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

function setLastSeen(version: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (id, key, value, category)
       VALUES (lower(hex(randomblob(16))), 'lastSeenVersion', ?, 'app')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, category = excluded.category`,
    )
    .run(version);
}

export function getWhatsNewStatus() {
  const lastSeen = getLastSeen();

  // First time this feature runs — seed silently so existing users don't get a popup
  if (!lastSeen) {
    setLastSeen(CURRENT_VERSION);
    return { shouldShow: false, didUpdate: false, entries: [] as ReleaseEntry[], currentVersion: CURRENT_VERSION, previousVersion: null as string | null };
  }

  if (lastSeen === CURRENT_VERSION) {
    return { shouldShow: false, didUpdate: false, entries: [] as ReleaseEntry[], currentVersion: CURRENT_VERSION, previousVersion: null as string | null };
  }

  // Version changed — advance lastSeenVersion NOW so toast/dialog only fire once,
  // even if the user closes the app before dismissing the dialog, or if there are no notes.
  const previousVersion = lastSeen;
  setLastSeen(CURRENT_VERSION);

  // Only count as an "upgrade" (not a downgrade) for the toast
  const didUpdate = isNewerVersion(CURRENT_VERSION, previousVersion);

  // Collect notes for versions the user hasn't seen yet, newest first.
  // On a downgrade this will be empty (no entries newer than a higher lastSeen).
  const newEntries = (releaseNotes as ReleaseEntry[])
    .filter((e) => isNewerVersion(e.version, previousVersion))
    .sort((a, b) => (isNewerVersion(b.version, a.version) ? 1 : -1));

  return {
    shouldShow: newEntries.length > 0,
    didUpdate,
    entries: newEntries,
    currentVersion: CURRENT_VERSION,
    previousVersion,
  };
}

// Kept for API compatibility — lastSeenVersion is now advanced in getWhatsNewStatus()
// so this is a safe no-op when called from the frontend dialog close handler.
export function markWhatsNewSeen() {
  setLastSeen(CURRENT_VERSION);
  return { success: true };
}
