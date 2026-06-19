import { tool, generateText } from "ai";
import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { db } from "../../db";
import {
	agents as agentsTable,
	settings,
	messages,
	projects as projectsTable,
	deployEnvironments,
	deployHistory,
	pullRequests,
	prComments,
	costBudgets,
	cronJobs,
	cronJobHistory,
	auditLog,
	githubIssues,
	channels,
	branchStrategies,
	kanbanTasks,
} from "../../db/schema";
import type { AgentActivityEvent } from "../types";
import { runInlineAgent, pruneAgentToolResults, READ_ONLY_AGENTS, type InlineAgentCallbacks } from "../agent-loop";
import { buildContext } from "../context";
import type { MessageMetadata } from "../engine";
import { createProjectHandler, getProjectsList } from "../../rpc/projects";
import { schedulerTools } from "./scheduler";
import { getConversations, createConversation, deleteConversation, getMessages } from "../../rpc/conversations";
import { getInboxMessages, searchInboxMessages } from "../../rpc/inbox";
import { getSettings, getSetting, saveSetting } from "../../rpc/settings";
import { createProviderAdapter } from "../../providers";
import { getProjectNotes, getNote, searchNotes, createNote, updateNote } from "../../rpc/notes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PMToolsDeps {
	projectId: string;
	conversationId: string;
	/** Absolute path to the project workspace directory. */
	workspacePath?: string;
	/** Emit an activity event attributed to the project-manager. */
	emitPMActivity: (type: AgentActivityEvent["type"], data: Record<string, unknown>) => void;
	/** Emit a new message (or refresh an existing one) in the conversation. */
	emitNewMessage: (params: { messageId: string; agentId: string; agentName: string; content: string; metadata: string }) => void;
	/** Returns the active message metadata (source, channelId, etc.). */
	getActiveMetadata?: () => MessageMetadata;
	/** Callbacks for streaming inline agent parts to frontend. */
	inlineAgentCallbacks: InlineAgentCallbacks;
	/** Provider config for agent dispatch. */
	providerConfig: import("../../providers/types").ProviderConfig;
	/** Ask the user a question via modal dialog (app source only). Returns the user's answer. */
	askUserQuestion?: (payload: {
		question: string;
		inputType: "choice" | "text" | "confirm" | "multi_select";
		options?: string[];
		placeholder?: string;
		defaultValue?: string;
		context?: string;
	}) => Promise<string>;
	/** Register/unregister an abort controller for a running agent (global tracking for stop-all). */
	registerAgentAbort?: (controller: AbortController, agentName: string) => void;
	unregisterAgentAbort?: (controller: AbortController) => void;
	/** Stop the PM's current stream (used after plan approval submission). */
	stopPMStream?: () => void;
	/** Called when a dispatched agent completes — restarts PM with agent result. */
	onAgentDone?: (agentName: string, displayName: string, result: { status: string; summary: string; filesModified: string[] }) => void;
	/** When true, only read-only agents may be dispatched and all agents get read-only tools. */
	planMode?: boolean;
	/**
	 * The original user message that triggered this PM run.
	 * Appended to sub-agent task prompts (when no kanban_task_id) so the agent
	 * always sees the user's exact words, including any specific tool or method requests.
	 */
	lastUserMessage?: string;
	/** All agent names loaded from DB — includes custom agents. Falls back to hardcoded list. */
	agentNames?: readonly string[];
}

// ---------------------------------------------------------------------------
// Available agent names (must match agents table)
// ---------------------------------------------------------------------------

const AGENT_NAMES = [
	"software-architect",
	"frontend_engineer",
	"backend-engineer",
	"devops-engineer",
	"qa-engineer",
	"security-expert",
	"documentation-expert",
	"code-reviewer",
	"task-planner",
	"debugging-specialist",
	"performance-expert",
	"data-engineer",
	"ui-ux-designer",
	"refactoring-specialist",
	"code-explorer",
	"api-designer",
	"database-expert",
	"ml-engineer",
	"mobile-engineer",
	"research-expert",
] as const;

// ---------------------------------------------------------------------------
// Direct DB helpers for todo items — bypass getSetting's auto-JSON-parse
// (getSetting already JSON.parses the stored value, so callers must NOT
//  call JSON.parse again. We use raw DB access to stay explicit.)
// ---------------------------------------------------------------------------

type TodoItem = { id: string; title: string; status: string };


async function getTodoItems(conversationId: string, listId: string): Promise<TodoItem[] | null> {
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, `pm_todos:${conversationId}:${listId}`))
		.limit(1);
	if (rows.length === 0) return null;
	try { return JSON.parse(rows[0].value) as TodoItem[]; } catch { return null; }
}

async function setTodoItems(conversationId: string, listId: string, items: TodoItem[]): Promise<void> {
	const key = `pm_todos:${conversationId}:${listId}`;
	const value = JSON.stringify(items);
	const existing = await db.select({ id: settings.id }).from(settings).where(eq(settings.key, key)).limit(1);
	if (existing.length > 0) {
		await db.update(settings).set({ value, category: "pm_todos", updatedAt: new Date().toISOString() }).where(eq(settings.key, key));
	} else {
		await db.insert(settings).values({ key, value, category: "pm_todos" });
	}
}

async function getActiveListId(conversationId: string): Promise<string | null> {
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, `pm_active_todo:${conversationId}`))
		.limit(1);
	if (rows.length === 0) return null;
	try { return JSON.parse(rows[0].value) as string | null; } catch { return rows[0].value; }
}

async function setActiveListId(conversationId: string, listId: string | null): Promise<void> {
	const key = `pm_active_todo:${conversationId}`;
	const value = JSON.stringify(listId);
	const existing = await db.select({ id: settings.id }).from(settings).where(eq(settings.key, key)).limit(1);
	if (existing.length > 0) {
		await db.update(settings).set({ value, category: "pm_todos", updatedAt: new Date().toISOString() }).where(eq(settings.key, key));
	} else {
		await db.insert(settings).values({ key, value, category: "pm_todos" });
	}
}

// ---------------------------------------------------------------------------
// Helper — auto-mark a todo item done (used by run_agent callback)
// ---------------------------------------------------------------------------

async function autoMarkTodoDone(conversationId: string, listId: string, todoItemId: string, emitNewMessage: PMToolsDeps["emitNewMessage"]) {
	try {
		const items = await getTodoItems(conversationId, listId);
		if (!items) return;
		const idx = items.findIndex((i) => i.id === todoItemId);
		if (idx === -1) return;
		items[idx].status = "done";
		await setTodoItems(conversationId, listId, items);

		const messageId = `todo-list:${conversationId}:${listId}`;
		const doneCount = items.filter((i) => i.status === "done").length;
		const content = `${doneCount}/${items.length} tasks`;

		if (doneCount === items.length) {
			await setActiveListId(conversationId, null);
		}
		const metadata = JSON.stringify({ type: "todo_list", list_id: listId, items });

		const existing = await db.select({ id: messages.id }).from(messages).where(eq(messages.id, messageId)).limit(1);
		if (existing.length > 0) {
			await db.update(messages).set({ content, metadata }).where(eq(messages.id, messageId));
		} else {
			await db.insert(messages).values({
				id: messageId,
				conversationId,
				role: "assistant",
				agentId: "project-manager",
				content,
				metadata,
				tokenCount: 0,
				createdAt: new Date().toISOString(),
			});
		}
		emitNewMessage({ messageId, agentId: "project-manager", agentName: "Project Manager", content, metadata });
	} catch { /* non-fatal */ }
}

// Auto-advance: mark the first pending item done when agent completes but didn't pass todo_list_id
export async function autoAdvanceTodo(conversationId: string, emitNewMessage: PMToolsDeps["emitNewMessage"]): Promise<void> {
	try {
		const listId = await getActiveListId(conversationId);
		if (!listId) return;
		const items = await getTodoItems(conversationId, listId);
		if (!items) return;
		const firstPending = items.find((i) => i.status === "pending");
		if (!firstPending) return;
		await autoMarkTodoDone(conversationId, listId, firstPending.id, emitNewMessage);
	} catch { /* non-fatal */ }
}

export async function getActiveTodoStatus(conversationId: string): Promise<string> {
	try {
		const listId = await getActiveListId(conversationId);
		if (!listId) return "";
		const items = await getTodoItems(conversationId, listId);
		if (!items) return "";
		const doneCount = items.filter((i) => i.status === "done").length;
		if (doneCount === items.length) return ""; // all done, no need to remind PM
		const pending = items.filter((i) => i.status !== "done");
		const pendingList = pending.map((i) => `  - id:"${i.id}" ${i.title} [${i.status}]`).join("\n");
		return `\n\n[Todo List: ${listId}] ${doneCount}/${items.length} done — remaining:\n${pendingList}\nUse todo_list_id="${listId}" in run_agent for remaining items.`;
	} catch { return ""; }
}

// ---------------------------------------------------------------------------
// Module-level pre-registration dispatch guard
// ---------------------------------------------------------------------------

/**
 * Tracks agents that are in the process of being dispatched (after the
 * getRunningAgentNames check but before registerAbort completes).
 * Vercel AI SDK executes multiple tool calls from a single LLM step
 * concurrently via Promise.all, so two run_agent("same-agent") calls can
 * both pass the getRunningAgentNames check before either one registers.
 * This Set closes that gap atomically (JS is single-threaded).
 */
const dispatchingAgents = new Set<string>();

// ---------------------------------------------------------------------------
// Factory — creates PM-specific tools that close over the engine
// ---------------------------------------------------------------------------

