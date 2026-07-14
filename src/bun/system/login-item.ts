import { existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Registers/unregisters AgentDesk as a native OS login item ("launch at
// startup"). Electrobun has no setLoginItemSettings equivalent, so each
// platform gets its own mechanism:
//   - win32:  HKCU\...\CurrentVersion\Run value, via spawned `reg add`/`reg delete`
//   - darwin: macOS Login Items, via spawned `osascript` (System Events)
//   - linux:  ~/.config/autostart/<id>.desktop file (freedesktop autostart spec)
// Re-applied on every boot so a moved/updated install self-heals; every branch
// is best-effort — failures are logged, never thrown.
// ---------------------------------------------------------------------------

const APP_NAME = "AgentDesk";

// process.argv0 is the currently-running bun binary (e.g. <app>/bin/bun.exe),
// which our JS code runs as — but the app's actual front door is the native
// `launcher` binary Electrobun spawns it from (bin/launcher.exe on Windows,
// bin/launcher elsewhere; confirmed a sibling of bun.exe in the same bin/
// folder, same relationship src/bun/index.ts already relies on for locating
// Resources/ relative to the running binary). Autostart must launch through
// that binary, not bun directly, to match what a normal double-click/Start
// Menu launch does. Falls back to argv0 if no sibling launcher is found
// (shouldn't happen in a real build, but never block on this).
// Exported so quick-chat/os-integration.ts's Explorer context-menu "command"
// value points at the same native front door, not the bun runtime directly.
export function getLauncherPath(): string {
	const launcherName = process.platform === "win32" ? "launcher.exe" : "launcher";
	const candidate = join(dirname(process.argv0), launcherName);
	return existsSync(candidate) ? candidate : process.argv0;
}

// macOS Login Items expect the .app bundle path, not the inner launcher binary.
function getMacAppBundlePath(execPath: string): string {
	const idx = execPath.indexOf(".app");
	return idx === -1 ? execPath : execPath.slice(0, idx + 4);
}

function getAutostartDesktopFilePath(): string {
	return join(homedir(), ".config", "autostart", "agentdesk.desktop");
}

export async function enableLaunchAtStartup(): Promise<void> {
	try {
		const launcherPath = getLauncherPath();

		if (process.platform === "win32") {
			const proc = Bun.spawn(
				["reg", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", APP_NAME, "/t", "REG_SZ", "/d", `"${launcherPath}"`, "/f"],
				{ stdout: "ignore", stderr: "ignore" },
			);
			await proc.exited;
		} else if (process.platform === "darwin") {
			const appPath = getMacAppBundlePath(launcherPath);
			const proc = Bun.spawn(
				["osascript", "-e", `tell application "System Events" to make login item at end with properties {path:"${appPath}", hidden:false, name:"${APP_NAME}"}`],
				{ stdout: "ignore", stderr: "ignore" },
			);
			await proc.exited;
		} else if (process.platform === "linux") {
			const desktopFile = getAutostartDesktopFilePath();
			const contents = [
				"[Desktop Entry]",
				"Type=Application",
				`Name=${APP_NAME}`,
				`Exec="${launcherPath}"`,
				"X-GNOME-Autostart-enabled=true",
				"NoDisplay=false",
				"",
			].join("\n");
			await Bun.write(desktopFile, contents);
		}
	} catch (err) {
		console.error("[login-item] Failed to enable launch at startup:", err);
	}
}

export async function disableLaunchAtStartup(): Promise<void> {
	try {
		if (process.platform === "win32") {
			const proc = Bun.spawn(
				["reg", "delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", APP_NAME, "/f"],
				{ stdout: "ignore", stderr: "ignore" },
			);
			await proc.exited;
		} else if (process.platform === "darwin") {
			const proc = Bun.spawn(
				["osascript", "-e", `tell application "System Events" to delete login item "${APP_NAME}"`],
				{ stdout: "ignore", stderr: "ignore" },
			);
			await proc.exited;
		} else if (process.platform === "linux") {
			const desktopFile = getAutostartDesktopFilePath();
			if (existsSync(desktopFile)) {
				rmSync(desktopFile, { force: true });
			}
		}
	} catch (err) {
		console.error("[login-item] Failed to disable launch at startup:", err);
	}
}
