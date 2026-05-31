import { sqlite } from "../connection";

export const name = "disable-db-viewer-plugin";

/**
 * The db-viewer plugin manifest already declares defaultEnabled: false, but
 * existing installs created before that flag was added have enabled = 1 in the
 * plugins table. Force-disable it so it is off for all users by default.
 * Users can still re-enable it manually from Settings > Plugins.
 */
export function run(): void {
	sqlite
		.prepare("UPDATE plugins SET enabled = 0 WHERE name = 'db-viewer' AND enabled = 1")
		.run();
}
