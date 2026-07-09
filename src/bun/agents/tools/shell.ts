import { tool } from "ai";
import { z } from "zod";
import { spawn } from "child_process";
import path from "path";
import type { ToolRegistryEntry } from "./index";
import { truncateShellOutput } from "./truncation";

// ---------------------------------------------------------------------------
// Safety: patterns that should never be executed
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS: string[] = [
	"rm -rf /", "rm -rf ~", "rm -rf .",
	"format c:", "format d:",
	"drop database", "drop table", "truncate table",
	":(){ :|:& };:",
	"mkfs.", "dd if=", "> /dev/sda",
	"shutdown", "reboot", "init 0", "init 6",
];

function isBlockedCommand(command: string): boolean {
	const lower = command.toLowerCase();
	return BLOCKED_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Shell resolution — follows OpenCode's approach
//
// On Windows: find Git Bash via `git` on PATH, fall back to cmd.exe
// On macOS: /bin/zsh
// On Linux: $SHELL or /bin/bash
// ---------------------------------------------------------------------------

function which(name: string): string | null {
	try {
		const result = Bun.spawnSync(
			process.platform === "win32" ? ["where", name] : ["which", name],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const out = result.stdout.toString().trim().split(/\r?\n/)[0];
		return out || null;
	} catch {
		return null;
	}
}

let _resolvedShell: string | null = null;

function resolveShell(): string {
	if (_resolvedShell) return _resolvedShell;

	if (process.platform === "win32") {
		// 1. Check $SHELL env (e.g. Git Bash sets this)
		if (process.env.SHELL && !process.env.SHELL.includes("fish")) {
			_resolvedShell = process.env.SHELL;
			return _resolvedShell;
		}
		// 2. Find Git Bash via git.exe on PATH
		const git = which("git");
		if (git) {
			// git.exe is at: C:\Program Files\Git\cmd\git.exe
			// bash.exe is at: C:\Program Files\Git\bin\bash.exe
			const bash = path.join(path.dirname(git), "..", "bin", "bash.exe");
			try {
				const stat = Bun.spawnSync(["cmd", "/c", `if exist "${bash}" echo found`], { stdout: "pipe" });
				if (stat.stdout.toString().includes("found")) {
					_resolvedShell = bash;
					return _resolvedShell;
				}
			} catch { /* fall through */ }
		}
		// 3. Check common Git Bash locations
		const commonPaths = [
			"C:\\Program Files\\Git\\bin\\bash.exe",
			"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
		];
		for (const p of commonPaths) {
			try {
				const stat = Bun.spawnSync(["cmd", "/c", `if exist "${p}" echo found`], { stdout: "pipe" });
				if (stat.stdout.toString().includes("found")) {
					_resolvedShell = p;
					return _resolvedShell;
				}
			} catch { /* continue */ }
		}
		// 4. Fall back to cmd.exe
		_resolvedShell = process.env.COMSPEC || "cmd.exe";
		return _resolvedShell;
	}

	// Unix
	const shell = process.env.SHELL;
	if (shell && !shell.includes("fish") && !shell.includes("nu")) {
		_resolvedShell = shell;
		return _resolvedShell;
	}
	if (process.platform === "darwin") {
		_resolvedShell = "/bin/zsh";
		return _resolvedShell;
	}
	_resolvedShell = which("bash") || "/bin/sh";
	return _resolvedShell;
}

// ---------------------------------------------------------------------------
// Shell approval gate
// ---------------------------------------------------------------------------

export type ShellApprovalHandler = (
	command: string,
	agentId: string,
	agentName: string,
	projectId: string,
	conversationId: string,
) => Promise<"allow" | "deny" | "always">;

let approvalHandler: ShellApprovalHandler | null = null;
/**
 * Projects for which the user has clicked "Always allow" this session.
 * MUST stay per-project (not a single shared boolean) — otherwise approving
 * one shell command in project A silently disables the approval prompt for
 * every OTHER project's agents too, bypassing their own shellApprovalMode.
 */
const sessionAutoApprovedProjects = new Set<string>();

export function setShellApprovalHandler(handler: ShellApprovalHandler | null): void {
	approvalHandler = handler;
}

export function resetShellAutoApprove(projectId: string): void {
	sessionAutoApprovedProjects.delete(projectId);
}

// ---------------------------------------------------------------------------
// Process tree killing (Windows-safe)
// ---------------------------------------------------------------------------

function killProcessTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			// taskkill /f /t kills the entire process tree on Windows
			spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
				stdio: "ignore",
				windowsHide: true,
			});
		} else {
			// Kill process group on Unix
			try { process.kill(-pid, "SIGTERM"); } catch { /* ignore */ }
			setTimeout(() => {
				try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
			}, 200);
		}
	} catch { /* already dead */ }
}

// ---------------------------------------------------------------------------
// run_shell tool — factory
// autoApprove=true skips the approval gate entirely (used by freelance contexts
// so the gate is hardcoded out at the tool level, not via shared mutable state).
// ---------------------------------------------------------------------------