export function createPMTools(deps: PMToolsDeps) {
	// Closure-scoped guard: prevents concurrent write-agent dispatch even if
	// the LLM emits two parallel run_agent tool calls in a single step.
	let writeAgentRunning = false;
	const effectiveAgentNames = deps.agentNames ?? AGENT_NAMES;

	return {
		...schedulerTools,
		run_agent: tool({
			description: `Run a specialist sub-agent to complete a task. The agent runs inline in the main chat — you and the user see all its tool calls and output. The agent gets a fresh context with your task description and explores the codebase itself. Use for implementation, review, debugging, testing, or any task needing specialist skills.

IMPORTANT: The agent does NOT see our conversation history. Your task description is the agent's ENTIRE context. Write comprehensive task descriptions that include: what to do, which files/areas are relevant, acceptance criteria, tech stack, what prior agents already created (mention specific files).

If you have an active todo list, pass todo_list_id (from todo_write) and todo_item_id — the item will be automatically marked done when the agent completes.

Available agents: ${effectiveAgentNames.join(", ")}.`,
			inputSchema: z.object({
				agent: z.string().describe(
					`The specialist agent to run. Must be one of: ${effectiveAgentNames.join(", ")}`,
				),
				task: z.string().describe(
					"Comprehensive task description. Include: what to do, which files/areas are relevant, acceptance criteria, and any constraints. The agent does NOT see conversation history — this description IS its full context.",
				),
				kanban_task_id: z.string().optional().describe(
					"Kanban task ID — auto-moves to 'working' when agent starts, 'review' on completion.",
				),
				project_id: z.string().optional().describe(
					"Target project ID for the agent. REQUIRED when working on any project other than the current conversation's project — e.g. when a channel user asks to work on a specific project. The agent will operate in that project's workspace. Get the ID via list_projects or search_projects. If earlier in this conversation you already identified a project ID, reuse it — do NOT fall back to the default project.",
				),
				todo_list_id: z.string().optional().describe(
					"The list_id from todo_write — identifies which todo list this agent belongs to.",
				),
				todo_item_id: z.string().optional().describe(
					"The item id within that todo list — automatically marked 'done' when the agent completes successfully.",
				),
			}),
			execute: async (args) => {
				// Whether the background agent dispatch was actually launched. If a
				// synchronous-path error throws BEFORE dispatch, the .then/.catch chain that
				// normally releases the guards is never attached — so the outer catch must
				// release them or all future write-agent dispatch deadlocks until app restart.
				// Declared outside the try so they remain in scope inside the catch.
				let dispatchInitiated = false;
				let releaseGuards: (() => void) | null = null;
				try {
					// Validate task is not empty — return error so PM retries with a description
					if (!args.task?.trim()) {
						return JSON.stringify({
							success: false,
							error: "Task description is required. You MUST provide a comprehensive task description — the agent has NO conversation history and relies entirely on your description.",
						});
					}

					// When the agent is dispatched for a direct user query (no kanban task),
					// append the original user message so the agent sees the user's exact words,
					// including any specific tool names or methods they requested.
					let task = args.task;
					if (!args.kanban_task_id && deps.lastUserMessage) {
						task = `${task}\n\n---\nOriginal User Request: ${deps.lastUserMessage}`;
					}

					// Channel conversations (WhatsApp, Discord, Email) have no meaningful
					// default project — the routing project is arbitrary. Require an explicit
					// project_id so the agent always runs in the right place.
					const isChannelConversation = deps.conversationId.startsWith("channel:");
					if (isChannelConversation && !args.project_id) {
						const projectList = await db
							.select({ id: projectsTable.id, name: projectsTable.name })
							.from(projectsTable)
							.limit(20);
						return JSON.stringify({
							success: false,
							error: "project_id is required when dispatching agents from a channel conversation. " +
								"You are messaging via WhatsApp/Discord/Email where there is no default project. " +
								"Use list_projects or search_projects to find the project, then pass its ID as project_id.",
							availableProjects: projectList.map(p => ({ id: p.id, name: p.name })),
						});
					}

					// Resolve target project — use project_id override if provided.
					// Must happen before guard checks so we validate against the right project.
					let effectiveProjectId = deps.projectId;
					let effectiveWorkspacePath = deps.workspacePath;
					if (args.project_id && args.project_id !== deps.projectId) {
						const projectRow = await db
							.select({ id: projectsTable.id, workspacePath: projectsTable.workspacePath })
							.from(projectsTable)
							.where(eq(projectsTable.id, args.project_id))
							.limit(1);
						if (projectRow.length > 0) {
							effectiveProjectId = projectRow[0].id;
							effectiveWorkspacePath = projectRow[0].workspacePath;
						}
					}
					const isCrossProject = effectiveProjectId !== deps.projectId;

					// Re-entrancy guard: only one write-agent at a time.
					// Use effectiveProjectId so cross-project dispatches check the right project.
					const isReadOnly = READ_ONLY_AGENTS.has(args.agent);

					// Prevent duplicate dispatch: block if this exact agent is already running
					// OR currently being dispatched by a concurrent tool call in this step.
					// Vercel AI SDK runs parallel tool calls via Promise.all, so two
					// run_agent("same-agent") calls from one LLM step can both pass the
					// getRunningAgentNames check before either one registers the abort controller.
					// dispatchingAgents is checked and populated atomically (JS single-threaded).
					const dispatchKey = `${effectiveProjectId}:${args.agent}`;
					{
						const { getRunningAgentNames } = await import("../../engine-manager");
						const alreadyRunning = getRunningAgentNames(effectiveProjectId);
						if (alreadyRunning.includes(args.agent) || dispatchingAgents.has(dispatchKey)) {
							deps.stopPMStream?.();
							return JSON.stringify({
								success: false,
								error: `${args.agent} is already running for this project. Only one instance of each agent can run at a time. Wait for it to complete.`,
							});
						}
					}
					dispatchingAgents.add(dispatchKey);
					// Capture guard-release so the outer catch can free the guards if a
					// synchronous-path error (e.g. the agent-rows db.select, cross-project
					// channel-conversation resolution, or a dynamic import) throws before the
					// background dispatch launches. writeAgentRunning may be set further below;
					// the closure reads it at call time, so a no-op clear when unset is harmless.
					releaseGuards = () => {
						dispatchingAgents.delete(dispatchKey);
						if (!isReadOnly) writeAgentRunning = false;
					};

					// Plan mode: only read-only agents are allowed.
					if (deps.planMode && !isReadOnly) {
						dispatchingAgents.delete(dispatchKey);
						return JSON.stringify({
							success: false,
							error: `Plan Mode is active — only read-only agents (${[...READ_ONLY_AGENTS].join(", ")}) can be dispatched. Ask the user to switch to Build Mode to run ${args.agent}.`,
						});
					}

					if (!isReadOnly) {
						if (writeAgentRunning) {
							// Stop PM stream so it does not keep retrying in the same session
							dispatchingAgents.delete(dispatchKey);
							deps.stopPMStream?.();
							return JSON.stringify({
								success: false,
								error: "A write agent is already running. Wait for it to complete before dispatching another write agent. Use run_agents_parallel for read-only exploration tasks.",
							});
						}
						// Also check global running count — a review-cycle fix agent may be running
						const { getRunningAgentCount } = await import("../../engine-manager");
						if (getRunningAgentCount(effectiveProjectId) > 0) {
							// Stop PM stream so it does not keep retrying in the same session
							dispatchingAgents.delete(dispatchKey);
							deps.stopPMStream?.();
							return JSON.stringify({
								success: false,
								error: "Another agent is currently running (possibly from automatic code review). Wait for it to complete before dispatching a new write agent.",
							});
						}
						// Block kanban-task dispatch if any task is in review — review must complete first
						// Exception: code-reviewer (for manual review recovery) and ad-hoc dispatches (no kanban_task_id)
						if (args.kanban_task_id && args.agent !== "code-reviewer") {
							const reviewTasks = await db
								.select({ id: kanbanTasks.id, title: kanbanTasks.title })
								.from(kanbanTasks)
								.where(and(eq(kanbanTasks.projectId, effectiveProjectId), eq(kanbanTasks.column, "review")));
							if (reviewTasks.length > 0) {
								dispatchingAgents.delete(dispatchKey);
								return JSON.stringify({
									success: false,
									error: `Cannot dispatch new agent: ${reviewTasks.length} task(s) in review column (${reviewTasks.map(t => t.title).join(", ")}). Wait for code review to complete or spawn review agent if it is not running. Use get_next_task to check the correct next action.`,
								});
							}
						}
						writeAgentRunning = true;
					}

					// Resolve agent display name + enabled status from DB
					const agentRows = await db
						.select({ displayName: agentsTable.displayName, isEnabled: agentsTable.isEnabled, isBuiltin: agentsTable.isBuiltin, availableToPm: agentsTable.availableToPm })
						.from(agentsTable)
						.where(eq(agentsTable.name, args.agent))
						.limit(1);

					if (agentRows.length > 0 && !agentRows[0].isEnabled) {
						dispatchingAgents.delete(dispatchKey);
						if (!isReadOnly) writeAgentRunning = false;
						return JSON.stringify({
							success: false,
							error: `Agent "${args.agent}" is disabled and cannot be dispatched. Enable it in Settings → Agents or choose a different agent.`,
						});
					}

					// Custom agents can be hidden from the PM via "Make Agent Available
					// to PM". Block dispatch in case the PM tries to call it anyway
					// (e.g. from training-data inference rather than the current prompt).
					if (agentRows.length > 0 && agentRows[0].isBuiltin === 0 && agentRows[0].availableToPm === 0) {
						dispatchingAgents.delete(dispatchKey);
						if (!isReadOnly) writeAgentRunning = false;
						return JSON.stringify({
							success: false,
							error: `Agent "${args.agent}" is not available to the PM. Toggle "Make Agent Available to PM" in Settings → Agents to dispatch it.`,
						});
					}

					const displayName = agentRows.length > 0 ? agentRows[0].displayName : args.agent;

					// Move kanban task to working before agent starts
					let taskConversationId: string | null = null;
					if (args.kanban_task_id) {
						try {
							const { moveKanbanTask, getKanbanTask } = await import("../../rpc/kanban");
							const existingTask = await getKanbanTask(args.kanban_task_id);
							if (!existingTask) {
								dispatchingAgents.delete(dispatchKey);
								if (!isReadOnly) writeAgentRunning = false;
								return JSON.stringify({
									success: false,
									error: `Task ID "${args.kanban_task_id}" not found. Use get_next_task or list_tasks to get valid task IDs.`,
								});
							}
							const wasBacklog = existingTask.column === "backlog";
							await moveKanbanTask(args.kanban_task_id, "working");
							const { broadcastToWebview } = await import("../../engine-manager");
							broadcastToWebview("kanbanTaskUpdated", { projectId: effectiveProjectId, taskId: args.kanban_task_id, action: "moved" });

							// Create a dedicated conversation for this task when the setting is on
							// and the task is moving from backlog → working (agent-initiated only).
							if (wasBacklog) {
								const newConvSetting = await getSetting(`project:${effectiveProjectId}:newConvPerTask`, "project");
								if (String(newConvSetting) === "true") {
									const { createConversation } = await import("../../rpc/conversations");
									const taskTitle = existingTask.title ?? `Task ${args.kanban_task_id}`;
									const newConv = await createConversation(effectiveProjectId, taskTitle);
									taskConversationId = newConv.id;
									broadcastToWebview("conversationUpdated", {
										conversationId: newConv.id,
										updatedAt: new Date().toISOString(),
										projectId: effectiveProjectId,
									});
									broadcastToWebview("switchToConversation", {
										conversationId: newConv.id,
										projectId: effectiveProjectId,
									});
									// Tell engine to keep this conv above PM conv in the sidebar
									const { engines } = await import("../../engine-manager");
									const eng = engines.get(effectiveProjectId);
									if (eng) eng.activeAgentConversationId = newConv.id;
								}
							}
						} catch (err) {
							console.warn(`[PM] Failed to move task ${args.kanban_task_id} to working:`, err);
						}
					}

					// For cross-project channel dispatches, create/reuse a Platform - date
					// conversation in the target project so agent streaming appears there.
					// The routing project's conversation keeps PM responses.
					let agentConversationId = taskConversationId ?? deps.conversationId;
					console.log(`[PM run_agent] isChannelConv=${isChannelConversation} isCrossProject=${isCrossProject} routingConv=${deps.conversationId} routingProject=${deps.projectId} effectiveProject=${effectiveProjectId}`);
					if (isChannelConversation && isCrossProject) {
						const { getOrCreateProjectChannelConversation, getChannelPlatform } = await import("../../channels/manager");
						// channelId is always the second segment regardless of ID format
						// (channel:{channelId}:{date} or channel:{channelId}:{projectId}:{date})
						const channelId = deps.conversationId.split(":")[1];
						const platform = getChannelPlatform(channelId) ?? "discord";
						agentConversationId = await getOrCreateProjectChannelConversation(effectiveProjectId, channelId, platform);
						console.log(`[PM run_agent] Cross-project channel conv created: ${agentConversationId} in project ${effectiveProjectId}`);
					}

					// Build project context + workflow instructions if kanban task
					const projectContext = [
						effectiveWorkspacePath ? `Workspace: ${effectiveWorkspacePath}` : "",
						`Project ID: ${effectiveProjectId} (use this for any tool that requires project_id)`,
					].filter(Boolean).join("\n");

					// Append workflow-style instructions when dispatching with a kanban task
					let taskWithInstructions = task;
					if (args.kanban_task_id) {
						const tid = args.kanban_task_id;
						taskWithInstructions = [
							`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
							`  YOUR TASK ID: ${tid}`,
							`  Use ONLY "${tid}" when calling check_criteria, verify_implementation, and move_task.`,
							`  Do NOT use any other task ID — not from context, not from memory.`,
							``,
							`  MANDATORY FIRST STEPS (in order):`,
							`  1. Call get_task(id="${tid}") — get the authoritative acceptance criteria.`,
							`     Do NOT rely on any AC listed below — they may be out of sync.`,
								`  2. Call list_docs(project_id="${effectiveProjectId}"). Scan the returned titles`,
							`     and call get_doc on any document titled "Plan:", "Product Requirements`,
							`     Document", or "PRD" to get the overall picture of the project before`,
							`     doing any work, as subsequent agents will build upon your assigned work/task.`,
							`     If no such document exists in the list, continue with your task.`,
							`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
							``,
							args.task,
							``,
							`The task has already been moved to "working" — do NOT call move_task to working again.`,
							`When implementation is complete:`,
							`1. Use check_criteria with id="${tid}" and ALL indices as an array in ONE call (e.g. criteria_index=[0,1,2]) — never call it one index at a time.`,
							`2. Call verify_implementation with your summary, files changed, and checklist — this is MANDATORY.`,
							`3. verify_implementation will automatically move the task to review on pass.`,
							`Do NOT call move_task to review yourself — it will be rejected. Do NOT call move_task to done — only the review system does that.`,
						].join("\n");
					}

					// For cross-project dispatch (e.g. WhatsApp asking to work on a different project),
					// register the abort controller under effectiveProjectId so that dashboard agent
					// counts, stop-all, and stop-agent-by-name all operate on the correct project.
					const { registerAgentController, unregisterAgentController } = await import("../../engine-manager");
					const registerAbort = isCrossProject
						? (c: AbortController, name: string) => registerAgentController(effectiveProjectId, c, name)
						: (c: AbortController, name: string) => deps.registerAgentAbort?.(c, name);
					const unregisterAbort = isCrossProject
						? (c: AbortController) => unregisterAgentController(effectiveProjectId, c)
						: (c: AbortController) => deps.unregisterAgentAbort?.(c);

					const agentAbort = new AbortController();
					try {
						registerAbort(agentAbort, args.agent);
					} catch (err) {
						// Registration failed — clear dispatch guard and bail
						dispatchingAgents.delete(dispatchKey);
						if (!isReadOnly) writeAgentRunning = false;
						throw err;
					}

					// Dispatch agent asynchronously — PM stops and agent runs independently.
					// When agent completes, onAgentDone restarts PM with the result.
					const agentOpts = {
						conversationId: agentConversationId,
						agentName: args.agent,
						agentDisplayName: displayName,
						task: taskWithInstructions,
						projectContext,
						providerConfig: deps.providerConfig,
						kanbanTaskId: args.kanban_task_id,
						abortSignal: agentAbort.signal,
						callbacks: deps.inlineAgentCallbacks,
						workspacePath: effectiveWorkspacePath,
						projectId: effectiveProjectId,
						// In plan mode all agents get read-only tools regardless of their type.
						readOnly: deps.planMode || isReadOnly,
					};

					// Fire-and-forget: agent runs in background
					runInlineAgent(agentOpts).then(async (result) => {
						// Clear the task conv pin now that the agent has finished
						const { engines: enginesMap } = await import("../../engine-manager");
						const doneEng = enginesMap.get(effectiveProjectId);
						if (doneEng && doneEng.activeAgentConversationId === agentConversationId) {
							doneEng.activeAgentConversationId = null;
						}
						dispatchingAgents.delete(dispatchKey);
						if (!isReadOnly) writeAgentRunning = false;
						unregisterAbort(agentAbort);

						// Auto-mark todo item done on successful completion
						if (result.status === "completed") {
							if (args.todo_list_id && args.todo_item_id) {
								await autoMarkTodoDone(deps.conversationId, args.todo_list_id, args.todo_item_id, deps.emitNewMessage);
							} else {
								// LLM didn't pass todo_list_id — auto-advance first pending item in active list
								await autoAdvanceTodo(deps.conversationId, deps.emitNewMessage);
							}
						}

						// Generate handoff summary
						let handoffSummary = "";
						if (result.filesModified.length > 0) {
							try {
								const { generateHandoffSummary } = await import("../handoff");
								handoffSummary = await generateHandoffSummary(result.filesModified);
							} catch { /* non-fatal */ }
						}

						// Store handoff as kanban task note
						if (args.kanban_task_id && handoffSummary) {
							try {
								const { updateKanbanTask } = await import("../../rpc/kanban");
								await updateKanbanTask({
									id: args.kanban_task_id,
									importantNotes: `## Handoff Summary\n${handoffSummary}`,
								});
							} catch { /* non-fatal */ }
						}

						// Move kanban task based on agent result
						if (args.kanban_task_id) {
							try {
								const { moveKanbanTask, getKanbanTask } = await import("../../rpc/kanban");
								if (result.status === "completed") {
									// Only move to review if verify_implementation was called and passed.
									// If agent skipped verification, leave in working.
									const task = await getKanbanTask(args.kanban_task_id);
									if (task?.verificationStatus === "passed" && task?.column === "working") {
										// Auto-commit before review so reviewer can see git diff
										const { autoCommitTask } = await import("../review-cycle");
										await autoCommitTask(effectiveProjectId, args.kanban_task_id, task.title);
										await moveKanbanTask(args.kanban_task_id, "review");
										const { notifyTaskInReview } = await import("../review-cycle");
										notifyTaskInReview(effectiveProjectId, args.kanban_task_id);
									} else if (task?.column === "review") {
										// Already in review (verify_implementation moved it)
										const { notifyTaskInReview } = await import("../review-cycle");
										notifyTaskInReview(effectiveProjectId, args.kanban_task_id);
									} else if (task?.column === "working" && task?.verificationStatus !== "passed") {
										// Agent completed but didn't call verify_implementation.
										// Append error to result so PM knows to re-dispatch.
										result.summary += "\n\n⚠️ AGENT DID NOT CALL verify_implementation. Task remains in working. Re-dispatch the same agent with explicit instructions to call verify_implementation before finishing.";
									}
								} else if (result.status !== "cancelled") {
									await moveKanbanTask(args.kanban_task_id, "backlog");
								}
							} catch { /* non-fatal */ }
						}

						// Between-task hygiene: trim the just-finished sub-agent's verbose
						// tool outputs once past ~60% so they don't bloat the PM context.
						// This is NOT conversation compaction — full summarization is owned
						// solely by the engine's next-turn check, which fires at 100% of the
						// Context Window Limit (the bar reaches the top before it compacts).
						try {
							const { getDefaultModel } = await import("../../providers/models");
							const modelId = deps.providerConfig.defaultModel ?? getDefaultModel(deps.providerConfig.providerType);
							const ctx = await buildContext({
								conversationId: deps.conversationId,
								systemPrompt: "",
								constitution: "",
								modelId,
							});
							if (ctx.utilizationPercent >= 60 && result.messageIds.length > 0) {
								const pruneCount = await pruneAgentToolResults(result.messageIds);
								if (pruneCount > 0) console.log(`[PM] Pruned ${pruneCount} tool outputs after ${displayName} (context at ${ctx.utilizationPercent}%)`);
							}
						} catch { /* non-fatal */ }

						// Code-level plan approval enforcement:
						// If task-planner just completed for an in-app conversation and
						// has pending task definitions, auto-show the approval card here
						// regardless of whether the PM LLM calls request_plan_approval.
						// This prevents the PM from presenting approval as plain text.
						if (
							args.agent === "task-planner" &&
							result.status === "completed" &&
							!isChannelConversation
						) {
							try {
								const { peekTaskDefinitions } = await import("./planning");
								const pendingDefs = peekTaskDefinitions(effectiveProjectId);
								// Guard: if active kanban tasks already exist (backlog/working/review),
								// the plan was already approved — do NOT show the approval card again.
								// This prevents a spurious re-plan (task-planner called by mistake)
								// from interrupting an in-progress workflow.
								const hasActiveTasks = effectiveProjectId
									? (await db.select({ id: kanbanTasks.id, column: kanbanTasks.column })
											.from(kanbanTasks)
											.where(eq(kanbanTasks.projectId, effectiveProjectId)))
										.some(t => t.column !== "done")
									: false;
								if (pendingDefs && pendingDefs.length > 0 && !hasActiveTasks) {
									const recentNotes = await getProjectNotes(effectiveProjectId);
									const planDoc = recentNotes[0];
									if (planDoc?.content?.trim()) {
										const { broadcastToWebview } = await import("../../engine-manager");
										const planTitle = planDoc.title ?? "Implementation Plan";
										const planContent = planDoc.content;
										const planMessageId = crypto.randomUUID();
										const planMetadata = JSON.stringify({
											type: "plan",
											title: planTitle,
											projectId: effectiveProjectId,
											conversationId: deps.conversationId,
										});

										// Persist plan message so it survives page refresh
										await db.insert(messages).values({
											id: planMessageId,
											conversationId: deps.conversationId,
											role: "assistant",
											agentId: "task-planner",
											content: planContent,
											metadata: planMetadata,
											tokenCount: 0,
											createdAt: new Date().toISOString(),
										});

										deps.emitNewMessage({
											messageId: planMessageId,
											agentId: "task-planner",
											agentName: "Task Planner",
											content: planContent,
											metadata: planMetadata,
										});

										broadcastToWebview("planPresented", {
											projectId: effectiveProjectId,
											conversationId: deps.conversationId,
											plan: { title: planTitle, content: planContent },
										});

										// Save a context message to the DB so PM has the note_id
										// available when it restarts on the user's "approve" reply.
										// We do NOT call onAgentDone here — that would immediately
										// restart PM which (especially in production) causes a second
										// task-planner dispatch before the user can even see the card.
										// PM restarts naturally when the user sends "approve"/"reject",
										// at which point this message is already in its history.
										await db.insert(messages).values({
											id: crypto.randomUUID(),
											conversationId: deps.conversationId,
											role: "assistant",
											agentId: "project-manager",
											content:
												`[Task Planner Report] Plan document created. ` +
												`Approval card shown to user (plan_note_id: ${planDoc.id}). ` +
												`When user says "approve": call create_tasks_from_plan (no note_id needed). ` +
												`When user says "reject": re-run task-planner with their feedback.`,
											metadata: JSON.stringify({ type: "agent_report" }),
											tokenCount: 0,
											createdAt: new Date().toISOString(),
										});

										return; // do NOT call onAgentDone — PM waits for user input
									}
								}
							} catch { /* non-fatal — fall through to normal onAgentDone */ }
						}

						// Restart PM with agent result (skip if agent was cancelled by user)
						if (result.status !== "cancelled") {
							deps.onAgentDone?.(args.agent, displayName, {
								status: result.status,
								summary: result.summary,
								filesModified: result.filesModified,
							});
						}
					}).catch((err) => {
						dispatchingAgents.delete(dispatchKey);
						if (!isReadOnly) writeAgentRunning = false;
						unregisterAbort(agentAbort);

						// Don't restart PM if the agent was aborted by user (stop button)
						const isAbort = err instanceof Error &&
							(err.name === "AbortError" || err.message.includes("abort") || err.message.includes("cancel"));
						if (isAbort) return;

						// Move task to backlog on error
						if (args.kanban_task_id) {
							import("../../rpc/kanban").then(({ moveKanbanTask }) =>
								moveKanbanTask(args.kanban_task_id ?? "", "backlog").catch(() => { /* empty */ }));
						}

						const message = err instanceof Error ? err.message : String(err);
						deps.onAgentDone?.(args.agent, displayName, {
							status: "failed",
							summary: `Agent failed: ${message}`,
							filesModified: [],
						});
					});
					// Dispatch launched: the .then/.catch chain above now owns guard cleanup,
					// so the outer catch must NOT touch the guards from here on.
					dispatchInitiated = true;

					// Stop PM stream — PM is done until agent completes
					deps.stopPMStream?.();

					return JSON.stringify({
						success: true,
						agent: displayName,
						status: "dispatched",
						message: `${displayName} is now working on the task. I'll update you when it's done.`,
					});
				} catch (err) {
					// A throw on the synchronous dispatch path lands here. If dispatch never
					// launched, release the write-agent/dispatch guards — otherwise they stay
					// held for the engine's lifetime and deadlock all future write dispatch.
					// If dispatch DID launch, its .then/.catch chain owns cleanup; don't touch.
					if (!dispatchInitiated) releaseGuards?.();
					// Move kanban task to backlog on unexpected error
					if (args.kanban_task_id) {
						try {
							const { moveKanbanTask } = await import("../../rpc/kanban");
							await moveKanbanTask(args.kanban_task_id, "backlog");
						} catch { /* non-fatal */ }
					}
					if (err instanceof DOMException && err.name === "AbortError") throw err;
					if (err instanceof Error && err.name === "AbortError") throw err;
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),

		run_agents_parallel: tool({
			description:
				`Run multiple READ-ONLY agents concurrently for exploration or research. These agents can only read files, search, and browse — no file writes. Use when you need to gather information from multiple areas before planning. Only these agents are allowed: ${[...READ_ONLY_AGENTS].join(", ")}.`,
			inputSchema: z.object({
				tasks: z.array(z.object({
					agent: z.string().describe(`Read-only agent type. Must be one of: ${[...READ_ONLY_AGENTS].join(", ")}`),
					task: z.string().describe("Exploration/research task description"),
				})).min(1).max(5),
			}),
			execute: async (args) => {
				try {
					// Validate all agents are read-only
					const invalidAgents = args.tasks.filter(t => !READ_ONLY_AGENTS.has(t.agent)).map(t => t.agent);
					if (invalidAgents.length > 0) {
						return JSON.stringify({
							success: false,
							error: `run_agents_parallel only accepts read-only agents (${[...READ_ONLY_AGENTS].join(", ")}). ` +
								`These agents are write-capable and must use run_agent instead: ${invalidAgents.join(", ")}`,
						});
					}

					const projectContext = deps.workspacePath ? `Workspace: ${deps.workspacePath}` : "";

					// Run all read-only agents in parallel (no concurrency limit for read-only)
					const allResults = await Promise.allSettled(
						args.tasks.map(async (t, i) => {
							// Stagger starts to avoid overwhelming the provider with simultaneous requests
							if (i > 0) await new Promise(r => setTimeout(r, i * 1500));
							const agentRows = await db
								.select({ displayName: agentsTable.displayName, isEnabled: agentsTable.isEnabled })
								.from(agentsTable)
								.where(eq(agentsTable.name, t.agent))
								.limit(1);

							if (agentRows.length > 0 && !agentRows[0].isEnabled) {
								throw new Error(`Agent "${t.agent}" is disabled and cannot be dispatched. Enable it in Settings → Agents or choose a different agent.`);
							}

							const displayName = agentRows.length > 0 ? agentRows[0].displayName : t.agent;

							const agentAbort = new AbortController();
							deps.registerAgentAbort?.(agentAbort, t.agent);
							try {
								return await runInlineAgent({
									conversationId: deps.conversationId,
									agentName: t.agent,
									agentDisplayName: displayName,
									task: t.task,
									projectContext,
									providerConfig: deps.providerConfig,
									abortSignal: agentAbort.signal,
									callbacks: deps.inlineAgentCallbacks,
									workspacePath: deps.workspacePath,
									projectId: deps.projectId,
									readOnly: true,
								});
							} finally {
								deps.unregisterAgentAbort?.(agentAbort);
							}
						}),
					);

					const summaries = allResults.map((r, i) => ({
						agent: args.tasks[i].agent,
						task: args.tasks[i].task,
						status: r.status === "fulfilled" ? r.value.status : "failed",
						summary: r.status === "fulfilled" ? r.value.summary : (r.reason?.message ?? "Unknown error"),
					}));

					return JSON.stringify({ success: true, results: summaries });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		verify_project: tool({
			description:
				"Verify project integrity: check that the entry point file exists, trace all imports/script references, and report any missing files. Run this after completing tasks to ensure the project works.",
			inputSchema: z.object({
				entry_point: z.string().describe("Main entry file relative to workspace (e.g., index.html, src/main.ts)"),
			}),
			execute: async (args) => {
				try {
					const { resolve, dirname, extname } = await import("node:path");

					const wsPath = deps.workspacePath ?? ".";
					const entryPath = resolve(wsPath, args.entry_point);

					if (!(await Bun.file(entryPath).exists())) {
						return JSON.stringify({ valid: false, issues: [`Entry point not found: ${args.entry_point}`], filesChecked: 0 });
					}

					const issues: string[] = [];
					const checked = new Set<string>();

					async function checkFile(filePath: string, fromFile: string): Promise<void> {
						if (checked.has(filePath)) return;
						checked.add(filePath);

						const file = Bun.file(filePath);
						if (!(await file.exists())) {
							issues.push(`Missing: ${filePath} (referenced from ${fromFile})`);
							return;
						}

						const ext = extname(filePath).toLowerCase();
						if (![".html", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".css"].includes(ext)) return;

						let content: string;
						try { content = await file.text(); }
						catch { return; }

						const dir = dirname(filePath);
						const refs: string[] = [];

						if (ext === ".html") {
							// script src, link href, img src
							const srcRe = /(?:src|href)=["']([^"']+)["']/g;
							let m: RegExpExecArray | null;
							while ((m = srcRe.exec(content)) !== null) {
								const ref = m[1];
								if (ref.startsWith("http") || ref.startsWith("//") || ref.startsWith("data:") || ref.startsWith("#")) continue;
								refs.push(resolve(dir, ref));
							}
						} else if ([".js", ".ts", ".jsx", ".tsx", ".mjs"].includes(ext)) {
							// import/require
							const importRe = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
							let m: RegExpExecArray | null;
							while ((m = importRe.exec(content)) !== null) {
								const ref = m[1];
								if (!ref.startsWith(".")) continue; // skip node_modules
								let resolved = resolve(dir, ref);
								if (!(await Bun.file(resolved).exists())) {
									// Try common extensions
									const tryExts = [".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.js"];
									for (const e of tryExts) {
										if (await Bun.file(resolved + e).exists()) {
											resolved = resolved + e;
											break;
										}
									}
								}
								refs.push(resolved);
							}
						} else if (ext === ".css") {
							const importRe = /@import\s+(?:url\()?['"]([^'"]+)['"]\)?/g;
							let m: RegExpExecArray | null;
							while ((m = importRe.exec(content)) !== null) {
								const ref = m[1];
								if (ref.startsWith("http")) continue;
								refs.push(resolve(dir, ref));
							}
						}

						await Promise.all(refs.map((r) => checkFile(r, filePath)));
					}

					await checkFile(entryPath, "(entry)");

					return JSON.stringify({
						valid: issues.length === 0,
						issues,
						filesChecked: checked.size,
					});
				} catch (err) {
					return JSON.stringify({ valid: false, issues: [err instanceof Error ? err.message : String(err)], filesChecked: 0 });
				}
			},
		}),


		create_project: tool({
			description:
				"Create a new project. The workspace folder is auto-created under the global workspace path. Use this when the user asks to create a new project, including from channels.",
			inputSchema: z.object({
				name: z.string().describe("The project name"),
				description: z.string().optional().describe("Optional project description"),
				github_url: z.string().optional().describe("Optional GitHub repository URL"),
				working_branch: z.string().optional().describe("Optional git branch name (default: main)"),
			}),
			execute: async (args) => {
				try {
					const result = await createProjectHandler({
						name: args.name,
						description: args.description,
						githubUrl: args.github_url,
						workingBranch: args.working_branch,
					});
					return JSON.stringify(result);
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),

		list_projects: tool({
			description:
				"List all projects. Use when the user asks about existing projects or you need to find a project by name.",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					const projects = await getProjectsList();
					return JSON.stringify({ success: true, projects });
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),

		search_projects: tool({
			description:
				"Fuzzy-search projects by name. Returns the closest matches. Use when the user mentions a project name that might not be exact.",
			inputSchema: z.object({
				query: z.string().describe("The search query — will be matched against project names"),
			}),
			execute: async (args) => {
				try {
					const allProjects = await getProjectsList();
					const query = args.query.toLowerCase();
					const scored = allProjects
						.map((p) => {
							const name = p.name.toLowerCase();
							const desc = (p.description ?? "").toLowerCase();
							let score = 0;
							// Name matches score higher than description matches
							if (name === query) score = 100;
							else if (name.includes(query)) score = 80;
							else if (query.includes(name)) score = 60;
							else if (desc.includes(query)) score = 40;
							else {
								// Word-level overlap scoring (name + description)
								const words = query.split(/\s+/);
								for (const w of words) {
									if (name.includes(w)) score += 20;
									else if (desc.includes(w)) score += 10;
								}
							}
							return { ...p, score };
						})
						.filter((p) => p.score > 0)
						.sort((a, b) => b.score - a.score)
						.slice(0, 5);
					return JSON.stringify({ success: true, matches: scored });
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),

		// -----------------------------------------------------------------
		// Conversation management
		// -----------------------------------------------------------------

		list_conversations: tool({
			description:
				"List all conversations for the current project. Returns id, title, updatedAt, and isPinned for each conversation.",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					const convs = await getConversations(deps.projectId);
					return JSON.stringify({ success: true, conversations: convs, count: convs.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		create_conversation: tool({
			description:
				"Create a new conversation in the current project. Returns the new conversation ID. " +
				"Only call this when explicitly asked by the user — do NOT create conversations speculatively.",
			inputSchema: z.object({
				title: z.string().min(1).describe("Descriptive title for the conversation (required)."),
			}),
			execute: async (args) => {
				try {
					const result = await createConversation(deps.projectId, args.title);
					return JSON.stringify({ success: true, ...result });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		search_conversations: tool({
			description:
				"Search across all conversation messages in the current project. " +
				"Finds messages containing the query text and returns matching conversations with snippets. " +
				"Useful for finding past discussions, decisions, or user requests across channels.",
			inputSchema: z.object({
				query: z.string().describe("Text to search for in conversation messages."),
				limit: z.number().optional().default(20).describe("Max results to return (default 20)."),
			}),
			execute: async (args) => {
				try {
					const { sqlite: sqliteConn } = await import("../../db/connection");
					// FTS5 search with fallback to LIKE
					let rows: Array<{ id: string; conversation_id: string; role: string; content: string; created_at: string; title: string }>;
					try {
						rows = sqliteConn.prepare(
							`SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title
							 FROM messages m
							 JOIN messages_fts f ON m.rowid = f.rowid
							 JOIN conversations c ON m.conversation_id = c.id
							 WHERE messages_fts MATCH ?1 AND c.project_id = ?2
							 ORDER BY rank
							 LIMIT ?3`
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						).all(args.query, deps.projectId, args.limit ?? 20) as any;
					} catch {
						rows = sqliteConn.prepare(
							`SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title
							 FROM messages m
							 JOIN conversations c ON m.conversation_id = c.id
							 WHERE c.project_id = ?1 AND m.content LIKE '%' || ?2 || '%'
							 ORDER BY m.created_at
							 LIMIT ?3`
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						).all(deps.projectId, args.query, args.limit ?? 20) as any;
					}

					const results = rows.map((r) => ({
						conversationId: r.conversation_id,
						conversationTitle: r.title,
						messageId: r.id,
						role: r.role,
						snippet: r.content.slice(0, 300) + (r.content.length > 300 ? "..." : ""),
						createdAt: r.created_at,
					}));

					return JSON.stringify({ success: true, results, count: results.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		delete_conversation: tool({
			description:
				"Delete a conversation and all its messages. This is irreversible.",
			inputSchema: z.object({
				conversation_id: z.string().describe("The ID of the conversation to delete."),
			}),
			execute: async (args) => {
				try {
					await deleteConversation(args.conversation_id);
					return JSON.stringify({ success: true });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		get_conversation_messages: tool({
			description:
				"Get messages from a conversation. Returns the most recent messages (up to limit). " +
				"Useful for reviewing what was discussed in a conversation, especially when users communicate via channels like WhatsApp or Discord.",
			inputSchema: z.object({
				conversation_id: z.string().describe("The conversation ID to fetch messages from. Use list_conversations to find IDs."),
				limit: z.number().optional().default(50).describe("Max messages to return (default 50)."),
			}),
			execute: async (args) => {
				try {
					const msgs = await getMessages(args.conversation_id, args.limit);
					return JSON.stringify({
						success: true,
						messages: msgs.map((m) => ({
							id: m.id,
							role: m.role,
							agentId: m.agentId,
							content: m.content?.slice(0, 2000) + (m.content && m.content.length > 2000 ? "... (truncated)" : ""),
							createdAt: m.createdAt,
						})),
						count: msgs.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		search_conversation_messages: tool({
			description:
				"Search for messages within a specific conversation by text query. " +
				"If no conversation_id is provided, searches the current active conversation. " +
				"Useful for finding specific discussions, decisions, or code references within a conversation.",
			inputSchema: z.object({
				query: z.string().describe("Text to search for in messages."),
				conversation_id: z.string().optional().describe("Conversation ID to search in. Omit to search the current active conversation."),
				limit: z.number().optional().default(20).describe("Max results to return (default 20)."),
			}),
			execute: async (args) => {
				try {
					const targetConvId = args.conversation_id || deps.conversationId;
					const { sqlite: sqliteConn } = await import("../../db/connection");
					// FTS5 search with fallback to LIKE
					let rows: Array<{ id: string; role: string; agent_id: string | null; content: string; created_at: string }>;
					try {
						rows = sqliteConn.prepare(
							`SELECT m.id, m.role, m.agent_id, m.content, m.created_at
							 FROM messages m
							 JOIN messages_fts f ON m.rowid = f.rowid
							 WHERE messages_fts MATCH ?1 AND f.conversation_id = ?2
							 ORDER BY rank
							 LIMIT ?3`
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						).all(args.query, targetConvId, args.limit ?? 20) as any;
					} catch {
						rows = sqliteConn.prepare(
							`SELECT id, role, agent_id, content, created_at
							 FROM messages
							 WHERE conversation_id = ?1 AND content LIKE '%' || ?2 || '%'
							 ORDER BY created_at
							 LIMIT ?3`
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						).all(targetConvId, args.query, args.limit ?? 20) as any;
					}

					const results = rows.map((r) => ({
						id: r.id,
						role: r.role,
						agentId: r.agent_id,
						snippet: r.content.slice(0, 500) + (r.content.length > 500 ? "..." : ""),
						createdAt: r.created_at,
					}));

					return JSON.stringify({ success: true, conversationId: targetConvId, results, count: results.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Inbox
		// -----------------------------------------------------------------

		get_inbox_messages: tool({
			description:
				"Get inbox messages for the current project. Shows messages from all channels (chat, WhatsApp, Discord, email). " +
				"Useful for seeing what users have sent, especially from external channels.",
			inputSchema: z.object({
				unread_only: z.boolean().optional().default(false).describe("If true, return only unread messages."),
				limit: z.number().optional().default(30).describe("Max messages to return (default 30)."),
			}),
			execute: async (args) => {
				try {
					const msgs = await getInboxMessages({
						projectId: deps.projectId,
						isRead: args.unread_only ? false : undefined,
						limit: args.limit,
					});
					return JSON.stringify({
						success: true,
						messages: msgs.map((m) => ({
							id: m.id,
							sender: m.sender,
							content: m.content?.slice(0, 1000),
							platform: m.platform,
							channelId: m.channelId,
							isRead: m.isRead,
							createdAt: m.createdAt,
						})),
						count: msgs.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		search_inbox: tool({
			description: "Search inbox messages by text query. Searches across sender, content, and subject fields.",
			inputSchema: z.object({
				query: z.string().describe("Search query to find in inbox messages."),
			}),
			execute: async (args) => {
				try {
					const msgs = await searchInboxMessages(args.query, deps.projectId);
					return JSON.stringify({
						success: true,
						messages: msgs.map((m) => ({
							id: m.id,
							sender: m.sender,
							content: m.content?.slice(0, 1000),
							platform: m.platform,
							isRead: m.isRead,
							createdAt: m.createdAt,
						})),
						count: msgs.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Settings (read-only)
		// -----------------------------------------------------------------

		get_settings: tool({
			description:
				"Read global or project settings (read-only). Returns key-value pairs. " +
				"Categories: 'general', 'providers', 'channels'. " +
				"For project-specific settings, keys are prefixed with 'project:<projectId>:'.",
			inputSchema: z.object({
				category: z.string().optional().describe("Filter by category (e.g. 'general', 'providers'). Omit to get all settings."),
			}),
			execute: async (args) => {
				try {
					const result = await getSettings(args.category);
					// Filter out sensitive keys (API keys, tokens)
					const safe: Record<string, unknown> = {};
					for (const [key, value] of Object.entries(result)) {
						if (/apiKey|api_key|token|secret|password/i.test(key)) {
							safe[key] = "[REDACTED]";
						} else {
							safe[key] = value;
						}
					}
					return JSON.stringify({ success: true, settings: safe });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		get_setting: tool({
			description: "Read a single setting by key (read-only). Returns the value or null if not found.",
			inputSchema: z.object({
				key: z.string().describe("The setting key to look up."),
			}),
			execute: async (args) => {
				try {
					// Block sensitive keys
					if (/apiKey|api_key|token|secret|password/i.test(args.key)) {
						return JSON.stringify({ success: true, value: "[REDACTED]" });
					}
					const value = await getSetting(args.key);
					return JSON.stringify({ success: true, key: args.key, value });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Docs (direct access — no delegation needed)
		// -----------------------------------------------------------------

		list_docs: tool({
			description:
				"List all documents in the current project. Returns id, title, authorAgentId, and updatedAt.",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					const rows = await getProjectNotes(deps.projectId);
					return JSON.stringify({
						success: true,
						notes: rows.map((n) => ({
							id: n.id,
							title: n.title,
							authorAgentId: n.authorAgentId,
							updatedAt: n.updatedAt,
						})),
						count: rows.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		get_doc: tool({
			description: "Get the full content of a document by its ID.",
			inputSchema: z.object({
				doc_id: z.string().describe("The document ID."),
			}),
			execute: async (args) => {
				try {
					const note = await getNote(args.doc_id);
					if (!note) return JSON.stringify({ success: false, error: "Document not found." });
					return JSON.stringify({
						success: true,
						note: {
							id: note.id,
							title: note.title,
							content: note.content.slice(0, 5000) + (note.content.length > 5000 ? "... (truncated)" : ""),
							authorAgentId: note.authorAgentId,
							updatedAt: note.updatedAt,
						},
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		search_docs: tool({
			description: "Search documents by title or content within the current project.",
			inputSchema: z.object({
				query: z.string().describe("Text to search for in document titles and content."),
			}),
			execute: async (args) => {
				try {
					const rows = await searchNotes(deps.projectId, args.query);
					return JSON.stringify({
						success: true,
						notes: rows.map((n) => ({
							id: n.id,
							title: n.title,
							snippet: n.content.slice(0, 300) + (n.content.length > 300 ? "..." : ""),
							authorAgentId: n.authorAgentId,
							updatedAt: n.updatedAt,
						})),
						count: rows.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		create_doc: tool({
			description:
				"Create a new document in the current project. Use for documenting decisions, plans, meeting summaries, or any persistent information.",
			inputSchema: z.object({
				title: z.string().describe("Document title."),
				content: z.string().describe("Document content (markdown supported)."),
			}),
			execute: async (args) => {
				try {
					const result = await createNote({
						projectId: deps.projectId,
						title: args.title,
						content: args.content,
						authorAgentId: "project-manager",
					});
					return JSON.stringify({ success: true, noteId: result.id });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		update_doc: tool({
			description:
				"Update an existing document's title or content. Use get_doc first to read current content if you need to append.",
			inputSchema: z.object({
				doc_id: z.string().describe("The document ID to update."),
				title: z.string().optional().describe("New title (omit to keep current)."),
				content: z.string().optional().describe("New content (omit to keep current)."),
			}),
			execute: async (args) => {
				try {
					await updateNote({ id: args.doc_id, title: args.title, content: args.content });
					return JSON.stringify({ success: true });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Kanban stats
		// -----------------------------------------------------------------

		get_project_stats: tool({
			description:
				"Get kanban task counts and active agent info for any project by ID. " +
				"Useful when you need a quick overview of a project other than the current one.",
			inputSchema: z.object({
				project_id: z.string().describe("The project UUID. Use list_projects or search_projects to find it."),
			}),
			execute: async (args) => {
				try {
					const projectRow = await db
						.select({ name: projectsTable.name, description: projectsTable.description, status: projectsTable.status, workspacePath: projectsTable.workspacePath })
						.from(projectsTable).where(eq(projectsTable.id, args.project_id)).limit(1);
					if (!projectRow.length) return JSON.stringify({ success: false, error: "Project not found" });

					const tasks = await db.select({ column: kanbanTasks.column, priority: kanbanTasks.priority })
						.from(kanbanTasks).where(eq(kanbanTasks.projectId, args.project_id));

					const columns: Record<string, number> = { backlog: 0, working: 0, review: 0, done: 0 };
					const priorities: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
					for (const t of tasks) {
						columns[t.column] = (columns[t.column] ?? 0) + 1;
						priorities[t.priority] = (priorities[t.priority] ?? 0) + 1;
					}

					return JSON.stringify({ success: true, project: projectRow[0], kanban: { total: tasks.length, columns, priorities } });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		get_kanban_stats: tool({
			description:
				"Get a quick summary of kanban board stats: task counts per column, priority breakdown, and blocked tasks. " +
				"Faster than list_tasks when you just need an overview.",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					const tasks = await db
						.select({
							column: kanbanTasks.column,
							priority: kanbanTasks.priority,
							blockedBy: kanbanTasks.blockedBy,
							assignedAgentId: kanbanTasks.assignedAgentId,
						})
						.from(kanbanTasks)
						.where(eq(kanbanTasks.projectId, deps.projectId));

					const columns: Record<string, number> = { backlog: 0, working: 0, review: 0, done: 0 };
					const priorities: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
					let blocked = 0;
					let assigned = 0;

					for (const t of tasks) {
						columns[t.column] = (columns[t.column] ?? 0) + 1;
						priorities[t.priority] = (priorities[t.priority] ?? 0) + 1;
						if (t.blockedBy) {
							try {
								const deps = JSON.parse(t.blockedBy);
								if (Array.isArray(deps) && deps.length > 0) blocked++;
							} catch { /* empty */ }
						}
						if (t.assignedAgentId) assigned++;
					}

					return JSON.stringify({
						success: true,
						total: tasks.length,
						columns,
						priorities,
						blocked,
						assigned,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Plan approval + kanban task creation
		// -----------------------------------------------------------------

		request_plan_approval: tool({
			description:
				"Present a plan to the user for approval. Call this AFTER the task-planner has finished " +
				"defining tasks via define_tasks. For in-app conversations this shows an approval card in the UI. " +
				"For channel conversations (WhatsApp/Discord/Email) the plan is sent as a text message to the channel " +
				"and you wait for the user's reply ('approve'/'reject'). " +
				"Include a summary of the planned tasks so the user can make an informed decision.",
			inputSchema: z.object({
				title: z.string().describe("Short title for the plan, e.g. 'Implementation Plan for Feature X'"),
				summary: z.string().describe("Markdown summary of the plan — task count, phases, key decisions."),
			}),
			execute: async ({ title, summary }) => {
				try {
					// Use the plan document that the task-planner just saved to the Docs tab
					// (via create_doc) as the approval card content. This is the full markdown
					// plan the user expects to see — not a PM-written summary.
					// Fall back to the PM's summary if no doc was created (e.g. simple plans
					// where the task-planner skipped document creation).
					const recentNotes = await getProjectNotes(deps.projectId);
					const planDoc = recentNotes[0]; // most recently created/updated note
					const planContent = planDoc?.content?.trim() ? planDoc.content : summary;

					const isChannelConversation = deps.conversationId.startsWith("channel:");

					if (isChannelConversation) {
						// For channel conversations: send the plan as a text message to the channel
						// so the user can read and approve it directly in WhatsApp/Discord/Email.
						// Derive channelId from conversationId (format: "channel:<channelId>" or
						// "channel:<channelId>:thread:<threadId>") — more reliable than activeMetadata
						// which resets to DEFAULT when PM restarts after an agent completes.
						const metaChannelId = deps.getActiveMetadata?.()?.channelId;
						const derivedChannelId = deps.conversationId.split(":")[1]; // always second segment
						const channelId = metaChannelId ?? derivedChannelId;
						if (channelId) {
							const { sendChannelMessage } = await import("../../channels/manager");
							const { chunkMessage } = await import("../../channels/chunker");
							const planText = `📋 *${title}*\n\n${planContent}\n\nReply *approve* to start implementation, or *reject* to cancel.`;
							for (const chunk of chunkMessage(planText)) {
								await sendChannelMessage(channelId, chunk).catch(() => {});
							}
						}

						// Stop PM stream — wait for user's approve/reject reply in the channel
						deps.stopPMStream?.();

						return JSON.stringify({
							success: true,
							message: "Plan sent to channel. Waiting for user's 'approve' or 'reject' reply. When approved, call create_tasks_from_plan.",
						});
					}

					// In-app: guard against the PM calling this concurrently with run_agent("task-planner").
					// In production, Vercel AI SDK executes parallel tool calls from a single LLM step
					// via Promise.all, so request_plan_approval can fire while task-planner is still
					// running. The code-level enforcement in run_agent's .then() already shows the
					// card reliably once task-planner completes — block the early/duplicate call here.
					const taskPlannerKey = `${deps.projectId}:task-planner`;
					{
						const { getRunningAgentNames } = await import("../../engine-manager");
						const isRunning = getRunningAgentNames(deps.projectId).includes("task-planner");
						const isDispatching = dispatchingAgents.has(taskPlannerKey);
						if (isRunning || isDispatching) {
							// Don't show the card yet — the .then() handler will do it once task-planner finishes.
							return JSON.stringify({
								success: false,
								message: "task-planner is still running. The approval card will appear automatically when it completes. Do not call request_plan_approval again — wait for the task-planner result.",
							});
						}
					}

					// In-app: show approval card in the UI
					const { broadcastToWebview } = await import("../../engine-manager");
					const planMessageId = crypto.randomUUID();
					const metadata = JSON.stringify({ type: "plan", title, projectId: deps.projectId, conversationId: deps.conversationId });

					// Persist plan message to DB so it survives page refresh
					await db.insert(messages).values({
						id: planMessageId,
						conversationId: deps.conversationId,
						role: "assistant",
						agentId: "task-planner",
						content: planContent,
						metadata,
						tokenCount: 0,
						createdAt: new Date().toISOString(),
					});

					// Notify frontend via newMessage (gives it the real UUID + persisted data)
					deps.emitNewMessage({ messageId: planMessageId, agentId: "task-planner", agentName: "Task Planner", content: planContent, metadata });

					// Broadcast planPresented so the frontend shows the approval card
					broadcastToWebview("planPresented", {
						projectId: deps.projectId,
						conversationId: deps.conversationId,
						plan: { title, content: planContent },
					});

					// Stop PM stream — wait for user's approve/reject
					deps.stopPMStream?.();

					return JSON.stringify({
						success: true,
						noteId: planDoc?.id ?? null,
						message: `Plan presented to user for approval. Waiting for response. When the user approves, call create_tasks_from_plan (no arguments needed for in-app conversations).`,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		create_tasks_from_plan: tool({
			description:
				"Create kanban tasks from an approved plan. Uses the task definitions already stored by the " +
				"task-planner's define_tasks calls during planning. Call this immediately after the user approves the plan.",
			inputSchema: z.object({
				project_id: z.string().optional().describe(
					"Target project ID. Required when working from a channel (WhatsApp/Discord/Email). Omit for in-app conversations.",
				),
			}),
			execute: async ({ project_id }) => {
				try {
					const isChannelConv = deps.conversationId.startsWith("channel:");
					if (isChannelConv && !project_id) {
						return JSON.stringify({
							success: false,
							error: "project_id is required when creating tasks from a channel conversation.",
						});
					}

					const effectiveProjId = project_id ?? deps.projectId;
					const { drainTaskDefinitions } = await import("./planning");

					// Use the task definitions already stored by the task-planner's define_tasks
					// calls during the planning phase. Do NOT re-run task-planner here — a second
					// inline run is unreliable (LLM truncates the list, only returns partial tasks)
					// and duplicates work that was already done correctly during planning.
					const defs = drainTaskDefinitions(effectiveProjId);
					if (!defs || defs.length === 0) {
						return JSON.stringify({ success: false, error: `No task definitions found for project ${effectiveProjId}. The task-planner must call define_tasks before tasks can be created.` });
					}

					const { createKanbanTask } = await import("../../rpc/kanban");
					const { broadcastToWebview } = await import("../../engine-manager");

					// Create tasks and map definition indices to real task IDs for dependencies
					const createdIds: string[] = [];
					for (let i = 0; i < defs.length; i++) {
						const def = defs[i];
						// Resolve blocked_by indices to real task IDs
						const blockedByIds = def.blocked_by
							.filter((idx) => idx >= 0 && idx < i && createdIds[idx])
							.map((idx) => createdIds[idx]);

						const result = await createKanbanTask({
							projectId: effectiveProjId,
							title: def.title,
							description: def.description,
							acceptanceCriteria: JSON.stringify(def.acceptance_criteria),
							column: "backlog",
							priority: def.priority,
							assignedAgentId: def.assigned_agent,
							blockedBy: blockedByIds.length > 0 ? JSON.stringify(blockedByIds) : undefined,
						});
						createdIds.push(result.id);
						broadcastToWebview("kanbanTaskUpdated", { projectId: effectiveProjId, taskId: result.id, action: "created" });
					}

					return JSON.stringify({
						success: true,
						count: createdIds.length,
						taskIds: createdIds,
						message: `Created ${createdIds.length} kanban tasks in backlog for project ${effectiveProjId}. Ready to execute sequentially via run_agent with kanban_task_id and project_id.`,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		get_next_task: tool({
			description:
				"Get the next task to work on. Returns the highest-priority actionable task based on: " +
				"(1) tasks in 'review' column (wait for review to finish), " +
				"(2) tasks in 'working' column (re-dispatch assigned agent), " +
				"(3) tasks in 'backlog' column — oldest unblocked task first (respects plan ordering). " +
				"Always call this instead of manually picking from list_tasks to ensure correct execution order.",
			inputSchema: z.object({
				project_id: z.string().optional().describe(
					"Project to query tasks from. Required for channel conversations — pass the same project_id used throughout this conversation.",
				),
			}),
			execute: async ({ project_id }) => {
				try {
					const effectiveProjId = project_id ?? deps.projectId;
					const allTasks = await db
						.select()
						.from(kanbanTasks)
						.where(eq(kanbanTasks.projectId, effectiveProjId));

					const doneTasksList = allTasks
						.filter(t => t.column === "done")
						.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
					const doneTasks = new Set(doneTasksList.map(t => t.id));

					// Get handoff from most recently completed task
					const lastDone = doneTasksList[0];
					const lastHandoff = lastDone?.importantNotes?.includes("## Handoff Summary")
						? lastDone.importantNotes
						: "";

					// 1. Tasks in review — check if review agent is running
					const inReview = allTasks.filter(t => t.column === "review");
					if (inReview.length > 0) {
						const { getRunningAgentCount } = await import("../../engine-manager");
						const agentsRunning = getRunningAgentCount(effectiveProjId);
						if (agentsRunning > 0) {
							return JSON.stringify({
								action: "wait",
								reason: `${inReview.length} task(s) in review — code review agent is running. Wait for it to complete.`,
								tasksInReview: inReview.map(t => ({ id: t.id, title: t.title })),
							});
						}
						// No review agent running — tell PM to dispatch code-reviewer
						const reviewTask = inReview[0];
						return JSON.stringify({
							action: "dispatch_reviewer",
							task: {
								id: reviewTask.id,
								title: reviewTask.title,
								description: reviewTask.description,
								assignedAgent: "code-reviewer",
								column: "review",
							},
							reason: "Task is in review but no review agent is running. Dispatch code-reviewer to review it.",
						});
					}

					// 2. Tasks in working — re-dispatch (may have been interrupted)
					const inWorking = allTasks
						.filter(t => t.column === "working")
						.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
					if (inWorking.length > 0) {
						const task = inWorking[0];
						return JSON.stringify({
							action: "dispatch",
							task: {
								id: task.id,
								title: task.title,
								description: task.description,
								assignedAgent: task.assignedAgentId,
								priority: task.priority,
								column: task.column,
							},
							priorWork: lastHandoff || undefined,
							reason: "Task is in 'working' column — re-dispatch to complete it.",
						});
					}

					// 3. Tasks in backlog — pick oldest unblocked task (plan ordering)
					const inBacklog = allTasks
						.filter(t => t.column === "backlog")
						.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

					for (const task of inBacklog) {
						// Check if all blockers are done
						let blocked = false;
						if (task.blockedBy) {
							try {
								const blockerIds: string[] = JSON.parse(task.blockedBy);
								blocked = blockerIds.some(id => !doneTasks.has(id));
							} catch { /* invalid JSON — treat as unblocked */ }
						}
						if (!blocked) {
							return JSON.stringify({
								action: "dispatch",
								task: {
									id: task.id,
									title: task.title,
									description: task.description,
									assignedAgent: task.assignedAgentId,
									priority: task.priority,
									column: task.column,
								},
								priorWork: lastHandoff || undefined,
								reason: "Next unblocked backlog task in plan order.",
							});
						}
					}

					// 4. All tasks done or all remaining are blocked
					const remaining = allTasks.filter(t => t.column !== "done");
					if (remaining.length === 0) {
						return JSON.stringify({
							action: "complete",
							reason: "All tasks are done.",
							total: allTasks.length,
						});
					}

					return JSON.stringify({
						action: "blocked",
						reason: `${remaining.length} task(s) remaining but all are blocked by incomplete dependencies.`,
						blockedTasks: remaining.map(t => ({ id: t.id, title: t.title, blockedBy: t.blockedBy })),
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Agent configs
		// -----------------------------------------------------------------

		list_agents: tool({
			description:
				"List all agents with their capabilities, models, and enabled status. " +
				"IMPORTANT: Only dispatch agents where isEnabled=true. Disabled agents (isEnabled=false) " +
				"will be rejected by run_agent — do not attempt to call them.",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					const allRows = await db.select().from(agentsTable).orderBy(agentsTable.name);
					// Hide custom agents the user has opted out of PM visibility —
					// matches the filter in buildAgentsSection so the PM sees a
					// consistent picture across its system prompt and this tool.
					const rows = allRows.filter((a) => a.isBuiltin === 1 || a.availableToPm === 1);
					return JSON.stringify({
						success: true,
						agents: rows.map((a) => ({
							id: a.id,
							name: a.name,
							displayName: a.displayName,
							isEnabled: !!a.isEnabled,
							isBuiltin: !!a.isBuiltin,
							modelId: a.modelId,
							providerId: a.providerId,
							temperature: a.temperature,
							maxTokens: a.maxTokens,
							thinkingBudget: a.thinkingBudget,
						})),
						count: rows.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// -----------------------------------------------------------------
		// Deploy environments & history
		// -----------------------------------------------------------------

		get_deploy_status: tool({
			description:
				"Check deployment environments and recent deploy history for the current project. " +
				"Shows configured environments, last deploy status, and recent deployments.",
			inputSchema: z.object({
				limit: z.number().optional().default(10).describe("Max deploy history entries (default 10)."),
			}),
			execute: async (args) => {
				try {
					const envs = await db
						.select()
						.from(deployEnvironments)
						.where(eq(deployEnvironments.projectId, deps.projectId));

					const envIds = envs.map((e) => e.id);
					let history: Array<Record<string, unknown>> = [];
					if (envIds.length > 0) {
						const { inArray } = await import("drizzle-orm");
						history = await db
							.select()
							.from(deployHistory)
							.where(inArray(deployHistory.environmentId, envIds))
							.orderBy(desc(deployHistory.createdAt))
							.limit(args.limit ?? 10);
					}

					return JSON.stringify({
						success: true,
						environments: envs.map((e) => ({
							id: e.id,
							name: e.name,
							branch: e.branch,
							url: e.url,
							command: e.command,
						})),
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						recentDeploys: history.map((h: any) => ({
							id: h.id,
							environmentId: h.environmentId,
							status: h.status,
							triggeredBy: h.triggeredBy,
							durationMs: h.durationMs,
							createdAt: h.createdAt,
						})),
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Pull requests & PR comments
		// -----------------------------------------------------------------

		get_pull_requests: tool({
			description:
				"List pull requests for the current project. Shows PR status, branches, and linked tasks.",
			inputSchema: z.object({
				state: z.string().optional().describe("Filter by state: 'open', 'review', 'merged', 'closed'. Omit for all."),
				limit: z.number().optional().default(20).describe("Max results (default 20)."),
			}),
			execute: async (args) => {
				try {
					const { and: drAnd } = await import("drizzle-orm");
					let query = db.select().from(pullRequests).where(eq(pullRequests.projectId, deps.projectId));
					if (args.state) {
						query = db.select().from(pullRequests).where(
							drAnd(eq(pullRequests.projectId, deps.projectId), eq(pullRequests.state, args.state)) ?? undefined,
						);
					}
					const rows = await query.orderBy(desc(pullRequests.updatedAt)).limit(args.limit ?? 20);
					return JSON.stringify({
						success: true,
						pullRequests: rows.map((pr) => ({
							id: pr.id,
							prNumber: pr.prNumber,
							title: pr.title,
							sourceBranch: pr.sourceBranch,
							targetBranch: pr.targetBranch,
							state: pr.state,
							authorName: pr.authorName,
							linkedTaskId: pr.linkedTaskId,
							mergeStrategy: pr.mergeStrategy,
							createdAt: pr.createdAt,
							updatedAt: pr.updatedAt,
						})),
						count: rows.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		get_pr_comments: tool({
			description: "Get review comments for a specific pull request.",
			inputSchema: z.object({
				pr_id: z.string().describe("The pull request ID."),
				limit: z.number().optional().default(30).describe("Max comments (default 30)."),
			}),
			execute: async (args) => {
				try {
					const rows = await db
						.select()
						.from(prComments)
						.where(eq(prComments.prId, args.pr_id))
						.orderBy(prComments.createdAt)
						.limit(args.limit ?? 30);
					return JSON.stringify({
						success: true,
						comments: rows.map((c) => ({
							id: c.id,
							file: c.file,
							lineNumber: c.lineNumber,
							content: c.content.slice(0, 1000),
							authorName: c.authorName,
							authorType: c.authorType,
							createdAt: c.createdAt,
						})),
						count: rows.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Cost budgets
		// -----------------------------------------------------------------

		get_cost_budget: tool({
			description:
				"Check token/cost budget for the current project. Shows limits, usage tracking, and remaining budget.",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					const { or } = await import("drizzle-orm");
					const rows = await db
						.select()
						.from(costBudgets)
						.where(
							or(
								eq(costBudgets.projectId, deps.projectId),
								eq(costBudgets.projectId, ""),
							) ?? undefined,
						);

					// Also check the token usage from settings
					const usageKey = `project:${deps.projectId}:token_usage`;
					const usageRows = await db
						.select({ value: settings.value })
						.from(settings)
						.where(eq(settings.key, usageKey))
						.limit(1);

					let usage: Record<string, unknown> = {};
					if (usageRows.length > 0) {
						try { usage = JSON.parse(usageRows[0].value); } catch { /* empty */ }
					}

					return JSON.stringify({
						success: true,
						budgets: rows.map((b) => ({
							id: b.id,
							projectId: b.projectId,
							period: b.period,
							limitUsd: b.limitUsd,
							alertThreshold: b.alertThreshold,
							enabled: !!b.enabled,
						})),
						currentUsage: usage,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Cron jobs
		// -----------------------------------------------------------------

		get_cron_jobs: tool({
			description:
				"List scheduled cron jobs for the current project. Shows job name, schedule, last run status, and recent history.",
			inputSchema: z.object({
				limit: z.number().optional().default(10).describe("Max history entries per job (default 10)."),
			}),
			execute: async (args) => {
				try {
					const jobs = await db
						.select()
						.from(cronJobs)
						.where(eq(cronJobs.projectId, deps.projectId))
						.orderBy(cronJobs.name);

					const jobIds = jobs.map((j) => j.id);
					let history: Array<Record<string, unknown>> = [];
					if (jobIds.length > 0) {
						const { inArray } = await import("drizzle-orm");
						history = await db
							.select()
							.from(cronJobHistory)
							.where(inArray(cronJobHistory.jobId, jobIds))
							.orderBy(desc(cronJobHistory.createdAt))
							.limit(args.limit ?? 10);
					}

					return JSON.stringify({
						success: true,
						jobs: jobs.map((j) => ({
							id: j.id,
							name: j.name,
							cronExpression: j.cronExpression,
							timezone: j.timezone,
							taskType: j.taskType,
							enabled: !!j.enabled,
							lastRunAt: j.lastRunAt,
							lastRunStatus: j.lastRunStatus,
						})),
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						recentHistory: history.map((h: any) => ({
							jobId: h.jobId,
							status: h.status,
							durationMs: h.durationMs,
							startedAt: h.startedAt,
							completedAt: h.completedAt,
						})),
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Audit log
		// -----------------------------------------------------------------

		get_audit_log: tool({
			description:
				"Query the audit log for recent actions. Shows who did what and when. " +
				"Useful for understanding recent changes or debugging issues.",
			inputSchema: z.object({
				entity_type: z.string().optional().describe("Filter by entity type (e.g. 'project', 'task', 'agent')."),
				limit: z.number().optional().default(30).describe("Max entries (default 30)."),
			}),
			execute: async (args) => {
				try {
					let query;
					if (args.entity_type) {
						query = db
							.select()
							.from(auditLog)
							.where(eq(auditLog.entityType, args.entity_type))
							.orderBy(desc(auditLog.createdAt))
							.limit(args.limit ?? 30);
					} else {
						query = db
							.select()
							.from(auditLog)
							.orderBy(desc(auditLog.createdAt))
							.limit(args.limit ?? 30);
					}
					const rows = await query;
					return JSON.stringify({
						success: true,
						entries: rows.map((e) => ({
							id: e.id,
							action: e.action,
							entityType: e.entityType,
							entityId: e.entityId,
							details: e.details ? e.details.slice(0, 500) : null,
							createdAt: e.createdAt,
						})),
						count: rows.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// GitHub issues
		// -----------------------------------------------------------------

		get_github_issues: tool({
			description:
				"List GitHub issues linked to the current project. Shows issue title, state, labels, and linked kanban task.",
			inputSchema: z.object({
				state: z.string().optional().describe("Filter by state: 'open' or 'closed'. Omit for all."),
				limit: z.number().optional().default(30).describe("Max results (default 30)."),
			}),
			execute: async (args) => {
				try {
					const { and: drAnd } = await import("drizzle-orm");
					let query;
					if (args.state) {
						query = db.select().from(githubIssues).where(
							drAnd(eq(githubIssues.projectId, deps.projectId), eq(githubIssues.state, args.state)) ?? undefined,
						);
					} else {
						query = db.select().from(githubIssues).where(eq(githubIssues.projectId, deps.projectId));
					}
					const rows = await query.orderBy(desc(githubIssues.syncedAt)).limit(args.limit ?? 30);
					return JSON.stringify({
						success: true,
						issues: rows.map((i) => ({
							id: i.id,
							githubIssueNumber: i.githubIssueNumber,
							title: i.title,
							state: i.state,
							labels: i.labels,
							taskId: i.taskId,
							syncedAt: i.syncedAt,
						})),
						count: rows.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Channel configs (read-only)
		// -----------------------------------------------------------------

		get_channels: tool({
			description:
				"List connected communication channels for the current project. " +
				"Shows channel type (Discord, WhatsApp, email), enabled status, and basic config (credentials redacted).",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					const rows = await db
						.select()
						.from(channels)
						.where(eq(channels.projectId, deps.projectId));
					return JSON.stringify({
						success: true,
						channels: rows.map((c) => {
							let safeConfig: Record<string, unknown> = {};
							try {
								const parsed = JSON.parse(c.config);
								for (const [k, v] of Object.entries(parsed)) {
									if (/token|secret|password|apiKey|api_key|credentials/i.test(k)) {
										safeConfig[k] = "[REDACTED]";
									} else {
										safeConfig[k] = v;
									}
								}
							} catch {
								safeConfig = { raw: "[parse error]" };
							}
							return {
								id: c.id,
								platform: c.platform,
								enabled: !!c.enabled,
								config: safeConfig,
								createdAt: c.createdAt,
							};
						}),
						count: rows.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Branch strategies
		// -----------------------------------------------------------------

		get_branch_strategy: tool({
			description:
				"Get the branch strategy configuration for the current project. " +
				"Shows branching model (gitflow/github-flow/trunk), naming templates, and protected branches.",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					const rows = await db
						.select()
						.from(branchStrategies)
						.where(eq(branchStrategies.projectId, deps.projectId))
						.limit(1);
					if (rows.length === 0) {
						return JSON.stringify({ success: true, strategy: null, message: "No branch strategy configured for this project." });
					}
					const s = rows[0];
					return JSON.stringify({
						success: true,
						strategy: {
							model: s.model,
							defaultBranch: s.defaultBranch,
							featureBranchPrefix: s.featureBranchPrefix,
							releaseBranchPrefix: s.releaseBranchPrefix,
							hotfixBranchPrefix: s.hotfixBranchPrefix,
							namingTemplate: s.namingTemplate,
							protectedBranches: s.protectedBranches,
							autoCleanup: !!s.autoCleanup,
						},
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// -----------------------------------------------------------------
		// Workspace
		// -----------------------------------------------------------------

		// -----------------------------------------------------------------
		// Interactive user question (app-only modal dialog)
		// -----------------------------------------------------------------

		ask_user_question: tool({
			description:
				"Ask the user a question via an interactive modal dialog. " +
				"Supports four input types: 'choice' (single select from options), 'multi_select' (pick multiple), " +
				"'text' (free-form text input), and 'confirm' (yes/no). " +
				"This tool BLOCKS until the user responds. Only available when the user is chatting via the app " +
				"(not Discord, WhatsApp, or email). Use sparingly — only when you need structured input that " +
				"cannot be gathered from a plain chat message.",
			inputSchema: z.object({
				question: z.string().describe("The question to present to the user."),
				input_type: z
					.enum(["choice", "text", "confirm", "multi_select"])
					.describe("The type of input UI to show."),
				options: z
					.array(z.string())
					.optional()
					.describe("Options for 'choice' or 'multi_select' input types. Required for those types."),
				placeholder: z
					.string()
					.optional()
					.describe("Placeholder text for 'text' input type."),
				default_value: z
					.string()
					.optional()
					.describe("Default value pre-filled in the input."),
				context: z
					.string()
					.optional()
					.describe("Additional context shown below the question to help the user understand why it's being asked."),
			}),
			execute: async (args) => {
				const metadata = deps.getActiveMetadata?.() ?? { source: "app" as const };
				if (metadata.source !== "app") {
					return JSON.stringify({
						success: false,
						error: "ask_user_question is only available when chatting via the app. For channel users, ask the question as a plain text message instead.",
					});
				}

				if (!deps.askUserQuestion) {
					return JSON.stringify({
						success: false,
						error: "ask_user_question handler not available.",
					});
				}

				if ((args.input_type === "choice" || args.input_type === "multi_select") && (!args.options || args.options.length === 0)) {
					return JSON.stringify({
						success: false,
						error: `input_type '${args.input_type}' requires at least one option in the 'options' array.`,
					});
				}

				try {
					const answer = await deps.askUserQuestion({
						question: args.question,
						inputType: args.input_type,
						options: args.options,
						placeholder: args.placeholder,
						defaultValue: args.default_value,
						context: args.context,
					});

					return JSON.stringify({ success: true, answer });
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),

		// -----------------------------------------------------------------
		// Workspace
		// -----------------------------------------------------------------

		list_workspace_folders: tool({
			description:
				"List all folders in the global workspace directory. Shows what projects/folders exist on disk, " +
				"including ones not yet registered as AgentDesk projects. Useful for discovering existing codebases " +
				"or suggesting new projects to create.",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					// Read the global workspace path from settings
					const rows = await db
						.select({ value: settings.value })
						.from(settings)
						.where(eq(settings.key, "global_workspace_path"))
						.limit(1);

					if (rows.length === 0 || !rows[0].value) {
						return JSON.stringify({
							success: false,
							error: "Global workspace path is not configured. Set it in Settings → General.",
						});
					}

					let workspacePath: string;
					try {
						workspacePath = JSON.parse(rows[0].value);
					} catch {
						workspacePath = rows[0].value;
					}

					if (!workspacePath) {
						return JSON.stringify({
							success: false,
							error: "Global workspace path is empty. Set it in Settings → General.",
						});
					}

					const { readdir, stat } = await import("node:fs/promises");
					const entries = await readdir(workspacePath, { withFileTypes: true });

					// Parallelize .git stat checks across all directories
					const dirEntries = entries.filter(
						(e) => e.isDirectory() && !e.name.startsWith("."),
					);

					const folders = await Promise.all(
						dirEntries.map(async (entry) => {
							const fullPath = `${workspacePath}/${entry.name}`;
							let hasGit = false;
							try {
								const gitStat = await stat(`${fullPath}/.git`);
								hasGit = gitStat.isDirectory();
							} catch { /* no .git folder */ }
							return { name: entry.name, path: fullPath, hasGit };
						}),
					);

					// Cross-reference with registered projects
					const allProjects = await getProjectsList();
					const registeredPaths = new Set(
						allProjects.map((p) => p.workspacePath).filter(Boolean),
					);

					const result = folders.map((f) => ({
						...f,
						isRegistered: registeredPaths.has(f.path),
					}));

					return JSON.stringify({
						success: true,
						workspacePath,
						folders: result,
						total: result.length,
						registered: result.filter((f) => f.isRegistered).length,
						unregistered: result.filter((f) => !f.isRegistered).length,
					});
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),

		// -----------------------------------------------------------------
		// Todo list (PM working memory — appears in main chat)
		// -----------------------------------------------------------------

		todo_write: tool({
			description:
				"Create a new todo list. Pass titles as a simple string array. Returns a list_id — use it in run_agent (todo_list_id). " +
				"Item IDs are auto-assigned as '1', '2', '3'... matching the order of titles. " +
				"If a list already exists and is not done, returns the existing list — do NOT retry, just use that list_id.",
			inputSchema: z.object({
				titles: z.array(z.string().min(1)).min(1).describe(
					"Ordered list of todo item titles, e.g. [\"Tell Einstein quote\", \"Tell Gandhi quote\"]"
				),
			}),
			execute: async ({ titles }) => {
				try {
					// Block creation if there's already an active (not fully done) list
					const activeListId = await getActiveListId(deps.conversationId);
					if (activeListId) {
						const activeItems = await getTodoItems(deps.conversationId, activeListId);
						if (activeItems) {
							const allDone = activeItems.every((i) => i.status === "done");
							if (!allDone) {
								const doneCount = activeItems.filter((i) => i.status === "done").length;
								const pending = activeItems.filter((i) => i.status !== "done");
								return JSON.stringify({ success: true, note: "Resumed existing todo list — use this list_id, do not call todo_write again.", list_id: activeListId, done: doneCount, total: activeItems.length, remaining: pending.map((i) => ({ id: i.id, title: i.title, status: i.status })) });
							}
						}
					}

					// Create new list
					const listId = Math.random().toString(36).slice(2, 8);
					const fullItems = titles.map((title, i) => ({ id: String(i + 1), title, status: "pending" as const }));

					await setTodoItems(deps.conversationId, listId, fullItems);
					await setActiveListId(deps.conversationId, listId);

					const messageId = `todo-list:${deps.conversationId}:${listId}`;
					const content = `0/${fullItems.length} tasks`;
					const metadata = JSON.stringify({ type: "todo_list", list_id: listId, items: fullItems });

					await db.insert(messages).values({
						id: messageId,
						conversationId: deps.conversationId,
						role: "assistant",
						agentId: "project-manager",
						content,
						metadata,
						tokenCount: 0,
						createdAt: new Date().toISOString(),
					});

					deps.emitNewMessage({ messageId, agentId: "project-manager", agentName: "Project Manager", content, metadata });
					return JSON.stringify({ success: true, list_id: listId, total: fullItems.length, done: 0 });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		todo_read: tool({
			description: "Read a todo list by its list_id. Pass the list_id returned by todo_write.",
			inputSchema: z.object({
				list_id: z.string().describe("The list_id returned by todo_write"),
			}),
			execute: async ({ list_id }) => {
				try {
					const items = await getTodoItems(deps.conversationId, list_id);
					if (!items) return JSON.stringify({ success: false, error: `No todo list with id '${list_id}'` });
					return JSON.stringify({
						list_id,
						items,
						total: items.length,
						done: items.filter((i) => i.status === "done").length,
						inProgress: items.filter((i) => i.status === "in_progress").length,
						pending: items.filter((i) => i.status === "pending").length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		todo_update_item: tool({
			description:
				"Update a single item's status in a todo list. Pass the list_id from todo_write and the item id.",
			inputSchema: z.object({
				list_id: z.string().describe("The list_id returned by todo_write"),
				id: z.string().describe("The item id to update"),
				status: z.enum(["pending", "in_progress", "done"]),
			}),
			execute: async ({ list_id, id, status }) => {
				try {
					const items = await getTodoItems(deps.conversationId, list_id);
					if (!items) return JSON.stringify({ success: false, error: `No todo list with id '${list_id}'` });
					const idx = items.findIndex((i) => i.id === id);
					if (idx === -1) return JSON.stringify({ success: false, error: `No item with id '${id}' in list '${list_id}'` });

					items[idx].status = status;
					await setTodoItems(deps.conversationId, list_id, items);

					const messageId = `todo-list:${deps.conversationId}:${list_id}`;
					const doneCount = items.filter((i) => i.status === "done").length;
					const content = `${doneCount}/${items.length} tasks`;
					const metadata = JSON.stringify({ type: "todo_list", list_id, items });

					const existing = await db.select({ id: messages.id }).from(messages).where(eq(messages.id, messageId)).limit(1);
					if (existing.length > 0) {
						await db.update(messages).set({ content, metadata }).where(eq(messages.id, messageId));
					}

					// Also clear active list tracking if all done
					if (doneCount === items.length) {
						await setActiveListId(deps.conversationId, null);
					}

					deps.emitNewMessage({ messageId, agentId: "project-manager", agentName: "Project Manager", content, metadata });
					return JSON.stringify({ success: true, list_id, id, status, done: doneCount, total: items.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		get_agent_status: tool({
			description:
				"Check which agents are currently running system-wide and whether any reviews are active. " +
				"Use this when asked about running agents, current work, or agent progress — do NOT answer from conversation context alone. Always call this tool first.",
			inputSchema: z.object({
				project_id: z.string().optional().describe("Specific project to check. Omit to check all projects system-wide."),
			}),
			execute: async ({ project_id }) => {
				const { getRunningAgentNames, getRunningAgentCount, getSystemActivity } = await import("../../engine-manager");
				const { getActiveReviewCount } = await import("../review-cycle");

				if (project_id) {
					return JSON.stringify({
						runningAgentCount: getRunningAgentCount(project_id),
						runningAgents: getRunningAgentNames(project_id),
						activeReviews: getActiveReviewCount(),
					});
				}

				// System-wide: running agents + engines that are streaming or have queued work
				const activity = getSystemActivity();
				return JSON.stringify({
					totalRunningAgents: activity.totalRunningAgents,
					runningAgentsByProject: activity.runningAgentsByProject,
					busyEngines: activity.busyEngines,
					activeReviews: getActiveReviewCount(),
				});
			},
		}),

		set_feature_branch: tool({
			description:
				"Auto-generate and store a feature branch name for the current work session from the conversation context. " +
				"Call this ONCE before dispatching any agents when the feature branch workflow is enabled. " +
				"All task auto-commits will land on this branch. The name is generated by AI from the user's request — no input needed.",
			inputSchema: z.object({}),
			execute: async (): Promise<string> => {
				try {
					// Fetch recent user messages from this conversation to understand the request
					const userMessages = await db
						.select({ content: messages.content })
						.from(messages)
						.where(and(eq(messages.conversationId, deps.conversationId), eq(messages.role, "user")))
						.orderBy(desc(messages.createdAt))
						.limit(5);

					const context = userMessages
						.reverse()
						.map((m) => m.content.slice(0, 300))
						.join("\n");

					if (!context.trim()) {
						return JSON.stringify({ success: false, error: "No conversation context found to generate branch name." });
					}

					// Collect existing branch names + all PR source branches to avoid re-using them
					const { getGitBranches } = await import("../../rpc/git");
					const { pullRequests: prTable } = await import("../../db/schema");
					const [branchesRes, allPrs] = await Promise.all([
						getGitBranches(deps.projectId).catch(() => ({ branches: [] as Array<{ name: string }> })),
						db.select({ sourceBranch: prTable.sourceBranch }).from(prTable).where(eq(prTable.projectId, deps.projectId)),
					]);
					const takenNames = new Set([
						...branchesRes.branches.map((b) => b.name),
						...allPrs.map((p) => p.sourceBranch),
					]);
					const takenList = [...takenNames].filter((n) => n.startsWith("feature/")).join(", ") || "none";

					const { getDefaultModel } = await import("../../providers/models");
					const adapter = createProviderAdapter(deps.providerConfig);
					const modelId = deps.providerConfig.defaultModel ?? getDefaultModel(deps.providerConfig.providerType);
					const { text } = await generateText({
						model: adapter.createModel(modelId),
						messages: [
							{
								role: "user",
								content: `Given this user request, generate a short git branch name in the format "feature/<slug>".
Rules: lowercase, hyphens only, max 40 chars, describes the overall feature (not a single task).
Examples: feature/todo-app, feature/user-auth, feature/dark-mode, feature/payment-flow
IMPORTANT: Do NOT reuse any of these already-taken branch names: ${takenList}

User request:
${context}

Reply with ONLY the branch name, nothing else.`,
							},
						],
					});

					let name = text.trim().replace(/[`'"]/g, "").split("\n")[0].trim();
					if (!name.startsWith("feature/") || name.length < 10) {
						return JSON.stringify({ success: false, error: `Generated name "${name}" is invalid. Try calling again.` });
					}

					// If AI still produced a taken name, append a numeric suffix
					if (takenNames.has(name)) {
						const base = name;
						let counter = 2;
						while (takenNames.has(name) && counter < 20) name = `${base}-${counter++}`;
					}

					await saveSetting(`currentFeatureBranch:${deps.projectId}`, name, "git");
					return JSON.stringify({ success: true, branch: name, message: `Feature branch set to '${name}'. All task commits will land here.` });
				} catch (err) {
					return JSON.stringify({ success: false, error: String(err) });
				}
			},
		}),

		clear_feature_branch: tool({
			description:
				"Clear the active feature branch for a project. Call this after all tasks for the current feature are done " +
				"(after creating the PR or when starting a completely new unrelated feature).",
			inputSchema: z.object({
				project_id: z.string().describe("The project UUID"),
			}),
			execute: async (args): Promise<string> => {
				await saveSetting(`currentFeatureBranch:${args.project_id}`, "", "git");
				return JSON.stringify({ success: true, message: "Feature branch cleared. Next feature will start fresh." });
			},
		}),
	};
}
