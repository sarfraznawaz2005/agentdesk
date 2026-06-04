// RPC contract for the Remote Sync feature (per-project SFTP/FTP file sync).

export type RemoteProtocol = "sftp" | "ftp" | "ftps";
export type RemoteAuthType = "password" | "key";

export interface RemoteSelection {
	/** Path relative to remoteBasePath (POSIX). */
	path: string;
	type: "dir" | "file";
}

export interface RemoteSyncConfigDto {
	projectId: string;
	enabled: boolean;
	protocol: RemoteProtocol;
	host: string;
	port: number;
	username: string;
	authType: RemoteAuthType;
	// Secrets are NEVER sent to the frontend in cleartext — only presence flags.
	hasPassword: boolean;
	hasPrivateKey: boolean;
	hasPassphrase: boolean;
	remoteBasePath: string;
	localSubdir: string;
	selections: RemoteSelection[];
	/** FTPS only — reject invalid/self-signed TLS certificates. */
	rejectUnauthorized: boolean;
	/** SFTP only — pinned server host-key fingerprint ("SHA256:…"), or null if not yet trusted. */
	hostKeyFingerprint: string | null;
	/** Glob patterns excluded from pull + push (e.g. "node_modules", "*.log"). */
	excludePatterns: string[];
	lastPulledAt: string | null;
	lastPushedAt: string | null;
}

/**
 * Save payload. For secret fields: `undefined` = keep the existing value,
 * `null` or "" = clear it, a string = set it (will be encrypted at rest).
 */
export interface RemoteSyncConfigInput {
	enabled?: boolean;
	protocol?: RemoteProtocol;
	host?: string;
	port?: number;
	username?: string;
	authType?: RemoteAuthType;
	password?: string | null;
	privateKey?: string | null;
	passphrase?: string | null;
	remoteBasePath?: string;
	localSubdir?: string;
	selections?: RemoteSelection[];
	rejectUnauthorized?: boolean;
	excludePatterns?: string[];
	/** Set to null/"" to forget a pinned SFTP host key (re-trusted on next connect). */
	hostKeyFingerprint?: string | null;
}

export interface RemoteEntryDto {
	name: string;
	type: "dir" | "file" | "symlink";
	size: number;
	modifiedAt: number | null;
}

export type PushChangeStatus = "new" | "modified" | "deleted";

export interface PushDiffEntry {
	remotePath: string;
	localPath: string;
	status: PushChangeStatus;
	/** Local file size (bytes); 0 for deletions. */
	size: number;
	/**
	 * The server copy changed since our last sync (different size/mtime than recorded),
	 * or — for a "new" file — already exists on the server. Uploading would overwrite
	 * those remote changes. Null when the remote could not be checked (offline).
	 */
	remoteChanged: boolean | null;
}

export interface PullConflictEntry {
	remotePath: string;
	localPath: string;
	/** Local file size (bytes). */
	size: number;
}

export interface RemoteSyncRunDto {
	id: string;
	projectId: string;
	direction: "pull" | "push" | "test";
	status: string;
	totalFiles: number;
	okFiles: number;
	failedFiles: number;
	bytes: number;
	summary: string | null;
	error: string | null;
	startedAt: string;
	finishedAt: string | null;
}

export type RemoteSyncRequests = {
	getRemoteSyncConfig: {
		params: { projectId: string };
		response: { config: RemoteSyncConfigDto | null };
	};
	saveRemoteSyncConfig: {
		params: { projectId: string; input: RemoteSyncConfigInput };
		response: { config: RemoteSyncConfigDto };
	};
	/** Decrypt and return the saved secrets so the user can view/edit them (on explicit
	 *  reveal — e.g. clicking the eye icon). Empty strings when none are stored. */
	revealRemoteSyncSecret: {
		params: { projectId: string };
		response: { password: string; passphrase: string };
	};
	/** Connect using the SAVED config and confirm the base path is reachable. */
	testRemoteConnection: {
		params: { projectId: string };
		response: { ok: boolean; message?: string; error?: string };
	};
	/** List a single remote directory (lazy tree expansion). `remoteDir` is absolute. */
	browseRemoteDir: {
		params: { projectId: string; remoteDir: string };
		response: { entries: RemoteEntryDto[]; error?: string };
	};
	/**
	 * Preflight for Pull: list selected files whose local copy has un-pushed edits
	 * (local content differs from the last-synced manifest) and would be overwritten.
	 * Empty `conflicts` ⇒ safe to pull without prompting.
	 */
	computeRemotePullConflicts: {
		params: { projectId: string };
		response: { conflicts: PullConflictEntry[]; error?: string };
	};
	/** Download all selected files/folders into the workspace (async; streams progress). */
	startRemotePull: {
		params: { projectId: string };
		response: { ok: boolean; runId?: string; error?: string };
	};
	/** Compute which tracked/local files would be uploaded (new/modified/deleted). */
	computeRemotePushDiff: {
		params: { projectId: string };
		/** `scanned` = number of local files examined (0 ⇒ nothing selected / no local files). */
		response: { entries: PushDiffEntry[]; scanned: number; error?: string };
	};
	/** Local + current-server content for one file, for a side-by-side/diff preview. */
	getRemotePushFileDiff: {
		params: { projectId: string; remotePath: string };
		response: {
			local: string;
			remote: string;
			remoteExists: boolean;
			binary: boolean;
			tooLarge: boolean;
			error?: string;
		};
	};
	/** Upload the given remote paths back to the server (async; streams progress). */
	startRemotePush: {
		params: { projectId: string; remotePaths: string[] };
		response: { ok: boolean; runId?: string; error?: string };
	};
	listRemoteSyncRuns: {
		params: { projectId: string; limit?: number };
		response: { runs: RemoteSyncRunDto[] };
	};
	/** Abort the in-flight pull/push for this project. */
	cancelRemoteSync: {
		params: { projectId: string };
		response: { ok: boolean };
	};
};
