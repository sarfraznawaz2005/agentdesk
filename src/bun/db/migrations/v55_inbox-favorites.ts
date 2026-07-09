import { sqlite } from "../connection";

export const name = "inbox-favorites";

/**
 * Adds `is_favorite` to inbox_messages so a message can be starred/favorited
 * independently of its archive state (orthogonal to is_archived — a message
 * can be favorited while active or after being archived). Guarded so it's
 * safe to re-run.
 */
export function run(): void {
	const cols = sqlite.prepare("PRAGMA table_info(inbox_messages)").all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === "is_favorite")) {
		sqlite.exec("ALTER TABLE inbox_messages ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0");
	}
}
