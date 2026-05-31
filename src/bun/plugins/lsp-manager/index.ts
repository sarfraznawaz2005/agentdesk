// ---------------------------------------------------------------------------
// LSP Manager Plugin — single plugin managing all language servers
// ---------------------------------------------------------------------------

import { z } from "zod";
import { tool } from "ai";
import { extname } from "path";
import type { PluginAPI } from "../types";
import { LSPClient } from "../../lsp/client";
import { SERVER_DEFS, getServerForExtension } from "../../lsp/servers";
import { resolveServerBinary } from "../../lsp/installer";

// ── Server Pool ──────────────────────────────────────────────────────────

/** Pool key = `${serverId}:${workspaceRoot}` */
const serverPool = new Map<string, LSPClient>();

/** Track open documents across all servers to avoid double-open */
export const openDocs = new Set<string>();

function poolKey(serverId: string, workspace: string): string {
	return `${serverId}:${workspace}`;
}

export type SpawnResult =
	| { ok: true; client: LSPClient }
	| { ok: false; error: string };

/** Get or lazily spawn a server for a file extension + workspace. */
export async function getOrSpawnServer(
	ext: string,
	workspace: string,
	settings: Record<string, unknown>,
): Promise<SpawnResult> {
	const def = getServerForExtension(ext);
	if (!def) return { ok: false, error: `No language server configured for "${ext}" files` };

	// Check if this language is enabled in settings
	const enabledKey = `${def.id}_enabled`;
	if (settings[enabledKey] === false) {
		return { ok: false, error: `${def.displayName} language server is disabled. Enable it in plugin settings (${enabledKey}).` };
	}

	const key = poolKey(def.id, workspace);
	const existing = serverPool.get(key);
	if (existing && existing.state === "ready") return { ok: true, client: existing };

	// If there's a dead/error server, clean it up
	if (existing) {
		await existing.shutdown().catch(() => {});
		serverPool.delete(key);
	}

	// Resolve binary
	const binaryOverride = settings[`${def.id}_binary`] as string | undefined;
	const resolved = await resolveServerBinary(def, binaryOverride);
	if (!resolved) {
		const installHint = def.install.method === "bun"
			? `Install via: bun install -g ${def.install.packages?.join(" ") ?? def.binary}`
			: def.install.method === "go"
				? `Install via: go install ${def.install.goPackage}`
				: `Download from GitHub: ${def.install.repo}`;
		return { ok: false, error: `${def.displayName} binary "${def.binary}" not found. ${installHint}. Or set a custom path in plugin settings (${def.id}_binary).` };
	}

	// Spawn
	const client = new LSPClient(resolved.path, def.args, workspace, def.initOptions);
	try {
		await client.initialize();
		serverPool.set(key, client);
		return { ok: true, client };
	} catch (err) {
		console.error(`[lsp-manager] Failed to start ${def.displayName}:`, err);
		return { ok: false, error: `Failed to start ${def.displayName}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** Get a running server for a file path (no spawn). */
function getServerForFile(filePath: string): LSPClient | null {
	const ext = extname(filePath).toLowerCase();
	const def = getServerForExtension(ext);
	if (!def) return null;

	// Find a running server for this language (any workspace)
	for (const [key, client] of serverPool) {
		if (key.startsWith(`${def.id}:`) && client.state === "ready") {
			return client;
		}
	}
	return null;
}

/** Shut down all running servers. */
async function shutdownAll(): Promise<void> {
	const shutdowns = Array.from(serverPool.values()).map((c) =>
		c.shutdown().catch(() => {}),
	);
	await Promise.all(shutdowns);
	serverPool.clear();
	openDocs.clear();
}

// ── Plugin Lifecycle ─────────────────────────────────────────────────────

export let pluginSettings: Record<string, unknown> = {};

export async function activate(api: PluginAPI): Promise<void> {
	pluginSettings = api.getSettings();

	// Register file change handler — notifies running servers, returns diagnostics
	api.onFileChange(async (filePath: string, content: string): Promise<string[]> => {
		const ext = extname(filePath).toLowerCase();
		const def = getServerForExtension(ext);
		if (!def) return [];

		// Only notify already-running servers (don't spawn on passive writes)
		const client = getServerForFile(filePath);
		if (!client) return [];

		const docKey = filePath;
		if (!openDocs.has(docKey)) {
			const languageId = def?.languageIds[ext] ?? ext.slice(1);
			await client.openDocument(filePath, languageId, content);
			openDocs.add(docKey);
		} else {
			client.notifyDocumentChanged(filePath, content);
		}

		// Wait for the server to publish diagnostics (event-driven)
		const diags = await client.waitForDiagnostics(filePath);
		if (diags.length === 0) return [];

		// Format as concise strings for agent context
		return diags.map((d) => {
			const sev = severityLabel(d.severity);
			const line = d.range.start.line + 1;
			const col = d.range.start.character + 1;
			return `${filePath}:${line}:${col}: ${sev}: ${d.message}`;
		});
	});

	// ── Tool: lsp_diagnostics ─────────────────────────────────────────

	api.registerTool(
		"lsp_diagnostics",
		tool({
			description:
				"Get LSP diagnostics (errors, warnings) for a file. The language server must be running for the file's language. Returns an array of diagnostics with line, column, severity, and message.",
			inputSchema: z.object({
				file_path: z.string().describe("Absolute path to the file"),
				workspace: z.string().describe("Workspace root directory"),
				content: z
					.string()
					.optional()
					.describe("Current file content (if not yet saved to disk)"),
			}),
			execute: async ({ file_path, workspace, content }) => {
				try {
					const ext = extname(file_path).toLowerCase();
					const result = await getOrSpawnServer(ext, workspace, pluginSettings);
					if (!result.ok) {
						return { diagnostics: [], error: result.error };
					}
					const client = result.client;
					const def = getServerForExtension(ext);
					if (!def) return { diagnostics: [], error: "No LSP server for extension" };
					const languageId = def?.languageIds[ext] ?? ext.slice(1);
					const docKey = file_path;

					if (!openDocs.has(docKey)) {
						await client.openDocument(file_path, languageId, content);
						openDocs.add(docKey);
					} else if (content !== undefined) {
						client.notifyDocumentChanged(file_path, content);
					}

					// Wait for the server to publish diagnostics (event-driven, with 10s timeout)
					const diags = await client.waitForDiagnostics(file_path);
					return {
						diagnostics: diags.map((d) => ({
							line: d.range.start.line + 1,
							column: d.range.start.character + 1,
							endLine: d.range.end.line + 1,
							endColumn: d.range.end.character + 1,
							severity: severityLabel(d.severity),
							message: d.message,
							source: d.source ?? "",
							code: d.code ?? "",
						})),
					};
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return { diagnostics: [], error: msg };
				}
			},
		}),
	);

	// ── Tool: lsp_hover ───────────────────────────────────────────────

	api.registerTool(
		"lsp_hover",
		tool({
			description:
				"Get type information and documentation for a symbol at a position. Returns the hover content (type signature, docs) from the language server.",
			inputSchema: z.object({
				file_path: z.string().describe("Absolute path to the file"),
				workspace: z.string().describe("Workspace root directory"),
				line: z.number().describe("Line number (1-based)"),
				character: z.number().describe("Column number (1-based)"),
			}),
			execute: async ({ file_path, workspace, line, character }) => {
				try {
					const ext = extname(file_path).toLowerCase();
					const spawn = await getOrSpawnServer(ext, workspace, pluginSettings);
					if (!spawn.ok) return { content: null, error: spawn.error };
					const client = spawn.client;

					if (!openDocs.has(file_path)) {
						const def = getServerForExtension(ext);
						const languageId = def?.languageIds[ext] ?? ext.slice(1);
						await client.openDocument(file_path, languageId);
						openDocs.add(file_path);
					}

					const hoverResult = await client.hover(file_path, line - 1, character - 1);
					return { content: hoverResult };
				} catch (err) {
					return { content: null, error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),
	);

	// ── Tool: lsp_definition ──────────────────────────────────────────

	api.registerTool(
		"lsp_definition",
		tool({
			description:
				"Go to the definition of a symbol at a position. Returns the file path, line, and column of the definition.",
			inputSchema: z.object({
				file_path: z.string().describe("Absolute path to the file"),
				workspace: z.string().describe("Workspace root directory"),
				line: z.number().describe("Line number (1-based)"),
				character: z.number().describe("Column number (1-based)"),
			}),
			execute: async ({ file_path, workspace, line, character }) => {
				try {
					const ext = extname(file_path).toLowerCase();
					const spawn = await getOrSpawnServer(ext, workspace, pluginSettings);
					if (!spawn.ok) return { locations: [], error: spawn.error };
					const client = spawn.client;

					if (!openDocs.has(file_path)) {
						const def = getServerForExtension(ext);
						const languageId = def?.languageIds[ext] ?? ext.slice(1);
						await client.openDocument(file_path, languageId);
						openDocs.add(file_path);
					}

					const locations = await client.definition(file_path, line - 1, character - 1);
					return {
						locations: locations.map((l) => ({
							file: l.file,
							line: l.line + 1,
							character: l.character + 1,
						})),
					};
				} catch (err) {
					return { locations: [], error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),
	);

	// ── Tool: lsp_references ──────────────────────────────────────────

	api.registerTool(
		"lsp_references",
		tool({
			description:
				"Find all references to a symbol at a position. Returns a list of locations (file, line, column) where the symbol is used.",
			inputSchema: z.object({
				file_path: z.string().describe("Absolute path to the file"),
				workspace: z.string().describe("Workspace root directory"),
				line: z.number().describe("Line number (1-based)"),
				character: z.number().describe("Column number (1-based)"),
				include_declaration: z
					.boolean()
					.optional()
					.default(true)
					.describe("Include the declaration in results"),
			}),
			execute: async ({ file_path, workspace, line, character, include_declaration }) => {
				try {
					const ext = extname(file_path).toLowerCase();
					const spawn = await getOrSpawnServer(ext, workspace, pluginSettings);
					if (!spawn.ok) return { locations: [], error: spawn.error };
					const client = spawn.client;

					if (!openDocs.has(file_path)) {
						const def = getServerForExtension(ext);
						const languageId = def?.languageIds[ext] ?? ext.slice(1);
						await client.openDocument(file_path, languageId);
						openDocs.add(file_path);
					}

					const locations = await client.references(file_path, line - 1, character - 1, include_declaration);
					return {
						locations: locations.map((l) => ({
							file: l.file,
							line: l.line + 1,
							character: l.character + 1,
						})),
					};
				} catch (err) {
					return { locations: [], error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),
	);

	// ── Tool: lsp_document_symbols ───────────────────────────────────

	api.registerTool(
		"lsp_document_symbols",
		tool({
			description:
				"Get all symbols (functions, classes, variables, interfaces, etc.) defined in a file. Returns a list of symbol names, kinds, and positions. Useful for understanding file structure at a glance.",
			inputSchema: z.object({
				file_path: z.string().describe("Absolute path to the file"),
				workspace: z.string().describe("Workspace root directory"),
			}),
			execute: async ({ file_path, workspace }) => {
				try {
					const ext = extname(file_path).toLowerCase();
					const spawn = await getOrSpawnServer(ext, workspace, pluginSettings);
					if (!spawn.ok) return { symbols: [], error: spawn.error };
					const client = spawn.client;

					if (!openDocs.has(file_path)) {
						const def = getServerForExtension(ext);
						const languageId = def?.languageIds[ext] ?? ext.slice(1);
						await client.openDocument(file_path, languageId);
						openDocs.add(file_path);
					}

					const symbols = await client.documentSymbols(file_path);
					return {
						symbols: symbols.map((s) => ({
							name: s.name,
							kind: symbolKindLabel(s.kind),
							line: s.line + 1,
							character: s.character + 1,
						})),
					};
				} catch (err) {
					return { symbols: [], error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),
	);

	api.log("info", `LSP Manager activated — ${Object.keys(SERVER_DEFS).length} language servers configured`);
}

export async function deactivate(): Promise<void> {
	await shutdownAll();
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** LSP SymbolKind enum → human label */
function symbolKindLabel(kind: number): string {
	const kinds: Record<number, string> = {
		1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class",
		6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum",
		11: "interface", 12: "function", 13: "variable", 14: "constant",
		15: "string", 16: "number", 17: "boolean", 18: "array", 19: "object",
		20: "key", 21: "null", 22: "enum_member", 23: "struct", 24: "event",
		25: "operator", 26: "type_parameter",
	};
	return kinds[kind] ?? "unknown";
}

function severityLabel(severity?: number): string {
	switch (severity) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "info";
		case 4:
			return "hint";
		default:
			return "unknown";
	}
}
