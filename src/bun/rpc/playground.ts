// ---------------------------------------------------------------------------
// Playground RPC handlers
// ---------------------------------------------------------------------------

import { cpSync, readdirSync, existsSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync, realpathSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import os from "node:os";
import { Utils } from "electrobun/bun";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { aiProviders, settings } from "../db/schema";
import { getDefaultModel } from "../providers/models";
import {
	runPlayground,
	stopPlayground,
	newPlayground as newPlaygroundImpl,
	getPlaygroundState as getStateImpl,
	isPlaygroundRunning,
} from "../playground/orchestrator";
import { PLAYGROUND_ROOT, PLAYGROUND_FILES_DIR, PLAYGROUND_COPY_IGNORE, PREVIEW_FILE, DEPLOY_FILE, SERVERS_FILE } from "../playground/paths";
import { getRunningJobsUnderPath, killJobById, startBackgroundJob } from "../agents/tools/process";
import type { PlaygroundServerDto, PlaygroundPreviewDto } from "../../shared/rpc/playground";
import { createProjectHandler, getProject } from "./projects";

// --- playgroundSend (fire-and-forget; streams via broadcasts) ----------------

export async function playgroundSend(params: { message: string; consoleErrors?: string[] }): Promise<{ ok: boolean; error?: string }> {
	const message = params.message?.trim();
	if (!message) return { ok: false, error: "Message is empty." };
	if (isPlaygroundRunning()) return { ok: false, error: "A playground run is already in progress." };

	// Don't await — let it run in the background and stream events.
	runPlayground(message, params.consoleErrors).catch((err) => {
		console.error("[playground] run error:", err);
	});
	return { ok: true };
}

export function playgroundStop(): { ok: boolean } {
	stopPlayground();
	return { ok: true };
}

export function newPlayground(params?: { force?: boolean }): { ok: boolean; error?: string } {
	// `force` recovery path: a wipe fails when a playground dev server still holds
	// a file (common on Windows). Kill every running job rooted in the playground
	// to release those locks, then wipe — turning a dead-end into a one-click retry.
	if (params?.force) {
		for (const job of getRunningJobsUnderPath(PLAYGROUND_ROOT)) {
			killJobById(job.id);
		}
	}
	try {
		newPlaygroundImpl();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export function getPlaygroundState() {
	const state = getStateImpl();
	let deployedUrl: string | null = null;
	try {
		if (existsSync(DEPLOY_FILE)) {
			deployedUrl = (JSON.parse(readFileSync(DEPLOY_FILE, "utf-8")) as { url?: string }).url ?? null;
		}
	} catch { /* ignore corrupt file */ }
	return { ...state, deployedUrl };
}

// --- getPlaygroundSource (raw text files, for the "View source" dialog) ----

const SOURCE_TEXT_EXT = new Set([
	"html", "htm", "css", "scss", "sass", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx",
	"json", "jsonc", "md", "markdown", "txt", "svg", "xml", "yaml", "yml", "toml", "csv",
	"py", "rb", "go", "rs", "java", "php", "sh", "graphql", "gql", "vue", "svelte",
]);
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SOURCE_FILES = 60;

function readSourceFiles(dir: string, base = "", acc: { path: string; content: string }[] = []): { path: string; content: string }[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return acc;
	}
	for (const e of entries) {
		if (acc.length >= MAX_SOURCE_FILES) break;
		if (PLAYGROUND_COPY_IGNORE.has(e.name)) continue;
		const rel = base ? `${base}/${e.name}` : e.name;
		const abs = path.join(dir, e.name);
		if (e.isDirectory()) {
			readSourceFiles(abs, rel, acc);
		} else if (e.isFile()) {
			const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
			if (!SOURCE_TEXT_EXT.has(ext)) continue;
			try {
				if (statSync(abs).size > MAX_SOURCE_BYTES) continue;
				acc.push({ path: rel, content: readFileSync(abs, "utf-8") });
			} catch {
				/* skip unreadable */
			}
		}
	}
	return acc;
}

export function getPlaygroundSource(): { files: { path: string; content: string }[] } {
	const files = readSourceFiles(PLAYGROUND_FILES_DIR).sort((a, b) => a.path.localeCompare(b.path));
	return { files };
}

// --- createProjectFromPlayground --------------------------------------------

/** Generate a short, slug-friendly project name from the playground contents. */
async function generateProjectName(): Promise<string> {
	const fallback = "playground-project";
	try {
		const files = readdirSync(PLAYGROUND_FILES_DIR)
			.filter((f) => !PLAYGROUND_COPY_IGNORE.has(f))
			.slice(0, 40);
		if (files.length === 0) return fallback;

		let providerRow = (await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1))[0];
		if (!providerRow) providerRow = (await db.select().from(aiProviders).limit(1))[0];
		if (!providerRow) return fallback;

		const { generateText } = await import("ai");
		const { createProviderAdapter } = await import("../providers");
		const modelId = providerRow.defaultModel || getDefaultModel(providerRow.providerType);
		const adapter = createProviderAdapter({
			id: providerRow.id,
			name: providerRow.name,
			providerType: providerRow.providerType,
			apiKey: providerRow.apiKey ?? "",
			baseUrl: providerRow.baseUrl ?? null,
			defaultModel: providerRow.defaultModel ?? null,
		});
		const result = await generateText({
			model: adapter.createModel(modelId),
			system:
				"You name software projects. Given a list of files, reply with ONLY a concise, descriptive " +
				"project name of 2-4 words in Title Case. No quotes, no punctuation, no explanation.",
			messages: [{ role: "user", content: `Files in the project:\n${files.join("\n")}\n\nProject name:` }],
		});
		const name = result.text.trim().replace(/^["']|["']$/g, "").split("\n")[0].slice(0, 60);
		return name || fallback;
	} catch {
		return fallback;
	}
}

export async function createProjectFromPlayground(): Promise<{
	success: boolean;
	id?: string;
	name?: string;
	error?: string;
}> {
	if (!existsSync(PLAYGROUND_FILES_DIR) || readdirSync(PLAYGROUND_FILES_DIR).filter((f) => !PLAYGROUND_COPY_IGNORE.has(f)).length === 0) {
		return { success: false, error: "Nothing to save — the playground is empty." };
	}

	const baseName = await generateProjectName();

	// Create the project (auto-derives workspace path). Retry on name collision.
	let created: { success: boolean; id: string; error?: string } | null = null;
	let finalName = baseName;
	for (let attempt = 0; attempt < 6; attempt++) {
		const name = attempt === 0 ? baseName : `${baseName} ${attempt + 1}`;
		const res = await createProjectHandler({ name, description: "Created from Playground" });
		if (res.success) {
			created = res;
			finalName = name;
			break;
		}
		if (res.error?.includes("already exists")) continue;
		return {
			success: false,
			error: res.error || "Could not create project. Set a workspace path in Settings → General first.",
		};
	}
	if (!created) return { success: false, error: "Could not find an available project name." };

	// Resolve the project's workspace path and copy the playground files into it.
	const project = await getProject(created.id);
	const dest = project?.workspacePath;
	if (!dest) return { success: false, error: "Project created but its workspace path could not be resolved." };

	try {
		cpSync(PLAYGROUND_FILES_DIR, dest, {
			recursive: true,
			filter: (src) => !PLAYGROUND_COPY_IGNORE.has(path.basename(src)),
		});
	} catch (err) {
		return { success: false, id: created.id, name: finalName, error: `Project created but copying files failed: ${err instanceof Error ? err.message : String(err)}` };
	}

	// Verify the copy landed.
	if (!existsSync(dest) || readdirSync(dest).length === 0) {
		return { success: false, id: created.id, name: finalName, error: "Project created but no files were copied." };
	}

	return { success: true, id: created.id, name: finalName };
}

// --- exportPlaygroundZip -----------------------------------------------------

/**
 * Resolve the user's ACTUAL Downloads folder. Electrobun's Utils.paths.downloads
 * returns the default %USERPROFILE%\Downloads and does NOT honor a relocated
 * Downloads known-folder (common on Windows when Downloads is moved to another
 * drive). On Windows we read the real path from the registry; otherwise fall back.
 */
function resolveDownloadsDir(): string {
	if (process.platform === "win32") {
		try {
			const proc = Bun.spawnSync(
				[
					"reg", "query",
					"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders",
					"/v", "{374DE290-123F-4565-9164-39C4925E467B}",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const m = proc.stdout.toString().match(/REG_SZ\s+(.+)/);
			const resolved = m?.[1]?.trim();
			if (resolved && existsSync(resolved)) return resolved;
		} catch { /* fall through to default */ }
	}
	return Utils.paths.downloads || Utils.paths.home;
}

/** Slugify a preview title into a folder/file-friendly project name. */
function projectNameFromPreview(): string {
	let title = "";
	try {
		if (existsSync(PREVIEW_FILE)) {
			const preview = JSON.parse(readFileSync(PREVIEW_FILE, "utf-8")) as { title?: string };
			title = preview?.title ?? "";
		}
	} catch { /* ignore */ }
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
	return slug || "playground-project";
}

export async function exportPlaygroundZip(): Promise<{ success: boolean; path?: string; error?: string }> {
	if (!existsSync(PLAYGROUND_FILES_DIR) || readdirSync(PLAYGROUND_FILES_DIR).length === 0) {
		return { success: false, error: "Nothing to export — the playground is empty." };
	}

	const downloads = resolveDownloadsDir();
	const projectName = projectNameFromPreview();

	// Stage the files inside a folder named after the project, so the archive contains
	// `<projectName>/...` and extracts into its own folder instead of loose files.
	const stagingRoot = path.join(os.tmpdir(), "agentdesk-playground-export");
	const stageDir = path.join(stagingRoot, projectName);
	try {
		rmSync(stagingRoot, { recursive: true, force: true });
		mkdirSync(stageDir, { recursive: true });
		cpSync(PLAYGROUND_FILES_DIR, stageDir, {
			recursive: true,
			filter: (src) => !PLAYGROUND_COPY_IGNORE.has(path.basename(src)),
		});
	} catch (err) {
		return { success: false, error: `Could not stage files: ${err instanceof Error ? err.message : String(err)}` };
	}

	// Unique output path: <Downloads>/<projectName>.zip (then -1, -2, … if it exists).
	let out = path.join(downloads, `${projectName}.zip`);
	for (let n = 1; existsSync(out); n++) out = path.join(downloads, `${projectName}-${n}.zip`);

	try {
		let proc;
		if (process.platform === "win32") {
			// cwd = stagingRoot so the relative -Path '<projectName>' nests the folder in the archive.
			proc = Bun.spawn(
				[
					"powershell", "-NoProfile", "-NonInteractive", "-Command",
					`Compress-Archive -Path '${projectName}' -DestinationPath '${out}' -Force`,
				],
				{ cwd: stagingRoot, stdout: "ignore", stderr: "pipe" },
			);
		} else {
			proc = Bun.spawn(["zip", "-r", "-q", out, projectName], { cwd: stagingRoot, stdout: "ignore", stderr: "pipe" });
		}
		await proc.exited;
		const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
		try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* ignore */ }

		if (proc.exitCode !== 0 || !existsSync(out)) {
			return { success: false, error: `Zip failed (exit ${proc.exitCode}). ${stderr.slice(0, 200)}`.trim() };
		}
		return { success: true, path: out };
	} catch (err) {
		try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// --- savePlaygroundFile ------------------------------------------------------

export function savePlaygroundFile(params: { path: string; content: string }): { success: boolean; error?: string } {
	try {
		const base = path.resolve(PLAYGROUND_FILES_DIR);
		const resolved = path.resolve(base, params.path);
		// Prevent path traversal — the resolved path must stay inside PLAYGROUND_FILES_DIR
		if (resolved !== base && !resolved.startsWith(base + path.sep) && !resolved.startsWith(base + "/")) {
			return { success: false, error: "Path is outside the playground directory." };
		}
		mkdirSync(path.dirname(resolved), { recursive: true });
		writeFileSync(resolved, params.content, "utf-8");
		return { success: true };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// --- setPlaygroundPreviewUrl -------------------------------------------------

/**
 * Update the `url` field of the current preview manifest. Lets the user point the
 * live preview at a different address (e.g. correct a dev-server port) from the
 * Playground page instead of hand-editing preview.json in the temp folder.
 */
export function setPlaygroundPreviewUrl(params: { url: string }): {
	success: boolean;
	preview?: PlaygroundPreviewDto;
	error?: string;
} {
	const url = params.url?.trim();
	if (!url) return { success: false, error: "URL is empty." };
	if (!existsSync(PREVIEW_FILE)) return { success: false, error: "There is no active preview to update." };
	try {
		const preview = JSON.parse(readFileSync(PREVIEW_FILE, "utf-8")) as PlaygroundPreviewDto;
		const updated: PlaygroundPreviewDto = { ...preview, url };
		writeFileSync(PREVIEW_FILE, JSON.stringify(updated, null, 2), "utf-8");
		return { success: true, preview: updated };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// --- dev servers (persisted so they survive a restart as "stopped") ----------

interface PersistedServer { command: string; cwd: string; label: string }

function readPersistedServers(): PersistedServer[] {
	try {
		if (!existsSync(SERVERS_FILE)) return [];
		const data = JSON.parse(readFileSync(SERVERS_FILE, "utf-8")) as PersistedServer[];
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

function writePersistedServers(servers: PersistedServer[]): void {
	try {
		mkdirSync(path.dirname(SERVERS_FILE), { recursive: true });
		writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2), "utf-8");
	} catch { /* non-fatal */ }
}

export function getPlaygroundDevServers(): { servers: PlaygroundServerDto[] } {
	const live = getRunningJobsUnderPath(PLAYGROUND_ROOT);

	// Merge any currently-running servers into the persisted set (dedupe by command),
	// so they're remembered as "stopped" after the app restarts and kills them.
	const persisted = readPersistedServers();
	let changed = false;
	for (const job of live) {
		if (!persisted.some((p) => p.command === job.command)) {
			persisted.push({ command: job.command, cwd: job.cwd, label: job.label });
			changed = true;
		}
	}
	if (changed) writePersistedServers(persisted);

	// A persisted server is "running" if a live job currently matches its command.
	const servers: PlaygroundServerDto[] = persisted.map((p) => {
		const job = live.find((l) => l.command === p.command);
		return job
			? { id: job.id, label: p.label, command: p.command, status: "running" as const, pid: job.pid, startedAt: job.startedAt, elapsedHuman: job.elapsedHuman }
			: { id: "", label: p.label, command: p.command, status: "stopped" as const };
	});
	return { servers };
}

export function stopPlaygroundDevServer(params: { jobId: string }): { ok: boolean } {
	// Stop the process but KEEP it in servers.json so it stays in the strip as
	// "stopped" with a ▶ start button. Only "New Playground" clears servers.json.
	return { ok: killJobById(params.jobId) };
}

export async function startPlaygroundDevServer(params: { command: string }): Promise<{ ok: boolean; error?: string }> {
	const persisted = readPersistedServers();
	const entry = persisted.find((p) => p.command === params.command);
	if (!entry) return { ok: false, error: "Unknown server — it is no longer tracked." };

	const result = await startBackgroundJob({ command: entry.command, workingDirectory: entry.cwd, label: entry.label });
	if (result.error) return { ok: false, error: result.error };
	return { ok: true };
}

// --- deployPlayground (surge.sh) --------------------------------------------

const SURGE_FIXED_PASSWORD = "AgentDesk!Surge#Playground2024";

/** Read surge credentials from ~/.netrc (checks both .netrc and _netrc for Windows compat). */
function readSurgeNetrc(): { email: string; token: string } | null {
	try {
		const home = os.homedir();
		const netrcPath = [".netrc", "_netrc"].map((f) => path.join(home, f)).find(existsSync);
		if (!netrcPath) return null;
		const lines = readFileSync(netrcPath, "utf-8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		let inSurge = false;
		let login = "";
		let password = "";
		for (const line of lines) {
			if (line.startsWith("machine ")) {
				const machine = line.slice(8).trim();
				inSurge = machine === "surge.surge.sh" || machine === "surge.sh";
			} else if (inSurge) {
				const [key, val] = line.split(/\s+/);
				if (key === "login") login = val ?? "";
				if (key === "password") password = val ?? "";
			}
		}
		return login && password ? { email: login, token: password } : null;
	} catch {
		return null;
	}
}

async function cacheSurgeToken(email: string, token: string): Promise<void> {
	await db.insert(settings).values({ key: "surgeToken", value: token, category: "deploy" })
		.onConflictDoUpdate({ target: settings.key, set: { value: token } });
	await db.insert(settings).values({ key: "surgeTokenEmail", value: email, category: "deploy" })
		.onConflictDoUpdate({ target: settings.key, set: { value: email } });
}

/**
 * Resolve a surge.sh auth token for the given email:
 *  1. Cached token in settings (fastest)
 *  2. ~/.netrc written by `surge login` (existing accounts)
 *  3. POST to surge API with our fixed password (new accounts)
 */
async function getSurgeToken(email: string): Promise<{ token: string } | { error: string }> {
	// 1. Cached
	const [tokenRow, emailRow] = await Promise.all([
		db.select({ value: settings.value }).from(settings).where(eq(settings.key, "surgeToken")).limit(1),
		db.select({ value: settings.value }).from(settings).where(eq(settings.key, "surgeTokenEmail")).limit(1),
	]);
	if (tokenRow[0]?.value && emailRow[0]?.value === email) {
		return { token: tokenRow[0].value };
	}

	// 2. ~/.netrc — covers users who already have a surge account (any password)
	const netrc = readSurgeNetrc();
	if (netrc) {
		await cacheSurgeToken(netrc.email, netrc.token);
		return { token: netrc.token };
	}

	// 3. API — creates a new account with our fixed password
	try {
		const auth = Buffer.from(`${email}:${SURGE_FIXED_PASSWORD}`).toString("base64");
		const token = await new Promise<string>((resolve, reject) => {
			const req = https.request(
				{
					hostname: "surge.surge.sh",
					port: 443,
					path: "/token",
					method: "POST",
					headers: { Authorization: `Basic ${auth}`, "Content-Length": 0 },
				},
				(res) => {
					if (res.statusCode && res.statusCode >= 400) {
						reject(new Error(
							`Surge auth failed (${res.statusCode}). ` +
							"Your email already has a surge.sh account with a different password. " +
							"Run `surge login` once in a terminal — after that, deploy will work automatically.",
						));
						res.resume();
						return;
					}
					let data = "";
					res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
					res.on("end", () => {
						try {
							resolve((JSON.parse(data) as { token?: string }).token?.trim() ?? "");
						} catch {
							resolve(data.trim());
						}
					});
				},
			);
			req.on("error", reject);
			req.end();
		});

		if (!token) return { error: "Surge returned an empty token." };
		await cacheSurgeToken(email, token);
		return { token };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export async function deployPlayground(): Promise<{ success: boolean; url?: string; error?: string }> {
	if (!existsSync(PLAYGROUND_FILES_DIR) || readdirSync(PLAYGROUND_FILES_DIR).length === 0) {
		return { success: false, error: "Nothing to deploy — the playground is empty." };
	}

	// Get user email from global settings (values are JSON-serialized, so parse quotes off)
	const emailRow = await db.select({ value: settings.value }).from(settings)
		.where(eq(settings.key, "user_email")).limit(1);
	const rawEmail = emailRow[0]?.value?.trim() ?? "";
	let email = rawEmail;
	try { email = (JSON.parse(rawEmail) as string).trim(); } catch { /* keep raw value */ }
	if (!email) {
		return { success: false, error: "No email set in Settings → General. Surge.sh needs an email to create your free account." };
	}

	const tokenResult = await getSurgeToken(email);
	if ("error" in tokenResult) return { success: false, error: tokenResult.error };

	// Build a unique subdomain from the preview title + short random suffix
	const slug = projectNameFromPreview();
	const suffix = crypto.randomUUID().slice(0, 6);
	const domain = `${slug}-${suffix}.surge.sh`;

	try {
		// Resolve the real long path for the temp dir to avoid Windows 8.3 short name
		// paths (e.g. MEHBOO~1.REH) that break bunx's CJS module resolution.
		const realTemp = realpathSync(os.tmpdir());
		const proc = Bun.spawn(
			["bun", "x", "surge", PLAYGROUND_FILES_DIR, domain],
			{
				env: { ...process.env, SURGE_LOGIN: email, SURGE_TOKEN: tokenResult.token, TEMP: realTemp, TMP: realTemp, TMPDIR: realTemp },
				stdout: "pipe",
				stderr: "pipe",
				stdin: null,
			},
		);

		const timeout = setTimeout(() => proc.kill(), 90_000);
		await proc.exited;
		clearTimeout(timeout);

		if (proc.exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			const stdout = await new Response(proc.stdout).text();
			const detail = (stderr + stdout).slice(0, 300).trim();
			// Clear cached token — it may be stale; next deploy will re-fetch
			await db.delete(settings).where(eq(settings.key, "surgeToken"));
			return {
				success: false,
				error: detail ||
					"Deploy failed. If you already have a surge.sh account, run `surge login` in a terminal first to save your credentials.",
			};
		}

		const url = `https://${domain}`;
		try { writeFileSync(DEPLOY_FILE, JSON.stringify({ url }), "utf-8"); } catch { /* non-fatal */ }
		return { success: true, url };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

