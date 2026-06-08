// ---------------------------------------------------------------------------
// Auto-Earn — credential vault (client-provided access)
//
// Stores client-provided credentials (FTP/SFTP/git tokens/CMS logins) encrypted
// at rest using the shared AES-256-GCM secret-crypto (same master key as Remote
// Sync). Secrets are NEVER returned in lists/logs; only resolved on demand by the
// FX tools that need them. Scoped per job.
// ---------------------------------------------------------------------------

import { sqlite } from "../../db/connection";
import { encryptSecret, decryptSecret } from "../../lib/secret-crypto";

export type CredentialKind = "ftp" | "sftp" | "git" | "cms" | "other";

export interface StoreCredentialInput {
	jobId: string;
	kind: CredentialKind;
	label?: string;
	host?: string;
	port?: number;
	username?: string;
	secret?: string; // password/token/private-key — encrypted before storage
	meta?: Record<string, unknown>;
}

export interface ResolvedCredential {
	id: string;
	jobId: string;
	kind: CredentialKind;
	label: string | null;
	host: string | null;
	port: number | null;
	username: string | null;
	secret: string; // decrypted — handle carefully, never log
	meta: Record<string, unknown> | null;
}

/** Redacted view for listing/UI/audit — no secret. */
export interface CredentialSummary {
	id: string;
	jobId: string;
	kind: CredentialKind;
	label: string | null;
	host: string | null;
	port: number | null;
	username: string | null;
	hasSecret: boolean;
	meta: Record<string, unknown> | null;
}

export function storeCredential(input: StoreCredentialInput): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	sqlite
		.prepare(
			`INSERT INTO freelance_credentials (id, job_id, kind, label, host, port, username, secret_enc, meta, created_at, updated_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			id,
			input.jobId,
			input.kind,
			input.label ?? null,
			input.host ?? null,
			input.port ?? null,
			input.username ?? null,
			input.secret ? encryptSecret(input.secret) : "",
			input.meta ? JSON.stringify(input.meta) : null,
			now,
			now,
		);
	return id;
}

function parseMeta(raw: string | null): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function getCredential(id: string): ResolvedCredential | null {
	const r = sqlite.prepare(`SELECT * FROM freelance_credentials WHERE id = ?`).get(id) as
		| Record<string, unknown>
		| undefined;
	if (!r) return null;
	return {
		id: String(r.id),
		jobId: String(r.job_id),
		kind: String(r.kind) as CredentialKind,
		label: (r.label as string | null) ?? null,
		host: (r.host as string | null) ?? null,
		port: (r.port as number | null) ?? null,
		username: (r.username as string | null) ?? null,
		secret: decryptSecret((r.secret_enc as string | null) ?? ""),
		meta: parseMeta((r.meta as string | null) ?? null),
	};
}

export function getCredentialsForJob(jobId: string): ResolvedCredential[] {
	const rows = sqlite
		.prepare(`SELECT * FROM freelance_credentials WHERE job_id = ? ORDER BY created_at ASC`)
		.all(jobId) as Array<Record<string, unknown>>;
	return rows.map((r) => ({
		id: String(r.id),
		jobId: String(r.job_id),
		kind: String(r.kind) as CredentialKind,
		label: (r.label as string | null) ?? null,
		host: (r.host as string | null) ?? null,
		port: (r.port as number | null) ?? null,
		username: (r.username as string | null) ?? null,
		secret: decryptSecret((r.secret_enc as string | null) ?? ""),
		meta: parseMeta((r.meta as string | null) ?? null),
	}));
}

/** Redacted listing (safe for UI/audit/agent context). */
export function listCredentialSummaries(jobId: string): CredentialSummary[] {
	const rows = sqlite
		.prepare(
			`SELECT id, job_id, kind, label, host, port, username, secret_enc, meta FROM freelance_credentials WHERE job_id = ? ORDER BY created_at ASC`,
		)
		.all(jobId) as Array<Record<string, unknown>>;
	return rows.map((r) => ({
		id: String(r.id),
		jobId: String(r.job_id),
		kind: String(r.kind) as CredentialKind,
		label: (r.label as string | null) ?? null,
		host: (r.host as string | null) ?? null,
		port: (r.port as number | null) ?? null,
		username: (r.username as string | null) ?? null,
		hasSecret: !!(r.secret_enc as string | null),
		meta: parseMeta((r.meta as string | null) ?? null),
	}));
}
