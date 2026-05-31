import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { getDefaultModel } from "./models";
import { PROVIDER_HEADERS } from "./headers";

const FALLBACK_MODELS = [
	"deepseek-chat",
	"deepseek-reasoner",
];

export class DeepSeekAdapter implements ProviderAdapter {
	private config: ProviderConfig;
	private provider: ReturnType<typeof createDeepSeek>;

	constructor(config: ProviderConfig) {
		this.config = config;
		this.provider = createDeepSeek({
			apiKey: config.apiKey,
			headers: PROVIDER_HEADERS,
		});
	}

	createModel(modelId: string): LanguageModel {
		return this.provider(modelId);
	}

	async listModels(): Promise<string[]> {
		try {
			const response = await fetch("https://api.deepseek.com/models", {
				headers: { Authorization: `Bearer ${this.config.apiKey}` },
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) return FALLBACK_MODELS;
			const data = await response.json() as { data?: Array<{ id: string }> };
			const models = (data.data ?? []).map((m) => m.id).sort();
			return models.length > 0 ? models : FALLBACK_MODELS;
		} catch {
			return FALLBACK_MODELS;
		}
	}

	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			const modelId = this.config.defaultModel ?? getDefaultModel("deepseek");
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
