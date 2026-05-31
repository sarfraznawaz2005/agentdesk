import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";
import { validateManifest } from "./manifest";
import type { PluginManifest, PluginModule } from "./types";

export interface LoadedPlugin {
	manifest: PluginManifest;
	module: PluginModule;
	directory: string;
}

export async function scanPluginDirectory(pluginsDir: string): Promise<LoadedPlugin[]> {
	if (!existsSync(pluginsDir)) return [];

	const entries = await readdir(pluginsDir, { withFileTypes: true });
	const results: LoadedPlugin[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const pluginDir = join(pluginsDir, entry.name);
		const manifestPath = join(pluginDir, "manifest.json");
		const indexPath = join(pluginDir, "index.ts");

		if (!existsSync(manifestPath)) {
			console.warn(`[plugins] Skipping ${entry.name}: no manifest.json`);
			continue;
		}
		if (!existsSync(indexPath)) {
			console.warn(`[plugins] Skipping ${entry.name}: no index.ts`);
			continue;
		}

		try {
			const raw = JSON.parse(await Bun.file(manifestPath).text());
			const validation = validateManifest(raw);
			if (!validation.valid) {
				console.warn(`[plugins] Invalid manifest in ${entry.name}:`, validation.errors);
				continue;
			}

			const mod = await import(indexPath);
			if (typeof mod.activate !== "function") {
				console.warn(`[plugins] ${entry.name} has no activate() export`);
				continue;
			}

			results.push({
				manifest: validation.manifest,
				module: mod as PluginModule,
				directory: pluginDir,
			});
		} catch (err) {
			console.error(`[plugins] Failed to load ${entry.name}:`, err);
		}
	}

	return results;
}
