import { db } from "../db";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";

const DEFAULT_CONTEXT_LIMIT = 1_000_000; // 1M tokens

// Default models per provider type
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
	anthropic: "claude-sonnet-4-5",
	openai: "gpt-4o",
	google: "gemini-2.5-flash",
	deepseek: "deepseek-chat",
	groq: "llama-3.3-70b-versatile",
	xai: "grok-3-mini",
	openrouter: "anthropic/claude-sonnet-4-5",
	ollama: "llama3.2",
	zai: "glm-4.5",
	opencode: "big-pickle",
};

/** Cached context limits per project (or "global" key). */
const contextLimitCache = new Map<string, number>();

/**
 * Returns the configured context window limit in tokens for a project.
 * Reads from `project:<projectId>:contextWindowLimit` setting, defaulting to 1M.
 * Results are cached in memory per project.
 */
export function getContextLimit(_modelId?: string, projectId?: string): number {
	const cacheKey = projectId ?? "global";
	const cached = contextLimitCache.get(cacheKey);
	if (cached !== undefined) return cached;

	let limit = DEFAULT_CONTEXT_LIMIT;
	try {
		// Try project-level setting first
		if (projectId) {
			const row = db.select({ value: settings.value }).from(settings)
				.where(eq(settings.key, `project:${projectId}:contextWindowLimit`)).get() as { value: string } | undefined;
			if (row?.value) {
				const parsed = parseInt(JSON.parse(row.value), 10);
				if (!Number.isNaN(parsed) && parsed >= 1000) limit = parsed;
			}
		}
		// Fall back to global setting
		if (limit === DEFAULT_CONTEXT_LIMIT) {
			const row = db.select({ value: settings.value }).from(settings)
				.where(eq(settings.key, "contextWindowLimit")).get() as { value: string } | undefined;
			if (row?.value) {
				const parsed = parseInt(JSON.parse(row.value), 10);
				if (!Number.isNaN(parsed) && parsed >= 1000) limit = parsed;
			}
		}
	} catch {
		// DB not ready — use default
	}

	contextLimitCache.set(cacheKey, limit);
	return limit;
}

/** Clear cached context limits (call when settings change). */
export function clearContextLimitCache(): void {
	contextLimitCache.clear();
}

/**
 * Returns the default model ID for a given provider type.
 * Falls back to "gpt-4o" if the provider type is not recognized.
 */
export function getDefaultModel(providerType: string): string {
	return PROVIDER_DEFAULT_MODELS[providerType] ?? "gpt-4o";
}
