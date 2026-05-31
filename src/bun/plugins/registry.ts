import type { PluginInstance } from "./types";
import type { LoadedPlugin } from "./loader";
import { createPluginAPI } from "./api";
import { clearPluginExtensions } from "./extensions";
import { db } from "../db";
import { plugins as pluginsTable } from "../db/schema";
import { eq } from "drizzle-orm";

const instances = new Map<string, PluginInstance>();

/** All scanned plugins (enabled or not), keyed by name. Used to re-activate on enable. */
const loadedPlugins = new Map<string, LoadedPlugin>();

export async function activatePlugin(loaded: LoadedPlugin): Promise<void> {
	const { manifest, module, directory } = loaded;

	// Always store the loaded plugin so it can be re-activated later
	loadedPlugins.set(manifest.name, loaded);

	const rows = await db.select().from(pluginsTable).where(eq(pluginsTable.name, manifest.name)).limit(1);
	let dbRow = rows[0];

	const isNewInstall = !dbRow;

	if (!dbRow) {
		await db.insert(pluginsTable).values({
			name: manifest.name,
			version: manifest.version,
			enabled: manifest.defaultEnabled === false ? 0 : 1,
			settings: JSON.stringify(
				Object.fromEntries(
					Object.entries(manifest.settings ?? {}).map(([k, v]) => [k, v.default ?? null])
				)
			),
			prompt: manifest.prompt ?? null,
		});
		dbRow = (await db.select().from(pluginsTable).where(eq(pluginsTable.name, manifest.name)).limit(1))[0];
	}

	// Backfill manifest prompt into DB if the column is empty (e.g. after migration added the column)
	if (!isNewInstall && dbRow && !dbRow.prompt && manifest.prompt) {
		await db.update(pluginsTable).set({ prompt: manifest.prompt }).where(eq(pluginsTable.name, manifest.name));
		dbRow = { ...dbRow, prompt: manifest.prompt };
	}

	if (!dbRow || dbRow.enabled === 0) {
		console.log(`[plugins] ${manifest.name} is disabled, skipping activation`);
		return;
	}

	const { api, registeredTools, registeredHooks, fileChangeCallbacks } = createPluginAPI(manifest);

	try {
		await module.activate(api);
		instances.set(manifest.name, {
			manifest,
			directory,
			module,
			api,
			enabled: true,
			registeredTools,
			registeredHooks,
			fileChangeCallbacks,
		});

		// Call lifecycle hooks
		if (isNewInstall && typeof module.onInstall === "function") {
			await module.onInstall();
		}
		if (typeof module.onEnable === "function") {
			await module.onEnable();
		}

		console.log(`[plugins] Activated: ${manifest.displayName} v${manifest.version} (${registeredTools.length} tools)`);
	} catch (err) {
		console.error(`[plugins] Failed to activate ${manifest.name}:`, err);
	}
}

export async function deactivatePlugin(name: string): Promise<void> {
	const instance = instances.get(name);
	if (!instance) return;

	try {
		// Call onDisable hook
		if (typeof instance.module.onDisable === "function") {
			await instance.module.onDisable();
		}
		// Call plugin's deactivate if exported
		await instance.module.deactivate?.();
	} catch (err) {
		console.error(`[plugins] Error deactivating ${name}:`, err);
	}
	instances.delete(name);
	clearPluginExtensions(name);
}

export async function uninstallPlugin(name: string): Promise<void> {
	const instance = instances.get(name);
	if (instance) {
		try {
			// Call onUninstall hook
			if (typeof instance.module.onUninstall === "function") {
				await instance.module.onUninstall();
			}
		} catch (err) {
			console.error(`[plugins] Error in onUninstall for ${name}:`, err);
		}
		await deactivatePlugin(name);
	}
	// Delete from DB
	await db.delete(pluginsTable).where(eq(pluginsTable.name, name));
}

export async function enablePlugin(name: string): Promise<void> {
	await db.update(pluginsTable).set({ enabled: 1, updatedAt: new Date().toISOString() }).where(eq(pluginsTable.name, name));

	// Re-activate the plugin in memory so its extensions (sidebar items, tools, etc.) register
	const loaded = loadedPlugins.get(name);
	if (loaded && !instances.has(name)) {
		await activatePlugin(loaded);
	}
}

export async function disablePlugin(name: string): Promise<void> {
	await db.update(pluginsTable).set({ enabled: 0, updatedAt: new Date().toISOString() }).where(eq(pluginsTable.name, name));
	await deactivatePlugin(name);
}

export function getPluginInstances(): PluginInstance[] {
	return Array.from(instances.values());
}

export function getPluginInstance(name: string): PluginInstance | undefined {
	return instances.get(name);
}

/** Notify all active plugins that a file has been written/edited. Returns any diagnostics. */
export async function notifyFileChange(filePath: string, content: string): Promise<string[]> {
	const diagnostics: string[] = [];
	for (const instance of instances.values()) {
		if (!instance.enabled) continue;
		for (const cb of instance.fileChangeCallbacks) {
			try {
				const result = await cb(filePath, content);
				if (Array.isArray(result)) {
					diagnostics.push(...result);
				}
			} catch (err) {
				console.error(`[plugins] File change callback error in ${instance.manifest.name}:`, err);
			}
		}
	}
	return diagnostics;
}
