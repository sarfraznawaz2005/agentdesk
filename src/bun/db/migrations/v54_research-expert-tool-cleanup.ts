import { sqlite } from "../connection";

export const name = "research-expert-tool-cleanup";

/**
 * Clean up an over-broad `research-expert` tool grant from a same-day fix.
 *
 * `research-expert`'s `defaultAgentTools` entry (seed.ts) was briefly expanded
 * to spread every family constant — including write-capable ones (FILE_WRITE,
 * FILE_ADVANCED, GIT_WRITE, full KANBAN, PLANNING) — which was more than was
 * asked for. It has since been corrected back to the original read-only set
 * (FILE_READ, WEB, NOTES, SYSTEM, KANBAN_READ, SKILLS) plus only PROCESS and
 * SCREENSHOT, which were the actual requested additions.
 *
 * `seedAgentTools()`'s per-boot backfill only ever ADDS tool rows missing from
 * an agent's default set — it never removes rows that fall out of it. Any
 * install that already restarted while the over-broad seed def was live would
 * still have those extra rows sitting in `agent_tools`, showing as enabled in
 * the Tools tab despite being useless (write-capable ones are stripped by
 * `filterReadOnlyTools` at dispatch time regardless) or simply unrequested.
 *
 * Deletes ALL existing `agent_tools` rows for research-expert so
 * `seedAgentTools()`'s "no rows yet" branch re-seeds it fresh from the
 * corrected default set on the next boot (same pattern as
 * v26_remove-legacy-general-agent.ts). No-op for any install that never saw
 * the over-broad def (nothing to delete) or hasn't run `seedAgentTools()` yet.
 */
export function run(): void {
	const rows = sqlite.prepare("SELECT id FROM agents WHERE name = 'research-expert'").all() as { id: string }[];
	for (const row of rows) {
		sqlite.prepare("DELETE FROM agent_tools WHERE agent_id = ?").run(row.id);
	}
}
