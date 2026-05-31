import { tool } from "ai";
import { z } from "zod";
import path from "node:path";
import os from "node:os";
import { openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
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

	proc: ReturnType<typeof Bun.spawn>;
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
	execute: async ({ command, workingDirectory, label = command.slice(0, 60) }): Promise<string> => {
		try {
			pruneOldJobs();

			const id = crypto.randomUUID().slice(0, 8);
			const logPath = path.join(os.tmpdir(), `aidesk-job-${id}.log`);

			// Open a single fd and pass it to both stdout and stderr so they share
			// the same file position — equivalent to "2>&1" but without shell redirection,
			// which is unreliable on Windows (Bun quotes array args, turning > literal).
			const logFd = openSync(logPath, "w");

			const shellArgs: string[] =
				process.platform === "win32"
					? ["cmd", "/c", command]
					: ["bash", "-c", command];

			const proc = Bun.spawn(shellArgs, {
				cwd: workingDirectory,
				stdout: logFd,
				stderr: logFd,
			});

			// Close our copy of the fd once the process exits — the child holds its own.
			proc.exited.finally(() => { try { closeSync(logFd); } catch { /* ignore */ } });

			const job: BackgroundJob = {
				id,
				label,
				command,
				pid: proc.pid,
				logPath,
				startedAt: new Date(),
				cwd: workingDirectory ? path.resolve(workingDirectory) : process.cwd(),
				proc,
			};

			jobStore.set(id, job);

			return JSON.stringify({
				jobId: id,
				pid: proc.pid,
				logPath,
				label,
				startedAt: job.startedAt.toISOString(),
				message: `Job started. Use check_process("${id}") to monitor it.`,
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
			job.proc.kill();
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

function killProcessTree(pid: number, proc: ReturnType<typeof Bun.spawn>): void {
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore", windowsHide: true });
		} else {
			try { proc.kill(); } catch { /* ignore */ }
			setTimeout(() => { try { proc.kill(9); } catch { /* ignore */ } }, 300);
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
// Exported tool registry
// ---------------------------------------------------------------------------

export const processTools: Record<string, ToolRegistryEntry> = {
	run_background: { tool: runBackgroundTool, category: "process" },
	check_process: { tool: checkProcessTool, category: "process" },
	kill_process: { tool: killProcessTool, category: "process" },
	list_background_jobs: { tool: listBackgroundJobsTool, category: "process" },
};
