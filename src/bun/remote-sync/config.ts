// ---------------------------------------------------------------------------
// Remote Sync — persistence layer (config + manifest + run history)
// Shared by the RPC handlers and the engine.
// ---------------------------------------------------------------------------

import { db } from "../db";
import { remoteSyncConfig, remoteSyncItems, remoteSyncRuns } from "../db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "./crypto";
import type { RemoteCredentials } from "./client";
import type {
	RemoteSyncConfigDto,
	RemoteSyncConfigInput,
	RemoteSelection,
	RemoteSyncRunDto,
} from "../../shared/rpc/remote-sync";

type ConfigRow = typeof remoteSyncConfig.$inferSelect;

function parseStringArray(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}

/** Trim, drop empties, de-dupe exclude patterns (order preserved). */
function sanitizeExcludes(list: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of list ?? []) {
		const p = String(raw).trim();
		if (p && !seen.has(p)) {
			seen.add(p);
			out.push(p);
		}
	}
	return out;
}

function parseSelections(raw: string | null | undefined): RemoteSelection[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		if (!Array.isArray(v)) return [];
		return v
			.filter((e) => e && typeof e.path === "string" && (e.type === "dir" || e.type === "file"))
			.map((e) => ({ path: String(e.path), type: e.type as "dir" | "file" }));
	} catch {
		return [];
	}
}

/** Map a DB row to the frontend DTO — secrets reduced to presence booleans. */
function mapConfig(row: ConfigRow): RemoteSyncConfigDto {
	return {
		projectId: row.projectId,
		enabled: row.enabled === 1,
		protocol: (row.protocol as RemoteSyncConfigDto["protocol"]) ?? "sftp",
		host: row.host ?? "",
		port: row.port ?? 22,
		username: row.username ?? "",
		authType: (row.authType as RemoteSyncConfigDto["authType"]) ?? "password",
		hasPassword: !!row.passwordEnc,
		hasPrivateKey: !!row.privateKeyEnc,
		hasPassphrase: !!row.passphraseEnc,
		remoteBasePath: row.remoteBasePath ?? "/",
		localSubdir: row.localSubdir ?? "",
		selections: parseSelections(row.selections),
		rejectUnauthorized: row.rejectUnauthorized === 1,
		hostKeyFingerprint: row.hostKeyFingerprint ?? null,
		excludePatterns: parseStringArray(row.excludePatterns),
		lastPulledAt: row.lastPulledAt ?? null,
		lastPushedAt: row.lastPushedAt ?? null,
	};
}

async function getRow(projectId: string): Promise<ConfigRow | null> {
	const rows = await db.select().from(remoteSyncConfig).where(eq(remoteSyncConfig.projectId, projectId)).limit(1);
	return rows[0] ?? null;
}

export async function getRemoteSyncConfig(projectId: string): Promise<RemoteSyncConfigDto | null> {
	const row = await getRow(projectId);
	return row ? mapConfig(row) : null;
}

/** Default port for a protocol when the user hasn't set one. */
function defaultPort(protocol: string): number {
	return protocol === "sftp" ? 22 : 21;
}

