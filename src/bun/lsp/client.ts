// ---------------------------------------------------------------------------
// LSP Client — manages a single language server process
// ---------------------------------------------------------------------------

import { spawn } from "bun";
import { readFileSync } from "fs";
import { JsonRpcTransport } from "./jsonrpc";
import type {
	InitializeParams,
	InitializeResult,
	ServerCapabilities,
	Diagnostic,
	PublishDiagnosticsParams,
	TextDocumentItem,
	VersionedTextDocumentIdentifier,
	TextDocumentContentChangeEvent,
	Hover,
	MarkupContent,
	Location,
	DocumentSymbol,
	SymbolInformation,
	ReferenceParams,
	TextDocumentPositionParams,
} from "./types";

const INIT_TIMEOUT = 45_000;
const DIAGNOSTICS_DEBOUNCE = 150;

export type ClientState = "starting" | "ready" | "error" | "disposed";

interface OpenDocument {
	uri: string;
	languageId: string;
	version: number;
}

/**
 * LSP Client — spawns a language server process, handles the initialize
 * handshake, document sync, and diagnostic collection.
 *
 * Usage:
 *   const client = new LSPClient("typescript-language-server", ["--stdio"], "/workspace");
 *   await client.initialize();
 *   await client.openDocument("/workspace/src/app.ts", "typescript");
 *   const diags = client.getDiagnostics("/workspace/src/app.ts");
 *   await client.shutdown();
 */
export class LSPClient {
	private transport: JsonRpcTransport | null = null;
	private process: ReturnType<typeof spawn> | null = null;
	private capabilities: ServerCapabilities = {};
	private diagnosticsMap = new Map<string, Diagnostic[]>();
	private diagnosticsTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private diagnosticsWaiters = new Map<string, Array<(diags: Diagnostic[]) => void>>();
	private openDocuments = new Map<string, OpenDocument>();

	state: ClientState = "starting";
	error: string | null = null;

	constructor(
		private binary: string,
		private args: string[],
		private workspaceRoot: string,
		private initOptions?: unknown,
	) {}

	// ── Lifecycle ─────────────────────────────────────────────────────────

	/** Spawn the server process and perform the LSP initialize handshake. */
	async initialize(): Promise<void> {
		try {
			this.process = spawn({
				cmd: [this.binary, ...this.args],
				cwd: this.workspaceRoot,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			this.transport = new JsonRpcTransport(this.process as never);
			this.transport.setNotificationHandler(this.handleNotification.bind(this));

			// Watch for process exit
			this.process.exited.then((code) => {
				if (this.state !== "disposed") {
					this.state = "error";
					this.error = `Server exited with code ${code}`;
				}
			});

			const rootUri = pathToUri(this.workspaceRoot);
			const params: InitializeParams = {
				processId: process.pid,
				rootUri,
				capabilities: {
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: true },
						hover: { contentFormat: ["markdown", "plaintext"] },
						definition: { dynamicRegistration: false },
						references: { dynamicRegistration: false },
						documentSymbol: { dynamicRegistration: false },
						publishDiagnostics: { relatedInformation: true },
					},
					workspace: {
						workspaceFolders: true,
					},
				},
				initializationOptions: this.initOptions,
				workspaceFolders: [{ uri: rootUri, name: this.workspaceRoot.split("/").pop() ?? "workspace" }],
			};

			const result = (await this.transport.sendRequest("initialize", params, INIT_TIMEOUT)) as InitializeResult;
			this.capabilities = result.capabilities;

			// Send initialized notification
			this.transport.sendNotification("initialized", {});
			this.state = "ready";
		} catch (err) {
			this.state = "error";
			this.error = err instanceof Error ? err.message : String(err);
			throw err;
		}
	}

	/** Gracefully shut down the server. */
	async shutdown(): Promise<void> {
		if (this.state === "disposed") return;
		this.state = "disposed";

		// Clear diagnostics debounce timers and waiters
		for (const timer of this.diagnosticsTimers.values()) clearTimeout(timer);
		this.diagnosticsTimers.clear();
		this.diagnosticsWaiters.clear();

		if (this.transport) {
			try {
				await this.transport.sendRequest("shutdown", null, 5_000);
				this.transport.sendNotification("exit");
			} catch {
				// Server may already be dead
			}
			this.transport.dispose();
		}

		// Kill process if still running
		if (this.process) {
			try {
				this.process.kill();
			} catch {
				// Already exited
			}
		}
	}

	// ── Document Sync ─────────────────────────────────────────────────────

