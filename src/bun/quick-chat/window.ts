// ---------------------------------------------------------------------------
// Quick Chat window management — one native, rpc-bridged BrowserWindow per
// Quick Chat project (folder). Unlike the /preview window (annotations/
// preview-window.ts), which loads a foreign URL with no rpc, this loads the
// same mainview bundle as the main window at a #/quick-chat/<projectId>
// route. Each window gets its OWN RPC instance via rpc-registration.ts's
// createRpc() — NOT the shared `rpc` singleton the main window uses. Reusing
// one rpc object across multiple BrowserWindows was tried first and broke
// the main window: BrowserView's constructor calls
// `this.rpc.setTransport(this.createTransport())`, and Electrobun's RPC
// (node_modules/electrobun/dist/api/shared/rpc.ts's createRPC) keeps a
// single mutable `transport` closed over by that one rpc object — so opening
// a second window silently repoints ALL of the first window's in-flight
// responses and future sends at the second window's transport. Confirmed
// live: with the main window and a Quick Chat window both open, the main
// window's RPC calls (e.g. getProjectsList) timed out while Quick Chat's own
// calls worked, because Quick Chat's window was created (and so captured the
// transport) last. createRpc() mints an independent transport/request-
// tracking closure per call — safe to share the underlying handler
// implementations (stateless) but never the rpc object itself across windows.
//
// Self-contained: applies the same navigation-rules lockdown, maximize, and
// titlebar-icon treatment the main window gets in index.ts (the production
// Cut/Copy/Paste-only context menu is a frontend concern — see
// components/production-context-menu.tsx — so it applies here automatically,
// no per-window wiring needed), so a Quick-Chat-only launch (no main window at all — see
// docs/quick-chat-plan.md Subsystem 6) doesn't lose any of that. Window-state
// (size/position) is a single shared file, not per-project — mirrors
// preview-window.ts's single state file rather than accumulating one file per
// distinct folder ever quick-chatted.
// ---------------------------------------------------------------------------

import { BrowserWindow, Screen, Utils } from "electrobun/bun";
import { existsSync, mkdirSync } from "fs";
import { getMainViewUrl } from "../lib/main-view-url";
import { appIconPath, brandWindow, focusWebviewContent } from "../lib/app-icon";
import { createRpc } from "../rpc-registration";
import { registerProjectWindow, unregisterProjectWindow, broadcastToProject, engines, abortAllAgents } from "../engine-manager";

const WINDOW_TITLE_PREFIX = "AgentDesk QuickChat";

/** The REAL title shown to the user — no length limit, since brandWindow
 * (src/bun/lib/app-icon.ts) sets this via a raw SetWindowTextW call, not
 * Electrobun's own setTitle (which silently hard-truncates at exactly 35
 * chars — confirmed by live measurement, see brandWindow's comment). */
function windowTitleFor(folderName: string): string {
	return `${WINDOW_TITLE_PREFIX} - ${folderName}`;
}

/**
 * Short, merely-unique marker used ONLY to locate the window via FindWindowW
 * (an exact-text lookup) — never shown to the user. Keyed by the window's
 * own numeric id (BrowserWindow#id) so two Quick Chat windows can never
 * collide, regardless of folder name. Deliberately well under Electrobun's
 * 35-char setTitle limit for any realistic id value.
 */
function shortMarkerFor(windowId: number): string {
	return `AgentDesk-QC-${windowId}`;
}

interface QuickChatWindowState {
	width: number;
	height: number;
	x: number;
	y: number;
}

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 800;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const windows = new Map<string, any>();

