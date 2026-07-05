/**
 * tests/helpers/dom-shim.ts
 *
 * Minimal shim so frontend Zustand stores (src/mainview/stores/*) can be
 * imported under plain `bun test` (no browser/webview). Bun's globalThis
 * already implements EventTarget/CustomEvent/addEventListener/dispatchEvent
 * natively (verified: no jsdom/happy-dom dependency needed) — the only gaps
 * are a `window` alias and a `localStorage` stand-in, since some store
 * modules reference these at import time (e.g. kanban-store.ts registers a
 * top-level `window.addEventListener(...)`, and chat-store.ts's initial
 * state reads localStorage for drafts).
 *
 * Import this file FIRST, before importing any store under test:
 *   import "../helpers/dom-shim";
 *   const { useKanbanStore } = await import("../../src/mainview/stores/kanban-store");
 */

if (typeof (globalThis as Record<string, unknown>).window === "undefined") {
	(globalThis as Record<string, unknown>).window = globalThis;
}

if (typeof (globalThis as Record<string, unknown>).localStorage === "undefined") {
	const store = new Map<string, string>();
	(globalThis as Record<string, unknown>).localStorage = {
		getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
		setItem: (key: string, value: string) => { store.set(key, String(value)); },
		removeItem: (key: string) => { store.delete(key); },
		clear: () => { store.clear(); },
		key: (index: number) => Array.from(store.keys())[index] ?? null,
		get length() { return store.size; },
	};
}
