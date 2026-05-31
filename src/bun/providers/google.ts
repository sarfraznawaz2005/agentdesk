import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { getDefaultModel } from "./models";
import { PROVIDER_HEADERS } from "./headers";

const FALLBACK_MODELS = [
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-2.0-flash",
	"gemini-1.5-pro",
	"gemini-1.5-flash",
];

export class GoogleAdapter implements ProviderAdapter {
	private config: ProviderConfig;
	private provider: ReturnType<typeof createGoogleGenerativeAI>;

	constructor(config: ProviderConfig) {
		this.config = config;
		this.provider = createGoogleGenerativeAI({
			apiKey: config.apiKey,
			headers: PROVIDER_HEADERS,
		});
	}

	createModel(modelId: string): LanguageModel {
		return this.provider(modelId);
	}

	async listModels(): Promise<string[]> {
		try {
			const response = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models?key=${this.config.apiKey}`,
				{ signal: AbortSignal.timeout(10_000) },
			);
			if (!response.ok) return FALLBACK_MODELS;
			const data = await response.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
			const models = (data.models ?? [])
				.filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
				.map((m) => m.name.replace("models/", ""))
				.filter((id) => id.startsWith("gemini"))
				.sort();
			return models.length > 0 ? models : FALLBACK_MODELS;
		} catch {
			return FALLBACK_MODELS;
		}
	}

	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			const modelId = this.config.defaultModel ?? getDefaultModel("google");
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
