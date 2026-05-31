import { eq, and, asc, desc } from "drizzle-orm";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { kanbanTasks, kanbanTaskActivity, projects } from "../db/schema";
import { eventBus } from "../scheduler";
import { broadcastToWebview } from "../engine-manager";
import { sendDesktopNotification } from "../notifications/desktop";
import { broadcastTaskDoneNotification } from "../channels/manager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KanbanTask {
	id: string;
	projectId: string;
	title: string;
	description: string | null;
	acceptanceCriteria: string | null;
	importantNotes: string | null;
	column: string;
	priority: string;
	assignedAgentId: string | null;
	blockedBy: string | null;
	dueDate: string | null;
	position: number;
	reviewRounds: number;
	verificationStatus: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CreateKanbanTaskParams {
	projectId: string;
	title: string;
	description?: string;
	acceptanceCriteria?: string;
	importantNotes?: string;
	column?: string;
	priority?: string;
	assignedAgentId?: string;
	blockedBy?: string;
	dueDate?: string;
}

export interface UpdateKanbanTaskParams {
	id: string;
	title?: string;
	description?: string;
	acceptanceCriteria?: string;
	importantNotes?: string;
	column?: string;
	priority?: string;
	assignedAgentId?: string;
	blockedBy?: string;
	dueDate?: string;
	position?: number;
	reviewRounds?: number;
	verificationStatus?: string | null;
	actorId?: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get all kanban tasks for a project, ordered by column then position.
 */
export async function getKanbanTasks(projectId: string): Promise<KanbanTask[]> {
	const rows = await db
		.select()
		.from(kanbanTasks)
		.where(eq(kanbanTasks.projectId, projectId))
		.orderBy(asc(kanbanTasks.position));

	return rows.map(mapTask);
}

/**
 * Get a single kanban task by ID.
 */
export async function getKanbanTask(id: string): Promise<KanbanTask | null> {
	const rows = await db
		.select()
		.from(kanbanTasks)
		.where(eq(kanbanTasks.id, id))
		.limit(1);

	return rows.length > 0 ? mapTask(rows[0]) : null;
}

/**
 * Create a new kanban task.
 */
export async function createKanbanTask(
	params: CreateKanbanTaskParams,
): Promise<{ success: boolean; id: string }> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	// Get max position in the target column to append at end
	const existing = await db
		.select({ position: kanbanTasks.position })
		.from(kanbanTasks)
		.where(
			and(
				eq(kanbanTasks.projectId, params.projectId),
				eq(kanbanTasks.column, params.column ?? "backlog"),
			),
		)
		.orderBy(desc(kanbanTasks.position))
		.limit(1);

	const position = existing.length > 0 ? existing[0].position + 1 : 0;

	await db.insert(kanbanTasks).values({
		id,
		projectId: params.projectId,
		title: params.title,
		description: params.description ?? null,
		acceptanceCriteria: params.acceptanceCriteria ?? null,
		importantNotes: params.importantNotes ?? null,
		column: params.column ?? "backlog",
		priority: params.priority ?? "medium",
		assignedAgentId: params.assignedAgentId ?? null,
		blockedBy: params.blockedBy ?? null,
		dueDate: params.dueDate ?? null,
		position,
		createdAt: now,
		updatedAt: now,
	});

	// Log activity
	await logActivity(id, "created", null, { column: params.column ?? "backlog" });

	eventBus.emit({ type: "task:created", projectId: params.projectId, taskId: id });

	return { success: true, id };
}

/**
 * Update an existing kanban task.
 */
export async function updateKanbanTask(
	params: UpdateKanbanTaskParams,
): Promise<{ success: boolean }> {
	const updates: Record<string, unknown> = {
		updatedAt: new Date().toISOString(),
	};

	if (params.title !== undefined) updates.title = params.title;
	if (params.description !== undefined) updates.description = params.description;
	if (params.acceptanceCriteria !== undefined) updates.acceptanceCriteria = params.acceptanceCriteria;
	if (params.importantNotes !== undefined) updates.importantNotes = params.importantNotes;
	if (params.column !== undefined) updates.column = params.column;
	if (params.priority !== undefined) updates.priority = params.priority;
	if (params.assignedAgentId !== undefined) updates.assignedAgentId = params.assignedAgentId;
	if (params.blockedBy !== undefined) updates.blockedBy = params.blockedBy;
	if (params.dueDate !== undefined) updates.dueDate = params.dueDate;
	if (params.position !== undefined) updates.position = params.position;
	if (params.reviewRounds !== undefined) updates.reviewRounds = params.reviewRounds;
	if (params.verificationStatus !== undefined) updates.verificationStatus = params.verificationStatus ?? null;

	await db
		.update(kanbanTasks)
		.set(updates)
		.where(eq(kanbanTasks.id, params.id));

	await logActivity(params.id, "updated", params.actorId ?? null, updates);

	return { success: true };
}

