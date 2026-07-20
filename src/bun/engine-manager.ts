import { AgentEngine } from "./agents/engine";
import type { AgentEngineCallbacks } from "./agents/engine";
import { db } from "./db";
import { projects, settings, kanbanTasks } from "./db/schema";
import { eq, inArray } from "drizzle-orm";
import { sendChannelMessage, broadcastSchedulerResult } from "./channels/manager";
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
import { dequeueMessage, getQueuedMessages, clearQueueForProject } from "./message-queue-manager";

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
 *
 * conversationId lets callers scope an abort to just one conversation instead
 * of the whole project — see abortAgentsForConversation below. It's `null`
 * only for genuinely conversation-less runs (the scheduler's project-less
 * "agent_task_simple" mode, which never creates a chat conversation at all);
 * those are exempt from conversation-scoped aborts by construction (no
 * conversationId can ever match `null`) and only reachable via abortAllAgents/
 * stopAllAgents, an explicit project-wide action.
 */
interface AgentControllerEntry {
	controller: AbortController;
	agentName: string;
	conversationId: string | null;
	/** Whether this running agent belongs to genuine main-project-chat activity
	 *  (regular chat dispatch, scheduled PM turns, or kanban auto-review/fix) —
	 *  as opposed to an independent background surface like Issue Fixer or a
	 *  directly-scheduled agent run, which has its own lifecycle and UI.
	 *  Governs BOTH the write-agent concurrency guards in
	 *  pm-tools.ts/review-cycle.ts (blocking a new write dispatch, or being
	 *  waited on before one) AND every "N agents running" count/list surfaced
	 *  to the user or to PM tools (dashboard project cards, get_agent_status,
	 *  /info, the per-conversation badge). Defaults to true; false for Issue
	 *  Fixer/scheduler entries. Deliberately does NOT affect stop-all,
	 *  stop-by-name, health checks, or app-reset — those must still see and
	 *  control everything regardless of surface. */
	isChatScoped: boolean;
}
const runningAgentControllers = new Map<string, Map<AbortController, AgentControllerEntry>>();

export function registerAgentController(projectId: string, controller: AbortController, agentName: string, conversationId: string | null, isChatScoped = true): void {
	let map = runningAgentControllers.get(projectId);
	if (!map) { map = new Map(); runningAgentControllers.set(projectId, map); }
	map.set(controller, { controller, agentName, conversationId, isChatScoped });
}

export function unregisterAgentController(projectId: string, controller: AbortController): void {
	const map = runningAgentControllers.get(projectId);
	if (map) { map.delete(controller); if (map.size === 0) runningAgentControllers.delete(projectId); }
}

/** Explicit "stop everything in this project" — used by the stopAllAgents RPC
 *  and engine teardown. NOT used for the implicit abort-on-new-message path
 *  (see abortAgentsForConversation) — that must stay scoped to one
 *  conversation so unrelated conversations, scheduler runs, review-cycle
 *  agents, and issue-fixer runs in the same project are never silently killed
 *  just because the user sent a message somewhere else in the project. */
export function abortAllAgents(projectId: string): void {
	const map = runningAgentControllers.get(projectId);
	if (map) {
		for (const entry of map.values()) entry.controller.abort();
		map.clear();
		runningAgentControllers.delete(projectId);
	}
}

/**
 * Abort only the agents running in one specific conversation of a project —
 * the correct scope for "a new message arrived, cancel whatever this
 * conversation's PM/agents were doing," which must never reach into sibling
 * conversations or conversation-less background runs in the same project.
 */
export function abortAgentsForConversation(projectId: string, conversationId: string): void {
	const map = runningAgentControllers.get(projectId);
	if (!map) return;
	for (const [key, entry] of map) {
		if (entry.conversationId === conversationId) {
			entry.controller.abort();
			map.delete(key);
		}
	}
	if (map.size === 0) runningAgentControllers.delete(projectId);
}

