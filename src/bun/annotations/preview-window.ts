// ---------------------------------------------------------------------------
// AgentDesk Preview Window
// A dedicated Electrobun BrowserWindow that loads the annotation-proxy URL.
// Replaces chrome-devtools MCP for /preview — no MCP tokens, no external deps.
//
// Features:
//   • Persisted size/position
//   • Title sync from page <title>
//   • DevTools toggle via GlobalShortcut (dev mode only)
//   • Console + uncaught error capture forwarded to the annotation server
//   • fs.watch driven reload for static projects (cheap HMR for plain HTML/CSS/JS)
//   • Singleton — re-running /preview reuses + navigates the same window
// ---------------------------------------------------------------------------

import { BrowserWindow, Screen, Utils, GlobalShortcut } from "electrobun/bun";
import { existsSync, mkdirSync, watch } from "fs";
import type { FSWatcher } from "fs";
import { ANNOTATION_SERVER_PORT } from "./server";
import { getToolbarScript } from "./toolbar-script";

interface PreviewWindowState {
	width:  number;
	height: number;
	x:      number;
	y:      number;
}

export interface OpenPreviewOptions {
	proxyUrl:       string;  // http://localhost:4748/preview?...
	rawUrl:         string;  // raw target URL (used to scope fs.watch base path)
	title?:         string;
	projectId:      string;
	conversationId: string;
	workspacePath:  string;
	projectType:    string;
	devMode:        boolean;
}

const DEFAULT_WIDTH  = 1024;
const DEFAULT_HEIGHT = 768;

let previewWin:     BrowserWindow | null = null;
let currentOpts:    OpenPreviewOptions | null = null;
let titleTimer:     ReturnType<typeof setInterval> | null = null;
let lastTitle:      string = "";
let fileWatcher:    FSWatcher | null = null;
let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
let devShortcutRegistered = false;

const DEV_SHORTCUT = "CommandOrControl+Alt+I";

// ---------------------------------------------------------------------------
// Window state persistence
// ---------------------------------------------------------------------------
function stateFilePath(): string {
	return `${Utils.paths.userData}/preview-window-state.json`;
}

async function loadState(): Promise<PreviewWindowState> {
	const filePath = stateFilePath();
	if (existsSync(filePath)) {
		try {
			const text  = await Bun.file(filePath).text();
			const state = JSON.parse(text) as PreviewWindowState;
			if (state.width > 0 && state.height > 0) return state;
		} catch { /* fall through to defaults */ }
	}
	const display = await Screen.getPrimaryDisplay();
	const wa      = display.workArea;
	// Default: park in the upper-right of the work area so it sits beside main window
	return {
		width:  DEFAULT_WIDTH,
		height: DEFAULT_HEIGHT,
		x:      Math.round(wa.x + wa.width - DEFAULT_WIDTH - 24),
		y:      Math.round(wa.y + 48),
	};
}

