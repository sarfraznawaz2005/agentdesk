// src/bun/scheduler/task-executor.ts
import { writeInboxMessage, updateAgentResponse } from "../rpc/inbox";
import { sendDesktopNotification } from "../notifications/desktop";
import { createConversation } from "../rpc/conversations";
import { db } from "../db";
import { aiProviders, agents as agentsTable, projects } from "../db/schema";
import { eq } from "drizzle-orm";
import { getDefaultModel } from "../providers/models";
import { createProviderAdapter } from "../providers";
import { broadcastToWebview, registerAgentController, unregisterAgentController } from "../engine-manager";
import type { MessagePart } from "../agents/agent-loop";
import { logPrompt } from "../agents/prompt-logger";

export type TaskType = "pm_prompt" | "reminder" | "shell" | "webhook" | "agent_task" | "agent_task_simple" | "send_channel_message";

export interface TaskResult {
	success: boolean;
	output?: string;
	error?: string;
	durationMs: number;
	stopped?: boolean;
}

// Correlates an in-flight scheduler-originated inbox message (agent_task_simple)
// to its owning cron job, so the Inbox page can show/target a Stop button for
// messages that are still running — including ones fired automatically on
// schedule, not just user-triggered runs.
const runningSchedulerMessages = new Map<string, string>(); // messageId -> jobId

export function getRunningSchedulerMessages(): Array<{ messageId: string; jobId: string }> {
	return [...runningSchedulerMessages.entries()].map(([messageId, jobId]) => ({ messageId, jobId }));
}

type GetOrCreateEngine = (projectId: string) => { sendMessage: (conversationId: string, content: string, metadata?: { source: "scheduler" }) => Promise<unknown> };

let engineResolver: GetOrCreateEngine | null = null;

export function setTaskExecutorEngine(resolver: GetOrCreateEngine): void {
	engineResolver = resolver;
}