/**
 * Move a kanban task to a different column (and optionally reposition).
 */
export async function moveKanbanTask(
	id: string,
	column: string,
	position?: number,
	actorId?: string,
): Promise<{ success: boolean }> {
	// Get current state for activity log
	const current = await getKanbanTask(id);
	if (!current) return { success: false };
	const fromColumn = current.column ?? "unknown";

	// No-op if already in the target column
	if (fromColumn === column) return { success: true };

	const updates: Record<string, unknown> = {
		column,
		updatedAt: new Date().toISOString(),
	};
	if (position !== undefined) updates.position = position;

	await db
		.update(kanbanTasks)
		.set(updates)
		.where(eq(kanbanTasks.id, id));

	await logActivity(id, "moved", actorId ?? null, {
		from: fromColumn,
		to: column,
	});

	if (current) {
		eventBus.emit({ type: "task:moved", projectId: current.projectId, taskId: id, from: fromColumn, to: column });
		broadcastToWebview("kanbanTaskUpdated", { projectId: current.projectId, taskId: id, action: "moved" });
		if (column === "done") {
			sendDesktopNotification("✅ Task Done", current.title ?? id).catch(() => {});
			// Notify all connected channels (fire-and-forget)
			db.select({ name: projects.name })
				.from(projects)
				.where(eq(projects.id, current.projectId))
				.limit(1)
				.then((rows) => broadcastTaskDoneNotification(current.title ?? id, rows[0]?.name ?? undefined))
				.catch(() => {});
		}
	}

	return { success: true };
}

/**
 * Delete a kanban task and its activity log.
 */
export async function deleteKanbanTask(
	id: string,
): Promise<{ success: boolean }> {
	// Delete activity first (foreign key)
	await db.delete(kanbanTaskActivity).where(eq(kanbanTaskActivity.taskId, id));
	await db.delete(kanbanTasks).where(eq(kanbanTasks.id, id));
	return { success: true };
}

/**
 * Get activity log for a task.
 */
export async function getTaskActivity(taskId: string) {
	return db
		.select()
		.from(kanbanTaskActivity)
		.where(eq(kanbanTaskActivity.taskId, taskId))
		.orderBy(desc(kanbanTaskActivity.createdAt));
}

/**
 * Get task stats (done / total) grouped by project — for dashboard cards.
 */
export function getProjectTaskStats(): Array<{ projectId: string; done: number; total: number }> {
	return sqlite.prepare(`
		SELECT
			project_id AS projectId,
			COUNT(*) AS total,
			SUM(CASE WHEN "column" = 'done' THEN 1 ELSE 0 END) AS done
		FROM kanban_tasks
		GROUP BY project_id
	`).all() as Array<{ projectId: string; done: number; total: number }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapTask(row: typeof kanbanTasks.$inferSelect): KanbanTask {
	return {
		id: row.id,
		projectId: row.projectId,
		title: row.title,
		description: row.description,
		acceptanceCriteria: row.acceptanceCriteria,
		importantNotes: row.importantNotes,
		column: row.column,
		priority: row.priority,
		assignedAgentId: row.assignedAgentId,
		blockedBy: row.blockedBy,
		dueDate: row.dueDate,
		position: row.position,
		reviewRounds: row.reviewRounds,
		verificationStatus: row.verificationStatus ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

async function logActivity(
	taskId: string,
	type: string,
	actorId: string | null,
	data: Record<string, unknown>,
): Promise<void> {
	await db.insert(kanbanTaskActivity).values({
		id: crypto.randomUUID(),
		taskId,
		type,
		actorId,
		data: JSON.stringify(data),
	});
}
