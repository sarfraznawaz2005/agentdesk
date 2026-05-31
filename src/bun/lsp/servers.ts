// ---------------------------------------------------------------------------
// LSP server definitions registry — static data for all supported languages
// ---------------------------------------------------------------------------

export interface InstallDef {
	method: "bun" | "go" | "github";
	/** npm packages (for bun method) */
	packages?: string[];
	/** go package path (for go method) */
	goPackage?: string;
	/** GitHub repo (for github method) */
	repo?: string;
	/** Asset name pattern — {platform} replaced with os-arch */
	asset?: string;
	/** External tool required on the user's machine before this server can be installed */
	prereq?: { tool: string; installUrl: string; binary: string };
}

export interface ServerDef {
	id: string;
	displayName: string;
	/** Binary name to look up in PATH or managed dir */
	binary: string;
	/** Args to pass when spawning */
	args: string[];
	/** File extensions this server handles */
	extensions: string[];
	/** Map of extension → LSP languageId */
	languageIds: Record<string, string>;
	/** How to install the server binary */
	install: InstallDef;
	/** LSP initializationOptions sent during initialize handshake */
	initOptions?: unknown;
}

/**
 * All supported language server definitions.
 * The key is the server ID used throughout the system.
 */
export const SERVER_DEFS: Record<string, ServerDef> = {
	typescript: {
		id: "typescript",
		displayName: "TypeScript / JavaScript",
		binary: "typescript-language-server",
		args: ["--stdio"],
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		languageIds: {
			".ts": "typescript",
			".tsx": "typescriptreact",
			".js": "javascript",
			".jsx": "javascriptreact",
			".mjs": "javascript",
			".cjs": "javascript",
		},
		install: {
			method: "bun",
			packages: ["typescript-language-server", "typescript"],
		},
		// Disable Automatic Type Acquisition — prevents npm install types-registry from
		// blocking the initialize handshake when spawning for a new workspace.
		initOptions: {
			disableAutomaticTypingAcquisition: true,
			preferences: {
				disableAutomaticTypingAcquisition: true,
			},
		},
	},
	python: {
		id: "python",
		displayName: "Python",
		binary: "pyright-langserver",
		args: ["--stdio"],
		extensions: [".py", ".pyi"],
		languageIds: {
			".py": "python",
			".pyi": "python",
		},
		install: {
			method: "bun",
			packages: ["pyright"],
		},
	},
	go: {
		id: "go",
		displayName: "Go",
		binary: "gopls",
		args: ["serve"],
		extensions: [".go"],
		languageIds: {
			".go": "go",
		},
		install: {
			method: "go",
			goPackage: "golang.org/x/tools/gopls@latest",
			prereq: { tool: "Go SDK", installUrl: "https://go.dev/dl/", binary: "go" },
		},
	},
	rust: {
		id: "rust",
		displayName: "Rust",
		binary: "rust-analyzer",
		args: [],
		extensions: [".rs"],
		languageIds: {
			".rs": "rust",
		},
		install: {
			method: "github",
			repo: "rust-lang/rust-analyzer",
			asset: "rust-analyzer-{platform}",
		},
	},
	php: {
		id: "php",
		displayName: "PHP",
		binary: "intelephense",
		args: ["--stdio"],
		extensions: [".php"],
		languageIds: {
			".php": "php",
		},
		install: {
			method: "bun",
			packages: ["intelephense"],
		},
	},
	html: {
		id: "html",
		displayName: "HTML",
		binary: "vscode-html-language-server",
		args: ["--stdio"],
		extensions: [".html", ".htm"],
		languageIds: {
			".html": "html",
			".htm": "html",
		},
		install: {
			method: "bun",
			packages: ["vscode-langservers-extracted"],
		},
	},
	css: {
		id: "css",
		displayName: "CSS / SCSS / Less",
		binary: "vscode-css-language-server",
		args: ["--stdio"],
		extensions: [".css", ".scss", ".less"],
		languageIds: {
			".css": "css",
			".scss": "scss",
			".less": "less",
		},
		install: {
			method: "bun",
			packages: ["vscode-langservers-extracted"],
		},
	},
	json: {
		id: "json",
		displayName: "JSON",
		binary: "vscode-json-language-server",
		args: ["--stdio"],
		extensions: [".json", ".jsonc"],
		languageIds: {
			".json": "json",
			".jsonc": "jsonc",
		},
		install: {
			method: "bun",
			packages: ["vscode-langservers-extracted"],
		},
	},
};

/** Flattened lookup: file extension → server definition */
const extensionMap = new Map<string, ServerDef>();
for (const def of Object.values(SERVER_DEFS)) {
	for (const ext of def.extensions) {
		extensionMap.set(ext, def);
	}
}

/** Get the server definition for a file extension, or null if unsupported. */
export function getServerForExtension(ext: string): ServerDef | null {
	return extensionMap.get(ext.toLowerCase()) ?? null;
}

/** Get all server definitions as an array. */
export function getAllServerDefs(): ServerDef[] {
	return Object.values(SERVER_DEFS);
}
