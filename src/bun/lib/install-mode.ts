import { resolve, sep } from "path";
import { Utils } from "electrobun/bun";

/**
 * Detects how the running Windows build was deployed.
 *
 * Both the Setup installer and the portable zip are built from the SAME app
 * bundle (tar.zst) — Electrobun writes no registry keys, shortcuts, uninstaller,
 * or marker file, so the ONLY intrinsic difference is the install LOCATION:
 *
 *   • Setup.exe extracts to  %LOCALAPPDATA%\<identifier>\<channel>\app\  (== Utils.paths.userData + "\app")
 *   • Portable zip is extracted by the user to an arbitrary folder.
 *
 * We therefore classify by whether the running executable lives under that
 * canonical install root.
 */

/** True when the app is running from the Setup install location (or on macOS/Linux). */
export function isInstalledBuild(): boolean {
	// macOS/Linux have a single distribution form; treat them as "installed" so the
	// existing (Electrobun/Setup) update path is used.
	if (process.platform !== "win32") return true;
	try {
		const installRoot = resolve(Utils.paths.userData, "app");
		const runningExe = resolve(process.execPath);
		return (runningExe.toLowerCase() + sep).startsWith(installRoot.toLowerCase() + sep);
	} catch {
		// If we can't determine it, fall back to the existing behaviour.
		return true;
	}
}

/** True only for a Windows portable (non-installed) build. */
export function isPortableBuild(): boolean {
	return process.platform === "win32" && !isInstalledBuild();
}
