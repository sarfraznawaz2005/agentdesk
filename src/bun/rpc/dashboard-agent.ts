/**
 * Dashboard custom-agent chat — lightweight chatbot for the dashboard floating
 * widget, but routed to a user-defined custom agent rather than the PM.
 *
 *   • In-memory history per sessionId (no DB persistence — same as dashboard PM)
 *   • System prompt comes from getAgentSystemPrompt(agentName), which honors
 *     the agent's "Use this system prompt only" toggle.
 *   • Tools come from getToolsForAgent(agentName), so the user's tool-tab
 *     checkboxes drive what the agent can call.
 *   • Token + tool-call events broadcast via broadcastToWebview with the
 *     agentName included so the matching widget can filter.
 */

import { streamText, stepCountIs, type ModelMessage } from "ai";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agents, aiProviders } from "../db/schema";
import { createProviderAdapter } from "../providers";
import { getDefaultModel } from "../providers/models";
import { getAgentSystemPrompt } from "../agents/prompts";
import { getToolsForAgent } from "../agents/tools/index";
import { broadcastToWebview } from "../engine-manager";

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const sessionHistory = new Map<string, ModelMessage[]>();
const activeAborts   = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getProviderForAgent(agentRow: { providerId: string | null }) {
	if (agentRow.providerId) {
		const rows = await db.select().from(aiProviders).where(eq(aiProviders.id, agentRow.providerId)).limit(1);
		if (rows[0]) return rows[0];
	}
	const def = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
	if (def[0]) return def[0];
	const any = await db.select().from(aiProviders).limit(1);
	if (!any[0]) throw new Error("No AI provider configured.");
	return any[0];
}

// ---------------------------------------------------------------------------
// Exported RPC handlers
// ---------------------------------------------------------------------------

export async function getChatEnabledAgents(): Promise<Array<{ id: string; name: string; displayName: string; color: string }>> {
	const rows = await db
		.select({
			id:           agents.id,
			name:         agents.name,
			displayName:  agents.displayName,
			color:        agents.color,
		})
		.from(agents)
		.where(and(
			eq(agents.isBuiltin,    0),  // custom only
			eq(agents.chatEnabled,  1),  // dashboard chat opt-in
			eq(agents.isEnabled,    1),  // honour the agent-disabled toggle
		));
	return rows;
}

export async function sendDashboardAgentMessage(
	params: { sessionId: string; agentName: string; content: string },
): Promise<{ messageId: string }> {
	const { sessionId, agentName, content } = params;

	// Cancel any in-flight stream for this session
	activeAborts.get(sessionId)?.abort();

	const messageId       = crypto.randomUUID();
	const abortController = new AbortController();
	activeAborts.set(sessionId, abortController);

	const history    = sessionHistory.get(sessionId) ?? [];
	const newHistory: ModelMessage[] = [...history, { role: "user", content }];
	sessionHistory.set(sessionId, newHistory);

	(async () => {
		let fullText = "";
		try {
			// Verify the agent is real, custom, enabled, and chat-enabled
			const agentRows = await db.select().from(agents).where(eq(agents.name, agentName)).limit(1);
			const agentRow = agentRows[0];
			if (!agentRow)                    throw new Error(`Agent "${agentName}" not found.`);
			if (agentRow.isBuiltin   === 1)   throw new Error(`Chat is only supported for custom agents.`);
			if (agentRow.isEnabled   !== 1)   throw new Error(`This agent is disabled.`);
			if (agentRow.chatEnabled !== 1)   throw new Error(`Chat is not enabled for this agent.`);

			const provider = await getProviderForAgent(agentRow);
			const modelId  = agentRow.modelId ?? provider.defaultModel ?? getDefaultModel(provider.providerType);
			const adapter  = createProviderAdapter({
				id:           provider.id,
				name:         provider.name,
				providerType: provider.providerType,
				apiKey:       provider.apiKey,
				baseUrl:      provider.baseUrl,
				defaultModel: provider.defaultModel,
			});

			// System prompt: getAgentSystemPrompt honours useSystemPromptOnly already.
			// Tools: getToolsForAgent honours the per-agent agent_tools rows.
			const [system, tools] = await Promise.all([
				getAgentSystemPrompt(agentName),
				getToolsForAgent(agentName),
			]);

			const result = streamText({
				model: adapter.createModel(modelId),
				system,
				messages:    newHistory,
				tools,
				stopWhen:    [stepCountIs(15)],
				abortSignal: abortController.signal,
			});

			for await (const part of result.fullStream) {
				if (part.type === "text-delta") {
					const text = (part as { text?: string }).text ?? "";
					fullText += text;
					broadcastToWebview("dashboardAgentChunk", { sessionId, agentName, messageId, token: text });
				} else if (part.type === "tool-call") {
					const tcInput = (part as Record<string, unknown>).input ?? (part as Record<string, unknown>).args;
					broadcastToWebview("dashboardAgentToolCall", { sessionId, agentName, toolName: part.toolName, args: tcInput });
				} else if (part.type === "error") {
					const err = (part as { error: unknown }).error;
					throw err instanceof Error ? err : new Error(String(err));
				}
			}

			if (!fullText.trim()) {
				let finalText = "";
				try { finalText = await result.text; } catch { /* not available */ }
				if (!finalText.trim()) {
					throw new Error("The AI model returned an empty response. Check your provider quota or switch to a different model.");
				}
				fullText = finalText;
				broadcastToWebview("dashboardAgentChunk", { sessionId, agentName, messageId, token: fullText });
			}

			if (fullText) {
				const updated = sessionHistory.get(sessionId) ?? newHistory;
				sessionHistory.set(sessionId, [...updated, { role: "assistant", content: fullText }]);
			}

			broadcastToWebview("dashboardAgentComplete", { sessionId, agentName, messageId, content: fullText });
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") return;
			if (err instanceof Error     && err.name === "AbortError") return;
			const errMsg = err instanceof Error ? err.message : String(err);
			broadcastToWebview("dashboardAgentError", { sessionId, agentName, error: errMsg });
		} finally {
			activeAborts.delete(sessionId);
		}
	})();

	return { messageId };
}

export function abortDashboardAgentMessage(params: { sessionId: string }): { success: boolean } {
	const ctrl = activeAborts.get(params.sessionId);
	if (ctrl) {
		ctrl.abort();
		activeAborts.delete(params.sessionId);
		return { success: true };
	}
	return { success: false };
}

export function clearDashboardAgentSession(params: { sessionId: string }): { success: boolean } {
	sessionHistory.delete(params.sessionId);
	activeAborts.get(params.sessionId)?.abort();
	activeAborts.delete(params.sessionId);
	return { success: true };
}
