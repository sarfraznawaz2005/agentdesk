import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { settings } from "../db/schema";
import { logAudit } from "../db/audit";
import { clearContextLimitCache } from "../providers/models";

/**
 * Retrieve all settings, optionally filtered by category.
 * Returns a Record where keys are setting keys and values are JSON-parsed.
 */
export async function getSettings(
	category?: string,
): Promise<Record<string, unknown>> {
	const rows = category
		? await db.select().from(settings).where(eq(settings.category, category))
		: await db.select().from(settings);

	const result: Record<string, unknown> = {};
	for (const row of rows) {
		try {
			result[row.key] = JSON.parse(row.value);
		} catch {
			// If value is not valid JSON, return it as a raw string
			result[row.key] = row.value;
		}
	}
	return result;
}

/**
 * Retrieve the raw (unparsed) string value for a single setting.
 * Unlike getSetting / getSettings, this never JSON-parses the stored value —
 * useful for settings that intentionally store a serialised JSON string and
 * must come back as a string, not an object.
 * Returns null if the setting does not exist.
 */
export async function getRawSetting(
	key: string,
	category?: string,
): Promise<string | null> {
	const rows = category
		? await db
				.select()
				.from(settings)
				.where(and(eq(settings.key, key), eq(settings.category, category)))
				.limit(1)
		: await db.select().from(settings).where(eq(settings.key, key)).limit(1);

	if (rows.length === 0) return null;
	return rows[0].value; // raw string — no JSON.parse
}

/**
 * Retrieve a single setting by key (optionally filtered by category).
 * Returns null if the setting does not exist.
 */
export async function getSetting(
	key: string,
	category?: string,
): Promise<string | null> {
	const rows = category
		? await db
				.select()
				.from(settings)
				.where(and(eq(settings.key, key), eq(settings.category, category)))
				.limit(1)
		: await db.select().from(settings).where(eq(settings.key, key)).limit(1);

	if (rows.length === 0) {
		return null;
	}

	try {
		// Return the JSON-parsed value
		return JSON.parse(rows[0].value);
	} catch {
		// If not valid JSON, return as raw string
		return rows[0].value;
	}
}

/**
 * Upsert a single setting. If the key already exists, update value + category
 * + updatedAt. Otherwise insert a new row.
 */
export async function saveSetting(
	key: string,
	value: unknown,
	category: string,
): Promise<{ success: boolean }> {
	const serialized = JSON.stringify(value);
	const now = new Date().toISOString();

	// Single upsert — settings.key has a UNIQUE constraint
	await db
		.insert(settings)
		.values({ key, value: serialized, category })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: serialized, category, updatedAt: now },
		});

	if (key === "contextWindowLimit") clearContextLimitCache();

	logAudit({ action: "setting.save", entityType: "setting", details: { key, category } });
	return { success: true };
}
