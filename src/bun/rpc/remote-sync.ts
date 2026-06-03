// RPC handlers for the Remote Sync feature.

import {
	getRemoteSyncConfig as dbGetConfig,
	saveRemoteSyncConfig as dbSaveConfig,
	resolveRemoteConfig,
	listRuns,
} from "../remote-sync/config";
import {
	testConnection as engineTest,
	browseRemoteDir as engineBrowse,
	pull as enginePull,
	computePushDiff as engineDiff,
	getPushFileDiff as engineFileDiff,
	push as enginePush,
	cancel as engineCancel,
	evictBrowseCache,
} from "../remote-sync/engine";
import type {
	RemoteSyncConfigDto,
	RemoteSyncConfigInput,
	RemoteSyncRunDto,
	RemoteEntryDto,
	PushDiffEntry,
} from "../../shared/rpc/remote-sync";

export async function getRemoteSyncConfig(params: { projectId: string }): Promise<{ config: RemoteSyncConfigDto | null }> {
	return { config: await dbGetConfig(params.projectId) };
}

export async function saveRemoteSyncConfig(params: {
	projectId: string;
	input: RemoteSyncConfigInput;
}): Promise<{ config: RemoteSyncConfigDto }> {
	const config = await dbSaveConfig(params.projectId, params.input);
	// Connection details may have changed — drop any cached browse connection so the
	// next browse reconnects with the new host/credentials.
	await evictBrowseCache(params.projectId).catch(() => {});
	return { config };
}

export async function revealRemoteSyncSecret(params: {
	projectId: string;
}): Promise<{ password: string; passphrase: string }> {
	try {
		const cfg = await resolveRemoteConfig(params.projectId);
		return { password: cfg?.creds.password ?? "", passphrase: cfg?.creds.passphrase ?? "" };
	} catch {
		return { password: "", passphrase: "" };
	}
}

export async function testRemoteConnection(params: {
	projectId: string;
}): Promise<{ ok: boolean; message?: string; error?: string }> {
	return engineTest(params.projectId);
}

export async function browseRemoteDir(params: {
	projectId: string;
	remoteDir: string;
}): Promise<{ entries: RemoteEntryDto[]; error?: string }> {
	return engineBrowse(params.projectId, params.remoteDir);
}

export async function startRemotePull(params: {
	projectId: string;
}): Promise<{ ok: boolean; runId?: string; error?: string }> {
	return enginePull(params.projectId);
}

export async function computeRemotePushDiff(params: {
	projectId: string;
}): Promise<{ entries: PushDiffEntry[]; scanned: number; error?: string }> {
	return engineDiff(params.projectId);
}

export async function getRemotePushFileDiff(params: {
	projectId: string;
	remotePath: string;
}): Promise<{ local: string; remote: string; remoteExists: boolean; binary: boolean; tooLarge: boolean; error?: string }> {
	return engineFileDiff(params.projectId, params.remotePath);
}

export async function startRemotePush(params: {
	projectId: string;
	remotePaths: string[];
}): Promise<{ ok: boolean; runId?: string; error?: string }> {
	return enginePush(params.projectId, params.remotePaths);
}

export async function listRemoteSyncRuns(params: {
	projectId: string;
	limit?: number;
}): Promise<{ runs: RemoteSyncRunDto[] }> {
	return { runs: await listRuns(params.projectId, params.limit ?? 50) };
}

export async function cancelRemoteSync(params: { projectId: string }): Promise<{ ok: boolean }> {
	return { ok: engineCancel(params.projectId) };
}
