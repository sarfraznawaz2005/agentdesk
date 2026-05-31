import type { ModelMessage } from "ai";
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

export const THINKING_BUDGET_TOKENS: Record<string, number> = {
	low: 2000,
	medium: 8000,
	high: 16000,
};

export function buildPMThinkingOptions(budget: string | null, providerType: string): Record<string, unknown> {
	if (!budget) return {};
	const budgetTokens = THINKING_BUDGET_TOKENS[budget] ?? 8000;
	const safeMaxTokens = budgetTokens + 1000;

	if (providerType === "anthropic") {
		return {
			maxTokens: safeMaxTokens,
			providerOptions: {
				anthropic: { thinking: { type: "enabled", budgetTokens } },
			},
		};
	}

	if (providerType === "openrouter") {
		// OpenRouter proxies Claude and forwards anthropic providerOptions
		return {
			maxTokens: safeMaxTokens,
			providerOptions: {
				anthropic: { thinking: { type: "enabled", budgetTokens } },
			},
		};
	}

	if (providerType === "custom") {
		// enable_thinking is injected at model creation level via OpenAIAdapter.createModel()
		return { maxTokens: safeMaxTokens };
	}

	return {};
}

export function extractPMReasoning(stepResult: unknown): string {
	const step = stepResult as Record<string, unknown>;
	if (typeof step.reasoningText === "string" && step.reasoningText) return step.reasoningText;

	const meta = step.experimental_providerMetadata as Record<string, unknown> | undefined;
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
 * For Anthropic and OpenRouter providers, moves the system prompt into
 * a system-role message at the front of `messages` with cacheControl metadata.
 * This enables Anthropic's prompt caching (~90% cheaper on cache hits).
 *
 * For other providers, returns the inputs unchanged.
 */
export function applyAnthropicCaching(
	providerType: string,
	system: string,
	messages: ModelMessage[],
): { system: string | undefined; messages: ModelMessage[] } {
	if (providerType !== "anthropic" && providerType !== "openrouter") {
		return { system, messages };
	}

	const systemMessage: ModelMessage = {
		role: "system",
		content: system,
		providerOptions: {
			anthropic: { cacheControl: { type: "ephemeral" } },
		},
	};

	return {
		system: undefined,
		messages: [systemMessage, ...messages],
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
	onConversationTitleChanged?(conversationId: string, title: string): void;
	onConversationUpdated?(conversationId: string, updatedAt: string): void;
	onConversationCompacted?(conversationId: string, remainingTokens?: number): void;
	onCompactionStarted?(conversationId: string): void;
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