export async function saveRemoteSyncConfig(
	projectId: string,
	input: RemoteSyncConfigInput,
): Promise<RemoteSyncConfigDto> {
	const now = new Date().toISOString();
	const existing = await getRow(projectId);

	const protocol = input.protocol ?? existing?.protocol ?? "sftp";

	// Secret handling: undefined → keep; "" or null → clear; string → (re)encrypt.
	const resolveSecret = (incoming: string | null | undefined, current: string): string => {
		if (incoming === undefined) return current;
		if (!incoming) return "";
		return encryptSecret(incoming);
	};

	const values = {
		enabled: (input.enabled ?? existing?.enabled === 1) ? 1 : 0,
		protocol,
		host: (input.host ?? existing?.host ?? "").trim(),
		port: input.port ?? existing?.port ?? defaultPort(protocol),
		username: (input.username ?? existing?.username ?? "").trim(),
		authType: input.authType ?? existing?.authType ?? "password",
		passwordEnc: resolveSecret(input.password, existing?.passwordEnc ?? ""),
		privateKeyEnc: resolveSecret(input.privateKey, existing?.privateKeyEnc ?? ""),
		passphraseEnc: resolveSecret(input.passphrase, existing?.passphraseEnc ?? ""),
		remoteBasePath: (input.remoteBasePath ?? existing?.remoteBasePath ?? "/").trim() || "/",
		localSubdir: (input.localSubdir ?? existing?.localSubdir ?? "").trim(),
		selections: JSON.stringify(input.selections ?? parseSelections(existing?.selections)),
		rejectUnauthorized: (input.rejectUnauthorized ?? existing?.rejectUnauthorized === 1) ? 1 : 0,
		// undefined = keep; null/"" = forget the pinned key.
		hostKeyFingerprint:
			input.hostKeyFingerprint !== undefined
				? input.hostKeyFingerprint || null
				: existing?.hostKeyFingerprint ?? null,
		excludePatterns: JSON.stringify(
			sanitizeExcludes(input.excludePatterns ?? parseStringArray(existing?.excludePatterns)),
		),
		updatedAt: now,
	};

	if (existing) {
		await db.update(remoteSyncConfig).set(values).where(eq(remoteSyncConfig.projectId, projectId));
	} else {
		await db.insert(remoteSyncConfig).values({ projectId, ...values, createdAt: now });
	}
	const row = await getRow(projectId);
	if (!row) throw new Error("Failed to persist remote sync config.");
	return mapConfig(row);
}

export async function setLastPulled(projectId: string, ts: string): Promise<void> {
	await db.update(remoteSyncConfig).set({ lastPulledAt: ts }).where(eq(remoteSyncConfig.projectId, projectId));
}

export async function setLastPushed(projectId: string, ts: string): Promise<void> {
	await db.update(remoteSyncConfig).set({ lastPushedAt: ts }).where(eq(remoteSyncConfig.projectId, projectId));
}

/** Persist a trust-on-first-use SFTP host-key fingerprint. */
export async function setHostKeyFingerprint(projectId: string, fingerprint: string): Promise<void> {
	await db
		.update(remoteSyncConfig)
		.set({ hostKeyFingerprint: fingerprint })
		.where(eq(remoteSyncConfig.projectId, projectId));
}

/** Full internal config + decrypted credentials, for the engine. Null if unconfigured. */
export interface ResolvedRemoteConfig {
	creds: RemoteCredentials;
	remoteBasePath: string;
	localSubdir: string;
	selections: RemoteSelection[];
	excludePatterns: string[];
	/** Whether a host key was already pinned (so the engine knows to persist a fresh one). */
	hadHostKey: boolean;
}

export async function resolveRemoteConfig(projectId: string): Promise<ResolvedRemoteConfig | null> {
	const row = await getRow(projectId);
	if (!row) return null;
	// A decrypt failure means the master key file changed/was lost (e.g. app data
	// moved without it). Surface a clear, actionable message rather than a raw GCM error.
	const dec = (blob: string): string => {
		try {
			return decryptSecret(blob);
		} catch {
			throw new Error(
				"Saved credentials could not be decrypted — the encryption key has changed or is missing. Re-enter the connection password/key in the Connection tab.",
			);
		}
	};
	return {
		creds: {
			protocol: (row.protocol as RemoteCredentials["protocol"]) ?? "sftp",
			host: row.host ?? "",
			port: row.port ?? defaultPort(row.protocol ?? "sftp"),
			username: row.username ?? "",
			password: row.passwordEnc ? dec(row.passwordEnc) : undefined,
			privateKey: row.authType === "key" && row.privateKeyEnc ? dec(row.privateKeyEnc) : undefined,
			passphrase: row.passphraseEnc ? dec(row.passphraseEnc) : undefined,
			rejectUnauthorized: row.rejectUnauthorized === 1,
			expectedHostKeyFp: row.hostKeyFingerprint ?? null,
		},
		remoteBasePath: row.remoteBasePath ?? "/",
		localSubdir: row.localSubdir ?? "",
		selections: parseSelections(row.selections),
		excludePatterns: parseStringArray(row.excludePatterns),
		hadHostKey: !!row.hostKeyFingerprint,
	};
}

