import { AgentEngine } from "./agents/engine";
import type { AgentEngineCallbacks } from "./agents/engine";
import { db } from "./db";
import { projects, settings, kanbanTasks } from "./db/schema";
import { eq, inArray } from "drizzle-orm";
import { sendChannelMessage } from "./channels/manager";
import { chunkMessage } from "./channels/chunker";
import { setShellApprovalHandler, resetShellAutoApprove } from "./agents/tools/shell";
import { sqlite } from "./db/connection";
import { updateAgentResponse } from "./rpc/inbox";
import { recordActivity } from "./rpc/activity";
import { sendDesktopNotification } from "./notifications/desktop";
import {
	savePendingApproval,
	deletePendingApproval,
	loadPendingApprovalsByProject,
	loadStaleInteractiveApprovals,
	deleteAllInteractiveApprovals,
} from "./db/pending-approvals";

// ---------------------------------------------------------------------------
// Engine management — one AgentEngine instance per project.
// mainWindowRef is set after the window is created (in index.ts). All engine
// callbacks reference it via closure so they always use the live value.
// ---------------------------------------------------------------------------
export const engines = new Map<string, AgentEngine>();

/**
 * Tracks abort controllers for all running inline agents (PM-dispatched and
 * workflow-dispatched) per project. Used by stopGeneration to abort everything,
 * and by stopAgent to abort a specific agent by name.
 */
interface AgentControllerEntry {
	controller: AbortController;
	agentName: string;
}
const runningAgentControllers = new Map<string, Map<AbortController, AgentControllerEntry>>();

export function registerAgentController(projectId: string, controller: AbortController, agentName: string): void {
	let map = runningAgentControllers.get(projectId);
	if (!map) { map = new Map(); runningAgentControllers.set(projectId, map); }
	map.set(controller, { controller, agentName });
}

export function unregisterAgentController(projectId: string, controller: AbortController): void {
	const map = runningAgentControllers.get(projectId);
	if (map) { map.delete(controller); if (map.size === 0) runningAgentControllers.delete(projectId); }
}

export function abortAllAgents(projectId: string): void {
	const map = runningAgentControllers.get(projectId);
	if (map) {
		for (const entry of map.values()) entry.controller.abort();
		map.clear();
		runningAgentControllers.delete(projectId);
	}
}

/**
 * Abort a specific agent by name. If multiple agents share the same name,
 * aborts the first one found.
 */
export function abortAgentByName(projectId: string, agentName: string): boolean {
	const map = runningAgentControllers.get(projectId);
	if (!map) return false;
	for (const [key, entry] of map) {
		if (entry.agentName === agentName) {
			entry.controller.abort();
			map.delete(key);
			if (map.size === 0) runningAgentControllers.delete(projectId);
			return true;
		}
	}
	return false;
}

/** Returns the number of currently running agents for a project. */
export function getRunningAgentCount(projectId: string): number {
	return runningAgentControllers.get(projectId)?.size ?? 0;
}

/** Returns names of currently running agents for a project. */
export function getRunningAgentNames(projectId: string): string[] {
	const map = runningAgentControllers.get(projectId);
	if (!map) return [];
	return [...map.values()].map(e => e.agentName);
}

/** Returns all running agents across every project, keyed by projectId. */
export function getAllRunningAgents(): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [pid, map] of runningAgentControllers) {
		if (map.size > 0) {
			result[pid] = [...map.values()].map(e => e.agentName);
		}
	}
	return result;
}

/**
 * Returns a system-wide activity summary: running agents + any engine that is
 * currently streaming (PM generating) or has agents queued.
 */
