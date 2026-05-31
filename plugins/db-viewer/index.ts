import type { PluginAPI } from "../../src/bun/plugins/types";

export async function activate(api: PluginAPI) {
	api.log("info", "Activating Database Viewer plugin");

	api.registerSidebarItem({
		id: "db-viewer",
		label: "DB Viewer",
		icon: "Database",
		href: "/plugin/db-viewer",
	});

	api.log("info", "Database Viewer plugin activated");
}

export async function deactivate() {
	// no-op
}
