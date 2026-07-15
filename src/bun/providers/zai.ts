import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { getDefaultModel } from "./models";
import { PROVIDER_HEADERS } from "./headers";
import { generateImageOpenAICompatible } from "./image-generation";

// Z.AI's API (https://api.z.ai/api/paas/v4) is OpenAI-compatible: standard
// {baseURL}/chat/completions with an `Authorization: Bearer <apiKey>` header
// -- exactly what createOpenAICompatible() produces by default, matching the
// generateImage() call below, which already hits the same base URL.
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
	private provider: ReturnType<typeof createOpenAICompatible>;

	constructor(config: ProviderConfig) {
		this.config = config;
		this.provider = createOpenAICompatible({
			name: "zai",
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

	// Z.AI's image endpoint (POST {ZAI_BASE_URL}/images/generations) is a
	// separate REST call, not part of the LanguageModel chat surface above.
	async generateImage(modelId: string, prompt: string): Promise<{ base64: string; mimeType: string }> {
		return generateImageOpenAICompatible(ZAI_BASE_URL, this.config.apiKey, modelId, prompt);
	}
}
