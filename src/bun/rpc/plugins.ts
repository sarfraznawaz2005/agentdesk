import { db } from "../db";
import { plugins } from "../db/schema";
import { eq } from "drizzle-orm";
import { getPluginInstances, getLoadedPluginManifest, enablePlugin, disablePlugin } from "../plugins";

export async function getPluginsList() {
	const rows = await db.select().from(plugins);
	const instances = getPluginInstances();

	return rows.map((row) => {
		const instance = instances.find((i) => i.manifest.name === row.name);
		// Disabled plugins have no live `instance` (activatePlugin returns before
		// registering one), but their manifest is still known — fall back to it
		// so a disabled plugin's card shows real metadata instead of blanks.
		const manifest = instance?.manifest ?? getLoadedPluginManifest(row.name);
		return {
			id: row.id,
			name: row.name,
			displayName: manifest?.displayName ?? row.name,
			version: row.version,
			description: manifest?.description ?? "",
			author: manifest?.author ?? "",
			permissions: manifest?.permissions ?? [],
			enabled: row.enabled === 1,
			settings: JSON.parse(row.settings ?? "{}"),
			toolCount: instance?.registeredTools.length ?? 0,
			isLoaded: !!instance,
			prompt: row.prompt ?? null,
			defaultPrompt: manifest?.prompt ?? null,
			manifest: manifest ? {
				settings: manifest.settings,
			} : undefined,
		};
	});
}

export async function togglePlugin(name: string, enabled: boolean) {
	if (enabled) {
		await enablePlugin(name);
	} else {
		await disablePlugin(name);
	}
	return { success: true };
}

export async function getPluginSettings(name: string) {
	const rows = await db.select().from(plugins).where(eq(plugins.name, name)).limit(1);
	if (rows.length === 0) return {};
	return JSON.parse(rows[0].settings ?? "{}");
}

export async function savePluginSettings(name: string, settings: Record<string, unknown>) {
	const rows = await db.select().from(plugins).where(eq(plugins.name, name)).limit(1);
	if (rows.length === 0) return { success: false };
	const current = JSON.parse(rows[0].settings ?? "{}");
	const merged = { ...current, ...settings };
	await db.update(plugins).set({ settings: JSON.stringify(merged), updatedAt: new Date().toISOString() }).where(eq(plugins.name, name));
	return { success: true };
}

export async function savePluginPrompt(name: string, prompt: string | null) {
	const rows = await db.select().from(plugins).where(eq(plugins.name, name)).limit(1);
	if (rows.length === 0) return { success: false };
	const value = prompt && prompt.trim() ? prompt.trim() : null;
	await db.update(plugins).set({ prompt: value, updatedAt: new Date().toISOString() }).where(eq(plugins.name, name));
	return { success: true };
}