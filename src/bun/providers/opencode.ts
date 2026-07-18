import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { PROVIDER_HEADERS } from "./headers";
import { generateImageOpenAICompatible } from "./image-generation";

const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Wraps globalThis.fetch to inject the x-opencode-* headers the Zen backend
 * expects from official CLI clients.  Without these, requests are classified
 * as anonymous and hit a much lower fallbackValue rate-limit quota.
 *
 * Headers sent per request:
 *   x-opencode-client   – fixed "cli" to match the official client
 *   x-opencode-session  – stable for the adapter lifetime (ses_<uuid>)
 *   x-opencode-project  – fixed "global" (no project context from backend)
 *   x-opencode-request  – unique per request (msg_<uuid>)
 */
function buildOpenCodeHeaders(sessionId: string): Record<string, string> {
	return {
		"x-opencode-client": "cli",
		"x-opencode-session": sessionId,
		"x-opencode-project": "global",
		"x-opencode-request": `msg_${crypto.randomUUID()}`,
	};
}

function createOpenCodeFetch(sessionId: string): typeof globalThis.fetch {
	const openCodeFetch = (input: RequestInfo | URL, init?: BunFetchRequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.startsWith(OPENCODE_BASE_URL)) {
			return globalThis.fetch(input, init);
		}

		const existingHeaders = new Headers(init?.headers);
		for (const [key, value] of Object.entries(buildOpenCodeHeaders(sessionId))) {
			existingHeaders.set(key, value);
		}

		return globalThis.fetch(input, { ...init, headers: existingHeaders });
	};
	return Object.assign(openCodeFetch, { preconnect: globalThis.fetch.preconnect });
}

let modelsCache: { models: string[]; ts: number } | null = null;

async function fetchFreeModels(extraHeaders?: Record<string, string>): Promise<string[]> {
	// The API endpoint is the primary source — free key only unlocks free models.
	// models.dev catalog is a secondary filter; we give it less time and don't
	// block on it if the API already responded.
	const API_TIMEOUT_MS = 30_000;
	const CATALOG_TIMEOUT_MS = 10_000;

	const apiPromise = fetch(`${OPENCODE_BASE_URL}/models`, {
		headers: { Authorization: "Bearer public", ...extraHeaders },
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
	private apiKey: string;
	private sessionId: string;

	constructor(config: ProviderConfig) {
		this.apiKey =
			config.apiKey && config.apiKey !== "public" ? config.apiKey : "public";
		this.sessionId = `ses_${crypto.randomUUID()}`;
		this.provider = createOpenAICompatible({
			name: "opencode",
			apiKey: this.apiKey,
			baseURL: OPENCODE_BASE_URL,
			headers: PROVIDER_HEADERS,
			fetch: createOpenCodeFetch(this.sessionId),
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
		const models = await fetchFreeModels(
			this.apiKey === "public" ? buildOpenCodeHeaders(this.sessionId) : undefined,
		);
		if (models.length > 0) {
			modelsCache = { models, ts: now };
		}
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

	async generateImage(modelId: string, prompt: string): Promise<{ base64: string; mimeType: string }> {
		return generateImageOpenAICompatible(OPENCODE_BASE_URL, this.apiKey, modelId, prompt);
	}
}
