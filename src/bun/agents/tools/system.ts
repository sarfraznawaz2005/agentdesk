import { tool } from "ai";
import { z } from "zod";
import type { ToolRegistryEntry } from "./index";

// ---------------------------------------------------------------------------
// environment_info — OS, runtime, and environment details
// ---------------------------------------------------------------------------

/** Keys that are safe to expose — never include secrets, tokens, API keys, or passwords. */
const SAFE_ENV_KEYS = [
	// System
	"NODE_ENV", "HOME", "USERPROFILE", "PATH", "SHELL", "TERM", "LANG", "TZ",
	// Temp directories
	"TEMP", "TMP", "TMPDIR",
	// User data (Windows / Linux / Mac)
	"APPDATA", "LOCALAPPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
	// Development tools
	"JAVA_HOME", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME",
	"PYTHON", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX",
	"NVM_DIR", "BUN_INSTALL", "DENO_DIR",
	"ANDROID_HOME", "ANDROID_SDK_ROOT",
	"DOTNET_ROOT", "FLUTTER_ROOT",
	// CI/CD context
	"CI", "GITHUB_ACTIONS", "GITLAB_CI",
];

const environmentInfoTool = tool({
	description:
		"Return information about the current execution environment: OS, Bun/Node version, " +
		"working directory, paths (temp, user data, home), and development tool env vars. " +
		"Use this at the start of a task to understand the runtime context without burning shell turns.",
	inputSchema: z.object({}),
	execute: async (): Promise<string> => {
		try {
			const os = await import("node:os");

			const env: Record<string, string> = {};
			for (const key of SAFE_ENV_KEYS) {
				const val = process.env[key];
				if (val !== undefined) env[key] = val;
			}

			return JSON.stringify({
				os: {
					platform: process.platform,
					arch: process.arch,
					hostname: os.hostname(),
					release: os.release(),
					cpus: os.cpus().length,
					freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
					totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
				},
				runtime: {
					bun: Bun.version,
					bunRevision: Bun.revision,
					node: process.version,
				},
				process: {
					cwd: process.cwd(),
					pid: process.pid,
				},
				paths: {
					home: os.homedir(),
					temp: os.tmpdir(),
				},
				env,
			});
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// get_env — read specific environment variables
// ---------------------------------------------------------------------------

/** Patterns that should never be exposed to agents. */
const SECRET_PATTERNS = /key|token|secret|password|credential|auth|private|apikey|api_key/i;

const getEnvTool = tool({
	description:
		"Read one or more environment variables by name. Useful for checking tool paths, " +
		"language runtimes, or project-specific config. Blocks access to variables whose names " +
		"contain 'key', 'token', 'secret', or 'password' for security.",
	inputSchema: z.object({
		names: z.array(z.string()).min(1).describe("List of environment variable names to read"),
	}),
	execute: async (args): Promise<string> => {
		const result: Record<string, string | null> = {};
		const blocked: string[] = [];

		for (const name of args.names) {
			if (SECRET_PATTERNS.test(name)) {
				blocked.push(name);
				continue;
			}
			result[name] = process.env[name] ?? null;
		}

		return JSON.stringify({
			...(Object.keys(result).length > 0 ? { values: result } : {}),
			...(blocked.length > 0 ? { blocked, reason: "Variable names matching secret patterns are not accessible" } : {}),
		});
	},
});

// ---------------------------------------------------------------------------
// get_agentdesk_paths — AgentDesk app data and storage paths
// ---------------------------------------------------------------------------

const getAgentDeskPathsTool = tool({
	description:
		"Get AgentDesk application paths: where the database, logs, LSP servers, plugins, " +
		"and other app data are stored. Paths vary between dev and production builds.",
	inputSchema: z.object({}),
	execute: async (): Promise<string> => {
		try {
			const { Utils } = await import("electrobun/bun");
			const base = Utils.paths.userData;
			return JSON.stringify({
				appData: base,
				database: `${base}/agentdesk.db`,
				logs: `${base}/logs`,
				lspServers: `${base}/lsp-servers`,
				plugins: `${base}/plugins`,
			});
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// sleep — Pause execution for a number of milliseconds
// ---------------------------------------------------------------------------

const MAX_SLEEP_MS = 30_000; // 30 seconds cap

const sleepTool = tool({
	description:
		"Pause execution for the specified number of milliseconds. " +
		"Use this to wait for a dev server to start, a background process to complete, " +
		"or a rate-limited API to reset. Maximum sleep is 30 seconds.",
	inputSchema: z.object({
		ms: z
			.number()
			.int()
			.min(100)
			.describe("Duration to sleep in milliseconds (capped at 30000)"),
	}),
	execute: async ({ ms }, { abortSignal }): Promise<string> => {
		const duration = Math.min(ms, MAX_SLEEP_MS);

		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, duration);

			// Wake early if the agent is cancelled
			abortSignal?.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			}, { once: true });
		});

		const wokenEarly = abortSignal?.aborted ?? false;
		return JSON.stringify({
			slept: wokenEarly ? 0 : duration,
			requestedMs: ms,
			cappedAt: ms > MAX_SLEEP_MS ? MAX_SLEEP_MS : null,
			wokenEarly,
		});
	},
});

// ---------------------------------------------------------------------------
// Exported tool registry
// ---------------------------------------------------------------------------

export const systemTools: Record<string, ToolRegistryEntry> = {
	environment_info: { tool: environmentInfoTool, category: "system" },
	get_env: { tool: getEnvTool, category: "system" },
	get_agentdesk_paths: { tool: getAgentDeskPathsTool, category: "system" },
	sleep: { tool: sleepTool, category: "system" },
};
