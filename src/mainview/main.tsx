import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initClientErrorHandler } from "./lib/global-error-handler";
import { IS_REMOTE, isPaired } from "./lib/remote-transport";
import { PairingScreen } from "./components/remote/pairing-screen";
import { RemoteStatusBanner } from "./components/remote/remote-status-banner";
import { initWebNotifications } from "./lib/web-notifications";

// Install global error handlers before React renders
initClientErrorHandler();

// Register the PWA service worker — web mode only (not the Electrobun webview),
// so the desktop app is never affected by SW caching.
if (IS_REMOTE && "serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		navigator.serviceWorker.register("/sw.js").catch(() => {});
	});
}

// Suppress WebView2 status bar (URL preview on link hover).
// Strip href from all anchors on mount and observe new ones.
// TanStack Router uses onClick for navigation, so href is not needed.
function stripHrefs(root: ParentNode = document) {
	for (const a of root.querySelectorAll("a[href]")) {
		a.removeAttribute("href");
	}
}
stripHrefs();
new MutationObserver((mutations) => {
	for (const m of mutations) {
		for (const node of m.addedNodes) {
			if (node instanceof HTMLElement) {
				if (node.tagName === "A" && node.hasAttribute("href")) {
					node.removeAttribute("href");
				}
				stripHrefs(node);
			}
		}
	}
}).observe(document.body, { childList: true, subtree: true });

// Web bootstrap (TASK-482): in a plain browser, show the pairing screen until
// this device is paired to a desktop. In Electrobun (IS_REMOTE === false) this
// is always the normal app.
const needsPairing = IS_REMOTE && !isPaired();

// Web notifications for approval events when the tab is backgrounded (TASK-490).
if (IS_REMOTE && !needsPairing) initWebNotifications();

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{needsPairing ? (
			<PairingScreen />
		) : (
			<>
				<RemoteStatusBanner />
				<App />
			</>
		)}
	</StrictMode>,
);
