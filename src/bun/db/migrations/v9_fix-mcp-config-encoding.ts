import { sqlite } from "../connection";

export const name = "fix-mcp-config-encoding";

/**
 * Fix mcp_config rows that were stored as a raw JSON object instead of a
 * double-encoded JSON string.
 *
 * saveSetting() always stores values via JSON.stringify(value), so a string
 * value like '{"mcpServers":{}}' is written as '"{\\"mcpServers\\":{}}"'.
 * getSettings() then JSON.parses that back to the original string.
 *
 * If a row was written by an older code path that skipped the outer
 * JSON.stringify, the DB contains a plain JSON object. This migration detects
 * that case and re-encodes the value correctly so that getSettings() always
 * returns a string.
 */
export function run(): void {
	const row = sqlite
		.prepare<{ value: string }, []>(
			"SELECT value FROM settings WHERE key = 'mcp_config' LIMIT 1",
		)
		.get();

	if (!row) return; // no mcp_config row — nothing to fix

	let parsed: unknown;
	try {
		parsed = JSON.parse(row.value);
	} catch {
		return; // unparseable — leave it alone; getMcpConfig handles this gracefully
	}

	// If it parsed to an object (not a string), it was stored without the outer
	// JSON.stringify wrapper. Re-encode it correctly.
	if (typeof parsed !== "string") {
		const fixed = JSON.stringify(JSON.stringify(parsed, null, 2));
		sqlite
			.prepare("UPDATE settings SET value = ? WHERE key = 'mcp_config'")
			.run(fixed);
		console.log("[migrate] v9: re-encoded mcp_config from object to double-encoded string.");
	}
}
