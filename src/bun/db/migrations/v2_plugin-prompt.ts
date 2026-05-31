import { sqlite } from "../connection";

export const name = "plugin-prompt";

export function run(): void {
	// Add optional prompt column to plugins table for agent prompt injection
	const cols = sqlite.prepare("PRAGMA table_info(plugins)").all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === "prompt")) {
		sqlite.exec("ALTER TABLE plugins ADD COLUMN prompt TEXT");
	}
}
