/**
 * Statistics & Analytics
 *
 * Queries run against kanban_tasks, kanban_task_activity, messages, and cost_budgets.
 */
import { sqlite } from "../db/connection";

// ── Project Dashboard ─────────────────────────────────────────────────────

export function getProjectStats(projectId: string, days = 30) {
	const since = new Date(Date.now() - days * 86400_000).toISOString();
	const global = projectId === "all";

	interface DayRow { day: string; count: number }
	const completedPerDay = global
		? sqlite.prepare(`SELECT date(updated_at) AS day, COUNT(*) AS count FROM kanban_tasks WHERE "column" = 'done' AND updated_at >= ? GROUP BY day ORDER BY day`).all(since) as DayRow[]
		: sqlite.prepare(`SELECT date(updated_at) AS day, COUNT(*) AS count FROM kanban_tasks WHERE project_id = ? AND "column" = 'done' AND updated_at >= ? GROUP BY day ORDER BY day`).all(projectId, since) as DayRow[];

	const createdPerDay = global
		? sqlite.prepare(`SELECT date(created_at) AS day, COUNT(*) AS count FROM kanban_tasks WHERE created_at >= ? GROUP BY day ORDER BY day`).all(since) as DayRow[]
		: sqlite.prepare(`SELECT date(created_at) AS day, COUNT(*) AS count FROM kanban_tasks WHERE project_id = ? AND created_at >= ? GROUP BY day ORDER BY day`).all(projectId, since) as DayRow[];

	interface ColRow { column: string; count: number }
	const byStatus = global
		? sqlite.prepare(`SELECT "column", COUNT(*) AS count FROM kanban_tasks GROUP BY "column"`).all() as ColRow[]
		: sqlite.prepare(`SELECT "column", COUNT(*) AS count FROM kanban_tasks WHERE project_id = ? GROUP BY "column"`).all(projectId) as ColRow[];

	interface PriRow { priority: string; count: number }
	const byPriority = global
		? sqlite.prepare(`SELECT priority, COUNT(*) AS count FROM kanban_tasks GROUP BY priority`).all() as PriRow[]
		: sqlite.prepare(`SELECT priority, COUNT(*) AS count FROM kanban_tasks WHERE project_id = ? GROUP BY priority`).all(projectId) as PriRow[];

	interface AvgRow { avg_hours: number | null }
	const avgCompletion = global
		? sqlite.prepare(`SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) AS avg_hours FROM kanban_tasks WHERE "column" = 'done'`).get() as AvgRow
		: sqlite.prepare(`SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) AS avg_hours FROM kanban_tasks WHERE project_id = ? AND "column" = 'done'`).get(projectId) as AvgRow;

	const activityHeatmap = global
		? sqlite.prepare(`SELECT CAST(strftime('%w', created_at) AS INTEGER) AS dow, CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS count FROM kanban_task_activity WHERE created_at >= ? GROUP BY dow, hour`).all(since) as Array<{ dow: number; hour: number; count: number }>
		: sqlite.prepare(`SELECT CAST(strftime('%w', kta.created_at) AS INTEGER) AS dow, CAST(strftime('%H', kta.created_at) AS INTEGER) AS hour, COUNT(*) AS count FROM kanban_task_activity kta JOIN kanban_tasks kt ON kt.id = kta.task_id WHERE kt.project_id = ? AND kta.created_at >= ? GROUP BY dow, hour`).all(projectId, since) as Array<{ dow: number; hour: number; count: number }>;

	return {
		completedPerDay: completedPerDay.map((r) => ({ day: r.day, count: r.count })),
		createdPerDay: createdPerDay.map((r) => ({ day: r.day, count: r.count })),
		byStatus: byStatus.map((r) => ({ status: r.column, count: r.count })),
		byPriority: byPriority.map((r) => ({ priority: r.priority, count: r.count })),
		avgCompletionHours: avgCompletion.avg_hours ?? 0,
		activityHeatmap,
		codeChurn: { added: 0, removed: 0 },
	};
}

// ── Summary for dashboard widget ─────────────────────────────────────────

export function getAnalyticsSummary(projectId: string) {
	interface SummaryRow { total_tasks: number; done_tasks: number; total_tokens: number }
	const row = sqlite.prepare(`
		SELECT
			(SELECT COUNT(*) FROM kanban_tasks WHERE project_id = ?) AS total_tasks,
			(SELECT COUNT(*) FROM kanban_tasks WHERE project_id = ? AND "column" = 'done') AS done_tasks,
			(SELECT COALESCE(SUM(m.token_count), 0) FROM messages m
			 JOIN conversations c ON c.id = m.conversation_id
			 WHERE c.project_id = ?) AS total_tokens
	`).get(projectId, projectId, projectId) as SummaryRow;

	return {
		totalTasks: row.total_tasks,
		doneTasks: row.done_tasks,
		totalTokens: row.total_tokens,
	};
}
