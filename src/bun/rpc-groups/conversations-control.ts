import * as conversationsRpc from "../rpc/conversations";
import * as dashboardRpc from "../rpc/dashboard";
import * as dashboardAgentRpc from "../rpc/dashboard-agent";
import { engines, getOrCreateEngine, broadcastToWebview, resolveShellApproval, resolveUserQuestion, getPendingApprovals, setAppFocused as setAppFocusedFn, abortAllAgents, abortAgentsForConversation, abortAgentByName, abortAgentByNameInConversation, getRunningAgentCount, getRunningAgentNamesForConversation, getChatScopedAgentNames, getActiveProjectAgentsList } from "../engine-manager";
import { enqueueMessage, removeQueuedMessage, getQueuedMessages, clearQueueForConversation } from "../message-queue-manager";
import { db } from "../db";
import { aiProviders } from "../db/schema";
import { eq } from "drizzle-orm";
import { sqlite } from "../db/connection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (params: any) => any> = {
	// Conversations
	getConversations: (params) =>
		conversationsRpc.getConversations(params.projectId),
	createConversation: (params) =>
		conversationsRpc.createConversation(params.projectId, params.title),
	deleteConversation: (params) =>
		conversationsRpc.deleteConversation(params.id),
	clearConversationMessages: (params) =>
		conversationsRpc.clearConversationMessages(params.id),
	getMessageParts: (params) =>
		conversationsRpc.getMessageParts(params.messageId),
	deleteMessage: (params) =>
		conversationsRpc.deleteMessage(params.id),
	branchConversation: (params) =>
		conversationsRpc.branchConversation(params.conversationId, params.upToMessageId),
	renameConversation: (params) =>
		conversationsRpc.renameConversation(params.id, params.title),
	pinConversation: (params) =>
		conversationsRpc.pinConversation(params.id, params.pinned),

	// Messages
	getMessages: (params) =>
		conversationsRpc.getMessages(
			params.conversationId,
			params.limit,
			params.before,
		),
	// Delegate to the per-project AgentEngine
	sendMessage: (params) =>
		getOrCreateEngine(params.projectId).sendMessage(
			params.conversationId,
			params.content,
			params.metadata,
		),
	// Regenerate the last assistant reply without persisting a duplicate user
	// message (the Retry button). Delegates to the per-project AgentEngine.
	retryLastMessage: (params) =>
		getOrCreateEngine(params.projectId).retryLastMessage(params.conversationId),
	stopGeneration: (params) => {
		// Each conversation runs its own independent PM turn now, so both the PM
		// abort and the sub-agent abort must be scoped to conversationId — an
		// unscoped stopAll() would kill every OTHER conversation's in-flight turn
		// in the same project too. Falls back to the project-wide variant only if
		// no conversationId was supplied (shouldn't happen from the current
		// frontend, kept for safety).
		engines.get(params.projectId)?.stopAll(params.conversationId);
		if (params.conversationId) {
			abortAgentsForConversation(params.projectId, params.conversationId);
			// Clear this conversation's queue server-side, atomically with the
			// abort — the frontend also clears it via a separate RPC call, but
			// that's a second, unsequenced round-trip. Relying on it alone let a
			// backend queue-drain (fired from the abort's own onStreamComplete,
			// near-synchronously) win the race and silently re-send the queued
			// message as a brand-new PM turn the Stop click already missed.
			if (getQueuedMessages(params.projectId, params.conversationId).length > 0) {
				clearQueueForConversation(params.projectId, params.conversationId);
				broadcastToWebview("messageQueueUpdated", { projectId: params.projectId, conversationId: params.conversationId, queue: [] });
			}
		} else {
			abortAllAgents(params.projectId);
		}
		return { success: true };
	},

	// Message queue — held server-side (see message-queue-manager.ts) so a
	// queued message reaches the right project+conversation once idle, even if
	// the frontend has since switched away from it.
	enqueueMessage: (params) => {
		const msg = enqueueMessage(params.projectId, params.conversationId, params.content);
		const queue = getQueuedMessages(params.projectId, params.conversationId);
		if (!msg) return { success: false, queue };
		broadcastToWebview("messageQueueUpdated", { projectId: params.projectId, conversationId: params.conversationId, queue });
		return { success: true, queue };
	},
	removeQueuedMessage: (params) => {
		removeQueuedMessage(params.projectId, params.conversationId, params.messageId);
		const queue = getQueuedMessages(params.projectId, params.conversationId);
		broadcastToWebview("messageQueueUpdated", { projectId: params.projectId, conversationId: params.conversationId, queue });
		return { success: true, queue };
	},
	getQueuedMessages: (params) =>
		getQueuedMessages(params.projectId, params.conversationId),
	clearQueuedMessages: (params) => {
		clearQueueForConversation(params.projectId, params.conversationId);
		broadcastToWebview("messageQueueUpdated", { projectId: params.projectId, conversationId: params.conversationId, queue: [] });
		return { success: true };
	},
	retryAgent: async (params: { projectId: string; conversationId: string; agentName: string; task: string }) => {
		const engine = engines.get(params.projectId);
		if (!engine) return { success: false, error: "No engine found for this project" };
		// Inject as an agent_report type so sendMessage doesn't abort any running agents
		// and the PM treats it like an internal system event (same pathway as [Agent Report]).
		// The PM will dispatch the same agent with the same task through the normal
		// run_agent pathway, so all existing guards (writeAgentRunning, kanban review
		// block, hallucination detection) apply — no special-casing needed.
		const retryMsg =
			`[AGENT RETRY] The user clicked Retry for \`${params.agentName}\` after it failed due to a network error. ` +
			`Dispatch \`${params.agentName}\` immediately with the task below — do NOT modify the task, do NOT ask for confirmation. ` +
			`Prepend this note to the task description: "⚠️ RETRY AFTER NETWORK FAILURE: Some work from the previous run may already be on disk. Read the relevant files before starting to avoid redoing completed edits."\n\n` +
			`Task:\n${params.task}`;
		engine.sendMessage(params.conversationId, retryMsg, { type: "agent_report" } as never)
			.catch((err: unknown) => console.error("[retryAgent] sendMessage failed:", err));
		return { success: true };
	},
	setAppFocused: (params) => {
		setAppFocusedFn(params.focused);
		return { success: true };
	},

	// Compact Conversation (for /compact)
	compactConversation: async (params) => {
		const { summarizeConversation } = await import("../agents/summarizer");
		const { getDefaultModel } = await import("../providers/models");
		const { messages: messagesTable } = await import("../db/schema");

		// Check if there are enough messages to compact (summarizer keeps last 10)
		const msgCount = await db.select({ id: messagesTable.id }).from(messagesTable)
			.where(eq(messagesTable.conversationId, params.conversationId));
		if (msgCount.length <= 10) {
			return { success: false, message: "Not enough messages to compact (need more than 10)" };
		}

		const provRows = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
		const providerRow = provRows[0] ?? (await db.select().from(aiProviders).limit(1))[0];
		if (!providerRow) return { success: false, message: "No AI provider configured" };

		await summarizeConversation({
			conversationId: params.conversationId,
			providerConfig: {
				id: providerRow.id,
				name: providerRow.name,
				providerType: providerRow.providerType,
				apiKey: providerRow.apiKey ?? "",
				baseUrl: providerRow.baseUrl ?? null,
				defaultModel: providerRow.defaultModel ?? null,
			},
			modelId: providerRow.defaultModel || getDefaultModel(providerRow.providerType),
		});

		// Notify frontend to reload messages
		broadcastToWebview("conversationCompacted", {
			conversationId: params.conversationId,
		});

		return { success: true };
	},

	// Conversation Archive
	archiveConversation: (params) => conversationsRpc.archiveConversation(params.id),
	restoreConversation: (params) => conversationsRpc.restoreConversation(params.id),
	archiveOldConversations: (params) => conversationsRpc.archiveOldConversations(params.projectId, params.daysOld),
	getArchivedConversations: (params) => conversationsRpc.getArchivedConversations(params.projectId),

	// Agent control — inline model: no pause/resume/redirect, just stop
	resumeAgent: async (_params) => ({ success: false }),
	redirectAgent: async (_params) => ({ success: false }),
	stopAgent: (params) => {
		// conversationId scopes the stop to just this conversation's agent —
		// avoids stopping the wrong same-named agent if another conversation in
		// the same project happens to be running one too. Falls back to the
		// project-wide match only if no conversationId was supplied.
		const aborted = params.conversationId
			? abortAgentByNameInConversation(params.projectId, params.conversationId, params.agentName)
			: abortAgentByName(params.projectId, params.agentName);
		return { success: aborted };
	},

	stopAllAgents: (params) => {
		// Deliberately unfiltered (not getChatScopedAgentCount) — abortAllAgents
		// below actually stops every agent regardless of surface, so the count
		// must match what's really being stopped, including Issue Fixer/scheduler.
		const count = getRunningAgentCount(params.projectId);
		engines.get(params.projectId)?.stopAll();
		abortAllAgents(params.projectId);
		return { success: true, stoppedCount: count };
	},

	// Project-wide — used by the dashboard's "N agents working" project cards.
	// Chat-scoped: excludes Issue Fixer and directly-scheduled agent runs,
	// which have their own independent lifecycle/UI (see isChatScoped). For
	// the per-conversation running-agent badge/count, use
	// getRunningAgentsForConversation instead.
	getRunningAgents: (params) => {
		const names = getChatScopedAgentNames(params.projectId);
		if (names.length === 0) return [];
		// Look up display names from the agents table in one query
		const placeholders = names.map(() => "?").join(", ");
		const rows = sqlite
			.prepare(`SELECT name, display_name FROM agents WHERE name IN (${placeholders})`)
			.all(...names) as Array<{ name: string; display_name: string }>;
		const displayNameMap = new Map(rows.map((r) => [r.name, r.display_name]));
		return names.map((name, i) => ({
			id: `agent-${i}-${name}`,
			name,
			displayName: displayNameMap.get(name) ?? name,
			taskDescription: "",
			status: "running" as const,
		}));
	},

	// Scoped to one conversation — the correct source for a per-conversation
	// running-agent count/badge (never includes sibling conversations, other
	// projects, or conversation-less background runs in the same project).
	getRunningAgentsForConversation: (params) => {
		const names = getRunningAgentNamesForConversation(params.projectId, params.conversationId);
		if (names.length === 0) return [];
		const placeholders = names.map(() => "?").join(", ");
		const rows = sqlite
			.prepare(`SELECT name, display_name FROM agents WHERE name IN (${placeholders})`)
			.all(...names) as Array<{ name: string; display_name: string }>;
		const displayNameMap = new Map(rows.map((r) => [r.name, r.display_name]));
		return names.map((name, i) => ({
			id: `agent-${i}-${name}`,
			name,
			displayName: displayNameMap.get(name) ?? name,
			taskDescription: "",
			status: "running" as const,
		}));
	},

	getPmStatus: (params) => {
		const engine = engines.get(params.projectId);
		if (!engine) return { isStreaming: false, conversationId: null };
		// Scoped to params.conversationId when supplied — each conversation runs
		// its own independent PM turn now, so "is the PM streaming" only makes
		// sense answered for one specific conversation. Falls back to the
		// project-wide "is ANY conversation streaming" reading otherwise.
		if (params.conversationId) {
			return {
				isStreaming: engine.isProcessing(params.conversationId),
				conversationId: params.conversationId,
			};
		}
		return {
			isStreaming: engine.isProcessing(),
			conversationId: engine.getActiveConversationId(),
		};
	},

	getActiveProjectAgents: () => getActiveProjectAgentsList(),

	// Shell/Question
	respondShellApproval: (params) => ({
		success: resolveShellApproval(params.requestId, params.decision),
	}),
	respondUserQuestion: (params) => ({
		success: resolveUserQuestion(params.requestId, params.answer),
	}),
	getPendingApprovals: (params) => getPendingApprovals(params.projectId),

	// Dashboard PM Chat
	sendDashboardMessage: (params) => dashboardRpc.sendDashboardMessage(params),
	abortDashboardMessage: (params) => dashboardRpc.abortDashboardMessage(params),
	clearDashboardSession: (params) => dashboardRpc.clearDashboardSession(params),

	// Dashboard Custom-Agent Chat
	getChatEnabledAgents:       ()       => dashboardAgentRpc.getChatEnabledAgents(),
	sendDashboardAgentMessage:  (params) => dashboardAgentRpc.sendDashboardAgentMessage(params),
	abortDashboardAgentMessage: (params) => dashboardAgentRpc.abortDashboardAgentMessage(params),
	clearDashboardAgentSession: (params) => dashboardAgentRpc.clearDashboardAgentSession(params),
};
