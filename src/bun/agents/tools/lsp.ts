import { tool } from "ai";
import { z } from "zod";
import { extname } from "path";
import type { ToolRegistryEntry } from "./index";
import {
	getOrSpawnServer,
	openDocs,
	pluginSettings,
} from "../../plugins/lsp-manager/index";
import { getServerForExtension } from "../../lsp/servers";

// ---------------------------------------------------------------------------
// Shared helper — ensure document is open before querying
// ---------------------------------------------------------------------------

async function ensureOpen(
	filePath: string,
	workspace: string,
	content?: string,
) {
	const ext = extname(filePath).toLowerCase();
	const spawn = await getOrSpawnServer(ext, workspace, pluginSettings);
	if (!spawn.ok) return spawn;

	const client = spawn.client;
	if (!openDocs.has(filePath)) {
		const def = getServerForExtension(ext);
		if (!def) return spawn;
		const languageId = def.languageIds[ext] ?? ext.slice(1);
		await client.openDocument(filePath, languageId, content);
		openDocs.add(filePath);
	} else if (content !== undefined) {
		client.notifyDocumentChanged(filePath, content);
	}
	return spawn;
}

// ---------------------------------------------------------------------------
// lsp_diagnostics
// ---------------------------------------------------------------------------

function formatDiagnostics(diags: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number | null; message: string; source?: string | null; code?: string | number | null }>) {
	return diags.map((d) => ({
		line: d.range.start.line + 1,
		column: d.range.start.character + 1,
		endLine: d.range.end.line + 1,
		endColumn: d.range.end.character + 1,
		severity: severityLabel(d.severity ?? undefined),
		message: d.message,
		source: d.source ?? "",
		code: d.code ?? "",
	}));
}

const lspDiagnosticsTool = tool({
	description:
		"Get LSP diagnostics (errors, warnings) for one or more files. Spawns the language server on demand. " +
		"Use file_paths (array) to check multiple files in parallel — preferred when checking more than one file. " +
		"Use file_path (string) for a single file. Returns diagnostics with line, column, severity, and message.",
	inputSchema: z.object({
		file_path: z.string().optional().describe("Absolute path to a single file (use file_paths for multiple files)"),
		file_paths: z.array(z.string()).optional().describe("Absolute paths to multiple files — checked in parallel"),
		workspace: z.string().describe("Workspace root directory"),
		content: z.string().optional().describe("Current file content for a single file (if unsaved); ignored when using file_paths"),
	}),
	execute: async ({ file_path, file_paths, workspace, content }): Promise<string> => {
		// Resolve list of paths — file_paths takes precedence; fall back to file_path
		const paths = file_paths && file_paths.length > 0
			? file_paths
			: file_path ? [file_path] : [];

		if (paths.length === 0) {
			return JSON.stringify({ error: "Provide file_path or file_paths" });
		}

		// Single file — return the original flat shape for backward compatibility
		if (paths.length === 1) {
			const fp = paths[0];
			try {
				const spawn = await ensureOpen(fp, workspace, content);
				if (!spawn.ok) return JSON.stringify({ diagnostics: [], error: spawn.error });
				const diags = await spawn.client.waitForDiagnostics(fp);
				return JSON.stringify({ diagnostics: formatDiagnostics(diags) });
			} catch (err) {
				return JSON.stringify({ diagnostics: [], error: err instanceof Error ? err.message : String(err) });
			}
		}

		// Multiple files — run in parallel, return results keyed by file path
		const results = await Promise.all(
			paths.map(async (fp) => {
				try {
					const spawn = await ensureOpen(fp, workspace);
					if (!spawn.ok) return { file: fp, diagnostics: [], error: spawn.error };
					const diags = await spawn.client.waitForDiagnostics(fp);
					return { file: fp, diagnostics: formatDiagnostics(diags) };
				} catch (err) {
					return { file: fp, diagnostics: [], error: err instanceof Error ? err.message : String(err) };
				}
			}),
		);

		const byFile: Record<string, { diagnostics: ReturnType<typeof formatDiagnostics>; error?: string }> = {};
		let totalErrors = 0;
		let totalWarnings = 0;
		for (const r of results) {
			byFile[r.file] = { diagnostics: r.diagnostics, ...(r.error ? { error: r.error } : {}) };
			totalErrors += r.diagnostics.filter((d) => d.severity === "error").length;
			totalWarnings += r.diagnostics.filter((d) => d.severity === "warning").length;
		}

		return JSON.stringify({ files: byFile, summary: { totalErrors, totalWarnings, filesChecked: paths.length } });
	},
});

// ---------------------------------------------------------------------------
// lsp_hover
// ---------------------------------------------------------------------------

