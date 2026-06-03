import { sqlite } from "../connection";

export const name = "remote-sync-security-excludes";

/** Add a column to remote_sync_config only if it isn't already present. */
function addColumnIfMissing(column: string, ddl: string): void {
	const cols = sqlite.prepare("PRAGMA table_info(remote_sync_config)").all() as Array<{ name: string }>;
	if (cols.length === 0) return; // table not created yet (v29 will create it with these columns)
	if (!cols.some((c) => c.name === column)) {
		sqlite.exec(`ALTER TABLE remote_sync_config ADD COLUMN ${ddl}`);
	}
}

export function run(): void {
	addColumnIfMissing("reject_unauthorized", "reject_unauthorized INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing("host_key_fingerprint", "host_key_fingerprint TEXT");
	addColumnIfMissing("exclude_patterns", "exclude_patterns TEXT NOT NULL DEFAULT '[]'");
}
