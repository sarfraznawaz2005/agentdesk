// ---------------------------------------------------------------------------
// Playground RPC handlers
// ---------------------------------------------------------------------------

import { cpSync, readdirSync, existsSync, mkdirSync, rmSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Utils } from "electrobun/bun";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { aiProviders } from "../db/schema";
import { getDefaultModel } from "../providers/models";
import {
	runPlayground,
	stopPlayground,
	newPlayground as newPlaygroundImpl,
	getPlaygroundState as getStateImpl,
	isPlaygroundRunning,
} from "../playground/orchestrator";
import { PLAYGROUND_FILES_DIR, PLAYGROUND_COPY_IGNORE, PREVIEW_FILE } from "../playground/paths";
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

export function newPlayground(): { ok: boolean } {
	newPlaygroundImpl();
	return { ok: true };
}

export function getPlaygroundState(): ReturnType<typeof getStateImpl> {
	return getStateImpl();
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
