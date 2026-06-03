// ---------------------------------------------------------------------------
// Remote Sync — unified remote-filesystem client
// ---------------------------------------------------------------------------
// A thin protocol-agnostic wrapper over `ssh2-sftp-client` (SFTP) and
// `basic-ftp` (FTP / FTPS). The engine and RPC layer only ever see the
// `RemoteClient` interface — they never branch on protocol.
//
// One instance holds ONE live connection: connect() once, run a batch of
// list/stat/download/upload, then disconnect(). Both underlying libraries
// validated on Bun 1.3.x (see research notes).
// ---------------------------------------------------------------------------

import { Client as FtpClient } from "basic-ftp";
import SftpClient from "ssh2-sftp-client";
import { createHash } from "crypto";
import { Writable } from "stream";

export type RemoteProtocol = "sftp" | "ftp" | "ftps";

export interface RemoteCredentials {
	protocol: RemoteProtocol;
	host: string;
	port: number;
	username: string;
	/** Used for password auth (all protocols). */
	password?: string;
	/** SFTP key auth — PEM string. */
	privateKey?: string;
	/** Optional passphrase protecting the private key. */
	passphrase?: string;
	/** FTPS only — reject invalid/self-signed TLS certificates (default false). */
	rejectUnauthorized?: boolean;
	/** SFTP only — pinned host-key fingerprint ("SHA256:…"). When set, the server's
	 *  host key must match or the connection is refused. When null, trust-on-first-use. */
	expectedHostKeyFp?: string | null;
}

export interface RemoteEntry {
	name: string;
	type: "dir" | "file" | "symlink";
	size: number;
	/** Epoch ms, or null when the server does not report it. */
	modifiedAt: number | null;
}

export interface RemoteClient {
	connect(): Promise<void>;
	/** List a single remote directory (non-recursive). */
	list(remoteDir: string): Promise<RemoteEntry[]>;
	/** Stat a single path; null if it does not exist. */
	stat(remotePath: string): Promise<RemoteEntry | null>;
	downloadFile(remotePath: string, localPath: string): Promise<void>;
	/** Read a remote file fully into memory (for previews/diffs). */
	readFile(remotePath: string): Promise<Buffer>;
	uploadFile(localPath: string, remotePath: string): Promise<void>;
	/** Recursively create a remote directory (no-op if it already exists). */
	ensureRemoteDir(remoteDir: string): Promise<void>;
	disconnect(): Promise<void>;
	/** SFTP only — the server host-key fingerprint observed during connect ("SHA256:…"),
	 *  or null (FTP/FTPS, or before connecting). */
	getHostKeyFingerprint?(): string | null;
}

const CONNECT_TIMEOUT_MS = 20_000;

// --- POSIX path helpers (remote paths are always POSIX) ---------------------

export function posixJoin(...parts: string[]): string {
	const joined = parts
		.filter((p) => p !== "")
		.join("/")
		.replace(/\/{2,}/g, "/");
	return joined === "" ? "/" : joined;
}

export function posixDirname(p: string): string {
	const norm = p.replace(/\/+$/, "");
	const idx = norm.lastIndexOf("/");
	if (idx <= 0) return "/";
	return norm.slice(0, idx);
}

// --- SFTP implementation ----------------------------------------------------

class SftpRemoteClient implements RemoteClient {
	private sftp = new SftpClient();
	private capturedFp: string | null = null;
	constructor(private readonly creds: RemoteCredentials) {}

	getHostKeyFingerprint(): string | null {
		return this.capturedFp;
	}

	async connect(): Promise<void> {
		await this.sftp.connect({
			host: this.creds.host,
			port: this.creds.port,
			username: this.creds.username,
			...(this.creds.privateKey
				? { privateKey: this.creds.privateKey, passphrase: this.creds.passphrase || undefined }
				: { password: this.creds.password }),
			// Capture the server host key and (when pinned) verify it — guards against MITM.
			hostVerifier: (key: Buffer) => {
				this.capturedFp = "SHA256:" + createHash("sha256").update(key).digest("base64");
				if (this.creds.expectedHostKeyFp) return this.capturedFp === this.creds.expectedHostKeyFp;
				return true; // trust-on-first-use
			},
			readyTimeout: CONNECT_TIMEOUT_MS,
			retries: 1,
		});
	}

	async list(remoteDir: string): Promise<RemoteEntry[]> {
		const rows = await this.sftp.list(remoteDir);
		return rows.map((r) => ({
			name: r.name,
			type: r.type === "d" ? "dir" : r.type === "l" ? "symlink" : "file",
			size: r.size,
			modifiedAt: typeof r.modifyTime === "number" ? r.modifyTime : null,
		}));
	}

	async stat(remotePath: string): Promise<RemoteEntry | null> {
		try {
			const s = await this.sftp.stat(remotePath);
			const name = remotePath.replace(/\/+$/, "").split("/").pop() || remotePath;
			return {
				name,
				type: s.isDirectory ? "dir" : s.isSymbolicLink ? "symlink" : "file",
				size: s.size,
				modifiedAt: typeof s.modifyTime === "number" ? s.modifyTime : null,
			};
		} catch {
			return null;
		}
	}

	async downloadFile(remotePath: string, localPath: string): Promise<void> {
		await this.sftp.fastGet(remotePath, localPath);
	}

	async readFile(remotePath: string): Promise<Buffer> {
		const out = await this.sftp.get(remotePath);
		return Buffer.isBuffer(out) ? out : Buffer.from(out as string);
	}

