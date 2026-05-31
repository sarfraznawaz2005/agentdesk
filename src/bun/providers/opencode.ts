import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { PROVIDER_HEADERS } from "./headers";

const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 5 * 60 * 1000;

let modelsCache: { models: string[]; ts: number } | null = null;

async function fetchFreeModels(): Promise<string[]> {
	// The API endpoint is the primary source — free key only unlocks free models.
	// models.dev catalog is a secondary filter; we give it less time and don't
	// block on it if the API already responded.
	const API_TIMEOUT_MS = 30_000;
	const CATALOG_TIMEOUT_MS = 10_000;

	const apiPromise = fetch(`${OPENCODE_BASE_URL}/models`, {
		headers: { Authorization: "Bearer public" },
		signal: AbortSignal.timeout(API_TIMEOUT_MS),
	})
		.then(async (res) => {
			if (!res.ok) {
				console.error("[opencode] /zen/v1/models returned HTTP", res.status);
				return null;
			}
			const data = (await res.json()) as { data?: Array<{ id: string }> };
			const models = data.data?.map((m) => m.id) ?? [];
			console.log(`[opencode] ${models.length} models from /zen/v1/models API`);
			return models;
		})
		.catch((err) => {
			console.error("[opencode] /zen/v1/models fetch failed:", (err as Error).message ?? err);
			return null;
		});

	const catalogPromise = fetch(MODELS_DEV_URL, {
		signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
	})
		.then(async (res) => {
			if (!res.ok) {
				console.warn("[opencode] models.dev returned HTTP", res.status);
				return null;
			}
			const catalog = (await res.json()) as Record<string, unknown>;
			const provider = catalog["opencode"] as Record<string, unknown> | undefined;
			if (!provider?.models) {
				console.warn("[opencode] no 'opencode' key in models.dev. Keys:", Object.keys(catalog).slice(0, 20));
				return null;
			}
			const free = new Set(
				Object.entries(provider.models as Record<string, unknown>)
					.filter(([, m]) => (m as { cost?: { input?: number } })?.cost?.input === 0)
					.map(([id]) => id),
			);
			console.log(`[opencode] ${free.size} free models from models.dev catalog`);
			return free;
		})
		.catch((err) => {
			// Catalog is optional — timeout here is normal on a cold connection
			console.warn("[opencode] models.dev fetch skipped:", (err as Error).message ?? err);
			return null;
		});

	// Wait for the API (primary) first; give the catalog a chance to finish too
	const [availableFromApi, freeFromCatalog] = await Promise.all([apiPromise, catalogPromise]);

	if (availableFromApi && freeFromCatalog) {
		const filtered = availableFromApi.filter((id) => freeFromCatalog.has(id));
		console.log(`[opencode] ${filtered.length} models after catalog filter`);
		return filtered;
	}
	if (availableFromApi) return availableFromApi;
	if (freeFromCatalog) return [...freeFromCatalog];
	console.error("[opencode] both model sources failed — returning empty list");
	return [];
}

export class OpenCodeAdapter implements ProviderAdapter {
	private provider: ReturnType<typeof createOpenAICompatible>;

	constructor(config: ProviderConfig) {
		const apiKey =
			config.apiKey && config.apiKey !== "public" ? config.apiKey : "public";
		this.provider = createOpenAICompatible({
			name: "opencode",
			apiKey,
			baseURL: OPENCODE_BASE_URL,
			headers: PROVIDER_HEADERS,
		});
	}

	createModel(modelId: string): LanguageModel {
		return this.provider(modelId);
	}

	async listModels(): Promise<string[]> {
		const now = Date.now();
		if (modelsCache && now - modelsCache.ts < CACHE_TTL_MS) {
			return modelsCache.models;
		}
		const models = await fetchFreeModels();
		modelsCache = { models, ts: now };
		return models;
	}

	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			const models = await this.listModels();
			if (models.length === 0) {
				return {
					success: false,
					error: "No free models available from OpenCode. Check your connection and try again.",
				};
			}
			return { success: true };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}
}
