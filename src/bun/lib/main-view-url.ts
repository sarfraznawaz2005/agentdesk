import { Updater } from "electrobun/bun";

// Extracted from index.ts so a second window (Quick Chat) can resolve the same
// mainview URL without importing index.ts itself, whose top-level code has
// app-startup side effects (migrations, seeding, cron/channel init, and the
// single main BrowserWindow creation) that must never run twice.

const DEV_SERVER_PORT = 5173;
export const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

/** Check if the Vite dev server is running for HMR; falls back to the bundled build. */
export async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		// Retry for up to 15 seconds so Vite can finish starting when launched concurrently
		for (let i = 0; i < 30; i++) {
			try {
				await fetch(DEV_SERVER_URL, { method: "HEAD" });
				console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
				return DEV_SERVER_URL;
			} catch {
				if (i === 0) console.log("Waiting for Vite dev server...");
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}
		console.log("Vite dev server not available. Falling back to bundled files.");
	}
	return "views://mainview/index.html";
}
