import { sqlite } from "../connection";

export const name = "request-human-input-backfill";

// Make request_human_input available to EXISTING agents (built-in + custom) so every
// agent can ask the user a question via the modal dialog — for existing installs, not
// just freshly-seeded ones.
//
// IMPORTANT: only agents that ALREADY have explicit agent_tools rows are touched.
// getToolsForAgent treats "zero rows" as "full registry"; inserting a single row for
// such an agent would wrongly collapse it to only that one tool.
//
// The autonomous background agents (freelance-expert, issue-fixer, playground-agent)
// are EXCLUDED — they run without a human watching and must never raise a blocking
// dialog; they escalate via channels/notify instead. (freelance-expert/issue-fixer
// have no rows anyway; playground-agent does, hence the explicit name filter.)
// Idempotent — agents that already have the row are skipped.
export function run(): void {
	const cols = sqlite.prepare("PRAGMA table_info(agent_tools)").all() as Array<{ name: string }>;
	if (cols.length === 0) return; // table not created yet

	const agentIds = sqlite
		.prepare(
			`SELECT DISTINCT agent_id FROM agent_tools
			 WHERE agent_id NOT IN (SELECT agent_id FROM agent_tools WHERE tool_name = 'request_human_input')
			   AND agent_id NOT IN (SELECT id FROM agents WHERE name IN ('freelance-expert', 'issue-fixer', 'playground-agent'))`,
		)
		.all() as Array<{ agent_id: string }>;
	if (agentIds.length === 0) return;

	const insert = sqlite.prepare(
		"INSERT INTO agent_tools (id, agent_id, tool_name, is_enabled) VALUES (?, ?, 'request_human_input', 1)",
	);
	const tx = sqlite.transaction((rows: Array<{ agent_id: string }>) => {
		for (const r of rows) insert.run(crypto.randomUUID(), r.agent_id);
	});
	tx(agentIds);
}
