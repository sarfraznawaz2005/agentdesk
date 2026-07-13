/**
 * Portable (Windows) update system — fully separate from the Setup-installer
 * update path in updater.ts.
 *
 * Strategy: download the FULL portable zip for the latest release, extract it,
 * and have a standalone PowerShell script swap the new app bundle over the
 * running portable folder (after the app exits), then relaunch.
 *
 * Deliberately patch-free: it uses Expand-Archive + robocopy only, so
 * `bspatch.exe` is never invoked (some AV engines flag it). The Setup path is
 * untouched; this file owns everything portable.
 */
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { existsSync, readdirSync, rmSync, mkdirSync, appendFileSync, writeFileSync } from "fs";
import { Updater } from "electrobun/bun";
import { broadcastToWebview } from "../engine-manager";

// Dedicated temp workspace — never shares paths with the Setup updater.
const DIR         = join(tmpdir(), "agentdesk-portable-update");
const ZIP         = join(DIR, "AgentDesk-portable.zip");
const EXTRACT_DIR = join(DIR, "extracted");
const SCRIPT      = join(DIR, "apply-portable.ps1");
const LOG         = join(DIR, "apply.log");

function log(msg: string): void {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
	} catch { /* never block on logging */ }
}

/** Double single quotes for safe embedding inside PowerShell single-quoted strings. */
function ps(s: string): string {
	return s.replace(/'/g, "''");
}

/** Locate the folder containing bin/launcher.exe inside the extracted zip. */
function findBundleRoot(base: string): string | null {
	if (existsSync(join(base, "bin", "launcher.exe"))) return base;
	try {
		for (const entry of readdirSync(base, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(base, entry.name, "bin", "launcher.exe"))) {
				return join(base, entry.name);
			}
		}
	} catch { /* fall through */ }
	return null;
}

// ── Download ────────────────────────────────────────────────────────────────

export async function portableDownloadUpdate(): Promise<{ success: boolean; error?: string }> {
	try {
		const { baseUrl, name } = await Updater.getLocalInfo();
		const arch = process.arch === "arm64" ? "arm64" : "x64";
		const zipUrl = `${baseUrl}/${name}-win-${arch}-portable.zip`;

		rmSync(DIR, { recursive: true, force: true });
		mkdirSync(DIR, { recursive: true });
		log(`Portable download starting: ${zipUrl}`);

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

		const buffer = new Uint8Array(downloaded);
		let pos = 0;
		for (const chunk of chunks) { buffer.set(chunk, pos); pos += chunk.length; }
		await Bun.write(ZIP, buffer);
		log(`Downloaded ${downloaded} bytes to ${ZIP}`);

		broadcastToWebview("updateStatus", {
			status: "download-complete",
			message: "Update ready — restart to install",
		});
		return { success: true };
	} catch (e) {
		const message = (e as Error).message;
		log(`DOWNLOAD ERROR: ${message}`);
		broadcastToWebview("updateStatus", { status: "error", message });
		return { success: false, error: message };
	}
}

// ── Apply ─────────────────────────────────────────────────────────────────────

