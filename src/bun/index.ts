import Electrobun from "electrobun/bun";
import { BrowserWindow, Utils, Screen, ApplicationMenu } from "electrobun/bun";
import { existsSync, mkdirSync } from "fs";
import { basename } from "path";
import { registerTelemetry } from "ai";
import { initGlobalErrorHandlers, installAiSdkWarningHandler } from "./db/error-logger";
import { telemetrySink } from "./agents/telemetry-sink";
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
import { getMainViewUrl } from "./lib/main-view-url";
import { appIconPath, brandWindow } from "./lib/app-icon";
import { parseQuickChatPathFromArgv } from "./quick-chat/launch-args";
import { acquireSingleInstanceLock, sendHandoffToPrimary, shutdownSingleInstanceServer, type HandoffRequest, type OpenQuickChatRequest } from "./single-instance";
import { openQuickChatForPath } from "./rpc/projects";
import { openQuickChatWindow, setOnAllQuickChatWindowsClosed, setOnFirstQuickChatDomReady, shutdownQuickChatWindows, hasAnyQuickChatWindows } from "./quick-chat/window";
import { registerQuickChatMenu, unregisterQuickChatMenu } from "./quick-chat/os-integration";

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

/** Resolves (or reuses) the Quick Chat project for a path and opens/focuses its window. */
async function handleQuickChatRequest(req: OpenQuickChatRequest): Promise<void> {
	try {
		const result = await openQuickChatForPath(req.workspacePath);
		if (result.success) {
			await openQuickChatWindow(result.projectId, result.conversationId, basename(req.workspacePath));
		} else {
			console.error("[quick-chat] openQuickChatForPath failed:", result.error);
		}
	} catch (err) {
		console.error("[quick-chat] Failed to handle request:", err);
	}
}

// ---------------------------------------------------------------------------
// Background services are split into two tiers:
//
//   - "Core": plugins (incl. LSP), skills, MCP, and the annotation server
//     (/preview). Needed regardless of launch type — Quick Chat explicitly
//     needs LSP/skills/MCP too — so these run behind whichever window's
//     dom-ready fires first, Quick Chat or main.
//   - "Full-instance": channels (Discord/WhatsApp/Email), the Playground
//     static server, the remote RPC/web-app server, and the Freelance
//     poller/watchdog. None of these are reachable from — or meaningful to —
//     a Quick Chat window (no channels config UI, no route to Playground,
//     etc), so they're skipped entirely for a Quick-Chat-only launch. They
//     only run once a real main window exists, which happens either at a
//     normal launch or later if this process gets PROMOTED via an
//     "activate-main-window" handoff (see ensureMainWindow below) — in
//     which case they start then, not skipped forever.
//
// Each tier guards itself so it only ever runs once per process.
// ---------------------------------------------------------------------------

let coreBackgroundServicesInitialised = false;

async function initCoreBackgroundServices(): Promise<void> {
	if (coreBackgroundServicesInitialised) return;
	coreBackgroundServicesInitialised = true;

	// Give the renderer's first data load (dashboard projects/task-stats, etc.)
	// a head start on an UNBLOCKED event loop before the synchronous parts of
	// background init run — plugin activation and the sync skill-file reads
	// otherwise briefly stall the first getProjects RPC, flashing a "Loading
	// projects" skeleton once on every launch. Also gives WebView2's native
	// controller construction (still finishing asynchronously off-thread at this
	// point) a much wider head start before that same CPU-heavy synchronous work
	// competes for the JS thread — starving its completion callback has been
	// observed to tear down and silently recreate the whole webview a few seconds
	// into a cold start (Quick Chat's preload-routed window, in particular). Nothing
	// here is needed in the first several seconds (no agent runs).
	await new Promise((resolve) => setTimeout(resolve, 4500));

	// Plugins (LSP manager, DB viewer, etc.) — Quick Chat needs LSP tools too.
	await initPlugins();

	// Yield back to the event loop before the sync skill-file reads below, so a
	// still-settling WebView2 controller callback isn't stuck behind those too.
	await new Promise((resolve) => setTimeout(resolve, 0));

	// Skills — explicitly needed by Quick Chat as well.
	skillRegistry.loadAll();

	// MCP clients — delayed ~10s so spawning external MCP servers (e.g. chrome-devtools
	// launching Chrome) doesn't compete with the initial UI load. MCP tools are only
	// needed once an agent uses one, which never happens in the first seconds.
	setTimeout(() => {
		initMcpClients().catch((err) => console.error("[mcp] Init error:", err));
	}, 10_000);

	// Annotation server — serves toolbar JS + receives annotations from any browser
	// tab; also backs the /preview slash-command, which Quick Chat still supports.
	startAnnotationServer();
}

