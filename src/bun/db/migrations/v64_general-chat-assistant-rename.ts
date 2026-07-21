import { sqlite } from "../connection";

export const name = "general-chat-assistant-rename";

/**
 * Renamed the internal identifier for General Chat's standalone agent from
 * "assistant" to "general-chat-assistant". The bare name "assistant" was too
 * easy for a user to also give a custom agent (Settings → Agents lets any
 * string through) — a collision would wrongly hand that custom agent every
 * `agentName === "assistant"` special-case in agent-loop.ts/prompts.ts
 * (workspace-less, no plugin tools, no log_decision, hidden from the Agents
 * page and the PM's dispatch list).
 *
 * Renames via UPDATE (not delete+reinsert) so the row's id — and therefore
 * its existing `agent_tools` rows — stay attached. Scoped to `is_builtin = 1`
 * so it can never touch an actual user-created custom agent that happens to
 * share the old name. Skips entirely if a row already holds the target name
 * (belt-and-suspenders alongside the case-insensitive unique index from v51,
 * which some legacy installs may be missing if it was skipped due to a
 * pre-existing duplicate).
 *
 * Also drops `take_screenshot`/`environment_info` from its tool set (no
 * screenshot/env-info use case for a workspace-less chat agent) — wipes
 * `agent_tools` for a fresh reseed from the corrected default set, same
 * pattern as v63.
 */
export function run(): void {
	const collision = sqlite
		.prepare("SELECT id FROM agents WHERE name = 'general-chat-assistant' COLLATE NOCASE")
		.get();
	if (collision) return;

	const rows = sqlite
		.prepare("SELECT id FROM agents WHERE name = 'assistant' AND is_builtin = 1")
		.all() as { id: string }[];

	for (const row of rows) {
		sqlite.prepare("UPDATE agents SET name = 'general-chat-assistant' WHERE id = ?").run(row.id);
		sqlite.prepare("DELETE FROM agent_tools WHERE agent_id = ?").run(row.id);
	}
}
