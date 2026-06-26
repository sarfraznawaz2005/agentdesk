import { sqlite } from "../connection";

export const name = "remove-enhanced-web-search";

/**
 * One-time cleanup of the removed `enhanced_web_search` agent tool.
 *
 * `enhanced_web_search` was a Tavily-only duplicate of `web_search`. Since
 * `web_search` already routes through Tavily when a key is configured (and falls
 * back to DuckDuckGo otherwise), the two tools were redundant and the enhanced
 * variant has been deleted from the tool registry.
 *
 * Existing users' `agent_tools` tables still hold rows naming the now-missing
 * tool. Those rows are harmless no-ops (tool binding is name-lookup against the
 * registry, so unknown names are simply skipped), but this migration deletes
 * them so the DB stays in lock-step with the registry and the Agents → Tools
 * tab no longer offers a tool that does not exist.
 *
 * Runs ONCE via the migration version gate. No-op on fresh installs (the seed
 * no longer assigns this tool, so no such rows are created).
 */
export function run(): void {
	sqlite.prepare("DELETE FROM agent_tools WHERE tool_name = 'enhanced_web_search'").run();
}