// Pull-based fallback for the `preload` initial-route delivery below. Keyed
// by the window's own numeric id (BrowserWindow#id — the same value
// Electrobun injects into that window's webview as window.__electrobunWindowId,
// per node_modules/electrobun/dist/api/bun/proc/native.ts's initWebview call
// site). If the native webview gets torn down and silently recreated after a
// cold start (see docs/quick-chat-plan.md), the recreated page has none of
// preload's state, but it CAN still make an RPC request — that only needs
// its own JS to be running, unlike a Bun-initiated push into a webview whose
// native pointer readiness can't be trusted (see the three prior approaches
// this replaces, discussed at the `preload` assignment below). The
// getQuickChatRoute RPC handler (rpc/projects.ts) reads this map so the
// frontend can self-correct. Process-lifetime, never cleared — one entry per
// Quick Chat window ever opened is too small to be worth expiring.
const pendingRoutes = new Map<number, { projectId: string; conversationId: string }>();

/** Looked up by the getQuickChatRoute RPC handler. Null for any window id
 * that was never a Quick Chat window (including the main window). */
export function getPendingQuickChatRoute(windowId: number): { projectId: string; conversationId: string } | null {
	return pendingRoutes.get(windowId) ?? null;
}

type EmptyListener = () => void;
let onAllWindowsClosed: EmptyListener | null = null;

type DomReadyListener = () => void;
let onFirstDomReady: DomReadyListener | null = null;
let firstDomReadyFired = false;

/**
 * Register a one-time callback for the first Quick Chat window's dom-ready —
 * the hook index.ts uses to bootstrap background services (plugins, skills,
 * channels, MCP) on a Quick-Chat-only launch that never creates a main
 * window, mirroring what the main window's own dom-ready already does today.
 * No-op if a Quick Chat window's dom-ready already fired before this was set.
 */
export function setOnFirstQuickChatDomReady(listener: DomReadyListener | null): void {
	onFirstDomReady = listener;
}

/**
 * Register a callback for when the last open Quick Chat window closes. Used
 * by index.ts ONLY for a Quick-Chat-only launch (no main window) to quit the
 * process once nothing is left open — a normal launch's lifetime is governed
 * by the main window's own close handler and must not register this.
 */
export function setOnAllQuickChatWindowsClosed(listener: EmptyListener | null): void {
	onAllWindowsClosed = listener;
}

function stateFilePath(): string {
	return `${Utils.paths.userData}/quick-chat-window-state.json`;
}

async function loadState(): Promise<QuickChatWindowState> {
	const filePath = stateFilePath();
	if (existsSync(filePath)) {
		try {
			const text = await Bun.file(filePath).text();
			const state = JSON.parse(text) as QuickChatWindowState;
			if (state.width > 0 && state.height > 0) return state;
		} catch { /* fall through to defaults */ }
	}
	const display = await Screen.getPrimaryDisplay();
	const wa = display.workArea;
	return {
		width: DEFAULT_WIDTH,
		height: DEFAULT_HEIGHT,
		x: Math.round(wa.x + (wa.width - DEFAULT_WIDTH) / 2),
		y: Math.round(wa.y + (wa.height - DEFAULT_HEIGHT) / 2),
	};
}

