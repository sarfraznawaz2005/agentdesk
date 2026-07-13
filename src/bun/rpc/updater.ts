import { join, dirname } from "path";
import { mkdirSync, rmSync, existsSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { Updater } from "electrobun/bun";
import { broadcastToWebview } from "../engine-manager";
import { isPortableBuild } from "../lib/install-mode";
import { portableDownloadUpdate, portableApplyUpdate } from "./updater-portable";

function relayStatus() {
	Updater.onStatusChange((entry) => {
		const progress = entry.details?.progress;
		broadcastToWebview("updateStatus", {
			status: entry.status,
			message: entry.message,
			...(progress !== undefined && { progress }),
		});
	});
}

const CHECK_TIMEOUT_MS = 15_000;

export async function checkForUpdate() {
	try {
		relayStatus();
		const result = await Promise.race([
			Updater.checkForUpdate(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS),
			),
		]);
		return { ...result, devMode: false };
	} catch (e) {
		if (e instanceof Error && e.message === "timeout") {
			return {
				version: "",
				hash: "",
				updateAvailable: false,
				updateReady: false,
				error: "Update check timed out — check your connection",
				devMode: false,
			};
		}
		// version.json not present — running in dev mode
		return {
			version: "",
			hash: "",
			updateAvailable: false,
			updateReady: false,
			error: "",
			devMode: true,
		};
	}
}

export async function downloadUpdate() {
	if (process.platform === "win32") {
		// Portable builds use their own full-zip update path (no installer, no bspatch).
		return isPortableBuild() ? portableDownloadUpdate() : windowsDownloadSetup();
	}
	try {
		relayStatus();
		await Updater.downloadUpdate();
		return { success: true };
	} catch (e) {
		return { success: false, error: (e as Error).message };
	}
}

export async function applyUpdate() {
	try {
		if (process.platform === "win32") {
			const result = isPortableBuild() ? await portableApplyUpdate() : await windowsApplySetup();
			if (!result.success) return result;
			setTimeout(() => process.exit(0), 400);
			return { success: true };
		}
		await Updater.applyUpdate();
		return { success: true };
	} catch (e) {
		return { success: false, error: (e as Error).message };
	}
}

// ---------------------------------------------------------------------------
// Windows installer-based update
// No .ps1 script file  → ExecutionPolicy never checked
// No wscript.exe       → not needed
// No system tar        → Expand-Archive is built into PS 5+ (ships with all Win 10/11)
// No hardcoded paths   → NSIS installer manages its own install location
// ---------------------------------------------------------------------------

const WIN_UPDATE_DIR  = join(tmpdir(), "agentdesk-update");
const WIN_SETUP_ZIP   = join(WIN_UPDATE_DIR, "AgentDesk-Setup.zip");
const WIN_EXTRACT_DIR = join(WIN_UPDATE_DIR, "extracted");
const WIN_SETUP_EXE   = join(WIN_EXTRACT_DIR, "AgentDesk-Setup.exe");
const WIN_APPLY_LOG   = join(WIN_UPDATE_DIR, "apply.log");

function applyLog(msg: string): void {
	try {
		appendFileSync(WIN_APPLY_LOG, `${new Date().toISOString()} ${msg}\n`);
	} catch { /* never block on logging */ }
}

