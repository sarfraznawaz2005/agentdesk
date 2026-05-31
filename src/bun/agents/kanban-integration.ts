import { eq } from "drizzle-orm";
import { db } from "../db";
import { kanbanTasks, kanbanTaskActivity } from "../db/schema";
import * as kanbanRpc from "../rpc/kanban";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KanbanIntegrationCallbacks {
	onNotifyPM(
		projectId: string,
		event: { type: string; taskId: string; details: Record<string, unknown> },
	): void;
	onBroadcast(method: string, payload: unknown): void;
}

// ---------------------------------------------------------------------------
// KanbanIntegration
// ---------------------------------------------------------------------------

/**
 * Bridges the kanban board and the agent engine.
 *
 * Handles human-initiated task moves (with blocked-task enforcement and PM
 * notifications) as well as agent-initiated moves (activity logging and
 * webview broadcast).
 */
export class KanbanIntegration {
	private callbacks: KanbanIntegrationCallbacks;

	constructor(callbacks: KanbanIntegrationCallbacks) {
		this.callbacks = callbacks;
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Handle a task move initiated by a human via the kanban UI.
	 *
	 * - Enforces the "blocked" rule: a task cannot move backlog → working while
	 *   any of its blocking tasks are not yet in the "done" column.
	 * - Performs the actual column change via kanbanRpc.
	 * - Notifies the PM of relevant lifecycle transitions.
	 */
	async handleHumanMove(
		taskId: string,
		fromColumn: string,
		toColumn: string,
	): Promise<{ success: boolean; error?: string }> {
		try {
			// Blocked-task guard: prevent moving into "working" from "backlog" when
			// one or more blocking tasks have not yet been completed.
			if (fromColumn === "backlog" && toColumn === "working") {
				const isReady = await this.checkBlocked(taskId);
				if (!isReady) {
					return { success: false, error: "Task is blocked" };
				}
			}

			// Perform the move
			await kanbanRpc.moveKanbanTask(taskId, toColumn, undefined, "human");

			// Resolve the projectId for PM notifications
			const projectId = await this.getProjectId(taskId);

			// Notify PM based on the transition
			if (fromColumn === "backlog" && toColumn === "working") {
				this.callbacks.onNotifyPM(projectId, {
					type: "human_started_task",
					taskId,
					details: { fromColumn, toColumn },
				});
			} else if (fromColumn === "working" && toColumn === "backlog") {
				this.callbacks.onNotifyPM(projectId, {
					type: "human_stopped_task",
					taskId,
					details: { fromColumn, toColumn },
				});
			} else if (toColumn === "done") {
				this.callbacks.onNotifyPM(projectId, {
					type: "human_completed_task",
					taskId,
					details: { fromColumn, toColumn },
				});
			}

			return { success: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[KanbanIntegration] handleHumanMove failed for task ${taskId}:`, err);
			return { success: false, error: message };
		}
	}

	/**
	 * Handle a task move initiated by an agent.
	 *
	 * Moves the task, writes an activity record, and broadcasts the update so
	 * the webview stays in sync in real time.
	 */
	async handleAgentMove(
		taskId: string,
		toColumn: string,
		agentId: string,
	): Promise<void> {
		try {
			await kanbanRpc.moveKanbanTask(taskId, toColumn, undefined, agentId);

			await this.logActivity(taskId, "moved", agentId, { toColumn });

			const projectId = await this.getProjectId(taskId);
			this.callbacks.onBroadcast("kanban:task_moved", {
				projectId,
				taskId,
				toColumn,
				agentId,
			});
		} catch (err) {
			console.error(`[KanbanIntegration] handleAgentMove failed for task ${taskId}:`, err);
		}
	}

	/**
	 * Determine whether a task's blockers have all been resolved.
	 *
	 * Returns `true`  when the task is NOT blocked (safe to move to "working").
	 * Returns `false` when at least one blocker is not yet in the "done" column.
	 *
	 * A task with no blockedBy data is considered unblocked.
	 */
	async checkBlocked(taskId: string): Promise<boolean> {
		try {
			const rows = await db
				.select({ blockedBy: kanbanTasks.blockedBy })
				.from(kanbanTasks)
				.where(eq(kanbanTasks.id, taskId))
				.limit(1);

			if (rows.length === 0) {
				// Task not found — treat as unblocked so the caller can surface
				// the missing-task error separately.
				return true;
			}

			const { blockedBy } = rows[0];
			if (!blockedBy) {
				return true;
			}

			let blockerIds: string[];
			try {
				const parsed = JSON.parse(blockedBy) as unknown;
				blockerIds = Array.isArray(parsed) ? (parsed as string[]) : [];
			} catch {
				// Malformed JSON — assume no blockers
				return true;
			}

			if (blockerIds.length === 0) {
				return true;
			}

			// Check every blocker's column; all must be "done"
			for (const blockerId of blockerIds) {
				const blockerRows = await db
					.select({ column: kanbanTasks.column })
					.from(kanbanTasks)
					.where(eq(kanbanTasks.id, blockerId))
					.limit(1);

				if (blockerRows.length === 0) {
					// Blocker task no longer exists — skip it
					continue;
				}

				if (blockerRows[0].column !== "done") {
					return false;
				}
			}

			return true;
		} catch (err) {
			console.error(`[KanbanIntegration] checkBlocked failed for task ${taskId}:`, err);
			// Fail safe: report as unblocked so moves are not silently swallowed
			return true;
		}
	}

	/**
	 * Append an activity record to kanban_task_activity.
	 */
	async logActivity(
		taskId: string,
		type: string,
		actorId: string,
		data: Record<string, unknown>,
	): Promise<void> {
		try {
			await db.insert(kanbanTaskActivity).values({
				id: crypto.randomUUID(),
				taskId,
				type,
				actorId,
				data: JSON.stringify(data),
			});
		} catch (err) {
			console.error(`[KanbanIntegration] logActivity failed for task ${taskId}:`, err);
		}
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	/**
	 * Resolve the projectId for a given task. Returns an empty string if the
	 * task cannot be found (callers treat it as a non-critical field).
	 */
	private async getProjectId(taskId: string): Promise<string> {
		try {
			const rows = await db
				.select({ projectId: kanbanTasks.projectId })
				.from(kanbanTasks)
				.where(eq(kanbanTasks.id, taskId))
				.limit(1);

			return rows[0]?.projectId ?? "";
		} catch {
			return "";
		}
	}
}
