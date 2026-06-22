/**
 * spawnAsync — a tiny async replacement for `spawnSync` on the Bun main thread.
 *
 * Why this exists: the Bun process is single-threaded and `bun:sqlite` is a
 * synchronous driver, so EVERY RPC reply the webview is waiting on is serialized
 * through this one thread. A synchronous `spawnSync(...)` on a hot path (git
 * status during prompt assembly, PreToolUse/PostToolUse hooks per tool call)
 * blocks that thread for the full duration of the child process — stalling chat
 * tokens, kanban updates, and the freelance inbox alike.
 *
 * This helper runs the child via `Bun.spawn` and `await`s its streams, so the
 * event loop stays free to service other RPCs while the child runs. It mirrors
 * the shape of `runGit` (lib/git-runner.ts) but is command-agnostic and adds a
 * timeout, so any remaining `spawnSync` hot-path call site can migrate to it with
 * a one-line change.
 *
 * NOTE: this is the enabling primitive. Migrating existing `spawnSync` call sites
 * (e.g. agents/prompts.ts buildGitContext, agents/agent-loop.ts tool hooks) to it
 * is a separate, deliberate sweep.
 */

export interface SpawnAsyncOptions {
	/** Working directory for the child process. */
	cwd?: string;
	/** Environment variables (defaults to the parent env). */
	env?: Record<string, string | undefined>;
	/** String written to the child's stdin, if any. */
	input?: string;
	/** Kill the child after this many ms (then `timedOut` is true). */
	timeoutMs?: number;
	/** External abort signal — killing the child when it fires. */
	signal?: AbortSignal;
	/**
	 * Run the command through the platform shell (parity with spawnSync's
	 * `shell: true`). When set, `cmd` is treated as a shell command string —
	 * pass it as a single array element. Bun.spawn has no native shell option, so
	 * we wrap with `cmd /c` on Windows and `sh -c` elsewhere.
	 */
	shell?: boolean;
}

export interface SpawnAsyncResult {
	stdout: string;
	stderr: string;
	/** Process exit code (null when killed by signal/timeout). */
	exitCode: number | null;
	/** True when the child was killed by the timeout (not a clean exit). */
	timedOut: boolean;
}

/**
 * Run a command asynchronously without blocking the Bun event loop.
 *
 * @example
 *   const { stdout, exitCode } = await spawnAsync(["git", "status", "--short"], { cwd, timeoutMs: 5000 });
 */
export async function spawnAsync(
	cmd: string[],
	opts: SpawnAsyncOptions = {},
): Promise<SpawnAsyncResult> {
	const argv = opts.shell
		? process.platform === "win32"
			? ["cmd", "/c", cmd.join(" ")]
			: ["sh", "-c", cmd.join(" ")]
		: cmd;

	const proc = Bun.spawn(argv, {
		cwd: opts.cwd,
		env: opts.env,
		stdin: opts.input != null ? new TextEncoder().encode(opts.input) : undefined,
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	const kill = () => {
		try { proc.kill(); } catch { /* already exited */ }
	};

	const timer =
		opts.timeoutMs != null
			? setTimeout(() => {
					timedOut = true;
					kill();
				}, opts.timeoutMs)
			: null;

	opts.signal?.addEventListener("abort", kill, { once: true });

	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode, timedOut };
	} finally {
		if (timer) clearTimeout(timer);
		opts.signal?.removeEventListener("abort", kill);
	}
}
