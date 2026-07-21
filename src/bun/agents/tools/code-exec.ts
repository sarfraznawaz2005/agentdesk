// ---------------------------------------------------------------------------
// execute_code — real-workspace Python/JavaScript execution for write-capable
// sub-agents (project chat + Quick Chat, both dispatched via runInlineAgent)
// and the Playground agent. NOT granted to the PM (its tools come entirely
// from pm-tools.ts, which never touches the shared toolRegistry this is
// registered in) or to the 3 read-only agents (WRITE_TOOLS/filterReadOnlyTools
// in agent-loop.ts strip it the same way they strip run_shell/write_file).
//
// Distinct from general-chat-code-exec.ts: THIS version runs with cwd set to
// the agent's REAL project workspace (or Playground's own generated one) —
// not a throwaway temp folder — so a script can read/write actual project
// files, same capability tier as run_shell. It is gated the same way:
// approval-required by default (requestShellLikeApproval, shared with
// run_shell's own handler/UI), auto-approved only for Playground, which
// already auto-approves its own run_shell for the same reason (see
// playground/orchestrator.ts's extraTools override).
//
// Deliberately a closure-based factory (createCodeExecTool), NOT an AI SDK
// contextSchema/context tool like run_shell — agent-loop.ts's
// isClaudeSubscriptionViaCli branch (Sonnet/Opus via the Agent SDK/CLI
// runner) calls each tool's execute() directly with only
// { toolCallId, abortSignal }, no `context` object at all (confirmed by
// reading claude-subscription-cli-runner.ts — this is the same two-path
// provider gap documented in this file's own Critical Rules, and the reason
// run_shell's own context-based approval gate silently no-ops on that path
// today). A contextSchema-based execute_code would have failed outright for
// every Claude Subscription (non-Haiku) user, since it also needs
// workspacePath to know where to write the script file, which run_shell
// doesn't. Overlaid onto the agent's tool set in agent-loop.ts BEFORE the
// CLI/generateText branch point, exactly like trackedFileTools/
// createDecisionsTool — so both paths get the identical, already-bound tool.
// A lightweight registry stub (below) still exists so execute_code shows up
// as a normal, per-agent-toggleable tool in Settings → Agents → Tools; the
// stub itself should never actually execute.
// ---------------------------------------------------------------------------

import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { truncateShellOutput } from "./truncation";
import { imageToolModelOutput } from "./screenshot";
import { requestShellLikeApproval } from "./shell";
import type { ToolRegistryEntry } from "./index";
import {
	isBlockedCode, killProcessTree, resolvePython, resolveJsInterpreter,
	describeInterpreterAvailability, extractAndStripImage, IMAGE_RECIPE_DESCRIPTION,
} from "./code-exec-shared";

const EXECUTE_CODE_DESCRIPTION =
	"Run a short Python or JavaScript snippet in the project workspace and return its stdout, stderr, " +
	"and exit code as a JSON string. Use this for calculations, data processing, quick algorithms, " +
	"generating a chart/plot, or a small script that's faster to write and run than to do by hand — " +
	"for reading/writing/editing actual project files, prefer the dedicated file tools, which are " +
	"tracked and reviewable; this is for throwaway logic, not a substitute for them. Runs with the " +
	"project workspace as the working directory (relative paths resolve there), same scope run_shell " +
	"has. If you import a library (e.g. numpy, pandas) and it isn't installed, the import will fail — " +
	"catch that and report what's missing rather than assuming it's available. " + IMAGE_RECIPE_DESCRIPTION;

const EXECUTE_CODE_INPUT_SCHEMA = z.object({
	code: z.string().min(1).describe("The full source code to run."),
	language: z.enum(["python", "javascript"]).default("python").describe(
		"Check the tool description for which of these are actually available on THIS machine before picking one.",
	),
	timeout: z.number().optional().describe("Maximum execution time in milliseconds. Defaults to 300000 (300 s)."),
});

export interface CodeExecIdentity {
	projectId: string;
	conversationId: string;
	agentName: string;
	agentDisplayName: string;
}

/** Factory — closes over the real workspace + calling agent's identity (for the approval prompt). */
export function createCodeExecTool(workspacePath: string, identity: CodeExecIdentity, autoApprove: boolean): Record<string, Tool> {
	return {
		execute_code: tool({
			description: `${EXECUTE_CODE_DESCRIPTION}\n\n${describeInterpreterAvailability()}`,
			inputSchema: EXECUTE_CODE_INPUT_SCHEMA,
			execute: async (rawArgs, { abortSignal }): Promise<string> => {
				const { code, language, timeout = 300_000 } = rawArgs as z.infer<typeof EXECUTE_CODE_INPUT_SCHEMA>;

				if (isBlockedCode(code)) {
					return JSON.stringify({ exitCode: null, stdout: "", stderr: "Blocked: code matches a dangerous pattern" });
				}

				if (!autoApprove) {
					try {
						const decision = await requestShellLikeApproval(
							`[execute_code:${language}]\n${code}`,
							identity.agentName,
							identity.agentDisplayName,
							identity.projectId,
							identity.conversationId,
						);
						if (decision === "deny") {
							return JSON.stringify({ exitCode: null, stdout: "", stderr: "Command denied by user" });
						}
					} catch {
						return JSON.stringify({ exitCode: null, stdout: "", stderr: "Approval check failed — command blocked" });
					}
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

					const { cleanedStdout, imagePayload } = extractAndStripImage(stdout);

					const stdoutResult = await truncateShellOutput(cleanedStdout);
					const stderrResult = stderr.length > 5000 ? stderr.slice(0, 5000) + "\n... (stderr truncated)" : stderr;

					const resultPayload: Record<string, unknown> = {
						exitCode: proc.exitCode ?? null,
						stdout: stdoutResult.content,
						stderr: stderrResult,
					};
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

// ---------------------------------------------------------------------------
// Registry stub — exists only so "execute_code" is a valid, listable,
// per-agent-toggleable tool name (Settings → Agents → Tools, agent_tools
// rows, getToolDefinitions()). agent-loop.ts always overlays the real,
// workspace-bound implementation above whenever an agent is actually granted
// this tool and has a workspace; if this stub ever executes, something
// upstream failed to overlay it.
// ---------------------------------------------------------------------------

const codeExecStub: Tool = tool({
	description: `${EXECUTE_CODE_DESCRIPTION}\n\n${describeInterpreterAvailability()}`,
	inputSchema: EXECUTE_CODE_INPUT_SCHEMA,
	execute: async (): Promise<string> =>
		JSON.stringify({
			exitCode: null,
			stdout: "",
			stderr: "execute_code requires a real workspace; this registry stub should never execute directly.",
		}),
});

export const codeExecTools: Record<string, ToolRegistryEntry> = {
	execute_code: { tool: codeExecStub, category: "shell" },
};
