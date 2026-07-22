// ---------------------------------------------------------------------------
// General Chat orchestrator
//
// Runs the standalone "general-chat-assistant" agent via runInlineAgent — fully decoupled
// from the PM, kanban, and review-cycle paths (mirrors the Playground's use
// of runInlineAgent directly). Conversation history is DB-backed
// (general_chat_messages) but flat: tool-call activity streams live via
// callbacks and is NEVER persisted. The user's message row is written UP FRONT
// (before the agent run) so leaving/refreshing the page mid-turn still shows it;
// the assistant's final text row is appended once the turn completes.
// ---------------------------------------------------------------------------

import { generateText } from "ai";
import { eq, asc, inArray } from "drizzle-orm";
import type { ModelMessage, Tool } from "ai";
import { runInlineAgent, type InlineAgentCallbacks, type MessagePart } from "../agents/agent-loop";
import type { ProviderConfig } from "../providers/types";
import { getDefaultModel, getContextLimit } from "../providers/models";
import { createProviderAdapter } from "../providers";
import { internalCallModelId } from "../providers/claude-subscription";
import { getSetting } from "../rpc/settings";
import { getGeneralChatStreamingMode } from "../agents/streaming-mode";
import { getProjectSettings } from "../rpc/projects";
import { db } from "../db";
import { aiProviders, generalChatConversations, generalChatMessages } from "../db/schema";
import { broadcastToWebview, isAppFocused } from "../engine-manager";
import { sendDesktopNotification } from "../notifications/desktop";
import { createGeneralChatMemoryTools } from "../agents/tools/general-chat-memory";
import { createGeneralChatTodoTools, clearGeneralChatTodos } from "../agents/tools/general-chat-todos";
import { createGeneralChatCodeExecTool } from "../agents/tools/general-chat-code-exec";
import { extractImagePayload } from "../agents/tools/screenshot";
import { getGeneralChatWorkspacePath } from "./paths";

// Tools whose successful output is an image the assistant itself produced
// (not one the user attached — read_image is deliberately excluded, that's
// the assistant *viewing* an existing attachment, not creating new visual
// output). Their base64 payload gets embedded into the persisted message so
// it survives a reload — general_chat_messages has no parts table to persist
// live tool-call activity into, unlike project chat's message_parts.
// take_screenshot isn't in this set — it's not in the Assistant's tool grant
// (defaultAgentTools["general-chat-assistant"], seed.ts) at all. execute_code
// only actually returns an `image` payload when the script printed one (see
// general-chat-code-exec.ts) — extractImagePayload returns null otherwise,
// so a plain calculation/data-processing run is unaffected.
const IMAGE_OUTPUT_TOOLS = new Set(["generate_image", "execute_code"]);

// Keep conversation history bounded so context stays manageable across many turns.
const MAX_HISTORY_TURNS = 60;

// Per-conversationId AbortController registry — supports stop generation mid-turn.
const abortControllers = new Map<string, AbortController>();

// Last real prompt-token usage per conversation, from runInlineAgent's own
// result.tokensUsed.prompt — mirrors AgentEngine.lastPromptTokens (engine.ts),
// the signal _runPMProcessing checks each turn to decide whether to
// auto-compact before proceeding. runInlineAgent itself is stateless across
// calls, so this Map is the one piece of cross-turn memory the orchestrator
// has to track on its own.
const lastPromptTokens = new Map<string, number>();

export function isGeneralChatRunning(conversationId: string): boolean {
	return abortControllers.has(conversationId);
}

/** Abort the in-flight run for a conversation (if any). */
export function stopGeneralChatGeneration(conversationId: string): void {
	abortControllers.get(conversationId)?.abort();
}

// ---------------------------------------------------------------------------
// Provider resolution — mirrors the Playground's resolveProviderConfig, plus
// a per-conversation override. The ModelSelector component is reused as-is
// for General Chat with `projectId={conversationId}` (see general-chat.tsx),
// so it persists via the REAL rpc.saveProjectSetting(conversationId, "chatProviderId"/
// "chatModelId", ...) convention (settings key `project:<conversationId>:chat*`) —
// read back here the same way project chat resolves its own model override.
// ---------------------------------------------------------------------------

