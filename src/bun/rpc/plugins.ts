import { db } from "../db";
import { plugins } from "../db/schema";
import { eq } from "drizzle-orm";
import { getPluginInstances, enablePlugin, disablePlugin } from "../plugins";

export async function getPluginsList() {
	const rows = await db.select().from(plugins);
	const instances = getPluginInstances();

	return rows.map((row) => {
		const instance = instances.find((i) => i.manifest.name === row.name);
		return {
			id: row.id,
			name: row.name,
			displayName: instance?.manifest.displayName ?? row.name,
			version: row.version,
			description: instance?.manifest.description ?? "",
			author: instance?.manifest.author ?? "",
			permissions: instance?.manifest.permissions ?? [],
			enabled: row.enabled === 1,
			settings: JSON.parse(row.settings ?? "{}"),
			toolCount: instance?.registeredTools.length ?? 0,
			isLoaded: !!instance,
			prompt: row.prompt ?? null,
			defaultPrompt: instance?.manifest.prompt ?? null,
			manifest: instance?.manifest ? {
				settings: instance.manifest.settings,
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