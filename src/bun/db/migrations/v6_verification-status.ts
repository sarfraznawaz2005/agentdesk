import { sqlite } from "../connection";

export const name = "verification-status";

export function run(): void {
	const cols = sqlite.prepare("PRAGMA table_info(kanban_tasks)").all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === "verification_status")) {
		sqlite.exec("ALTER TABLE kanban_tasks ADD COLUMN verification_status TEXT DEFAULT NULL");
	}
}
