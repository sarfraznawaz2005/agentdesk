// ---------------------------------------------------------------------------
// Registers/unregisters the OS Explorer/Finder "Open in AgentDesk" entry for
// Quick Chat — folders and folder-background right-clicks only, never
// individual files or the Desktop background (see docs/quick-chat-plan.md).
// Driven by the "Allow Quick Chat" setting (ON by default) via
// registerQuickChatMenu()/unregisterQuickChatMenu(), the single entry points
// index.ts calls; each dispatches per-platform internally, same convention as
// system/login-item.ts.
//
// Every channel (dev/canary/stable) registers — NOT just stable, unlike
// registerWindowsUninstaller — but non-stable channels get a channel-prefixed
// label ("Dev - Open in AgentDesk") and a channel-suffixed registry key/
// bundle name so a dev/canary install's entry never collides with, or gets
// mistaken for, a real stable install's.
// ---------------------------------------------------------------------------

import { join } from "path";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { homedir } from "os";
import { Utils } from "electrobun/bun";
import { getLauncherPath } from "../system/login-item";
import { appIconPath } from "../lib/app-icon";
import { quickChatHandoffFilePath } from "./launch-args";

async function getChannel(): Promise<string> {
	try {
		const versionJson = await Bun.file("../Resources/version.json").json() as { channel?: string };
		return versionJson.channel || "stable";
	} catch {
		// Unpackaged/local run (no Resources/version.json) — matches how
		// index.ts's own Updater.localInfo.channel() resolves to "dev" here.
		return "dev";
	}
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function menuLabel(channel: string): string {
	return channel === "stable" ? "Open in AgentDesk" : `${capitalize(channel)} - Open in AgentDesk`;
}

// ---------------------------------------------------------------------------
// Windows — HKCU registry, via spawned hidden PowerShell (mirrors
// windows-registry.ts's cache-file fast path so normal launches never spawn
// a subprocess once already registered).
// ---------------------------------------------------------------------------

function winRegKeyName(channel: string): string {
	return channel === "stable" ? "AgentDeskQuickChat" : `AgentDeskQuickChat${capitalize(channel)}`;
}

// v2: switched the registered command from a direct `--quick-chat "%V"` CLI
// arg (proven via a live test to never reach the app — launcher.exe doesn't
// forward its own argv) to a PowerShell launcher script that writes a
// handoff file instead.
// v3: wrapped that same PowerShell invocation in `conhost.exe --headless`
// (see commandValue below) — confirmed via live user report that
// `powershell.exe -WindowStyle Hidden` alone still briefly flashes a console
// window on launch (a well-known PowerShell/conhost quirk: the window is
// actually created before PowerShell's own startup applies the hidden
// style; --headless never allocates a console surface in the first place,
// so there's nothing to flash). The main app's own launch never goes
// through PowerShell at all, which is why only the Quick Chat context-menu
// path ever showed it.
// Each version bump forces every existing registration (including any
// created under an older command) to be rewritten once, rather than being
// skipped by the cache-file fast path below because the launcher path alone
// hadn't changed.
function winCacheFilePath(channel: string): string {
	return join(Utils.paths.userData, `.quick-chat-menu-win-v3-${channel}`);
}

/**
 * Small PowerShell launcher script the registry command invokes (via
 * `-File`, not an inline `-Command` string) so the target folder path never
 * has to survive being embedded inside a nested, hand-quoted command line —
 * it arrives as a real PowerShell script parameter instead, which PowerShell
 * itself parses correctly regardless of spaces/special characters. Writes
 * the folder to the handoff file launch-args.ts reads at startup (see that
 * file's doc comment for why this replaced a direct --quick-chat CLI arg:
 * launcher.exe does not forward its own argv to the app it spawns), then
 * starts the app. Also passes --quick-chat as a CLI arg anyway, in case a
 * future Electrobun version does forward it — costs nothing either way.
 */
function winLauncherScriptPath(channel: string): string {
	return join(Utils.paths.userData, `quick-chat-launch-${channel}.ps1`);
}

function winLauncherScriptContent(launcherPath: string): string {
	const handoffFile = quickChatHandoffFilePath();
	// -ArgumentList takes an array — PowerShell/Start-Process quotes each
	// element correctly when building the actual OS command line, so
	// $TargetPath is passed as-is here (no manual quote-wrapping needed, and
	// wrapping it would instead make the launched process see literal quote
	// characters as part of the path string).
	return `param([string]$TargetPath)
Set-Content -LiteralPath '${handoffFile}' -Value $TargetPath -Encoding UTF8 -NoNewline
Start-Process -FilePath '${launcherPath}' -ArgumentList '--quick-chat', $TargetPath
`;
}

async function registerWindowsQuickChatMenu(): Promise<void> {
	try {
		const channel = await getChannel();
		const launcherPath = getLauncherPath();
		const keyName = winRegKeyName(channel);
		const label = menuLabel(channel);

		const cacheFile = winCacheFilePath(channel);
		if (existsSync(cacheFile)) {
			const cached = await Bun.file(cacheFile).text();
			if (cached.trim() === launcherPath) return;
		}

		const scriptPath = winLauncherScriptPath(channel);
		await Bun.write(scriptPath, winLauncherScriptContent(launcherPath));

		// conhost.exe --headless (Windows 10 1809+/11) runs the console host
		// with no window surface at all, rather than creating one and hiding
		// it — see winCacheFilePath's v3 comment for why plain
		// `powershell.exe -WindowStyle Hidden` isn't enough on its own.
		// -WindowStyle Hidden is kept too, as a harmless no-op fallback if
		// --headless were ever unavailable (conhost.exe itself is a core,
		// always-present Windows binary, so this never fails outright — worst
		// case is degrading back to the old occasional-flash behavior, not
		// a broken launch).
		const commandValue = `conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}" "%V"`;
		const cacheFileFwd = cacheFile.replace(/\\/g, "/");
		const iconFwd = appIconPath.replace(/\\/g, "\\\\");

		// Folders (Directory\shell) and folder-background (Directory\Background\shell)
		// only — no entry under `*` (individual files) or DesktopBackground.
		const psScript = `
$dirKey = 'HKCU:\\Software\\Classes\\Directory\\shell\\${keyName}'
New-Item -Path $dirKey -Force | Out-Null
New-ItemProperty -Path $dirKey -Name '(default)' -Value '${label}' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $dirKey -Name 'Icon' -Value '${iconFwd}' -PropertyType String -Force | Out-Null
New-Item -Path "$dirKey\\command" -Force | Out-Null
New-ItemProperty -Path "$dirKey\\command" -Name '(default)' -Value '${commandValue}' -PropertyType String -Force | Out-Null

$bgKey = 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\${keyName}'
New-Item -Path $bgKey -Force | Out-Null
New-ItemProperty -Path $bgKey -Name '(default)' -Value '${label}' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $bgKey -Name 'Icon' -Value '${iconFwd}' -PropertyType String -Force | Out-Null
New-Item -Path "$bgKey\\command" -Force | Out-Null
New-ItemProperty -Path "$bgKey\\command" -Name '(default)' -Value '${commandValue}' -PropertyType String -Force | Out-Null

Set-Content -Path '${cacheFileFwd}' -Value '${launcherPath.replace(/\\/g, "\\\\")}' -NoNewline
`;

		// Fire-and-forget — don't block startup. PowerShell writes the cache
		// file only on success, so a failed write is retried next launch.
		Bun.spawn([
			"powershell.exe",
			"-ExecutionPolicy", "Bypass",
			"-WindowStyle", "Hidden",
			"-Command", psScript,
		], { stdout: "ignore", stderr: "ignore" });
	} catch (err) {
		console.error("[quick-chat/os-integration] Failed to register Windows context menu:", err);
	}
}

async function unregisterWindowsQuickChatMenu(): Promise<void> {
	try {
		const channel = await getChannel();
		const keyName = winRegKeyName(channel);
		const cacheFile = winCacheFilePath(channel);
		const scriptPath = winLauncherScriptPath(channel);

		const psScript = `
Remove-Item -Path 'HKCU:\\Software\\Classes\\Directory\\shell\\${keyName}' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\${keyName}' -Recurse -Force -ErrorAction SilentlyContinue
`;
		const proc = Bun.spawn([
			"powershell.exe",
			"-ExecutionPolicy", "Bypass",
			"-WindowStyle", "Hidden",
			"-Command", psScript,
		], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;

		if (existsSync(cacheFile)) {
			try { unlinkSync(cacheFile); } catch { /* non-critical */ }
		}
		if (existsSync(scriptPath)) {
			try { unlinkSync(scriptPath); } catch { /* non-critical */ }
		}
	} catch (err) {
		console.error("[quick-chat/os-integration] Failed to unregister Windows context menu:", err);
	}
}

// ---------------------------------------------------------------------------
// macOS — a Finder Quick Action (Automator .workflow bundle) in
// ~/Library/Services. Deliberately NOT an NSServices Info.plist entry: that
// mechanism requires the receiving app to register a native
// NSApplication.servicesProvider and implement the corresponding selector at
// launch, which Electrobun's documented capabilities (Tray/ContextMenu/
// ApplicationMenu/urlSchemes+open-url — see the electrobun skill) give no
// indication of exposing. An Automator-run Quick Action sidesteps that
// entirely: Automator's own runtime executes the workflow's actions (here, a
// single "Run Shell Script" step that calls `open "agentdesk://..."`), which
// only depends on Electrobun's already-documented open-url deep-linking — no
// native provider registration needed on AgentDesk's side.
//
// LOWEST-CONFIDENCE PIECE OF THIS FEATURE: the .wflow document format below
// follows Automator's well-known "Run Shell Script" action structure (the
// same shape used by numerous published "generate an Automator Quick Action
// programmatically" scripts), but was hand-authored without ever running
// Automator.app to produce a reference file, and cannot be tested on this
// (Windows) machine. If Finder doesn't offer the entry, or invoking it does
// nothing, inspecting/regenerating this file from a real Automator.app
// export is the fastest fix — the registration/unregistration logic around
// it (paths, enable toggle, install/remove) is unaffected either way.
// ---------------------------------------------------------------------------

function macServicesDir(): string {
	return join(homedir(), "Library", "Services");
}

function macWorkflowName(channel: string): string {
	const base = channel === "stable" ? "AgentDesk Quick Chat" : `AgentDesk Quick Chat (${capitalize(channel)})`;
	return `${base}.workflow`;
}

function macWorkflowPath(channel: string): string {
	return join(macServicesDir(), macWorkflowName(channel));
}

function macInfoPlist(label: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>${label}</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.folder</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
`;
}

// Single "Run Shell Script" action invoking the app's registered URL scheme
// with the selected folder's POSIX path — the same open-url deep-link path
// index.ts's Electrobun open-url handler already receives normal launches
// through (see docs/quick-chat-plan.md Subsystem 6).
function macDocumentWflow(urlScheme: string): string {
	const script = `for f in "$@"; do\n\topen "${urlScheme}://quick-chat?path=$f"\ndone`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>512</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>${script.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</string>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/bash</string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
			</dict>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject.folder</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<integer>0</integer>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
`;
}

async function registerMacQuickChatMenu(): Promise<void> {
	try {
		const channel = await getChannel();
		const bundlePath = macWorkflowPath(channel);
		const contentsDir = join(bundlePath, "Contents");
		mkdirSync(contentsDir, { recursive: true });

		await Bun.write(join(contentsDir, "Info.plist"), macInfoPlist(menuLabel(channel)));
		await Bun.write(join(contentsDir, "document.wflow"), macDocumentWflow("agentdesk"));

		// Nudge Launch Services / Finder to notice the new Service without
		// requiring a logout — best-effort, non-fatal if unavailable.
		try {
			Bun.spawn(["/System/Library/CoreServices/pbs", "-flush"], { stdout: "ignore", stderr: "ignore" });
		} catch { /* non-critical */ }
	} catch (err) {
		console.error("[quick-chat/os-integration] Failed to register macOS Quick Action:", err);
	}
}

async function unregisterMacQuickChatMenu(): Promise<void> {
	try {
		const channel = await getChannel();
		const bundlePath = macWorkflowPath(channel);
		if (existsSync(bundlePath)) {
			rmSync(bundlePath, { recursive: true, force: true });
		}
		try {
			Bun.spawn(["/System/Library/CoreServices/pbs", "-flush"], { stdout: "ignore", stderr: "ignore" });
		} catch { /* non-critical */ }
	} catch (err) {
		console.error("[quick-chat/os-integration] Failed to unregister macOS Quick Action:", err);
	}
}

// ---------------------------------------------------------------------------
// Public entry points — index.ts / the "Allow Quick Chat" setting handler
// call only these; platform dispatch happens internally, no-op on Linux
// (deferred — see docs/quick-chat-plan.md).
// ---------------------------------------------------------------------------

export async function registerQuickChatMenu(): Promise<void> {
	if (process.platform === "win32") await registerWindowsQuickChatMenu();
	else if (process.platform === "darwin") await registerMacQuickChatMenu();
}

export async function unregisterQuickChatMenu(): Promise<void> {
	if (process.platform === "win32") await unregisterWindowsQuickChatMenu();
	else if (process.platform === "darwin") await unregisterMacQuickChatMenu();
}
