// ---------------------------------------------------------------------------
// LSP protocol types — subset needed for agent tool integration
// Based on LSP 3.17 specification
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 message types */
export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ---------------------------------------------------------------------------
// LSP base types
// ---------------------------------------------------------------------------

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface TextDocumentIdentifier {
	uri: string;
}

export interface TextDocumentPositionParams {
	textDocument: TextDocumentIdentifier;
	position: Position;
}

export interface TextDocumentItem {
	uri: string;
	languageId: string;
	version: number;
	text: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
	version: number;
}

export interface TextDocumentContentChangeEvent {
	/** Full document text (when full sync is used) */
	text: string;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export enum DiagnosticSeverity {
	Error = 1,
	Warning = 2,
	Information = 3,
	Hint = 4,
}

export interface Diagnostic {
	range: Range;
	severity?: DiagnosticSeverity;
	code?: number | string;
	source?: string;
	message: string;
	relatedInformation?: DiagnosticRelatedInformation[];
}

export interface DiagnosticRelatedInformation {
	location: Location;
	message: string;
}

export interface PublishDiagnosticsParams {
	uri: string;
	diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

export interface Hover {
	contents: MarkupContent | string;
	range?: Range;
}

export interface MarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

// ---------------------------------------------------------------------------
// Document Symbols
// ---------------------------------------------------------------------------

export enum SymbolKind {
	File = 1, Module = 2, Namespace = 3, Package = 4, Class = 5,
	Method = 6, Property = 7, Field = 8, Constructor = 9, Enum = 10,
	Interface = 11, Function = 12, Variable = 13, Constant = 14, String = 15,
	Number = 16, Boolean = 17, Array = 18, Object = 19, Key = 20,
	Null = 21, EnumMember = 22, Struct = 23, Event = 24, Operator = 25,
	TypeParameter = 26,
}

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: SymbolKind;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: SymbolKind;
	location: Location;
	containerName?: string;
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export interface InitializeParams {
	processId: number | null;
	rootUri: string | null;
	capabilities: ClientCapabilities;
	initializationOptions?: unknown;
	workspaceFolders?: WorkspaceFolder[] | null;
}

export interface WorkspaceFolder {
	uri: string;
	name: string;
}

export interface ClientCapabilities {
	textDocument?: {
		synchronization?: { dynamicRegistration?: boolean; didSave?: boolean };
		hover?: { contentFormat?: string[] };
		definition?: { dynamicRegistration?: boolean };
		references?: { dynamicRegistration?: boolean };
		documentSymbol?: { dynamicRegistration?: boolean };
		publishDiagnostics?: { relatedInformation?: boolean };
	};
	workspace?: {
		workspaceFolders?: boolean;
	};
}

export interface InitializeResult {
	capabilities: ServerCapabilities;
	serverInfo?: { name: string; version?: string };
}

export interface ServerCapabilities {
	textDocumentSync?: number | TextDocumentSyncOptions;
	hoverProvider?: boolean;
	definitionProvider?: boolean;
	referencesProvider?: boolean;
	documentSymbolProvider?: boolean;
}

export interface TextDocumentSyncOptions {
	openClose?: boolean;
	change?: number; // 0=None, 1=Full, 2=Incremental
}

// ---------------------------------------------------------------------------
// Reference params (extends position params)
// ---------------------------------------------------------------------------

export interface ReferenceParams extends TextDocumentPositionParams {
	context: { includeDeclaration: boolean };
}

// ---------------------------------------------------------------------------
// Server state tracking
// ---------------------------------------------------------------------------

export type LSPServerState =
	| "disabled"
	| "not_installed"
	| "installed"
	| "installing"
	| "starting"
	| "ready"
	| "running"
	| "error";
