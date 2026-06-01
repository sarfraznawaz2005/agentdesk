import { tool } from "ai";
import { z } from "zod";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import type { ToolRegistryEntry } from "./index";

// ---------------------------------------------------------------------------
// In-memory job store
// Jobs are keyed by a short UUID. The store is module-level so all agents in
// the same process share visibility into each other's background jobs.
// ---------------------------------------------------------------------------

interface BackgroundJob {
	id: string;
	label: string;
	command: string;
	pid: number;
	logPath: string;
	startedAt: Date;
	/** Resolved working directory the job was spawned in (used for path-scoped cleanup). */
	cwd: string;

	// node:child_process ChildProcess — detached + unref'd so it never blocks
	// Bun's event loop (critical for long-running servers like PHP/Python).
	proc: ChildProcess;
}

const jobStore = new Map<string, BackgroundJob>();
const MAX_JOBS = 100;

function pruneOldJobs(): void {
	if (jobStore.size < MAX_JOBS) return;
	// Evict the oldest completed jobs first, then oldest running if still over limit
	const entries = [...jobStore.entries()];
	const completed = entries.filter(([, j]) => j.proc.exitCode !== null);
	for (const [id] of completed) {
		jobStore.delete(id);
		if (jobStore.size < MAX_JOBS) return;
	}
	// If still over limit, evict oldest regardless
	const oldest = entries[0];
	if (oldest) jobStore.delete(oldest[0]);
}

// ---------------------------------------------------------------------------
// run_background
// ---------------------------------------------------------------------------

export interface StartJobResult {
	jobId?: string;
	pid?: number;
	logPath?: string;
	label?: string;
	startedAt?: string;
	running?: boolean;
	error?: string;
	output?: string;
}

/**
 * Spawn a long-running background process, then confirm it's actually alive.
 * Shared by the run_background tool and the Playground "restart server" RPC.
 *
 * CRITICAL — stdio:"ignore" (NOT inherited file descriptors). Passing fd handles
 * in stdio forces libuv to spawn with bInheritHandles=TRUE on Windows, which leaks
 * EVERY inheritable parent handle into the child — including the keep-alive TCP
 * socket the AI SDK holds open to the model provider. A long-running child (PHP/
 * Python/Vite dev server) then keeps a duplicate of that socket open, so when the
 * provider closes the connection the parent never receives EOF and the NEXT
 * streamed model call hangs until it times out. stdio:"ignore" lets libuv spawn
 * with no inherited handles; output is captured by redirecting inside the shell
 * command instead. detached is only safe on Unix (on Windows it gives the child
 * its own console, which detaches the grandchild's stderr and breaks the redirect).
 */
export async function startBackgroundJob(opts: {
	command: string;
	workingDirectory?: string;
	label?: string;
}): Promise<StartJobResult> {
	const { command, workingDirectory } = opts;
	const label = opts.label ?? command.slice(0, 60);

	pruneOldJobs();

	const id = crypto.randomUUID().slice(0, 8);
	const logPath = path.join(os.tmpdir(), `aidesk-job-${id}.log`);
	const isWin = process.platform === "win32";

	const proc = spawn(`${command} > "${logPath}" 2>&1`, {
		cwd: workingDirectory,
		stdio: "ignore",
		shell: true,
		windowsHide: true,
		detached: !isWin,
	});
	proc.unref();

	// spawn failures (shell missing, bad cwd) surface ASYNChronously via 'error',
	// not as a throw — without this listener Node would treat it as unhandled.
	let spawnError: string | null = null;
	let exited: { code: number | null; signal: string | null } | null = null;
	proc.once("error", (e) => { spawnError = e instanceof Error ? e.message : String(e); });
	proc.once("exit", (code, signal) => { exited = { code, signal }; });

	const job: BackgroundJob = {
		id,
		label,
		command,
		pid: proc.pid ?? 0,
		logPath,
		startedAt: new Date(),
		cwd: workingDirectory ? path.resolve(workingDirectory) : process.cwd(),
		proc,
	};

	jobStore.set(id, job);

	// Liveness probe: wait briefly, then confirm the process is still alive. This
	// turns the instant return (which the model mistakes for failure and then wrongly
	// retries with run_shell) into an authoritative, accurate result.
	await Bun.sleep(600);

	if (spawnError) {
		jobStore.delete(id);
		return { error: `Failed to start: ${spawnError}` };
	}
	if (exited) {
		const e = exited as { code: number | null; signal: string | null };
		let logTail = "";
		try { logTail = (await Bun.file(logPath).text()).slice(-500); } catch { /* ignore */ }
		jobStore.delete(id);
		return {
			error: `The command exited immediately (code ${e.code}${e.signal ? `, signal ${e.signal}` : ""}) instead of staying alive. ` +
				`For a server, check the port isn't already in use and the command is correct.`,
			output: logTail || "(no output captured)",
		};
	}

	return { jobId: id, pid: proc.pid ?? 0, logPath, label, startedAt: job.startedAt.toISOString(), running: true };
}

