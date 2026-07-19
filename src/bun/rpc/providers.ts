import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { aiProviders, modelCapabilitiesCache, modelPreferences } from "../db/schema";
import { createProviderAdapter, dedupeModels, type ProviderConfig } from "../providers";
import { classifyModels, type ModelType } from "../providers/model-classification";
import { logAudit } from "../db/audit";
import { isClaudeSubscriptionEnabled } from "../claude/feature-flag";

/**
 * Normalize a base URL by:
 * 1. Stripping known endpoint suffixes (e.g., /chat/completions)
 * 2. Removing trailing slashes
 *
 * This ensures consistent URL handling regardless of how the user enters it.
 */
export function normalizeBaseUrl(url: string): string {
	return url
		.replace(/\/chat\/completions\/?$/, "")
		.replace(/\/completions\/?$/, "")
		.replace(/\/$/, "");
}

// Alias for duplicate detection (lowercases for case-insensitive comparison)
function normalizeUrlForComparison(url: string): string {
	return normalizeBaseUrl(url).toLowerCase();
}

// Shape returned to the renderer — apiKey is intentionally excluded
export interface ProviderListItem {
	id: string;
	name: string;
	providerType: string;
	baseUrl: string | null;
	defaultModel: string | null;
	isDefault: boolean;
	isValid: boolean;
}

/**
 * Select all AI providers. Maps integer 0/1 flags to booleans and strips the
 * apiKey from the returned objects. Default provider is always listed first.
 */
export async function getProvidersList(): Promise<ProviderListItem[]> {
	const rows = await db.select().from(aiProviders);
	const mapped = rows.map((row) => ({
		id: row.id,
		name: row.name,
		providerType: row.providerType,
		baseUrl: row.baseUrl,
		defaultModel: row.defaultModel,
		isDefault: row.isDefault === 1,
		isValid: row.isValid === 1,
	}));
	// Sort: default provider first, then by name
	return mapped.sort((a, b) => {
		if (a.isDefault && !b.isDefault) return -1;
		if (!a.isDefault && b.isDefault) return 1;
		return a.name.localeCompare(b.name);
	});
}

export interface SaveProviderParams {
	id?: string;
	name: string;
	providerType: string;
	apiKey: string;
	baseUrl?: string;
	defaultModel?: string;
	isDefault?: boolean;
}

/**
 * Insert or update an AI provider record. If params.id is provided and the
 * row exists, perform an update; otherwise insert a new row.
 */