export async function portableApplyUpdate(): Promise<{ success: boolean; error?: string }> {
	try {
		log("Portable apply started");

		if (!existsSync(ZIP)) {
			const msg = "Update file not found — please download again";
			log(`ERROR: zip missing at ${ZIP}`);
			broadcastToWebview("updateStatus", { status: "error", message: msg });
			return { success: false, error: msg };
		}

		// Extract synchronously while still running (only the app's own bin/*.exe are
		// locked; the extracted copy goes to a separate temp folder).
		rmSync(EXTRACT_DIR, { recursive: true, force: true });
		const extract = Bun.spawnSync(
			[
				"powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
				`Expand-Archive -Path '${ps(ZIP)}' -DestinationPath '${ps(EXTRACT_DIR)}' -Force`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stderr = extract.stderr?.toString().trim() ?? "";
		log(`Expand-Archive exit=${extract.exitCode}${stderr ? ` stderr=${stderr}` : ""}`);
		if (extract.exitCode !== 0) {
			const msg = `Failed to extract update (exit ${extract.exitCode})${stderr ? `: ${stderr}` : ""}`;
			broadcastToWebview("updateStatus", { status: "error", message: msg });
			return { success: false, error: msg };
		}

		const newBundleRoot = findBundleRoot(EXTRACT_DIR);
		if (!newBundleRoot) {
			const msg = "Could not find the app bundle inside the downloaded update";
			log(`ERROR: ${msg}`);
			broadcastToWebview("updateStatus", { status: "error", message: msg });
			return { success: false, error: msg };
		}

		// The running portable bundle root = parent of the bin/ folder holding our exe.
		// process.execPath is .../<bundle>/bin/{bun|launcher}.exe → up two levels.
		const currentBundleRoot = dirname(dirname(resolve(process.execPath)));
		const launcherPath = join(currentBundleRoot, "bin", "launcher.exe");
		log(`current bundle: ${currentBundleRoot}`);
		log(`new bundle:     ${newBundleRoot}`);

		// Preserve the feature-flag files (kept in bin/, wiped by the mirror) — same
		// flags the Setup updater preserves.
		const binDir = join(currentBundleRoot, "bin");
		const hadFreelance = existsSync(join(binDir, "freelance"));
		const hadClaude = existsSync(join(binDir, "claude"));
		log(`flags freelance=${hadFreelance} claude=${hadClaude}`);

		const script = buildApplyScript({
			bundle: currentBundleRoot,
			src: newBundleRoot,
			launcher: launcherPath,
			binDir,
			log: LOG,
			cleanupZip: ZIP,
			cleanupExtract: EXTRACT_DIR,
			hadFreelance,
			hadClaude,
		});
		writeFileSync(SCRIPT, script, "utf-8");
		log("Wrote apply-portable.ps1");

		// Launch detached via `cmd /c start` so it escapes our process tree and
		// survives process.exit(). -ExecutionPolicy Bypass lets the .ps1 run under
		// the default RemoteSigned policy.
		Bun.spawnSync(
			[
				"cmd.exe", "/c", "start", "", "powershell.exe",
				"-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Normal", "-File", SCRIPT,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		log("Apply wrapper launched; app will now exit");
		return { success: true };
	} catch (e) {
		const msg = (e as Error).message;
		log(`APPLY EXCEPTION: ${msg}`);
		return { success: false, error: msg };
	}
}

// ── PowerShell apply script ─────────────────────────────────────────────────

function buildApplyScript(o: {
	bundle: string;
	src: string;
	launcher: string;
	binDir: string;
	log: string;
	cleanupZip: string;
	cleanupExtract: string;
	hadFreelance: boolean;
	hadClaude: boolean;
}): string {
	const restoreFlags =
		(o.hadFreelance ? `New-Item -ItemType File -Path '${ps(join(o.binDir, "freelance"))}' -Force | Out-Null\nLog 'Restored freelance flag'\n` : "") +
		(o.hadClaude ? `New-Item -ItemType File -Path '${ps(join(o.binDir, "claude"))}' -Force | Out-Null\nLog 'Restored claude flag'\n` : "");

	// NOTE: the script lives in temp (NOT under $bundle), so robocopy /MIR won't touch it.
	return `$ErrorActionPreference = 'Continue'
$bundle = '${ps(o.bundle)}'
$src = '${ps(o.src)}'
$launcher = '${ps(o.launcher)}'
$log = '${ps(o.log)}'
function Log($m) { try { Add-Content -Path $log -Value "$(Get-Date -Format 'HH:mm:ss') $m" } catch {} }

$host.UI.RawUI.WindowTitle = 'AgentDesk Update'
Write-Host ''
Write-Host '  AgentDesk Update (portable)' -ForegroundColor Cyan
Write-Host '  --------------------------------------' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  [1/3]  Waiting for AgentDesk to close...' -ForegroundColor Yellow
Log 'Waiting for app processes to exit'

$prefix = $bundle.ToLower()
if (-not $prefix.EndsWith('\\')) { $prefix = $prefix + '\\' }
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($prefix) }
  if (-not $running) { break }
  Start-Sleep -Milliseconds 400
}
Start-Sleep -Milliseconds 600
Log 'Proceeding with file swap'

Write-Host '  [2/3]  Installing update...' -ForegroundColor Yellow
# Mirror the new bundle over the running folder. robocopy exit codes 0-7 are success.
robocopy $src $bundle /MIR /R:2 /W:2 /NFL /NDL /NP /NJH /NJS | Out-Null
$rc = $LASTEXITCODE
Log "robocopy exit $rc"
if ($rc -ge 8) {
  Write-Host '         ERROR: could not update files (is the folder writable?).' -ForegroundColor Red
  Log 'ERROR: robocopy failed (>=8)'
}

# Purge Electrobun's unused updater binaries (bspatch.exe + zig-zstd.exe). /MIR already
# drops them once the new zip is stripped, but delete explicitly so existing installs lose
# them regardless of what the downloaded bundle contains (AgentDesk's Windows updater never
# uses the native bsdiff/zstd path). mac/Linux keep zig-zstd; this is the Windows path only.
Remove-Item -Force '${ps(join(o.binDir, "bspatch.exe"))}' -ErrorAction SilentlyContinue
Remove-Item -Force '${ps(join(o.binDir, "zig-zstd.exe"))}' -ErrorAction SilentlyContinue
Log 'Removed unused updater binaries (bspatch.exe, zig-zstd.exe)'

${restoreFlags}
Write-Host '  [3/3]  Launching AgentDesk...' -ForegroundColor Yellow
if (Test-Path $launcher) {
  Start-Process -FilePath $launcher
  Log 'Relaunched app'
  Write-Host '         Done.' -ForegroundColor Green
} else {
  Log 'ERROR: launcher not found'
  Write-Host '         ERROR: Launcher not found. Please start AgentDesk manually.' -ForegroundColor Red
  Start-Sleep -Seconds 8
}

# Best-effort cleanup (leave this script + log for diagnostics; OS clears temp eventually).
Remove-Item -Recurse -Force '${ps(o.cleanupExtract)}' -ErrorAction SilentlyContinue
Remove-Item -Force '${ps(o.cleanupZip)}' -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  Update complete. This window will close shortly.' -ForegroundColor DarkGray
Start-Sleep -Seconds 2
`;
}
