// ---------------------------------------------------------------------------
// "Project to display" — Ambient Mode projected onto a second monitor/TV
// (docs/ambient-screen-plan.md Subsystem 7). Mirrors quick-chat/window.ts's
// proven shape: its own BrowserWindow, its own createRpc() instance (never
// the shared main-window `rpc` singleton — reusing one rpc object across
// windows breaks the first window's in-flight responses, see that file's
// header comment for the full diagnosis), positioned at the chosen display's
// bounds with no OS titlebar (titleBarStyle: "hidden") for a kiosk look.
//
// Only one projected window at a time (v1) — opening a new one replaces
// whatever was already projected, rather than accumulating one per display.
// ---------------------------------------------------------------------------

import { BrowserWindow, Screen } from "electrobun/bun";
import { getMainViewUrl } from "../lib/main-view-url";
import { createRpc } from "../rpc-registration";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let win: any = null;

export async function openAmbientDisplayWindow(displayId: number): Promise<{ success: boolean; error?: string }> {
	if (win) {
		try { win.close(); } catch { /* ignore — already gone */ }
		win = null;
	}

	const display = Screen.getAllDisplays().find((d) => d.id === displayId);
	if (!display) {
		return { success: false, error: "Selected display is no longer connected." };
	}

	const url = await getMainViewUrl();
	// Same preload-based initial-route delivery quick-chat/window.ts uses —
	// runs before the page's own scripts (including the router's first read
	// of window.location.hash), so there's no race with createHashHistory().
	const preload = `window.location.hash = ${JSON.stringify("/ambient-display")};`;

	const newWin = new BrowserWindow({
		title: "AgentDesk — Ambient Display",
		url,
		frame: {
			x: display.bounds.x,
			y: display.bounds.y,
			width: display.bounds.width,
			height: display.bounds.height,
		},
		titleBarStyle: "hidden",
		preload,
		// Independent RPC instance/transport — required for any second window,
		// never the shared singleton (see this file's header comment).
		rpc: createRpc(),
	});

	newWin.webview.setNavigationRules([
		"^*",
		"views://*",
		"http://localhost:*",
		"http://127.0.0.1:*",
	]);

	newWin.on("close", () => {
		if (win === newWin) win = null;
	});

	win = newWin;
	return { success: true };
}

export function closeAmbientDisplayWindow(): void {
	if (!win) return;
	try { win.close(); } catch { /* ignore */ }
	win = null;
}

/** Whether a projected display window is currently open — used to gate the Settings/overlay control's state. */
export function hasAmbientDisplayWindow(): boolean {
	return win !== null;
}
