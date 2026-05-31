import { eq } from "drizzle-orm";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { aiProviders } from "../db/schema";
import { createProviderAdapter, type ProviderConfig } from "../providers";
import { logAudit } from "../db/audit";

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
): Promise<{ success: boolean; id: string }> {
	const now = new Date().toISOString();

	if (params.id) {
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
	if (params.baseUrl) {
		const normalizedNew = normalizeUrlForComparison(params.baseUrl);
		const duplicate = existing.find(
			(r) => r.baseUrl && normalizeUrlForComparison(r.baseUrl) === normalizedNew,
		);
		if (duplicate) {
			return { success: false, id: duplicate.id, error: "A provider with this base URL already exists." } as never;
		}
	} else {
		const duplicate = existing.find((r) => r.providerType === params.providerType && !r.baseUrl);
		if (duplicate) {
			return { success: false, id: duplicate.id, error: `A ${params.providerType} provider already exists.` } as never;
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
			models,
		});
	}

	return results;
}

/**
 * List available models from a provider without saving it.
 * Used during onboarding to show model options after API key is entered.
 */
export async function listProviderModelsHandler(params: {
	providerType: string;
	apiKey: string;
	baseUrl?: string;
}): Promise<{ success: boolean; models: string[]; error?: string }> {
	try {
		const normalizedBaseUrl = params.baseUrl ? normalizeBaseUrl(params.baseUrl) : null;
		const config: ProviderConfig = {
			id: "temp",
			name: "temp",
			providerType: params.providerType,
			apiKey: params.apiKey,
			baseUrl: normalizedBaseUrl,
			defaultModel: null,
		};
		const adapter = createProviderAdapter(config);
		const models = await adapter.listModels();
		return { success: true, models };
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
		const models = await adapter.listModels();
		return { success: true, models };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return { success: false, models: [], error };
	}
}