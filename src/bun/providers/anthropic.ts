import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { getDefaultModel } from "./models";
import { PROVIDER_HEADERS } from "./headers";

const ANTHROPIC_MODELS = [
	"claude-opus-4-5",
	"claude-opus-4-20250514",
	"claude-sonnet-4-5",
	"claude-sonnet-4-20250514",
	"claude-haiku-4-5",
	"claude-haiku-4-20250514",
	"claude-3-5-sonnet-20241022",
	"claude-3-5-haiku-20241022",
	"claude-3-opus-20240229",
];

export class AnthropicAdapter implements ProviderAdapter {
	private config: ProviderConfig;
	private provider: ReturnType<typeof createAnthropic>;

	constructor(config: ProviderConfig) {
		this.config = config;
		this.provider = createAnthropic({
			apiKey: config.apiKey,
			headers: PROVIDER_HEADERS,
		});
	}

	createModel(modelId: string, _thinkingBudgetTokens?: number): LanguageModel {
		// Anthropic thinking is configured via providerOptions.anthropic in streamText.
		// Anthropic thinking configured via providerOptions; SDK surfaces via step.reasoningText.
		return this.provider(modelId);
	}

	async listModels(): Promise<string[]> {
		try {
			const response = await fetch("https://api.anthropic.com/v1/models", {
				headers: {
					"x-api-key": this.config.apiKey,
					"anthropic-version": "2023-06-01",
				},
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) return ANTHROPIC_MODELS;
			const data = await response.json() as { data?: Array<{ id: string }> };
			const models = (data.data ?? []).map((m) => m.id).sort();
			return models.length > 0 ? models : ANTHROPIC_MODELS;
		} catch {
			return ANTHROPIC_MODELS;
		}
	}

	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			const modelId = this.config.defaultModel ?? getDefaultModel("anthropic");
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