export async function resolveProviderConfig(conversationId: string): Promise<{ config: ProviderConfig; modelId: string }> {
	const projectSettings = await getProjectSettings(conversationId);
	const overrideProviderId = projectSettings.chatProviderId;
	const overrideModelId = projectSettings.chatModelId;

	let providerRow: typeof aiProviders.$inferSelect | undefined;
	if (overrideProviderId) {
		providerRow = (await db.select().from(aiProviders).where(eq(aiProviders.id, overrideProviderId)).limit(1))[0];
	}
	if (!providerRow) providerRow = (await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1))[0];
	if (!providerRow) providerRow = (await db.select().from(aiProviders).limit(1))[0];
	if (!providerRow) throw new Error("No AI provider configured. Add one in Settings → Providers first.");

	const modelId = overrideModelId || providerRow.defaultModel || getDefaultModel(providerRow.providerType);

	return {
		config: {
			id: providerRow.id,
			name: providerRow.name,
			providerType: providerRow.providerType,
			apiKey: providerRow.apiKey ?? "",
			baseUrl: providerRow.baseUrl ?? null,
			defaultModel: providerRow.defaultModel ?? null,
		},
		modelId,
	};
}

// ---------------------------------------------------------------------------
// Prior history — loaded from general_chat_messages (flat, final-text only).
// ---------------------------------------------------------------------------

