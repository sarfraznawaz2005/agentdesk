/**
 * Phase 13 — Project data export/import RPC handlers.
 */
import { sqlite } from "../db/connection";
import { logAudit } from "../db/audit";

const EXPORT_VERSION = 1;

/**
 * Export all project data as a JSON string.
 */
export function exportProjectData(projectId: string): { data: string } {
	const project = sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
	if (!project) throw new Error("Project not found");

	const conversations = sqlite.prepare("SELECT * FROM conversations WHERE project_id = ?").all(projectId);
	const convIds = (conversations as Array<{ id: string }>).map((c) => c.id);

	let allMessages: unknown[] = [];
	let allSummaries: unknown[] = [];
	if (convIds.length > 0) {
		const placeholders = convIds.map(() => "?").join(",");
		allMessages = sqlite.prepare(`SELECT * FROM messages WHERE conversation_id IN (${placeholders})`).all(...convIds);
		allSummaries = sqlite.prepare(`SELECT * FROM conversation_summaries WHERE conversation_id IN (${placeholders})`).all(...convIds);
	}

	const kanbanTasks = sqlite.prepare("SELECT * FROM kanban_tasks WHERE project_id = ?").all(projectId);
	const taskIds = (kanbanTasks as Array<{ id: string }>).map((t) => t.id);

	let kanbanActivity: unknown[] = [];
	if (taskIds.length > 0) {
		const placeholders = taskIds.map(() => "?").join(",");
		kanbanActivity = sqlite.prepare(`SELECT * FROM kanban_task_activity WHERE task_id IN (${placeholders})`).all(...taskIds);
	}

	const notes = sqlite.prepare("SELECT * FROM notes WHERE project_id = ?").all(projectId);

	const exportData = {
		version: EXPORT_VERSION,
		exportedAt: new Date().toISOString(),
		project,
		conversations,
		messages: allMessages,
		conversationSummaries: allSummaries,
		kanbanTasks,
		kanbanTaskActivity: kanbanActivity,
		notes,
	};

	logAudit({
		action: "project.export",
		entityType: "project",
		entityId: projectId,
		details: {
			conversations: conversations.length,
			messages: allMessages.length,
			kanbanTasks: kanbanTasks.length,
			notes: notes.length,
		},
	});

	return { data: JSON.stringify(exportData, null, 2) };
}

/**
 * Import project data from a JSON string.
 */
export function importProjectData(
	projectId: string,
	data: string,
	mode: "merge" | "replace",
): { success: boolean; counts: Record<string, number> } {
	const parsed = JSON.parse(data);
	if (!parsed.version) throw new Error("Invalid export format: missing version");

	const counts: Record<string, number> = {};

	const tx = sqlite.transaction(() => {
		if (mode === "replace") {
			// Delete existing project data (same cascade as deleteProjectCascade, but keep the project)
			const convIds = (sqlite.prepare("SELECT id FROM conversations WHERE project_id = ?").all(projectId) as Array<{ id: string }>).map((c) => c.id);
			if (convIds.length > 0) {
				const ph = convIds.map(() => "?").join(",");
				sqlite.prepare(`DELETE FROM messages WHERE conversation_id IN (${ph})`).run(...convIds);
				sqlite.prepare(`DELETE FROM conversation_summaries WHERE conversation_id IN (${ph})`).run(...convIds);
			}
			sqlite.prepare("DELETE FROM conversations WHERE project_id = ?").run(projectId);

			const taskIds = (sqlite.prepare("SELECT id FROM kanban_tasks WHERE project_id = ?").all(projectId) as Array<{ id: string }>).map((t) => t.id);
			if (taskIds.length > 0) {
				const ph = taskIds.map(() => "?").join(",");
				sqlite.prepare(`DELETE FROM kanban_task_activity WHERE task_id IN (${ph})`).run(...taskIds);
			}
			sqlite.prepare("DELETE FROM kanban_tasks WHERE project_id = ?").run(projectId);

			sqlite.prepare("DELETE FROM notes WHERE project_id = ?").run(projectId);
		}

		const insertOrIgnore = mode === "merge" ? "INSERT OR IGNORE" : "INSERT";

		counts.conversations = insertRows(parsed.conversations, "conversations", insertOrIgnore);
		counts.messages = insertRows(parsed.messages, "messages", insertOrIgnore);
		counts.conversationSummaries = insertRows(parsed.conversationSummaries, "conversation_summaries", insertOrIgnore);
		counts.kanbanTasks = insertRows(parsed.kanbanTasks, "kanban_tasks", insertOrIgnore);
		counts.kanbanTaskActivity = insertRows(parsed.kanbanTaskActivity, "kanban_task_activity", insertOrIgnore);
		counts.notes = insertRows(parsed.notes, "notes", insertOrIgnore);
	});

	tx();

	logAudit({
		action: "project.import",
		entityType: "project",
		entityId: projectId,
		details: { mode, counts },
	});

	return { success: true, counts };
}

function insertRows(rows: unknown[] | undefined, table: string, insertMode: string): number {
	if (!rows || rows.length === 0) return 0;

	let inserted = 0;
	for (const row of rows) {
		const obj = row as Record<string, unknown>;
		const keys = Object.keys(obj);
		const cols = keys.join(", ");
		const placeholders = keys.map(() => "?").join(", ");
		const values = keys.map((k) => {
			const v = obj[k];
			// SQLite only accepts string | number | bigint | boolean | null | Uint8Array
			if (v === null || v === undefined) return null;
			if (typeof v === "object") return JSON.stringify(v);
			return v as string | number;
		});

		try {
			sqlite.prepare(`${insertMode} INTO ${table} (${cols}) VALUES (${placeholders})`).run(...values);
			inserted++;
		} catch {
			// Skip rows that fail (e.g. constraint violations in merge mode)
		}
	}
	return inserted;
}
