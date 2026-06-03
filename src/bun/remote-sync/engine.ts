// ---------------------------------------------------------------------------
// Remote Sync — engine
// ---------------------------------------------------------------------------
// Orchestrates the actual SFTP/FTP work: test, browse (lazy tree), pull
// (download selections into the workspace), diff (what changed locally), and
// push (upload changed/new files back). Every operation streams progress to the
// webview so the user always sees exactly what is happening.
//
// One operation per project at a time (a per-project lock). Pull/push run a
// single connection sequentially — robust, ordered, and easy to narrate.
// ---------------------------------------------------------------------------

import { createHash } from "crypto";
import { createReadStream, promises as fsp } from "fs";
import { join, dirname, relative, isAbsolute } from "path";
import { db } from "../db";
import { projects } from "../db/schema";
import { eq } from "drizzle-orm";
import { broadcastToWebview } from "../engine-manager";
import {
	createRemoteClient,
	posixJoin,
	posixDirname,
	type RemoteClient,
	type RemoteEntry,
} from "./client";
import {
	resolveRemoteConfig,
	createRun,
	updateRun,
	getManifest,
	upsertManifestItem,
	setLastPulled,
	setLastPushed,
	setHostKeyFingerprint,
	type ResolvedRemoteConfig,
} from "./config";
import type { PushDiffEntry, RemoteEntryDto } from "../../shared/rpc/remote-sync";

// --- per-project lock + cancellation ----------------------------------------

const active = new Map<string, AbortController>();

export function isBusy(projectId: string): boolean {
	return active.has(projectId);
}

export function cancel(projectId: string): boolean {
	const ac = active.get(projectId);
	if (!ac) return false;
	ac.abort();
	return true;
}

class CancelledError extends Error {
	constructor() {
		super("Cancelled");
		this.name = "CancelledError";
	}
}

// --- small helpers -----------------------------------------------------------

async function getWorkspacePath(projectId: string): Promise<string | null> {
	const rows = await db
		.select({ workspacePath: projects.workspacePath })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	return rows[0]?.workspacePath ?? null;
}

function hashFile(absPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(absPath);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

/** True for a single, safe path component (no separators, traversal, or NUL). */
function isSafeSegment(name: string): boolean {
	return name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

/** True if every segment of a base-relative path is safe. */
function isSafeRel(rel: string): boolean {
	return rel.split("/").every(isSafeSegment);
}

/**
 * Absolute local path for a base-relative remote path, GUARDED against path
 * traversal: the result must stay within the project's local sync root. Throws
 * otherwise (e.g. a hostile server returning a name containing "..").
 */
function toLocalAbs(workspacePath: string, localSubdir: string, rel: string): string {
	const root = join(workspacePath, ...localSubdir.split("/").filter(Boolean));
	const localAbs = join(root, ...rel.split("/").filter(Boolean));
	const within = relative(root, localAbs);
	if (within.startsWith("..") || isAbsolute(within)) {
		throw new Error(`Unsafe path rejected (escapes workspace): ${rel}`);
	}
	return localAbs;
}

/** Workspace-relative POSIX path stored in the manifest. */
function toLocalRel(localSubdir: string, rel: string): string {
	return [localSubdir, rel].filter(Boolean).join("/");
}

function log(projectId: string, level: "info" | "warn" | "error", message: string): void {
	broadcastToWebview("remoteSyncLog", { projectId, level, message, at: new Date().toISOString() });
}

// --- exclude patterns (glob) -------------------------------------------------

/** Compile a single glob into an anchored RegExp. `**` crosses `/`, `*`/`?` do not. */
function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp("^" + re + "$");
}

/** Build a predicate that tests a base-relative path against exclude patterns.
 *  Patterns without "/" match any path segment (so "node_modules" excludes it anywhere);
 *  patterns with "/" match the full relative path. */
function makeExcluder(patterns: string[]): (rel: string) => boolean {
	if (!patterns?.length) return () => false;
	const compiled = patterns
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => ({ re: globToRegExp(p), hasSlash: p.includes("/") }));
	return (rel: string) => {
		const segs = rel.split("/");
		const base = segs[segs.length - 1];
		for (const { re, hasSlash } of compiled) {
			if (hasSlash) {
				if (re.test(rel)) return true;
			} else if (re.test(base) || segs.some((s) => re.test(s))) {
				return true;
			}
		}
		return false;
	};
}

