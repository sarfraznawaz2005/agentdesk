/**
 * Reset Application — wipes all data and restarts the UI in-place.
 *
 * Rather than deleting the DB file (unreliable on Windows while the process
 * holds the file handle) or relaunching the native process (no Electrobun API),
 * we reset in-process:
 *   1. Drop all tables (FTS virtual tables first so shadow tables cascade).
 *   2. Reset user_version to 0 and re-run migrations — schema is fully
 *      restored before the RPC response is returned, so no in-flight call
 *      can hit a missing table.
 *   3. Return success immediately, then seed default data in the background.
 *   4. Once seed completes, reload the webview URL — equivalent to a restart
 *      from the user's perspective.
 */
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import { Utils } from "electrobun/bun";
import { sqlite } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { seedDatabase } from "../db/seed";
import { getMainWindowRef, engines, abortAllAgents, getAllRunningAgents } from "../engine-manager";

export function resetApplication(): { success: boolean } {
	// Stop every agent (PM + sub-agents) in every project first — this wipe
	// drops tables out from under any in-flight write, and once the schema is
	// rebuilt below a still-running write could silently repopulate a fresh
	// table referencing a project/conversation id that no longer exists.
	// Union of engines (covers a PM mid-turn with no sub-agent running) and
	// getAllRunningAgents (covers conversation-less scheduler runs with no
	// engine at all).
	const activeProjectIds = new Set([...engines.keys(), ...Object.keys(getAllRunningAgents())]);
	for (const projectId of activeProjectIds) {
		engines.get(projectId)?.stopAll();
		abortAllAgents(projectId);
	}
	engines.clear();

	// Temporarily disable FK constraints so tables can be dropped in any order
	sqlite.exec("PRAGMA foreign_keys = OFF");

	// Drop freelance tables explicitly in child-before-parent order before the
	// general loop. The general loop discovers tables from sqlite_master in an
	// arbitrary order; doing these first guarantees no FK remnant issues even if
	// the order changes between SQLite versions.
	sqlite.exec("DROP TABLE IF EXISTS freelance_chat_messages");
	sqlite.exec("DROP TABLE IF EXISTS freelance_listings");

	// Drop FTS virtual tables first — SQLite requires this because dropping a
	// virtual table automatically removes its shadow tables (e.g. messages_fts_data).
	// Attempting to DROP shadow tables directly raises "may not be dropped".
	const virtualTables = sqlite
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%' AND name NOT LIKE 'sqlite_%'",
		)
		.all() as Array<{ name: string }>;

	for (const { name } of virtualTables) {
		sqlite.exec(`DROP TABLE IF EXISTS "${name}"`);
	}

	// Drop all remaining regular tables (shadow tables are already gone)
	const regularTables = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		.all() as Array<{ name: string }>;

	for (const { name } of regularTables) {
		try {
			sqlite.exec(`DROP TABLE IF EXISTS "${name}"`);
		} catch {
			// Shadow tables removed by virtual table drop above — safe to skip
		}
	}

	// Delete the first_launch flag so onboarding shows after the app reloads
	const flagPath = join(Utils.paths.userData, "first_launch");
	if (existsSync(flagPath)) unlinkSync(flagPath);

	// Rebuild schema synchronously so any RPC calls made before the webview
	// reloads hit valid (empty) tables rather than missing ones
	sqlite.exec("PRAGMA user_version = 0");
	sqlite.exec("PRAGMA foreign_keys = ON");
	runMigrations();

	// Seed default data then reload the webview — fire-and-forget so the RPC
	// response returns immediately and the UI shows a loading state while seed runs
	(async () => {
		await seedDatabase();
		const win = getMainWindowRef();
		if (win?.webview?.url) {
			win.webview.loadURL(win.webview.url);
		}
	})().catch(console.error);

	return { success: true };
}