/**
 * Abort a specific agent by name anywhere in the project. If multiple agents
 * share the same name (possible across different conversations), aborts the
 * first one found — prefer abortAgentByNameInConversation when the caller
 * knows which conversation it means.
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

/**
 * Abort a specific agent by name, scoped to one conversation — avoids
 * aborting the wrong agent when two conversations in the same project happen
 * to be running same-named agents concurrently.
 */
export function abortAgentByNameInConversation(projectId: string, conversationId: string, agentName: string): boolean {
	const map = runningAgentControllers.get(projectId);
	if (!map) return false;
	for (const [key, entry] of map) {
		if (entry.conversationId === conversationId && entry.agentName === agentName) {
			entry.controller.abort();
			map.delete(key);
			if (map.size === 0) runningAgentControllers.delete(projectId);
			return true;
		}
	}
	return false;
}

/** Returns the number of currently running agents for a project (all conversations combined — used by dashboard project cards). */
export function getRunningAgentCount(projectId: string): number {
	return runningAgentControllers.get(projectId)?.size ?? 0;
}

/** Returns the names of currently running agents scoped to one conversation — used for the per-conversation running-agent badge/count. */
export function getRunningAgentNamesForConversation(projectId: string, conversationId: string): string[] {
	const map = runningAgentControllers.get(projectId);
	if (!map) return [];
	return [...map.values()].filter((e) => e.conversationId === conversationId).map((e) => e.agentName);
}

/**
 * Tracks whether at least one (non-cancelled) sub-agent has completed since the
 * project's last idle-settle. Set in onAgentInlineComplete, consumed + cleared
 * by the idle-check in onStreamComplete — this is what lets that check
 * distinguish "a whole agent-dispatch session just finished" from "the PM sent
 * a plain chat reply with zero dispatches" (both look identical to the
 * existing isProcessing()/getRunningAgentCount()==0/queue-empty gate alone).
 */
const sessionHadAgentActivity = new Map<string, boolean>();

/** Returns names of currently running agents that belong to main-project-chat
 *  activity (regular chat dispatch, scheduled PM turns, kanban auto-review/fix
 *  — excludes Issue Fixer and directly-scheduled agent runs, see
 *  AgentControllerEntry.isChatScoped). This is the correct source for BOTH the
 *  write-agent concurrency guards (pm-tools.ts's otherWriteAgents check,
 *  review-cycle.ts's fix-agent wait) AND any "N agents running" count/list
 *  shown to the user or a PM tool. Safety-critical call sites (engine
 *  eviction, health checks, app reset, stop-all) must keep using the
 *  unfiltered getRunningAgentNames/getRunningAgentCount/getAllRunningAgents
 *  below instead — they need to see and control every surface. */
export function getChatScopedAgentNames(projectId: string): string[] {
	const map = runningAgentControllers.get(projectId);
	if (!map) return [];
	return [...map.values()].filter((e) => e.isChatScoped).map((e) => e.agentName);
}

/** Chat-scoped equivalent of getRunningAgentCount — see getChatScopedAgentNames. */
export function getChatScopedAgentCount(projectId: string): number {
	return getChatScopedAgentNames(projectId).length;
}

/** Returns names of currently running agents for a project — UNFILTERED,
 *  includes Issue Fixer/scheduler. Only for safety-critical call sites (see
 *  getChatScopedAgentNames); UI/PM-tool "running agents" surfaces should use
 *  getChatScopedAgentNames instead. */
export function getRunningAgentNames(projectId: string): string[] {
	const map = runningAgentControllers.get(projectId);
	if (!map) return [];
	return [...map.values()].map(e => e.agentName);
}

/** Returns all running agents across every project, keyed by projectId —
 *  UNFILTERED, includes Issue Fixer/scheduler. Only for safety-critical call
 *  sites (app reset); see getChatScopedAgentsByProject for the display/PM-tool
 *  equivalent. */
export function getAllRunningAgents(): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [pid, map] of runningAgentControllers) {
		if (map.size > 0) {
			result[pid] = [...map.values()].map(e => e.agentName);
		}
	}
	return result;
}

