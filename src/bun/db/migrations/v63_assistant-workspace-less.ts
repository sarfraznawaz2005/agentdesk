import { sqlite } from "../connection";

export const name = "assistant-workspace-less";

/**
 * Assistant (General Chat) became a workspace-less, ChatGPT-style agent —
 * `defaultAgentTools["assistant"]` (seed.ts) dropped every file read/write/edit
 * tool and run_shell, keeping only environment_info/find_skills/generate_image/
 * http_request/read_audio/read_file/read_image/read_skill/read_skill_file/
 * sleep/take_screenshot/validate_skill/web_fetch/web_search.
 *
 * `seedAgentTools()`'s per-boot backfill only ever ADDS tool rows missing from
 * an agent's default set — it never removes rows that fall out of it. Any
 * install that already ran with the old, broader default set still has those
 * now-removed tool rows sitting in `agent_tools`, enabled. `assistant` is never
 * exposed in the Agents UI (no user-customization risk), so the safe fix is the
 * same wipe-and-reseed pattern as v54_research-expert-tool-cleanup.ts: delete
 * all existing `agent_tools` rows for it so `seedAgentTools()`'s "no rows yet"
 * branch re-seeds it fresh from the corrected, smaller default set on next boot.
 */
export function run(): void {
	const rows = sqlite.prepare("SELECT id FROM agents WHERE name = 'assistant'").all() as { id: string }[];
	for (const row of rows) {
		sqlite.prepare("DELETE FROM agent_tools WHERE agent_id = ?").run(row.id);
	}
}
