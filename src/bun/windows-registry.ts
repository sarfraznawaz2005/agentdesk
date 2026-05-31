import { join } from "path";
import { existsSync } from "fs";
import { Utils } from "electrobun/bun";

/**
 * Registers the app in Windows "Add or Remove Programs" (HKCU uninstall key).
 * Called on startup but skips the PowerShell write when the registered version
 * already matches the current version, using a local cache file — no subprocess
 * at all on normal launches (avoids any console window flash).
 * Only runs on Windows stable builds — silently no-ops on other platforms/channels.
 */
export async function registerWindowsUninstaller(): Promise<void> {
    if (process.platform !== "win32") return;

    try {
        const versionJson = await Bun.file("../Resources/version.json").json() as {
            identifier: string;
            channel: string;
            name: string;
            version: string;
        };

        const { identifier, channel, name, version } = versionJson;

        // Only register for stable releases — skip dev builds
        if (channel !== "stable") return;

        // Fast path: read a tiny local cache file — zero subprocesses, no window flash.
        // Written at the end of the PowerShell script so it only exists when the
        // registry write actually succeeded.
        const cacheFile = join(Utils.paths.userData, ".registry-version");
        if (existsSync(cacheFile)) {
            const cached = await Bun.file(cacheFile).text();
            if (cached.trim() === version) return;
        }

        const installDir   = join(Utils.paths.userData, "app");
        const iconPath     = join(installDir, "Resources", "app.ico");
        // electrobun copies all copy-section assets into Resources/app/
        const scriptPath   = join(installDir, "Resources", "app", "uninstall.ps1");
        const regKeyPs     = `HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${identifier}`;
        const uninstallStr = `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`;
        // Forward-slash path is fine for Set-Content; avoids backslash escaping issues
        const cacheFileFwd = cacheFile.replace(/\\/g, "/");

        const psScript = `
$regPath = '${regKeyPs}'
New-Item -Path $regPath -Force | Out-Null
New-ItemProperty -Path $regPath -Name 'DisplayName'     -Value '${name}'           -PropertyType String -Force | Out-Null
New-ItemProperty -Path $regPath -Name 'DisplayVersion'  -Value '${version}'        -PropertyType String -Force | Out-Null
New-ItemProperty -Path $regPath -Name 'Publisher'       -Value 'Sarfraz Ahmed'     -PropertyType String -Force | Out-Null
New-ItemProperty -Path $regPath -Name 'DisplayIcon'     -Value '${iconPath},0'     -PropertyType String -Force | Out-Null
New-ItemProperty -Path $regPath -Name 'InstallLocation' -Value '${installDir}'     -PropertyType String -Force | Out-Null
New-ItemProperty -Path $regPath -Name 'UninstallString' -Value '${uninstallStr}'   -PropertyType String -Force | Out-Null
New-ItemProperty -Path $regPath -Name 'NoModify'        -Value 1                   -PropertyType DWord  -Force | Out-Null
New-ItemProperty -Path $regPath -Name 'NoRepair'        -Value 1                   -PropertyType DWord  -Force | Out-Null
Set-Content -Path '${cacheFileFwd}' -Value '${version}' -NoNewline
`;

        // Fire-and-forget — don't block the startup thread.
        // PowerShell writes the cache file on success, so a failed write is retried next launch.
        Bun.spawn([
            "powershell.exe",
            "-ExecutionPolicy", "Bypass",
            "-WindowStyle", "Hidden",
            "-Command", psScript,
        ], { stdout: "ignore", stderr: "ignore" });
    } catch (err) {
        // Non-critical — never crash the app over registry writes
        console.error("[windows-registry] Failed to register uninstaller:", err);
    }
}