	async uploadFile(localPath: string, remotePath: string): Promise<void> {
		await this.sftp.fastPut(localPath, remotePath);
	}

	async ensureRemoteDir(remoteDir: string): Promise<void> {
		if (!remoteDir || remoteDir === "/" || remoteDir === ".") return;
		const exists = await this.sftp.exists(remoteDir);
		if (exists === "d") return;
		await this.sftp.mkdir(remoteDir, true);
	}

	async disconnect(): Promise<void> {
		try {
			await this.sftp.end();
		} catch {
			/* already closed */
		}
	}
}

// --- FTP / FTPS implementation ----------------------------------------------

class FtpRemoteClient implements RemoteClient {
	private client = new FtpClient(CONNECT_TIMEOUT_MS);
	private homeCwd = "/";
	/** Item count the server reports after a directory transfer (PureFTPd's
	 *  "226 N matches total"), or null if the server doesn't report it. Lets us tell a
	 *  FAILED data transfer (reported > 0 but parsed 0) apart from a genuinely empty dir. */
	private lastMatches: number | null = null;

	constructor(private readonly creds: RemoteCredentials, private readonly secure: boolean) {
		// Sniff the server's transfer-complete message for the reported match count.
		this.client.ftp.log = (msg: string) => {
			const m = /(\d+)\s+matches total/.exec(String(msg));
			if (m) this.lastMatches = parseInt(m[1], 10);
		};
	}

	async connect(): Promise<void> {
		await this.client.access({
			host: this.creds.host,
			port: this.creds.port,
			user: this.creds.username,
			password: this.creds.password,
			secure: this.secure,
			// FTPS: by default tolerate self-signed certs (common on internal servers) —
			// the channel is still encrypted. Users can opt into strict verification.
			secureOptions: this.secure ? { rejectUnauthorized: !!this.creds.rejectUnauthorized } : undefined,
		});
		try {
			this.homeCwd = await this.client.pwd();
		} catch {
			this.homeCwd = "/";
		}
	}

	async list(remoteDir: string): Promise<RemoteEntry[]> {
		// CWD into the directory, THEN list — like FileZilla/WinSCP. Many servers ignore
		// the path argument to MLSD/LIST and return the working directory (or nothing),
		// so `client.list("/path")` can come back empty even when the folder has files.
		const once = async () => {
			this.lastMatches = null;
			if (remoteDir && remoteDir !== ".") await this.client.cd(remoteDir);
			return await this.client.list();
		};

		let rows = await once();
		// Detect a FAILED data transfer: the server reported items (matches > 2, i.e. more
		// than just "." and "..") but we parsed nothing — common on plain-FTP servers whose
		// unencrypted data channel is mangled by a firewall/ALG. Retry once (the engine adds
		// a further fresh-connection retry on top of this, so keep it gentle).
		const transferFailed = () => rows.length === 0 && this.lastMatches != null && this.lastMatches > 2;
		if (transferFailed()) {
			await new Promise((r) => setTimeout(r, 800));
			rows = await once();
		}
		if (transferFailed()) {
			const reported = Math.max(0, (this.lastMatches ?? 2) - 2);
			throw new Error(
				`The server reported ${reported} item(s) in "${remoteDir || "/"}" but the data transfer ` +
					`returned nothing — plain-FTP data connections are likely being blocked here. ` +
					`Switch the Protocol to FTPS (this server supports it) for a reliable connection.`,
			);
		}

		return rows.map((r) => ({
			name: r.name,
			type: r.isDirectory ? "dir" : r.isSymbolicLink ? "symlink" : "file",
			size: r.size,
			modifiedAt: r.modifiedAt instanceof Date ? r.modifiedAt.getTime() : null,
		}));
	}

	async stat(remotePath: string): Promise<RemoteEntry | null> {
		// FTP has no portable stat; derive it from the parent directory listing.
		const dir = posixDirname(remotePath);
		const base = remotePath.replace(/\/+$/, "").split("/").pop();
		try {
			const hit = (await this.list(dir)).find((r) => r.name === base);
			return hit ?? null;
		} catch {
			return null;
		}
	}

	async downloadFile(remotePath: string, localPath: string): Promise<void> {
		await this.client.downloadTo(localPath, remotePath);
	}

	async readFile(remotePath: string): Promise<Buffer> {
		const chunks: Buffer[] = [];
		const sink = new Writable({
			write(chunk, _enc, cb) {
				chunks.push(Buffer.from(chunk));
				cb();
			},
		});
		await this.client.downloadTo(sink, remotePath);
		return Buffer.concat(chunks);
	}

	async uploadFile(localPath: string, remotePath: string): Promise<void> {
		await this.client.uploadFrom(localPath, remotePath);
	}

	async ensureRemoteDir(remoteDir: string): Promise<void> {
		if (!remoteDir || remoteDir === "/" || remoteDir === ".") return;
		// ensureDir creates the whole path AND changes the working directory into it;
		// restore the login directory afterwards so subsequent absolute paths resolve.
		await this.client.ensureDir(remoteDir);
		try {
			await this.client.cd(this.homeCwd);
		} catch {
			/* best effort */
		}
	}

	async disconnect(): Promise<void> {
		try {
			this.client.close();
		} catch {
			/* already closed */
		}
	}
}

/** Build a RemoteClient for the given credentials. Does not connect yet. */
export function createRemoteClient(creds: RemoteCredentials): RemoteClient {
	if (creds.protocol === "sftp") return new SftpRemoteClient(creds);
	return new FtpRemoteClient(creds, creds.protocol === "ftps");
}