export function getSystemActivity(): {
	runningAgentsByProject: Record<string, string[]>;
	busyEngines: Array<{ projectId: string; pmStreaming: boolean; queuedAgents: string[] }>;
	totalRunningAgents: number;
} {
	const runningAgentsByProject = getAllRunningAgents();
	const totalRunningAgents = Object.values(runningAgentsByProject).reduce((s, a) => s + a.length, 0);
	const busyEngines: Array<{ projectId: string; pmStreaming: boolean; queuedAgents: string[] }> = [];

	for (const [projectId, engine] of engines) {
		const pmStreaming = engine.isProcessing();
		const queued = engine.getQueuedAgentsSnapshot().map(a => a.displayName);
		if (pmStreaming || queued.length > 0) {
			busyEngines.push({ projectId, pmStreaming, queuedAgents: queued });
		}
	}

	return { runningAgentsByProject, busyEngines, totalRunningAgents };
}

/** Tracks whether the app window is currently in focus. Updated via setAppFocused RPC. */
let appFocused = true;
export function setAppFocused(focused: boolean): void {
	appFocused = focused;
}

/**
 * Build a markdown system-status report for the /info slash command.
 * Shared by AgentEngine._handleStatusCommand() and the dashboard PM widget.
 */
export async function getStatusReport(): Promise<string> {
	const { runningAgentsByProject, busyEngines, totalRunningAgents } = getSystemActivity();

	const activeProjectIds = Object.keys(runningAgentsByProject).filter(
		(id) => runningAgentsByProject[id].length > 0,
	);

	const projectNameMap = new Map<string, string>();
	if (activeProjectIds.length > 0) {
		const rows = await db
			.select({ id: projects.id, name: projects.name })
			.from(projects)
			.where(inArray(projects.id, activeProjectIds));
		for (const r of rows) projectNameMap.set(r.id, r.name);
	}

	const tasksByProject = new Map<string, Array<{ title: string; column: string }>>();
	if (activeProjectIds.length > 0) {
		const taskRows = await db
			.select({ projectId: kanbanTasks.projectId, title: kanbanTasks.title, column: kanbanTasks.column })
			.from(kanbanTasks)
			.where(inArray(kanbanTasks.projectId, activeProjectIds));
		for (const t of taskRows) {
			if (t.column !== "working" && t.column !== "review") continue;
			if (!tasksByProject.has(t.projectId)) tasksByProject.set(t.projectId, []);
			tasksByProject.get(t.projectId)?.push({ title: t.title, column: t.column });
		}
	}

	const now = new Date().toLocaleTimeString();

	if (totalRunningAgents === 0 && busyEngines.length === 0) {
		return `## System Status\n\nAll quiet — no agents are currently running across any project.\n\n*Checked at ${now}*`;
	}

	const lines: string[] = ["## System Status", ""];
	lines.push(`**${totalRunningAgents} agent${totalRunningAgents === 1 ? "" : "s"} running across ${activeProjectIds.length} project${activeProjectIds.length === 1 ? "" : "s"}**`, "");

	for (const projectId of activeProjectIds) {
		const agentNames = runningAgentsByProject[projectId] ?? [];
		if (agentNames.length === 0) continue;
		const projectName = projectNameMap.get(projectId) ?? projectId;
		const tasks = tasksByProject.get(projectId) ?? [];
		const busyEngine = busyEngines.find((e) => e.projectId === projectId);

		lines.push(`### ${projectName}`);
		lines.push(`- **Running agents (${agentNames.length}):** ${agentNames.map((n) => `\`${n}\``).join(", ")}`);
		if (busyEngine?.pmStreaming) lines.push(`- PM is streaming a response`);
		if ((busyEngine?.queuedAgents.length ?? 0) > 0) {
			lines.push(`- **Queued:** ${busyEngine?.queuedAgents.map((n) => `\`${n}\``).join(", ")}`);
		}
		const workingTasks = tasks.filter((t) => t.column === "working");
		const reviewTasks = tasks.filter((t) => t.column === "review");
		if (workingTasks.length > 0) lines.push(`- **In progress:** ${workingTasks.map((t) => `"${t.title}"`).join(", ")}`);
		if (reviewTasks.length > 0) lines.push(`- **In review:** ${reviewTasks.map((t) => `"${t.title}"`).join(", ")}`);
		lines.push("");
	}

	lines.push(`*Checked at ${now}*`);
	return lines.join("\n");
}

/**
 * Maximum number of AgentEngine instances to keep in the map at once.
 * When the limit is exceeded the oldest idle engine (no active agents, not
 * processing) is evicted to reclaim memory.
 */
const ENGINE_MAP_MAX_SIZE = 50;

/**
 * Remove the engine for a project and stop any work it is doing.
 * Safe to call if the engine does not exist.
 */
export function removeEngine(projectId: string): void {
	const engine = engines.get(projectId);
	if (engine) {
		engine.stopAll();
		abortAllAgents(projectId);
		engines.delete(projectId);
		resetShellAutoApprove();
	}
}

/**
 * If the engines map has grown past ENGINE_MAP_MAX_SIZE, find the first idle
 * engine (not processing, no active sub-agents) and evict it.  If all engines
 * are busy the map is allowed to exceed the limit temporarily.
 */
function evictOldestIdleEngine(): void {
	if (engines.size <= ENGINE_MAP_MAX_SIZE) return;

	for (const [projectId, engine] of engines) {
		if (!engine.isProcessing() && getRunningAgentCount(projectId) === 0) {
			engines.delete(projectId);
			return;
		}
	}
}

// Module-level reference populated once the BrowserWindow exists.
// Handlers are invoked at runtime (not at definition time) so this
// will always be assigned before any engine callback fires.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mainWindowRef: any = null;

/**
 * Set the main window reference so engine callbacks can send RPC messages.
 * Must be called once after the BrowserWindow is created.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setMainWindowRef(win: any): void {
	mainWindowRef = win;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getMainWindowRef(): any {
	return mainWindowRef;
}

// Remote broadcast fan-out (TASK-475). The remote layer (src/bun/remote)
// registers a sink so webview broadcasts are ALSO forwarded to connected remote
// clients (the web app, via the relay or a direct WS). Registration keeps
// engine-manager decoupled from the remote module (no import cycle; the remote
// layer depends on engine-manager, never the reverse).
type RemoteBroadcastSink = (method: string, payload: unknown) => void;
const remoteBroadcastSinks = new Set<RemoteBroadcastSink>();

export function registerRemoteBroadcastSink(sink: RemoteBroadcastSink): () => void {
	remoteBroadcastSinks.add(sink);
	return () => remoteBroadcastSinks.delete(sink);
}

/**
 * Safely send a message to the webview via RPC. At runtime the rpc
 * object has `send.<method>()` helpers created by BrowserView.defineRPC,
 * but Electrobun's exported types don't expose them statically on
 * BrowserWindow. We route through an any-typed ref to keep TS happy.
 */
export function broadcastToWebview(method: string, payload: unknown): void {
	try {
		mainWindowRef?.webview?.rpc?.send?.[method]?.(payload);
	} catch {
		// Window may have been closed — silently ignore
	}
	// Additive fan-out to remote transports. Runs after the webview send and
	// never lets a sink failure affect the in-app path.
	if (remoteBroadcastSinks.size > 0) {
		for (const sink of remoteBroadcastSinks) {
			try {
				sink(method, payload);
			} catch {
				// A remote sink must never break the webview broadcast.
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Link agent responses to inbox messages
// ---------------------------------------------------------------------------

/**
 * Find the most recent inbox message from a given channel that has no
 * agentResponse yet, and update it with the agent's reply content.
 */
function linkAgentResponseToInbox(channelId: string, responseContent: string): void {
	try {
		// Use raw SQL for efficiency — find latest unresponded message from this channel
		const row = sqlite.prepare(
			`SELECT id FROM inbox_messages WHERE channel_id = ? AND agent_response IS NULL ORDER BY created_at DESC LIMIT 1`
		).get(channelId) as { id: string } | undefined;
		if (row) {
			updateAgentResponse(row.id, responseContent).catch(() => {});
		}
	} catch {
		// Non-critical — don't crash if query fails
	}
}

// ---------------------------------------------------------------------------
// Shell approval system
// ---------------------------------------------------------------------------

/** Map of pending shell approval requests: requestId → resolver */
const pendingShellApprovals = new Map<string, {
	resolve: (decision: "allow" | "deny" | "always") => void;
	timer: ReturnType<typeof setTimeout>;
}>();

/** Auto-deny a shell approval after this long with no response. */
const SHELL_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** Cache for the active project ID — set when getOrCreateEngine is called */
let activeProjectId: string | null = null;

/**
 * Resolve a pending shell approval request. Called by the RPC handler when
 * the user clicks Allow/Deny/Always in the UI.
 */
export function resolveShellApproval(
	requestId: string,
	decision: "allow" | "deny" | "always",
): boolean {
	const pending = pendingShellApprovals.get(requestId);
	if (!pending) return false;
	clearTimeout(pending.timer);
	pendingShellApprovals.delete(requestId);
	deletePendingApproval(requestId);
	pending.resolve(decision);
	return true;
}

/**
 * Read the shellApprovalMode for a project from the settings table.
 * Returns "ask" | "auto" — defaults to "ask" if not found.
 */
async function getShellApprovalMode(projectId: string): Promise<string> {
	try {
		const rows = await db
			.select({ value: settings.value })
			.from(settings)
			.where(eq(settings.key, `project:${projectId}:shellApprovalMode`))
			.limit(1);
		return rows.length > 0 ? rows[0].value : "ask";
	} catch {
		return "ask";
	}
}

/**
 * Install the shell approval handler. This wires up the shell tool to
 * read the active project's shellApprovalMode and request approval when
 * mode is "ask".
 */
function installShellApprovalHandler(): void {
	setShellApprovalHandler(async (command, agentId, agentName) => {
		if (!activeProjectId) return "allow";

		const mode = await getShellApprovalMode(activeProjectId);
		if (mode === "auto") return "allow";

		// Mode is "ask" — broadcast approval request and wait
		const requestId = crypto.randomUUID();
		const projectId = activeProjectId;
		const timestamp = new Date().toISOString();
		const payload = { requestId, projectId, agentId, agentName, command, timestamp };

		broadcastToWebview("shellApprovalRequest", payload);

		// Write through to the DB so a reconnecting web client can re-render this
		// pending request, and a restart can emit a clean expiry signal (TASK-478).
		savePendingApproval({
			id: requestId,
			projectId,
			kind: "shell",
			payload,
			expiresAt: new Date(Date.now() + SHELL_APPROVAL_TIMEOUT_MS).toISOString(),
		});

		// Fire an OS-level desktop notification so the user is alerted even when
		// the app window is in the background or minimised.
		sendDesktopNotification(
			`Shell Approval Required — ${agentName}`,
			command.length > 100 ? command.slice(0, 97) + "..." : command,
		).catch(() => {});

		return new Promise<"allow" | "deny" | "always">((resolve) => {
			// Auto-deny after the timeout if no response
			const timer = setTimeout(() => {
				pendingShellApprovals.delete(requestId);
				deletePendingApproval(requestId);
				// Tell the frontend to mark the stale card as expired (clean re-request
				// UX instead of a stuck spinner) — see AC: expired approvals signal.
				broadcastToWebview("shellApprovalExpired", { requestId, projectId, reason: "timeout" });
				resolve("deny");
			}, SHELL_APPROVAL_TIMEOUT_MS);

			pendingShellApprovals.set(requestId, { resolve, timer });
		});
	});
}

// Install the handler at module load time
installShellApprovalHandler();

// ---------------------------------------------------------------------------
// User question system (PM asks user a question via modal dialog)
// ---------------------------------------------------------------------------

/** Map of pending user questions: requestId → resolver */
const pendingUserQuestions = new Map<string, {
	resolve: (answer: string) => void;
	timer: ReturnType<typeof setTimeout>;
}>();

/**
 * Resolve a pending user question. Called by the RPC handler when the user
 * submits their answer in the modal dialog.
 */
export function resolveUserQuestion(
	requestId: string,
	answer: string,
): boolean {
	const pending = pendingUserQuestions.get(requestId);
	if (!pending) return false;
	clearTimeout(pending.timer);
	pendingUserQuestions.delete(requestId);
	deletePendingApproval(requestId);
	pending.resolve(answer);
	return true;
}

/** Default wait before a user-question auto-resolves with a timeout message. */
const DEFAULT_USER_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Ask the user a question via a modal dialog and wait for the response. Raises an
 * OS-level desktop notification (so the user is alerted even when the dialog is
 * triggered by a background agent and the app isn't focused), then blocks until
 * the user answers or the timeout elapses.
 *
 * `timeoutMs` lets callers tune the wait — autonomous background agents
 * (freelance-expert, issue-fixer) pass a short window so an absent user never
 * stalls the run; interactive agents use the longer default. On timeout we also
 * broadcast `userQuestionCancel` so the now-stale dialog closes itself.
 *
 * Returns the user's answer string, or a timeout/cancel message.
 */
export function askUserQuestion(payload: {
	question: string;
	inputType: "choice" | "text" | "confirm" | "multi_select";
	options?: string[];
	placeholder?: string;
	defaultValue?: string;
	context?: string;
	projectId?: string;
	agentId: string;
	agentName: string;
	timeoutMs?: number;
}): Promise<string> {
	const requestId = crypto.randomUUID();
	const timeoutMs = payload.timeoutMs ?? DEFAULT_USER_QUESTION_TIMEOUT_MS;
	const projectId = payload.projectId ?? activeProjectId ?? "";
	const requestPayload = {
		requestId,
		...payload,
		projectId,
		timestamp: new Date().toISOString(),
	};

	broadcastToWebview("userQuestionRequest", requestPayload);

	// Write through so a reconnecting web client can re-render the question
	// (TASK-478). Background autonomous questions (short timeoutMs) are also
	// persisted but reconciled away on restart like any other interactive request.
	savePendingApproval({
		id: requestId,
		projectId,
		kind: "question",
		payload: requestPayload,
		expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
	});

	// OS-level toast so a human away from the app still learns an agent needs them.
	const snippet = payload.question.length > 140 ? `${payload.question.slice(0, 140)}…` : payload.question;
	sendDesktopNotification(`${payload.agentName} needs your input`, snippet).catch(() => {});

	return new Promise<string>((resolve) => {
		const timer = setTimeout(() => {
			pendingUserQuestions.delete(requestId);
			deletePendingApproval(requestId);
			// Tell the frontend to close the stale dialog — the agent has moved on.
			broadcastToWebview("userQuestionCancel", { requestId });
			const mins = Math.round(timeoutMs / 60000);
			resolve(
				timeoutMs < 60000
					? `[No response — timed out after ${Math.round(timeoutMs / 1000)} seconds; continuing without an answer]`
					: `[No response — timed out after ${mins} minute${mins === 1 ? "" : "s"}; continuing without an answer]`,
			);
		}, timeoutMs);

		pendingUserQuestions.set(requestId, { resolve, timer });
	});
}

// ---------------------------------------------------------------------------
// Durability: reconnect re-surfacing + startup reconciliation (TASK-478)
// ---------------------------------------------------------------------------

/**
 * Return the still-pending shell-approval and user-question requests for a
 * project (desktop alive). A reconnecting web client calls this and re-renders
 * the approval cards/dialogs that were broadcast while it was disconnected —
 * the awaiting agent promises are still live in memory, so resolving them works.
 * Expired rows (past `expires_at`) are filtered out.
 */
export function getPendingApprovals(projectId: string): {
	shell: unknown[];
	question: unknown[];
} {
	const now = Date.now();
	const rows = loadPendingApprovalsByProject(projectId, ["shell", "question"]);
	const live = rows.filter((r) => {
		// Only re-surface requests whose resolver is still in memory — anything
		// not in the live maps belongs to a dead run and must not be shown.
		const inMemory =
			pendingShellApprovals.has(r.id) || pendingUserQuestions.has(r.id);
		const notExpired = !r.expiresAt || new Date(r.expiresAt).getTime() > now;
		return inMemory && notExpired;
	});
	return {
		shell: live.filter((r) => r.kind === "shell").map((r) => r.payload),
		question: live.filter((r) => r.kind === "question").map((r) => r.payload),
	};
}

/**
 * On desktop startup, every persisted shell/question request is orphaned — its
 * awaiting agent run died with the previous process. Emit a clean per-request
 * expiry signal (so any card the web client still shows resolves to a "please
 * re-request" state instead of a stuck spinner) and clear the rows. Plan-task
 * definitions are intentionally left in place — they are reusable after restart.
 */
export function reconcilePendingApprovalsOnStartup(): void {
	const stale = loadStaleInteractiveApprovals();
	if (stale.length === 0) return;
	console.log(`[durability] reconciling ${stale.length} orphaned approval(s) from previous session`);
	for (const row of stale) {
		const projectId = row.projectId;
		if (row.kind === "shell") {
			broadcastToWebview("shellApprovalExpired", { requestId: row.id, projectId, reason: "restart" });
		} else if (row.kind === "question") {
			broadcastToWebview("userQuestionCancel", { requestId: row.id });
		}
	}
	deleteAllInteractiveApprovals();
}

export function getOrCreateEngine(projectId: string): AgentEngine {
	activeProjectId = projectId;
	let engine = engines.get(projectId);
	if (!engine) {
		evictOldestIdleEngine();
		const callbacks: AgentEngineCallbacks = {
			onStreamToken: (cid, mid, token, agentId) => {
				broadcastToWebview("streamToken", {
					conversationId: cid,
					messageId: mid,
					token,
					agentId,
				});
			},
			onStreamReset: (cid, mid) => {
				broadcastToWebview("streamReset", {
					conversationId: cid,
					messageId: mid,
				});
			},
			onStreamComplete: (cid, mid, usage) => {
				broadcastToWebview("streamComplete", {
					conversationId: cid,
					messageId: mid,
					content: usage.content,
					metadata: usage.metadata ?? null,
					usage,
				});

				// Flag the project's main chat as having unread agent activity (the PM
				// produced a reply). Cleared when the user views the Chat tab.
				if (usage.content) recordActivity(projectId, "chat").catch(() => {});

				// Relay PM response to source channel if message came from a channel
				const eng = engines.get(projectId);
				if (eng && usage.content) {
					const meta = eng.getActiveMetadata();
					if (meta.source !== "app" && meta.channelId) {
						console.log(`[EngineManager] Relaying PM response to channel ${meta.channelId} (${usage.content.length} chars)`);
						for (const chunk of chunkMessage(usage.content)) {
							sendChannelMessage(meta.channelId, chunk).catch((err) => {
								console.error(`[EngineManager] sendChannelMessage failed for channel ${meta.channelId}:`, err);
							});
						}
						linkAgentResponseToInbox(meta.channelId, usage.content);
					}
				}

				// Desktop notification when everything is idle (PM done + no agents).
				// Use setTimeout(0) so the engine's finally block sets pmProcessing=false first.
				setTimeout(() => {
					const e = engines.get(projectId);
					if (!e || e.isProcessing() || getRunningAgentCount(projectId) > 0 || e.getQueuedAgentsSnapshot().length > 0) return;
					// Skip if app window is in focus — notification only useful when user is away
					if (appFocused) return;
					// Respect the "session complete" notification setting (default: enabled)
					const settingRow = db.select({ value: settings.value }).from(settings)
						.where(eq(settings.key, "session_complete_notification")).get();
					const enabled = settingRow ? settingRow.value !== "\"false\"" && settingRow.value !== "false" : true;
					if (!enabled) return;
					const row = db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).get();
					const name = row?.name ?? "Project";
					sendDesktopNotification(
						`${name} — Session Complete`,
						usage.content.slice(0, 150) || "All agents have finished.",
					).catch(() => {});
				}, 0);
			},
			onStreamError: (cid, error) => {
				broadcastToWebview("streamError", {
					conversationId: cid,
					error,
				});

				// Desktop notification on agent error (errors shown in red in chat).
				// Mirrors the session-complete gate: only when the app is not focused
				// and the "error_notification" setting is enabled (default: on).
				if (appFocused) return;
				const settingRow = db.select({ value: settings.value }).from(settings)
					.where(eq(settings.key, "error_notification")).get();
				const enabled = settingRow ? settingRow.value !== "\"false\"" && settingRow.value !== "false" : true;
				if (!enabled) return;
				const row = db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).get();
				const name = row?.name ?? "Project";
				sendDesktopNotification(
					`${name} — Error`,
					(error || "An error occurred while the agent was working.").slice(0, 200),
				).catch(() => {});
			},
			onNewMessage: (params) => {
				broadcastToWebview("newMessage", params);
			},
			onAgentStatus: (pid, aid, status) => {
				broadcastToWebview("agentStatus", {
					projectId: pid,
					agentId: aid,
					status,
				});
			},
			onAgentInlineStart: (conversationId, messageId, agentName, agentDisplayName, task) => {
				broadcastToWebview("agentInlineStart", { conversationId, messageId, agentName, agentDisplayName, task });
			},
			onContextUsage: (conversationId, promptTokens, contextLimit) => {
				broadcastToWebview("contextUsage", { conversationId, promptTokens, contextLimit });
			},
			onAgentInlineComplete: (conversationId, messageId, agentName, status, summary, tokensUsed) => {
				broadcastToWebview("agentInlineComplete", { conversationId, messageId, agentName, status, summary, tokensUsed });
				// A sub-agent finished work in the main chat (skip user-cancelled runs).
				if (status !== "cancelled") recordActivity(projectId, "chat").catch(() => {});
			},
			onPartCreated: (conversationId, part) => {
				broadcastToWebview("partCreated", {
					conversationId,
					messageId: part.messageId,
					part: {
						id: part.id,
						type: part.type,
						content: part.content,
						toolName: part.toolName,
						toolInput: part.toolInput,
						toolOutput: part.toolOutput,
						toolState: part.toolState,
						sortOrder: part.sortOrder,
						agentName: part.agentName,
						timeStart: part.timeStart,
						timeEnd: part.timeEnd,
					},
				});
			},
			onPartUpdated: (conversationId, messageId, partId, updates) => {
				broadcastToWebview("partUpdated", {
					conversationId,
					messageId,
					partId,
					updates: {
						content: updates.content,
						toolOutput: updates.toolOutput,
						toolState: updates.toolState,
						timeEnd: updates.timeEnd,
					},
				});
			},
			onKanbanTaskMove: (pid, taskId, _column) => {
				broadcastToWebview("kanbanTaskUpdated", {
					projectId: pid,
					taskId,
					action: "moved",
				});
			},
			onConversationTitleChanged: (conversationId, title) => {
				broadcastToWebview("conversationTitleChanged", {
					conversationId,
					title,
				});
			},
			onConversationUpdated: (conversationId, updatedAt) => {
				broadcastToWebview("conversationUpdated", {
					conversationId,
					updatedAt,
				});
			},
			onCompactionStarted: (conversationId) => {
				broadcastToWebview("compactionStarted", { conversationId });
			},
			onConversationCompacted: (conversationId, remainingTokens) => {
				broadcastToWebview("conversationCompacted", {
					conversationId,
					remainingTokens,
				});
			},
			onAgentActivity(event) {
				// Only forward PM thinking events — other activity types were removed in v2
				if (event.type === "thinking" && event.data?.text) {
					broadcastToWebview("pmThinking", {
						conversationId: event.conversationId,
						text: event.data.text,
						isPartial: event.data.isPartial ?? false,
					});
				}
			},
			askUserQuestion: (payload) => askUserQuestion(payload),
		};
		engine = new AgentEngine(projectId, callbacks);
		// Wire abort controller tracking so stopGeneration can abort all running agents
		engine.registerAgentAbort = (c, name) => registerAgentController(projectId, c, name);
		engine.unregisterAgentAbort = (c) => unregisterAgentController(projectId, c);
		engine.setAbortAgentsFn(abortAllAgents);
		engines.set(projectId, engine);
	}
	return engine;
}

