import { sqlite } from "../connection";

export const name = "external-issues-due-date";

/**
 * Adds `due_date` to external_issues so issues imported from trackers that
 * support due dates (Jira, GitLab, Trello, Linear, Kanboard) can carry it into
 * kanban tasks created from them. Guarded so it's safe to re-run.
 */
export function run(): void {
	const cols = sqlite.prepare("PRAGMA table_info(external_issues)").all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === "due_date")) {
		sqlite.exec("ALTER TABLE external_issues ADD COLUMN due_date TEXT");
	}
}
