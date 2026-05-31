/**
 * Phase 13 — Database backup/restore RPC handlers.
 */
import { Utils } from "electrobun/bun";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync } from "fs";
import { join, basename } from "path";
import { sqlite, closeDatabase } from "../db/connection";
import { logAudit } from "../db/audit";

function getBackupsDir(): string {
	const dir = join(Utils.paths.userData, "backups");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function getDbPath(): string {
	return join(Utils.paths.userData, "agentdesk.db");
}

/**
 * Create a consistent backup using VACUUM INTO.
 */
export function createBackup(): { filename: string; size: number } {
	const dir = getBackupsDir();
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filename = `agentdesk-backup-${timestamp}.db`;
	const backupPath = join(dir, filename);

	sqlite.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

	const stats = statSync(backupPath);
	logAudit({ action: "backup.create", entityType: "backup", details: { filename, size: stats.size } });
	return { filename, size: stats.size };
}

/**
 * List all backups in the backups directory.
 */
export function listBackups(): Array<{ filename: string; size: number; date: string }> {
	const dir = getBackupsDir();
	const files = readdirSync(dir).filter((f) => f.endsWith(".db")).sort().reverse();

	return files.map((filename) => {
		const stats = statSync(join(dir, filename));
		return {
			filename,
			size: stats.size,
			date: stats.mtime.toISOString(),
		};
	});
}

/**
 * Delete a backup file. Uses basename() to prevent path traversal.
 */
export function deleteBackup(filename: string): { success: boolean } {
	const safe = basename(filename);
	const filePath = join(getBackupsDir(), safe);
	if (existsSync(filePath)) {
		unlinkSync(filePath);
	}
	return { success: true };
}

/**
 * Restore a backup by copying it over the current database.
 * Returns requiresRestart: true since the app needs to restart.
 */
export function restoreBackup(filename: string): { success: boolean; requiresRestart: boolean } {
	const safe = basename(filename);
	const backupPath = join(getBackupsDir(), safe);

	if (!existsSync(backupPath)) {
		throw new Error("Backup file not found");
	}

	const dbPath = getDbPath();
	closeDatabase();
	copyFileSync(backupPath, dbPath);

	logAudit({ action: "backup.restore", entityType: "backup", details: { filename: safe } });
	return { success: true, requiresRestart: true };
}