export async function saveProviderHandler(
	params: SaveProviderParams,
): Promise<{ success: boolean; id: string; error?: string }> {
	const now = new Date().toISOString();

	if (params.id) {
		// Duplicate name check before updating (excluding this provider itself)
		const existingForUpdate = await db.select().from(aiProviders);
		const nameCollisionOnUpdate = existingForUpdate.find(
			(r) => r.id !== params.id && r.name.toLowerCase() === params.name.trim().toLowerCase(),
		);
		if (nameCollisionOnUpdate) {
			return { success: false, id: params.id, error: `A provider named "${params.name.trim()}" already exists.` };
		}

		// Normalize baseUrl before updating
		const normalizedBaseUrl = params.baseUrl ? normalizeBaseUrl(params.baseUrl) : null;
		const updateFields: Record<string, unknown> = {
			name: params.name,
			providerType: params.providerType,
			baseUrl: normalizedBaseUrl,
			defaultModel: params.defaultModel ?? null,
			isDefault: params.isDefault ? 1 : 0,
			updatedAt: now,
		};
		// Only overwrite the stored key when a non-empty replacement is supplied
		if (params.apiKey) {
			updateFields.apiKey = params.apiKey;
		}

		// Wrap clear-default + set-default in a transaction to prevent race conditions
		sqlite.exec("BEGIN");
		try {
			if (params.isDefault) {
				await db.update(aiProviders).set({ isDefault: 0, updatedAt: now });
			}
			await db
				.update(aiProviders)
				.set(updateFields)
				.where(eq(aiProviders.id, params.id));
			// Invalidate the model-type classification cache — an edited
			// baseUrl/apiKey can change which models are even reachable,
			// so force a full reclassify on this provider's next fetch.
			await db.delete(modelCapabilitiesCache).where(eq(modelCapabilitiesCache.providerId, params.id));
			sqlite.exec("COMMIT");
		} catch (err) {
			sqlite.exec("ROLLBACK");
			throw err;
		}

		return { success: true, id: params.id };
	}

	// If setting this provider as default, clear isDefault on all others first
	if (params.isDefault) {
		await db.update(aiProviders).set({ isDefault: 0, updatedAt: now });
	}

	// Duplicate check before inserting
	const existing = await db.select().from(aiProviders);
	const nameCollision = existing.find(
		(r) => r.name.toLowerCase() === params.name.trim().toLowerCase(),
	);
	if (nameCollision) {
		return { success: false, id: nameCollision.id, error: `A provider named "${params.name.trim()}" already exists.` };
	}
	if (params.baseUrl) {
		const normalizedNew = normalizeUrlForComparison(params.baseUrl);
		const duplicate = existing.find(
			(r) => r.baseUrl && normalizeUrlForComparison(r.baseUrl) === normalizedNew,
		);
		if (duplicate) {
			return { success: false, id: duplicate.id, error: "A provider with this base URL already exists." };
		}
	} else {
		const duplicate = existing.find((r) => r.providerType === params.providerType && !r.baseUrl);
		if (duplicate) {
			return { success: false, id: duplicate.id, error: `A ${params.providerType} provider already exists.` };
		}
	}

	// Normalize baseUrl before saving
	const normalizedBaseUrl = params.baseUrl ? normalizeBaseUrl(params.baseUrl) : null;

	// Insert new provider
	const id = crypto.randomUUID();
	await db.insert(aiProviders).values({
		id,
		name: params.name,
		providerType: params.providerType,
		apiKey: params.apiKey,
		baseUrl: normalizedBaseUrl,
		defaultModel: params.defaultModel ?? null,
		isDefault: params.isDefault ? 1 : 0,
		isValid: 0,
	});

	logAudit({ action: "provider.save", entityType: "provider", entityId: id, details: { name: params.name, providerType: params.providerType } });
	return { success: true, id };
}

/**
 * Return the stored API key for a provider. Only called by the edit dialog
 * on the local machine — key is never logged or sent off-device.
 */
export async function getProviderApiKeyHandler(id: string): Promise<{ apiKey: string }> {
	const rows = await db.select({ apiKey: aiProviders.apiKey }).from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
	return { apiKey: rows[0]?.apiKey ?? "" };
}

/**
 * Run a real testConnection() call using credentials supplied directly
 * (not from a saved provider row). Used by the Add/Edit provider dialog
 * so it tests exactly what the user has entered in the form.
 */
