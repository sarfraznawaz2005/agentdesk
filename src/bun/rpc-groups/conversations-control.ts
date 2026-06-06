import * as conversationsRpc from "../rpc/conversations";
import * as dashboardRpc from "../rpc/dashboard";
import * as dashboardAgentRpc from "../rpc/dashboard-agent";
import { engines, getOrCreateEngine, broadcastToWebview, resolveShellApproval, resolveUserQuestion, setAppFocused as setAppFocusedFn, abortAllAgents, abortAgentByName, getRunningAgentCount, getRunningAgentNames, getAllRunningAgents } from "../engine-manager";
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
	stopGeneration: (params) => {
		engines.get(params.projectId)?.stopAll();
		abortAllAgents(params.projectId);
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
		const aborted = abortAgentByName(params.projectId, params.agentName);
		return { success: aborted };
	},

	stopAllAgents: (params) => {
		const count = getRunningAgentCount(params.projectId);
		engines.get(params.projectId)?.stopAll();
		abortAllAgents(params.projectId);
		return { success: true, stoppedCount: count };
	},

	getRunningAgents: (params) => {
		const names = getRunningAgentNames(params.projectId);
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

	getPmStatus: (params) => {
		const engine = engines.get(params.projectId);
		if (!engine) return { isStreaming: false, conversationId: null };
		return {
			isStreaming: engine.isProcessing(),
			conversationId: engine.getActiveConversationId(),
		};
	},

	getActiveProjectAgents: () => {
		const result: Array<{ projectId: string; agentCount: number }> = [];
		const seen = new Set<string>();

		// Engine-based projects (PM streaming or PM-dispatched sub-agents)
		for (const [projectId, engine] of engines) {
			seen.add(projectId);
			const subAgentCount = getRunningAgentCount(projectId);
			// If sub-agents are running, show their count.
			// If only the PM itself is processing (planning phase or writing summary),
			// count it as 1 so the dashboard reflects any active work.
			const total = subAgentCount > 0 ? subAgentCount : (engine.isProcessing() ? 1 : 0);
			if (total > 0) result.push({ projectId, agentCount: total });
		}

		// Projects with registered running agents that have no engine (e.g. direct
		// runInlineAgent calls from the scheduler for non-PM agent_task jobs).
		const allRunning = getAllRunningAgents();
		for (const [projectId, agentNames] of Object.entries(allRunning)) {
			if (!seen.has(projectId) && agentNames.length > 0) {
				result.push({ projectId, agentCount: agentNames.length });
			}
		}

		return result;
	},

	// Shell/Question
	respondShellApproval: (params) => ({
		success: resolveShellApproval(params.requestId, params.decision),
	}),
	respondUserQuestion: (params) => ({
		success: resolveUserQuestion(params.requestId, params.answer),
	}),

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
