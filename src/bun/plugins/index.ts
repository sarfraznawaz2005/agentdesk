import { join } from "path";
import { Utils } from "electrobun/bun";
import { scanPluginDirectory } from "./loader";
import { activatePlugin } from "./registry";
import type { LoadedPlugin } from "./loader";

// Built-in plugins — bundled with the app, not scanned from filesystem
import * as lspManagerModule from "./lsp-manager/index";
import lspManagerManifestJson from "./lsp-manager/manifest.json";

export { getPluginInstances, enablePlugin, disablePlugin, uninstallPlugin, notifyFileChange } from "./registry";
export type { PluginManifest, PluginInstance, PluginAPI } from "./types";

/** Initialize the plugin system — call once at startup after DB is ready */
export async function initPlugins(): Promise<void> {
	const builtinDir = join(import.meta.dir, "../plugins");
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
	}
}