/** Chat-scoped equivalent of getAllRunningAgents — excludes Issue
 *  Fixer/scheduler entries in every project. Used by getSystemActivity, which
 *  feeds get_agent_status, /info, and the dashboard PM widget. */
export function getChatScopedAgentsByProject(): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [pid, map] of runningAgentControllers) {
		const names = [...map.values()].filter((e) => e.isChatScoped).map((e) => e.agentName);
		if (names.length > 0) result[pid] = names;
	}
	return result;
}

/**
 * Active agent count per project — backs the getActiveProjectAgents RPC
 * (rpc-groups/conversations-control.ts) and Ambient Mode's TV-projection
 * snapshot (rpc/ambient.ts), which both need the identical computation.
 */
export function getActiveProjectAgentsList(): Array<{ projectId: string; agentCount: number }> {
	const result: Array<{ projectId: string; agentCount: number }> = [];
	const seen = new Set<string>();

	// Engine-based projects (PM streaming or PM-dispatched sub-agents).
	// Chat-scoped: excludes Issue Fixer and directly-scheduled agent runs —
	// see isChatScoped.
	for (const [projectId, engine] of engines) {
		seen.add(projectId);
		const subAgentCount = getChatScopedAgentCount(projectId);
		// If sub-agents are running, show their count.
		// If only the PM itself is processing (planning phase or writing summary),
		// count it as 1 so the dashboard reflects any active work.
		const total = subAgentCount > 0 ? subAgentCount : (engine.isProcessing() ? 1 : 0);
		if (total > 0) result.push({ projectId, agentCount: total });
	}

	// Chat-scoped projects with no engine yet — in practice this should
	// never fire (a chat-scoped agent always has a matching engine, created
	// either by the PM turn that dispatched it or by review-cycle's
	// getOrCreateEngine call), but kept as a defensive fallback.
	const allRunning = getChatScopedAgentsByProject();
	for (const [projectId, agentNames] of Object.entries(allRunning)) {
		if (!seen.has(projectId) && agentNames.length > 0) {
			result.push({ projectId, agentCount: agentNames.length });
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
	const runningAgentsByProject = getChatScopedAgentsByProject();
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
export function isAppFocused(): boolean {
	return appFocused;
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
		resetShellAutoApprove(projectId);
		clearQueueForProject(projectId);
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

// ---------------------------------------------------------------------------
// Quick Chat window registry — a Quick Chat project's engine callbacks and
// shell-approval/user-question prompts route to its own BrowserWindow instead
// of the main window, so its stream/tool events never leak into (or get lost
// from) whichever window the main app happens to have open. Populated by
// src/bun/quick-chat/window.ts when a Quick Chat window opens/closes. Every
// other (non-Quick-Chat) project has no entry here and falls back to the main
// window, which is the existing, unchanged behavior.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const projectWindows = new Map<string, any>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerProjectWindow(projectId: string, win: any): void {
	projectWindows.set(projectId, win);
}

export function unregisterProjectWindow(projectId: string): void {
	projectWindows.delete(projectId);
}

/** Additive fan-out to remote transports, shared by broadcastToWebview and broadcastToProject. */
function fanOutToRemote(method: string, payload: unknown): void {
	if (remoteBroadcastSinks.size === 0) return;
	for (const sink of remoteBroadcastSinks) {
		try {
			sink(method, payload);
		} catch {
			// A remote sink must never break the webview broadcast.
		}
	}
}

/**
 * Safely send a message to the webview via RPC. At runtime the rpc
 * object has `send.<method>()` helpers created by BrowserView.defineRPC,
 * but Electrobun's exported types don't expose them statically on
 * BrowserWindow. We route through an any-typed ref to keep TS happy.
 *
 * Fans out to the main window AND every open Quick Chat window — this is for
 * genuinely global, project-less events (showToast, settingsChanged,
 * projectsUpdated, etc). Over-delivery to a Quick Chat window is harmless:
 * the frontend already filters project/conversation-scoped events by ID, and
 * global events have no such filtering to begin with. For anything scoped to
 * a single project, use broadcastToProject instead.
 */
export function broadcastToWebview(method: string, payload: unknown): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const targets = new Set<any>([mainWindowRef, ...projectWindows.values()].filter(Boolean));
	for (const target of targets) {
		try {
			target?.webview?.rpc?.send?.[method]?.(payload);
		} catch {
			// Window may have been closed — silently ignore
		}
	}
	// Additive fan-out to remote transports. Runs after the webview sends and
	// never lets a sink failure affect the in-app path.
	fanOutToRemote(method, payload);
}

/**
 * Like broadcastToWebview, but routes to a project's own Quick Chat window
 * when one is registered (see projectWindows above), falling back to the main
 * window otherwise — the normal case for every non-Quick-Chat project. Use
 * this instead of broadcastToWebview for any event scoped to a single project
 * (stream tokens, tool parts, shell-approval/user-question prompts) so a Quick
 * Chat run's events land only in the window that owns it.
 */
export function broadcastToProject(projectId: string, method: string, payload: unknown): void {
	const target = projectWindows.get(projectId) ?? mainWindowRef;
	try {
		target?.webview?.rpc?.send?.[method]?.(payload);
	} catch {
		// Window may have been closed — silently ignore
	}
	fanOutToRemote(method, payload);
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
	projectId: string;
}>();

/** Auto-deny a shell approval after this long with no response. */
const SHELL_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Whether pending questions/shell-approvals should be pushed to connected
 * channels (and channel replies allowed to resolve them). Shared by
 * askUserQuestion and installShellApprovalHandler. Fail-open (no row ⇒
 * enabled), matching every other channel-notify toggle in this codebase.
 */
function isQuestionChannelNotifyEnabled(): boolean {
	const row = db.select({ value: settings.value }).from(settings)
		.where(eq(settings.key, "question_channel_notify")).get();
	return row ? row.value !== "\"false\"" && row.value !== "false" : true;
}

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
	setShellApprovalHandler(async (command, agentId, agentName, projectId, conversationId) => {
		if (!projectId) return "allow";

		const mode = await getShellApprovalMode(projectId);
		if (mode === "auto") return "allow";

		// Mode is "ask" — broadcast approval request and wait
		const requestId = crypto.randomUUID();
		const timestamp = new Date().toISOString();
		const payload = { requestId, projectId, conversationId, agentId, agentName, command, timestamp };

		broadcastToProject(projectId, "shellApprovalRequest", payload);
		recordGlobalActivity(projectId, `waiting for you to approve: ${command}`, {
			key: agentId.split("#")[0],
			label: agentName,
		});

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

		// Also push to connected channels (Discord/WhatsApp/Email) so a reply of
		// allow/deny/always can resolve this from a phone — mirrors the desktop
		// toast above and is not gated by app focus (channel notify is meant for
		// "away from the computer entirely", same precedent as task_done_channel_notify).
		// Shares the question_channel_notify setting with AskUserQuestion since both
		// are the same "blocking, needs a human decision" shape.
		if (isQuestionChannelNotifyEnabled()) {
			const truncated = command.length > 300 ? command.slice(0, 297) + "..." : command;
			broadcastSchedulerResult(
				`${agentName} — Shell Approval Needed`,
				`\`${truncated}\`\n\nReply *allow*, *deny*, or *always* to respond.`,
			).catch(() => {});
		}

		return new Promise<"allow" | "deny" | "always">((resolve) => {
			// Auto-deny after the timeout if no response
			const timer = setTimeout(() => {
				pendingShellApprovals.delete(requestId);
				deletePendingApproval(requestId);
				// Tell the frontend to mark the stale card as expired (clean re-request
				// UX instead of a stuck spinner) — see AC: expired approvals signal.
				broadcastToProject(projectId, "shellApprovalExpired", { requestId, projectId, reason: "timeout" });
				resolve("deny");
			}, SHELL_APPROVAL_TIMEOUT_MS);

			pendingShellApprovals.set(requestId, { resolve, timer, projectId });
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
	projectId: string;
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

/**
 * Find a pending channel-forwardable interactive request (AskUserQuestion or
 * shell approval) for a project, so an inbound channel reply can resolve it
 * directly instead of starting a fresh PM turn — see channels/manager.ts's
 * handleIncomingMessage. Returns the first match found; in practice at most
 * one such request is open per project at a time (sequential single-agent
 * model — see agent-engine.ts).
 */
export function getPendingChannelInteraction(
	projectId: string,
): { kind: "question"; requestId: string } | { kind: "shell"; requestId: string } | null {
	for (const [requestId, entry] of pendingUserQuestions) {
		if (entry.projectId === projectId) return { kind: "question", requestId };
	}
	for (const [requestId, entry] of pendingShellApprovals) {
		if (entry.projectId === projectId) return { kind: "shell", requestId };
	}
	return null;
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
	// Required — the caller MUST know which project's agent is asking. Previously
	// fell back to a module-level "most recently touched engine" cache
	// (activeProjectId), which could mistag a question from project A as
	// belonging to whichever project's engine happened to be touched last by
	// unrelated backend activity. Removed; every caller now threads its own
	// projectId through explicitly (see engine.ts's PMToolsDeps.askUserQuestion
	// wrapper and communication.ts's request_human_input tool).
	projectId: string;
	agentId: string;
	agentName: string;
	timeoutMs?: number;
}): Promise<string> {
	const requestId = crypto.randomUUID();
	const timeoutMs = payload.timeoutMs ?? DEFAULT_USER_QUESTION_TIMEOUT_MS;
	const projectId = payload.projectId || "";
	const requestPayload = {
		requestId,
		...payload,
		projectId,
		timestamp: new Date().toISOString(),
	};

	broadcastToProject(projectId, "userQuestionRequest", requestPayload);
	recordGlobalActivity(projectId, `asked: ${payload.question}`, {
		key: payload.agentId.split("#")[0],
		label: payload.agentName,
	});

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

	// Also push to connected channels so the question can be answered from a
	// phone — a reply on the same channel/project resolves this request (see
	// handleIncomingMessage's pending-interaction check in channels/manager.ts).
	if (isQuestionChannelNotifyEnabled()) {
		const optionsText = payload.options && payload.options.length > 0 ? `\n\nOptions: ${payload.options.join(", ")}` : "";
		const contextText = payload.context ? `\n\n${payload.context}` : "";
		broadcastSchedulerResult(
			`${payload.agentName} needs your input`,
			`${payload.question}${contextText}${optionsText}\n\nReply to this message with your answer.`,
		).catch(() => {});
	}

	return new Promise<string>((resolve) => {
		const timer = setTimeout(() => {
			pendingUserQuestions.delete(requestId);
			deletePendingApproval(requestId);
			// Tell the frontend to close the stale dialog — the agent has moved on.
			broadcastToProject(projectId, "userQuestionCancel", { requestId });
			const mins = Math.round(timeoutMs / 60000);
			resolve(
				timeoutMs < 60000
					? `[No response — timed out after ${Math.round(timeoutMs / 1000)} seconds; continuing without an answer]`
					: `[No response — timed out after ${mins} minute${mins === 1 ? "" : "s"}; continuing without an answer]`,
			);
		}, timeoutMs);

		pendingUserQuestions.set(requestId, { resolve, timer, projectId });
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
 * Total shell + question approvals currently awaiting a response, across
 * every project with a live engine — backs Ambient Mode's TV-projection
 * snapshot (rpc/ambient.ts), which has no per-project scope to ask about like
 * the main window's shellApprovalRequests store does.
 */
export function getGlobalPendingApprovalCount(): number {
	let total = 0;
	for (const projectId of engines.keys()) {
		const { shell, question } = getPendingApprovals(projectId);
		total += shell.length + question.length;
	}
	return total;
}

export interface GlobalActivityLogEntry {
	id: string;
	timestamp: number;
	projectId: string;
	/** Raw agent type key (e.g. "code-explorer"), for color-coding. Absent for non-agent entries. */
	agentKey?: string;
	/** Human-readable name to render in the agent's colored badge. */
	agentLabel?: string;
	text: string;
}

const GLOBAL_ACTIVITY_LOG_LIMIT = 50;
const globalActivityLog: GlobalActivityLogEntry[] = [];
let globalActivityLogIdCounter = 0;

const GLOBAL_ACTIVITY_ACRONYMS = new Set(["qa", "ui", "ux", "api", "db", "ml"]);

/**
 * "code-explorer" -> "Code Explorer" — mirrors the frontend's own
 * formatAgentKey (use-global-agent-activity.ts) for entries where only the
 * raw agent key is known, not its display name.
 */
function formatGlobalActivityAgentKey(key: string): string {
	return key
		.split(/[-_]/)
		.map((w) => (GLOBAL_ACTIVITY_ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
		.join(" ");
}

/**
 * Backend-side mirror of the rolling activity log the main window's
 * useGlobalAgentActivity hook builds itself from live push events — the
 * ambient TV-projection window (rpc/ambient.ts) has no per-project broadcast
 * target to receive those pushes (same reason getGlobalPendingApprovalCount
 * above exists), so it polls this instead. In-memory only, resets on
 * restart — same ephemeral nature as the frontend's own rolling log.
 */
export function recordGlobalActivity(projectId: string, text: string, agent?: { key: string; label: string }): void {
	globalActivityLog.unshift({
		id: `${Date.now()}-${globalActivityLogIdCounter++}`,
		timestamp: Date.now(),
		projectId,
		agentKey: agent?.key,
		agentLabel: agent?.label,
		text,
	});
	if (globalActivityLog.length > GLOBAL_ACTIVITY_LOG_LIMIT) globalActivityLog.length = GLOBAL_ACTIVITY_LOG_LIMIT;
}

export function getRecentGlobalActivity(): GlobalActivityLogEntry[] {
	return globalActivityLog;
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
			broadcastToProject(projectId, "shellApprovalExpired", { requestId: row.id, projectId, reason: "restart" });
		} else if (row.kind === "question") {
			broadcastToProject(projectId, "userQuestionCancel", { requestId: row.id });
		}
	}
	deleteAllInteractiveApprovals();
}

export function getOrCreateEngine(projectId: string): AgentEngine {
	let engine = engines.get(projectId);
	if (!engine) {
		evictOldestIdleEngine();
		const callbacks: AgentEngineCallbacks = {
			onStreamToken: (cid, mid, token, agentId) => {
				broadcastToProject(projectId, "streamToken", {
					conversationId: cid,
					messageId: mid,
					token,
					agentId,
				});
			},
			onStreamReset: (cid, mid) => {
				broadcastToProject(projectId, "streamReset", {
					conversationId: cid,
					messageId: mid,
				});
			},
			onStreamComplete: (cid, mid, usage) => {
				broadcastToProject(projectId, "streamComplete", {
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
					const meta = eng.getActiveMetadata(cid);
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

				// Fires when THIS conversation is idle (its own PM turn done + no
				// sub-agents of its own still running). Scoped to cid, not the whole
				// project — a sibling conversation still working must never delay this
				// conversation's own queue-drain or "session complete" signal.
				// Use setTimeout(0) so the engine's finally block clears its
				// per-conversation processing state first.
				setTimeout(() => {
					const e = engines.get(projectId);
					if (!e || e.isProcessing(cid) || getRunningAgentNamesForConversation(projectId, cid).length > 0) return;

					// If the user queued a message for THIS conversation while it was
					// busy, send it now instead of treating this as "session complete" —
					// the conversation is continuing, not finished.
					const queued = dequeueMessage(projectId, cid);
					if (queued) {
						broadcastToProject(projectId, "messageQueueUpdated", { projectId, conversationId: cid, queue: getQueuedMessages(projectId, cid) });
						e.sendMessage(cid, queued.content, undefined);
						return;
					}

					const hadAgentActivity = sessionHadAgentActivity.get(projectId) === true;
					if (hadAgentActivity) sessionHadAgentActivity.set(projectId, false);

					const row = db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).get();
					const name = row?.name ?? "Project";

					// In-app toast for a background project — fires regardless of window
					// focus (that's the point of it; the desktop notification below is for
					// when the user is away entirely). Skipped if the PM never actually
					// dispatched an agent this turn — a plain chat reply isn't a "session".
					if (hadAgentActivity) {
						broadcastToProject(projectId, "agentSessionComplete", { projectId, projectName: name });
					}

					// Skip if app window is in focus — notification only useful when user is away
					if (appFocused) return;
					// Respect the "session complete" notification setting (default: enabled)
					const settingRow = db.select({ value: settings.value }).from(settings)
						.where(eq(settings.key, "session_complete_notification")).get();
					const enabled = settingRow ? settingRow.value !== "\"false\"" && settingRow.value !== "false" : true;
					if (!enabled) return;
					sendDesktopNotification(
						`${name} — Session Complete`,
						usage.content.slice(0, 150) || "All agents have finished.",
					).catch(() => {});
				}, 0);
			},
			onStreamError: (cid, error) => {
				broadcastToProject(projectId, "streamError", {
					conversationId: cid,
					error,
				});

				// Mirrors the queued-message drain in onStreamComplete — an error also
				// ends the PM's turn for THIS conversation, so a message queued for it
				// should still get its chance to send once this conversation (not the
				// whole project) is truly idle.
				setTimeout(() => {
					const e = engines.get(projectId);
					if (!e || e.isProcessing(cid) || getRunningAgentNamesForConversation(projectId, cid).length > 0) return;
					const queued = dequeueMessage(projectId, cid);
					if (queued) {
						broadcastToProject(projectId, "messageQueueUpdated", { projectId, conversationId: cid, queue: getQueuedMessages(projectId, cid) });
						e.sendMessage(cid, queued.content, undefined);
					}
				}, 0);

				// Push to connected channels — independent of app focus (mirrors the
				// existing task_done_channel_notify precedent: channel notify is for
				// "away from the computer entirely", not just "window unfocused"),
				// gated by its own "error_channel_notify" setting (default: on) so it
				// can be turned off separately from the desktop toast below.
				{
					const channelSettingRow = db.select({ value: settings.value }).from(settings)
						.where(eq(settings.key, "error_channel_notify")).get();
					const channelEnabled = channelSettingRow ? channelSettingRow.value !== "\"false\"" && channelSettingRow.value !== "false" : true;
					if (channelEnabled) {
						const row = db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).get();
						const name = row?.name ?? "Project";
						broadcastSchedulerResult(
							`${name} — Error`,
							`⚠️ ${(error || "An error occurred while the agent was working.").slice(0, 300)}`,
						).catch(() => {});
					}
				}

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
				broadcastToProject(projectId, "newMessage", params);
			},
			onAgentStatus: (pid, aid, status) => {
				broadcastToProject(pid, "agentStatus", {
					projectId: pid,
					agentId: aid,
					status,
				});
			},
			onAgentInlineStart: (conversationId, messageId, agentName, agentDisplayName, task) => {
				broadcastToProject(projectId, "agentInlineStart", { projectId, conversationId, messageId, agentName, agentDisplayName, task });
				recordGlobalActivity(projectId, `started: ${task}`, { key: agentName.split("#")[0], label: agentDisplayName });
			},
			onContextUsage: (conversationId, promptTokens, contextLimit) => {
				broadcastToProject(projectId, "contextUsage", { conversationId, promptTokens, contextLimit });
			},
			onStreamPerformance: (conversationId, tokensPerSecond, timeToFirstOutputMs) => {
				broadcastToProject(projectId, "streamPerformance", { conversationId, tokensPerSecond, timeToFirstOutputMs });
			},
			onAgentInlineComplete: (conversationId, messageId, agentName, status, summary, tokensUsed) => {
				broadcastToProject(projectId, "agentInlineComplete", { projectId, conversationId, messageId, agentName, status, summary, tokensUsed });
				const verb = status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "completed";
				const globalActivityKey = agentName.split("#")[0];
				recordGlobalActivity(projectId, `${verb}: ${summary || status}`, {
					key: globalActivityKey,
					label: formatGlobalActivityAgentKey(globalActivityKey),
				});
				// A sub-agent finished work in the main chat (skip user-cancelled runs).
				if (status !== "cancelled") {
					recordActivity(projectId, "chat").catch(() => {});
					// Marks this project's session as having real agent activity, so the
					// idle-check in onStreamComplete knows a plain PM chat reply (zero
					// dispatches) shouldn't trigger the "all agents completed" toast.
					sessionHadAgentActivity.set(projectId, true);
				}
			},
			onPartCreated: (conversationId, part) => {
				broadcastToProject(projectId, "partCreated", {
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
				broadcastToProject(projectId, "partUpdated", {
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
				broadcastToProject(pid, "kanbanTaskUpdated", {
					projectId: pid,
					taskId,
					action: "moved",
				});
				recordGlobalActivity(pid, `Task ${taskId} moved`);
			},
			onConversationTitleChanged: (conversationId, title) => {
				broadcastToProject(projectId, "conversationTitleChanged", {
					conversationId,
					title,
				});
			},
			onConversationUpdated: (conversationId, updatedAt) => {
				broadcastToProject(projectId, "conversationUpdated", {
					conversationId,
					updatedAt,
					projectId,
				});
			},
			onCompactionStarted: (conversationId) => {
				broadcastToProject(projectId, "compactionStarted", { conversationId });
			},
			onConversationCompacted: (conversationId, remainingTokens) => {
				broadcastToProject(projectId, "conversationCompacted", {
					conversationId,
					remainingTokens,
				});
			},
			onMessageQueued: (conversationId, queue) => {
				broadcastToProject(projectId, "messageQueueUpdated", { projectId, conversationId, queue });
			},
			onAgentActivity(event) {
				// v2 removed all non-thinking activity from the UI; thinking + the PM's
				// own tool calls (below) are the only two forwarded today.
				if (event.type === "thinking" && event.data?.text) {
					broadcastToProject(projectId, "pmThinking", {
						conversationId: event.conversationId,
						text: event.data.text,
						isPartial: event.data.isPartial ?? false,
					});
				}
				// PM's own direct tool calls (list_tasks, read_file, search_content, etc.)
				// — reinstated as an ephemeral, non-persisted "what is the PM doing right
				// now" indicator (v2 removed all non-thinking activity from the UI).
				// Scoped to agentId === "project-manager" so sub-agent tool calls (which
				// already render permanently via message parts / tool-call-card.tsx) are
				// never duplicated here.
				if ((event.type === "tool_call" || event.type === "status_check") && event.agentId === "project-manager") {
					const toolName = event.data?.toolName;
					if (typeof toolName === "string") {
						broadcastToProject(projectId, "pmActivity", {
							conversationId: event.conversationId,
							toolName,
							isSkill: toolName === "read_skill" || toolName === "find_skills",
						});
					}
				}
			},
			askUserQuestion: (payload) => askUserQuestion(payload),
		};
		engine = new AgentEngine(projectId, callbacks);
		// Wire abort controller tracking so stopGeneration/stopAgent can find and
		// abort running agents. conversationId is supplied by the caller (e.g.
		// pm-tools.ts knows exactly which conversation it's dispatching into,
		// including cross-project dispatch cases) rather than assumed here.
		engine.registerAgentAbort = (c, name, conversationId, isChatScoped) => registerAgentController(projectId, c, name, conversationId, isChatScoped);
		engine.unregisterAgentAbort = (c) => unregisterAgentController(projectId, c);
		// abortAllAgents/abortAgentsForConversation (explicit "stop everything"/
		// "stop this conversation") are called directly by the stopAllAgents/
		// stopGeneration RPC handlers — they don't need engine wiring. A new
		// message never aborts anything on its own now (see sendMessage()); it
		// only needs to know whether THIS conversation already has sub-agents
		// running, to decide whether to queue.
		engine.setGetRunningAgentNamesForConversationFn((conversationId) => getRunningAgentNamesForConversation(projectId, conversationId));
		engines.set(projectId, engine);
	}
	return engine;
}

