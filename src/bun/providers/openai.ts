import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { getDefaultModel } from "./models";
import { PROVIDER_HEADERS } from "./headers";

/**
 * Endpoints (keyed by normalized base URL) that have rejected the non-standard
 * `enable_thinking` / `thinking_budget` body params. Populated at runtime the
 * first time a backend 4xx-rejects them (e.g. Mistral answers 422
 * `extra_forbidden`), so every subsequent request to that endpoint skips the
 * injection entirely. In-memory for the process lifetime — it resets on restart
 * and is cheap to re-learn (one transparent retry).
 */
const THINKING_PARAMS_UNSUPPORTED = new Set<string>();

/**
 * Normalize a base URL by stripping endpoint suffixes and trailing slashes.
 */
function normalizeBaseUrl(url: string): string {
	let normalized = url
		.replace(/\/chat\/completions\/?$/, "")
		.replace(/\/completions\/?$/, "")
		.replace(/\/models\/?$/, "");
	normalized = normalized.replace(/\/$/, "");
	return normalized;
}

function joinUrl(baseUrl: string, path: string): string {
	const cleanBase = baseUrl.replace(/\/$/, "");
	const cleanPath = path.startsWith("/") ? path : `/${path}`;
	return `${cleanBase}${cleanPath}`;
}

function naturalSort(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

const OPENAI_MODELS = [
	"gpt-4o",
	"gpt-4o-mini",
	"gpt-4-turbo",
	"o1",
	"o1-mini",
	"o3",
	"o3-mini",
];

export class OpenAIAdapter implements ProviderAdapter {
	private config: ProviderConfig;
	private normalizedBaseUrl: string | null;
	/** True when using a custom base URL (non-OpenAI provider). */
	private isCustom: boolean;

	constructor(config: ProviderConfig) {
		this.config = config;
		this.normalizedBaseUrl = config.baseUrl ? normalizeBaseUrl(config.baseUrl) : null;
		this.isCustom = !!this.normalizedBaseUrl;
	}

	createModel(modelId: string, thinkingBudgetTokens?: number): LanguageModel {
		// Custom base URL → use @ai-sdk/openai-compatible (always Chat Completions API).
		// This avoids the v6 issue where @ai-sdk/openai defaults to the Responses API
		// which third-party providers (Z.AI, LM Studio, etc.) don't support.
		if (this.isCustom) {
			const baseUrlKey = this.normalizedBaseUrl ?? "";
			// `enable_thinking` / `thinking_budget` is a non-standard convention
			// (Qwen / vLLM / SGLang / DashScope). Only inject it when a budget is
			// set AND this endpoint hasn't already rejected it — strict backends
			// (e.g. Mistral) 422 on unknown body fields.
			const wantsThinking = !!thinkingBudgetTokens && !THINKING_PARAMS_UNSUPPORTED.has(baseUrlKey);

			if (wantsThinking) {
				const budget = thinkingBudgetTokens as number;
				const interceptFetch = async (
					url: Parameters<typeof fetch>[0],
					init: Parameters<typeof fetch>[1],
				): ReturnType<typeof fetch> => {
					let injectedBody: string | null = null;
					if (init?.body && typeof init.body === "string") {
						const body = JSON.parse(init.body) as Record<string, unknown>;
						body.enable_thinking = true;
						body.thinking_budget = budget;
						injectedBody = JSON.stringify(body);
						init = { ...init, body: injectedBody };
					}
					const response = await globalThis.fetch(url, init);

					// Self-heal: if the endpoint rejected our injected params, remember
					// the endpoint and transparently retry once without them so the
					// caller never sees the failure. Subsequent requests skip injection.
					if (injectedBody && !response.ok && (response.status === 422 || response.status === 400)) {
						const errText = await response.clone().text().catch(() => "");
						if (/enable_thinking|thinking_budget/.test(errText)) {
							THINKING_PARAMS_UNSUPPORTED.add(baseUrlKey);
							const body = JSON.parse(injectedBody) as Record<string, unknown>;
							delete body.enable_thinking;
							delete body.thinking_budget;
							return globalThis.fetch(url, { ...init, body: JSON.stringify(body) });
						}
					}
					return response;
				};
				const provider = createOpenAICompatible({
					name: "custom",
					apiKey: this.config.apiKey,
					baseURL: this.normalizedBaseUrl ?? "",
					headers: PROVIDER_HEADERS,
					fetch: interceptFetch as unknown as typeof fetch,
				});
				return provider(modelId);
			}
			const provider = createOpenAICompatible({
				name: "custom",
				apiKey: this.config.apiKey,
				baseURL: this.normalizedBaseUrl ?? "",
				headers: PROVIDER_HEADERS,
			});
			return provider(modelId);
		}

		// Standard OpenAI → use @ai-sdk/openai with .chat() for Chat Completions API.
		// This ensures compatibility and avoids Responses API issues with tool calling.
		const provider = createOpenAI({ apiKey: this.config.apiKey, headers: PROVIDER_HEADERS });
		return provider.chat(modelId);
	}

	async listModels(): Promise<string[]> {
		const baseUrl = this.normalizedBaseUrl ?? "https://api.openai.com/v1";
		try {
			const url = joinUrl(baseUrl, "models");
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${this.config.apiKey}` },
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) return OPENAI_MODELS;
			const data = await response.json() as { data?: Array<{ id: string }> };
			const models = (data.data ?? [])
				.map((m) => m.id)
				.filter((id) => {
					const lower = id.toLowerCase();
					return !lower.includes("embed") &&
						!lower.includes("whisper") &&
						!lower.includes("tts") &&
						!lower.includes("dall-e") &&
						!lower.includes("moderation") &&
						!lower.includes("realtime") &&
						!lower.includes("audio") &&
						!lower.includes("search");
				})
				.sort(naturalSort);
			return models.length > 0 ? models : OPENAI_MODELS;
		} catch {
			return OPENAI_MODELS;
		}
	}

	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			const modelId = this.config.defaultModel ?? getDefaultModel("openai");

			if (this.isCustom) {
				// For custom providers, use direct fetch (more reliable than SDK for non-standard endpoints)
				const fullUrl = joinUrl(this.normalizedBaseUrl ?? "", "chat/completions");
				const response = await fetch(fullUrl, {
					method: "POST",
					headers: {
						...PROVIDER_HEADERS,
						"Content-Type": "application/json",
						"Authorization": `Bearer ${this.config.apiKey}`,
					},
					body: JSON.stringify({
						model: modelId,
						messages: [{ role: "user", content: "Hi" }],
						max_tokens: 5,
					}),
					signal: AbortSignal.timeout(30_000),
				});

				if (response.ok) return { success: true };

				const errorText = await response.text();
				if (response.status === 401) return { success: false, error: "Invalid API key." };
				if (response.status === 404) return { success: false, error: `Model "${modelId}" not found.` };
				if (response.status === 429) return { success: false, error: "Rate limited. Try again in a moment." };

				try {
					const errorJson = JSON.parse(errorText);
					const message = errorJson.error?.message || errorJson.message || errorText.slice(0, 200);
					return { success: false, error: `API error (${response.status}): ${message}` };
				} catch {
					return { success: false, error: `API error (${response.status})` };
				}
			}

			// Standard OpenAI — use SDK
			await generateText({
				model: this.createModel(modelId),
				prompt: "Hi",
				maxOutputTokens: 5,
				abortSignal: AbortSignal.timeout(30_000),
			});
			return { success: true };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			if (error.includes("timeout")) return { success: false, error: "Connection timed out." };
			return { success: false, error };
		}
	}
}
