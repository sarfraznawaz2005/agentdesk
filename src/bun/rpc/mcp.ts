import { getRawSetting, saveSetting } from "./settings";
import { reloadMcpClients, getMcpStatus, reconnectMcpServer, disconnectMcpServer } from "../mcp/client";

export interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	disabled?: boolean;
}

/** Return the raw MCP config JSON string plus a parsed servers map. */
export async function getMcpConfig(): Promise<{
	raw: string;
	servers: Record<string, McpServerConfig>;
}> {
	// Use getRawSetting to avoid getSettings double-parsing the stored JSON string
	// into an object — mcp_config is intentionally a serialised JSON string.
	const stored = await getRawSetting("mcp_config", "mcp");
	// stored is the literal DB value e.g. `"\"{ ... }\""` (double-encoded) or
	// `"{}"` / null when never set. JSON.parse unwraps one level.
	let raw = "{}";
	if (stored !== null) {
		try {
			const unwrapped = JSON.parse(stored);
			// If saveSetting double-encoded it, unwrapped is the inner string.
			// If it was stored as a raw JSON object (legacy), stringify it back.
			raw = typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped, null, 2);
		} catch {
			raw = stored; // treat as literal if unparseable
		}
	}

	let servers: Record<string, McpServerConfig> = {};
	try {
		const parsed = JSON.parse(raw);
		// Support both { mcpServers: {...} } (Claude Desktop format) and flat { name: {...} }
		servers = parsed.mcpServers ?? parsed ?? {};
	} catch {
		// malformed JSON — return empty
	}

	return { raw, servers };
}

/** Return live connection status for all MCP servers. */
export function getMcpStatusRpc(): Record<string, "connected" | "connecting" | "failed" | "disabled"> {
	return getMcpStatus();
}

/** Reconnect a specific server by name, or all failed servers if name omitted. */
export async function reconnectMcpServerRpc(name?: string): Promise<{ success: boolean }> {
	await reconnectMcpServer(name).catch((err) => console.error("[mcp] Reconnect error:", err));
	return { success: true };
}

/** Disconnect a specific server by name. */
export async function disconnectMcpServerRpc(name: string): Promise<{ success: boolean }> {
	await disconnectMcpServer(name).catch((err) => console.error("[mcp] Disconnect error:", err));
	return { success: true };
}

/** Save (overwrite) the entire MCP config as a JSON string. Validates JSON first. */
export async function saveMcpConfig(configJson: string): Promise<{ success: boolean; error?: string }> {
	try {
		JSON.parse(configJson); // validate
	} catch (e) {
		return { success: false, error: `Invalid JSON: ${String(e)}` };
	}
	await saveSetting("mcp_config", configJson, "mcp");

	// Reload live connections with the new config (fire-and-forget)
	reloadMcpClients().catch((err) => console.error("[mcp] Reload error:", err));

	return { success: true };
}
