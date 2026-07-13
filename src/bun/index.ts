import Electrobun from "electrobun/bun";
import { BrowserWindow, Updater, Utils, Screen, ApplicationMenu } from "electrobun/bun";
import { existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { initGlobalErrorHandlers, installAiSdkWarningHandler } from "./db/error-logger";
import { runMigrations } from "./db/migrate";
import { seedDatabase } from "./db/seed";
import { closeDatabase } from "./db";
import { startWalCheckpointTimer } from "./db/connection";
import { setDiscordStatusGetter } from "./rpc/discord";
import { initPlugins } from "./plugins";
import { skillRegistry } from "./skills/registry";
import { setTaskExecutorEngine, initCronScheduler, shutdownCronScheduler, initAutomationEngine, shutdownAutomationEngine } from "./scheduler";
import { registerAdapter, initChannelManager, shutdownChannelManager, getChannelStatuses } from "./channels";
import { startIssueFixerPolling, stopIssueFixerPolling } from "./issue-fixer/poller";
import { failInterruptedRuns as failInterruptedRemoteSyncRuns } from "./remote-sync/config";
import { DiscordAdapter } from "./channels/discord-adapter";
import { WhatsAppAdapter } from "./channels/whatsapp-adapter";
import { EmailAdapter } from "./channels/email-adapter";

import { maybeRunStartupMaintenance, runIncrementalMaintenance } from "./db/maintenance";
import { startCollectionsTrashPurgeTimer, stopCollectionsTrashPurgeTimer } from "./collections/trash-purge";
import { registerWindowsUninstaller } from "./windows-registry";
import { getOrCreateEngine, setMainWindowRef } from "./engine-manager";
import { rpc, onSettingChange } from "./rpc-registration";
import { syncWorkspaceFolders } from "./rpc/projects";
import { setSchedulerRunning } from "./rpc/health";
import { initTruncationDir, cleanupTruncationFiles } from "./agents/tools/truncation";
import { initMcpClients, shutdownMcpClients } from "./mcp/client";
import { startAnnotationServer, shutdownAnnotationServer } from "./annotations/server";
import { shutdownPreviewWindow } from "./annotations/preview-window";
import { startPlaygroundServer, shutdownPlaygroundServer } from "./playground/server";
import { maybeStartRemoteRpcServer, shutdownRemoteRpcServer } from "./remote";
import { initRemoteAccess, shutdownRemoteAccess } from "./remote/manager";
import { requestHandlers } from "./remote/rpc-handlers";
import { shutdownPlayground } from "./playground/orchestrator";
import { isFreelanceEnabled } from "./freelance/feature-flag";
import { loadCustomEnvVarsIntoProcess } from "./rpc/env-vars";
import { encryptExistingSecrets } from "./lib/encrypt-existing-secrets";
import { getSetting } from "./rpc/settings";
import { startSleepBlock, stopSleepBlock } from "./system/power-save-blocker";
import { enableLaunchAtStartup, disableLaunchAtStartup } from "./system/login-item";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
// Dev-only local RPC port so a plain browser tab at DEV_SERVER_URL can drive the
// app directly (no pairing) — see the isDevMode check below and
// src/mainview/lib/remote-transport.ts's IS_DEV_DIRECT/createDevRpcTransport.
const DEV_REMOTE_RPC_PORT = 5174;

// Window state shape persisted to disk
interface WindowState {
	x: number;
	y: number;
	width: number;
	height: number;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

function getWindowStateFilePath(): string {
	return `${Utils.paths.userData}/window-state.json`;
}

async function loadWindowState(): Promise<WindowState> {
	const filePath = getWindowStateFilePath();

	if (existsSync(filePath)) {
		try {
			const file = Bun.file(filePath);
			const text = await file.text();
			const state = JSON.parse(text) as WindowState;
			if (
				typeof state.x === "number" &&
				typeof state.y === "number" &&
				typeof state.width === "number" &&
				typeof state.height === "number" &&
				state.width > 0 &&
				state.height > 0
			) {
				return state;
			}
		} catch (_err) {
			console.warn("Failed to load window state, using defaults");
		}
	}

	// Fallback: center on primary display
	const display = await Screen.getPrimaryDisplay();
	const { workArea } = display;
	const width = DEFAULT_WIDTH;
	const height = DEFAULT_HEIGHT;
	const x = Math.round((workArea.width - width) / 2) + workArea.x;
	const y = Math.round((workArea.height - height) / 2) + workArea.y;

	return { x, y, width, height };
}

async function saveWindowState(state: WindowState): Promise<void> {
	const filePath = getWindowStateFilePath();
	const dir = Utils.paths.userData;

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	try {
		await Bun.write(filePath, JSON.stringify(state, null, 2));
	} catch (_err) {
		console.error("Failed to save window state");
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return ((...args: Parameters<T>) => {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => fn(...args), delay);
	}) as T;
}

// Check if Vite dev server is running for HMR
async function getMainViewUrl(): Promise<string> {
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

// ---------------------------------------------------------------------------
// Global error handlers — install before anything else can throw
// ---------------------------------------------------------------------------
initGlobalErrorHandlers();

// Route Vercel AI SDK warnings: console in dev (visible in the run.ps1 terminal),
// error.log with a [WARNING] prefix in production/canary builds. Installed before
// any AI inference so no warning slips through with the SDK's default logger.
installAiSdkWarningHandler((await Updater.localInfo.channel()) === "dev");

// ---------------------------------------------------------------------------
// Database initialisation — run migrations then seed default data
// ---------------------------------------------------------------------------
runMigrations();
await seedDatabase();
await loadCustomEnvVarsIntoProcess();
await encryptExistingSecrets();

// Lightweight DB optimize (PRAGMA optimize + passive WAL checkpoint) runs here —
// synchronously, BEFORE the window appears — so it is invisible (no overlay, no
// skeletons). It is cheap (near-instant when nothing changed) and is the SQLite-
// recommended "run every startup" call. The rare, slow full VACUUM stays deferred
// to after the window, where it shows the maintenance overlay (see below).
runIncrementalMaintenance();

export const FREELANCE_ENABLED = isFreelanceEnabled();
if (FREELANCE_ENABLED) {
	console.log("[startup] Freelance feature enabled");
}

// Register Windows uninstaller entry (no-op on non-Windows / dev builds)
registerWindowsUninstaller().catch(() => {});

// Prevent System Sleep + Launch at Startup — both off by default, no Electrobun
// equivalent exists, so each is a custom per-platform native call (see
// src/bun/system/power-save-blocker.ts and src/bun/system/login-item.ts).
// Re-applied on every boot (self-heals a moved/updated install / a sleep block
// that was never released) and kept live via onSettingChange below.
const [preventSystemSleepSetting, launchAtStartupSetting] = await Promise.all([
	getSetting("prevent_system_sleep", "general"),
	getSetting("launch_at_startup", "general"),
]);
// getSetting JSON-parses the stored value, so a boolean true comes back as an
// actual boolean despite the string | null return type (see prompt-logger.ts).
console.log(`[startup] prevent_system_sleep=${JSON.stringify(preventSystemSleepSetting)} launch_at_startup=${JSON.stringify(launchAtStartupSetting)}`);
if ((preventSystemSleepSetting as unknown) === true) startSleepBlock();
if ((launchAtStartupSetting as unknown) === true) await enableLaunchAtStartup().catch(() => {});

onSettingChange("prevent_system_sleep", (value) => {
	console.log(`[settings] prevent_system_sleep changed to ${JSON.stringify(value)}`);
	if (value === true) startSleepBlock();
	else stopSleepBlock();
});

onSettingChange("launch_at_startup", (value) => {
	if (value === true) enableLaunchAtStartup().catch(() => {});
	else disableLaunchAtStartup().catch(() => {});
});

// Periodic WAL checkpoint timer — cheap to schedule. The one-shot incremental optimize
// already ran above (pre-window); the rare full VACUUM, workspace sync, and one-off
// cleanups are deferred to the background block (post dom-ready) so they never block
// the window from appearing.
startWalCheckpointTimer();

// Initialise truncation directory for tool output overflow + cleanup old files
initTruncationDir(Utils.paths.userData);
cleanupTruncationFiles().catch(() => {});

// Cron scheduler and automation engine start early so health checks pass
// and scheduled jobs fire on time. Plugins, skills, channels, and MCP
// are deferred to dom-ready (network/disk I/O that doesn't block the UI).
setTaskExecutorEngine(getOrCreateEngine);
await initCronScheduler();
setSchedulerRunning(true);
initAutomationEngine();

// Issue Fixer — outbound polling of GitHub issues/comments for enabled projects.
startIssueFixerPolling();

// Remote Sync — mark any sync runs interrupted by a crash/restart as failed so
// they don't appear permanently "running" in the Activity history.
void failInterruptedRemoteSyncRuns().catch((e) => console.error("[remote-sync] failInterruptedRuns:", e));

// Re-sync workspace folders whenever the global workspace path changes
onSettingChange("global_workspace_path", () => {
	syncWorkspaceFolders().catch(() => {});
});


// Load persisted window state (or compute centered defaults)
const savedFrame = await loadWindowState();
const url = await getMainViewUrl();

// True only in the "dev" channel — controls DevTools access and context menu.
const isDevMode = url.startsWith("http://localhost");

// Create the main application window using saved frame
const mainWindow = new BrowserWindow({
	title: "AgentDesk",
	url,
	frame: {
		width: savedFrame.width,
		height: savedFrame.height,
		x: savedFrame.x,
		y: savedFrame.y,
	},
	rpc,
});

// Assign the module-level ref so engine callbacks can send RPC messages
setMainWindowRef(mainWindow);

// Deferred startup jobs — scheduled AFTER the window is created so they never block it
// from appearing (moved off the synchronous critical path): workspace folder sync,
// stuck-deploy reconcile, and orphaned-settings cleanup run on the next tick; the rare
// 7-day full VACUUM (which holds a DB lock) is pushed out ~20s so it never competes with
// the initial UI/agent load — it shows the maintenance overlay for its duration.
setTimeout(() => {
	startCollectionsTrashPurgeTimer();
	syncWorkspaceFolders().catch((e) => console.error("[startup] workspace sync:", e));
	import("./rpc/deploy")
		.then(({ reconcileStuckDeploys }) => reconcileStuckDeploys())
		.catch(() => {});
	// Durability: clear shell/question approvals orphaned by the previous session
	// and emit a clean expiry signal for any card a client still shows (TASK-478).
	import("./engine-manager")
		.then(({ reconcilePendingApprovalsOnStartup }) => reconcilePendingApprovalsOnStartup())
		.catch((e) => console.error("[startup] approval reconcile:", e));
	void (async () => {
		try {
			const { like } = await import("drizzle-orm");
			const { settings: settingsTable } = await import("./db/schema");
			const { db: database } = await import("./db");
			const deleted = database.delete(settingsTable).where(like(settingsTable.key, "workflow:%")).run() as unknown as { changes: number };
			if (deleted.changes > 0) console.log(`[startup] Cleaned up ${deleted.changes} orphaned workflow settings`);
		} catch { /* non-critical */ }
	})();
}, 0);

setTimeout(() => {
	try { maybeRunStartupMaintenance(); } catch (e) { console.error("[maintenance] startup:", e); }
}, 20_000);

// Maximize once the webview DOM is ready so the layout fills the full window.
// All background services (plugins, channels, scheduler, MCP) are also started
// here so the window appears immediately without waiting for network/disk I/O.
let backgroundServicesInitialised = false;
mainWindow.webview.on("dom-ready", () => {
	mainWindow.maximize();
	setWindowTitlebarIcon("AgentDesk", appIconPath);
	if (!isDevMode) {
		// Disable right-click context menu in production — removes Inspect Element
		mainWindow.webview.executeJavascript(
			"document.addEventListener('contextmenu', e => e.preventDefault(), true)",
		);
	}
	if (!backgroundServicesInitialised) {
		backgroundServicesInitialised = true;
		(async () => {
			// Give the renderer's first data load (dashboard projects/task-stats, etc.)
			// a head start on an UNBLOCKED event loop before the synchronous parts of
			// background init run — plugin activation, the sync skill-file reads, and
			// channel/baileys crypto otherwise briefly stall the first getProjects RPC,
			// flashing a "Loading projects" skeleton once on every launch. Nothing here
			// is needed in the first second (no agent runs, channels are background).
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Plugins (LSP manager, DB viewer, etc.)
			await initPlugins();

			// Skills
			skillRegistry.loadAll();

			// Channel manager (Discord, WhatsApp, Email)
			registerAdapter("discord", () => new DiscordAdapter());
			registerAdapter("whatsapp", () => new WhatsAppAdapter());
			registerAdapter("email", () => new EmailAdapter());
			// Fire-and-forget so a slow channel (e.g. WhatsApp reconnect) never holds up MCP
			// or the local servers below.
			initChannelManager(getOrCreateEngine).catch((e) => console.error("[channels] init:", e));

			// Wire Discord status getter after channel manager is ready
			setDiscordStatusGetter(() => {
				const statuses = getChannelStatuses();
				const discordStatuses = statuses.filter((s) => s.platform === "discord");
				if (discordStatuses.length === 0) return { status: "disconnected" as const };
				if (discordStatuses.every((s) => s.status === "connected")) return { status: "connected" as const };
				if (discordStatuses.some((s) => s.status === "error")) return { status: "error" as const };
				if (discordStatuses.some((s) => s.status === "connecting")) return { status: "reconnecting" as const };
				return { status: "disconnected" as const };
			});

			// MCP clients — delayed ~10s so spawning external MCP servers (e.g. chrome-devtools
			// launching Chrome) doesn't compete with the initial UI load. MCP tools are only
			// needed once an agent uses one, which never happens in the first seconds.
			setTimeout(() => {
				initMcpClients().catch((err) => console.error("[mcp] Init error:", err));
			}, 10_000);

			// Annotation server — serves toolbar JS + receives annotations from any browser tab
			startAnnotationServer();

			// Playground static server — serves the playground temp folder for in-app previews
			startPlaygroundServer();

			// Remote RPC server (web app) — opt-in via AGENTDESK_REMOTE_RPC_PORT; no-op otherwise.
			// Dev builds default it on (unless already set) so a plain browser tab at
			// http://localhost:5173 can drive the app directly, with no pairing —
			// production/canary are unaffected since isDevMode is false there.
			if (isDevMode && !process.env.AGENTDESK_REMOTE_RPC_PORT) {
				process.env.AGENTDESK_REMOTE_RPC_PORT = String(DEV_REMOTE_RPC_PORT);
			}
			maybeStartRemoteRpcServer();

			// Remote access (web app over the relay) — connects only if the user has
			// enabled it; no-op for existing users (disabled by default).
			initRemoteAccess(requestHandlers);

			// Freelance poller — deferred to after window is shown so startup is fast
			if (FREELANCE_ENABLED) {
				import("./freelance/fetcher" as string)
					.then(({ startFreelancePoller }: { startFreelancePoller: () => void }) => startFreelancePoller())
					.catch((err: unknown) => console.error("[startup] Freelance poller unavailable:", err));
			}

			// Auto-Earn watchdog — bun-side safety net (stuck sends, engine heartbeat).
			// Self-gates on the freelance flag file + master switch, so it's inert otherwise.
			import("./freelance/watchdog")
				.then(({ startAutoEarnWatchdog }) => startAutoEarnWatchdog())
				.catch((err: unknown) => console.error("[startup] Auto-Earn watchdog unavailable:", err));
		})().catch((err) => console.error("[startup] Background services error:", err));
	}
});

// Block all external navigation — only bundled views and the Vite dev server
// are allowed.  This prevents AI-generated content from redirecting the window
// to arbitrary external URLs.
mainWindow.webview.setNavigationRules([
	"^*",                        // Block all by default
	"views://*",                 // Allow bundled views
	"http://localhost:*",        // Allow Vite HMR + Playground static/dev servers (localhost only)
	"http://127.0.0.1:*",        // Playground preview iframe (static server + agent dev servers)
]);

// Debounced save so we don't hammer the filesystem on every pixel change
const debouncedSave = debounce(async (state: WindowState) => {
	await saveWindowState(state);
}, 500);

// Track current in-memory state so move events can merge with last known size
let currentState: WindowState = { ...savedFrame };

function attachWindowListeners(win: typeof mainWindow): void {
	win.on("resize", (e: unknown) => {
		const event = e as { data: { x: number; y: number; width: number; height: number } };
		const { x, y, width, height } = event.data;
		currentState = { x, y, width, height };
		debouncedSave(currentState);
	});

	win.on("move", (e: unknown) => {
		const event = e as { data: { x: number; y: number } };
		const { x, y } = event.data;
		currentState = { ...currentState, x, y };
		debouncedSave(currentState);
	});

	win.on("close", () => {
		Utils.quit();
	});
}

attachWindowListeners(mainWindow);

// Cleanup on quit — fires for Utils.quit(), Cmd+Q, Ctrl+C, etc.
Electrobun.events.on("before-quit", () => {
	(async () => {
		try {
			const frame = mainWindow.getFrame();
			await saveWindowState({
				x: frame.x,
				y: frame.y,
				width: frame.width,
				height: frame.height,
			});
		} catch (_err) {
			console.error("Failed to save window state on quit");
		}

		stopSleepBlock();
		stopCollectionsTrashPurgeTimer();
		await shutdownChannelManager();
		shutdownCronScheduler();
		shutdownAutomationEngine();
		stopIssueFixerPolling();
		await shutdownMcpClients();
		shutdownPreviewWindow();
		shutdownAnnotationServer();
		shutdownPlayground();
		shutdownPlaygroundServer();
		shutdownRemoteRpcServer();
		shutdownRemoteAccess();
		closeDatabase();
	})();
});

ApplicationMenu.setApplicationMenu([]);

// App icon path — used for the Win32 titlebar icon FFI call.
// Production: bundled as Resources/app.ico next to the bun binary.
// Dev / fallback: source assets/icon.ico.
const bundledIconPath = join(dirname(process.argv0), "..", "Resources", "app", "app.ico");
const appIconPath = existsSync(bundledIconPath)
	? bundledIconPath
	: resolve(import.meta.dir, "../../assets/icon.ico");

function setWindowTitlebarIcon(windowTitle: string, iconFilePath: string): void {
	if (process.platform !== "win32") return;
	try {
		const user32 = dlopen("user32.dll", {
			FindWindowW:  { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			SendMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.ptr },
			LoadImageW:   { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		});

		const toWide = (s: string) => {
			const b = Buffer.alloc((s.length + 1) * 2);
			b.write(s, 0, "utf16le");
			return b;
		};

		const WM_SETICON      = 0x0080;
		const IMAGE_ICON      = 1;
		const LR_LOADFROMFILE = 0x0010;
		const LR_DEFAULTSIZE  = 0x0040;

		const pathBuf  = toWide(iconFilePath);
		const titleBuf = toWide(windowTitle);

		const hIcon = user32.symbols.LoadImageW(null, ptr(pathBuf), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
		const hwnd  = user32.symbols.FindWindowW(null, ptr(titleBuf));

		if (hwnd && hIcon) {
			user32.symbols.SendMessageW(hwnd, WM_SETICON, 1, hIcon); // ICON_BIG
			user32.symbols.SendMessageW(hwnd, WM_SETICON, 0, hIcon); // ICON_SMALL
		}
	} catch {
		// Non-fatal — icon is cosmetic only
	}
}

console.log("AgentDesk started!");