async function windowsDownloadSetup(): Promise<{ success: boolean; error?: string }> {
	try {
		const { baseUrl, name } = await Updater.getLocalInfo();

		const arch   = process.arch === "arm64" ? "arm64" : "x64";
		const zipUrl = `${baseUrl}/${name}-win-${arch}-Setup.zip`;

		// Clean up any previous partial download before starting fresh
		rmSync(WIN_UPDATE_DIR, { recursive: true, force: true });
		mkdirSync(WIN_UPDATE_DIR, { recursive: true });

		broadcastToWebview("updateStatus", {
			status: "downloading-full-bundle",
			message: "Downloading update…",
		});

		const response = await fetch(zipUrl);
		if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

		const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
		if (!response.body) throw new Error("Response body is null");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let downloaded = 0;

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			downloaded += value.length;
			if (contentLength > 0) {
				const progress = Math.round((downloaded / contentLength) * 100);
				broadcastToWebview("updateStatus", {
					status: "download-progress",
					message: `Downloading… ${progress}%`,
					progress,
				});
			}
		}

		// Assemble chunks into a single buffer and write to disk
		const buffer = new Uint8Array(downloaded);
		let pos = 0;
		for (const chunk of chunks) { buffer.set(chunk, pos); pos += chunk.length; }
		await Bun.write(WIN_SETUP_ZIP, buffer);

		broadcastToWebview("updateStatus", {
			status: "download-complete",
			message: "Update ready — restart to install",
		});

		return { success: true };
	} catch (e) {
		const message = (e as Error).message;
		broadcastToWebview("updateStatus", { status: "error", message });
		return { success: false, error: message };
	}
}

