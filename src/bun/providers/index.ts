import { AnthropicAdapter } from "./anthropic";
import { OpenAIAdapter } from "./openai";
import { OpenRouterAdapter } from "./openrouter";
import { OllamaAdapter } from "./ollama";
import { GoogleAdapter } from "./google";
import { DeepSeekAdapter } from "./deepseek";
import { GroqAdapter } from "./groq";
import { XaiAdapter } from "./xai";
import { ZaiAdapter } from "./zai";
import { OpenCodeAdapter } from "./opencode";
import { ClaudeSubscriptionAdapter } from "./claude-subscription";
import type { ProviderAdapter, ProviderConfig } from "./types";

export type { ProviderAdapter, ProviderConfig };
export { getContextLimit, getDefaultModel } from "./models";

const SUPPORTED_TYPES = ["anthropic", "openai", "google", "deepseek", "groq", "xai", "openrouter", "ollama", "zai", "opencode", "custom", "claude-subscription"] as const;

/**
 * Factory function that instantiates the correct provider adapter based
 * on the `providerType` field in the supplied config.
 *
 * Supported provider types:
 *   - "anthropic"  → Anthropic Claude via @ai-sdk/anthropic
 *   - "openai"     → OpenAI GPT / o-series via @ai-sdk/openai
 *   - "openrouter" → OpenRouter via OpenAI-compatible API
 *   - "ollama"     → Local Ollama via OpenAI-compatible API
 *
 * Throws if an unrecognised provider type is supplied.
 */
export function createProviderAdapter(config: ProviderConfig): ProviderAdapter {
	switch (config.providerType) {
		case "anthropic":
			return new AnthropicAdapter(config);
		case "openai":
		case "custom":
			return new OpenAIAdapter(config);
		case "google":
			return new GoogleAdapter(config);
		case "deepseek":
			return new DeepSeekAdapter(config);
		case "groq":
			return new GroqAdapter(config);
		case "xai":
			return new XaiAdapter(config);
		case "openrouter":
			return new OpenRouterAdapter(config);
		case "ollama":
			return new OllamaAdapter(config);
		case "zai":
			return new ZaiAdapter(config);
		case "opencode":
			return new OpenCodeAdapter(config);
		case "claude-subscription":
			return new ClaudeSubscriptionAdapter(config);
		default:
			throw new Error(
				`Unknown provider type: "${config.providerType}". ` +
					`Supported types are: ${SUPPORTED_TYPES.join(", ")}.`,
			);
	}
}

/**
 * Create a provider adapter with automatic fallback.
 *
 * Attempts to create the adapter for the primary config. If the provider is
 * unreachable (testConnection fails), falls back to the fallback config.
 * Returns both the adapter and which config was used.
 */
export async function createProviderAdapterWithFallback(
	primary: ProviderConfig,
	fallback?: ProviderConfig,
): Promise<{ adapter: ProviderAdapter; usedFallback: boolean }> {
	const primaryAdapter = createProviderAdapter(primary);
	try {
		const result = await primaryAdapter.testConnection();
		if (result.success) {
			return { adapter: primaryAdapter, usedFallback: false };
		}
	} catch {
		// Primary unavailable — try fallback
	}

	if (!fallback) {
		// No fallback configured — return primary anyway and let caller handle errors
		return { adapter: primaryAdapter, usedFallback: false };
	}

	console.warn(
		`[ProviderAdapter] Primary provider "${primary.name}" (${primary.providerType}) unavailable, falling back to "${fallback.name}" (${fallback.providerType})`,
	);
	const fallbackAdapter = createProviderAdapter(fallback);
	return { adapter: fallbackAdapter, usedFallback: true };
}