const lspHoverTool = tool({
	description:
		"Get type information and documentation for a symbol at a position. " +
		"Returns the hover content (type signature, docs) from the language server.",
	inputSchema: z.object({
		file_path: z.string().describe("Absolute path to the file"),
		workspace: z.string().describe("Workspace root directory"),
		line: z.number().describe("Line number (1-based)"),
		character: z.number().describe("Column number (1-based)"),
	}),
	execute: async ({ file_path, workspace, line, character }): Promise<string> => {
		try {
			const spawn = await ensureOpen(file_path, workspace);
			if (!spawn.ok) return JSON.stringify({ content: null, error: spawn.error });

			const result = await spawn.client.hover(file_path, line - 1, character - 1);
			return JSON.stringify({ content: result });
		} catch (err) {
			return JSON.stringify({ content: null, error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// lsp_definition
// ---------------------------------------------------------------------------

const lspDefinitionTool = tool({
	description:
		"Go to the definition of a symbol at a position. " +
		"Returns the file path, line, and column of the definition.",
	inputSchema: z.object({
		file_path: z.string().describe("Absolute path to the file"),
		workspace: z.string().describe("Workspace root directory"),
		line: z.number().describe("Line number (1-based)"),
		character: z.number().describe("Column number (1-based)"),
	}),
	execute: async ({ file_path, workspace, line, character }): Promise<string> => {
		try {
			const spawn = await ensureOpen(file_path, workspace);
			if (!spawn.ok) return JSON.stringify({ locations: [], error: spawn.error });

			const locations = await spawn.client.definition(file_path, line - 1, character - 1);
			return JSON.stringify({
				locations: locations.map((l) => ({
					file: l.file,
					line: l.line + 1,
					character: l.character + 1,
				})),
			});
		} catch (err) {
			return JSON.stringify({ locations: [], error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// lsp_references
// ---------------------------------------------------------------------------

const lspReferencesTool = tool({
	description:
		"Find all references to a symbol at a position. " +
		"Returns a list of locations (file, line, column) where the symbol is used.",
	inputSchema: z.object({
		file_path: z.string().describe("Absolute path to the file"),
		workspace: z.string().describe("Workspace root directory"),
		line: z.number().describe("Line number (1-based)"),
		character: z.number().describe("Column number (1-based)"),
		include_declaration: z.boolean().optional().default(true)
			.describe("Include the declaration in results"),
	}),
	execute: async ({ file_path, workspace, line, character, include_declaration }): Promise<string> => {
		try {
			const spawn = await ensureOpen(file_path, workspace);
			if (!spawn.ok) return JSON.stringify({ locations: [], error: spawn.error });

			const locations = await spawn.client.references(
				file_path, line - 1, character - 1, include_declaration,
			);
			return JSON.stringify({
				locations: locations.map((l) => ({
					file: l.file,
					line: l.line + 1,
					character: l.character + 1,
				})),
			});
		} catch (err) {
			return JSON.stringify({ locations: [], error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// lsp_document_symbols
// ---------------------------------------------------------------------------

const lspDocumentSymbolsTool = tool({
	description:
		"Get all symbols (functions, classes, variables, interfaces, etc.) defined in a file. " +
		"Useful for understanding file structure at a glance.",
	inputSchema: z.object({
		file_path: z.string().describe("Absolute path to the file"),
		workspace: z.string().describe("Workspace root directory"),
	}),
	execute: async ({ file_path, workspace }): Promise<string> => {
		try {
			const spawn = await ensureOpen(file_path, workspace);
			if (!spawn.ok) return JSON.stringify({ symbols: [], error: spawn.error });

			const symbols = await spawn.client.documentSymbols(file_path);
			return JSON.stringify({
				symbols: symbols.map((s) => ({
					name: s.name,
					kind: symbolKindLabel(s.kind),
					line: s.line + 1,
					character: s.character + 1,
				})),
			});
		} catch (err) {
			return JSON.stringify({ symbols: [], error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityLabel(severity?: number): string {
	switch (severity) {
		case 1: return "error";
		case 2: return "warning";
		case 3: return "info";
		case 4: return "hint";
		default: return "unknown";
	}
}

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

// ---------------------------------------------------------------------------
// Exported tool registry
// ---------------------------------------------------------------------------

export const lspTools: Record<string, ToolRegistryEntry> = {
	lsp_diagnostics: { tool: lspDiagnosticsTool, category: "file" },
	lsp_hover: { tool: lspHoverTool, category: "file" },
	lsp_definition: { tool: lspDefinitionTool, category: "file" },
	lsp_references: { tool: lspReferencesTool, category: "file" },
	lsp_document_symbols: { tool: lspDocumentSymbolsTool, category: "file" },
};
