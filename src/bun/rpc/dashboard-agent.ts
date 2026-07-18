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

import { streamText, isStepCount, type ModelMessage, tool } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { agents, aiProviders } from "../db/schema";
import { createProviderAdapter } from "../providers";
import { getDefaultModel } from "../providers/models";
import { isHaikuModel } from "../providers/claude-subscription";
import { getStreamingMode } from "../agents/streaming-mode";
import { createThrottledAccumulator } from "../agents/throttled-accumulator";
import { getAgentSystemPrompt } from "../agents/prompts";
import { getToolsForAgent } from "../agents/tools/index";
import { extractImagePayload } from "../agents/tools/screenshot";
import { broadcastToWebview } from "../engine-manager";
import { saveLastMessage, loadLastMessage, removeLastMessage, buildLastMsgInjection } from "../agents/last-msg-store";

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

// The SDK's query() takes a single prompt, not a ModelMessage[] — flatten the
// conversation history into a text transcript, same approach engine.ts uses
// for the PM's own CLI/SDK-routed transcript.
function flattenHistoryForCli(history: ModelMessage[]): string {
	return history.map((m) => {
		const text = typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? m.content.map((p) => (p && typeof p === "object" && "text" in p ? (p as { text?: string }).text ?? "" : "")).filter(Boolean).join("\n")
				: "";
		return `[${m.role}]\n${text}`;
	}).join("\n\n");
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
		let removedLastMsg = false;
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

			// System prompt: getAgentSystemPrompt honours useSystemPromptOnly already.
			// Tools: getToolsForAgent honours the per-agent agent_tools rows.
			const [systemBase, agentTools] = await Promise.all([
				getAgentSystemPrompt(agentName),
				getToolsForAgent(agentName),
			]);

			// Inject last saved message so the agent remembers its previous reply
			// even after the user clears the conversation.
			const lastMsg = loadLastMessage(agentName);
			const system = lastMsg ? systemBase + buildLastMsgInjection(lastMsg) : systemBase;

			// remove_last_message tool — custom dashboard agents only.
			const removeLastMsgTool = tool({
				description: "Delete your saved last message file so you can start fresh. Use this when the user explicitly asks you to forget your last message or reset your memory.",
				inputSchema: z.object({}),
				execute: async () => {
					const deleted = removeLastMessage(agentName);
					removedLastMsg = true;
					return deleted
						? "Your last saved message has been deleted. You will start fresh from the next reply."
						: "No saved last message was found — nothing to delete.";
				},
			});
			const tools = { ...agentTools, remove_last_message: removeLastMsgTool };
			const streamingMode = await getStreamingMode();
			const isFullStreaming = streamingMode === "full";
			const isNoStreaming = streamingMode === "none";

			// Claude Subscription's direct-HTTP OAuth path 429s for anything but
			// Haiku — non-Haiku models route through the official Agent SDK
			// instead (see providers/claude-subscription.ts / claude-subscription-cli-runner.ts).
			if (provider.providerType === "claude-subscription" && !isHaikuModel(modelId)) {
				const { runClaudeCliTask } = await import("../providers/claude-subscription-cli-runner");
				// onToolCallEnd only carries the callId, not the toolName — track it
				// from onToolCallStart so the image-tool-result broadcast below can
				// tell which tool produced a given result.
				const cliToolNameByCallId = new Map<string, string>();
				// Full Streaming only — broadcastToWebview appends client-side, so
				// only the slice new since the last throttled flush is ever sent.
				let flushedLength = 0;
				const textAcc = isFullStreaming ? createThrottledAccumulator((acc) => {
					const delta = acc.slice(flushedLength);
					flushedLength = acc.length;
					if (delta) broadcastToWebview("dashboardAgentChunk", { sessionId, agentName, messageId, token: delta });
				}) : null;
				const cliResult = await runClaudeCliTask({
					task: flattenHistoryForCli(newHistory),
					systemPrompt: system,
					tools,
					modelId,
					timeoutMs: 900_000,
					abortSignal: abortController.signal,
					verifyToolCall: false, // dashboard agent chat is general Q&A — a turn may legitimately need zero tool calls
					onText: (text) => {
						fullText += text;
						if (!isFullStreaming) broadcastToWebview("dashboardAgentChunk", { sessionId, agentName, messageId, token: text });
					},
					onReasoning: () => { /* dashboard agent chat doesn't surface reasoning today (same as the streamText path, which ignores 'reasoning' parts) */ },
					onTextToken: (delta) => textAcc?.push(delta),
					onRetract: () => { textAcc?.cancel(); flushedLength = 0; },
					onToolCallStart: (toolName, args) => {
						const callId = crypto.randomUUID();
						cliToolNameByCallId.set(callId, toolName);
						broadcastToWebview("dashboardAgentToolCall", { sessionId, agentName, callId, toolName, args });
						return callId;
					},
					onToolCallEnd: (callId, resultText, isError) => {
						const toolName = cliToolNameByCallId.get(callId);
						cliToolNameByCallId.delete(callId);
						// Only image tools carry a payload worth broadcasting today — avoid
						// blowing up widget state with every other tool's raw output.
						if (!isError && toolName && extractImagePayload(resultText)) {
							broadcastToWebview("dashboardAgentToolResult", { sessionId, agentName, messageId, callId, toolName, output: resultText });
						}
					},
				});
				textAcc?.flushNow();

				if (abortController.signal.aborted) return;
				if (cliResult.status === "cancelled") return;
				if (cliResult.status === "timeout") {
					throw Object.assign(new Error("This request hit the 15-minute time limit and was stopped. Send a follow-up to continue."), { name: "TimeoutError" });
				}
				if (cliResult.status === "failed") {
					throw new Error(cliResult.summary);
				}
				if (!fullText.trim()) fullText = cliResult.summary;
			} else {
				const adapter  = createProviderAdapter({
					id:           provider.id,
					name:         provider.name,
					providerType: provider.providerType,
					apiKey:       provider.apiKey,
					baseUrl:      provider.baseUrl,
					defaultModel: provider.defaultModel,
				});

				const result = streamText({
					model: adapter.createModel(modelId),
					instructions: system,
					messages:    newHistory,
					tools,
					toolsContext: { run_shell: { projectId: "", conversationId: "" }, request_human_input: { projectId: "" } } as never,
					stopWhen:    [isStepCount(100)],
					abortSignal: AbortSignal.any([abortController.signal, AbortSignal.timeout(900_000)]),
				});

				for await (const part of result.stream) {
					if (part.type === "text-delta") {
						const text = (part as { text?: string }).text ?? "";
						fullText += text;
						if (!isNoStreaming) broadcastToWebview("dashboardAgentChunk", { sessionId, agentName, messageId, token: text });
					} else if (part.type === "tool-call") {
						const tcInput = (part as Record<string, unknown>).input ?? (part as Record<string, unknown>).args;
						broadcastToWebview("dashboardAgentToolCall", { sessionId, agentName, callId: part.toolCallId, toolName: part.toolName, args: tcInput });
					} else if (part.type === "tool-result") {
						// Only image tools carry a payload worth broadcasting today — avoid
						// blowing up widget state with every other tool's raw output.
						const trOutput = (part as Record<string, unknown>).output ?? (part as Record<string, unknown>).result;
						const resultStr = typeof trOutput === "string" ? trOutput : JSON.stringify(trOutput);
						if (extractImagePayload(resultStr)) {
							broadcastToWebview("dashboardAgentToolResult", { sessionId, agentName, messageId, callId: part.toolCallId, toolName: part.toolName, output: resultStr });
						}
					} else if (part.type === "error") {
						const err = (part as { error: unknown }).error;
						throw err instanceof Error ? err : new Error(String(err));
					}
				}

				if (!fullText.trim()) {
					let finalText = "";
					try { finalText = await result.text; } catch { /* not available */ }
					if (finalText.trim()) {
						fullText = finalText;
						if (!isNoStreaming) broadcastToWebview("dashboardAgentChunk", { sessionId, agentName, messageId, token: fullText });
					}
				}
			}

			if (!fullText.trim()) {
				throw new Error("The AI model returned an empty response. Check your provider quota or switch to a different model.");
			}

			if (fullText) {
				const updated = sessionHistory.get(sessionId) ?? newHistory;
				sessionHistory.set(sessionId, [...updated, { role: "assistant", content: fullText }]);
				// Don't persist the confirmation reply after a removal — the file was
				// just deleted intentionally and we must not recreate it.
				if (!removedLastMsg) saveLastMessage(agentName, fullText);
			}

			broadcastToWebview("dashboardAgentComplete", { sessionId, agentName, messageId, content: fullText });
		} catch (err) {
			// User-initiated stop (or a superseding message) — swallow silently.
			if (err instanceof DOMException && err.name === "AbortError") return;
			if (err instanceof Error     && err.name === "AbortError") return;
			// 15-minute wall-clock guard fired — surface a clear message.
			const isTimeout = err instanceof Error && err.name === "TimeoutError";
			const errMsg = isTimeout
				? "This request hit the 15-minute time limit and was stopped. Send a follow-up to continue."
				: err instanceof Error ? err.message : String(err);
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
