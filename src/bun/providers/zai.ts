import { createZhipu } from "zhipu-ai-provider";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { getDefaultModel } from "./models";
import { PROVIDER_HEADERS } from "./headers";

const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";

const ZAI_MODELS = [
	"glm-4.5",
	"glm-4.5-air",
	"glm-4.7",
	"glm-5",
	"glm-5-turbo",
];

export class ZaiAdapter implements ProviderAdapter {
	private config: ProviderConfig;
	private provider: ReturnType<typeof createZhipu>;

	constructor(config: ProviderConfig) {
		this.config = config;
		this.provider = createZhipu({
			apiKey: config.apiKey,
			baseURL: ZAI_BASE_URL,
			headers: PROVIDER_HEADERS,
		});
	}

	createModel(modelId: string): LanguageModel {
		return this.provider(modelId);
	}

	async listModels(): Promise<string[]> {
		return ZAI_MODELS;
	}

	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			const modelId = this.config.defaultModel ?? getDefaultModel("zai");
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
