/**
 * Shared git command runner used by both RPC handlers and agent tools.
 */
export async function runGit(
	args: string[],
	cwd: string,
	abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

	const killProcess = () => {
		try { proc.kill(); } catch { /* already exited */ }
	};
	abortSignal?.addEventListener("abort", killProcess, { once: true });

	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
	} finally {
		abortSignal?.removeEventListener("abort", killProcess);
	}
}
