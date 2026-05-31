import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { PROVIDER_HEADERS } from "./headers";

const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";

const OLLAMA_FALLBACK_MODELS = [
	"llama3.2",
	"llama3.1",
	"mistral",
	"codellama",
	"phi3",
	"gemma2",
];

interface OllamaTagsResponse {
	models: Array<{ name: string }>;
}

export class OllamaAdapter implements ProviderAdapter {
	private config: ProviderConfig;
	private provider: ReturnType<typeof createOpenAICompatible>;

	constructor(config: ProviderConfig) {
		this.config = config;
		this.provider = createOpenAICompatible({
			name: "ollama",
			apiKey: "ollama",
			baseURL: config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
			headers: PROVIDER_HEADERS,
		});
	}

	createModel(modelId: string, _thinkingBudgetTokens?: number): LanguageModel {
		return this.provider(modelId);
	}

	/**
	 * Fetches the list of locally available Ollama models from the
	 * /api/tags endpoint. Falls back to a hardcoded list if Ollama
	 * is not running or the request fails.
	 */
	async listModels(): Promise<string[]> {
		try {
			const response = await fetch(OLLAMA_TAGS_URL, {
				signal: AbortSignal.timeout(3000),
			});

			if (!response.ok) {
				return OLLAMA_FALLBACK_MODELS;
			}

			const data = (await response.json()) as OllamaTagsResponse;
			const models = data.models?.map((m) => m.name) ?? [];
			return models.length > 0 ? models : OLLAMA_FALLBACK_MODELS;
		} catch {
			return OLLAMA_FALLBACK_MODELS;
		}
	}

	/**
	 * Tests whether Ollama is running by hitting the /api/tags endpoint
	 * first, then attempts a minimal text generation.
	 */
	async testConnection(): Promise<{ success: boolean; error?: string }> {
		// Step 1: Check if Ollama is reachable at all.
		try {
			const response = await fetch(OLLAMA_TAGS_URL, {
				signal: AbortSignal.timeout(3000),
			});
			if (!response.ok) {
				return {
					success: false,
					error: `Ollama server returned HTTP ${response.status}. Is Ollama running?`,
				};
			}
		} catch {
			return {
				success: false,
				error:
					"Cannot reach Ollama server. Make sure Ollama is running (ollama serve).",
			};
		}

		// Step 2: Attempt a minimal generation with the configured or first available model.
		try {
			const models = await this.listModels();
			const modelId = this.config.defaultModel ?? models[0] ?? "llama3.2";
			await generateText({
				model: this.createModel(modelId),
				prompt: "Hi",
				maxOutputTokens: 5,
			});
			return { success: true };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return { success: false, error };
		}
	}
}
