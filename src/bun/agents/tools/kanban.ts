import { tool } from "ai";
import { z } from "zod";
import * as kanbanRpc from "../../rpc/kanban";
import type { ToolRegistryEntry } from "./index";

// Lazily resolved at call-time to avoid circular-import initialisation issues.
// By the time any execute() runs, all modules are fully loaded.
async function notifyKanban(projectId: string, taskId: string, action: string) {
	try {
		const { broadcastToWebview } = await import("../../engine-manager");
		broadcastToWebview("kanbanTaskUpdated", { projectId, taskId, action });
	} catch {
		// Non-critical — the board will sync on next manual refresh if this fails
	}
}

/**
 * Notify the review cycle that a task has moved to "review" so it can
 * spawn a code-reviewer agent for automated review.
 */
async function notifyTaskInReviewHandler(projectId: string, taskId: string) {
	try {
		const { notifyTaskInReview } = await import("../review-cycle");
		notifyTaskInReview(projectId, taskId);
	} catch (err) {
		console.error(`[kanban] notifyTaskInReview failed for task ${taskId}:`, err);
	}
}


// ---------------------------------------------------------------------------
// Acceptance criteria normalizer — handles JSON array or plain-text formats
// ---------------------------------------------------------------------------

/**
 * Parse acceptance criteria from any format into a consistent JSON array.
 * Supports: JSON array of {text, checked}, newline-separated text, or
 * plain strings. Always returns a valid array.
 */
function parseCriteria(raw: string | null | undefined): Array<{ text: string; checked: boolean }> {
	if (!raw || !raw.trim()) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.map((item) => {
				if (typeof item === "string") return { text: item, checked: false };
				return { text: String(item.text ?? item), checked: Boolean(item.checked) };
			});
		}
	} catch { /* not JSON — fall through to plain-text */ }
	// Plain-text fallback: newline-separated criteria
	return raw
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((text) => ({ text, checked: false }));
}

/**
 * Normalize a task object's acceptanceCriteria to always be a valid JSON array string.
 * Mutates the object in-place for convenience.
 */
function normalizeTaskCriteria<T extends { acceptanceCriteria?: string | null }>(task: T): T {
	if (task.acceptanceCriteria) {
		const criteria = parseCriteria(task.acceptanceCriteria);
		task.acceptanceCriteria = JSON.stringify(criteria);
	}
	return task;
}

// Per-task lock to serialize check_criteria calls and prevent read-modify-write races
const criteriaLocks = new Map<string, Promise<void>>();

type CriteriaCheckResult =
	| { error: string; task: null }
	| { error: string; task: Awaited<ReturnType<typeof kanbanRpc.getKanbanTask>> }
	| { error: null; task: Awaited<ReturnType<typeof kanbanRpc.getKanbanTask>> };

// Checks all acceptance criteria are met. Returns the fetched task (for reuse) and an error string if any are unmet.
async function checkAllCriteriaMet(taskId: string): Promise<CriteriaCheckResult> {
	const task = await kanbanRpc.getKanbanTask(taskId);
	if (!task) return { error: "Task not found", task: null };
	if (!task.acceptanceCriteria) {
		return { error: "This task has no acceptance criteria. Add and complete all criteria before moving to Review.", task };
	}
	const criteria = parseCriteria(task.acceptanceCriteria);
	if (criteria.length === 0) {
		return { error: "This task has no acceptance criteria. Add and complete all criteria before moving to Review.", task };
	}
	const unmet = criteria.filter((c) => !c.checked);
	if (unmet.length === 0) return { error: null, task };
	const list = unmet.map((c) => `  - ${c.text}`).join("\n");
	return { error: `Cannot move task to Review — ${unmet.length} of ${criteria.length} acceptance criteria not yet met:\n${list}\nUse the check_criteria tool to mark each criterion complete before moving to Review.`, task };
}

export function createKanbanTools(actorId: string): Record<string, ToolRegistryEntry> {
  return createKanbanToolsImpl(actorId);
}

// Backwards-compatible static export used by getAllTools() for plugin/category inspection.
// Does not carry an actorId — use createKanbanTools() for agent-context tool sets.
export const kanbanTools: Record<string, ToolRegistryEntry> = createKanbanToolsImpl("unknown");