	/** Notify the server that a document was opened. Reads from disk if content not provided. */
	async openDocument(filePath: string, languageId: string, content?: string): Promise<void> {
		if (this.state !== "ready") return;

		const uri = pathToUri(filePath);
		const text = content ?? readFileSync(filePath, "utf-8");
		const version = 1;

		const item: TextDocumentItem = { uri, languageId, version, text };
		this.transport?.sendNotification("textDocument/didOpen", { textDocument: item });
		this.openDocuments.set(uri, { uri, languageId, version });
	}

	/** Notify the server that a document's content has changed. Uses full sync. */
	notifyDocumentChanged(filePath: string, content: string): void {
		if (this.state !== "ready") return;

		const uri = pathToUri(filePath);
		const doc = this.openDocuments.get(uri);
		if (!doc) return;

		doc.version++;
		const versioned: VersionedTextDocumentIdentifier = { uri, version: doc.version };
		const changes: TextDocumentContentChangeEvent[] = [{ text: content }];
		this.transport?.sendNotification("textDocument/didChange", {
			textDocument: versioned,
			contentChanges: changes,
		});
	}

	/** Notify the server that a document was closed. */
	closeDocument(filePath: string): void {
		if (this.state !== "ready") return;

		const uri = pathToUri(filePath);
		this.transport?.sendNotification("textDocument/didClose", {
			textDocument: { uri },
		});
		this.openDocuments.delete(uri);
		this.diagnosticsMap.delete(uri);
	}

	// ── Diagnostics ───────────────────────────────────────────────────────

	/** Get cached diagnostics for a file. */
	getDiagnostics(filePath: string): Diagnostic[] {
		const uri = pathToUri(filePath);
		// Direct lookup first
		const direct = this.diagnosticsMap.get(uri);
		if (direct) return direct;
		// Fallback: case-insensitive + decoded URI comparison (servers may
		// encode drive letters differently, e.g. file:///d%3A/ vs file:///D:/)
		const normalizedUri = decodeURIComponent(uri).toLowerCase();
		for (const [key, diags] of this.diagnosticsMap) {
			if (decodeURIComponent(key).toLowerCase() === normalizedUri) return diags;
		}
		return [];
	}

	/** Get all cached diagnostics across all open files. */
	getAllDiagnostics(): Map<string, Diagnostic[]> {
		return new Map(this.diagnosticsMap);
	}