async function saveState(state: QuickChatWindowState): Promise<void> {
	const dir = Utils.paths.userData;
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	try { await Bun.write(stateFilePath(), JSON.stringify(state, null, 2)); }
	catch { /* non-critical */ }
}

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
	let t: ReturnType<typeof setTimeout> | undefined;
	return ((...args: Parameters<T>) => {
		if (t !== undefined) clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	}) as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachWindowListeners(projectId: string, win: any, folderName: string): void {
	const persist = debounce((state: QuickChatWindowState) => { saveState(state).catch(() => {}); }, 500);
	let lastState: QuickChatWindowState = { x: 0, y: 0, width: 0, height: 0 };

	win.on("resize", (e: unknown) => {
		const ev = e as { data: { x: number; y: number; width: number; height: number } };
		lastState = { x: ev.data.x, y: ev.data.y, width: ev.data.width, height: ev.data.height };
		persist(lastState);
	});
	win.on("move", (e: unknown) => {
		const ev = e as { data: { x: number; y: number } };
		lastState = { ...lastState, x: ev.data.x, y: ev.data.y };
		persist(lastState);
	});
	win.on("close", () => {
		// Unlike the main window (which shares one always-open window across
		// every project), closing a Quick Chat window is the user's clear
		// signal they're done with this folder's session — stop the PM stream
		// and any running sub-agents rather than leaving them to keep working
		// unattended against a project whose window (and, for a Quick-Chat-
		// only launch, potentially the whole process — see
		// setOnAllQuickChatWindowsClosed below) is going away. Mirrors the
		// same two calls the stopAllAgents RPC handler makes
		// (rpc-groups/conversations-control.ts).
		engines.get(projectId)?.stopAll();
		abortAllAgents(projectId);
		windows.delete(projectId);
		unregisterProjectWindow(projectId);
		if (windows.size === 0) onAllWindowsClosed?.();
	});

	// Mirrors index.ts's main-window dom-ready treatment: maximize, titlebar
	// icon, and — once, across every Quick Chat window — kick off the
	// background-services hook.
	// The initial route itself is NOT handled here — see the `preload` option
	// on the BrowserWindow constructor in openQuickChatWindow below.
	win.webview.on("dom-ready", () => {
		try { win.maximize(); } catch { /* ignore */ }
		// The loaded page's static <title>AgentDesk</title> (src/mainview/
		// index.html — identical for every route, including Quick Chat) gets
		// auto-synced onto the native window by the time dom-ready fires,
		// overwriting whatever title the BrowserWindow constructor was given.
		// Re-assert a short, merely-unique marker (NOT the real display title
		// — Electrobun's own setTitle silently truncates at 35 chars, see
		// brandWindow's comment) so FindWindowW can locate this exact window,
		// then let brandWindow set the real, untruncated title itself.
		const marker = shortMarkerFor(win.id);
		const displayTitle = windowTitleFor(folderName);
		try { win.setTitle(marker); } catch { /* ignore */ }
		brandWindow(marker, appIconPath, displayTitle);
		// Force real OS keyboard focus into the webview's actual render
		// surface — see focusWebviewContent's own comment for the full,
		// CDP-verified diagnosis of why this is needed (document.activeElement
		// being the textarea is NOT sufficient; the render widget itself needs
		// real focus for keystrokes to be delivered at all). Delayed so it
		// runs after the async conversation load + React's own rAF-deferred
		// textarea.focus() have settled (a local SQLite query, not network-
		// bound) — searches by displayTitle since brandWindow's SetWindowTextW
		// call above already changed the window's real title to it.
		const refocusTextarea = () => {
			try {
				win.webview.executeJavascript("document.querySelector('textarea')?.focus()");
			} catch { /* ignore */ }
		};
		setTimeout(() => {
			focusWebviewContent(displayTitle);
			refocusTextarea();
			setTimeout(refocusTextarea, 150);
			setTimeout(refocusTextarea, 400);
		}, 300);
		if (!firstDomReadyFired) {
			firstDomReadyFired = true;
			onFirstDomReady?.();
		}
	});
}

/**
 * Open (or focus + re-target) the Quick Chat window for a project. If a
 * window is already open for this project, it's focused and sent the
 * existing `switchToConversation` broadcast (already used by pm-tools.ts for
 * cross-project navigation) to switch to the given conversation, rather than
 * opening a second window for the same folder (one window per Quick Chat
 * project). QuickChatPage's own setActiveProject(projectId) on mount is all
 * that's needed for the existing global chat-event-handlers.ts listener to
 * pick this up — no new frontend wiring required.
 */