async function loadPriorMessages(conversationId: string): Promise<ModelMessage[]> {
	const rows = await db
		.select({ role: generalChatMessages.role, content: generalChatMessages.content })
		.from(generalChatMessages)
		.where(eq(generalChatMessages.conversationId, conversationId))
		.orderBy(asc(generalChatMessages.createdAt));

	const trimmed = rows.slice(-MAX_HISTORY_TURNS);
	return trimmed.map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

// ---------------------------------------------------------------------------
// Compaction — shared by the manual `/compact` slash command (rpc/general-chat.ts)
// and the automatic pre-turn threshold check in sendMessage() below. Lighter
// than agents/summarizer.ts's project-chat version: general_chat_messages is
// already flat (no parts table to prune), so this is a single generateText
// call over everything but the most recent COMPACT_KEEP_RECENT messages,
// which get deleted and replaced with one condensed assistant message.
// ---------------------------------------------------------------------------

const COMPACT_KEEP_RECENT = 10;
const COMPACT_MAX_TRANSCRIPT_CHARS = 30_000;

const COMPACT_SYSTEM_PROMPT =
	"You are a conversation compaction engine. Produce a single, dense summary of the " +
	"conversation below that preserves everything needed to continue it without loss of " +
	"context: topics discussed, decisions made, facts established, and any open questions " +
	"or unfinished threads. Do not include pleasantries or meta-commentary. Write in compact " +
	"bullet/section format. Be thorough — anything you omit will be permanently lost.";

export async function compactConversation(conversationId: string): Promise<{ success: boolean; message?: string }> {
	const rows = await db
		.select({ id: generalChatMessages.id, role: generalChatMessages.role, content: generalChatMessages.content, createdAt: generalChatMessages.createdAt })
		.from(generalChatMessages)
		.where(eq(generalChatMessages.conversationId, conversationId))
		.orderBy(asc(generalChatMessages.createdAt));

	if (rows.length <= COMPACT_KEEP_RECENT) {
		return { success: false, message: `Not enough messages to compact (need more than ${COMPACT_KEEP_RECENT})` };
	}

	const toCompact = rows.slice(0, rows.length - COMPACT_KEEP_RECENT);
	const transcript = toCompact
		.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
		.join("\n\n")
		.slice(-COMPACT_MAX_TRANSCRIPT_CHARS);

	const { config, modelId } = await resolveProviderConfig(conversationId);
	const adapter = createProviderAdapter(config);
	const model = adapter.createModel(internalCallModelId(config.providerType, modelId));

	const result = await generateText({
		model,
		instructions: COMPACT_SYSTEM_PROMPT,
		messages: [{ role: "user", content: `Conversation to compact:\n\n${transcript}` }],
	});
	const summary = result.text.trim();
	if (!summary) return { success: false, message: "Compaction produced an empty summary" };

	const compactedIds = toCompact.map((m) => m.id);
	await db.delete(generalChatMessages).where(inArray(generalChatMessages.id, compactedIds));
	await db.insert(generalChatMessages).values({
		conversationId,
		role: "assistant",
		content: `## Conversation summary (compacted)\n\n${summary}`,
		metadata: JSON.stringify({ modelId }),
		createdAt: toCompact[0].createdAt,
	});

	// Recompute a char-based estimate over what's left (kept messages + the new
	// summary row) so the next pre-turn threshold check doesn't immediately
	// re-trigger on the stale pre-compaction peak — mirrors engine.ts's
	// triggerSummarization, which does the same thing to its own lastPromptTokens.
	const remainingRows = await db
		.select({ content: generalChatMessages.content })
		.from(generalChatMessages)
		.where(eq(generalChatMessages.conversationId, conversationId));
	const remainingTokens = remainingRows.reduce((sum, m) => sum + Math.ceil((m.content?.length ?? 0) / 4), 0);
	lastPromptTokens.set(conversationId, remainingTokens);

	broadcastToWebview("generalChatCompacted", { conversationId });
	return { success: true };
}

function serializePart(part: MessagePart) {
	return {
		id: part.id,
		type: part.type,
		content: part.content,
		toolName: part.toolName,
		toolInput: part.toolInput,
		toolOutput: part.toolOutput,
		toolState: part.toolState,
		sortOrder: part.sortOrder,
		timeStart: part.timeStart,
		timeEnd: part.timeEnd,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SendMessageResult {
	status: "completed" | "failed" | "cancelled" | "context_full" | "timeout";
	assistantText: string;
}

/**
 * Run the Assistant agent on a user message for one General Chat conversation.
 * Tool-call activity streams live via broadcastToWebview (generalChatPart*) and
 * is NEVER persisted. The user's message row is written before the run starts
 * (so a mid-turn reload still shows it); the assistant's final text row is
 * appended once the turn completes.
 */
export async function sendMessage(conversationId: string, userText: string): Promise<SendMessageResult> {
	if (abortControllers.has(conversationId)) {
		throw new Error("A response is already being generated for this conversation. Stop it first.");
	}

	// Wall-clock time for this whole turn (compaction + agent run) — persisted on
	// the assistant row's metadata and broadcast so general-chat.tsx can show a
	// "Worked Xs" readout once the reply lands, mirroring project chat's agent
	// card duration (message-parts.tsx's AgentStartBlock).
	const turnStartedAt = Date.now();

	const convRows = await db
		.select({ deepResearchMode: generalChatConversations.deepResearchMode, title: generalChatConversations.title })
		.from(generalChatConversations)
		.where(eq(generalChatConversations.id, conversationId))
		.limit(1);
	if (convRows.length === 0) throw new Error(`No General Chat conversation with id '${conversationId}'`);
	const deepResearchMode = convRows[0].deepResearchMode === 1;

	// Auto-title from the first real user message — mirrors engine.ts's
	// autoTitleConversation for project chat (same truncation rule, no source
	// prefix since General Chat has no Discord/WhatsApp/email channels).
	// Fires before the turn starts (not after it completes) so the sidebar/
	// header title update lands immediately, same as project chat.
	if (convRows[0].title === "New conversation") {
		const rawTitle = userText.trim().replace(/\s+/g, " ");
		const title = rawTitle.length <= 40 ? rawTitle : rawTitle.slice(0, 37) + "...";
		if (title) {
			await db.update(generalChatConversations).set({ title }).where(eq(generalChatConversations.id, conversationId));
			broadcastToWebview("generalChatConversationRenamed", { conversationId, title });
		}
	}

	const abortController = new AbortController();
	abortControllers.set(conversationId, abortController);
	broadcastToWebview("generalChatRunStarted", { conversationId });

	try {
		const { config, modelId } = await resolveProviderConfig(conversationId);

		// Automatic, threshold-based compaction — mirrors AgentEngine._runPMProcessing
		// (engine.ts), which checks lastPromptTokens against getContextLimit at the
		// start of every PM turn and auto-compacts before proceeding, independent of
		// the user ever typing /compact. Best-effort: a failure here must not block
		// the turn from proceeding on its (oversized) existing context.
		const limit = getContextLimit(modelId, conversationId);
		if ((lastPromptTokens.get(conversationId) ?? 0) >= limit) {
			await compactConversation(conversationId).catch((err) => {
				console.error(`[general-chat] Auto-compaction failed for ${conversationId}:`, err);
			});
		}

		const priorMessages = await loadPriorMessages(conversationId);
		const workspacePath = getGeneralChatWorkspacePath(conversationId);

		// Persist the user's message NOW — before the (potentially long) agent run,
		// not at completion. Otherwise leaving/refreshing the page mid-turn reloads
		// from general_chat_messages and finds no user row yet, so the message the
		// user just sent vanishes until the turn finishes (only the live optimistic
		// bubble held it, and a reload throws that away). Inserted AFTER
		// loadPriorMessages so this turn's message isn't double-counted (it's passed
		// separately as `task`). The id is pre-generated so the completion broadcast
		// can hand the frontend the real persisted row id for its hover actions.
		const userMessageId = crypto.randomUUID();
		await db.insert(generalChatMessages).values({ id: userMessageId, conversationId, role: "user", content: userText });

		const extraTools: Record<string, Tool> = {
			...createGeneralChatMemoryTools(),
			...createGeneralChatTodoTools(conversationId),
			...createGeneralChatCodeExecTool(workspacePath),
		};
		if (deepResearchMode) {
			const { createDeepResearchTool } = await import("../agents/tools/deep-research");
			const dr = createDeepResearchTool({ providerConfig: config, modelId });
			if (dr.deep_research) extraTools.deep_research = dr.deep_research.tool;
		}

		// Tracks tool_call partId -> toolName (from onPartCreated) so onPartUpdated
		// (which only carries toolOutput, not toolName) can tell whether a
		// successful result is an image-producing tool's — see IMAGE_OUTPUT_TOOLS.
		const toolNameByPartId = new Map<string, string>();
		// Collected in call order; embedded into the persisted assistant message
		// once the turn completes so generated images survive a reload.
		const generatedImages: Array<{ base64: string; mimeType: string }> = [];

		const callbacks: InlineAgentCallbacks = {
			onPartCreated: (part) => {
				if (part.type === "tool_call" && part.toolName) toolNameByPartId.set(part.id, part.toolName);
				broadcastToWebview("generalChatPart", { conversationId, part: serializePart(part) });
			},
			onPartUpdated: (_messageId, partId, updates) => {
				if (updates.toolState === "success" && updates.toolOutput) {
					const toolName = toolNameByPartId.get(partId);
					if (toolName && IMAGE_OUTPUT_TOOLS.has(toolName)) {
						const payload = extractImagePayload(updates.toolOutput);
						if (payload) generatedImages.push(payload);
					}
				}
				broadcastToWebview("generalChatPartUpdated", {
					conversationId,
					partId,
					updates: {
						content: updates.content,
						toolOutput: updates.toolOutput,
						toolState: updates.toolState,
						timeEnd: updates.timeEnd,
					},
				});
			},
			onTextDelta: (_messageId, delta) => {
				broadcastToWebview("generalChatTextDelta", { conversationId, delta });
			},
			onPartsRemoved: (_messageId, partIds) => {
				broadcastToWebview("generalChatPartsRemoved", { conversationId, partIds });
			},
			// Live tokens/sec readout next to the context meter — mirrors project
			// chat's ContextIndicator (chat-event-handlers.ts's onStreamPerformance),
			// fed by the same generic InlineAgentCallbacks.onStreamPerformance
			// runInlineAgent already calls for every caller, not just the PM engine.
			onStreamPerformance: (tokensPerSecond, timeToFirstOutputMs) => {
				broadcastToWebview("generalChatStreamPerformance", { conversationId, tokensPerSecond, timeToFirstOutputMs });
			},
			// Live context-bar updates while the turn runs (real usage from the
			// model's own step, not a char/4 guess) — mirrors project chat's
			// ContextIndicator, fed the same way via AgentEngine.onStepUsage.
			onStepUsage: (promptTokens, contextLimit) => {
				broadcastToWebview("generalChatContextUsage", { conversationId, promptTokens, contextLimit });
			},
			onAgentStart: () => {
				/* no-op — General Chat has a single agent, no sub-agent card to show */
			},
			onAgentComplete: () => {
				/* no-op — completion is handled below once runInlineAgent resolves */
			},
		};

		// General Chat runs through runInlineAgent directly, the same mechanism
		// Playground/sub-agent cards use — NOT the separate direct-streamText
		// forwarding PM chat and the six widget-chat surfaces use for their own
		// live-streaming behavior. It uses its OWN streaming preference (the
		// General Chat header gear-icon settings dialog), independent of the global
		// streamingMode. Its three modes ("full"/"chunked"/"none") are all valid
		// StreamingMode values, so we pass the choice straight through as the
		// override — runInlineAgent derives the flush cadence from it centrally
		// (streamingFlushArgs), same as every other surface.
		const streamingModeOverride = await getGeneralChatStreamingMode();

		const result = await runInlineAgent({
			// The conversationId doubles as "projectId" — gives run_shell's approval
			// gate and ModelSelector's persisted settings (chatProviderId/chatModelId/
			// shellApprovalMode, all keyed by projectId) real per-conversation scoping,
			// exactly like a normal project chat. Safe: agent-loop.ts's per-project
			// memory-tool overlay explicitly excludes agentName==="general-chat-assistant"
			// (see its comment there) so this doesn't clobber the Assistant-exclusive
			// memory tools injected above.
			projectId: conversationId,
			conversationId,
			agentName: "general-chat-assistant",
			agentDisplayName: "Assistant",
			task: userText,
			projectContext: "",
			providerConfig: config,
			modelId,
			callbacks,
			workspacePath,
			persistToDb: false,
			priorMessages,
			extraTools,
			deepResearchMode,
			// Most General Chat turns are plain conversation ("hi", explaining
			// something from context) that legitimately need zero tool calls —
			// runInlineAgent's default assumes every task is a concrete, actionable
			// sub-agent job (correct for the Playground), which is the wrong
			// assumption here. Mirrors PM chat's own verifyToolCall: false in
			// engine.ts (see agent-loop.ts's InlineAgentOptions.verifyToolCall doc).
			verifyToolCall: false,
			abortSignal: abortController.signal,
			streamingModeOverride,
		});

		// general_chat_messages has no parts table (tool-call activity is never
		// persisted), so any image the assistant generated this turn is embedded
		// directly into the persisted text as a <generated-image> block —
		// GeneralChatBubble (general-chat.tsx) extracts it back out into a real
		// <img> at render time, the same way it strips attachment wrapper text.
		const imageBlocks = generatedImages
			.map((img) => `\n<generated-image mime="${img.mimeType}">${img.base64}</generated-image>\n`)
			.join("");
		const finalContent = imageBlocks ? `${result.summary}\n${imageBlocks}` : result.summary;

		// Explicit id (rather than relying on the schema's $defaultFn) so the
		// broadcast below can hand the frontend the REAL, persisted message id
		// straight away — general-chat.tsx's hover action row (delete/fork/
		// retry) needs the actual DB row id, not a client-generated placeholder.
		// The user row was already persisted before the run (see above); here we
		// only append the assistant's reply.
		const assistantMessageId = crypto.randomUUID();
		const durationMs = Date.now() - turnStartedAt;
		await db.insert(generalChatMessages).values([
			// status: only meaningful when "failed" — general-chat.tsx reads it to
			// render this bubble as a red error card with a Retry button, matching
			// project chat's message-bubble.tsx isError treatment. Unlike project
			// chat's PM loop (engine.ts), which keeps a failed turn as a purely
			// client-side, never-persisted `role: "error"` bubble, General Chat
			// always persists a real assistant row here (success or failure) — so
			// the DB content itself carries agent-loop.ts's generic "Failed: ..."
			// prefix (see runInlineAgent) and needs this flag to be distinguishable.
			{ id: assistantMessageId, conversationId, role: "assistant", content: finalContent, metadata: JSON.stringify({ modelId, status: result.status, durationMs }) },
		]);
		await db
			.update(generalChatConversations)
			.set({ updatedAt: new Date().toISOString() })
			.where(eq(generalChatConversations.id, conversationId));

		// Real prompt-token usage from this turn — checked at the start of the
		// NEXT sendMessage call to decide whether to auto-compact first.
		lastPromptTokens.set(conversationId, result.tokensUsed.prompt);

		broadcastToWebview("generalChatComplete", {
			conversationId,
			status: result.status,
			assistantText: finalContent,
			userMessageId,
			assistantMessageId,
			modelId,
			promptTokens: result.tokensUsed.prompt,
			contextLimit: limit,
			durationMs,
		});

		if (!isAppFocused()) {
			// getSetting JSON-parses the stored value, so this is really a plain boolean
			// (or null when never set — defaults to enabled, mirroring engine-manager.ts).
			const enabled = (await getSetting("session_complete_notification")) !== false;
			if (enabled) {
				sendDesktopNotification(
					"General Chat — Response Ready",
					result.summary.slice(0, 150) || "Assistant has responded.",
				).catch(() => {});
			}
		}

		return { status: result.status, assistantText: finalContent };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		broadcastToWebview("generalChatRunError", { conversationId, error: message });
		throw err;
	} finally {
		abortControllers.delete(conversationId);
		clearGeneralChatTodos(conversationId);
	}
}
