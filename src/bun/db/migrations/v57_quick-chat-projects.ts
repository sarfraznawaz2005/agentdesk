import { sqlite } from "../connection";

export const name = "quick-chat-projects";

/**
 * Adds `is_quick_chat` to projects so a project created via the OS Explorer
 * "Open in AgentDesk" entry (no user-driven project creation) can be hidden
 * from the Dashboard and from the PM's own list_projects/search_projects
 * tools until the user explicitly promotes it via "Create Project" in the
 * Quick Chat window. Guarded so it's safe to re-run.
 */
export function run(): void {
	const cols = sqlite.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === "is_quick_chat")) {
		sqlite.exec("ALTER TABLE projects ADD COLUMN is_quick_chat INTEGER NOT NULL DEFAULT 0");
	}
}