let fullInstanceServicesInitialised = false;

async function initFullInstanceServices(isDevMode: boolean): Promise<void> {
	if (fullInstanceServicesInitialised) return;
	fullInstanceServicesInitialised = true;

	// Channel manager (Discord, WhatsApp, Email) — not reachable from Quick Chat
	// (no Channels settings tab there), so skipped entirely for a Quick-Chat-only
	// launch; starts here once a real main window exists.
	registerAdapter("discord", () => new DiscordAdapter());
	registerAdapter("whatsapp", () => new WhatsAppAdapter());
	registerAdapter("email", () => new EmailAdapter());
	// Fire-and-forget so a slow channel (e.g. WhatsApp reconnect) never holds up
	// the local servers below.
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

	// Playground static server — serves the playground temp folder for in-app
	// previews. Quick Chat's UI has no route to Playground at all, so this
	// would be pure waste for a Quick-Chat-only process.
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

	// Freelance poller — unrelated to Quick Chat entirely.
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
}

let schedulingServicesInitialised = false;

/**
 * Cron scheduler, automation engine, and Issue Fixer polling. Skipped
 * entirely (not just deferred) for a Quick-Chat-only launch — these are
 * project-level automation features with no configuration surface reachable
 * from a Quick Chat window — and start here once a real main window exists
 * (a normal launch, or a later promotion via ensureMainWindow).
 */
async function initSchedulingServices(): Promise<void> {
	if (schedulingServicesInitialised) return;
	schedulingServicesInitialised = true;
	await initCronScheduler();
	setSchedulerRunning(true);
	initAutomationEngine();
	startIssueFixerPolling();
}

// null until a real main window exists in this process — either from a normal
// launch, or later via ensureMainWindow() promoting a Quick-Chat-only process
// that received an "activate-main-window" handoff. Read by the before-quit
// handler and by the prevent-sleep/launch-at-startup onSettingChange handlers
// below (both should no-op while this is null — see ensureMainWindow's own
// startup-preferences apply for why that's not a gap).
let mainWindow: BrowserWindow | null = null;
let mainWindowCreationPromise: Promise<void> | null = null;

/**
 * Quits the process once NO window of any kind remains — main window closed
 * AND every Quick Chat window closed. Called from both the main window's own
 * "close" handler (below) and Quick Chat's setOnAllQuickChatWindowsClosed
 * hook, since either can be the last one standing: a normal launch can have
 * Quick Chat windows opened into it afterward (see quick-chat/window.ts),
 * and a Quick-Chat-only launch can later be promoted to a full instance via
 * ensureMainWindow(). Closing the main window must NOT quit the process
 * while Quick Chat windows are still open — they can have agents mid-work
 * (a real bug: closing the main window used to call Utils.quit()
 * unconditionally, silently killing every other open Quick Chat window and
 * whatever it was doing).
 */
function maybeQuitWhenAllWindowsClosed(): void {
	if (!mainWindow && !hasAnyQuickChatWindows()) {
		Utils.quit();
	}
}

/**
 * Creates (or, if one already exists, focuses) this process's main window.
 * Called either directly at startup for a normal launch, or later from the
 * single-instance handoff handler when a normal launch elsewhere finds this
 * process already running and asks it to activate/promote instead of
 * starting a redundant second instance. Idempotent and re-entrancy-safe.
 */