export async function openQuickChatWindow(projectId: string, conversationId: string, folderName: string): Promise<void> {
	const existing = windows.get(projectId);
	if (existing) {
		try { existing.activate(); } catch { /* ignore — window may be in a bad state, fall through to recreate below is NOT attempted here since `existing` is still registered; a genuinely dead window will be cleaned up by its own close handler */ }
		broadcastToProject(projectId, "switchToConversation", { conversationId, projectId });
		return;
	}

	const frame = await loadState();
	// Bare url — no hash, no query string. Both break Electrobun's views://
	// flat-file loader, which resolves the url as a literal file path with no
	// URL-component awareness: anything appended to it (hash or query) makes
	// it try to open a file literally named "...index.html#/quick-chat/<id>"
	// (or "...index.html?qc=<id>") on disk, which fails and leaves the window
	// blank — confirmed via two separate live tests, one for each form.
	const url = await getMainViewUrl();

	// The initial route is delivered via `preload` instead — reading
	// node_modules/electrobun/dist/api/bun/proc/native.ts's initWebview call
	// site confirms this option is passed straight through as raw JavaScript
	// SOURCE TEXT (`const customPreload = preload; ... toCString(customPreload
	// || "")`), not fetched as a views:///http URL, and Electrobun runs it
	// after the page's HTML is parsed but before ANY of the page's own
	// scripts execute — including before router.tsx's createHashHistory()
	// call, since that only happens once main.tsx's import graph starts
	// evaluating. Setting the hash here means the router's very first read of
	// window.location.hash already sees the correct value — no race, and no
	// dependency on the window's `url` at all. Two RPC/script-injection-after-
	// dom-ready approaches were tried first and don't work: (1) a raw
	// `location.hash =` / `history.replaceState` call from Bun (via
	// executeJavascript or rpc.send, which share the same delivery mechanism)
	// never reliably reaches the page — Electrobun's own BrowserView.ts shows
	// both silently no-op if the native webview pointer isn't set yet, which
	// a live test showed being true for several seconds after dom-ready on a
	// cold-started process; (2) even when delivered, @tanstack/history's
	// createHashHistory (node_modules/@tanstack/history/dist/cjs/index.cjs)
	// only reacts to its OWN monkey-patched pushState/replaceState and the
	// native "popstate" event — it has no "hashchange" listener, so a raw
	// `location.hash =` assignment is invisible to it regardless of timing.
	// Calling history.replaceState from a preload script sidesteps that too,
	// since it runs before the monkey-patch even exists — createHashHistory
	// just reads the already-correct location fresh when it later runs.
	const preload = `window.location.hash = ${JSON.stringify(
		`/quick-chat/${projectId}?c=${encodeURIComponent(conversationId)}`,
	)};`;

	// Best-effort initial title for the brief pre-dom-ready window — may be
	// silently truncated by Electrobun's own 35-char setTitle limit if long,
	// or overwritten by the page's static title once it loads. Corrected to
	// the real, untruncated text via brandWindow once dom-ready fires (see
	// attachWindowListeners below).
	const win = new BrowserWindow({
		title: windowTitleFor(folderName),
		url,
		frame,
		preload,
		rpc: createRpc(),
	});

	// Record the fallback entry right away, keyed by this window's own id —
	// window.__electrobunWindowId in that window's webview will match win.id
	// regardless of which webview instance (original or silently recreated)
	// ends up asking for it.
	pendingRoutes.set(win.id, { projectId, conversationId });

	// Same lockdown the main window applies — prevents AI-generated content
	// from redirecting this window to arbitrary external URLs.
	win.webview.setNavigationRules([
		"^*",                        // Block all by default
		"views://*",                 // Allow bundled views
		"http://localhost:*",        // Allow Vite HMR (dev only)
		"http://127.0.0.1:*",        // Allow local preview/dev servers
	]);

	windows.set(projectId, win);
	registerProjectWindow(projectId, win);
	attachWindowListeners(projectId, win, folderName);
}

/** Whether a Quick Chat window is currently open for this project. */
export function hasQuickChatWindow(projectId: string): boolean {
	return windows.has(projectId);
}

/** Whether ANY Quick Chat window is currently open — used by index.ts to
 * decide whether closing the main window should quit the whole process (see
 * its "close" handler) or leave it running for in-progress Quick Chat work. */
export function hasAnyQuickChatWindows(): boolean {
	return windows.size > 0;
}

/** Closes every open Quick Chat window — used on app shutdown. */
export function shutdownQuickChatWindows(): void {
	for (const [projectId, win] of windows) {
		try { win.close(); } catch { /* ignore */ }
		unregisterProjectWindow(projectId);
	}
	windows.clear();
}
