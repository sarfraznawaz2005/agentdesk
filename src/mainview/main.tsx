import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initClientErrorHandler } from "./lib/global-error-handler";
import { IS_REMOTE, isPaired, REPAIR_REASON_KEY } from "./lib/remote-transport";
import { completeAndStorePairing, clearStoredPairing } from "../shared/remote/web-pairing";
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

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const root = createRoot(document.getElementById("root")!);

// "Pair via QR" deep-link: a scanned QR opens the app at `?pair=<code>`. Auto-pair
// this device, then reload onto a clean URL — which both drops the secret from the
// address bar/history and re-boots with a live relay transport (the transport is
// created at module load, so it must see the stored pairing on a fresh load).
const pairCode = IS_REMOTE ? new URLSearchParams(window.location.search).get("pair") : null;

if (pairCode) {
	root.render(
		<StrictMode>
			<div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
				<p className="text-sm text-muted-foreground">Pairing this device…</p>
			</div>
		</StrictMode>,
	);
	void (async () => {
		const cleanUrl = window.location.origin + window.location.pathname;
		try {
			// On success this overwrites any prior pairing with the new one.
			await completeAndStorePairing(pairCode.trim());
		} catch {
			// The new pairing failed (e.g. a corrupt/expired code). Clear any prior
			// pairing so the reload lands on the PairingScreen with an explanation,
			// instead of silently reconnecting to a stale device and hanging on
			// "Connecting… device may have been removed".
			try { clearStoredPairing(); } catch { /* ignore */ }
			try { sessionStorage.setItem(REPAIR_REASON_KEY, "Couldn't pair from that QR — scan again, or paste the code from your desktop."); } catch { /* ignore */ }
		}
		window.location.replace(cleanUrl);
	})();
} else {
	// Web bootstrap (TASK-482): in a plain browser, show the pairing screen until
	// this device is paired to a desktop. In Electrobun (IS_REMOTE === false) this
	// is always the normal app.
	const needsPairing = IS_REMOTE && !isPaired();

	// Web notifications for approval events when the tab is backgrounded (TASK-490).
	if (IS_REMOTE && !needsPairing) initWebNotifications();

	root.render(
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
}
