/**
 * Classifies model ids into the app-wide model-type taxonomy (language,
 * embedding, image, video, transcription, speech, realtime, reranking,
 * unknown) using two shared, in-memory-cached network catalogs — never one
 * fetch per provider/model. See docs/model-type-badges-plan.md.
 */

export type ModelType =
	| "language"
	| "embedding"
	| "image"
	| "video"
	| "transcription"
	| "speech"
	| "realtime"
	| "reranking"
	| "unknown";

export type ClassificationSource = "gateway" | "models-dev" | "heuristic" | "default";

export interface ModelClassification {
	type: ModelType;
	source: ClassificationSource;
}

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/models";
const MODELS_DEV_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 24h — these catalogs change rarely
const CATALOG_FETCH_TIMEOUT_MS = 15_000;

const GATEWAY_TYPES = new Set<ModelType>([
	"language",
	"embedding",
	"image",
	"video",
	"transcription",
	"speech",
	"realtime",
	"reranking",
]);

interface GatewayModel {
	id: string;
	type?: string;
}

interface ModelsDevModel {
	id: string;
	family?: string;
	modalities?: { input?: string[]; output?: string[] };
	// $ per million tokens. Only present for hosted, metered models — absent
	// for free/open-weight entries.
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

interface ModelsDevProvider {
	id: string;
	models: Record<string, ModelsDevModel>;
}

// --- Tier 1: Vercel AI Gateway catalog (authoritative `type` field) --------

interface GatewayCatalog {
	byFullId: Map<string, GatewayModel>;
	byBareId: Map<string, GatewayModel[]>;
	fetchedAt: number;
}

let gatewayCache: GatewayCatalog | null = null;
let gatewayInFlight: Promise<GatewayCatalog | null> | null = null;

async function getGatewayCatalog(): Promise<GatewayCatalog | null> {
	if (gatewayCache && Date.now() - gatewayCache.fetchedAt < CATALOG_TTL_MS) return gatewayCache;
	if (gatewayInFlight) return gatewayInFlight;

	gatewayInFlight = (async () => {
		try {
			const res = await fetch(GATEWAY_URL, { signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = (await res.json()) as { data?: GatewayModel[] };
			const byFullId = new Map<string, GatewayModel>();
			const byBareId = new Map<string, GatewayModel[]>();
			for (const m of json.data ?? []) {
				if (!m.id) continue;
				byFullId.set(m.id.toLowerCase(), m);
				const bare = (m.id.split("/").pop() ?? m.id).toLowerCase();
				const list = byBareId.get(bare) ?? [];
				list.push(m);
				byBareId.set(bare, list);
			}
			gatewayCache = { byFullId, byBareId, fetchedAt: Date.now() };
			return gatewayCache;
		} catch {
			// Leave any previous (possibly stale) cache in place; caller falls
			// back to tier 2/heuristics when this returns null.
			return gatewayCache;
		} finally {
			gatewayInFlight = null;
		}
	})();
	return gatewayInFlight;
}

/** Best-guess Gateway vendor prefix(es) for a given AgentDesk provider type. */
const VENDOR_PREFIX_GUESSES: Record<string, string[]> = {
	anthropic: ["anthropic"],
	"claude-subscription": ["anthropic"],
	openai: ["openai"],
	google: ["google"],
	deepseek: ["deepseek"],
	xai: ["xai"],
	zai: ["zhipuai", "z-ai"],
};

function lookupGateway(
	providerType: string,
	modelId: string,
	catalog: GatewayCatalog,
): GatewayModel | null {
	const lower = modelId.toLowerCase();

	// 1. Vendor-prefixed guess (e.g. "openai/gpt-4o")
	for (const vendor of VENDOR_PREFIX_GUESSES[providerType] ?? []) {
		const hit = catalog.byFullId.get(`${vendor}/${lower}`);
		if (hit) return hit;
	}

	// 2. Model id is already a full "vendor/model" id (OpenRouter, OpenCode, etc.)
	const direct = catalog.byFullId.get(lower);
	if (direct) return direct;

	// 3. Suffix match — any gateway id whose part after "/" equals this model id
	const bareMatches = catalog.byBareId.get(lower);
	if (bareMatches && bareMatches.length > 0) return bareMatches[0];

	return null;
}

// --- Tier 2: models.dev catalog (modalities + id heuristics) --------------

interface ModelsDevCatalog {
	data: Record<string, ModelsDevProvider>;
	catalogKeys: Set<string>;
	fetchedAt: number;
}

let modelsDevCache: ModelsDevCatalog | null = null;
let modelsDevInFlight: Promise<ModelsDevCatalog | null> | null = null;

async function getModelsDevCatalog(): Promise<ModelsDevCatalog | null> {
	if (modelsDevCache && Date.now() - modelsDevCache.fetchedAt < CATALOG_TTL_MS) return modelsDevCache;
	if (modelsDevInFlight) return modelsDevInFlight;

	modelsDevInFlight = (async () => {
		try {
			const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as Record<string, ModelsDevProvider>;
			modelsDevCache = { data, catalogKeys: new Set(Object.keys(data)), fetchedAt: Date.now() };
			return modelsDevCache;
		} catch {
			return modelsDevCache;
		} finally {
			modelsDevInFlight = null;
		}
	})();
	return modelsDevInFlight;
}

/**
 * Maps an AgentDesk provider (type/baseUrl/name) to the best-guess models.dev
 * catalog key. Mirrors the matching logic already validated in
 * scripts/list-provider-models.ts (provider_type → hostname substring → name
 * substring).
 */
function resolveModelsDevCatalogKey(
	providerType: string,
	baseUrl: string | null,
	providerName: string,
	catalogKeys: Set<string>,
): string | null {
	if (providerType !== "custom" && catalogKeys.has(providerType)) return providerType;
	if (providerType === "claude-subscription") return catalogKeys.has("anthropic") ? "anthropic" : null;

	if (baseUrl) {
		let host = "";
		try {
			host = new URL(baseUrl).hostname.toLowerCase();
		} catch {
			host = baseUrl.toLowerCase();
		}
		const candidates = [...catalogKeys].filter((k) => host.includes(k));
		if (candidates.length > 0) {
			candidates.sort((a, b) => b.length - a.length);
			return candidates[0];
		}
	}

	const nameLower = providerName.toLowerCase();
	return [...catalogKeys].find((k) => nameLower.includes(k)) ?? null;
}

function modelsDevEntryType(entry: ModelsDevModel, modelId: string): ModelType | null {
	const output = entry.modalities?.output ?? [];
	const input = entry.modalities?.input ?? [];
	if (output.includes("image")) return "image";
	if (output.includes("video")) return "video";
	if (output.includes("audio")) return "speech"; // text/audio in, audio out → TTS
	if (input.includes("audio") && !output.includes("audio")) return "transcription"; // audio in, text out → STT
	// models.dev doesn't mark embedding/reranking via modalities (they present
	// as plain text→text) — fall back to id/family substring heuristics.
	return idHeuristicType(modelId) ?? idHeuristicType(entry.family ?? "");
}

// --- Tier 3: id-substring heuristics (last resort, no catalog entry) ------

function idHeuristicType(id: string): ModelType | null {
	const lower = id.toLowerCase();
	if (/rerank/.test(lower)) return "reranking";
	if (/embed/.test(lower)) return "embedding";
	if (/realtime/.test(lower)) return "realtime";
	if (/whisper|transcri/.test(lower)) return "transcription";
	if (/\btts\b|text-to-speech|-tts-|-tts$/.test(lower)) return "speech";
	if (/dall-?e|gpt-image|image-gen|-image(-|$)|imagen|stable-?diffusion|\bsdxl\b|\bflux\b|midjourney/.test(lower)) return "image";
	return null;
}

// --- Public API -------------------------------------------------------------

/**
 * Classify a batch of model ids for one provider against the two shared
 * catalogs (fetched at most once, in-memory, regardless of how many
 * providers/models are classified across the whole app).
 */
export async function classifyModels(
	providerType: string,
	baseUrl: string | null,
	providerName: string,
	modelIds: string[],
): Promise<Record<string, ModelClassification>> {
	const [gateway, modelsDev] = await Promise.all([getGatewayCatalog(), getModelsDevCatalog()]);

	const catalogKey =
		modelsDev ? resolveModelsDevCatalogKey(providerType, baseUrl, providerName, modelsDev.catalogKeys) : null;
	const catalogModels = catalogKey ? modelsDev?.data[catalogKey]?.models ?? {} : {};

	const result: Record<string, ModelClassification> = {};
	for (const id of modelIds) {
		// Tier 1 — Gateway
		if (gateway) {
			const hit = lookupGateway(providerType, id, gateway);
			if (hit?.type && GATEWAY_TYPES.has(hit.type as ModelType)) {
				result[id] = { type: hit.type as ModelType, source: "gateway" };
				continue;
			}
		}

		// Tier 2 — models.dev
		const entry =
			catalogModels[id] ?? catalogModels[id.split("/").pop() ?? id] ?? Object.values(catalogModels).find((m) => m.id === id);
		if (entry) {
			const type = modelsDevEntryType(entry, id);
			if (type) {
				result[id] = { type, source: "models-dev" };
				continue;
			}
			result[id] = { type: "language", source: "models-dev" };
			continue;
		}

		// Tier 3 — id heuristics
		const heuristic = idHeuristicType(id);
		if (heuristic) {
			result[id] = { type: heuristic, source: "heuristic" };
			continue;
		}

		// Default — matches today's reality: the vast majority of ids left
		// unclassified at this point are ordinary chat/language models.
		result[id] = { type: "language", source: "default" };
	}

	return result;
}

// --- Model pricing (§9.1 cost view) -----------------------------------------
//
// Reuses the same models.dev catalog fetch/cache as classification above —
// deliberately not a second fetcher or a persistent DB cache, since the
// existing 24h in-memory TTL already solves "don't hit models.dev on every
// analytics query."

export interface ModelCostRate {
	inputPerMillion: number;
	outputPerMillion: number;
	cacheReadPerMillion?: number;
	cacheWritePerMillion?: number;
}

/**
 * Look up $/million-token rates for a telemetry (provider, modelId) pair.
 *
 * `rawProvider` is the AI SDK's own telemetry provider string, which is
 * always `${baseProviderName}.${suffix}` (e.g. "openai.chat",
 * "anthropic.messages", "zai.chat" — confirmed against the installed SDK's
 * compiled source; `@ai-sdk/openai-compatible` itself normalizes the same
 * way via `provider.split(".")[0]`) or occasionally bare (e.g. "google").
 * Splitting on "." recovers AgentDesk's own provider-type string, which
 * matches models.dev's top-level catalog keys directly for every provider
 * except "ollama" (self-hosted, not in the catalog — genuinely free, not
 * unknown) and "custom" (an arbitrary OpenAI-compatible endpoint — telemetry
 * rows carry no baseUrl/providerId to guess a vendor from, unlike
 * classifyModels() above, so cost is unknowable here by design, not a bug).
 *
 * "claude-subscription" is mapped to the "anthropic" catalog entry since its
 * Haiku direct-HTTP path is a real `@ai-sdk/anthropic` instance — but this is
 * a known imprecision: that path is a flat monthly subscription, not metered
 * per-token, so a project using Claude Subscription will show a per-token $
 * figure here that doesn't reflect actual marginal cost. Telemetry has no way
 * to distinguish Claude Subscription's Anthropic calls from a real Anthropic
 * API key's calls (both emit provider="anthropic.messages"), so this can't be
 * corrected without a schema change; documented rather than silently wrong.
 *
 * Returns "free" for known-zero-cost providers (Ollama), a rate object when
 * a metered rate is known, or null when pricing genuinely can't be
 * determined (custom providers, or a model id absent from the catalog).
 */
export async function getModelCostRate(rawProvider: string | null | undefined, modelId: string | null | undefined): Promise<ModelCostRate | "free" | null> {
	if (!rawProvider || !modelId) return null;
	const baseProvider = rawProvider.split(".")[0].trim();
	if (baseProvider === "ollama") return "free";
	if (baseProvider === "custom") return null;

	const modelsDev = await getModelsDevCatalog();
	if (!modelsDev) return null;

	const catalogKey = baseProvider === "claude-subscription" ? "anthropic" : baseProvider;
	if (!modelsDev.catalogKeys.has(catalogKey)) return null;

	const models = modelsDev.data[catalogKey]?.models ?? {};
	const entry = models[modelId] ?? models[modelId.split("/").pop() ?? modelId];
	if (!entry?.cost?.input || entry.cost.output == null) return null;

	return {
		inputPerMillion: entry.cost.input,
		outputPerMillion: entry.cost.output,
		cacheReadPerMillion: entry.cost.cache_read,
		cacheWritePerMillion: entry.cost.cache_write,
	};
}

/** Age of the in-memory models.dev catalog, for a UI "pricing as of" note. Null if never successfully fetched. */
export function getModelsDevCatalogFetchedAt(): number | null {
	return modelsDevCache?.fetchedAt ?? null;
}
