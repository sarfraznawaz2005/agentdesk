// ---------------------------------------------------------------------------
// MCP Client Manager
// Reads MCP server configs from settings, spawns stdio/remote processes,
// lists their tools, and exposes getMcpTools() for both PM and sub-agents.
// ---------------------------------------------------------------------------

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { dynamicTool, jsonSchema } from "ai";
import type { Tool, JSONSchema7 } from "ai";
import { getSettings } from "../rpc/settings";

export interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	disabled?: boolean;
}

async function loadMcpServers(): Promise<Record<string, McpServerConfig>> {
	const s = await getSettings("mcp");
	const rawValue = s["mcp_config"];
	if (!rawValue) return {};
	try {
		// getSettings() JSON.parses the stored value once.
		// When saved via saveSetting() (double-encoded), rawValue is a string → parse again.
		// When inserted by seed (single-encoded), rawValue is already the object → use directly.
		const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
		return (parsed as { mcpServers?: Record<string, McpServerConfig> }).mcpServers
			?? (parsed as Record<string, McpServerConfig>)
			?? {};
	} catch {
		return {};
	}
}

// ── Types ─────────────────────────────────────────────────────────────────

export type McpServerStatus = "connected" | "connecting" | "failed" | "disabled";

interface McpEntry {
	client: Client;
	tools: Record<string, Tool>;
	status: McpServerStatus;
}

// ── State ─────────────────────────────────────────────────────────────────

const clients = new Map<string, McpEntry>();
const retryTimers = new Map<string, Timer>();
let initialized = false;

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5_000;

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Initialize all MCP servers from settings. Safe to call multiple times —
 * subsequent calls reload (shutdown old, start new).
 */
export async function initMcpClients(): Promise<void> {
	if (initialized) {
		await shutdownMcpClients();
	}
	initialized = true;

	const servers = await loadMcpServers();

	await Promise.allSettled(
		Object.entries(servers).map(([name, cfg]) => connectServer(name, cfg)),
	);

	const connected = [...clients.values()].filter((e) => e.status === "connected").length;
	console.log(`[mcp] Initialized — ${connected}/${Object.keys(servers).length} servers connected`);
}

/**
 * Reload MCP clients (called after settings change).
 */
export async function reloadMcpClients(): Promise<void> {
	console.log("[mcp] Reloading clients...");
	await initMcpClients();
}

/**
 * Shut down all MCP server connections.
 */
export async function shutdownMcpClients(): Promise<void> {
	// Cancel all pending retry timers
	for (const timer of retryTimers.values()) clearTimeout(timer);
	retryTimers.clear();

	await Promise.allSettled(
		[...clients.values()].map((entry) => entry.client.close().catch(() => {})),
	);
	clients.clear();
	initialized = false;
}

/**
 * Disconnect a specific server and cancel any pending retries.
 */
export async function disconnectMcpServer(name: string): Promise<void> {
	const timer = retryTimers.get(name);
	if (timer) { clearTimeout(timer); retryTimers.delete(name); }
	const entry = clients.get(name);
	if (entry) {
		await entry.client.close().catch(() => {});
		clients.set(name, { ...entry, tools: {}, status: "disabled" });
	}
	console.log(`[mcp] "${name}" disconnected`);
}

/**
 * Manually reconnect a specific server (or all failed servers if no name given).
 */
export async function reconnectMcpServer(name?: string): Promise<void> {
	const servers = await loadMcpServers();

	if (name) {
		const cfg = servers[name];
		if (!cfg) {
			console.warn(`[mcp] reconnect: server "${name}" not found in config`);
			return;
		}
		// Cancel any pending retry for this server
		const existing = retryTimers.get(name);
		if (existing) { clearTimeout(existing); retryTimers.delete(name); }
		// Close old client if present
		const old = clients.get(name);
		if (old) await old.client.close().catch(() => {});
		clients.delete(name);

		await connectServer(name, cfg);
	} else {
		// Reconnect all failed servers
		const failed = [...clients.entries()]
			.filter(([, e]) => e.status === "failed")
			.map(([n]) => n);

		await Promise.allSettled(
			failed.map(async (n) => {
				const cfg = servers[n];
				if (!cfg) return;
				const existing = retryTimers.get(n);
				if (existing) { clearTimeout(existing); retryTimers.delete(n); }
				const old = clients.get(n);
				if (old) await old.client.close().catch(() => {});
				clients.delete(n);
				await connectServer(n, cfg);
			}),
		);
	}
}

/**
 * Returns all tools from all connected MCP servers, keyed as
 * `{serverName}_{toolName}` (sanitized for AI SDK compatibility).
 */
export function getMcpTools(): Record<string, Tool> {
	const result: Record<string, Tool> = {};
	for (const [, entry] of clients) {
		if (entry.status === "connected") {
			Object.assign(result, entry.tools);
		}
	}
	return result;
}