	/**
	 * Wait for diagnostics to be published for a file.
	 * Resolves when the server sends `textDocument/publishDiagnostics` for the URI
	 * (after the debounce settles). Falls back to a timeout to avoid hanging forever.
	 */
	waitForDiagnostics(filePath: string, timeoutMs = 10_000): Promise<Diagnostic[]> {
		const uri = pathToUri(filePath);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				// Timeout — remove this waiter and return whatever we have cached
				this.removeWaiter(uri, onDiags);
				resolve(this.getDiagnostics(filePath));
			}, timeoutMs);

			const onDiags = (diags: Diagnostic[]) => {
				clearTimeout(timer);
				resolve(diags);
			};

			const existing = this.diagnosticsWaiters.get(uri);
			if (existing) {
				existing.push(onDiags);
			} else {
				this.diagnosticsWaiters.set(uri, [onDiags]);
			}
		});
	}

	private resolveWaiters(uri: string, diags: Diagnostic[]): void {
		// Check exact URI first
		const waiters = this.diagnosticsWaiters.get(uri);
		if (waiters && waiters.length > 0) {
			for (const resolve of waiters) resolve(diags);
			this.diagnosticsWaiters.delete(uri);
			return;
		}
		// Fallback: case-insensitive + decoded match (same as getDiagnostics)
		const normalizedUri = decodeURIComponent(uri).toLowerCase();
		for (const [key, keyWaiters] of this.diagnosticsWaiters) {
			if (decodeURIComponent(key).toLowerCase() === normalizedUri && keyWaiters.length > 0) {
				for (const resolve of keyWaiters) resolve(diags);
				this.diagnosticsWaiters.delete(key);
				return;
			}
		}
	}

	private removeWaiter(uri: string, fn: (diags: Diagnostic[]) => void): void {
		const waiters = this.diagnosticsWaiters.get(uri);
		if (!waiters) return;
		const idx = waiters.indexOf(fn);
		if (idx !== -1) waiters.splice(idx, 1);
		if (waiters.length === 0) this.diagnosticsWaiters.delete(uri);
	}

	// ── Query Methods ─────────────────────────────────────────────────────

	/** Get hover information (type info, documentation) at a position. */
	async hover(filePath: string, line: number, character: number): Promise<string | null> {
		if (this.state !== "ready" || !this.capabilities.hoverProvider) return null;

		const params: TextDocumentPositionParams = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
		};

		try {
			const result = (await this.transport?.sendRequest("textDocument/hover", params)) as Hover | null;
			if (!result) return null;

			if (typeof result.contents === "string") return result.contents;
			return (result.contents as MarkupContent).value;
		} catch {
			return null;
		}
	}

	/** Go to definition — returns list of locations. */
	async definition(filePath: string, line: number, character: number): Promise<Array<{ file: string; line: number; character: number }>> {
		if (this.state !== "ready" || !this.capabilities.definitionProvider) return [];

		const params: TextDocumentPositionParams = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
		};

		try {
			const result = await this.transport?.sendRequest("textDocument/definition", params);
			return normalizeLocations(result);
		} catch {
			return [];
		}
	}

	/** Find all references to a symbol. */
	async references(filePath: string, line: number, character: number, includeDeclaration = true): Promise<Array<{ file: string; line: number; character: number }>> {
		if (this.state !== "ready" || !this.capabilities.referencesProvider) return [];

		const params: ReferenceParams = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
			context: { includeDeclaration },
		};

		try {
			const result = await this.transport?.sendRequest("textDocument/references", params);
			return normalizeLocations(result);
		} catch {
			return [];
		}
	}

	/** Get all symbols in a document. */
	async documentSymbols(filePath: string): Promise<Array<{ name: string; kind: number; line: number; character: number }>> {
		if (this.state !== "ready" || !this.capabilities.documentSymbolProvider) return [];

		try {
			const result = await this.transport?.sendRequest("textDocument/documentSymbol", {
				textDocument: { uri: pathToUri(filePath) },
			});

			if (!result || !Array.isArray(result)) return [];

			// Can be DocumentSymbol[] or SymbolInformation[]
			return (result as Array<DocumentSymbol | SymbolInformation>).map((s) => {
				if ("range" in s && "selectionRange" in s) {
					// DocumentSymbol
					const ds = s as DocumentSymbol;
					return { name: ds.name, kind: ds.kind, line: ds.selectionRange.start.line, character: ds.selectionRange.start.character };
				}
				// SymbolInformation
				const si = s as SymbolInformation;
				return { name: si.name, kind: si.kind, line: si.location.range.start.line, character: si.location.range.start.character };
			});
		} catch {
			return [];
		}
	}

	// ── Private ───────────────────────────────────────────────────────────

	private handleNotification(method: string, params: unknown): void {
		if (method === "textDocument/publishDiagnostics") {
			const diagParams = params as PublishDiagnosticsParams;
			// Debounce diagnostics — servers often send syntax first, then semantic
			const existing = this.diagnosticsTimers.get(diagParams.uri);
			if (existing) clearTimeout(existing);

			this.diagnosticsTimers.set(
				diagParams.uri,
				setTimeout(() => {
					this.diagnosticsMap.set(diagParams.uri, diagParams.diagnostics);
					this.diagnosticsTimers.delete(diagParams.uri);
					// Resolve any waiters for this URI
					this.resolveWaiters(diagParams.uri, diagParams.diagnostics);
				}, DIAGNOSTICS_DEBOUNCE),
			);
		}
	}
}

// ── Utilities ────────────────────────────────────────────────────────────

/** Convert a file path to a file:// URI. */
function pathToUri(filePath: string): string {
	// Normalize to forward slashes
	const normalized = filePath.replace(/\\/g, "/");
	// Windows: C:/foo → file:///C:/foo
	if (/^[A-Za-z]:/.test(normalized)) {
		return `file:///${normalized}`;
	}
	return `file://${normalized}`;
}

/** Convert a file:// URI back to a file path. */
export function uriToPath(uri: string): string {
	let p = uri.replace("file:///", "").replace("file://", "");
	p = decodeURIComponent(p);
	// On Windows, keep the drive letter
	if (/^[A-Za-z]:/.test(p)) return p;
	return "/" + p;
}

/** Normalize LSP definition/references results to a simple array. */
function normalizeLocations(result: unknown): Array<{ file: string; line: number; character: number }> {
	if (!result) return [];

	// Single Location
	if (typeof result === "object" && "uri" in (result as object)) {
		const loc = result as Location;
		return [{ file: uriToPath(loc.uri), line: loc.range.start.line, character: loc.range.start.character }];
	}

	// Array of Location
	if (Array.isArray(result)) {
		return result.map((loc: Location) => ({
			file: uriToPath(loc.uri),
			line: loc.range.start.line,
			character: loc.range.start.character,
		}));
	}

	return [];
}
