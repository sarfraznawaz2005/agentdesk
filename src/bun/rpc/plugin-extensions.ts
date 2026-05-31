import { getAllExtensions } from "../plugins/extensions";

/** Return all UI extension points registered by active plugins. */
export async function getPluginExtensions() {
	return getAllExtensions();
}
