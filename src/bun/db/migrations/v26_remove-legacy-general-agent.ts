import { sqlite } from "../connection";

export const name = "remove-legacy-general-agent";

/**
 * One-time removal of the legacy "general-agent" agent.
 *
 * The Playground builder agent was briefly named `general-agent`, which collided
 * with users' own custom agents of that name and inherited a crippled tool set
 * (so `run_background` etc. were missing). It has been renamed to `playground-agent`
 * (seeded fresh with no agent_tools rows → full tool registry).
 *
 * Delete any leftover `general-agent` row and its agent_tools so it no longer
 * lingers in the Agents page. Runs ONCE via the migration version gate — unlike
 * seed (which runs every launch), this never re-deletes on subsequent startups.
 * No-op on fresh installs (no such row exists yet).
 */
export function run(): void {
	const rows = sqlite.prepare("SELECT id FROM agents WHERE name = 'general-agent'").all() as { id: string }[];
	for (const row of rows) {
		sqlite.prepare("DELETE FROM agent_tools WHERE agent_id = ?").run(row.id);
	}
	sqlite.prepare("DELETE FROM agents WHERE name = 'general-agent'").run();
}
