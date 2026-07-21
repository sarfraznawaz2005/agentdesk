// ---------------------------------------------------------------------------
// General Chat code-execution tool (injected into the Assistant agent via
// extraTools) — NOT part of the shared toolRegistry, so no other agent can
// get THIS ungated variant of it (see code-exec.ts for the gated one write
// agents in project/Quick Chat + Playground use). A narrow, purpose-built
// substitute for the write_file/run_shell grant Assistant deliberately
// doesn't have (see seed.ts's "general-chat-assistant" comment): runs a
// short Python or JavaScript snippet, always cwd'd into the conversation's
// own ephemeral temp workspace (getGeneralChatWorkspacePath), matching
// createGeneralChatMemoryTools/createGeneralChatTodoTools' per-call
// injection pattern (orchestrator.ts).
//
// This is a process/cwd boundary, not a true OS sandbox (no container/VM) —
// a sufficiently adversarial script could still reach outside the workspace
// via an absolute path, same limitation run_shell already has for every
// other agent in this codebase. There is deliberately no interactive
// approval step (unlike run_shell/code-exec.ts): General Chat has no
// project/workspace concept to gate against, so the safety net here is
// scope (temp-folder cwd, a short default timeout, and output truncation)
// rather than a prompt.
// ---------------------------------------------------------------------------

import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { truncateShellOutput } from "./truncation";
import { imageToolModelOutput } from "./screenshot";
import {
	isBlockedCode, killProcessTree, resolvePython, resolveJsInterpreter,
	describeInterpreterAvailability, extractAndStripImage, IMAGE_RECIPE_DESCRIPTION,
} from "./code-exec-shared";

const EXECUTE_CODE_DESCRIPTION_BASE =
	"Run a short Python or JavaScript snippet and return its stdout, stderr, and exit code as a JSON " +
	"string. Use this for calculations, data processing, quick algorithms, or generating a chart/plot " +
	"file — NOT for reading or modifying the user's own files (you have no access to them; this runs in " +
	"your own private, temporary scratch folder that is discarded with the conversation). If you import " +
	"a library (e.g. matplotlib, numpy, pandas) and it isn't installed on the user's machine, the import " +
	"will fail — catch that and tell the user what's missing rather than assuming it's available. " +
	"Only stdout/stderr are returned — print whatever you want to see. " + IMAGE_RECIPE_DESCRIPTION;

const EXECUTE_CODE_INPUT_SCHEMA = z.object({
	code: z.string().min(1).describe("The full source code to run."),
	language: z.enum(["python", "javascript"]).default("python").describe(
		"Check the tool description for which of these are actually available on THIS machine before picking one.",
	),
	timeout: z.number().optional().describe("Maximum execution time in milliseconds. Defaults to 60000 (60 s)."),
});

/**
 * Interpreter availability, injected into the tool's own description so the
 * model sees it on every turn without spending a call probing for it —
 * preferred over a system-prompt note since it lives right next to the tool
 * it describes and is computed fresh (not hand-maintained prose that can
 * drift from what's actually installed on this particular machine).
 */
function describeAvailability(): string {
	return `${EXECUTE_CODE_DESCRIPTION_BASE}\n\n${describeInterpreterAvailability()}`;
}

/** Factory — closes over the conversation's own ephemeral workspace so every run is confined to it. */
export function createGeneralChatCodeExecTool(workspacePath: string): Record<string, Tool> {
	return {
		execute_code: tool({
			description: describeAvailability(),
			inputSchema: EXECUTE_CODE_INPUT_SCHEMA,
			execute: async (rawArgs, { abortSignal }): Promise<string> => {
				const { code, language, timeout = 60_000 } = rawArgs as z.infer<typeof EXECUTE_CODE_INPUT_SCHEMA>;

				if (isBlockedCode(code)) {
					return JSON.stringify({ exitCode: null, stdout: "", stderr: "Blocked: code matches a dangerous pattern" });
				}

				const interpreter = language === "javascript" ? resolveJsInterpreter() : resolvePython();
				if (!interpreter) {
					return JSON.stringify({
						exitCode: null,
						stdout: "",
						stderr: "No Python interpreter (python3/python) found on this machine.",
					});
				}

				const ext = language === "javascript" ? "js" : "py";
				const scriptPath = path.join(workspacePath, `.exec-${crypto.randomUUID()}.${ext}`);
				await writeFile(scriptPath, code, "utf-8");

				try {
					const proc = spawn(interpreter, [scriptPath], {
						cwd: workspacePath,
						env: process.env,
						stdio: ["ignore", "pipe", "pipe"],
						...(process.platform !== "win32" ? { detached: true } : { windowsHide: true }),
					});

					const pid = proc.pid;
					const killProc = () => {
						if (pid) killProcessTree(pid);
						else try { proc.kill(); } catch { /* already exited */ }
					};
					abortSignal?.addEventListener("abort", killProc, { once: true });

					let stdout = "";
					let stderr = "";
					proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
					proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

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
						return JSON.stringify({ exitCode: null, stdout: "", stderr: "Execution aborted" });
					}
					if (timedOut) {
						return JSON.stringify({ exitCode: null, stdout: "", stderr: `Execution timed out after ${timeout} ms` });
					}

					// Extracted from the RAW stdout, before truncateShellOutput — that
					// truncation would otherwise cut a large base64 payload mid-string,
					// corrupting it.
					const { cleanedStdout, imagePayload } = extractAndStripImage(stdout);

					const stdoutResult = await truncateShellOutput(cleanedStdout);
					const stderrResult = stderr.length > 5000 ? stderr.slice(0, 5000) + "\n... (stderr truncated)" : stderr;

					const resultPayload: Record<string, unknown> = {
						exitCode: proc.exitCode ?? null,
						stdout: stdoutResult.content,
						stderr: stderrResult,
					};
					// Same shape generate_image/take_screenshot use — toModelOutput
					// (below) strips the base64 back out before the model ever sees
					// it, so it's never retyped into the model's own reply text.
					if (imagePayload) resultPayload.image = { type: "image", mimeType: imagePayload.mimeType, base64: imagePayload.base64 };

					return JSON.stringify(resultPayload);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return JSON.stringify({ exitCode: null, stdout: "", stderr: `Error executing code: ${message}` });
				} finally {
					await unlink(scriptPath).catch(() => {});
				}
			},
			toModelOutput: ({ output }: { output: string }) => imageToolModelOutput(output),
		}),
	};
}