function createKanbanToolsImpl(actorId: string): Record<string, ToolRegistryEntry> {
  return {
	create_task: {
		category: "kanban",
		tool: tool({
			description:
				"Create a new kanban task in a project. Tasks start in the backlog column by default. REQUIRED fields: title, description (what needs to be done and why), and acceptance_criteria (JSON array with at least one verifiable criterion). A task cannot be moved to Done until all acceptance criteria are checked off.",
			inputSchema: z.object({
				project_id: z
					.string()
					.describe("The ID of the project to create the task in"),
				title: z
					.string()
					.describe("The task title"),
				description: z
					.string()
					.describe("Required description of the task — explain what needs to be done and why"),
				acceptance_criteria: z
					.string()
					.describe(
						'Required acceptance criteria. Provide as JSON array e.g. [{"text":"Criterion 1","checked":false}] or as newline-separated text. At least one criterion required.',
					),
				important_notes: z
					.string()
					.optional()
					.describe("Optional important notes for the task"),
				column: z
					.enum(["backlog", "working", "review", "done"])
					.optional()
					.describe("Column to place the task in (default: backlog)"),
				priority: z
					.enum(["critical", "high", "medium", "low"])
					.optional()
					.describe("Task priority (default: medium)"),
				assigned_agent_id: z
					.string()
					.optional()
					.describe("ID of the agent to assign this task to"),
				blocked_by: z
					.string()
					.optional()
					.describe("JSON array of task IDs that block this task, e.g. [\"task-id-1\"]"),
				due_date: z
					.string()
					.optional()
					.describe("Due date for the task as a date string"),
			}),
			execute: async (args) => {
				try {
					// Validate project_id looks like a UUID — agents sometimes pass project name by mistake
					if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.project_id)) {
						return JSON.stringify({ success: false, error: `Invalid project_id "${args.project_id}" — must be a UUID, not a project name. Use the Project ID from your context.` });
					}
					const result = await kanbanRpc.createKanbanTask({
						projectId: args.project_id,
						title: args.title,
						description: args.description,
						acceptanceCriteria: JSON.stringify(parseCriteria(args.acceptance_criteria)),
						importantNotes: args.important_notes,
						column: args.column,
						priority: args.priority,
						assignedAgentId: args.assigned_agent_id,
						blockedBy: args.blocked_by,
						dueDate: args.due_date,
					});
					notifyKanban(args.project_id, result.id, "created");
					return JSON.stringify(result);
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},

	update_task: {
		category: "kanban",
		tool: tool({
			description:
				"Update the fields of an existing kanban task. Only provided fields are changed.",
			inputSchema: z.object({
				id: z
					.string()
					.describe("The ID of the task to update"),
				title: z
					.string()
					.optional()
					.describe("New title for the task"),
				description: z
					.string()
					.optional()
					.describe("New description for the task"),
				acceptance_criteria: z
					.string()
					.optional()
					.describe(
						'Updated JSON string of acceptance criteria array, e.g. [{"text":"Criterion 1","checked":true}]',
					),
				important_notes: z
					.string()
					.optional()
					.describe("Updated important notes for the task"),
				priority: z
					.enum(["critical", "high", "medium", "low"])
					.optional()
					.describe("New priority level for the task"),
				assigned_agent_id: z
					.string()
					.optional()
					.describe("ID of the agent to assign this task to"),
				blocked_by: z
					.string()
					.optional()
					.describe("Updated JSON array of task IDs that block this task"),
				due_date: z
					.string()
					.optional()
					.describe("Updated due date as a date string"),
			}),
			execute: async (args) => {
				try {
					const task = await kanbanRpc.getKanbanTask(args.id);
					const result = await kanbanRpc.updateKanbanTask({
						id: args.id,
						title: args.title,
						description: args.description,
						acceptanceCriteria: args.acceptance_criteria ? JSON.stringify(parseCriteria(args.acceptance_criteria)) : undefined,
						importantNotes: args.important_notes,
						priority: args.priority,
						assignedAgentId: args.assigned_agent_id,
						blockedBy: args.blocked_by,
						dueDate: args.due_date,
						actorId,
					});
					if (task?.projectId) notifyKanban(task.projectId, args.id, "updated");
					return JSON.stringify(result);
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},

	move_task: {
		category: "kanban",
		tool: tool({
			description:
				"Move a kanban task to a different column. Allowed destinations: backlog, working, review. NEVER move a task to 'done' — only the PM can do that via finalize_task_review. IMPORTANT: moving to 'review' requires ALL acceptance criteria to be checked first — use check_criteria to mark each one complete.",
			inputSchema: z.object({
				id: z
					.string()
					.describe("The ID of the task to move"),
				column: z
					.enum(["backlog", "working", "review"])
					.describe("The target column. Allowed values: backlog, working, review. Do NOT use 'done'."),
				position: z
					.number()
					.optional()
					.describe("Zero-based position within the target column (appended at end if omitted)"),
			}),
			execute: async (args) => {
				try {
					// For "review" moves, verify all acceptance criteria are checked
					// and verify_implementation has passed.
					let task: Awaited<ReturnType<typeof kanbanRpc.getKanbanTask>>;
					if (args.column === "review") {
						const check = await checkAllCriteriaMet(args.id);
						if (check.error) return JSON.stringify({ success: false, error: check.error });
						task = check.task;

						// Enforce verification — agent must call verify_implementation first
						if (task && task.verificationStatus !== "passed") {
							return JSON.stringify({
								success: false,
								error: "Cannot move to review: you must call verify_implementation first and pass the self-check. This is mandatory before any task can enter review.",
							});
						}
					} else {
						task = await kanbanRpc.getKanbanTask(args.id);
					}

					// Block moves out of "done" — the review system owns that transition
					if (task?.column === "done") {
						return JSON.stringify({
							success: false,
							error: `Task "${task?.title}" is already marked done and cannot be moved. Only the automated review system finalises tasks.`,
						});
					}
					const fromColumn = task?.column ?? "unknown";
					// No-op if already in the target column
					if (fromColumn === args.column) {
						return JSON.stringify({
							success: true,
							taskId: args.id,
							taskTitle: task?.title ?? null,
							note: `Task is already in "${args.column}" — no move needed.`,
						});
					}

					// Enforce valid column transitions — agents cannot skip columns
					// backlog → working (only forward move allowed from backlog)
					// working → review  (only forward move allowed from working)
					// working → backlog (allowed — agent gives up, puts it back)
					// review  → working (allowed — workflow sends back for fixes)
					// All other transitions are invalid
					const invalidTransition =
						(fromColumn === "backlog" && args.column === "review");
					if (invalidTransition) {
						return JSON.stringify({
							success: false,
							error: `Cannot move task directly from "${fromColumn}" to "${args.column}". You must move it to "working" first and complete the implementation before submitting for review.`,
						});
					}

					// Reset verification when moving back to working/backlog (e.g. after failed review)
					if (args.column === "working" || args.column === "backlog") {
						await kanbanRpc.updateKanbanTask({ id: args.id, verificationStatus: null });
					}

					const result = await kanbanRpc.moveKanbanTask(
						args.id,
						args.column,
						args.position,
						actorId,
					);
					if (task?.projectId) {
						notifyKanban(task.projectId, args.id, "moved");
						if (args.column === "review") {
							// Notify review cycle to spawn code-reviewer for this task
							await notifyTaskInReviewHandler(task.projectId, args.id);
						}
					}
					return JSON.stringify({
						...result,
						taskId: args.id,
						taskTitle: task?.title ?? null,
						from: fromColumn,
						to: args.column,
					});
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},

	check_criteria: {
		category: "kanban",
		tool: tool({
			description:
				"Mark one or more acceptance criteria as checked on a kanban task. " +
				"ALWAYS pass ALL criteria indices as an array in a single call — never call this tool multiple times for the same task. " +
				"Example: criteria_index=[0,1,2] marks all three at once. " +
				"Use check_all_criteria instead if you want to mark every criterion complete without specifying indices.",
			inputSchema: z.object({
				id: z
					.string()
					.describe("The ID of the task containing the criteria"),
				criteria_index: z
					.union([z.number().int(), z.string(), z.array(z.number().int())])
					.describe("Zero-based index or array of indices to mark. Pass ALL indices in one call: e.g. [0,1,2] for a 3-criterion task. Get the criteria list from get_task first to know the exact count."),
				checked: z
					.boolean()
					.describe("The new checked state for the criteria item(s)"),
			}),
			execute: async (args) => {
				// Serialize concurrent check_criteria calls per task to prevent
				// read-modify-write races (multiple calls reading the same state
				// and only the last write winning).
				const lock = criteriaLocks.get(args.id);
				if (lock) await lock;

				let resolve: () => void = () => { /* noop */ };
				const thisLock = new Promise<void>((r) => { resolve = r; });
				criteriaLocks.set(args.id, thisLock);

				try {
					const task = await kanbanRpc.getKanbanTask(args.id);
					if (!task) {
						return JSON.stringify({ success: false, error: "Task not found" });
					}

					const criteria = parseCriteria(task.acceptanceCriteria);

					// Parse criteria_index flexibly — models may send number, array, or stringified array
					let indices: number[];
					const raw = args.criteria_index;
					if (typeof raw === "number") {
						indices = [raw];
					} else if (Array.isArray(raw)) {
						indices = raw;
					} else if (typeof raw === "string") {
						try {
							const parsed = JSON.parse(raw);
							indices = Array.isArray(parsed) ? parsed : [Number(parsed)];
						} catch {
							indices = [Number(raw)];
						}
					} else {
						indices = [Number(raw)];
					}

					for (const idx of indices) {
						if (idx < 0 || idx >= criteria.length) {
							return JSON.stringify({
								success: false,
								error: `criteria_index ${idx} is out of range. Task "${args.id}" has ${criteria.length} criteria item(s) — valid indices are 0 to ${criteria.length - 1}. Call get_task to see the full list.`,
							});
						}
						criteria[idx].checked = args.checked;
					}

					const result = await kanbanRpc.updateKanbanTask({
						id: args.id,
						acceptanceCriteria: JSON.stringify(criteria),
						actorId,
					});
					if (task.projectId) notifyKanban(task.projectId, args.id, "updated");
					return JSON.stringify(result);
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				} finally {
					resolve();
					if (criteriaLocks.get(args.id) === thisLock) {
						criteriaLocks.delete(args.id);
					}
				}
			},
		}),
	},

	check_all_criteria: {
		category: "kanban",
		tool: tool({
			description:
				"Mark ALL acceptance criteria on a task as checked in one call. Use this instead of calling check_criteria multiple times. " +
				"Only call this when you have genuinely verified every criterion.",
			inputSchema: z.object({
				id: z.string().describe("The ID of the task"),
			}),
			execute: async (args) => {
				const lock = criteriaLocks.get(args.id);
				if (lock) await lock;
				let resolve: () => void = () => { /* noop */ };
				const thisLock = new Promise<void>((r) => { resolve = r; });
				criteriaLocks.set(args.id, thisLock);
				try {
					const task = await kanbanRpc.getKanbanTask(args.id);
					if (!task) return JSON.stringify({ success: false, error: "Task not found" });
					const criteria = parseCriteria(task.acceptanceCriteria);
					if (criteria.length === 0) return JSON.stringify({ success: false, error: "No acceptance criteria on this task" });
					const updated = criteria.map((c) => ({ ...c, checked: true }));
					await kanbanRpc.updateKanbanTask({ id: args.id, acceptanceCriteria: JSON.stringify(updated), actorId });
					if (task.projectId) notifyKanban(task.projectId, args.id, "updated");
					return JSON.stringify({
						success: true,
						checked: updated.length,
						message: `All ${updated.length} acceptance criteria marked as checked.`,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				} finally {
					resolve();
					if (criteriaLocks.get(args.id) === thisLock) criteriaLocks.delete(args.id);
				}
			},
		}),
	},

	add_task_notes: {
		category: "kanban",
		tool: tool({
			description:
				"Append text to the important notes section of a kanban task. The new text is added after any existing notes.",
			inputSchema: z.object({
				id: z
					.string()
					.describe("The ID of the task to append notes to"),
				notes: z
					.string()
					.describe("The text to append to the task's important notes"),
			}),
			execute: async (args) => {
				try {
					const task = await kanbanRpc.getKanbanTask(args.id);
					if (!task) {
						return JSON.stringify({ success: false, error: "Task not found" });
					}

					const existing = task.importantNotes ?? "";
					const updated = existing.length > 0
						? `${existing}\n${args.notes}`
						: args.notes;

					const result = await kanbanRpc.updateKanbanTask({
						id: args.id,
						importantNotes: updated,
						actorId,
					});
					if (task.projectId) notifyKanban(task.projectId, args.id, "updated");
					return JSON.stringify(result);
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},

	list_tasks: {
		category: "kanban",
		tool: tool({
			description:
				"List all kanban tasks for a project, ordered by position within each column.",
			inputSchema: z.object({
				project_id: z
					.string()
					.describe("The ID of the project whose tasks to list"),
			}),
			execute: async (args) => {
				try {
					const tasks = await kanbanRpc.getKanbanTasks(args.project_id);
					tasks.forEach(normalizeTaskCriteria);
					return JSON.stringify({ success: true, tasks });
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},

	get_task: {
		category: "kanban",
		tool: tool({
			description:
				"Get the full details of a single kanban task by its ID.",
			inputSchema: z.object({
				id: z
					.string()
					.describe("The ID of the task to retrieve"),
			}),
			execute: async (args) => {
				try {
					const task = await kanbanRpc.getKanbanTask(args.id);
					if (!task) {
						return JSON.stringify({ success: false, error: "Task not found" });
					}
					return JSON.stringify({ success: true, task: normalizeTaskCriteria(task) });
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},

	delete_task: {
		category: "kanban",
		tool: tool({
			description:
				"Permanently delete a kanban task by its ID. Use this when the user asks to remove, clear, or delete specific tasks or all tasks. Call list_tasks first to get task IDs if you don't already have them.",
			inputSchema: z.object({
				id: z
					.string()
					.describe("The ID of the task to delete"),
			}),
			execute: async (args) => {
				try {
					const task = await kanbanRpc.getKanbanTask(args.id);
					const projectId = task?.projectId;
					const result = await kanbanRpc.deleteKanbanTask(args.id);
					if (projectId) notifyKanban(projectId, args.id, "deleted");
					return JSON.stringify(result);
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},

	submit_review: {
		category: "kanban",
		tool: tool({
			description:
				"Submit a formal code review verdict for a kanban task. Only the code-reviewer agent should call this. Use 'approved' if the implementation meets all acceptance criteria and has no blocking issues. Use 'changes_requested' if there are issues that must be fixed before the task can be considered done.",
			inputSchema: z.object({
				task_id: z.string().describe("The kanban task ID being reviewed"),
				verdict: z.enum(["approved", "changes_requested"]).describe("The review verdict"),
				summary: z.string().describe(
					"Detailed review findings. For 'approved': brief confirmation of what was verified. " +
					"For 'changes_requested': a structured list of every issue that MUST be fixed, each with: " +
					"(1) file path and line number(s), (2) what is wrong, (3) exactly what to change. " +
					"Example format: '1. src/foo.ts:42 — null check missing on user.id before calling .trim(). Add: if (!user.id) return; 2. src/bar.ts:17-23 — loop allocates new array on every iteration, move outside loop.' " +
					"Be specific enough that a fix agent can resolve each issue without re-reading the full codebase."
				),
			}),
			execute: async (args) => {
				try {
					const task = await kanbanRpc.getKanbanTask(args.task_id);
					if (!task) {
						return JSON.stringify({ success: false, error: "Task not found" });
					}
					if (task.column !== "review") {
						return JSON.stringify({ success: false, error: `Task is in "${task.column}" column, not "review". Cannot submit review.` });
					}

					// Store the verdict and move the task
					const reviewNote = `[Review ${args.verdict === "approved" ? "APPROVED" : "CHANGES REQUESTED"}]: ${args.summary}`;
					const existing = task.importantNotes ?? "";
					const updated = existing.length > 0 ? `${existing}\n${reviewNote}` : reviewNote;
					await kanbanRpc.updateKanbanTask({ id: args.task_id, importantNotes: updated, actorId });

					// Move task based on verdict
					if (args.verdict === "approved") {
						await kanbanRpc.moveKanbanTask(args.task_id, "done", undefined, "code-reviewer");
					} else {
						await kanbanRpc.moveKanbanTask(args.task_id, "working", undefined, "code-reviewer");
					}
					notifyKanban(task.projectId, args.task_id, "moved");

					return JSON.stringify({
						success: true,
						message: args.verdict === "approved"
							? "Review approved. Task moved to done."
							: "Changes requested. Task moved back to working for fixes.",
					});
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},

	verify_implementation: {
		category: "kanban",
		tool: tool({
			description:
				"**MANDATORY** self-verification before a task can move to review. You MUST call this after implementation is complete. " +
				"The task CANNOT be moved to review without passing this check. " +
				"Pass your verdict (pass/fail), what you implemented, files changed, and any issues found. " +
				"On pass: task automatically moves to review. On fail: fix the issues and call again.",
			inputSchema: z.object({
				task_id: z.string().describe("The kanban task ID"),
				verdict: z.enum(["pass", "fail"]).describe("Your honest self-assessment: pass = all work complete and integrated, fail = gaps remain"),
				files_changed: z.array(z.string()).describe("List of files you created or modified"),
				summary: z.string().describe("What you implemented"),
				decisions_made: z.array(z.string()).optional().describe("Key decisions made during implementation (e.g. 'Used fetch API instead of axios', 'Added error boundary component')"),
				api_contracts: z.array(z.string()).optional().describe("API endpoints, interfaces, or contracts created/modified (e.g. 'POST /api/auth/login', 'interface UserProfile')"),
				follow_up_issues: z.array(z.string()).optional().describe("Issues discovered that need follow-up (e.g. 'Need to add rate limiting', 'Mobile responsive not tested')"),
				checklist: z.object({
					all_acceptance_criteria_met: z.boolean().describe("Did you verify EVERY acceptance criterion is implemented and working?"),
					ui_reflects_logic: z.boolean().describe("If you added backend/logic code, does the UI expose it so the user can see and interact with it?"),
					logic_supports_ui: z.boolean().describe("If you added UI elements, is the underlying logic wired up and functional?"),
					no_lsp_errors: z.boolean().describe("Did you check and fix all LSP errors in modified files?"),
					feature_is_user_accessible: z.boolean().describe("Can the end user actually use this feature from the app's interface?"),
				}).describe("Completeness checklist — answer each honestly"),
				issues: z.array(z.string()).optional().describe("If verdict is fail, describe what still needs fixing"),
			}),
			execute: async (args) => {
				try {
					const task = await kanbanRpc.getKanbanTask(args.task_id);
					if (!task) return JSON.stringify({ success: false, error: `Task ${args.task_id} not found` });

					// If verdict is fail, update status and return feedback
					if (args.verdict === "fail") {
						await kanbanRpc.updateKanbanTask({ id: args.task_id, verificationStatus: "failed", actorId });
						return JSON.stringify({
							verdict: "fail",
							action: "Fix the issues listed below, then call verify_implementation again with verdict=pass when done.",
							issues: args.issues ?? ["No specific issues provided — review your checklist answers"],
							checklist: args.checklist,
						});
					}

					// Verdict is pass — validate checklist
					const failedChecks: string[] = [];
					if (!args.checklist.all_acceptance_criteria_met) failedChecks.push("Not all acceptance criteria are met");
					if (!args.checklist.ui_reflects_logic) failedChecks.push("UI does not reflect the logic you added — users cannot see or interact with the feature");
					if (!args.checklist.logic_supports_ui) failedChecks.push("UI elements lack underlying logic/wiring");
					if (!args.checklist.no_lsp_errors) failedChecks.push("LSP errors remain in modified files");
					if (!args.checklist.feature_is_user_accessible) failedChecks.push("Feature is not accessible to the end user from the app interface");

					if (failedChecks.length > 0) {
						// Agent said pass but checklist has false items — reject
						await kanbanRpc.updateKanbanTask({ id: args.task_id, verificationStatus: "failed", actorId });
						return JSON.stringify({
							verdict: "fail",
							reason: "You marked verdict as pass but your checklist has unchecked items. Fix these issues first.",
							issues: failedChecks,
							checklist: args.checklist,
						});
					}

					// All checks pass — store structured report and auto-move to review
					const report = JSON.stringify({
						summary: args.summary,
						files_changed: args.files_changed,
						decisions_made: args.decisions_made ?? [],
						api_contracts: args.api_contracts ?? [],
						follow_up_issues: args.follow_up_issues ?? [],
					});
					await kanbanRpc.updateKanbanTask({
						id: args.task_id,
						verificationStatus: "passed",
						importantNotes: `## Completion Report\n\`\`\`json\n${report}\n\`\`\``,
						actorId,
					});
					// Auto-commit before review so reviewer can see git diff
					if (task.projectId) {
						try {
							const { autoCommitTask } = await import("../review-cycle");
							await autoCommitTask(task.projectId, args.task_id, task.title);
						} catch { /* non-fatal */ }
					}
					await kanbanRpc.moveKanbanTask(args.task_id, "review", undefined, actorId);
					if (task.projectId) {
						notifyKanban(task.projectId, args.task_id, "moved");
						await notifyTaskInReviewHandler(task.projectId, args.task_id);
					}

					return JSON.stringify({
						verdict: "pass",
						action: "Task verified and automatically moved to review. Your work is done — provide a summary in your final response.",
						files_changed: args.files_changed,
						summary: args.summary,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),
	},
  };
}
