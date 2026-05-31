import { sqlite } from "../connection";

export const name = "message-parts-agent-name";

export function run(): void {
	const partCols = sqlite.prepare("PRAGMA table_info(message_parts)").all() as Array<{ name: string }>;
	if (!partCols.some((c) => c.name === "agent_name")) {
		sqlite.exec("ALTER TABLE message_parts ADD COLUMN agent_name TEXT");
	}
}