export async function testProviderWithCredentialsHandler(params: {
	providerType: string;
	apiKey: string;
	baseUrl?: string;
	defaultModel?: string;
}): Promise<{ success: boolean; error?: string }> {
	const config: ProviderConfig = {
		id: "dialog-test",
		name: "dialog-test",
		providerType: params.providerType,
		apiKey: params.apiKey,
		baseUrl: params.baseUrl ?? null,
		defaultModel: params.defaultModel ?? null,
	};
	try {
		const adapter = createProviderAdapter(config);
		return await adapter.testConnection();
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Test one specific model against a saved provider's stored credentials
 * (Models settings tab's per-row "Test Connection" icon). Unlike
 * testProviderHandler, this does not touch the provider's persisted isValid
 * flag — that column reflects the provider's own default model, not an
 * arbitrary one tested here.
 */
export async function testProviderModelHandler(params: {
	providerId: string;
	modelId: string;
}): Promise<{ success: boolean; error?: string }> {
	const rows = await db.select().from(aiProviders).where(eq(aiProviders.id, params.providerId));
	if (rows.length === 0) {
		return { success: false, error: "Provider not found" };
	}
	const row = rows[0];
	const config = {
		id: row.id,
		name: row.name,
		providerType: row.providerType,
		apiKey: row.apiKey,
		baseUrl: row.baseUrl,
		defaultModel: params.modelId,
	};
	try {
		const adapter = createProviderAdapter(config);
		return await adapter.testConnection();
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Load a provider from the DB, call its adapter's testConnection(), then
 * persist the result back into the isValid column.
 */
export async function testProviderHandler(
	id: string,
): Promise<{ success: boolean; error?: string }> {
	const rows = await db
		.select()
		.from(aiProviders)
		.where(eq(aiProviders.id, id));

	if (rows.length === 0) {
		return { success: false, error: "Provider not found" };
	}

	const row = rows[0];
	const config = {
		id: row.id,
		name: row.name,
		providerType: row.providerType,
		apiKey: row.apiKey,
		baseUrl: row.baseUrl,
		defaultModel: row.defaultModel,
	};

	let result: { success: boolean; error?: string };
	try {
		const adapter = createProviderAdapter(config);
		result = await adapter.testConnection();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		result = { success: false, error: message };
	}

	// Persist validation result
	await db
		.update(aiProviders)
		.set({
			isValid: result.success ? 1 : 0,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(aiProviders.id, id));

	return result;
}

/**
 * Delete an AI provider record by ID.
 */
export async function deleteProviderHandler(
	id: string,
): Promise<{ success: boolean }> {
	await db.delete(aiProviders).where(eq(aiProviders.id, id));
	logAudit({ action: "provider.delete", entityType: "provider", entityId: id });
	return { success: true };
}

/**
 * Fetch models for all connected (valid) providers.
 * Returns provider info + model list grouped by provider.
 */
export async function getConnectedProviderModelsHandler(): Promise<
	Array<{ providerId: string; providerName: string; providerType: string; models: string[] }>
> {
	const rows = await db.select().from(aiProviders);
	const results: Array<{ providerId: string; providerName: string; providerType: string; models: string[] }> = [];

	for (const row of rows) {
		let models: string[] = [];
		try {
			const adapter = createProviderAdapter({
				id: row.id,
				name: row.name,
				providerType: row.providerType,
				apiKey: row.apiKey,
				baseUrl: row.baseUrl,
				defaultModel: row.defaultModel,
			});
			models = await adapter.listModels();
		} catch {
			// Provider unreachable — return empty models
		}
		// Always include the user's saved default model even if the adapter didn't return it
		if (row.defaultModel && !models.includes(row.defaultModel)) {
			models = [row.defaultModel, ...models];
		}
		results.push({
			providerId: row.id,
			providerName: row.name,
			providerType: row.providerType,
			models: dedupeModels(models),
		});
	}

	return results;
}

/** Non-language types that shouldn't clutter the chat model picker by default. */
const NON_CHAT_TYPES = new Set<ModelType>([
	"embedding",
	"image",
	"video",
	"transcription",
	"speech",
	"realtime",
	"reranking",
]);

/**
 * Resolve model-type badges for every connected provider's models.
 *
 * Reads the persistent classification cache first; only ids missing from it
 * (first run, or a genuinely new model id) are classified via the two shared
 * catalog fetches in providers/model-classification.ts and upserted back into
 * the cache. So every call after the first is a pure DB read with zero
 * network calls, until a provider is added/edited (cache cleared) or a new
 * model id appears upstream.
 *
 * Newly-classified non-language models (embedding/image/etc.) are seeded as
 * disabled in model_preferences — unless the user already has an explicit
 * preference row for that model — so they don't clutter the chat picker.
 */
export async function getModelTypesHandler(): Promise<Record<string, Record<string, ModelType>>> {
	const providerRows = await db.select().from(aiProviders);
	const result: Record<string, Record<string, ModelType>> = {};

	for (const row of providerRows) {
		let modelIds: string[];
		try {
			const adapter = createProviderAdapter({
				id: row.id,
				name: row.name,
				providerType: row.providerType,
				apiKey: row.apiKey,
				baseUrl: row.baseUrl,
				defaultModel: row.defaultModel,
			});
			modelIds = dedupeModels(await adapter.listModels());
		} catch {
			modelIds = [];
		}
		if (row.defaultModel && !modelIds.includes(row.defaultModel)) modelIds.push(row.defaultModel);
		if (modelIds.length === 0) {
			result[row.id] = {};
			continue;
		}

		const cachedRows = await db
			.select()
			.from(modelCapabilitiesCache)
			.where(
				and(
					eq(modelCapabilitiesCache.providerId, row.id),
					inArray(modelCapabilitiesCache.modelId, modelIds),
				),
			);
		const cached = new Map(cachedRows.map((r) => [r.modelId, r.modelType as ModelType]));

		const missingIds = modelIds.filter((id) => !cached.has(id));
		if (missingIds.length > 0) {
			const classified = await classifyModels(row.providerType, row.baseUrl, row.name, missingIds);

			const existingPrefRows = await db
				.select({ modelId: modelPreferences.modelId })
				.from(modelPreferences)
				.where(
					and(
						eq(modelPreferences.providerId, row.id),
						inArray(modelPreferences.modelId, missingIds),
					),
				);
			const hasExplicitPref = new Set(existingPrefRows.map((r) => r.modelId));

			const now = new Date().toISOString();
			for (const id of missingIds) {
				const { type, source } = classified[id] ?? { type: "unknown" as ModelType, source: "default" as const };
				cached.set(id, type);
				await db
					.insert(modelCapabilitiesCache)
					.values({ providerId: row.id, modelId: id, modelType: type, source, computedAt: now })
					.onConflictDoUpdate({
						target: [modelCapabilitiesCache.providerId, modelCapabilitiesCache.modelId],
						set: { modelType: type, source, computedAt: now },
					});

				if (NON_CHAT_TYPES.has(type) && !hasExplicitPref.has(id)) {
					await db
						.insert(modelPreferences)
						.values({ providerId: row.id, modelId: id, isEnabled: 0, updatedAt: now })
						.onConflictDoNothing();
				}
			}
		}

		result[row.id] = Object.fromEntries(cached);
	}

	return result;
}

/**
 * List available models from a provider without saving it.
 * Used during onboarding to show model options after API key is entered.
 */
export async function listProviderModelsHandler(params: {
	providerType: string;
	apiKey: string;
	baseUrl?: string;
	defaultModel?: string;
}): Promise<{ success: boolean; models: string[]; error?: string }> {
	try {
		const normalizedBaseUrl = params.baseUrl ? normalizeBaseUrl(params.baseUrl) : null;
		const config: ProviderConfig = {
			id: "temp",
			name: "temp",
			providerType: params.providerType,
			apiKey: params.apiKey,
			baseUrl: normalizedBaseUrl,
			defaultModel: params.defaultModel ?? null,
		};
		const adapter = createProviderAdapter(config);
		let models = await adapter.listModels();
		// Always keep the already-configured default model in the list even if
		// the live/fallback fetch didn't happen to return it (e.g. Ollama not
		// running) — matches getConnectedProviderModelsHandler's behavior, so
		// the Edit Provider dialog's suggestion list doesn't silently drop the
		// value the user already saved.
		if (params.defaultModel && !models.includes(params.defaultModel)) {
			models = [params.defaultModel, ...models];
		}
		return { success: true, models: dedupeModels(models) };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return { success: false, models: [], error };
	}
}

/**
 * Check whether a given OpenRouter model supports the `tool_choice` parameter.
 * For non-OpenRouter providers, always returns supportsToolChoice: true.
 * Resolves the API key from DB if a providerId is given and no key is passed.
 */
export async function checkModelToolSupportHandler(params: {
	providerType: string;
	apiKey?: string;
	providerId?: string;
	modelId: string;
}): Promise<{ supportsToolChoice: boolean; warning?: string }> {
	if (params.providerType !== "openrouter") {
		return { supportsToolChoice: true };
	}
	if (!params.modelId.trim()) {
		return { supportsToolChoice: true };
	}

	// Resolve API key — either passed directly or fetched from DB via providerId
	let apiKey = params.apiKey?.trim() ?? "";
	if (!apiKey && params.providerId) {
		const rows = await db.select().from(aiProviders).where(eq(aiProviders.id, params.providerId)).limit(1);
		if (rows.length > 0) apiKey = rows[0].apiKey ?? "";
	}
	if (!apiKey) return { supportsToolChoice: true };

	try {
		const res = await fetch("https://openrouter.ai/api/v1/models", {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(8_000),
		});
		if (!res.ok) return { supportsToolChoice: true };
		const json = await res.json() as { data?: Array<{ id: string; supported_parameters?: string[] }> };
		const model = json.data?.find((m) => m.id === params.modelId);
		if (!model) {
			// Model not found in list — can't determine, assume ok
			return { supportsToolChoice: true };
		}
		const supported = model.supported_parameters ?? [];
		if (!supported.includes("tool_choice")) {
			return {
				supportsToolChoice: false,
				warning: `"${params.modelId}" does not support tool_choice on OpenRouter. Sub-agents may fail to call tools reliably. Choose a model that lists tool_choice in its supported parameters.`,
			};
		}
		return { supportsToolChoice: true };
	} catch {
		// Network error or timeout — don't block the user
		return { supportsToolChoice: true };
	}
}

export function getClaudeSubscriptionEnabledHandler(): { enabled: boolean } {
	return { enabled: isClaudeSubscriptionEnabled() };
}

/**
 * List models for an existing saved provider (uses stored API key).
 */
export async function listProviderModelsByIdHandler(providerId: string): Promise<{ success: boolean; models: string[]; error?: string }> {
	try {
		const rows = await db.select().from(aiProviders).where(eq(aiProviders.id, providerId)).limit(1);
		if (rows.length === 0) return { success: false, models: [], error: "Provider not found" };
		const row = rows[0];
		const adapter = createProviderAdapter({
			id: row.id,
			name: row.name,
			providerType: row.providerType,
			apiKey: row.apiKey,
			baseUrl: row.baseUrl,
			defaultModel: row.defaultModel,
		});
		let models = await adapter.listModels();
		// Always keep the already-configured default model in the list even if
		// the live/fallback fetch didn't happen to return it (e.g. Ollama not
		// running) — matches getConnectedProviderModelsHandler's behavior.
		if (row.defaultModel && !models.includes(row.defaultModel)) {
			models = [row.defaultModel, ...models];
		}
		return { success: true, models: dedupeModels(models) };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return { success: false, models: [], error };
	}
}

// ---------------------------------------------------------------------------
// Per-model preferences (global, app-wide): enabled/disabled, favourite,
// last-used. Backs the chat model picker's Latest/Favorites sections and the
// Settings → AI → Models page. Rows are sparse — absence implies the defaults
// (enabled, not favourite, never used), so existing users need no backfill.
// ---------------------------------------------------------------------------

/** Return every stored model preference row. */
export async function getModelPreferencesHandler(): Promise<
	Array<{ providerId: string; modelId: string; isEnabled: boolean; isFavorite: boolean; lastUsedAt: string | null }>
> {
	const rows = await db.select().from(modelPreferences);
	return rows.map((r) => ({
		providerId: r.providerId,
		modelId: r.modelId,
		isEnabled: r.isEnabled === 1,
		isFavorite: r.isFavorite === 1,
		lastUsedAt: r.lastUsedAt,
	}));
}

/** Upsert one or more columns of a model's preference row, keyed on (providerId, modelId). */
async function upsertModelPreference(
	providerId: string,
	modelId: string,
	patch: Partial<{ isEnabled: number; isFavorite: number; lastUsedAt: string }>,
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(modelPreferences)
		.values({ providerId, modelId, ...patch, updatedAt: now })
		.onConflictDoUpdate({
			target: [modelPreferences.providerId, modelPreferences.modelId],
			set: { ...patch, updatedAt: now },
		});
}

/** Enable or disable a model in the picker. Disabled models are hidden from chat. */
export async function setModelEnabledHandler(params: {
	providerId: string;
	modelId: string;
	enabled: boolean;
}): Promise<{ success: boolean }> {
	await upsertModelPreference(params.providerId, params.modelId, {
		isEnabled: params.enabled ? 1 : 0,
	});
	return { success: true };
}

/** Enable or disable every given model of a provider at once (bulk master toggle). */
export async function setModelsEnabledHandler(params: {
	providerId: string;
	modelIds: string[];
	enabled: boolean;
}): Promise<{ success: boolean }> {
	for (const modelId of params.modelIds) {
		await upsertModelPreference(params.providerId, modelId, {
			isEnabled: params.enabled ? 1 : 0,
		});
	}
	return { success: true };
}

/** Mark or unmark a model as a favourite (surfaces it in the Favorites section). */
export async function setModelFavoriteHandler(params: {
	providerId: string;
	modelId: string;
	favorite: boolean;
}): Promise<{ success: boolean }> {
	await upsertModelPreference(params.providerId, params.modelId, {
		isFavorite: params.favorite ? 1 : 0,
	});
	return { success: true };
}

/** Stamp a model as just-used so it floats to the top of the Latest section. */
export async function recordModelUsageHandler(params: {
	providerId: string;
	modelId: string;
}): Promise<{ success: boolean }> {
	if (!params.providerId || !params.modelId) return { success: false };
	await upsertModelPreference(params.providerId, params.modelId, {
		lastUsedAt: new Date().toISOString(),
	});
	return { success: true };
}