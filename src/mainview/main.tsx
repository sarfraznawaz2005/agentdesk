import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initClientErrorHandler } from "./lib/global-error-handler";

// Install global error handlers before React renders
initClientErrorHandler();

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
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