const runBackgroundTool = tool({
	description:
		"Spawn a shell command as a background process and return immediately. " +
		"stdout and stderr are redirected to a log file you can tail with check_process. " +
		"Use this for long-running tasks (builds, installs, dev servers, docker) that would " +
		"exceed the AI provider stream timeout if run synchronously with run_shell. " +
		"Returns a jobId — pass it to check_process to monitor progress.",
	inputSchema: z.object({
		command: z.string().describe("The shell command to run in the background"),
		workingDirectory: z
			.string()
			.optional()
			.describe("Directory to run the command in"),
		label: z
			.string()
			.optional()
			.describe("Human-readable label for this job (e.g. 'docker build', 'npm install')"),
	}),
	execute: async ({ command, workingDirectory, label }): Promise<string> => {
		try {
			const r = await startBackgroundJob({ command, workingDirectory, label });
			if (r.error) {
				return JSON.stringify({
					error: `${r.error} Do NOT retry with run_shell — fix the command and call run_background again.`,
					command,
					...(r.output ? { output: r.output } : {}),
				});
			}
			return JSON.stringify({
				jobId: r.jobId,
				pid: r.pid,
				logPath: r.logPath,
				label: r.label,
				startedAt: r.startedAt,
				running: true,
				message: `Server/process is running (pid ${r.pid}) and confirmed alive. This is the correct tool — do NOT also start it with run_shell. ` +
					`Next: verify it serves with http_request, then call playground_render_preview.`,
			});
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// check_process
// ---------------------------------------------------------------------------

const checkProcessTool = tool({
	description:
		"Check the status of a background job started with run_background. " +
		"Returns whether it is still running, its exit code if finished, elapsed time, " +
		"and the last N lines of its log output.",
	inputSchema: z.object({
		jobId: z.string().describe("The jobId returned by run_background"),
		tailLines: z
			.number()
			.int()
			.min(1)
			.max(500)
			.optional()
			.describe("Number of log lines to return from the end (default: 50)"),
	}),
	execute: async ({ jobId, tailLines = 50 }): Promise<string> => {
		const job = jobStore.get(jobId);
		if (!job) {
			return JSON.stringify({
				error: `No job found with id "${jobId}". Use list_background_jobs to see all tracked jobs.`,
			});
		}

		const running = job.proc.exitCode === null;
		const exitCode = job.proc.exitCode;
		const elapsedMs = Date.now() - job.startedAt.getTime();

		// Read log tail from the end of the file — avoids loading the entire log into memory
		let logTail: string;
		try {
			const file = Bun.file(job.logPath);
			const size = file.size;
			const TAIL_BYTES = 64 * 1024; // 64KB is plenty for 50-500 lines
			const start = Math.max(0, size - TAIL_BYTES);
			const tailText = await file.slice(start, size).text();
			const lines = tailText.split("\n");
			// If we sliced mid-line, drop the first potentially partial line
			const effectiveLines = start > 0 ? lines.slice(1) : lines;
			logTail = effectiveLines.slice(-tailLines).join("\n");
		} catch {
			logTail = "(log not yet available)";
		}

		return JSON.stringify({
			jobId,
			label: job.label,
			command: job.command,
			pid: job.pid,
			running,
			exitCode,
			elapsedMs,
			elapsedHuman: formatElapsed(elapsedMs),
			logPath: job.logPath,
			logTail,
			startedAt: job.startedAt.toISOString(),
		});
	},
});

// ---------------------------------------------------------------------------
// kill_process
// ---------------------------------------------------------------------------

const killProcessTool = tool({
	description:
		"Terminate a background job that was started with run_background. " +
		"Sends SIGTERM to the process. Use this to stop a dev server or cancel a long build.",
	inputSchema: z.object({
		jobId: z.string().describe("The jobId returned by run_background"),
	}),
	execute: async ({ jobId }): Promise<string> => {
		const job = jobStore.get(jobId);
		if (!job) {
			return JSON.stringify({ error: `No job found with id "${jobId}"` });
		}

		if (job.proc.exitCode !== null) {
			return JSON.stringify({
				jobId,
				pid: job.pid,
				alreadyExited: true,
				exitCode: job.proc.exitCode,
			});
		}

		try {
			// Kill the whole tree — with shell:true the tracked process is the shell and
			// the real server is its child, so a plain kill would orphan it (holding the port).
			killProcessTree(job.pid, job.proc);
			// Give it a moment then report
			await Bun.sleep(200);
			return JSON.stringify({
				jobId,
				pid: job.pid,
				killed: true,
				exitCode: job.proc.exitCode,
			});
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
	},
});

// ---------------------------------------------------------------------------
// list_background_jobs
// ---------------------------------------------------------------------------

const listBackgroundJobsTool = tool({
	description:
		"List all background jobs tracked in this session (both running and completed). " +
		"Use this to find jobIds or get an overview of what is running.",
	inputSchema: z.object({}),
	execute: async (): Promise<string> => {
		const jobs = [...jobStore.values()].map((job) => {
			const running = job.proc.exitCode === null;
			const elapsedMs = Date.now() - job.startedAt.getTime();
			return {
				jobId: job.id,
				label: job.label,
				pid: job.pid,
				running,
				exitCode: job.proc.exitCode,
				startedAt: job.startedAt.toISOString(),
				elapsedHuman: formatElapsed(elapsedMs),
				logPath: job.logPath,
			};
		});

		// Sort: running jobs first, then by start time descending
		jobs.sort((a, b) => {
			if (a.running !== b.running) return a.running ? -1 : 1;
			return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
		});

		return JSON.stringify({ total: jobs.length, jobs });
	},
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
	return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

// ---------------------------------------------------------------------------
// Process-tree kill (Windows-safe)
//
// A background "npm run dev" spawns cmd.exe/bash which in turn spawns node/vite.
// proc.kill() only signals the top shell, leaving the real server orphaned (and
// holding its port). On Windows we use `taskkill /T /F` to kill the whole tree;
// on Unix we SIGTERM then SIGKILL the shell (children typically exit with it).
// ---------------------------------------------------------------------------

function killProcessTree(pid: number, proc: ChildProcess): void {
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore", windowsHide: true });
		} else {
			// Unix jobs are spawned detached (own process group led by `pid`), so signal
			// the whole group with a negative pid to take down the shell + its children.
			try { process.kill(-pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch { /* ignore */ } }
			setTimeout(() => {
				try { process.kill(-pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* ignore */ } }
			}, 300);
		}
	} catch { /* already dead */ }
}

// ---------------------------------------------------------------------------
// killJobsUnderPath — terminate every running background job whose working
// directory is within `dir`. Used by the Playground to tear down dev servers
// it started when the user clicks "New Playground" or on app shutdown.
// Returns the number of jobs killed.
// ---------------------------------------------------------------------------

export function killJobsUnderPath(dir: string): number {
	const prefix = path.resolve(dir).toLowerCase();
	let killed = 0;
	for (const [id, job] of jobStore) {
		if (job.proc.exitCode !== null) continue; // already exited
		const jobCwd = job.cwd.toLowerCase();
		if (jobCwd === prefix || jobCwd.startsWith(prefix + path.sep) || jobCwd.startsWith(prefix + "/")) {
			killProcessTree(job.pid, job.proc);
			jobStore.delete(id);
			killed++;
		}
	}
	return killed;
}

// ---------------------------------------------------------------------------
// getRunningJobsUnderPath — list running jobs whose cwd is within `dir`
// Used by the Playground to surface active dev servers in the UI.
// ---------------------------------------------------------------------------

export interface RunningJobInfo {
	id: string;
	label: string;
	command: string;
	cwd: string;
	pid: number;
	startedAt: string;
	elapsedHuman: string;
}

export function getRunningJobsUnderPath(dir: string): RunningJobInfo[] {
	const prefix = path.resolve(dir).toLowerCase();
	const results: RunningJobInfo[] = [];
	for (const job of jobStore.values()) {
		if (job.proc.exitCode !== null) continue;
		const jobCwd = job.cwd.toLowerCase();
		if (jobCwd === prefix || jobCwd.startsWith(prefix + path.sep) || jobCwd.startsWith(prefix + "/")) {
			const elapsedMs = Date.now() - job.startedAt.getTime();
			results.push({
				id: job.id,
				label: job.label,
				command: job.command,
				cwd: job.cwd,
				pid: job.pid,
				startedAt: job.startedAt.toISOString(),
				elapsedHuman: formatElapsed(elapsedMs),
			});
		}
	}
	return results.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
}

// ---------------------------------------------------------------------------
// killJobById — terminate a single job by id (uses process-tree kill)
// ---------------------------------------------------------------------------

export function killJobById(id: string): boolean {
	const job = jobStore.get(id);
	if (!job || job.proc.exitCode !== null) return false;
	killProcessTree(job.pid, job.proc);
	jobStore.delete(id);
	return true;
}

// ---------------------------------------------------------------------------
// Exported tool registry
// ---------------------------------------------------------------------------

export const processTools: Record<string, ToolRegistryEntry> = {
	run_background: { tool: runBackgroundTool, category: "process" },
	check_process: { tool: checkProcessTool, category: "process" },
	kill_process: { tool: killProcessTool, category: "process" },
	list_background_jobs: { tool: listBackgroundJobsTool, category: "process" },
};