// --- SFTP host-key trust-on-first-use ---------------------------------------

/** After a successful connect, persist a freshly observed SFTP host key (TOFU). */
async function pinHostKeyIfNew(projectId: string, client: RemoteClient, cfg: ResolvedRemoteConfig): Promise<void> {
	if (cfg.hadHostKey) return;
	const fp = client.getHostKeyFingerprint?.() ?? null;
	if (fp) {
		await setHostKeyFingerprint(projectId, fp);
		log(projectId, "info", `Trusted host key ${fp} (first connection).`);
	}
}

/** If a connect failure was actually a host-key mismatch, return a clear message. */
function hostKeyMismatchMessage(client: RemoteClient, cfg: ResolvedRemoteConfig): string | null {
	const expected = cfg.creds.expectedHostKeyFp;
	const seen = client.getHostKeyFingerprint?.() ?? null;
	if (expected && seen && seen !== expected) {
		return `Host key mismatch — expected ${expected} but the server presented ${seen}. If the server's key legitimately changed, forget the saved key in Connection settings and reconnect.`;
	}
	return null;
}

// --- browse connection cache ------------------------------------------------
// Folder-tree expansion would otherwise open a fresh connection per click. We
// keep ONE short-lived connection per project, reused across expands and closed
// after a short idle period. Browse ops are serialized per project so we never
// issue concurrent commands on the same connection.

const BROWSE_IDLE_MS = 30_000;
const browseClients = new Map<string, { client: RemoteClient; timer: ReturnType<typeof setTimeout> }>();
const browseQueues = new Map<string, Promise<unknown>>();

async function disconnectBrowse(projectId: string): Promise<void> {
	const entry = browseClients.get(projectId);
	if (!entry) return;
	browseClients.delete(projectId);
	clearTimeout(entry.timer);
	await entry.client.disconnect().catch(() => {});
}

/** Drop any cached browse connection (call after the connection config changes). */
export async function evictBrowseCache(projectId: string): Promise<void> {
	await disconnectBrowse(projectId);
}

function scheduleBrowseEvict(projectId: string): void {
	const entry = browseClients.get(projectId);
	if (!entry) return;
	clearTimeout(entry.timer);
	entry.timer = setTimeout(() => void disconnectBrowse(projectId), BROWSE_IDLE_MS);
}

async function getBrowseClient(
	projectId: string,
	cfg: ResolvedRemoteConfig,
): Promise<{ client: RemoteClient; fresh: boolean }> {
	const existing = browseClients.get(projectId);
	if (existing) return { client: existing.client, fresh: false };
	const client = createRemoteClient(cfg.creds);
	try {
		await client.connect();
	} catch (e) {
		const mm = hostKeyMismatchMessage(client, cfg);
		await client.disconnect().catch(() => {});
		throw mm ? new Error(mm) : e;
	}
	await pinHostKeyIfNew(projectId, client, cfg);
	const timer = setTimeout(() => void disconnectBrowse(projectId), BROWSE_IDLE_MS);
	browseClients.set(projectId, { client, timer });
	return { client, fresh: true };
}

// --- test + browse -----------------------------------------------------------

