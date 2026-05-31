import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { getDefaultModel } from "./models";
import { PROVIDER_HEADERS } from "./headers";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const OPENROUTER_MODELS = [
	"anthropic/claude-sonnet-4-5",
	"anthropic/claude-opus-4-5",
	"anthropic/claude-haiku-4-5",
	"openai/gpt-4o",
	"openai/gpt-4o-mini",
	"openai/o1",
	"openai/o3",
	"google/gemini-2.0-flash-001",
	"google/gemini-2.5-pro-preview",
	"meta-llama/llama-3.3-70b-instruct",
	"mistralai/mistral-large-2411",
	"x-ai/grok-3",
];

export class OpenRouterAdapter implements ProviderAdapter {
	private config: ProviderConfig;
	private provider: ReturnType<typeof createOpenAICompatible>;

	constructor(config: ProviderConfig) {
		this.config = config;
		this.provider = createOpenAICompatible({
			name: "openrouter",
			apiKey: config.apiKey,
			baseURL: OPENROUTER_BASE_URL,
			headers: PROVIDER_HEADERS,
		});
	}

	createModel(modelId: string, _thinkingBudgetTokens?: number): LanguageModel {
		return this.provider(modelId);
	}

	async listModels(): Promise<string[]> {
		return OPENROUTER_MODELS;
	}

	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			const modelId = this.config.defaultModel ?? getDefaultModel("openrouter");
			await generateText({
				model: this.createModel(modelId),
				prompt: "Hi",
				maxOutputTokens: 5,
				abortSignal: AbortSignal.timeout(15_000),
			});
			return { success: true };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return { success: false, error };
		}
	}
}
