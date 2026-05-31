import type { LanguageModel } from "ai";

export interface ProviderConfig {
	id: string;
	name: string;
	providerType: string;
	apiKey: string;
	baseUrl: string | null;
	defaultModel: string | null;
}

export interface ProviderAdapter {
	/**
	 * Create a language model instance.
	 * @param modelId  The model identifier to use.
	 * @param thinkingBudgetTokens  When set, the adapter should enable thinking/reasoning
	 *   with this token budget. Anthropic: handled via providerOptions in streamText.
	 *   OpenAI-compatible (custom): injected into HTTP body. In AI SDK v6, reasoning
	 *   is surfaced natively via step.reasoningText — no manual SSE parsing needed.
	 */
	createModel(modelId: string, thinkingBudgetTokens?: number): LanguageModel;
	listModels(): Promise<string[]>;
	testConnection(): Promise<{ success: boolean; error?: string }>;
}