// --- manifest ---------------------------------------------------------------

export type RemoteItemRow = typeof remoteSyncItems.$inferSelect;

export async function getManifest(projectId: string): Promise<RemoteItemRow[]> {
	return db.select().from(remoteSyncItems).where(eq(remoteSyncItems.projectId, projectId));
}

export async function upsertManifestItem(item: {
	projectId: string;
	remotePath: string;
	localPath: string;
	size: number;
	remoteMtime: number | null;
	sha256: string;
}): Promise<void> {
	const now = new Date().toISOString();
	const existing = await db
		.select({ id: remoteSyncItems.id })
		.from(remoteSyncItems)
		.where(and(eq(remoteSyncItems.projectId, item.projectId), eq(remoteSyncItems.remotePath, item.remotePath)))
		.limit(1);
	if (existing[0]) {
		await db
			.update(remoteSyncItems)
			.set({
				localPath: item.localPath,
				size: item.size,
				remoteMtime: item.remoteMtime,
				sha256: item.sha256,
				lastSyncedAt: now,
			})
			.where(eq(remoteSyncItems.id, existing[0].id));
	} else {
		await db.insert(remoteSyncItems).values({ ...item, lastSyncedAt: now });
	}
}

// --- runs -------------------------------------------------------------------

type RunRow = typeof remoteSyncRuns.$inferSelect;

function mapRun(r: RunRow): RemoteSyncRunDto {
	return {
		id: r.id,
		projectId: r.projectId,
		direction: r.direction as RemoteSyncRunDto["direction"],
		status: r.status,
		totalFiles: r.totalFiles ?? 0,
		okFiles: r.okFiles ?? 0,
		failedFiles: r.failedFiles ?? 0,
		bytes: r.bytes ?? 0,
		summary: r.summary ?? null,
		error: r.error ?? null,
		startedAt: r.startedAt,
		finishedAt: r.finishedAt ?? null,
	};
}

export async function createRun(projectId: string, direction: "pull" | "push" | "test", totalFiles = 0): Promise<string> {
	const id = crypto.randomUUID();
	await db.insert(remoteSyncRuns).values({
		id,
		projectId,
		direction,
		status: "running",
		totalFiles,
		startedAt: new Date().toISOString(),
	});
	return id;
}

export async function updateRun(
	id: string,
	patch: Partial<{
		status: string;
		totalFiles: number;
		okFiles: number;
		failedFiles: number;
		bytes: number;
		summary: string | null;
		error: string | null;
		finishedAt: string | null;
	}>,
): Promise<void> {
	await db.update(remoteSyncRuns).set(patch).where(eq(remoteSyncRuns.id, id));
}

export async function listRuns(projectId: string, limit = 50): Promise<RemoteSyncRunDto[]> {
	const rows = await db
		.select()
		.from(remoteSyncRuns)
		.where(eq(remoteSyncRuns.projectId, projectId))
		.orderBy(desc(remoteSyncRuns.startedAt))
		.limit(limit);
	return rows.map(mapRun);
}

/** Mark runs left "running" by a crash/restart as failed. Called once on startup. */
export async function failInterruptedRuns(): Promise<void> {
	await db
		.update(remoteSyncRuns)
		.set({ status: "failed", error: "Interrupted by app restart", finishedAt: new Date().toISOString() })
		.where(inArray(remoteSyncRuns.status, ["running"]));
}
