// ---------------------------------------------------------------------------
// LSP server binary discovery and installation
// ---------------------------------------------------------------------------

import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { $ } from "bun";
import { Utils } from "electrobun/bun";
import type { ServerDef, InstallDef } from "./servers";

/** Root directory for managed LSP server installs */
function getManagedDir(): string {
	return join(Utils.paths.userData, "lsp-servers");
}

/** Get the node_modules/.bin path for npm-installed servers */
function getManagedBinDir(): string {
	return join(getManagedDir(), "node_modules", ".bin");
}

/** Get the bin/ path for direct binary downloads */
function getManagedBinaryDir(): string {
	return join(getManagedDir(), "bin");
}

export type InstallStatus = "not_installed" | "installed" | "installing";

/** In-flight installs to prevent concurrent installs of the same server */
const installing = new Set<string>();

/**
 * Discovery chain:
 * 1. User override path (from plugin settings)
 * 2. System PATH lookup
 * 3. Managed install directory
 * Returns the full path to the binary, or null if not found.
 */
export async function resolveServerBinary(
	def: ServerDef,
	userOverride?: string,
): Promise<{ path: string; source: "custom" | "system" | "managed" } | null> {
	// 1. User override
	if (userOverride && userOverride.trim()) {
		const p = userOverride.trim();
		if (existsSync(p)) {
			return { path: p, source: "custom" };
		}
	}

	// 2. System PATH
	try {
		const result = await $`which ${def.binary}`.quiet().text();
		const systemPath = result.trim();
		if (systemPath && existsSync(systemPath)) {
			return { path: systemPath, source: "system" };
		}
	} catch {
		// Not in PATH
	}

	// 3. Managed install
	const managedPath = getManagedBinaryPath(def);
	if (managedPath && existsSync(managedPath)) {
		return { path: managedPath, source: "managed" };
	}

	return null;
}

/**
 * Get the expected path of a managed binary for a given server definition.
 */
function getManagedBinaryPath(def: ServerDef): string | null {
	if (def.install.method === "bun") {
		// npm packages install to node_modules/.bin/
		// Bun on Windows creates .exe (not .cmd like npm does)
		const binDir = getManagedBinDir();
		const ext = process.platform === "win32" ? ".exe" : "";
		return join(binDir, def.binary + ext);
	}
	if (def.install.method === "go" || def.install.method === "github") {
		const binDir = getManagedBinaryDir();
		const ext = process.platform === "win32" ? ".exe" : "";
		return join(binDir, def.binary + ext);
	}
	return null;
}

/**
 * Get the install status for a server (not_installed, installed, or installing).
 */
export async function getInstallStatus(
	def: ServerDef,
	userOverride?: string,
): Promise<{ status: InstallStatus; source?: "custom" | "system" | "managed" }> {
	if (installing.has(def.id)) {
		return { status: "installing" };
	}
	const resolved = await resolveServerBinary(def, userOverride);
	if (resolved) {
		return { status: "installed", source: resolved.source };
	}
	return { status: "not_installed" };
}

/**
 * Install a language server binary into the managed directory.
 * Returns the path to the installed binary on success.
 */
export async function installServer(def: ServerDef): Promise<string> {
	if (installing.has(def.id)) {
		throw new Error(`${def.displayName} is already being installed`);
	}

	installing.add(def.id);
	try {
		const managedDir = getManagedDir();
		await mkdir(managedDir, { recursive: true });

		switch (def.install.method) {
			case "bun":
				return await installViaBun(def, managedDir);
			case "go":
				return await installViaGo(def);
			case "github":
				return await installViaGitHub(def);
			default:
				throw new Error(`Unknown install method: ${(def.install as InstallDef).method}`);
		}
	} finally {
		installing.delete(def.id);
	}
}

/**
 * Remove a managed install for a given server.
 */
export async function uninstallServer(def: ServerDef): Promise<void> {
	if (def.install.method === "bun" && def.install.packages) {
		const managedDir = getManagedDir();
		const pkgJsonPath = join(managedDir, "package.json");

		if (!existsSync(pkgJsonPath)) {
			return;
		}

		const proc = Bun.spawn([process.execPath, "remove", ...def.install.packages], { cwd: managedDir, stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`bun remove failed (exit ${exitCode}): ${stderr}`);
		}

		// Also remove the binary if it still exists
		const binPath = getManagedBinaryPath(def);
		if (binPath && existsSync(binPath)) {
			const { unlink } = await import("fs/promises");
			await unlink(binPath);
		}
	} else {
		const path = getManagedBinaryPath(def);
		if (path && existsSync(path)) {
			const { unlink } = await import("fs/promises");
			await unlink(path);
		}
	}
}