export async function testConnection(projectId: string): Promise<{ ok: boolean; message?: string; error?: string }> {
	let cfg: ResolvedRemoteConfig | null;
	try {
		cfg = await resolveRemoteConfig(projectId);
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	if (!cfg) return { ok: false, error: "No connection configured." };
	if (!cfg.creds.host) return { ok: false, error: "Host is required." };

	const client = createRemoteClient(cfg.creds);
	try {
		await client.connect();
		const entries = await client.list(cfg.remoteBasePath || "/");
		const fp = client.getHostKeyFingerprint?.() ?? null;
		await pinHostKeyIfNew(projectId, client, cfg);
		let message = `Connected — ${entries.length} entries in ${cfg.remoteBasePath || "/"}.`;
		if (fp && !cfg.hadHostKey) message += ` Trusted host key ${fp}.`;
		return { ok: true, message };
	} catch (e) {
		const mismatch = hostKeyMismatchMessage(client, cfg);
		return { ok: false, error: mismatch ?? (e instanceof Error ? e.message : String(e)) };
	} finally {
		await client.disconnect();
	}
}

export async function browseRemoteDir(
	projectId: string,
	remoteDir: string,
): Promise<{ entries: RemoteEntryDto[]; error?: string }> {
	let cfg: ResolvedRemoteConfig | null;
	try {
		cfg = await resolveRemoteConfig(projectId);
	} catch (e) {
		return { entries: [], error: e instanceof Error ? e.message : String(e) };
	}
	if (!cfg) return { entries: [], error: "No connection configured." };
	const resolved = cfg;
	const dir = remoteDir || resolved.remoteBasePath || "/";

	const sortEntries = (entries: RemoteEntryDto[]) =>
		entries.sort((a, b) => {
			if (a.type === "dir" && b.type !== "dir") return -1;
			if (a.type !== "dir" && b.type === "dir") return 1;
			return a.name.localeCompare(b.name);
		});

	// Serialize per project so we never run two commands on the shared connection.
	// A reused connection can go stale and return an empty/garbage listing (common with
	// FTP passive-mode data channels), so if a REUSED connection lists nothing or throws,
	// drop it and retry once on a fresh connection. A fresh connection's result is trusted
	// as-is (an empty directory is legitimately empty).
	const run = async (): Promise<{ entries: RemoteEntryDto[]; error?: string }> => {
		let lastError: unknown = null;
		for (let attempt = 0; attempt < 2; attempt++) {
			let fresh = true;
			try {
				const got = await getBrowseClient(projectId, resolved);
				fresh = got.fresh;
				const entries = await got.client.list(dir);
				if (!fresh && entries.length === 0 && attempt === 0) {
					await disconnectBrowse(projectId); // maybe a stale socket — verify on a fresh one
					continue;
				}
				scheduleBrowseEvict(projectId);
				return { entries: sortEntries(entries) };
			} catch (e) {
				lastError = e;
				await disconnectBrowse(projectId);
				// Retry only a reused-connection failure; a fresh connect failing is real.
				if (fresh) break;
			}
		}
		return { entries: [], error: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : undefined };
	};

	const prev = browseQueues.get(projectId) ?? Promise.resolve();
	const next = prev.then(run, run);
	browseQueues.set(projectId, next.catch(() => {}));
	return next;
}

// --- recursive remote walk (for pull) ---------------------------------------

interface RemoteFile {
	rel: string; // relative to base
	size: number;
	mtime: number | null;
}

async function walkRemote(
	client: RemoteClient,
	basePath: string,
	rel: string,
	signal: AbortSignal,
	out: RemoteFile[],
	exclude: (rel: string) => boolean,
): Promise<void> {
	if (signal.aborted) throw new CancelledError();
	const abs = posixJoin(basePath, rel);
	const entries = await client.list(abs);
	for (const e of entries as RemoteEntry[]) {
		if (signal.aborted) throw new CancelledError();
		if (e.type === "symlink") continue; // don't follow symlinks (loop-safe)
		if (!isSafeSegment(e.name)) continue; // reject "."/".."/separators from a hostile server
		const childRel = rel ? `${rel}/${e.name}` : e.name;
		if (exclude(childRel)) continue;
		if (e.type === "dir") {
			await walkRemote(client, basePath, childRel, signal, out, exclude);
		} else {
			out.push({ rel: childRel, size: e.size, mtime: e.modifiedAt });
		}
	}
}

// --- pull --------------------------------------------------------------------

export async function pull(projectId: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
	if (active.has(projectId)) return { ok: false, error: "A sync is already running for this project." };

	let cfg: ResolvedRemoteConfig | null;
	try {
		cfg = await resolveRemoteConfig(projectId);
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	if (!cfg) return { ok: false, error: "No connection configured." };
	if (!cfg.selections.length) return { ok: false, error: "No files or folders selected to download." };
	const workspacePath = await getWorkspacePath(projectId);
	if (!workspacePath) return { ok: false, error: "Project workspace path not found." };

	const ac = new AbortController();
	active.set(projectId, ac);
	const runId = await createRun(projectId, "pull");

	// Run asynchronously; report via broadcasts.
	void runPull(projectId, runId, cfg, workspacePath, ac.signal)
		.catch((e) => log(projectId, "error", `Pull crashed: ${e instanceof Error ? e.message : String(e)}`))
		.finally(() => active.delete(projectId));

	return { ok: true, runId };
}

async function runPull(
	projectId: string,
	runId: string,
	cfg: ResolvedRemoteConfig,
	workspacePath: string,
	signal: AbortSignal,
): Promise<void> {
	const client = createRemoteClient(cfg.creds);
	let ok = 0;
	let failed = 0;
	let bytes = 0;
	const exclude = makeExcluder(cfg.excludePatterns);
	try {
		await client.connect();
		await pinHostKeyIfNew(projectId, client, cfg);
		log(projectId, "info", `Connected to ${cfg.creds.host}. Enumerating selected paths…`);

		// Build the full file list from selections (expand dirs). Explicit file
		// selections are always included; excludes only prune within directory walks.
		const files: RemoteFile[] = [];
		for (const sel of cfg.selections) {
			if (signal.aborted) throw new CancelledError();
			if (sel.type === "file") {
				const abs = posixJoin(cfg.remoteBasePath, sel.path);
				const st = await client.stat(abs);
				files.push({ rel: sel.path, size: st?.size ?? 0, mtime: st?.modifiedAt ?? null });
			} else {
				await walkRemote(client, cfg.remoteBasePath, sel.path, signal, files, exclude);
			}
		}

		broadcastToWebview("remoteSyncRunStarted", { projectId, runId, direction: "pull", totalFiles: files.length });
		await updateRun(runId, { totalFiles: files.length });
		log(projectId, "info", `Downloading ${files.length} file(s)…`);

		for (let i = 0; i < files.length; i++) {
			if (signal.aborted) throw new CancelledError();
			const f = files[i];
			broadcastToWebview("remoteSyncProgress", {
				projectId, runId, direction: "pull", file: f.rel, status: "start", index: i + 1, total: files.length,
			});
			try {
				// Guarded inside the loop so a single unsafe path fails just this file.
				const localAbs = toLocalAbs(workspacePath, cfg.localSubdir, f.rel);
				const remoteAbs = posixJoin(cfg.remoteBasePath, f.rel);
				await fsp.mkdir(dirname(localAbs), { recursive: true });
				await client.downloadFile(remoteAbs, localAbs);
				const sha = await hashFile(localAbs);
				const stat = await fsp.stat(localAbs);
				await upsertManifestItem({
					projectId,
					remotePath: f.rel,
					localPath: toLocalRel(cfg.localSubdir, f.rel),
					size: stat.size,
					remoteMtime: f.mtime,
					sha256: sha,
				});
				ok++;
				bytes += stat.size;
				broadcastToWebview("remoteSyncProgress", {
					projectId, runId, direction: "pull", file: f.rel, status: "ok", index: i + 1, total: files.length,
				});
			} catch (e) {
				failed++;
				const msg = e instanceof Error ? e.message : String(e);
				broadcastToWebview("remoteSyncProgress", {
					projectId, runId, direction: "pull", file: f.rel, status: "error", index: i + 1, total: files.length, error: msg,
				});
				log(projectId, "error", `Failed to download ${f.rel}: ${msg}`);
			}
			await updateRun(runId, { okFiles: ok, failedFiles: failed, bytes });
		}

		const now = new Date().toISOString();
		await setLastPulled(projectId, now);
		const status = failed === 0 ? "success" : ok === 0 ? "error" : "partial";
		const summary = `Downloaded ${ok}/${files.length} file(s)${failed ? `, ${failed} failed` : ""}.`;
		await updateRun(runId, { status, summary, okFiles: ok, failedFiles: failed, bytes, finishedAt: now });
		broadcastToWebview("remoteSyncRunComplete", {
			projectId, runId, direction: "pull", status, okFiles: ok, failedFiles: failed, bytes, summary,
		});
		log(projectId, failed ? "warn" : "info", summary);
	} catch (e) {
		const cancelled = e instanceof CancelledError;
		const now = new Date().toISOString();
		const msg = cancelled
			? "Cancelled by user."
			: hostKeyMismatchMessage(client, cfg) ?? (e instanceof Error ? e.message : String(e));
		await updateRun(runId, {
			status: cancelled ? "cancelled" : "error",
			error: msg,
			okFiles: ok, failedFiles: failed, bytes,
			finishedAt: now,
		});
		broadcastToWebview("remoteSyncRunError", { projectId, runId, error: msg });
		log(projectId, "error", `Pull ${cancelled ? "cancelled" : "failed"}: ${msg}`);
	} finally {
		await client.disconnect();
	}
}

// --- local walk (for diff/push) ---------------------------------------------

async function walkLocal(
	rootAbs: string,
	rel: string,
	out: string[],
	exclude: (rel: string) => boolean,
): Promise<void> {
	const abs = rel ? join(rootAbs, ...rel.split("/")) : rootAbs;
	let entries: import("fs").Dirent[];
	try {
		entries = await fsp.readdir(abs, { withFileTypes: true });
	} catch {
		return; // dir missing locally
	}
	for (const e of entries) {
		if (e.isSymbolicLink()) continue;
		const childRel = rel ? `${rel}/${e.name}` : e.name;
		if (exclude(childRel)) continue;
		if (e.isDirectory()) {
			await walkLocal(rootAbs, childRel, out, exclude);
		} else if (e.isFile()) {
			out.push(childRel);
		}
	}
}

// --- push diff ---------------------------------------------------------------

export async function computePushDiff(
	projectId: string,
): Promise<{ entries: PushDiffEntry[]; scanned: number; error?: string }> {
	let cfg: ResolvedRemoteConfig | null;
	try {
		cfg = await resolveRemoteConfig(projectId);
	} catch (e) {
		return { entries: [], scanned: 0, error: e instanceof Error ? e.message : String(e) };
	}
	if (!cfg) return { entries: [], scanned: 0, error: "No connection configured." };
	const workspacePath = await getWorkspacePath(projectId);
	if (!workspacePath) return { entries: [], scanned: 0, error: "Project workspace path not found." };

	const manifest = await getManifest(projectId);
	const manifestByRemote = new Map(manifest.map((m) => [m.remotePath, m]));
	const exclude = makeExcluder(cfg.excludePatterns);

	// Collect the set of local files currently under the selected paths (base-relative).
	const localRelSet = new Set<string>();
	const localRoot = join(workspacePath, ...cfg.localSubdir.split("/").filter(Boolean));
	for (const sel of cfg.selections) {
		if (sel.type === "file") {
			if (isSafeRel(sel.path)) localRelSet.add(sel.path); // explicit file selection — never excluded
		} else {
			const found: string[] = [];
			await walkLocal(localRoot, sel.path, found, exclude);
			found.forEach((f) => localRelSet.add(f));
		}
	}

	const entries: PushDiffEntry[] = [];

	// New + modified (present locally).
	for (const rel of localRelSet) {
		let size: number;
		let sha: string;
		try {
			const localAbs = toLocalAbs(workspacePath, cfg.localSubdir, rel);
			const stat = await fsp.stat(localAbs);
			size = stat.size;
			sha = await hashFile(localAbs);
		} catch {
			continue; // vanished between walk and stat
		}
		const known = manifestByRemote.get(rel);
		if (!known) {
			entries.push({ remotePath: rel, localPath: toLocalRel(cfg.localSubdir, rel), status: "new", size, remoteChanged: null });
		} else if (known.sha256 !== sha) {
			entries.push({ remotePath: rel, localPath: toLocalRel(cfg.localSubdir, rel), status: "modified", size, remoteChanged: null });
		}
	}

	// Deleted (in manifest but no longer present locally) — reported, never auto-deleted remotely.
	for (const m of manifest) {
		if (exclude(m.remotePath)) continue; // now excluded — not a "deletion"
		if (!isSafeRel(m.remotePath)) continue; // defensive: never act on an unsafe stored path
		if (!localRelSet.has(m.remotePath)) {
			let exists = true;
			try {
				await fsp.access(toLocalAbs(workspacePath, cfg.localSubdir, m.remotePath));
			} catch {
				exists = false;
			}
			if (!exists) {
				entries.push({ remotePath: m.remotePath, localPath: m.localPath, status: "deleted", size: 0, remoteChanged: false });
			}
		}
	}

	// Conflict check — re-stat each upload candidate on the server and flag any whose
	// remote copy changed since our last sync (or, for "new" files, already exists). Best
	// effort: if the server is unreachable we leave remoteChanged = null (unknown).
	const resolved = cfg;
	const uploadable = entries.filter((e) => e.status !== "deleted");
	if (uploadable.length > 0) {
		const client = createRemoteClient(resolved.creds);
		try {
			await client.connect();
			await pinHostKeyIfNew(projectId, client, resolved);

			// Standard practice (rsync/FileZilla): fetch remote metadata with ONE listing
			// per directory, not one stat per file. Group candidates by remote parent dir.
			const byDir = new Map<string, PushDiffEntry[]>();
			for (const entry of uploadable) {
				const dir = posixDirname(posixJoin(resolved.remoteBasePath, entry.remotePath));
				const arr = byDir.get(dir);
				if (arr) arr.push(entry);
				else byDir.set(dir, [entry]);
			}

			for (const [dir, group] of byDir) {
				const listing = new Map<string, { size: number; modifiedAt: number | null }>();
				let listed = true;
				try {
					for (const r of await client.list(dir)) {
						listing.set(r.name, { size: r.size, modifiedAt: r.modifiedAt });
					}
				} catch {
					listed = false; // dir missing/unreadable — can't verify this group
				}
				for (const entry of group) {
					if (!listed) {
						entry.remoteChanged = null; // unknown (don't false-alarm or false-assure)
						continue;
					}
					const base = entry.remotePath.split("/").pop() || "";
					const st = listing.get(base) ?? null;
					if (entry.status === "new") {
						entry.remoteChanged = st !== null; // a "new" local file that already exists remotely
					} else {
						const known = manifestByRemote.get(entry.remotePath);
						if (!st || !known) {
							entry.remoteChanged = false; // gone remotely, or no baseline — nothing to clobber
						} else {
							const sizeDiff = st.size !== known.size;
							const mtimeDiff =
								known.remoteMtime != null && st.modifiedAt != null &&
								Math.abs(st.modifiedAt - known.remoteMtime) > 2000; // 2s tolerance (FTP granularity)
							entry.remoteChanged = sizeDiff || mtimeDiff;
						}
					}
				}
			}
		} catch {
			// Connection failed — leave all remoteChanged = null (unknown).
		} finally {
			await client.disconnect();
		}
	}

	entries.sort((a, b) => a.remotePath.localeCompare(b.remotePath));
	return { entries, scanned: localRelSet.size };
}

// --- per-file diff (push preview) -------------------------------------------

const MAX_DIFF_BYTES = 512 * 1024;

function looksBinary(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8192);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
}

export interface PushFileDiff {
	local: string;
	remote: string;
	remoteExists: boolean;
	binary: boolean;
	tooLarge: boolean;
	error?: string;
}

/** Fetch local + current-server content for one file so the UI can show a diff. */
export async function getPushFileDiff(projectId: string, remotePath: string): Promise<PushFileDiff> {
	const empty: PushFileDiff = { local: "", remote: "", remoteExists: false, binary: false, tooLarge: false };
	let cfg: ResolvedRemoteConfig | null;
	try {
		cfg = await resolveRemoteConfig(projectId);
	} catch (e) {
		return { ...empty, error: e instanceof Error ? e.message : String(e) };
	}
	if (!cfg) return { ...empty, error: "No connection configured." };
	if (!isSafeRel(remotePath)) return { ...empty, error: "Invalid path." };
	const workspacePath = await getWorkspacePath(projectId);
	if (!workspacePath) return { ...empty, error: "Project workspace path not found." };

	let localBuf: Buffer;
	try {
		localBuf = await fsp.readFile(toLocalAbs(workspacePath, cfg.localSubdir, remotePath));
	} catch {
		return { ...empty, error: "Local file not found." };
	}

	const client = createRemoteClient(cfg.creds);
	let remoteBuf: Buffer | null;
	try {
		await client.connect();
		try {
			remoteBuf = await client.readFile(posixJoin(cfg.remoteBasePath, remotePath));
		} catch {
			remoteBuf = null; // not present on the server (a new file)
		}
	} catch (e) {
		return { ...empty, error: e instanceof Error ? e.message : String(e) };
	} finally {
		await client.disconnect();
	}

	const binary = looksBinary(localBuf) || (remoteBuf != null && looksBinary(remoteBuf));
	const tooLarge = localBuf.length > MAX_DIFF_BYTES || (remoteBuf?.length ?? 0) > MAX_DIFF_BYTES;
	if (binary || tooLarge) {
		return { local: "", remote: "", remoteExists: remoteBuf != null, binary, tooLarge };
	}
	return {
		local: localBuf.toString("utf8"),
		remote: remoteBuf ? remoteBuf.toString("utf8") : "",
		remoteExists: remoteBuf != null,
		binary: false,
		tooLarge: false,
	};
}

// --- push --------------------------------------------------------------------

export async function push(
	projectId: string,
	remotePaths: string[],
): Promise<{ ok: boolean; runId?: string; error?: string }> {
	if (active.has(projectId)) return { ok: false, error: "A sync is already running for this project." };

	let cfg: ResolvedRemoteConfig | null;
	try {
		cfg = await resolveRemoteConfig(projectId);
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	if (!cfg) return { ok: false, error: "No connection configured." };
	const workspacePath = await getWorkspacePath(projectId);
	if (!workspacePath) return { ok: false, error: "Project workspace path not found." };

	// Only upload files that still exist locally (never the "deleted" entries).
	const candidates: string[] = [];
	for (const rel of remotePaths) {
		try {
			const stat = await fsp.stat(toLocalAbs(workspacePath, cfg.localSubdir, rel));
			if (stat.isFile()) candidates.push(rel);
		} catch {
			/* skip missing or unsafe */
		}
	}
	if (!candidates.length) return { ok: false, error: "No uploadable files in the selection." };

	const ac = new AbortController();
	active.set(projectId, ac);
	const runId = await createRun(projectId, "push", candidates.length);

	void runPush(projectId, runId, cfg, workspacePath, candidates, ac.signal)
		.catch((e) => log(projectId, "error", `Push crashed: ${e instanceof Error ? e.message : String(e)}`))
		.finally(() => active.delete(projectId));

	return { ok: true, runId };
}

async function runPush(
	projectId: string,
	runId: string,
	cfg: ResolvedRemoteConfig,
	workspacePath: string,
	files: string[],
	signal: AbortSignal,
): Promise<void> {
	const client = createRemoteClient(cfg.creds);
	let ok = 0;
	let failed = 0;
	let bytes = 0;
	try {
		await client.connect();
		await pinHostKeyIfNew(projectId, client, cfg);
		broadcastToWebview("remoteSyncRunStarted", { projectId, runId, direction: "push", totalFiles: files.length });
		log(projectId, "info", `Connected to ${cfg.creds.host}. Uploading ${files.length} file(s)…`);

		for (let i = 0; i < files.length; i++) {
			if (signal.aborted) throw new CancelledError();
			const rel = files[i];
			broadcastToWebview("remoteSyncProgress", {
				projectId, runId, direction: "push", file: rel, status: "start", index: i + 1, total: files.length,
			});
			try {
				const localAbs = toLocalAbs(workspacePath, cfg.localSubdir, rel);
				const remoteAbs = posixJoin(cfg.remoteBasePath, rel);
				await client.ensureRemoteDir(posixDirname(remoteAbs));
				await client.uploadFile(localAbs, remoteAbs);
				const sha = await hashFile(localAbs);
				const stat = await fsp.stat(localAbs);
				await upsertManifestItem({
					projectId,
					remotePath: rel,
					localPath: toLocalRel(cfg.localSubdir, rel),
					size: stat.size,
					remoteMtime: null,
					sha256: sha,
				});
				ok++;
				bytes += stat.size;
				broadcastToWebview("remoteSyncProgress", {
					projectId, runId, direction: "push", file: rel, status: "ok", index: i + 1, total: files.length,
				});
			} catch (e) {
				failed++;
				const msg = e instanceof Error ? e.message : String(e);
				broadcastToWebview("remoteSyncProgress", {
					projectId, runId, direction: "push", file: rel, status: "error", index: i + 1, total: files.length, error: msg,
				});
				log(projectId, "error", `Failed to upload ${rel}: ${msg}`);
			}
			await updateRun(runId, { okFiles: ok, failedFiles: failed, bytes });
		}

		const now = new Date().toISOString();
		await setLastPushed(projectId, now);
		const status = failed === 0 ? "success" : ok === 0 ? "error" : "partial";
		const summary = `Uploaded ${ok}/${files.length} file(s)${failed ? `, ${failed} failed` : ""}.`;
		await updateRun(runId, { status, summary, okFiles: ok, failedFiles: failed, bytes, finishedAt: now });
		broadcastToWebview("remoteSyncRunComplete", {
			projectId, runId, direction: "push", status, okFiles: ok, failedFiles: failed, bytes, summary,
		});
		log(projectId, failed ? "warn" : "info", summary);
	} catch (e) {
		const cancelled = e instanceof CancelledError;
		const now = new Date().toISOString();
		const msg = cancelled
			? "Cancelled by user."
			: hostKeyMismatchMessage(client, cfg) ?? (e instanceof Error ? e.message : String(e));
		await updateRun(runId, {
			status: cancelled ? "cancelled" : "error",
			error: msg,
			okFiles: ok, failedFiles: failed, bytes,
			finishedAt: now,
		});
		broadcastToWebview("remoteSyncRunError", { projectId, runId, error: msg });
		log(projectId, "error", `Push ${cancelled ? "cancelled" : "failed"}: ${msg}`);
	} finally {
		await client.disconnect();
	}
}