const SHELL_DESCRIPTION =
	"Execute a shell command and return its stdout, stderr, and exit code as a JSON string. " +
	"Dangerous commands (disk formats, recursive deletes, fork bombs, etc.) are blocked. " +
	"Commands run in bash (Unix-style). Use standard Unix shell syntax — find, grep, cat, ls, etc. all work. " +
	"You can use &&, ||, pipes, and standard shell operators. " +
	"The working directory defaults to the project workspace — do NOT cd into it manually. " +
	"To run in a subfolder, set workingDirectory to a relative path (e.g. 'src/server') and it will be resolved against the workspace root.";

const SHELL_INPUT_SCHEMA = z.object({
	command: z.string().describe("The shell command to execute (use Unix/bash syntax)"),
	workingDirectory: z
		.string()
		.optional()
		.describe("Directory to run the command in. Defaults to the project workspace. Use relative paths for subfolders."),
	timeout: z
		.number()
		.optional()
		.describe("Maximum execution time in milliseconds. Defaults to 300000 (300 s)."),
});

function makeShellTool(autoApprove: boolean) {
	return tool({
		description: SHELL_DESCRIPTION,
		inputSchema: SHELL_INPUT_SCHEMA,
		execute: async (rawArgs, { abortSignal }): Promise<string> => {
			const { command, workingDirectory, timeout = 300_000 } = rawArgs as z.infer<typeof SHELL_INPUT_SCHEMA>;
			// Stamped by agent-loop.ts's run_shell wrapper (hidden from the model —
			// not part of SHELL_INPUT_SCHEMA) so the approval gate below resolves
			// THIS agent's actual project/conversation, not whichever project's
			// engine the backend happened to touch most recently.
			const projectId = (rawArgs as Record<string, unknown>).__projectId as string | undefined ?? "";
			const conversationId = (rawArgs as Record<string, unknown>).__conversationId as string | undefined ?? "";

			// --- Safety check ---------------------------------------------------
			if (isBlockedCommand(command)) {
				return "Blocked: command matches dangerous pattern";
			}

			// --- Approval gate (skipped for freelance/auto-approved contexts) ----
			if (!autoApprove && approvalHandler && !sessionAutoApprovedProjects.has(projectId)) {
				try {
					const decision = await approvalHandler(command, "sub-agent", "Sub-Agent", projectId, conversationId);
					if (decision === "deny") {
						return JSON.stringify({ exitCode: null, stdout: "", stderr: "Command denied by user" });
					}
					if (decision === "always") {
						sessionAutoApprovedProjects.add(projectId);
					}
				} catch {
					return JSON.stringify({ exitCode: null, stdout: "", stderr: "Shell approval check failed — command blocked" });
				}
			}

		try {
			// --- Resolve shell ------------------------------------------------
			const shell = resolveShell();

			// Use spawn with { shell } option — Node/Bun handles the shell
			// invocation correctly for both bash and cmd.exe
			const proc = spawn(command, {
				shell,
				cwd: workingDirectory,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				// detached on Unix enables process-group kill; not on Windows
				...(process.platform !== "win32" ? { detached: true } : { windowsHide: true }),
			});

			const pid = proc.pid;

			const killProc = () => {
				if (pid) killProcessTree(pid);
				else try { proc.kill(); } catch { /* already exited */ }
			};

			// Kill process immediately when the agent's abort signal fires
			abortSignal?.addEventListener("abort", killProc, { once: true });

			// --- Collect output in real-time -----------------------------------
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
			proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

			// --- Timeout + exit race ------------------------------------------
			let timedOut = false;
			let timeoutId: ReturnType<typeof setTimeout> | null = null;

			const exitPromise = new Promise<void>((resolve, reject) => {
				proc.once("exit", () => resolve());
				proc.once("error", (err) => reject(err));
			});

			const timeoutPromise = new Promise<void>((resolve) => {
				timeoutId = setTimeout(() => {
					timedOut = true;
					killProc();
					resolve();
				}, timeout);
			});

			await Promise.race([exitPromise, timeoutPromise]);

			abortSignal?.removeEventListener("abort", killProc);
			if (timeoutId !== null) clearTimeout(timeoutId);

			if (abortSignal?.aborted) {
				return JSON.stringify({ exitCode: null, stdout: "", stderr: "Command aborted" });
			}

			if (timedOut) {
				return JSON.stringify({ exitCode: null, stdout: "", stderr: `Command timed out after ${timeout} ms` });
			}

			const exitCode = proc.exitCode ?? null;

			// Truncate large outputs to prevent context blowup
			const stdoutResult = await truncateShellOutput(stdout);
			const stderrResult = stderr.length > 5000
				? { content: stderr.slice(0, 5000) + "\n... (stderr truncated)" }
				: { content: stderr };

			return JSON.stringify({ exitCode, stdout: stdoutResult.content, stderr: stderrResult.content });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return `Error executing command: ${message}`;
		}
	},
	});
}

// ---------------------------------------------------------------------------
// Exported registry entries
// ---------------------------------------------------------------------------

const runShellTool = makeShellTool(false);

/** Auto-approved shell tool for freelance and skills-search chat contexts — no approval gate. */
export const autoApprovedShellTool = makeShellTool(true);

export const shellTools: Record<string, ToolRegistryEntry> = {
	run_shell: {
		tool: runShellTool,
		category: "shell",
	},
};