/**
 * Check whether a prerequisite tool binary exists in PATH.
 * Returns true if found, false if not.
 */
export async function checkPrerequisite(binary: string): Promise<boolean> {
	try {
		const result = await $`which ${binary}`.quiet().text();
		return result.trim().length > 0;
	} catch {
		return false;
	}
}

// ── Install methods ──────────────────────────────────────────────────────

async function installViaBun(def: ServerDef, managedDir: string): Promise<string> {
	const packages = def.install.packages;
	if (!packages?.length) throw new Error("No packages defined for bun install");

	// Ensure package.json exists in managed dir
	const pkgJsonPath = join(managedDir, "package.json");
	if (!existsSync(pkgJsonPath)) {
		await Bun.write(pkgJsonPath, JSON.stringify({ name: "agentdesk-lsp-servers", private: true }, null, 2));
	}

	const proc = Bun.spawn([process.execPath, "add", ...packages], { cwd: managedDir, stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`bun add failed (exit ${exitCode}): ${stderr}`);
	}

	const binPath = getManagedBinaryPath(def);
	if (!binPath || !existsSync(binPath)) {
		throw new Error(`Installation completed but binary not found at ${binPath}`);
	}
	return binPath;
}

async function installViaGo(def: ServerDef): Promise<string> {
	const goPackage = def.install.goPackage;
	if (!goPackage) throw new Error("No Go package defined");

	const hasGo = await checkPrerequisite("go");
	if (!hasGo) {
		const url = def.install.prereq?.installUrl ?? "https://go.dev/dl/";
		throw new Error(`Go SDK not found in PATH. Install it from ${url} and restart AgentDesk.`);
	}

	const binDir = getManagedBinaryDir();
	await mkdir(binDir, { recursive: true });

	// Set GOBIN so the binary lands in our managed dir
	await $`GOBIN=${binDir} go install ${goPackage}`.quiet();

	const binPath = getManagedBinaryPath(def);
	if (!binPath || !existsSync(binPath)) {
		throw new Error(`go install completed but binary not found at ${binPath}`);
	}
	return binPath;
}

async function installViaGitHub(def: ServerDef): Promise<string> {
	const { repo, asset } = def.install;
	if (!repo || !asset) throw new Error("No GitHub repo/asset defined");

	const binDir = getManagedBinaryDir();
	await mkdir(binDir, { recursive: true });

	// Determine platform string
	const platform = getPlatformString();
	const assetName = asset.replace("{platform}", platform);

	// Fetch latest release from GitHub API
	const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
	const response = await fetch(apiUrl, {
		headers: { Accept: "application/vnd.github.v3+json" },
	});
	if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);

	const release = (await response.json()) as { assets: Array<{ name: string; browser_download_url: string }> };
	const matchingAsset = release.assets.find((a) => a.name.includes(assetName));
	if (!matchingAsset) {
		throw new Error(`No matching asset "${assetName}" in latest release of ${repo}`);
	}

	// Download the binary
	const downloadUrl = matchingAsset.browser_download_url;
	const downloadResp = await fetch(downloadUrl);
	if (!downloadResp.ok) throw new Error(`Download failed: ${downloadResp.status}`);

	const ext = process.platform === "win32" ? ".exe" : "";
	const destPath = join(binDir, def.binary + ext);
	const data = new Uint8Array(await downloadResp.arrayBuffer());

	// Handle .gz compressed assets
	if (matchingAsset.name.endsWith(".gz")) {
		const { gunzipSync } = await import("zlib");
		const decompressed = gunzipSync(Buffer.from(data));
		await Bun.write(destPath, decompressed);
	} else {
		await Bun.write(destPath, data);
	}

	// Make executable on Unix
	if (process.platform !== "win32") {
		await $`chmod +x ${destPath}`.quiet();
	}

	return destPath;
}

function getPlatformString(): string {
	const os = process.platform === "win32" ? "pc-windows-msvc" : process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu";
	const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
	return `${arch}-${os}`;
}