/**
 * Returns per-server connection status (for settings UI).
 */
export function getMcpStatus(): Record<string, McpServerStatus> {
	return Object.fromEntries([...clients.entries()].map(([name, e]) => [name, e.status]));
}

// ── Private helpers ───────────────────────────────────────────────────────

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

async function connectServer(name: string, cfg: McpServerConfig, retryCount = 0): Promise<void> {
	if (cfg.disabled) {
		console.log(`[mcp] ${name}: disabled, skipping`);
		return;
	}

	console.log(`[mcp] Connecting to "${name}"${retryCount > 0 ? ` (retry ${retryCount})` : ""}...`);
	clients.set(name, {
		client: new Client({ name: "agentdeskai", version: "1.0.0" }),
		tools: {},
		status: "connecting",
	});

	try {
		const client = new Client({ name: "agentdeskai", version: "1.0.0" });
		const isRemote = cfg.command.startsWith("http://") || cfg.command.startsWith("https://");

		if (isRemote) {
			await connectRemote(client, cfg);
		} else {
			await connectLocal(client, name, cfg, retryCount);
		}

		// List tools
		const listed = await client.listTools();
		const tools: Record<string, Tool> = {};
		const serverPrefix = sanitize(name);

		for (const mcpTool of listed.tools) {
			const toolKey = `${serverPrefix}_${sanitize(mcpTool.name)}`;
			const inputSchema = mcpTool.inputSchema;

			const schema: JSONSchema7 = {
				...(inputSchema as JSONSchema7),
				type: "object",
				properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
				additionalProperties: false,
			};

			tools[toolKey] = dynamicTool({
				description: mcpTool.description ?? `MCP tool: ${mcpTool.name} (${name})`,
				inputSchema: jsonSchema(schema),
				execute: async (args: unknown) => {
					let callArgs = (args || {}) as Record<string, unknown>;

					// Force safe screenshot parameters regardless of what the agent passes —
					// fullPage PNG screenshots exceed provider image size limits (983 616 chars).
					if (mcpTool.name === "take_screenshot") {
						callArgs = { ...callArgs, fullPage: false, format: "jpeg", quality: 80 };
					}

					return client.callTool(
						{ name: mcpTool.name, arguments: callArgs },
						CallToolResultSchema,
					);
				},
			});
		}

		clients.set(name, { client, tools, status: "connected" });
		console.log(`[mcp] "${name}" connected — ${listed.tools.length} tools`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[mcp] "${name}" failed:`, msg);
		clients.set(name, {
			client: new Client({ name: "agentdeskai", version: "1.0.0" }),
			tools: {},
			status: "failed",
		});
		scheduleRetry(name, cfg, retryCount);
	}
}

/** Schedule an auto-retry with exponential backoff, up to MAX_RETRIES. */
function scheduleRetry(name: string, cfg: McpServerConfig, retryCount: number): void {
	if (retryCount >= MAX_RETRIES) {
		console.warn(`[mcp] "${name}" giving up after ${MAX_RETRIES} retries`);
		return;
	}
	const delay = RETRY_DELAY_MS * Math.pow(2, retryCount); // 5s, 10s, 20s, 40s, 80s
	console.log(`[mcp] "${name}" retrying in ${delay / 1000}s...`);
	const timer = setTimeout(async () => {
		retryTimers.delete(name);
		// Skip retry if server was removed or disabled in the meantime
		const current = clients.get(name);
		if (current?.status !== "failed") return;
		await connectServer(name, cfg, retryCount + 1);
	}, delay);
	retryTimers.set(name, timer);
}

async function connectLocal(client: Client, name: string, cfg: McpServerConfig, _retryCount: number): Promise<void> {
	const transport = new StdioClientTransport({
		command: cfg.command,
		args: cfg.args ?? [],
		env: { ...process.env as Record<string, string>, ...(cfg.env ?? {}) },
		stderr: "pipe",
	});

	transport.stderr?.on("data", (chunk: Buffer) => {
		console.log(`[mcp:${name}] stderr: ${chunk.toString().trim()}`);
	});

	// Auto-reconnect on unexpected close
	transport.onclose = () => {
		const entry = clients.get(name);
		if (!entry || entry.status !== "connected") return;
		console.warn(`[mcp] "${name}" disconnected unexpectedly`);
		clients.set(name, { ...entry, tools: {}, status: "failed" });
		scheduleRetry(name, cfg, 0);
	};

	await client.connect(transport);
}

async function connectRemote(client: Client, cfg: McpServerConfig): Promise<void> {
	const url = new URL(cfg.command);
	try {
		const transport = new StreamableHTTPClientTransport(url);
		await client.connect(transport);
		return;
	} catch {
		// fall through to SSE
	}
	const transport = new SSEClientTransport(url);
	await client.connect(transport);
}
