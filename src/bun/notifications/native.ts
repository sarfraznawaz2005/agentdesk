// src/bun/notifications/native.ts
import { shouldNotify } from "../rpc/notifications";

/**
 * Send a native OS notification for an incoming message.
 * Respects per-platform notification preferences.
 */
export async function sendNativeNotification(params: {
	platform: string;
	projectId?: string;
	title: string;
	body: string;
}): Promise<void> {
	const prefs = await shouldNotify(params.platform, params.projectId);

	if (prefs.banner) {
		// Electrobun native notification
		try {
			const { Utils } = await import("electrobun/bun");
			Utils.showNotification({
				title: params.title,
				body: params.body,
			});
		} catch {
			// Notification API may not be available in all environments
		}
	}

	// Sound and badge are handled by the frontend via RPC events
}
