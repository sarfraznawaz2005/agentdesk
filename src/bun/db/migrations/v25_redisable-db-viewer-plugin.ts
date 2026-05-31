import { sqlite } from "../connection";

export const name = "redisable-db-viewer-plugin";

/**
 * Corrective follow-up to v10. A bug in the plugin manifest validator
 * (manifest.ts) stripped the `defaultEnabled` flag during parsing, so the
 * plugin registry inserted db-viewer with enabled = 1 for every install created
 * after v10 ran — defeating the "off by default" intent. The validator is now
 * fixed so fresh installs insert enabled = 0, but installs that already received
 * the erroneously-enabled row need a one-time correction.
 *
 * Force-disable db-viewer so it is off by default for all users. Anyone who
 * wants it can re-enable it from Settings > Plugins.
 */
export function run(): void {
	sqlite
		.prepare("UPDATE plugins SET enabled = 0 WHERE name = 'db-viewer' AND enabled = 1")
		.run();
}
