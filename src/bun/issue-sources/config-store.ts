import { db } from "../db";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import type { IssueSource } from "../../shared/rpc/issues";

// Per-project, per-source config lives in the settings table as a JSON string.
const CATEGORY = "issue_sources";

function configKey(projectId: string, source: IssueSource): string {
	return `issueSource:${projectId}:${source}`;
}

/** Read a saved source config, or null if absent/empty. */
export async function getSavedConfig(
	projectId: string,
	source: IssueSource,
): Promise<Record<string, string> | null> {
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, configKey(projectId, source)))
		.limit(1);
	const raw = rows[0]?.value;
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Record<string, string>;
		return parsed && Object.keys(parsed).length > 0 ? parsed : null;
	} catch {
		return null;
	}
}

export async function saveConfig(
	projectId: string,
	source: IssueSource,
	config: Record<string, string>,
): Promise<void> {
	const key = configKey(projectId, source);
	const value = JSON.stringify(config);
	const now = new Date().toISOString();
	await db
		.insert(settings)
		.values({ key, value, category: CATEGORY })
		.onConflictDoUpdate({ target: settings.key, set: { value, category: CATEGORY, updatedAt: now } });
}

export async function deleteConfig(projectId: string, source: IssueSource): Promise<void> {
	await db.delete(settings).where(eq(settings.key, configKey(projectId, source)));
}

/** Trim + drop empty-string fields so required-field checks are accurate. */
export function cleanConfig(config: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(config)) {
		const t = (v ?? "").trim();
		if (t) out[k] = t;
	}
	return out;
}
