import { join, resolve } from "path";
import { existsSync } from "fs";
import { Utils } from "electrobun/bun";
import { scanPluginDirectory } from "./loader";
import { activatePlugin } from "./registry";
import type { LoadedPlugin } from "./loader";

// Built-in plugins — bundled with the app, not scanned from filesystem
import * as lspManagerModule from "./lsp-manager/index";
import lspManagerManifestJson from "./lsp-manager/manifest.json";

export { getPluginInstances, getLoadedPluginManifest, enablePlugin, disablePlugin, uninstallPlugin, notifyFileChange } from "./registry";
export type { PluginManifest, PluginInstance, PluginAPI } from "./types";

/**
 * Absolute path to the project-root `plugins/` directory (e.g. `plugins/db-viewer/`),
 * bundled into the packaged app via `electrobun.config.ts`'s copy section
 * (`"plugins": "plugins"`) — mirrors `skills/registry.ts`'s `bundledDir` getter
 * exactly, for the same reason: `join(import.meta.dir, "../plugins")` reaches the
 * copied directory once Electrobun flattens `src/bun/*` under `Resources/app/bun/`,
 * but in dev mode this file still runs from its real source location
 * (`src/bun/plugins/`), where `../plugins` just resolves back to itself. Preferring
 * `process.cwd()/plugins` in dev also means a plugin edit doesn't need a rebuild.
 */
function getBuiltinPluginsDir(): string {
	const buildResolved = resolve(import.meta.dir, "../plugins");
	const projectRoot = join(process.cwd(), "plugins");
	if (existsSync(projectRoot) && resolve(projectRoot) !== resolve(buildResolved)) {
		return projectRoot;
	}
	return buildResolved;
}

/** Initialize the plugin system — call once at startup after DB is ready */
export async function initPlugins(): Promise<void> {
	const builtinDir = getBuiltinPluginsDir();
	const userDir = join(Utils.paths.userData, "plugins");

	console.log("[plugins] Scanning for plugins...");

	// Built-in plugins (bundled in code, imports work at runtime)
	const builtinInCode: LoadedPlugin[] = [
		{
			manifest: lspManagerManifestJson as LoadedPlugin["manifest"],
			module: lspManagerModule,
			directory: join(import.meta.dir, "lsp-manager"),
		},
	];

	// Filesystem-scanned plugins
	const builtinPlugins = await scanPluginDirectory(builtinDir);
	const userPlugins = await scanPluginDirectory(userDir);

	const all = [...builtinInCode, ...builtinPlugins, ...userPlugins];
	console.log(`[plugins] Found ${all.length} plugin(s)`);

	for (const plugin of all) {
		await activatePlugin(plugin);
		// Real event-loop yield between plugins (activatePlugin's own awaits are
		// mostly synchronous bun:sqlite calls, so they don't actually free the JS
		// thread) — keeps this loop from starving other async work mid-startup.
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}
