import type { Instructions, ModelMessage } from "ai";
import { getAllTools } from "./tools/index";
import type { AgentConfig, AgentTask, AgentActivityEvent } from "./types";

// ---------------------------------------------------------------------------
// Plugin tools helper
// ---------------------------------------------------------------------------

/** Returns only plugin-registered tools from the registry (category === "plugin"). */
export async function getPluginTools(): Promise<Record<string, import("ai").Tool>> {
	const { getPluginInstances } = await import("../plugins");
	const instances = getPluginInstances();
	const all = getAllTools();
	const pluginToolNames = new Set(
		instances.flatMap((inst) => inst.registeredTools),
	);
	const result: Record<string, import("ai").Tool> = {};
	for (const [name, tool] of Object.entries(all)) {
		if (pluginToolNames.has(name)) result[name] = tool;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Thinking budget helpers
// ---------------------------------------------------------------------------

// Still used by the "custom" provider's separate, complementary model-creation
// -time thinking injection (see ProviderAdapter.createModel()'s
// thinkingBudgetTokens param) — that mechanism solves a different problem
// (some self-hosted models need a non-standard enable_thinking-style flag
// baked into model config, not expressible via a per-call option) and is
// unaffected by the reasoning-option migration below.
export const THINKING_BUDGET_TOKENS: Record<string, number> = {
	low: 2000,
	medium: 8000,
	high: 16000,
};

const REASONING_LEVELS = new Set(["low", "medium", "high"]);

/**
 * AI SDK v7 unified `reasoning` option (§6.5) — provider-agnostic, replacing
 * the old per-provider `providerOptions.anthropic.thinking` branching.
 * Confirmed (by reading each provider package's own source, not just docs)
 * that @ai-sdk/anthropic, @ai-sdk/openai, @ai-sdk/openai-compatible (covers
 * Ollama/OpenCode/OpenRouter/Z.AI), @ai-sdk/google, @ai-sdk/groq,
 * @ai-sdk/deepseek, and @ai-sdk/xai all forward it — unsupported
 * providers/models just get a non-fatal `warnings` entry (routed through
 * installAiSdkWarningHandler()), not an error.
 *
 * Known, accepted behavior change for Anthropic specifically: the SDK maps
 * reasoning levels to a PERCENTAGE of maxOutputTokens (10/30/60% for
 * low/medium/high) rather than AgentDesk's old fixed token counts
 * (2000/8000/16000) — so actual thinking depth per level now scales with
 * whatever maxOutputTokens the call resolves to, instead of being constant.
 */
export function buildReasoningOptions(budget: string | null): Record<string, unknown> {
	if (!budget || !REASONING_LEVELS.has(budget)) return {};
	return { reasoning: budget };
}

export function extractPMReasoning(stepResult: unknown): string {
	const step = stepResult as Record<string, unknown>;
	if (typeof step.reasoningText === "string" && step.reasoningText) return step.reasoningText;

	const meta = step.providerMetadata as Record<string, unknown> | undefined;
	if (!meta) return "";
	for (const ns of ["anthropic", "openrouter", "openai"]) {
		const nsMeta = meta[ns] as Record<string, unknown> | undefined;
		if (!nsMeta) continue;
		if (typeof nsMeta.reasoning === "string" && nsMeta.reasoning) return nsMeta.reasoning;
		// @ai-sdk/openai maps reasoning_content → reasoningContent (camelCase) in providerMetadata
		if (typeof nsMeta.reasoningContent === "string" && nsMeta.reasoningContent) return nsMeta.reasoningContent;
		if (Array.isArray(nsMeta.thinking)) {
			const text = (nsMeta.thinking as Array<Record<string, unknown>>)
				.filter((b) => b.type === "thinking" && typeof b.thinking === "string")
				.map((b) => b.thinking as string)
				.join("\n");
			if (text) return text;
		}
	}
	return "";
}

// ---------------------------------------------------------------------------
// Anthropic prompt caching
// ---------------------------------------------------------------------------

/**
 * For Anthropic, OpenRouter, and Claude Subscription (Haiku direct-HTTP sub-path
 * only — the CLI/SDK bridge for Sonnet/Opus never reaches this function at all,
 * see isClaudeSubscriptionViaCli in engine.ts) providers, passes the system
 * prompt as a `SystemModelMessage` (via `instructions`) with cacheControl
 * metadata. This enables Anthropic's prompt caching (~90% cheaper on cache hits).
 *
 * AI SDK v7 rejects a `role: "system"` entry inside `messages` outright
 * (`AI_InvalidPromptError: System messages are not allowed in the prompt or
 * messages fields. Use the instructions option instead.`) — `instructions`
 * accepts a plain string OR a `SystemModelMessage`/array thereof specifically
 * so provider options like cacheControl can still be attached. Do not go back
 * to prepending a system-role message to `messages`.
 *
 * For other providers, returns the inputs unchanged.
 */
export function applyAnthropicCaching(
	providerType: string,
	system: string,
	messages: ModelMessage[],
): { instructions: Instructions | undefined; messages: ModelMessage[] } {
	if (providerType !== "anthropic" && providerType !== "openrouter" && providerType !== "claude-subscription") {
		return { instructions: system, messages };
	}

	return {
		instructions: {
			role: "system",
			content: system,
			providerOptions: {
				anthropic: { cacheControl: { type: "ephemeral" } },
			},
		},
		messages,
	};
}

// ---------------------------------------------------------------------------
// Message source metadata
// ---------------------------------------------------------------------------

export interface MessageMetadata {
	/** Where the message originated from. Defaults to "app". */
	source: "app" | "discord" | "whatsapp" | "email";
	/** External channel ID (Discord channel, WhatsApp number, etc.) */
	channelId?: string;
	/** Sender username on the external platform */
	username?: string;
}

export const DEFAULT_METADATA: MessageMetadata = { source: "app" };

// ---------------------------------------------------------------------------
// Engine callbacks
// ---------------------------------------------------------------------------

export interface AgentEngineCallbacks {
	onStreamToken(
		conversationId: string,
		messageId: string,
		token: string,
		agentId: string | null,
	): void;
	onStreamComplete(
		conversationId: string,
		messageId: string,
		usage: { content: string; promptTokens: number; completionTokens: number; metadata?: string | null },
	): void;
	onStreamReset(conversationId: string, messageId: string): void;
	onStreamError(conversationId: string, error: string): void;
	onAgentActivity?(event: AgentActivityEvent): void;
	onNewMessage?(params: {
		conversationId: string;
		messageId: string;
		agentId: string;
		agentName: string;
		content: string;
		metadata: string;
	}): void;
	onAgentStatus(
		projectId: string,
		agentId: string,
		status: "spawned" | "running" | "paused" | "completed" | "failed" | "cancelled",
	): void;
	onPresentPlan?(projectId: string, plan: { title: string; content: string; conversationId: string }): void;
	onKanbanTaskMove?(projectId: string, taskId: string, column: string): void;
	onPartCreated?(conversationId: string, part: import("./agent-loop").MessagePart): void;
	onPartUpdated?(conversationId: string, messageId: string, partId: string, updates: Partial<import("./agent-loop").MessagePart>): void;
	onAgentInlineStart?(conversationId: string, messageId: string, agentName: string, agentDisplayName: string, task: string): void;
	onAgentInlineComplete?(conversationId: string, messageId: string, agentName: string, status: string, summary: string, tokensUsed?: { prompt: number; completion: number; contextLimit?: number }): void;
	/** Live context size (real prompt tokens) emitted each step by the PM or a sub-agent, so the meter climbs in real time. */
	onContextUsage?(conversationId: string, promptTokens: number, contextLimit: number): void;
	/** Per-step streaming throughput (§9.2), emitted from streamText's onLanguageModelCallEnd once each language-model call completes. */
	onStreamPerformance?(conversationId: string, tokensPerSecond: number, timeToFirstOutputMs: number | undefined): void;
	onConversationTitleChanged?(conversationId: string, title: string): void;
	onConversationUpdated?(conversationId: string, updatedAt: string): void;
	onConversationCompacted?(conversationId: string, remainingTokens?: number): void;
	onCompactionStarted?(conversationId: string): void;
	/** A message was queued (not sent) because a DIFFERENT conversation's PM turn is genuinely still in flight for this project — see sendMessage()'s busy-conversation guard. Lets the frontend reflect the queue if it's viewing this conversation. */
	onMessageQueued?(conversationId: string, queue: Array<{ id: string; conversationId: string; content: string; queuedAt: number }>): void;
	/** Ask the user a question via modal dialog (app source only). */
	askUserQuestion?(payload: {
		question: string;
		inputType: "choice" | "text" | "confirm" | "multi_select";
		options?: string[];
		placeholder?: string;
		defaultValue?: string;
		context?: string;
		projectId: string;
		agentId: string;
		agentName: string;
	}): Promise<string>;
}

// ---------------------------------------------------------------------------
// Internal queue entry
// ---------------------------------------------------------------------------

export interface PreviousFailureContext {
	errorSummary: string;
	lastToolCalls?: string[];
	partialOutput?: string;
}

export interface QueueEntry {
	config: AgentConfig;
	task: AgentTask;
	previousFailure?: PreviousFailureContext;
}
