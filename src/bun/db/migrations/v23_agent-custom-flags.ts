import { sqlite } from "../connection";

export const name = "agent-custom-flags";

// Adds two boolean (integer 0/1) columns to the `agents` table for custom
// (non-builtin) agents:
//   • use_system_prompt_only — when 1, the engine skips internal code-related
//     prompt prefixes and uses the agent's system prompt verbatim.
//   • chat_enabled — when 1, the custom agent is exposed in the chat picker.
// Both default to 0 so existing built-in agents are unaffected.
export function run(): void {
	const cols = sqlite.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;

	if (!cols.some((c) => c.name === "use_system_prompt_only")) {
		sqlite.exec("ALTER TABLE agents ADD COLUMN use_system_prompt_only INTEGER NOT NULL DEFAULT 0");
	}

	if (!cols.some((c) => c.name === "chat_enabled")) {
		sqlite.exec("ALTER TABLE agents ADD COLUMN chat_enabled INTEGER NOT NULL DEFAULT 0");
	}
}