async function saveState(state: PreviewWindowState): Promise<void> {
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

// ---------------------------------------------------------------------------
// Console hook — injected after every dom-ready so errors flow to the
// annotation server, which buffers them per-conversation. They get attached
// to the next annotation submission as additional context.
// ---------------------------------------------------------------------------
function buildConsoleHookScript(conversationId: string): string {
	return `(function(){
if (window.__agentdeskConsoleHook) return;
window.__agentdeskConsoleHook = true;
var BASE='http://localhost:${ANNOTATION_SERVER_PORT}/preview-events';
var CONV=${JSON.stringify(conversationId)};
function send(level,message,stack){
  try{
    fetch(BASE,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({conversationId:CONV,level:level,message:String(message||''),
        stack:String(stack||''),url:location.href,ts:Date.now()})}).catch(function(){});
  }catch(e){}
}
window.addEventListener('error',function(e){
  send('error', e.message || 'Uncaught error', e.error && e.error.stack || '');
});
window.addEventListener('unhandledrejection',function(e){
  var r=e.reason;
  send('error', (r && r.message) || String(r), (r && r.stack) || '');
});
var oe=console.error;
console.error=function(){
  try{ send('error', Array.prototype.map.call(arguments,function(a){
    return typeof a==='object'?JSON.stringify(a):String(a);}).join(' '), ''); }catch(_){}
  oe.apply(console,arguments);
};
var ow=console.warn;
console.warn=function(){
  try{ send('warn', Array.prototype.map.call(arguments,function(a){
    return typeof a==='object'?JSON.stringify(a):String(a);}).join(' '), ''); }catch(_){}
  ow.apply(console,arguments);
};
})();`;
}

// ---------------------------------------------------------------------------
// Title sync — poll document.title via the built-in evaluateJavascriptWithResponse
// every 2 s and reflect it in the native window title.
// ---------------------------------------------------------------------------
function startTitlePolling(win: BrowserWindow): void {
	stopTitlePolling();
	lastTitle = "";
	titleTimer = setInterval(async () => {
		try {
			const evaluate = (win.webview as unknown as {
				rpc?: { request?: { evaluateJavascriptWithResponse?: (a: { script: string }) => Promise<string> } };
			}).rpc?.request?.evaluateJavascriptWithResponse;
			if (!evaluate) return;
			const result = await evaluate({ script: "document.title || ''" });
			const t = typeof result === "string" ? result.replace(/^"|"$/g, "") : "";
			if (t && t !== lastTitle) {
				lastTitle = t;
				win.setTitle(`${t} — AgentDesk Preview`);
			}
		} catch { /* webview may be reloading */ }
	}, 2000);
}

function stopTitlePolling(): void {
	if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
}

// ---------------------------------------------------------------------------
// File watcher — static projects don't have HMR; watch their workspace and
// reload the preview window on change. Debounced to coalesce burst saves.
// ---------------------------------------------------------------------------
function stopWatcher(): void {
	if (reloadDebounce) { clearTimeout(reloadDebounce); reloadDebounce = null; }
	if (fileWatcher) {
		try { fileWatcher.close(); } catch { /* ignore */ }
		fileWatcher = null;
	}
}

function startWatcher(workspacePath: string, win: BrowserWindow): void {
	stopWatcher();
	if (!workspacePath || !existsSync(workspacePath)) {
		console.log(`[preview-window] watcher skipped — invalid workspace: '${workspacePath}'`);
		return;
	}

	// Capture the proxy URL at watcher-start time so reloads don't depend on
	// currentOpts (which may have been swapped by a re-open between events).
	const reloadProxyUrl = currentOpts?.proxyUrl ?? "";

	console.log(`[preview-window] watching ${workspacePath} for changes`);

	const shouldIgnore = (name: string): boolean => {
		if (name.startsWith(".agentdeskai") || name.startsWith(".git") ||
			name.includes("node_modules") || name.startsWith("dist") ||
			name.startsWith("build") || name.startsWith(".next") ||
			name.startsWith(".cache") || name.endsWith("~") ||
			name.endsWith(".tmp") || name.endsWith(".swp") ||
			name.includes("__tmp_") || name.endsWith(".log")) return true;
		return false;
	};

	const reload = (): void => {
		const wv = win.webview as unknown as {
			executeJavascript?: (s: string) => void;
			loadURL?:           (u: string) => void;
		};
		// Prefer executeJavascript — same channel index.ts uses; we know it works.
		// location.reload(true) forces bypassing the cache.
		if (typeof wv.executeJavascript === "function") {
			try {
				wv.executeJavascript("try{location.reload();}catch(e){}");
				console.log("[preview-window] reload via executeJavascript");
				return;
			} catch (err) {
				console.warn("[preview-window] executeJavascript reload failed:", err);
			}
		}
		// Fallback: re-load the URL with a cache-buster so the webview doesn't
		// short-circuit identical-URL loads.
		if (typeof wv.loadURL === "function" && reloadProxyUrl) {
			try {
				const u = new URL(reloadProxyUrl);
				u.searchParams.set("_r", String(Date.now()));
				wv.loadURL(u.toString());
				console.log("[preview-window] reload via loadURL");
			} catch (err) {
				console.error("[preview-window] loadURL reload failed:", err);
			}
		}
	};

	try {
		fileWatcher = watch(workspacePath, { recursive: true }, (event, filename) => {
			if (!filename) return;
			const name = String(filename);
			if (shouldIgnore(name)) return;
			console.log(`[preview-window] fs event: ${event} ${name}`);
			if (reloadDebounce) clearTimeout(reloadDebounce);
			reloadDebounce = setTimeout(reload, 250);
		});
	} catch (err) {
		console.error(`[preview-window] fs.watch failed for '${workspacePath}':`, err);
	}
}

// ---------------------------------------------------------------------------
// DevTools shortcut — only in dev mode, only while preview window is open.
// ---------------------------------------------------------------------------
function registerDevShortcut(win: BrowserWindow): void {
	if (devShortcutRegistered) return;
	try {
		GlobalShortcut.register(DEV_SHORTCUT, () => {
			try { (win.webview as unknown as { toggleDevTools?: () => void }).toggleDevTools?.(); }
			catch { /* webview may be gone */ }
		});
		devShortcutRegistered = true;
	} catch { /* ignore */ }
}

function unregisterDevShortcut(): void {
	if (!devShortcutRegistered) return;
	try { GlobalShortcut.unregister(DEV_SHORTCUT); } catch { /* ignore */ }
	devShortcutRegistered = false;
}

// ---------------------------------------------------------------------------
// Listener wiring
// ---------------------------------------------------------------------------
function attachWindowListeners(win: BrowserWindow): void {
	const persist = debounce((state: PreviewWindowState) => { saveState(state).catch(() => {}); }, 500);
	let lastState: PreviewWindowState = { x: 0, y: 0, width: 0, height: 0 };

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
		stopTitlePolling();
		stopWatcher();
		unregisterDevShortcut();
		previewWin  = null;
		currentOpts = null;
	});

	// Maximize once the webview's DOM is ready, mirroring the main window
	// behaviour (index.ts). Doing it before dom-ready can race with the OS
	// window creation and silently no-op on some Windows builds.
	let maximizedOnce = false;
	win.webview.on("dom-ready", () => {
		if (!maximizedOnce) {
			maximizedOnce = true;
			try { win.maximize(); } catch { /* ignore */ }
		}
		// Re-inject after every navigation. `dom-ready` fires on every full page
		// load in the preview window, so this is the safety net that keeps the
		// annotation toolbar present "no matter what" — internal links, JS
		// redirects, or address-bar loads that bypass the proxy (e.g. an
		// externally-hosted preview whose internal links aren't localhost/file and
		// so are never routed back through the proxy). Both scripts are idempotent,
		// so this is harmless on proxied pages that already baked the toolbar in.
		if (currentOpts) {
			try {
				const wv = win.webview as unknown as { executeJavascript?: (s: string) => void };
				wv.executeJavascript?.(buildConsoleHookScript(currentOpts.conversationId));
				wv.executeJavascript?.(getToolbarScript(ANNOTATION_SERVER_PORT, currentOpts.projectId, currentOpts.conversationId));
			} catch { /* ignore */ }
		}
	});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function openPreviewWindow(opts: OpenPreviewOptions): Promise<void> {
	currentOpts = opts;

	if (previewWin) {
		// Reuse — navigate to new URL
		try { previewWin.webview.loadURL(opts.proxyUrl); }
		catch { /* webview gone, fall through to recreate */ }
		try { previewWin.focus(); } catch { /* ignore */ }
		try { previewWin.setTitle(opts.title ?? "AgentDesk Preview"); } catch { /* ignore */ }

		// Reset watchers for the new project's workspace
		stopWatcher();
		if (opts.projectType === "static") startWatcher(opts.workspacePath, previewWin);
		return;
	}

	const frame = await loadState();
	const win = new BrowserWindow({
		title: opts.title ?? "AgentDesk Preview",
		url:   opts.proxyUrl,
		frame,
	});

	previewWin = win;
	attachWindowListeners(win);
	startTitlePolling(win);

	if (opts.projectType === "static") startWatcher(opts.workspacePath, win);
	if (opts.devMode) registerDevShortcut(win);
}

export function closePreviewWindow(): void {
	if (!previewWin) return;
	try { previewWin.close(); } catch { /* ignore */ }
	// listeners.close handler will clear state
}

export function getPreviewWindow(): BrowserWindow | null {
	return previewWin;
}

export function shutdownPreviewWindow(): void {
	stopTitlePolling();
	stopWatcher();
	unregisterDevShortcut();
	if (previewWin) {
		try { previewWin.close(); } catch { /* ignore */ }
		previewWin  = null;
		currentOpts = null;
	}
}