export async function executeTask(
	taskType: TaskType,
	config: Record<string, unknown>,
	abortSignal?: AbortSignal,
): Promise<TaskResult> {
	const start = Date.now();

	try {
		let output = "";

		switch (taskType) {
			case "pm_prompt": {
				// Legacy: treat as agent_task with project-manager
				const projectId = config.projectId as string;
				const prompt = (config.prompt ?? config.instructions) as string;
				if (!projectId || !prompt) throw new Error("pm_prompt requires projectId and prompt");
				if (!engineResolver) throw new Error("Engine not initialized");
				const { id: conversationId } = await createConversation(projectId, "Scheduled prompt");
				// Notify frontend so the new conversation appears in the sidebar
				broadcastToWebview("conversationUpdated", { conversationId, updatedAt: new Date().toISOString(), projectId });
				// source: "scheduler" exempts this PM turn's own write-agent dispatches
				// from the main-project-chat concurrency guards (see pm-tools.ts).
				await engineResolver(projectId).sendMessage(conversationId, prompt, { source: "scheduler" });
				output = "Agent task dispatched";
				break;
			}

			case "reminder": {
				const message = config.message as string;
				if (!message) throw new Error("reminder requires message");
				await writeInboxMessage({
					projectId: config.projectId as string | undefined,
					channelId: "cron",
					sender: "Scheduler",
					content: message,
					platform: "scheduler",
				});
				await sendDesktopNotification("Reminder", message.slice(0, 100));
				output = "Reminder sent to inbox";
				break;
			}

			case "shell": {
				const command = config.command as string;
				if (!command) throw new Error("shell requires command");
				const timeout = (config.timeout as number) ?? 60_000;
				const cwd = config.cwd as string | undefined;

				const proc = Bun.spawn(["sh", "-c", command], {
					cwd: cwd || undefined,
					stdout: "pipe",
					stderr: "pipe",
				});

				const timeoutId = setTimeout(() => proc.kill(), timeout);
				const onAbort = () => proc.kill();
				abortSignal?.addEventListener("abort", onAbort);
				const [stdout, stderr] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				clearTimeout(timeoutId);
				abortSignal?.removeEventListener("abort", onAbort);
				const exitCode = await proc.exited;

				if (abortSignal?.aborted) return { success: false, stopped: true, error: "STOPPED BY USER", durationMs: Date.now() - start };

				output = stdout || stderr;
				if (exitCode !== 0) {
					throw new Error(`Shell command exited with code ${exitCode}: ${stderr || stdout}`);
				}
				break;
			}

			case "webhook": {
				const url = config.url as string;
				if (!url) throw new Error("webhook requires url");
				const method = (config.method as string) ?? "POST";
				const headers = (config.headers as Record<string, string>) ?? {};
				const body = config.body as string | undefined;
				const timeout = (config.timeout as number) ?? 30_000;

				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), timeout);
				const onAbort = () => controller.abort();
				abortSignal?.addEventListener("abort", onAbort);

				let response: Response;
				try {
					response = await fetch(url, {
						method,
						headers,
						body: body || undefined,
						signal: controller.signal,
					});
				} catch (err) {
					if (abortSignal?.aborted) return { success: false, stopped: true, error: "STOPPED BY USER", durationMs: Date.now() - start };
					throw err;
				} finally {
					abortSignal?.removeEventListener("abort", onAbort);
				}
				clearTimeout(timeoutId);

				output = `HTTP ${response.status} ${response.statusText}`;
				if (!response.ok) {
					throw new Error(`Webhook returned ${response.status}: ${await response.text()}`);
				}
				break;
			}

			case "agent_task": {
				const projectId = config.projectId as string;
				const instructions = config.instructions as string;
				const agentId = (config.agentId as string | undefined) || "project-manager";
				if (!projectId || !instructions) throw new Error("agent_task requires projectId and instructions");

				if (agentId === "project-manager") {
					// Route through the PM engine (existing behavior)
					if (!engineResolver) throw new Error("Engine not initialized");
					const { id: convId } = await createConversation(projectId, "Scheduled agent task");
					// Notify frontend so the new conversation appears in the sidebar
					broadcastToWebview("conversationUpdated", { conversationId: convId, updatedAt: new Date().toISOString(), projectId });
					// source: "scheduler" exempts this PM turn's own write-agent dispatches
					// from the main-project-chat concurrency guards (see pm-tools.ts).
					await engineResolver(projectId).sendMessage(convId, instructions, { source: "scheduler" });
				} else {
					// Run the specified agent directly via runInlineAgent
					const { runInlineAgent, READ_ONLY_AGENTS } = await import("../agents/agent-loop");

					// Resolve provider config
					let providerRows = await db.select().from(aiProviders)
						.where(eq(aiProviders.isDefault, 1)).limit(1);
					if (providerRows.length === 0) {
						providerRows = await db.select().from(aiProviders).limit(1);
					}
					if (providerRows.length === 0) throw new Error("No AI providers configured");
					const providerRow = providerRows[0];
					const providerConfig = {
						id: providerRow.id,
						name: providerRow.name,
						providerType: providerRow.providerType,
						apiKey: providerRow.apiKey,
						baseUrl: providerRow.baseUrl,
						defaultModel: providerRow.defaultModel,
					};
					const modelId = providerRow.defaultModel ?? getDefaultModel(providerRow.providerType);

					// Resolve agent display name
					const agentRows = await db.select({ displayName: agentsTable.displayName })
						.from(agentsTable).where(eq(agentsTable.name, agentId)).limit(1);
					const agentDisplayName = agentRows[0]?.displayName ?? agentId;

					// Resolve project workspace path
					const projectRows = await db.select({ workspacePath: projects.workspacePath })
						.from(projects).where(eq(projects.id, projectId)).limit(1);
					const workspacePath = projectRows[0]?.workspacePath ?? undefined;

					const { id: convId } = await createConversation(projectId, `Scheduled: ${agentDisplayName}`);
					// Notify frontend so the new conversation appears in the sidebar
					broadcastToWebview("conversationUpdated", { conversationId: convId, updatedAt: new Date().toISOString(), projectId });

					const projectContext = [
						workspacePath ? `Workspace: ${workspacePath}` : "",
						`Project ID: ${projectId}`,
					].filter(Boolean).join("\n");

					// Register an AbortController so the Scheduler/Inbox Stop button and
					// stop-all work correctly. Chained to the job-level signal so the
					// Scheduler/Inbox Stop button cancels this run too.
					// isChatScoped: false — scheduled agent runs have their own
					// independent lifecycle/UI and must never block, or be blocked by, or
					// count toward, main-project-chat write-agent dispatches or "N agents
					// running" displays (the dashboard project cards no longer show this).
					const abortController = new AbortController();
					registerAgentController(projectId, abortController, agentId, convId, false);
					const onJobAbort = () => abortController.abort();
					abortSignal?.addEventListener("abort", onJobAbort);

					// Real broadcast callbacks — mirrors engine-manager.ts callbacks so
					// the frontend receives partCreated/partUpdated/agentInlineStart/etc.
					const callbacks = {
						onPartCreated: (part: MessagePart) => {
							broadcastToWebview("partCreated", {
								conversationId: convId,
								messageId: part.messageId,
								part: {
									id: part.id,
									type: part.type,
									content: part.content,
									toolName: part.toolName,
									toolInput: part.toolInput,
									toolOutput: part.toolOutput,
									toolState: part.toolState,
									sortOrder: part.sortOrder,
									agentName: part.agentName,
									timeStart: part.timeStart,
									timeEnd: part.timeEnd,
								},
							});
						},
						onPartUpdated: (messageId: string, partId: string, updates: Partial<MessagePart>) => {
							broadcastToWebview("partUpdated", {
								conversationId: convId,
								messageId,
								partId,
								updates: {
									content: updates.content,
									toolOutput: updates.toolOutput,
									toolState: updates.toolState,
									timeEnd: updates.timeEnd,
								},
							});
						},
						onTextDelta: (messageId: string, delta: string) => {
							broadcastToWebview("streamToken", {
								conversationId: convId,
								messageId,
								token: delta,
								agentId,
							});
						},
						onAgentStart: (messageId: string, agName: string, agDisplayName: string, task: string) => {
							broadcastToWebview("agentInlineStart", { conversationId: convId, messageId, agentName: agName, agentDisplayName: agDisplayName, task });
						},
						onAgentComplete: (messageId: string, agName: string, status: string, summary: string, _filesModified: string[], tokensUsed: { prompt: number; completion: number; contextLimit?: number }) => {
							broadcastToWebview("agentInlineComplete", { conversationId: convId, messageId, agentName: agName, status, summary, tokensUsed });
						},
						onMessageCreated: (messageId: string, cId: string, agName: string, content: string) => {
							broadcastToWebview("newMessage", {
								conversationId: cId,
								messageId,
								agentId: agName,
								agentName: agName,
								content,
								metadata: JSON.stringify({ source: "agent" }),
							});
						},
					};

					try {
						const result = await runInlineAgent({
							conversationId: convId,
							agentName: agentId,
							agentDisplayName,
							task: instructions,
							projectContext,
							providerConfig,
							modelId,
							readOnly: READ_ONLY_AGENTS.has(agentId),
							workspacePath: workspacePath ?? undefined,
							projectId,
							callbacks,
							abortSignal: abortController.signal,
						});
						if (result.status === "cancelled" && abortSignal?.aborted) {
							return { success: false, stopped: true, error: "STOPPED BY USER", durationMs: Date.now() - start };
						}
						output = `Agent task completed: ${result.status}`;
					} finally {
						abortSignal?.removeEventListener("abort", onJobAbort);
						unregisterAgentController(projectId, abortController);
					}
				}
				output = output || "Agent task dispatched";
				break;
			}

			case "agent_task_simple": {
				const instructions = config.instructions as string;
				const agentId = (config.agentId as string | undefined) || "project-manager";
				const jobName = (config._jobName as string | undefined) || "Agent Task";
				const simpleProjectId = config._projectId as string | undefined;
				const schedulerJobId = config._jobId as string | undefined;
				if (!instructions) throw new Error("agent_task_simple requires instructions");

				// Register an AbortController so stop-all works when this task is
				// associated with a project.
				const simpleAbortController = simpleProjectId ? new AbortController() : null;
				if (simpleProjectId && simpleAbortController) {
					// This mode is always project-less/conversation-less (see comment
					// above) — null means it's exempt from any conversation-scoped
					// abort and only reachable via this project's stopAllAgents.
					// isChatScoped: false — same reasoning as the agent_task branch
					// above, scheduled runs must never block, be blocked by, or count
					// toward main-project-chat write-agent dispatches or "N agents
					// running" displays.
					registerAgentController(simpleProjectId, simpleAbortController, agentId, null, false);
				}

				// Resolve provider
				let providerRows = await db.select().from(aiProviders)
					.where(eq(aiProviders.isDefault, 1)).limit(1);
				if (providerRows.length === 0) {
					providerRows = await db.select().from(aiProviders).limit(1);
				}
				if (providerRows.length === 0) throw new Error("No AI providers configured");
				const providerRow = providerRows[0];
				const modelId = providerRow.defaultModel ?? getDefaultModel(providerRow.providerType);
				const providerConfig = {
					id: providerRow.id,
					name: providerRow.name,
					providerType: providerRow.providerType,
					apiKey: providerRow.apiKey,
					baseUrl: providerRow.baseUrl,
					defaultModel: providerRow.defaultModel,
				};

				// Resolve the base system prompt. "project-manager" has no row in the
				// agents table (it's virtual) so it gets the REAL PM prompt via
				// getPMSystemPrompt instead, which also
				// yields working run_agent/run_agents_parallel dispatch tools below —
				// getPMSystemPrompt already appends its own skills + MCP sections, so
				// skip the separate build for this branch to avoid duplicating them.
				// This mode is always project-less (project-scoped dispatch already
				// exists via the "Agent Project Task" / agent_task type above) — dispatched
				// sub-agents run without a workspace, so file/shell-dependent agents
				// (e.g. code-explorer, backend-engineer) are not meaningfully usable here.
				let pmAgentNames: readonly string[] = [];
				let systemPrompt: string;
				if (agentId === "project-manager") {
					const { getPMSystemPrompt } = await import("../agents/prompts");
					const pmPrompt = await getPMSystemPrompt({}, [], "app");
					systemPrompt = pmPrompt.prompt;
					pmAgentNames = pmPrompt.agentNames;
				} else {
					// Resolve agent system prompt, then append skills + MCP context
					// so the agent knows what skills are available (same as project agents)
					const agentRows = await db.select({ systemPrompt: agentsTable.systemPrompt })
						.from(agentsTable).where(eq(agentsTable.name, agentId)).limit(1);
					const baseSystemPrompt = agentRows[0]?.systemPrompt ?? "";
					const { buildSkillsDescriptionSection, buildAgentMcpSection } = await import("../agents/prompts");
					const skillsSection = buildSkillsDescriptionSection();
					const mcpSection = await buildAgentMcpSection();
					systemPrompt = [baseSystemPrompt, skillsSection, mcpSection].filter(Boolean).join("\n\n---\n\n");
				}

				// Write user instruction to inbox
				const threadId = crypto.randomUUID();
				const { id: msgId } = await writeInboxMessage({
					channelId: "cron",
					sender: jobName,
					content: instructions,
					platform: "scheduler",
					threadId,
				});

				// Track this message as running for the given job so the Inbox page
				// can show a Stop button, including for auto-fired (non-manual) runs.
				if (schedulerJobId) {
					runningSchedulerMessages.set(msgId, schedulerJobId);
					broadcastToWebview("schedulerInboxRunState", { messageId: msgId, jobId: schedulerJobId, running: true });
				}

				// Run agent with full tool set (skills, MCP, plugins, web) — no project/conversation needed
				let responseText = "";
				try {
					const { getToolsForAgent } = await import("../agents/tools/index");
					const { getPluginTools } = await import("../agents/engine-types");
					const { getMcpTools } = await import("../mcp/client");
					const { isHaikuModel } = await import("../providers/claude-subscription");

					// Assemble the same tool set runInlineAgent uses: agent-specific tools +
					// plugin tools + MCP tools. Skills (read_skill, find_skills) are included
					// in getToolsForAgent so the agent can call skills like it would in a project.
					const { wrapToolsWithCallLogging } = await import("../agents/tool-call-logging");
					const baseTools = await getToolsForAgent(agentId);
					const pluginTools = await getPluginTools();
					const mcpTools = getMcpTools();
					let allTools = { ...baseTools, ...pluginTools, ...mcpTools };

					// PM gets real dispatch tools too — blocking run_agent/run_agents_parallel
					// (see agents/tools/simple-dispatch.ts for why dispatch must be blocking
					// here, unlike the real engine's fire-and-forget run_agent).
					if (agentId === "project-manager") {
						const { createSimpleDispatchTools } = await import("../agents/tools/simple-dispatch");
						allTools = {
							...allTools,
							...createSimpleDispatchTools({ providerConfig, agentNames: pmAgentNames }),
						};
					}
					allTools = wrapToolsWithCallLogging(allTools, agentId);

					// Claude Subscription's direct-HTTP OAuth path 429s for anything but
					// Haiku — non-Haiku models route through the official Agent SDK
					// instead. This branch genuinely dispatches sub-agents and uses
					// multi-step tool calls (not a bounded one-shot completion), so it
					// gets full CLI/SDK routing like runInlineAgent, not a Haiku-swap.
					if (providerRow.providerType === "claude-subscription" && !isHaikuModel(modelId)) {
						const { runClaudeCliTask } = await import("../providers/claude-subscription-cli-runner");
						const cliResult = await runClaudeCliTask({
							task: instructions,
							systemPrompt,
							tools: allTools,
							modelId,
							timeoutMs: 1_800_000,
							abortSignal,
							verifyToolCall: false, // a scheduled task may legitimately need zero tool calls (e.g. a plain reminder/summary)
							onText: (text) => { responseText += text; },
							onReasoning: () => { /* not surfaced today — this branch has no live streaming UI, matching the generateText path below */ },
							onToolCallStart: () => crypto.randomUUID(),
							onToolCallEnd: () => { /* no live UI broadcast today, matching the generateText path below */ },
						});
						if (cliResult.status === "cancelled") {
							responseText = "STOPPED BY USER";
						} else if (cliResult.status === "failed" || cliResult.status === "timeout") {
							responseText = `Error: ${cliResult.summary}`;
						} else if (!responseText.trim()) {
							responseText = cliResult.summary.trim();
						} else {
							responseText = responseText.trim();
						}
					} else {
						const { generateText } = await import("ai");
						const adapter = createProviderAdapter(providerConfig);
						const result = await generateText({
							model: adapter.createModel(modelId),
							instructions: systemPrompt,
							prompt: instructions,
							tools: allTools,
							abortSignal,
							// Stop when the model produces a final text response with no tool calls
							stopWhen: [
								({ steps }) => {
									if (steps.length === 0) return false;
									const last = steps[steps.length - 1];
									return !last.toolCalls || last.toolCalls.length === 0;
								},
							],
						});
						responseText = result.text.trim();
					}
				} catch (err) {
					responseText = abortSignal?.aborted
						? "STOPPED BY USER"
						: `Error: ${err instanceof Error ? err.message : String(err)}`;
				} finally {
					// Always unregister controller so the dashboard badge clears
					if (simpleProjectId && simpleAbortController) {
						unregisterAgentController(simpleProjectId, simpleAbortController);
					}
					if (schedulerJobId) {
						runningSchedulerMessages.delete(msgId);
						broadcastToWebview("schedulerInboxRunState", { messageId: msgId, jobId: schedulerJobId, running: false });
					}
				}

				// Log task + final answer together so Analytics' Messages tab shows the
				// full exchange, not just what was asked.
				await logPrompt(
					`${agentId} (scheduler:${jobName})`,
					systemPrompt,
					[{ role: "user", content: instructions }, { role: "assistant", content: responseText }],
					modelId,
				);

				// Update inbox message with agent response (shows "Replied" badge)
				if (responseText) {
					await updateAgentResponse(msgId, responseText);
				}

				if (responseText === "STOPPED BY USER") {
					return { success: false, stopped: true, error: responseText, durationMs: Date.now() - start };
				}

				// Desktop notification
				const notifSuccess = !responseText.startsWith("Error:");
				await sendDesktopNotification(
					notifSuccess ? `✓ ${jobName}` : `✗ ${jobName} failed`,
					notifSuccess ? "Task executed successfully" : responseText.slice(0, 120),
				).catch(() => {});

				// Broadcast result to all connected channels
				if (notifSuccess && responseText) {
					const { broadcastSchedulerResult } = await import("../channels/manager");
					await broadcastSchedulerResult(jobName, responseText).catch(() => {});
				}

				output = notifSuccess ? `Executed successfully` : responseText;
				if (!notifSuccess) throw new Error(responseText);
				break;
			}

			case "send_channel_message": {
				const { sendChannelMessage } = await import("../channels/manager");
				const channelId = config.channelId as string;
				const content = config.content as string;
				if (!channelId || !content) throw new Error("send_channel_message requires channelId and content");
				await sendChannelMessage(channelId, content);
				output = `Message sent to channel ${channelId}`;
				break;
			}

			default:
				throw new Error(`Unknown task type: ${taskType}`);
		}

		return { success: true, output, durationMs: Date.now() - start };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - start,
		};
	}
}