async function ensureMainWindow(): Promise<void> {
	if (mainWindow) {
		try { mainWindow.activate(); } catch { /* ignore */ }
		return;
	}
	if (mainWindowCreationPromise) return mainWindowCreationPromise;

	mainWindowCreationPromise = (async () => {
		// Prevent System Sleep + Launch at Startup — both off by default, no
		// Electrobun equivalent exists, so each is a custom per-platform native
		// call (see src/bun/system/power-save-blocker.ts and
		// src/bun/system/login-item.ts). Applied here (not unconditionally at
		// startup) so a Quick-Chat-only launch never sleep-blocks or
		// self-heals the login-item registration — only a real main window
		// (present from the start, or via later promotion) does. Kept live
		// afterwards via the onSettingChange handlers below.
		const [preventSystemSleepSetting, launchAtStartupSetting] = await Promise.all([
			getSetting("prevent_system_sleep", "general"),
			getSetting("launch_at_startup", "general"),
		]);
		console.log(`[startup] prevent_system_sleep=${JSON.stringify(preventSystemSleepSetting)} launch_at_startup=${JSON.stringify(launchAtStartupSetting)}`);
		if ((preventSystemSleepSetting as unknown) === true) startSleepBlock();
		if ((launchAtStartupSetting as unknown) === true) await enableLaunchAtStartup().catch(() => {});

		const savedFrame = await loadWindowState();
		const url = await getMainViewUrl();
		// True only in the "dev" channel — controls DevTools access and context menu.
		const isDevMode = url.startsWith("http://localhost");

		const win = new BrowserWindow({
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
		mainWindow = win;

		// Assign the module-level ref so engine callbacks can send RPC messages
		setMainWindowRef(win);

		// Maximize once the webview DOM is ready so the layout fills the full window.
		// All background services (plugins, channels, scheduler, MCP) are also started
		// here so the window appears immediately without waiting for network/disk I/O.
		win.webview.on("dom-ready", () => {
			win.maximize();
			brandWindow("AgentDesk", appIconPath);
			// Right-click context menu stays enabled in every build (previously
			// disabled in production to remove Inspect Element access) — it's
			// WebView2's only built-in way to copy/paste/cut text, so disabling
			// it took that away from every production user for the sake of
			// hiding a devtools entry point.
			initCoreBackgroundServices().catch((err) => console.error("[startup] Core background services error:", err));
			initFullInstanceServices(isDevMode).catch((err) => console.error("[startup] Full-instance services error:", err));
			initSchedulingServices().catch((err) => console.error("[startup] Scheduling services error:", err));
		});

		// Block all external navigation — only bundled views and the Vite dev server
		// are allowed.  This prevents AI-generated content from redirecting the window
		// to arbitrary external URLs.
		win.webview.setNavigationRules([
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
			mainWindow = null;
			mainWindowCreationPromise = null;
			setMainWindowRef(null);
			maybeQuitWhenAllWindowsClosed();
		});
	})();

	return mainWindowCreationPromise;
}

// ---------------------------------------------------------------------------
// Global error handlers — install before anything else can throw
// ---------------------------------------------------------------------------
initGlobalErrorHandlers();

// Route Vercel AI SDK warnings to both the backend console and error.log
// (with a [WARNING] prefix). Installed before any AI inference so no warning
// slips through with the SDK's default logger.
installAiSdkWarningHandler();

// ---------------------------------------------------------------------------
// Database initialisation — run migrations then seed default data
// ---------------------------------------------------------------------------
runMigrations();
await seedDatabase();

// Global AI SDK v7 telemetry — registered once, here, so every streamText/
// generateText call across all 9+ independent surfaces reports automatically
// (v7 telemetry is "enabled by default" once any integration is registered).
// See docs/ai-sdk-7-migration.md §6.3/§9.1 and telemetry-sink.ts. Must come
// after runMigrations() — the sink writes to ai_telemetry_events.
registerTelemetry(telemetrySink);

await loadCustomEnvVarsIntoProcess();
await encryptExistingSecrets();

// ---------------------------------------------------------------------------
// Launch detection + single-instance handoff (Windows). DB is ready at this
// point, so a handoff arriving the instant the port is claimed can be handled
// immediately. See src/bun/single-instance.ts's doc comment: a Quick Chat
// launch that loses the claim race hands its request to the owning process
// and exits; a NORMAL launch that loses the race now also hands off (asking
// the owner to activate/promote its main window) and exits too, rather than
// becoming a redundant second full instance.
// ---------------------------------------------------------------------------
// TEMPORARY diagnostic — the Windows Explorer "Open in AgentDesk" entry
// invokes launcher.exe (not a directly-run bun script), and a live test found
// the intended `--quick-chat "<folder>"` args were NOT being detected (the
// main window opened instead of a Quick Chat window). This logs the exact
// argv the packaged launcher hands to this process so the actual failure mode
// (args missing entirely / present under a different form / launcher.exe
// swallowing them) can be diagnosed from a real run instead of guessed at.
// Remove once the launcher/argv path is confirmed working end-to-end.
console.log("[startup] process.argv:", JSON.stringify(process.argv));
console.log("[startup] process.argv0:", process.argv0);

const quickChatPath = parseQuickChatPathFromArgv();
const launchedForQuickChat = quickChatPath !== null;
console.log(`[startup] parseQuickChatPathFromArgv() -> ${JSON.stringify(quickChatPath)} (launchedForQuickChat=${launchedForQuickChat})`);

const isSingleInstanceClaimant = await acquireSingleInstanceLock((req) => {
	if (req.action === "open-quick-chat") {
		void handleQuickChatRequest(req);
	} else {
		// A later normal launch found us already running — activate our main
		// window, promoting this process to a full instance if it was
		// Quick-Chat-only until now.
		void ensureMainWindow();
	}
});

if (!isSingleInstanceClaimant) {
	// AgentDesk is already running — hand off to it and exit without finishing
	// this process's own boot (no window, no background services).
	const handoffReq: HandoffRequest = quickChatPath
		? { action: "open-quick-chat", workspacePath: quickChatPath }
		: { action: "activate-main-window" };
	const delivered = await sendHandoffToPrimary(handoffReq);
	if (delivered) {
		process.exit(0);
	}
	// Delivery failed — rare race where the owning instance quit between the
	// failed lock attempt and this call. Fall through and boot this launch
	// normally as its own instance.
}

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
// The INITIAL apply lives in ensureMainWindow() (only a real main window
// should sleep-block or self-heal the login-item registration — never a
// Quick-Chat-only launch); these handlers keep both live afterwards, but only
// once this process actually has a main window (mainWindow !== null) — while
// Quick-Chat-only, toggling either setting is correctly a no-op here (the
// saved value still takes effect normally on the next real launch, or
// immediately if this process is later promoted via ensureMainWindow, which
// re-reads and re-applies both).
onSettingChange("prevent_system_sleep", (value) => {
	if (!mainWindow) return;
	console.log(`[settings] prevent_system_sleep changed to ${JSON.stringify(value)}`);
	if (value === true) startSleepBlock();
	else stopSleepBlock();
});

onSettingChange("launch_at_startup", (value) => {
	if (!mainWindow) return;
	if (value === true) enableLaunchAtStartup().catch(() => {});
	else disableLaunchAtStartup().catch(() => {});
});

// Quick Chat OS Explorer/Finder entry — ON by default (unlike the two toggles
// above), so a never-saved setting (existing users on their first launch
// after upgrading to this version) registers automatically rather than
// opting in. Re-applied on every boot (self-heals a moved/updated install)
// and kept live via onSettingChange below. See quick-chat/os-integration.ts.
{
	const allowQuickChatSetting = await getSetting("allow_quick_chat", "general");
	const allowQuickChat = (allowQuickChatSetting as unknown) !== false && (allowQuickChatSetting as unknown) !== "false";
	console.log(`[startup] allow_quick_chat=${JSON.stringify(allowQuickChatSetting)} (resolved: ${allowQuickChat})`);
	if (allowQuickChat) registerQuickChatMenu().catch(() => {});
	else unregisterQuickChatMenu().catch(() => {});
}

onSettingChange("allow_quick_chat", (value) => {
	if (value === false || value === "false") unregisterQuickChatMenu().catch(() => {});
	else registerQuickChatMenu().catch(() => {});
});

// Periodic WAL checkpoint timer — cheap to schedule. The one-shot incremental optimize
// already ran above (pre-window); the rare full VACUUM, workspace sync, and one-off
// cleanups are deferred to the background block (post dom-ready) so they never block
// the window from appearing.
startWalCheckpointTimer();

// Initialise truncation directory for tool output overflow + cleanup old files
initTruncationDir(Utils.paths.userData);
cleanupTruncationFiles().catch(() => {});

// Cron scheduler and automation engine registration — actual init
// (initSchedulingServices, defined above) happens inside ensureMainWindow's
// dom-ready, skipped entirely for a Quick-Chat-only launch.
setTaskExecutorEngine(getOrCreateEngine);

// Remote Sync — mark any sync runs interrupted by a crash/restart as failed so
// they don't appear permanently "running" in the Activity history.
void failInterruptedRemoteSyncRuns().catch((e) => console.error("[remote-sync] failInterruptedRuns:", e));

// Re-sync workspace folders whenever the global workspace path changes
onSettingChange("global_workspace_path", () => {
	syncWorkspaceFolders().catch(() => {});
});


// Deferred startup jobs — scheduled AFTER a window is created so they never block it
// from appearing (moved off the synchronous critical path): workspace folder sync,
// stuck-deploy reconcile, and orphaned-settings cleanup run on the next tick; the rare
// 7-day full VACUUM (which holds a DB lock) is pushed out ~20s so it never competes with
// the initial UI/agent load — it shows the maintenance overlay for its duration. None of
// this depends on which window exists, so it runs the same for both branches below.
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

if (launchedForQuickChat) {
	// -------------------------------------------------------------------
	// Quick-Chat-only boot — no main window at all, and none of the
	// full-instance-only services (channels, Playground server, remote,
	// freelance, cron/automation/issue-fixer). Opens straight to the Quick
	// Chat window for the requested folder; only the "core" services
	// (plugins/LSP, skills, MCP, annotation server) are deferred behind
	// that window's own dom-ready — see initCoreBackgroundServices above.
	// If this process later receives an "activate-main-window" handoff (a
	// normal launch while this one is running), ensureMainWindow() PROMOTES
	// it to a full instance and starts everything skipped here.
	// -------------------------------------------------------------------
	setOnFirstQuickChatDomReady(() => {
		initCoreBackgroundServices().catch((err) => console.error("[startup] Core background services error:", err));
	});

	await handleQuickChatRequest({ action: "open-quick-chat", workspacePath: quickChatPath as string });
} else {
	await ensureMainWindow();
}

// Registered unconditionally (not just for a Quick-Chat-only launch): a
// normal launch can have Quick Chat windows opened into it later, and a
// Quick-Chat-only launch can later be promoted to a full instance — either
// way, the process should quit only once BOTH the main window and every
// Quick Chat window are closed. See maybeQuitWhenAllWindowsClosed's own
// comment for the bug this fixes.
setOnAllQuickChatWindowsClosed(maybeQuitWhenAllWindowsClosed);

// Cleanup on quit — fires for Utils.quit(), Cmd+Q, Ctrl+C, etc.
Electrobun.events.on("before-quit", () => {
	(async () => {
		if (mainWindow) {
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
		}
		shutdownSingleInstanceServer();

		stopSleepBlock();
		stopCollectionsTrashPurgeTimer();
		await shutdownChannelManager();
		shutdownCronScheduler();
		shutdownAutomationEngine();
		stopIssueFixerPolling();
		await shutdownMcpClients();
		shutdownPreviewWindow();
		shutdownQuickChatWindows();
		shutdownAnnotationServer();
		shutdownPlayground();
		shutdownPlaygroundServer();
		shutdownRemoteRpcServer();
		shutdownRemoteAccess();
		closeDatabase();
	})();
});

ApplicationMenu.setApplicationMenu([]);

// macOS Quick Chat deep link (see electrobun.config.ts's urlSchemes and
// quick-chat/os-integration.ts's Finder Quick Action bundle, which invokes
// `open agentdesk://quick-chat?path=<folder>`). macOS Launch Services
// delivers this to the already-running instance automatically (or launches
// one) — no single-instance coordination needed here, unlike Windows.
Electrobun.events.on("open-url", (e: unknown) => {
	try {
		const { url: rawUrl } = (e as { data: { url: string } }).data;
		const url = new URL(rawUrl);
		const isQuickChat = url.hostname === "quick-chat" || url.pathname.replace(/^\/+/, "") === "quick-chat";
		if (!isQuickChat) return;
		const path = url.searchParams.get("path");
		if (!path) return;
		void handleQuickChatRequest({ action: "open-quick-chat", workspacePath: path });
	} catch (err) {
		console.error("[quick-chat] Failed to handle open-url:", err);
	}
});

console.log("AgentDesk started!");
