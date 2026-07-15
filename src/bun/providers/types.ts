import type { LanguageModel } from "ai";
import type { FilesV4 } from "@ai-sdk/provider";

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
	/**
	 * Generate an image from a text prompt. Optional — omitted entirely by
	 * providers with no image-generation capability. Implementations throw a
	 * human-readable Error on failure (auth/balance/entitlement/timeout); the
	 * generate_image tool catches it and surfaces it as a normal failed tool
	 * result instead of crashing the agent turn.
	 */
	generateImage?(modelId: string, prompt: string): Promise<{ base64: string; mimeType: string }>;
	/**
	 * Returns a Files API interface for `uploadFile()` (AI SDK v7, §6.7),
	 * enabling upload-once/reference-later media instead of resending full
	 * base64 payloads on every step (see media-followup.ts). Only real
	 * Anthropic and OpenAI accounts expose a Files API — omitted entirely by
	 * every OpenAI-compatible custom provider (Ollama, OpenRouter, Z.AI,
	 * OpenCode, etc.), which have no such endpoint.
	 */
	getFilesApi?(): FilesV4 | undefined;
}