async function windowsApplySetup(): Promise<{ success: boolean; error?: string }> {
	try {
		applyLog("Apply started");

		if (!existsSync(WIN_SETUP_ZIP)) {
			const msg = "Update file not found — please download again";
			applyLog(`ERROR: zip not found at ${WIN_SETUP_ZIP}`);
			broadcastToWebview("updateStatus", { status: "error", message: msg });
			return { success: false, error: msg };
		}
		applyLog(`Zip found: ${WIN_SETUP_ZIP}`);

		const esc = (s: string) => s.replace(/'/g, "''");

		// Extract synchronously while the app is still running.
		// spawnSync blocks until done — no detachment needed for this step,
		// and we get a real exit code to detect failures.
		const extractResult = Bun.spawnSync(
			[
				"powershell.exe", "-WindowStyle", "Hidden", "-Command",
				`Expand-Archive -Path '${esc(WIN_SETUP_ZIP)}' -DestinationPath '${esc(WIN_EXTRACT_DIR)}' -Force`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);

		const stderr = extractResult.stderr?.toString().trim() ?? "";
		applyLog(`Expand-Archive exit=${extractResult.exitCode}${stderr ? ` stderr=${stderr}` : ""}`);

		if (extractResult.exitCode !== 0) {
			const msg = `Failed to extract update (exit ${extractResult.exitCode})${stderr ? `: ${stderr}` : ""}`;
			broadcastToWebview("updateStatus", { status: "error", message: msg });
			return { success: false, error: msg };
		}

		if (!existsSync(WIN_SETUP_EXE)) {
			const msg = "Installer not found in update package";
			applyLog(`ERROR: ${msg} — expected ${WIN_SETUP_EXE}`);
			broadcastToWebview("updateStatus", { status: "error", message: msg });
			return { success: false, error: msg };
		}

		// Preserve freelance feature flag — NSIS installer wipes bin/ during install.
		// If the flag file existed before the update, recreate it afterwards.
		const freelanceFlagPath = join(dirname(process.execPath), "freelance");
		const hadFreelanceFlag = existsSync(freelanceFlagPath);
		applyLog(`Freelance flag present: ${hadFreelanceFlag}`);

		// Preserve claude-subscription feature flag the same way.
		const claudeFlagPath = join(dirname(process.execPath), "claude");
		const hadClaudeFlag = existsSync(claudeFlagPath);
		applyLog(`Claude subscription flag present: ${hadClaudeFlag}`);

		// Derive the launcher path for relaunch once the installer finishes.
		// Updater.appDataFolder() returns e.g. %LOCALAPPDATA%\com.sarfrazai.agentdesk\stable
		const appDataFolder = await Updater.appDataFolder();
		const launcherPath = join(appDataFolder, "app", "bin", "launcher.exe");
		applyLog(`Launcher path: ${launcherPath}`);

		// Electrobun unconditionally bundles bspatch.exe + zig-zstd.exe, but AgentDesk's
		// Windows updater never uses the native delta/decompress path (we do full-zip swaps
		// via Expand-Archive + the system installer). The NSIS installer re-extracts the
		// bundle on every update, so delete the unused binaries afterwards to purge them from
		// existing installs (bspatch also trips some AV engines). Fresh installs lose them on
		// their first update. Windows-only: mac/Linux still need zig-zstd for their updater.
		const unusedUpdaterBins = [
			join(appDataFolder, "app", "bin", "bspatch.exe"),
			join(appDataFolder, "app", "bin", "zig-zstd.exe"),
		];
		const removeUnusedBinsPs = unusedUpdaterBins
			.map((p) => `Remove-Item -Force '${esc(p)}' -ErrorAction SilentlyContinue; `)
			.join("");

		// Inline PowerShell command — no .ps1 file → ExecutionPolicy never checked.
		//  1. Run the NSIS installer silently and WAIT for it to finish (-Wait).
		//  2. If the freelance flag existed, recreate it at the same path.
		//  3. Re-launch the updated app via the new launcher.exe.
		// Launched via "cmd /c start" → creates a top-level process that escapes
		// Windows Job Objects and survives our process.exit().
		const psLog = (msg: string) =>
			`Add-Content -Path '${esc(WIN_APPLY_LOG)}' -Value "$(Get-Date -Format 'HH:mm:ss') ${msg}"; `;

		const psCommand =
			`$host.UI.RawUI.WindowTitle = 'AgentDesk Update'; ` +
			`Write-Host ''; ` +
			`Write-Host '  AgentDesk Update' -ForegroundColor Cyan; ` +
			`Write-Host '  ──────────────────────────────────────' -ForegroundColor DarkGray; ` +
			`Write-Host ''; ` +
			psLog("Installer starting") +
			`Write-Host '  [1/2]  Installing update, please wait...' -ForegroundColor Yellow; ` +
			`Start-Process -FilePath '${esc(WIN_SETUP_EXE)}' -ArgumentList '/S' -WindowStyle Hidden -Wait; ` +
			psLog("Installer finished") +
				removeUnusedBinsPs +
				psLog("Removed unused updater binaries (bspatch.exe, zig-zstd.exe)") +
			`Write-Host '         Done.' -ForegroundColor Green; ` +
			`Write-Host ''; ` +
			(hadFreelanceFlag
				? `New-Item -ItemType File -Path '${esc(freelanceFlagPath)}' -Force | Out-Null; ${psLog("Restored freelance feature flag")}`
				: "") +
			(hadClaudeFlag
				? `New-Item -ItemType File -Path '${esc(claudeFlagPath)}' -Force | Out-Null; ${psLog("Restored claude subscription feature flag")}`
				: "") +
			`Write-Host '  [2/2]  Launching AgentDesk...' -ForegroundColor Yellow; ` +
			`if (Test-Path '${esc(launcherPath)}') { ` +
				psLog("Launcher found, relaunching app") +
				`Start-Process -FilePath '${esc(launcherPath)}'; ` +
				`Write-Host '         Done.' -ForegroundColor Green; ` +
			`} else { ` +
				psLog("ERROR: launcher not found") +
				`Write-Host '         ERROR: Launcher not found. Please restart AgentDesk manually.' -ForegroundColor Red; ` +
				`Start-Sleep -Seconds 8; ` +
			`}` +
			`Write-Host ''; ` +
			`Write-Host '  Update complete. This window will close shortly.' -ForegroundColor DarkGray; ` +
			`Start-Sleep -Seconds 3`;

		applyLog("Launching install + relaunch wrapper");

		Bun.spawnSync(
			["cmd.exe", "/c", "start", "", "powershell.exe", "-WindowStyle", "Normal", "-Command", psCommand],
			{ stdout: "ignore", stderr: "ignore" },
		);

		applyLog("Wrapper launched, app will now exit");
		return { success: true };
	} catch (e) {
		const msg = (e as Error).message;
		applyLog(`EXCEPTION: ${msg}`);
		return { success: false, error: msg };
	}
}
