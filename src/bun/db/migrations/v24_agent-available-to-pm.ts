import { sqlite } from "../connection";

export const name = "agent-available-to-pm";

// Adds the `available_to_pm` column to the `agents` table. Custom agents with
// this flag set to 0 are excluded from the PM's system-prompt agent list.
// Default 1 preserves the previous behavior where every custom agent was
// automatically visible to the PM.
export function run(): void {
	const cols = sqlite.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;

	if (!cols.some((c) => c.name === "available_to_pm")) {
		sqlite.exec("ALTER TABLE agents ADD COLUMN available_to_pm INTEGER NOT NULL DEFAULT 1");
	}
}
