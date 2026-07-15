import { streamText, isStepCount } from "ai";

// ---------------------------------------------------------------------------
// /preview slash-command — full instructions passed silently to the PM
// ---------------------------------------------------------------------------
function getPreviewPrompt(_projectId: string): string {
	return `The user ran /preview. Call the \`preview_project\` tool immediately — it handles project detection, server startup, browser navigation, screenshot, and annotation toolbar injection automatically. No sub-agents needed. After the tool returns, summarise in one short sentence (project type + URL) and tell the user the annotation toolbar is active and will persist across refresh and navigation.`;
}
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { messages, conversations, settings, aiProviders, projects, agents, kanbanTasks, modelPreferences, messageParts } from "../db/schema";
import { createProviderAdapter } from "../providers";
import { recordModelUsageHandler } from "../rpc/providers";
import { getDefaultModel, getContextLimit } from "../providers/models";
import { isHaikuModel } from "../providers/claude-subscription";
import { buildContext } from "./context";
import { getPMSystemPrompt } from "./prompts";
import { summarizeConversation } from "./summarizer";
import { createPMTools } from "./tools/pm-tools";
import { kanbanTools } from "./tools/kanban";
import { notesTools } from "./tools/notes";
import { fileOpsTools } from "./tools/file-ops";
import { screenshotTools } from "./tools/screenshot";
import { audioTools } from "./tools/audio";
import { buildMediaFollowUpMessage } from "./tools/media-followup";
import { skillTools } from "./tools/skills";
import { createPreviewTool } from "./tools/preview";
import { isTransientError, getBackoffDelay } from "./safety";
import { logPrompt } from "./prompt-logger";
import { getStreamingMode } from "./streaming-mode";
import { createThrottledAccumulator } from "./throttled-accumulator";
import { eventBus } from "../scheduler";
import type { AgentActivityEvent } from "./types";
import { toolResultIsError, type InlineAgentCallbacks, type MessagePart } from "./agent-loop";
import { wrapToolsWithCallLogging } from "./tool-call-logging";
import {
	getPluginTools,
	THINKING_BUDGET_TOKENS,
	buildPMThinkingOptions,
	extractPMReasoning,
	applyAnthropicCaching,
	DEFAULT_METADATA,
} from "./engine-types";
import type { MessageMetadata, AgentEngineCallbacks } from "./engine-types";

// Re-export types so downstream imports (`engine-manager.ts`, `pm-tools.ts`) keep working.
export type { MessageMetadata, AgentEngineCallbacks, QueueEntry } from "./engine-types";

// ---------------------------------------------------------------------------
// AgentEngine
// ---------------------------------------------------------------------------

/** PM streaming coordinator for a single project. */
export class AgentEngine {
	private readonly projectId: string;
	private readonly callbacks: AgentEngineCallbacks;

	/** AbortController for the current Project Manager generation */
	private pmAbort: AbortController | null = null;

	/** Whether the Project Manager is currently streaming a response */
	private pmProcessing = false;
	private pmProcessingPromise: Promise<void> | null = null;

	/**
	 * Last real prompt-token usage reported by the provider, per conversation —
	 * the SAME figure the UI context bar shows. Compaction triggers measure
	 * against this (in addition to the text-only char estimate) so a tool-heavy
	 * turn (e.g. the kanban auto-execute loop, where tool I/O dominates the real
	 * prompt but barely touches stored message text) actually compacts instead of
	 * sitting pinned at 100% on the bar while the char estimate stays low.
	 */
	private lastPromptTokens = new Map<string, number>();
	/** Injected function to abort all running sub-agents for this project. */
	private abortAgentsFn?: (projectId: string) => void;

	/** The conversation the PM is currently operating on (set during sendMessage) */
	private activeConversationId: string | null = null;

	/** Task conversation an agent is actively working in (set by pm-tools when task conv is created). */
	activeAgentConversationId: string | null = null;

	/** Source metadata for the current message being processed */
	private activeMetadata: MessageMetadata = DEFAULT_METADATA;

	/** Set to true by stopAll() — causes inline agent launches to bail out */
	private stopped = false;

	/** Register/unregister abort controllers for running agents (set by engine-manager). */
	registerAgentAbort: ((controller: AbortController, agentName: string) => void) | null = null;
	unregisterAgentAbort: ((controller: AbortController) => void) | null = null;

	constructor(projectId: string, callbacks: AgentEngineCallbacks) {
		this.projectId = projectId;
		this.callbacks = callbacks;
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/** Process a user message: persist, stream PM response, persist result. */
	async sendMessage(conversationId: string, content: string, metadata?: Partial<MessageMetadata>): Promise<{ messageId: string; userMessageId: string }> {
		console.log(`[Engine] sendMessage: "${content.slice(0, 50)}" | pmProcessing=${this.pmProcessing} | hasPmPromise=${!!this.pmProcessingPromise}`);
		// A new user message clears any prior stop so PM can respond normally.
		this.stopped = false;

		const isAgentReport = (metadata as Record<string, unknown> | undefined)?.type === "agent_report";

		// Abort any in-progress PM stream + running sub-agents so the new message takes priority.
		// Skip abort for agent reports — a review-cycle agent may be running and shouldn't be killed.
		this.pmAbort?.abort();
		if (!isAgentReport) {
			this.abortAgentsFn?.(this.projectId);
		}

		// Wait for previous processing to fully complete before starting new.
		// Without this, two PM processes run concurrently and the old one writes
		// a stale response that ignores the user's latest message.
		// The wait is short since we already aborted everything above.
		if (this.pmProcessingPromise) {
			console.log("[Engine] Waiting for previous PM processing to complete...");
			await this.pmProcessingPromise.catch(() => {});
			console.log("[Engine] Previous PM processing completed");
		}

		// Set processing flag synchronously before any awaits so concurrent
		// sendMessage calls (e.g. double-click, two rapid events) see it immediately.
		this.pmProcessing = true;
		this.pmAbort = new AbortController();

		// Install a lock promise immediately so back-to-back sendMessage calls wait on each other.
		let lockResolve!: () => void;
		const lockPromise = new Promise<void>((r) => { lockResolve = r; });
		const prevPromise = this.pmProcessingPromise;
		this.pmProcessingPromise = lockPromise;
		this.activeConversationId = conversationId;
		this.activeMetadata = { ...DEFAULT_METADATA, ...metadata };

		const userMessageId = crypto.randomUUID();
		const assistantMessageId = crypto.randomUUID();

		// 1. Persist user message (fast — returns before AI call)
		// Verify conversation still exists to avoid FK constraint failures
		// (can happen if conversation was deleted while an agent was running)
		const convExists = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
		if (convExists.length === 0) {
			console.warn(`[Engine] Conversation ${conversationId} no longer exists — skipping sendMessage`);
			return { messageId: assistantMessageId, userMessageId };
		}
		// An empty message persists as an empty text content block, which every
		// provider rejects — and once persisted it poisons this conversation's
		// history for every future send, not just this one. Reject at the source
		// rather than relying on each individual caller (chat UI, scheduler,
		// channels, agent reports) to have already guarded against it.
		if (!content) {
			console.warn(`[Engine] sendMessage: empty content for conversation ${conversationId} — skipping`);
			// Release the processing lock set above — otherwise every later
			// sendMessage call on this engine waits forever on a promise nothing
			// ever resolves (this is a bail-out before the normal lockResolve()
			// callsite further down, which only runs once real PM processing settles).
			this.pmProcessing = false;
			lockResolve();
			if (this.pmProcessingPromise === lockPromise) this.pmProcessingPromise = null;
			return { messageId: assistantMessageId, userMessageId };
		}
		await db.insert(messages).values({
			id: userMessageId,
			conversationId,
			role: "user",
			agentId: null,
			content,
			metadata: metadata ? JSON.stringify(metadata) : null,
			tokenCount: Math.ceil(content.length / 4),
			createdAt: new Date().toISOString(),
		});

		// Bump conversation updatedAt so it sorts to top in the sidebar
		this._touchConversation(conversationId);

		// Title the conversation immediately from the first real user message
		if (!isAgentReport) {
			this.autoTitleConversation(conversationId, content).catch(() => {});
		}

		// 2. Insert placeholder assistant message (updated after streaming)
		await db.insert(messages).values({
			id: assistantMessageId,
			conversationId,
			role: "assistant",
			agentId: null,
			content: "",
			metadata: null,
			tokenCount: 0,
			createdAt: new Date().toISOString(),
		});

		// Soft approval gate: if a workflow is awaiting approval, check for
		// clear approval/rejection keywords before invoking the PM.
		console.log(`[Engine] Checking approval gate for: "${content.slice(0, 50)}"`);
		// Kick off the slow AI work in background so the RPC returns immediately.
		// Replace the lock promise with the real processing promise.
		// The lock is resolved when the real promise settles so any caller
		// awaiting pmProcessingPromise unblocks at the right time.
		void prevPromise; // already awaited above if it existed
		const realPromise = this._runPMProcessing(assistantMessageId, conversationId, content, userMessageId)
			.catch(() => {})
			.finally(() => {
				lockResolve();
				if (this.pmProcessingPromise === realPromise) {
					this.pmProcessingPromise = null;
				}
			});
		this.pmProcessingPromise = realPromise;

		return { messageId: assistantMessageId, userMessageId };
	}

	private async _runPMProcessing(
		assistantMessageId: string,
		conversationId: string,
		content: string,
		userMessageId?: string,
	): Promise<void> {
		const abortController = this.pmAbort;
		try {
			// ---------------------------------------------------------------------------
			// Slash-command: /info — hardcoded handler, no LLM call required.
			// Matches any casing, leading/trailing whitespace. E.g. " /info ", "/INFO"
			// Channel messages arrive prefixed: "[discord] senderName: /info" — strip prefix first.
			// ---------------------------------------------------------------------------
			const channelPrefixMatch = content.match(/^\[(?:discord|whatsapp|email)[^\]]*\] [^:]+: ([\s\S]*)$/);
			const rawUserContent = channelPrefixMatch ? channelPrefixMatch[1].trim() : content.trim();
			if (rawUserContent.toLowerCase() === "/info") {
				const response = await this._handleStatusCommand();
				await db.update(messages).set({ content: response, tokenCount: Math.ceil(response.length / 4) }).where(eq(messages.id, assistantMessageId));
				this._touchConversation(conversationId);
				this.callbacks.onStreamComplete(conversationId, assistantMessageId, { content: response, promptTokens: 0, completionTokens: 0 });
				return;
			}

			// /preview — silently replace the user message in DB with the full preview
			// instructions before the PM reads context, so the chat bubble stays clean
			// ("/preview") but the PM receives the complete prompt.
			if (rawUserContent.toLowerCase() === "/preview" && userMessageId) {
				const previewPrompt = getPreviewPrompt(this.projectId);
				await db.update(messages)
					.set({ content: previewPrompt, tokenCount: Math.ceil(previewPrompt.length / 4) })
					.where(eq(messages.id, userMessageId));
			}

			// 3. Load Project Manager system prompt and resolve provider / model
			const [projectRows, pmAgentRows, projectBudgetRows, chatThinkingRows, planModeRows] = await Promise.all([
				db.select({ name: projects.name, description: projects.description, workspacePath: projects.workspacePath, githubUrl: projects.githubUrl, workingBranch: projects.workingBranch, isQuickChat: projects.isQuickChat }).from(projects).where(eq(projects.id, this.projectId)).limit(1),
				db.select({ thinkingBudget: agents.thinkingBudget, color: agents.color }).from(agents).where(eq(agents.name, "project-manager")).limit(1),
				db.select({ value: settings.value }).from(settings).where(eq(settings.key, `project:${this.projectId}:thinkingBudget`)).limit(1),
				db.select({ value: settings.value }).from(settings).where(eq(settings.key, `project:${this.projectId}:chatThinkingLevel`)).limit(1),
				db.select({ value: settings.value }).from(settings).where(eq(settings.key, `project:${this.projectId}:planMode`)).limit(1),
			]);
			const planMode = planModeRows[0]?.value === "true";
			const projectRow = projectRows[0];
			const workspacePath = projectRow?.workspacePath;
			// Derived per-turn (not cached on the engine instance) so promoting a Quick
			// Chat project to a normal one re-enables Kanban on the very next PM turn.
			const quickChat = projectRow?.isQuickChat === 1;
			const chatThinkingLevel: string | null = chatThinkingRows[0]?.value || null;
			const projectThinkingBudget: string | null = projectBudgetRows[0]?.value ?? null;
			// Chat-level thinking override takes priority over agent/project defaults
			const pmThinkingBudget = chatThinkingLevel ?? pmAgentRows[0]?.thinkingBudget ?? projectThinkingBudget;
			const pmColor = pmAgentRows[0]?.color ?? "#6366f1";
			const pluginTools = await getPluginTools();
			const directTools = Object.entries(pluginTools).map(([name, tool]) => ({
				name,
				description: (tool as { description?: string }).description ?? name,
			}));
			const { prompt: systemPrompt, agentNames: pmAgentNames } = await getPMSystemPrompt(
				{ id: this.projectId, name: projectRow?.name, description: projectRow?.description ?? undefined, workspacePath, githubUrl: projectRow?.githubUrl ?? undefined, workingBranch: projectRow?.workingBranch ?? undefined },
				directTools,
				this.activeMetadata?.source ?? "app",
				planMode,
				quickChat,
			);
			const { row: providerRow, modelId } = await this.getDefaultProviderRow();

			// Record this model as just-used so it surfaces in the chat picker's
			// "Latest" section. Fire-and-forget — never block the PM turn on it.
			recordModelUsageHandler({ providerId: providerRow.id, modelId }).catch(() => {});

			// 4. Build context once — reuse tokenCount for compaction threshold check
			//    (previously loaded messages separately for estimation, causing a double query)
			let context = await buildContext({
				conversationId,
				systemPrompt,
				constitution: "",
				modelId,
			});

			// 4.1. Next-turn compaction — ONE limit (`contextWindowLimit`) governs both
			// the context bar and compaction. We measure the REAL last-turn prompt
			// tokens (exactly what the bar shows, tool I/O included) against that limit,
			// falling back to the char estimate when no real figure exists yet. At/over
			// 100% of the limit we compact HERE — at the start of this (the next) turn,
			// before streaming — never mid-stream. Set the limit at or below your
			// model's true window so the turn that reaches it doesn't itself overflow.
			{
				const limit = getContextLimit(modelId, this.projectId);
				const lastReal = this.lastPromptTokens.get(conversationId) ?? 0;
				const effectiveTokens = Math.max(context.tokenCount, lastReal);
				if (effectiveTokens >= limit) {
					console.log(`[AgentEngine] Compaction: ~${effectiveTokens} tokens (estimate ${context.tokenCount}, last real ${lastReal}) >= ${limit} context window limit`);
					this.callbacks.onCompactionStarted?.(conversationId);
					await this.triggerSummarization(conversationId, providerRow, modelId);
					context = await buildContext({ conversationId, systemPrompt, constitution: "", modelId });
					// If the durable history STILL exceeds the window after compaction,
					// there's nothing left to safely trim — ask for a fresh conversation.
					const afterReal = this.lastPromptTokens.get(conversationId) ?? 0;
					if (Math.max(context.tokenCount, afterReal) >= limit) {
						throw new Error(
							`Context window is full even after compacting. Your Context Window Limit (${Math.round(limit / 1000)}k tokens) is too low for this model — raise it in this project's Settings → AI → "Context Window Limit" (set it to your model's window, e.g. 1,000,000), then Retry. Or start a new conversation.`,
						);
					}
				}
			}

			// 5. Create provider adapter + model instance
			// Claude Subscription's direct-HTTP OAuth path 429s for anything but
			// Haiku (see isHaikuModel doc comment) — non-Haiku models route through
			// the Agent SDK instead, mirroring the sub-agent path in agent-loop.ts.
			const isClaudeSubscriptionViaCli =
				providerRow.providerType === "claude-subscription" && !isHaikuModel(modelId);
			const adapter = isClaudeSubscriptionViaCli ? null : createProviderAdapter({
				id: providerRow.id,
				name: providerRow.name,
				providerType: providerRow.providerType,
				apiKey: providerRow.apiKey,
				baseUrl: providerRow.baseUrl,
				defaultModel: providerRow.defaultModel,
			});
			const pmCustomThinkingTokens =
				providerRow.providerType === "custom" && pmThinkingBudget
					? (THINKING_BUDGET_TOKENS[pmThinkingBudget] ?? 8000)
					: undefined;
			let reasoningEmittedFromStream = false;
			const model = adapter ? adapter.createModel(modelId, pmCustomThinkingTokens) : null;
			// Read once, shared by both the CLI branch below and the streamText
			// branch further down — see docs/... global "Streaming" setting.
			const streamingMode = await getStreamingMode();
			const isFullStreaming = streamingMode === "full";
			const isNoStreaming = streamingMode === "none";

			// 6. Build inline agent callbacks that bridge to RPC broadcasts
			const emit = (agentId: string, agentName: string, type: AgentActivityEvent["type"], data: Record<string, unknown>) => {
				this.callbacks.onAgentActivity?.({ projectId: this.projectId, conversationId, agentId, agentName, agentColor: pmColor, type, data, timestamp: new Date().toISOString() });
			};
			const inlineCallbacks: InlineAgentCallbacks = {
				onPartCreated: (part: MessagePart) => {
					emit(part.agentName ?? "unknown", part.agentName ?? "unknown", "tool_call", { partCreated: true, partId: part.id, messageId: part.messageId, partType: part.type, toolName: part.toolName, toolInput: part.toolInput, sortOrder: part.sortOrder });
					this.callbacks.onPartCreated?.(conversationId, part);
				},
				onPartUpdated: (_mid: string, partId: string, updates: Partial<MessagePart>) => {
					emit("system", "system", "tool_result", { partUpdated: true, partId, ...updates });
					this.callbacks.onPartUpdated?.(conversationId, _mid, partId, updates);
				},
				onTextDelta: (mid: string, delta: string) => { this.callbacks.onStreamToken(conversationId, mid, delta, null); },
				onAgentStart: (mid: string, an: string, adn: string, task: string) => {
					emit(an, adn, "info", { agentInlineStart: true, messageId: mid, agentName: an, agentDisplayName: adn, task });
					this.callbacks.onAgentInlineStart?.(conversationId, mid, an, adn, task);
				},
				onAgentComplete: (mid: string, an: string, status: string, summary: string, filesModified: string[], tokensUsed: { prompt: number; completion: number; contextLimit?: number }) => {
					emit(an, an, "info", { agentInlineComplete: true, messageId: mid, agentName: an, status, summary, filesModified, tokensUsed });
					this.callbacks.onAgentInlineComplete?.(conversationId, mid, an, status, summary, tokensUsed);
					if (status === "completed") eventBus.emit({ type: "agent:completed", projectId: this.projectId, agentId: an, taskId: "" });
				},
				onMessageCreated: (mid: string, convId: string, an: string, content: string) => {
					this.callbacks.onNewMessage?.({
						conversationId: convId,
						messageId: mid,
						agentId: an,
						agentName: an,
						content,
						metadata: JSON.stringify({ source: "agent" }),
					});
				},
				// Live context-bar updates while a sub-agent runs (not just at completion).
				onStepUsage: (promptTokens: number, contextLimit: number) => {
					this.callbacks.onContextUsage?.(conversationId, promptTokens, contextLimit);
				},
			};

			// 7. Create PM tools — inline execution via run_agent / run_agents_parallel
			const providerConfig = {
				id: providerRow.id,
				name: providerRow.name,
				providerType: providerRow.providerType,
				apiKey: providerRow.apiKey,
				baseUrl: providerRow.baseUrl,
				defaultModel: providerRow.defaultModel,
			};

			const pmTools = wrapToolsWithCallLogging({
				...createPMTools({
					projectId: this.projectId,
					conversationId,
					workspacePath: workspacePath ?? undefined,
					getActiveMetadata: () => this.getActiveMetadata(),
					inlineAgentCallbacks: inlineCallbacks,
					providerConfig,
					askUserQuestion: this.callbacks.askUserQuestion
						// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
						? (payload) => this.callbacks.askUserQuestion!({
							...payload,
							projectId: this.projectId,
							agentId: "project-manager",
							agentName: "Project Manager",
						})
						: undefined,
					emitPMActivity: (type, data) => {
						this.callbacks.onAgentActivity?.({
							projectId: this.projectId,
							conversationId,
							agentId: "project-manager",
							agentName: "project-manager",
							agentColor: pmColor,
							type,
							data,
							timestamp: new Date().toISOString(),
						});
					},
					emitNewMessage: (params) => {
						this.callbacks.onNewMessage?.({ conversationId, ...params });
					},
					registerAgentAbort: this.registerAgentAbort ?? undefined,
					unregisterAgentAbort: this.unregisterAgentAbort ?? undefined,
					stopPMStream: () => {
						planApprovalRequested = true;
						console.log("[Engine] PM stream will stop after current step");
					},
					planMode,
					quickChat,
					agentNames: pmAgentNames.length > 0 ? pmAgentNames : undefined,
					// Pass the original user message so sub-agents get the user's exact words
					// appended to their task prompt (only for direct queries, not kanban tasks).
					// Agent reports start with "[Agent Report]" — skip those.
					lastUserMessage: content.startsWith("[Agent Report]") ? undefined : content,
					onAgentDone: async (agentName, displayName, result) => {
						// Delay to let review cycle spawn (it does async DB lookups)
						// and agent completion events propagate to frontend
						await new Promise((r) => setTimeout(r, 500));

						// A user-initiated cancellation must not auto-continue — clicking
						// Stop means "stop everything," not "move on to the next task."
						// Without this, only `status === "failed"` skipped the DISPATCH/
						// next-task logic below, so a cancelled agent still fell through to
						// it and the PM auto-continued to another task right after the user
						// asked it to stop.
						if (result.status === "cancelled") {
							console.log(`[Engine] Agent cancelled by user (${agentName}) — not auto-continuing`);
							return;
						}

						const summary = result.status === "completed"
							? `${displayName} completed successfully: ${result.summary}`
							: `${displayName} ${result.status}: ${result.summary}`;
						const filesInfo = result.filesModified.length > 0
							? `\nFiles modified: ${result.filesModified.join(", ")}`
							: "";

						// Compute next action so PM doesn't need to call get_next_task.
						// When the agent failed, skip DISPATCH hints — let PM investigate the
						// failure first rather than blindly re-dispatching (infinite failure loop).
						const agentFailed = result.status === "failed";
						let nextAction = "";
						if (agentFailed) {
							nextAction = `\n\n[Next Action] INVESTIGATE — ${displayName} failed. Review the error above and decide whether to retry, fix, or skip. Do NOT automatically re-dispatch without understanding the failure.`;
						}
						// Quick Chat has no kanban board — skip the lookup entirely rather than
						// let `allTasks.every(...)` on an empty array vacuously report "ALL DONE".
						if (!agentFailed && !quickChat) {
						try {
							const { getRunningAgentCount } = await import("../engine-manager");
							const agentsRunning = getRunningAgentCount(this.projectId);

							const allTasks = await db
								.select({ id: kanbanTasks.id, title: kanbanTasks.title, column: kanbanTasks.column, assignedAgentId: kanbanTasks.assignedAgentId, blockedBy: kanbanTasks.blockedBy, createdAt: kanbanTasks.createdAt })
								.from(kanbanTasks)
								.where(eq(kanbanTasks.projectId, this.projectId));
							const doneTasks = new Set(allTasks.filter(t => t.column === "done").map(t => t.id));
							const inReview = allTasks.filter(t => t.column === "review");
							const inWorking = allTasks.filter(t => t.column === "working").sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
							const inBacklog = allTasks.filter(t => t.column === "backlog").sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

							if (inReview.length > 0) {
								if (agentsRunning > 0) {
									nextAction = `\n\n[Next Action] WAIT — ${inReview.length} task(s) in review: ${inReview.map(t => t.title).join(", ")}. Code review agent is running. Do NOT dispatch any agents until review completes.`;
								} else {
									// Review task exists but no agent running — reviewer may have crashed/been aborted.
									// Tell PM to trigger review manually.
									nextAction = `\n\n[Next Action] REVIEW NEEDED — ${inReview.length} task(s) in review but no review agent is running (may have been interrupted). Dispatch code-reviewer agent via run_agent for task: "${inReview[0].title}" (${inReview[0].id})`;
								}
							} else if (agentsRunning > 0) {
								nextAction = `\n\n[Next Action] WAIT — an agent is still running. Wait for it to complete.`;
							} else if (inWorking.length > 0) {
								const t = inWorking[0];
								// Agent completed but task is still in "working" — agent likely forgot to
								// call move_task. Do NOT re-dispatch (creates infinite loop). Tell PM to
								// move it to "review" so the review cycle picks it up.
								nextAction = `\n\n[Next Action] MOVE TO REVIEW — ${displayName} completed but task "${t.title}" (${t.id}) is still in "working" column (agent likely forgot to move it). Call move_task with column="review" for this task so code review can begin. Do NOT call run_agent.`;
							} else {
								const unblocked = inBacklog.find(t => {
									if (!t.blockedBy) return true;
									try { return (JSON.parse(t.blockedBy) as string[]).every(id => doneTasks.has(id)); } catch { return true; }
								});
								if (unblocked) {
									nextAction = `\n\n[Next Action] DISPATCH — next backlog task: "${unblocked.title}" (${unblocked.id}) with agent ${unblocked.assignedAgentId ?? "backend-engineer"}`;
								} else if (allTasks.every(t => t.column === "done")) {
									nextAction = `\n\n[Next Action] ALL DONE — all ${allTasks.length} tasks completed. Summarize results to the user.`;
								} else {
									nextAction = `\n\n[Next Action] BLOCKED — remaining tasks are blocked by incomplete dependencies.`;
								}
							}
						} catch { /* non-fatal — PM can still call get_next_task */ }
						} // end if (!agentFailed && !quickChat)

						// Auto-execute gate (read live so the Project Settings toggle
						// applies immediately). When off, never auto-dispatch the NEXT
						// backlog task — the user steps through tasks with "continue".
						// Only the "DISPATCH next backlog task" decision is gated;
						// REVIEW NEEDED / MOVE TO REVIEW / WAIT / ALL DONE / INVESTIGATE
						// complete the current task's lifecycle and are left untouched.
						if (nextAction.includes("[Next Action] DISPATCH")) {
							const { isAutoExecuteEnabled } = await import("../rpc/projects");
							if (!(await isAutoExecuteEnabled(this.projectId))) {
								nextAction = `\n\n[Next Action] PAUSED — auto-execute is off. This task is complete and more tasks remain, but they will NOT start automatically. Tell the user the task is done and that they can say "continue" to work on the next task. Do NOT call run_agent.`;
							}
						}

						// Don't restart PM if next action is WAIT — review cycle will
						// trigger PM via triggerPMAutoContinue when review completes.
						if (nextAction.includes("[Next Action] WAIT")) {
							console.log(`[Engine] Agent done (${agentName}), skipping PM restart — review in progress`);
							return;
						}

						// Inject active todo status so PM knows list_id + remaining items
						let todoStatus = "";
						try {
							const { getActiveTodoStatus } = await import("./tools/pm-tools");
							todoStatus = await getActiveTodoStatus(conversationId);
						} catch { /* non-fatal */ }

						console.log(`[Engine] Agent done, restarting PM: ${agentName} (${result.status})`);
						// Pass type + channel metadata together. type:"agent_report" is detected
						// at line 79 to skip aborting review-cycle agents. Channel source/channelId
						// are preserved so PM can relay its response back to the originating channel.
						const agentReportMeta = {
							type: "agent_report",
							...(this.activeMetadata.channelId
								? { source: this.activeMetadata.source, channelId: this.activeMetadata.channelId }
								: {}),
						};
						this.sendMessage(conversationId, `[Agent Report] ${summary}${filesInfo}${todoStatus}${nextAction}`, agentReportMeta as Partial<MessageMetadata>).catch((err) => {
							console.error(`[Engine] Failed to restart PM after agent:`, err);
						});
					},
				}),
				// Direct kanban access (read-only + commit-from-plan). The PM does NOT
				// get create_task — task creation is restricted to the task-planner.
				// To add a task, the PM spawns task-planner via run_agent.
				// Omitted entirely in Quick Chat — there is no kanban board.
				...(quickChat ? {} : {
					list_tasks: kanbanTools.list_tasks.tool,
					get_task: kanbanTools.get_task.tool,
				}),
				// Docs access
				list_docs: notesTools.list_docs.tool,
				get_doc: notesTools.get_doc.tool,
				// Direct file tools (read-only)
				read_file: fileOpsTools.read_file.tool,
				file_info: fileOpsTools.file_info.tool,
				directory_tree: fileOpsTools.directory_tree.tool,
				search_files: fileOpsTools.search_files.tool,
				search_content: fileOpsTools.search_content.tool,
				checksum: fileOpsTools.checksum.tool,
				// Read attached/referenced images (requires a vision-capable model)
				read_image: screenshotTools.read_image.tool,
				// Read attached/referenced audio (requires an audio-capable model; WAV/MP3 only)
				read_audio: audioTools.read_audio.tool,
				// Skill tools
				read_skill: skillTools.read_skill.tool,
				read_skill_file: skillTools.read_skill_file.tool,
				find_skills: skillTools.find_skills.tool,
				validate_skill: skillTools.validate_skill.tool,
				// Preview tool
				preview_project: createPreviewTool(this.projectId, workspacePath ?? "", conversationId, providerConfig),
				...(await getPluginTools()),
			}, "project-manager");

			// 8. Stream Project Manager response
			let fullText = "";
			let promptTokens = 0;
			let completionTokens = 0;
			let accumulatedReasoning = ""; // Persisted in message metadata for UI replay
			let planApprovalRequested = false; // Set by run_agent tool execute — stops PM after current step

			// Media tools the PM can call directly (generate_image, read_image, read_audio)
			// get persisted as message_parts so they render inline in the main chat exactly
			// like sub-agent tool calls already do (message-parts.tsx/tool-call-card.tsx are
			// fully generic over this — zero frontend changes needed). Deliberately narrow to
			// media tools only: every other PM tool call intentionally stays "thinking"-only,
			// per the v2 declutter decision (see emitActivity below) — this isn't reintroducing
			// that, just carving out the one category that has real visual content to show.
			// Shared across both the CLI-path branch (8a) and the streamText branch (8b) below.
			const MEDIA_TOOLS = new Set(["generate_image", "read_image", "read_audio"]);
			let mediaPartSortOrder = 0;
			const mediaPartIdByCallId = new Map<string, string>();
			let pmHasPartsSet = false;

			// --- 8a. Claude Subscription non-Haiku models: execute via the Agent
			// SDK instead of the streamText() loop below (see isClaudeSubscriptionViaCli
			// above). Known, disclosed limitations vs. the normal PM loop — the SDK's
			// query() runs its own opaque multi-step agent loop with no per-step hooks,
			// so these streamText-loop-specific refinements are NOT reimplemented here
			// (same tradeoff already accepted for the sub-agent path in agent-loop.ts):
			// hallucination-retry/dispatch-enforcement, mid-stream plan-approval
			// early-stop, and the post-stream dispatch correction (step 11 below). Core
			// flow — response generation, real tool execution (including run_agent,
			// which dispatches sub-agents exactly as it does on the normal path since
			// it's the same Tool object), and persistence — all work.
			if (isClaudeSubscriptionViaCli) {
				const { runClaudeCliTask } = await import("../providers/claude-subscription-cli-runner");
				// The SDK's query() takes a single prompt, not a ModelMessage[] — flatten
				// the already-compacted conversation history into a text transcript.
				const transcript = context.messages.map((m) => {
					const text = typeof m.content === "string"
						? m.content
						: Array.isArray(m.content)
							? m.content.map((p) => (p && typeof p === "object" && "text" in p ? (p as { text?: string }).text ?? "" : "")).filter(Boolean).join("\n")
							: "";
					return `[${m.role}]\n${text}`;
				}).join("\n\n");

				const emitActivity = (type: AgentActivityEvent["type"], data: Record<string, unknown>) => {
					this.callbacks.onAgentActivity?.({
						projectId: this.projectId, conversationId, agentId: "project-manager",
						agentName: "project-manager", agentColor: pmColor, type, data,
						timestamp: new Date().toISOString(),
					});
				};
				const STATUS_CHECK_TOOLS = new Set(["list_tasks", "get_task"]);
				const toolCallNames = new Map<string, string>();

				this.callbacks.onStreamReset(conversationId, assistantMessageId);
				await logPrompt("PM", context.instructions, context.messages, providerRow.defaultModel ?? "default");

				// Full Streaming support — only ever active when the user has opted
				// in; Hybrid/No Streaming leave onText/onReasoning below completely
				// unchanged (today's exact single-dump-at-the-end behavior). See
				// agent-loop.ts's identical mechanism for sub-agents — this is the
				// flat-message-content counterpart (PM's message has no parts array).
				let flushedTextLength = 0;
				const textAcc = isFullStreaming ? createThrottledAccumulator((acc) => {
					// onStreamToken APPENDS the given token client-side — unlike the
					// parts-based onPartUpdated, it is not a full-content replace — so
					// only the slice new since the last flush is ever sent.
					const delta = acc.slice(flushedTextLength);
					flushedTextLength = acc.length;
					if (delta) this.callbacks.onStreamToken(conversationId, assistantMessageId, delta, null);
				}) : null;
				const reasoningAcc = isFullStreaming ? createThrottledAccumulator((acc) => {
					// emitActivity("thinking", ...) REPLACES the displayed text each
					// call (matches the existing streamText branch's own emitThinking
					// below) — so the full accumulated value is sent, not a delta.
					emitActivity("thinking", { text: acc, isPartial: true });
				}) : null;

				const cliResult = await runClaudeCliTask({
					task: transcript || content,
					systemPrompt: context.instructions ?? "",
					tools: pmTools,
					modelId,
					workspacePath,
					timeoutMs: 1_800_000,
					abortSignal: abortController?.signal,
					// Most PM turns are plain conversation ("hi", explaining something from
					// context) that legitimately need zero tool calls — unlike sub-agents,
					// whose task always requires tool use. See ClaudeCliRunOpts.verifyToolCall.
					verifyToolCall: false,
					onText: (text) => {
						fullText += text;
						// In Full Streaming, this same content already reached the UI
						// progressively via onTextToken below — broadcasting it again in
						// full here would double it (onStreamToken appends, not replaces).
						if (!isFullStreaming) this.callbacks.onStreamToken(conversationId, assistantMessageId, text, null);
					},
					onReasoning: (text) => {
						accumulatedReasoning += (accumulatedReasoning ? "\n\n" : "") + text;
						if (!isFullStreaming) emitActivity("thinking", { text, isPartial: false });
					},
					onTextToken: (delta) => textAcc?.push(delta),
					onReasoningToken: (delta) => reasoningAcc?.push(delta),
					onRetract: () => {
						// Live-streamed content from a failed, now-retried attempt must be
						// cleared before the retry's fresh deltas start arriving. In
						// practice PM chat passes verifyToolCall: false, so this never
						// actually fires — wired anyway for the same safety-net reasoning
						// as the CLI runner's own contract.
						textAcc?.cancel();
						reasoningAcc?.cancel();
						flushedTextLength = 0;
						this.callbacks.onStreamReset(conversationId, assistantMessageId);
						emitActivity("thinking", { text: "", isPartial: true });
					},
					onToolCallStart: (toolName, args) => {
						const callId = crypto.randomUUID();
						toolCallNames.set(callId, toolName);
						if (toolName !== "run_agent" && toolName !== "run_agents_parallel") {
							const type = STATUS_CHECK_TOOLS.has(toolName) ? "status_check" : "tool_call";
							emitActivity(type, { toolName, args, status: "completed" });
						}

						if (MEDIA_TOOLS.has(toolName)) {
							const partId = crypto.randomUUID();
							mediaPartIdByCallId.set(callId, partId);
							const part: MessagePart = {
								id: partId,
								messageId: assistantMessageId,
								type: "tool_call",
								content: toolName,
								toolName,
								toolInput: JSON.stringify(args),
								toolState: "running",
								sortOrder: mediaPartSortOrder++,
								timeStart: new Date().toISOString(),
							};
							db.insert(messageParts).values({
								id: part.id, messageId: part.messageId, type: part.type, content: part.content,
								toolName: part.toolName, toolInput: part.toolInput, toolState: part.toolState,
								sortOrder: part.sortOrder, timeStart: part.timeStart,
							}).catch(() => {});
							if (!pmHasPartsSet) {
								pmHasPartsSet = true;
								db.update(messages).set({ hasParts: 1 }).where(eq(messages.id, assistantMessageId)).catch(() => {});
							}
							this.callbacks.onPartCreated?.(conversationId, part);
						}

						return callId;
					},
					onToolCallEnd: (callId, resultText, isError) => {
						const toolName = toolCallNames.get(callId);
						if (!toolName || toolName === "run_agent" || toolName === "run_agents_parallel" || STATUS_CHECK_TOOLS.has(toolName)) return;
						emitActivity("tool_result", { toolName, result: resultText, isError });

						if (MEDIA_TOOLS.has(toolName)) {
							const partId = mediaPartIdByCallId.get(callId);
							if (partId) {
								mediaPartIdByCallId.delete(callId);
								// Media tools return large base64 payloads — same higher limit
								// agent-loop.ts uses, so the frontend can render the actual image.
								const toolOutputLimit = 500_000;
								const updates: Partial<MessagePart> = {
									toolOutput: resultText.length > toolOutputLimit ? resultText.slice(0, toolOutputLimit) + "\n... (truncated)" : resultText,
									toolState: isError ? "error" : "success",
									timeEnd: new Date().toISOString(),
								};
								db.update(messageParts).set({
									toolOutput: updates.toolOutput, toolState: updates.toolState, timeEnd: updates.timeEnd,
								}).where(eq(messageParts.id, partId)).catch(() => {});
								this.callbacks.onPartUpdated?.(conversationId, assistantMessageId, partId, updates);
							}
						}
					},
				});

				// Flush any tail content still sitting in the throttle window — the
				// attempt is done, and nothing further will trigger it.
				if (isFullStreaming) {
					textAcc?.flushNow();
					reasoningAcc?.cancel();
					const finalReasoning = reasoningAcc?.value();
					if (finalReasoning) emitActivity("thinking", { text: finalReasoning, isPartial: false });
				}

				if (abortController?.signal.aborted) {
					await db.delete(messages).where(eq(messages.id, assistantMessageId)).catch(() => {});
					this.callbacks.onStreamComplete(conversationId, assistantMessageId, { content: "", promptTokens: 0, completionTokens: 0 });
					return;
				}

				if (cliResult.status !== "completed") {
					throw new Error(cliResult.summary);
				}

				if (!fullText.trim()) fullText = cliResult.summary;
				promptTokens = cliResult.usage.inputTokens;
				completionTokens = cliResult.usage.outputTokens;

				const msgMeta: Record<string, unknown> = { promptTokens, completionTokens, modelId };
				// Real Anthropic prompt-cache telemetry — only available via this
				// CLI/SDK path (other providers' usage objects don't report this
				// breakdown today). Recorded even when 0 so it's distinguishable
				// from "not measured" on older messages that predate this field.
				if (cliResult.usage.cacheCreationInputTokens !== undefined) msgMeta.cacheCreationTokens = cliResult.usage.cacheCreationInputTokens;
				if (cliResult.usage.cacheReadInputTokens !== undefined) msgMeta.cacheReadTokens = cliResult.usage.cacheReadInputTokens;
				if (accumulatedReasoning) msgMeta.reasoning = accumulatedReasoning;
				await db.update(messages).set({
					content: fullText,
					tokenCount: promptTokens + completionTokens,
					metadata: JSON.stringify(msgMeta),
					createdAt: new Date().toISOString(),
				}).where(eq(messages.id, assistantMessageId));

				try {
					sqlite
						.prepare(
							`UPDATE messages
							   SET rowid = (SELECT MAX(rowid) FROM messages) + 1
							 WHERE id = ?
							   AND EXISTS (
							     SELECT 1 FROM messages m2
							     WHERE m2.conversation_id = ?
							       AND m2.rowid > messages.rowid
							   )`,
						)
						.run(assistantMessageId, conversationId);
				} catch (err) {
					console.error("[Engine] Failed to re-position PM message by rowid:", err);
				}

				this.callbacks.onStreamComplete(conversationId, assistantMessageId, {
					content: fullText, promptTokens, completionTokens, metadata: JSON.stringify(msgMeta),
				});
				this.lastPromptTokens.set(conversationId, promptTokens);
				this._touchConversation(conversationId);
				return;
			}
			// isClaudeSubscriptionViaCli returned above — model is guaranteed non-null below.
			if (!model) {
				throw new Error(`No language model resolved for PM (provider "${providerRow.providerType}")`);
			}

			// Whether this message expects PM to call run_agent.
			// Only trust the explicit [Next Action] DISPATCH signal injected by the engine
			// after an agent completes. Do NOT use kanban state as a fallback — that caused
			// the hallucination guard to fire on plain human messages (e.g. "hi") whenever
			// backlog tasks happened to exist, forcing the PM to dispatch an agent
			// inappropriately.
			const isDispatchExpected = content.includes("[Next Action] DISPATCH");
			let hallucinRetries = 0;
			const MAX_HALLUCIN_RETRIES = 2;
			// Tools handed to the PM. Narrowed to dispatch-only on a hallucination retry
			// (see below) so the model cannot answer with prose again — a provider-agnostic
			// alternative to toolChoice:'required' (which Ollama/OpenAI-compatible proxies
			// silently ignore and which Anthropic forbids alongside extended thinking).
			let activeTools: typeof pmTools = pmTools;

			// Set by the "retries exhausted" branch inside the while loop.
			// Checked after step 10 (onStreamComplete) for the post-stream ground-truth layer.
			let postStreamCorrectionNeeded = false;
			let postStreamDetectionSource = "";

			const pmThinkingOptions = buildPMThinkingOptions(pmThinkingBudget, providerRow.providerType);

			const MAX_PM_RETRIES = 3;
			let pmAttempt = 0;
			let lastStreamError: unknown = null;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let result: any;
			while (true) {
				try {
				fullText = "";
				reasoningEmittedFromStream = false;
				// Notify frontend immediately so PM placeholder is in the messages array
				// BEFORE any tool calls or agent dispatches happen.
				this.callbacks.onStreamReset(conversationId, assistantMessageId);
				await logPrompt("PM", context.instructions, context.messages, providerRow.defaultModel ?? "default");
				const cached = applyAnthropicCaching(providerRow.providerType, context.instructions, context.messages);
				result = streamText({
					model,
					instructions: cached.instructions,
					messages: cached.messages,
					tools: activeTools,
					stopWhen: [isStepCount(100)],
					abortSignal: abortController?.signal,
					// Flows automatically into every telemetry event's `runtimeContext`
					// field (see telemetry-sink.ts, Phase 3.1) — the PM turn is the
					// higher cost-significance surface per Phase 0's own usage-tracking
					// finding, so this is the more valuable of the two runtimeContext
					// additions in this migration phase (see also agent-loop.ts).
					runtimeContext: { agentName: "project-manager", projectId: this.projectId, conversationId },
					...pmThinkingOptions,
					// Deliver real media bytes from a read_image/take_screenshot/read_audio call
					// as a follow-up user message — the only wire format every provider actually
					// supports as vision/audio input (see buildMediaFollowUpMessage in media-followup.ts).
					prepareStep: async ({ steps }) => {
						if (steps.length === 0) return undefined;
						const lastStep = steps[steps.length - 1] as { toolResults?: Array<{ toolName: string; output?: unknown; result?: unknown }> };
						const mediaFollowUp = buildMediaFollowUpMessage(lastStep.toolResults);
						if (!mediaFollowUp) return undefined;
						context.messages = [...context.messages, mediaFollowUp];
						const recached = applyAnthropicCaching(providerRow.providerType, context.instructions, context.messages);
						return recached.instructions !== undefined
							? { messages: recached.messages, instructions: recached.instructions }
							: { messages: recached.messages };
					},
					onStepEnd: (stepResult) => {
						const stepAny = stepResult as {
							text?: string;
							reasoningText?: string;
							toolCalls?: Array<{ toolName: string; toolCallId?: string; input?: unknown; args?: unknown }>;
							toolResults?: Array<{ toolName: string; toolCallId?: string; output?: unknown; result?: unknown }>;
						};
						const emitActivity = (type: AgentActivityEvent["type"], data: Record<string, unknown>) => {
							this.callbacks.onAgentActivity?.({
								projectId: this.projectId,
								conversationId,
								agentId: "project-manager",
								agentName: "project-manager",
								agentColor: pmColor,
								type,
								data,
								timestamp: new Date().toISOString(),
							});
						};
						const pmReasoning = extractPMReasoning(stepResult);
						if (pmReasoning && !reasoningEmittedFromStream) {
							if (!isNoStreaming) emitActivity("thinking", { text: pmReasoning });
							accumulatedReasoning += (accumulatedReasoning ? "\n\n" : "") + pmReasoning;
						}
						reasoningEmittedFromStream = false;

						const STATUS_CHECK_TOOLS = new Set(["list_tasks", "get_task"]);
						for (const tc of stepAny.toolCalls ?? []) {
							if (tc.toolName === "run_agent" || tc.toolName === "run_agents_parallel") continue;
							const tcArgs = tc.input ?? tc.args;
							const type = STATUS_CHECK_TOOLS.has(tc.toolName) ? "status_check" : "tool_call";
							emitActivity(type, { toolName: tc.toolName, args: tcArgs, status: "completed" });
							if (tc.toolName === "read_skill" && (tcArgs as Record<string, unknown>)?.name) {
								console.log(`[skills] PM loaded skill "${(tcArgs as Record<string, unknown>).name}" (project: ${this.projectId})`);
							}

							if (MEDIA_TOOLS.has(tc.toolName) && tc.toolCallId) {
								const partId = crypto.randomUUID();
								mediaPartIdByCallId.set(tc.toolCallId, partId);
								const part: MessagePart = {
									id: partId,
									messageId: assistantMessageId,
									type: "tool_call",
									content: tc.toolName,
									toolName: tc.toolName,
									toolInput: JSON.stringify(tcArgs),
									toolState: "running",
									sortOrder: mediaPartSortOrder++,
									timeStart: new Date().toISOString(),
								};
								db.insert(messageParts).values({
									id: part.id, messageId: part.messageId, type: part.type, content: part.content,
									toolName: part.toolName, toolInput: part.toolInput, toolState: part.toolState,
									sortOrder: part.sortOrder, timeStart: part.timeStart,
								}).catch(() => {});
								if (!pmHasPartsSet) {
									pmHasPartsSet = true;
									db.update(messages).set({ hasParts: 1 }).where(eq(messages.id, assistantMessageId)).catch(() => {});
								}
								this.callbacks.onPartCreated?.(conversationId, part);
							}
						}
						for (const tr of stepAny.toolResults ?? []) {
							if (tr.toolName === "run_agent" || tr.toolName === "run_agents_parallel") continue;
							if (STATUS_CHECK_TOOLS.has(tr.toolName)) continue;
							const trResult = tr.output ?? tr.result;
							// Shared inline-agent error detection (agent-loop.ts): handles "Error …"
							// strings, "success":false, and JSON { error: "…" } envelopes alike.
							const resultStr = typeof trResult === "string" ? trResult : JSON.stringify(trResult);
							const isError = toolResultIsError(tr.toolName, resultStr);
							emitActivity("tool_result", { toolName: tr.toolName, result: trResult, isError });

							if (MEDIA_TOOLS.has(tr.toolName) && tr.toolCallId) {
								const partId = mediaPartIdByCallId.get(tr.toolCallId);
								if (partId) {
									mediaPartIdByCallId.delete(tr.toolCallId);
									// Media tools return large base64 payloads — same higher limit
									// agent-loop.ts uses, so the frontend can render the actual image.
									const toolOutputLimit = 500_000;
									const updates: Partial<MessagePart> = {
										toolOutput: resultStr.length > toolOutputLimit ? resultStr.slice(0, toolOutputLimit) + "\n... (truncated)" : resultStr,
										toolState: isError ? "error" : "success",
										timeEnd: new Date().toISOString(),
									};
									db.update(messageParts).set({
										toolOutput: updates.toolOutput, toolState: updates.toolState, timeEnd: updates.timeEnd,
									}).where(eq(messageParts.id, partId)).catch(() => {});
									this.callbacks.onPartUpdated?.(conversationId, assistantMessageId, partId, updates);
								}
							}
						}
						// Live context-bar update each PM step (real last-step prompt tokens),
						// so a multi-step PM turn climbs the bar in real time too.
						const pmStepUsage = (stepResult as { usage?: { inputTokens?: number; promptTokens?: number } }).usage;
						const pmStepTokens = pmStepUsage?.inputTokens ?? pmStepUsage?.promptTokens;
						if (typeof pmStepTokens === "number" && pmStepTokens > 0) {
							this.callbacks.onContextUsage?.(conversationId, pmStepTokens, getContextLimit(modelId, this.projectId));
						}
					},
				});

				// Use stream for real-time reasoning emission
				let allReasoning = "";
				let reasoningFlushTimer: ReturnType<typeof setTimeout> | null = null;
				const emitThinking = (isPartial: boolean) => {
					if (reasoningFlushTimer) { clearTimeout(reasoningFlushTimer); reasoningFlushTimer = null; }
					if (!allReasoning) return;
					reasoningEmittedFromStream = true;
					// No Streaming: skip the live broadcast, but keep every bookkeeping
					// side effect below (accumulatedReasoning still needs the final
					// value for msgMeta persistence) — only the progressive UI update
					// is suppressed here.
					if (!isNoStreaming) this.callbacks.onAgentActivity?.({
						projectId: this.projectId,
						conversationId,
						agentId: "project-manager",
						agentName: "project-manager",
						agentColor: pmColor,
						type: "thinking",
						data: { text: allReasoning, isPartial },
						timestamp: new Date().toISOString(),
					});
					if (!isPartial) {
						// Accumulate for metadata persistence before clearing
						if (allReasoning) accumulatedReasoning += (accumulatedReasoning ? "\n\n" : "") + allReasoning;
						allReasoning = "";
					}
				};

				// Track text emitted in the current step so we can retract it
				// if the step also dispatches a wait-type sub-agent.
				let stepTextEmitted = "";
				let stepHasWaitAgent = false;
				let retractedFallback = "";
				// Turn-level flag: was run_agent actually called at any point this turn?
				// Used by the hallucination guard below to detect user-initiated dispatch
				// requests where no [Next Action] hint was injected.
				let agentDispatchedThisTurn = false;

				for await (const part of result.stream) {
					if (part.type === "reasoning-start" || part.type === "reasoning-end") {
						// Track reasoning boundaries — skip, handled by reasoning-delta
					} else if (part.type === "reasoning-delta") {
						const delta = (part as { text?: string }).text ?? "";
						// no-op: delta accumulated in allReasoning below
						allReasoning += delta;
						if (!reasoningFlushTimer) {
							reasoningFlushTimer = setTimeout(() => emitThinking(true), 300);
						}
					} else if (part.type === "text-delta") {
						emitThinking(false);
						const delta = (part as { text?: string }).text ?? "";
						fullText += delta;
						stepTextEmitted += delta;
						if (retractedFallback) retractedFallback = "";
						if (!isNoStreaming) this.callbacks.onStreamToken(conversationId, assistantMessageId, delta, null);
					} else if (part.type === "tool-call") {
						const tc = part as { toolName?: string };
						if (tc.toolName === "run_agent" || tc.toolName === "run_agents_parallel") {
							stepHasWaitAgent = true;
							agentDispatchedThisTurn = true;
						}
					} else if (part.type === "finish-step") {
						if (stepHasWaitAgent && stepTextEmitted.trim()) {
							retractedFallback = stepTextEmitted;
							fullText = fullText.slice(0, fullText.length - stepTextEmitted.length);
							this.callbacks.onStreamReset(conversationId, assistantMessageId);
							// Surface the retracted narration as reasoning instead of letting it
							// flash-then-vanish in the answer lane. The restore-fallback below still
							// rescues it as the answer if the model never regenerates.
							this.callbacks.onAgentActivity?.({
								projectId: this.projectId,
								conversationId,
								agentId: "project-manager",
								agentName: "project-manager",
								agentColor: pmColor,
								type: "thinking",
								data: { text: stepTextEmitted, isPartial: false },
								timestamp: new Date().toISOString(),
							});
							console.log(`[PM] Retracted premature text (${stepTextEmitted.length} chars) — wait-agent dispatched in same step`);
						}
						stepTextEmitted = "";
						stepHasWaitAgent = false;

						// Plan approval submitted — stop PM from generating further text
						if (planApprovalRequested) {
							console.log("[PM] Breaking stream loop — plan awaiting human approval");
							break;
						}
					} else if (part.type === "error") {
						const err = (part as { error: unknown }).error;
						throw err instanceof Error ? err : new Error(String(err));
					}
				}
				emitThinking(false);

				// Persist reasoning captured from stream (onStepEnd won't duplicate it
				// because reasoningEmittedFromStream is true)
				if (allReasoning && !accumulatedReasoning.includes(allReasoning)) {
					accumulatedReasoning += (accumulatedReasoning ? "\n\n" : "") + allReasoning;
				}

				// Fallback: restore retracted text if the model didn't regenerate
				if (!fullText.trim() && retractedFallback.trim()) {
					fullText = retractedFallback;
					this.callbacks.onStreamToken(conversationId, assistantMessageId, retractedFallback, null);
					console.log(`[PM] Restored retracted fallback text (${retractedFallback.length} chars) — model did not regenerate`);
				}

				// Fallback: if stream deltas were empty, try result.text (v6 accumulates internally).
				// Skip when an agent was dispatched — result.text holds any narration the model
				// generated before/after calling run_agent, which we don't want to show.
				if (!fullText.trim() && !planApprovalRequested) {
					try {
						const accumulated = await result.text;
						if (accumulated?.trim()) {
							fullText = accumulated;
							this.callbacks.onStreamToken(conversationId, assistantMessageId, accumulated, null);
							console.log(`[PM] Recovered text from result.text (${accumulated.length} chars) — stream deltas were empty`);
						}
					} catch { /* result.text not available */ }
				}

				// Plan approval requested — treat as successful completion regardless of text
				if (planApprovalRequested) {
					break;
				}

				// Hallucination detection: PM wrote text without calling run_agent when a
				// dispatch was expected. Instead of sending a new DB message (which would
				// poison future context), inject the correction directly into context.messages
				// in-memory and continue the while loop. The hallucinated text + correction
				// are ephemeral — they guide the next LLM call but are never written to DB.
				//
				// Three detection vectors (evaluated in order, stops at first hit):
				//
				//   A) Engine-driven: [Next Action] DISPATCH was injected into content.
				//      `isDispatchExpected` covers auto-continue after task completion.
				//
				//   B) Thinking-block signal (PRIMARY for user-initiated requests):
				//      The PM's extended reasoning uses its own trained vocabulary for tool
				//      calls — "let me dispatch", "I'll call run_agent", "I will dispatch" —
				//      far more consistently than its response text. Scanning the reasoning
				//      for a conclusive dispatch decision is more reliable than regex on
				//      output prose, which varies freely. Requires extended thinking to be
				//      enabled (Anthropic + some OpenRouter models); gracefully absent
				//      on other providers (falls through to vector C).
				//
				//   C) Response-text regex (FALLBACK for non-thinking providers):
				//      Conservative pattern list targeting unambiguous present/past-tense
				//      action claims. Intentionally excludes bare "Done."/"Fixed." (too
				//      common in legitimate non-dispatch replies). Will miss novel phrasing
				//      but vector B covers the cases where thinking is available.
				const reasoning = accumulatedReasoning || allReasoning || "";

				// Vector B — conclusive dispatch decision in thinking block.
				// "let me dispatch", "I'll dispatch", "I will dispatch/call run_agent",
				// "I need to dispatch", "I'm going to dispatch/call run_agent".
				// Deliberately narrow: "should I dispatch" / "maybe dispatch" are
				// deliberation, not a concluded decision — they do not trigger.
				const THINKING_DISPATCH_RE =
					/\b(?:let me|i(?:'ll| will| am going to| need to| have to| must))\s+(?:dispatch|call\s+run_agent)\b/i;
				const thinkingSignalsDispatch = reasoning.length > 0 && THINKING_DISPATCH_RE.test(reasoning);

				// Vector C — response-text fallback (only checked when thinking unavailable).
				const DISPATCH_CLAIM_RE = new RegExp(
					[
						// Present participle ("Dispatching the fix", "Dispatching frontend-engineer")
						"dispatching(?:\\s+(?:the|a|an|it|this|fix|change|update|now|agent|engineer|specialist|[a-z]+-engineer|[a-z]+-specialist))?\\b",
						// Simple past ("I dispatched", "I've dispatched", "I have dispatched", "I just dispatched")
						"i(?:'ve|\\s+have|\\s+just|\\s+already)?\\s+dispatched\\b",
						// Passive voice ("[X] has been dispatched/applied/fixed/updated")
						"(?:has|have)\\s+been\\s+(?:dispatched|applied|fixed|updated|deployed)\\b",
						// Multi-item completion ("both/all lines updated/fixed")
						"(?:both|all)\\s+(?:lines|files|values|changes|entries)\\s+(?:updated|fixed|changed|applied|deployed)\\b",
						// "updated and verified" without a leading quantifier
						"updated\\s+and\\s+verified\\b",
						// "already done/fixed/updated/dispatched/applied"
						"already\\s+(?:done|fixed|updated|dispatched|applied|deployed)\\b",
						// Explicit agent dispatch completions
						"agent\\s+has\\s+been\\s+dispatched\\b",
						// Handed off to a specialist
						"(?:sent|handed)\\s+(?:this\\s+|it\\s+)?(?:to|off\\s+to)\\s+(?:the\\s+)?(?:frontend|backend|agent|engineer|specialist)\\b",
						// "[fix/change/update] [is] [now] applied/deployed"
						"(?:fix|change|update|patch)\\s+(?:is\\s+)?(?:now\\s+)?(?:applied|deployed)\\b",
					].join("|"),
					"i",
				);
				// Use text regex only when thinking is absent (other providers).
				// When thinking IS present, the thinking signal is authoritative — we
				// don't double-fire on the response text to avoid noise in the log.
				const textSignalsDispatch = !thinkingSignalsDispatch && DISPATCH_CLAIM_RE.test(fullText);

				const pmClaimedDispatchWithoutTool =
					!agentDispatchedThisTurn && (thinkingSignalsDispatch || textSignalsDispatch);

				if ((isDispatchExpected || pmClaimedDispatchWithoutTool) && fullText.trim() && !planApprovalRequested && hallucinRetries < MAX_HALLUCIN_RETRIES) {
					hallucinRetries++;
					const detectionSource = isDispatchExpected ? "next-action-hint" : thinkingSignalsDispatch ? "thinking-block" : "response-text-regex";
					console.warn(`[PM] Hallucination detected via ${detectionSource} — PM wrote text without calling run_agent (retry ${hallucinRetries}/${MAX_HALLUCIN_RETRIES})`);
					const hallucinatedText = fullText;
					fullText = "";
					this.callbacks.onStreamReset(conversationId, assistantMessageId);

					// Provider-agnostic forcing: on the retry, expose ONLY the dispatch tools so
					// the model cannot answer with prose again. This works on every provider (it
					// removes the choice), unlike toolChoice:'required' which many providers
					// (Ollama, OpenAI-compatible proxies) silently ignore and which Anthropic
					// rejects alongside extended thinking.
					activeTools = {
						run_agent: pmTools.run_agent,
						run_agents_parallel: pmTools.run_agents_parallel,
					} as typeof pmTools;

					// Append hallucinated response + correction to in-memory context only.
					// This lets the LLM see its own mistake and the explicit correction
					// without polluting the DB conversation history.
					const taskHintMatch = content.match(/DISPATCH[^"]*"([^"]+)"\s*\(([^)]+)\)/);
					const taskIdHint = taskHintMatch?.[2] ? ` with kanban_task_id="${taskHintMatch[2]}"` : "";
					context.messages = [
						...context.messages,
						{ role: "assistant" as const, content: hallucinatedText },
						{ role: "user" as const, content: `[DISPATCH REQUIRED] You wrote the above without calling run_agent — the agent was NOT spawned. Do not write any more text. Call run_agent${taskIdHint} NOW as a tool call.` },
					];
					continue;
				}

				// Retries exhausted but the PM still won't dispatch: surface it loudly instead of
				// silently persisting misleading "I'll dispatch…" narration as the final answer.
				if ((isDispatchExpected || pmClaimedDispatchWithoutTool) && fullText.trim() && hallucinRetries >= MAX_HALLUCIN_RETRIES) {
					const reason = isDispatchExpected ? "next-action-hint" : thinkingSignalsDispatch ? "thinking-block" : "response-text-regex";
					console.warn(`[PM] Dispatch not corrected after ${MAX_HALLUCIN_RETRIES} retries (${reason}) — will attempt post-stream ground-truth check.`);
					postStreamCorrectionNeeded = true;
					postStreamDetectionSource = reason;
				}

				if (fullText.trim()) {
					try {
						const usage = await result.usage;
						if (usage) {
							promptTokens = Number.isFinite(usage.inputTokens) ? (usage.inputTokens ?? 0) : 0;
							completionTokens = Number.isFinite(usage.outputTokens) ? (usage.outputTokens ?? 0) : 0;
						}
					} catch {
						// usage is not available for all providers
					}
					if (promptTokens === 0 && completionTokens === 0) {
						completionTokens = Math.ceil(fullText.length / 4);
					}
					break;
				}

				} catch (streamErr: unknown) {
					if (
						abortController?.signal.aborted === true ||
						(streamErr instanceof Error &&
							(streamErr.name === "AbortError" || streamErr.message.includes("abort")))
					) {
						throw streamErr;
					}

					if (!isTransientError(streamErr)) {
						throw streamErr;
					}

					lastStreamError = streamErr;
					fullText = "";
				}

				// Empty response or transient error — back off and retry
				pmAttempt++;
				console.warn(`[PM] Empty response attempt ${pmAttempt}/${MAX_PM_RETRIES} | fullText="${fullText.slice(0, 100)}" | planApproval=${planApprovalRequested}`);

				// Check if model made tool calls but returned no text — this is normal for tool-only responses
				try {
					const steps = await result?.steps;
					const hasToolCalls = steps?.some((s: { toolCalls?: unknown[] }) => s.toolCalls && s.toolCalls.length > 0);
					if (hasToolCalls) {
						console.log(`[PM] Model made tool calls but no text — this is valid, not retrying`);
						break;
					}
					console.warn(`[PM] No tool calls and no text — model returned truly empty response`);
				} catch { /* steps not available */ }

				if (pmAttempt >= MAX_PM_RETRIES) {
					// Try to get the final text from the result (v6 may accumulate differently)
					try {
						const finalText = await result?.text;
						if (finalText?.trim()) {
							fullText = finalText;
							console.log(`[PM] Recovered text from result.text: "${finalText.slice(0, 100)}"`);
							break;
						}
					} catch { /* result.text not available */ }

					if (!fullText.trim()) {
						if (lastStreamError instanceof Error) throw lastStreamError;
						throw new Error(
							`The AI model returned an empty response after ${MAX_PM_RETRIES} attempts. This may be a provider issue — try a different model or check your API key/quota.`,
						);
					}
					if (lastStreamError instanceof Error) throw lastStreamError;
					throw new Error(
						`PM streaming failed after ${MAX_PM_RETRIES} retries due to network errors. Please check your connection.`,
					);
				}

				const delayMs = getBackoffDelay(pmAttempt - 1);
				this.callbacks.onAgentActivity?.({
					projectId: this.projectId,
					conversationId,
					agentId: "project-manager",
					agentName: "project-manager",
					agentColor: pmColor,
					type: "info",
					data: {
						message: `Connection lost — retrying in ${Math.round(delayMs / 1000)}s (attempt ${pmAttempt}/${MAX_PM_RETRIES})...`,
					},
					timestamp: new Date().toISOString(),
				});

				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, getBackoffDelay(pmAttempt - 1));
					abortController?.signal.addEventListener(
						"abort",
						() => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); },
						{ once: true },
					);
				});
			}

			// 9. Persist full assistant message content + metadata
			const msgMeta: Record<string, unknown> = { promptTokens, completionTokens, modelId };
			if (accumulatedReasoning) msgMeta.reasoning = accumulatedReasoning;
			// Bump createdAt to the PM's finish time. This is the ordering key for
			// the LLM-context path: context.ts (history replay) and summarizer.ts
			// both sort messages by createdAt, so bumping keeps the PM's final
			// message AFTER the sub-agents it spawned when the conversation is
			// replayed to the model. The UI orders by rowid instead (see the
			// reposition below), so both the model's view and the user's view stay
			// chronological and consistent.
			await db
				.update(messages)
				.set({
					content: fullText,
					tokenCount: promptTokens + completionTokens,
					metadata: JSON.stringify(msgMeta),
					createdAt: new Date().toISOString(),
				})
				.where(eq(messages.id, assistantMessageId));

			// Re-position the PM's final message AFTER any sub-agent messages it
			// spawned during this turn. The PM row is inserted as an empty
			// placeholder BEFORE streaming begins (and thus before any sub-agent
			// rows exist), so by SQLite rowid — which the UI orders by — it would
			// otherwise render ABOVE the agents it spawned, even though its text
			// was produced last. Bump its rowid to MAX+1 so the conversation reads
			// chronologically (latest at the bottom), like a normal chat app. The
			// EXISTS guard only bumps when a newer row exists in this conversation;
			// the PM-processing lock guarantees the only newer rows are this turn's
			// sub-agents, so MAX(rowid)+1 slots the PM directly after them. rowid is
			// referenced by nothing else (FKs use messages.id), so this is safe.
			try {
				sqlite
					.prepare(
						`UPDATE messages
						   SET rowid = (SELECT MAX(rowid) FROM messages) + 1
						 WHERE id = ?
						   AND EXISTS (
						     SELECT 1 FROM messages m2
						     WHERE m2.conversation_id = ?
						       AND m2.rowid > messages.rowid
						   )`,
					)
					.run(assistantMessageId, conversationId);
			} catch (err) {
				// Non-critical: on failure the PM message keeps its placeholder
				// position (above its sub-agents) — the prior behaviour, not a crash.
				console.error("[Engine] Failed to re-position PM message by rowid:", err);
			}

			// 10. Notify stream complete
			const metadataJson = JSON.stringify(msgMeta);
			this.callbacks.onStreamComplete(conversationId, assistantMessageId, {
				content: fullText,
				promptTokens,
				completionTokens,
				metadata: metadataJson,
			});

			// Remember the real prompt-token usage (exactly what the context bar shows)
			// so the NEXT turn's compaction check measures against ACTUAL usage. We do
			// NOT compact here — compaction happens only at the start of the next turn
			// (step 4.1), so it never runs mid-stream.
			this.lastPromptTokens.set(conversationId, promptTokens);

			this._touchConversation(conversationId);

			// 11. Post-stream ground-truth safety net.
			// All in-stream retries were exhausted but the PM still didn't dispatch.
			// Confirm with the actual running-agent count (not text inference): if it's
			// zero, the dispatch genuinely never happened. Re-inject a correction message
			// that re-drives the PM. Guards:
			//   - Only fires when postStreamCorrectionNeeded (set by retries-exhausted branch)
			//   - Loop guard: skip if this turn was itself a [DISPATCH CORRECTION] message
			//     (prevents infinite correction→hallucination→correction loops)
			//   - Deferred via setTimeout so the call lands AFTER pmProcessingPromise
			//     resolves — calling sendMessage from inside _runPMProcessing deadlocks
			//     because sendMessage awaits pmProcessingPromise before starting.
			if (
				postStreamCorrectionNeeded &&
				!planApprovalRequested &&
				!content.startsWith("[DISPATCH CORRECTION]")
			) {
				const { getRunningAgentCount } = await import("../engine-manager");
				if (getRunningAgentCount(this.projectId) === 0) {
					console.warn(`[PM] Post-stream correction (${postStreamDetectionSource}): confirmed no agents running — scheduling re-injection`);
					const originalReq = content.startsWith("[Agent Report]")
						? ""
						: `\n\nThe user's original request was: "${content.slice(0, 400)}${content.length > 400 ? "…" : ""}"`;
					const correctionMsg =
						`[DISPATCH CORRECTION] Your previous response described dispatching an agent, ` +
						`but no agent is currently running — the dispatch never happened.` +
						`${originalReq}\n\nCall run_agent NOW as a tool call. Do not write any text first.`;
					// Defer past the processing lock (see comment above).
					setTimeout(() => {
						this.sendMessage(conversationId, correctionMsg, { type: "agent_report" } as never)
							.catch(err => console.error("[PM] Post-stream correction sendMessage failed:", err));
					}, 150);
				} else {
					console.log(`[PM] Post-stream check: agents are running (count=${getRunningAgentCount(this.projectId)}) — no correction needed`);
				}
			}

			// (Auto-title is fired from sendMessage with a 1s delay — see above)
		} catch (error: unknown) {
			const isAbort =
				abortController?.signal.aborted === true ||
				(error instanceof Error &&
					(error.name === "AbortError" || error.message.includes("abort")));

			if (isAbort) {
				await db
					.delete(messages)
					.where(eq(messages.id, assistantMessageId))
					.catch(() => {});
				this.callbacks.onStreamComplete(conversationId, assistantMessageId, {
					content: "",
					promptTokens: 0,
					completionTokens: 0,
				});
			} else {
				const errMsg = error instanceof Error ? error.message : String(error);
				this.callbacks.onStreamError(conversationId, errMsg);

				await db
					.update(messages)
					.set({ content: `[Generation failed] ${errMsg}` })
					.where(eq(messages.id, assistantMessageId))
					.catch(() => {});
			}

			throw error;
		} finally {
			if (this.pmAbort === abortController) {
				this.pmProcessing = false;
				this.pmAbort = null;
			}
		}
	}

	/** Abort PM stream + any running inline sub-agent. */
	stopAll(): void {
		this.pmAbort?.abort();
		this.pmAbort = null;
		this.pmProcessing = false;
		this.stopped = true;

	}

	/** Stop everything then reset so a notification sendMessage can go through. */
	stopAllAndReset(): void {
		this.stopAll();
		this.stopped = false;
	}

	/** Returns true if stopped flag is set (used by PM tools to check before launching agents). */
	isStopped(): boolean {
		return this.stopped;
	}

	/** Inject a function to abort all running sub-agents (avoids circular import with engine-manager). */
	setAbortAgentsFn(fn: (projectId: string) => void): void {
		this.abortAgentsFn = fn;
	}

	/** Returns the project ID for this engine. */
	getProjectId(): string {
		return this.projectId;
	}

	/** Returns true while the Project Manager is streaming a response. */
	isProcessing(): boolean {
		return this.pmProcessing;
	}

	/** Returns the conversation ID the PM is currently responding in, or null. */
	getActiveConversationId(): string | null {
		return this.activeConversationId;
	}

	/** Returns the source metadata for the currently active message. */
	getActiveMetadata(): MessageMetadata {
		return this.activeMetadata;
	}

	/** Returns queued agents — always empty in inline model (no queue). */
	getQueuedAgentsSnapshot(): Array<{ displayName: string; taskDescription: string }> {
		return [];
	}

	/**
	 * Present a plan to the user for approval as a chat message.
	 */
	presentPlan(plan: { title: string; content: string; conversationId: string }): void {
		this.callbacks.onPresentPlan?.(this.projectId, plan);
	}

	/**
	 * Move a kanban task to a different column.
	 */
	moveKanbanTask(taskId: string, column: string): void {
		this.callbacks.onKanbanTaskMove?.(this.projectId, taskId, column);
	}

	/** Post a deterministic assistant message without invoking the LLM. */
	async postDeterministicMessage(content: string): Promise<void> {
		const cid = this.activeConversationId;
		if (!cid) return;
		const mid = crypto.randomUUID();
		try { await db.insert(messages).values({ id: mid, conversationId: cid, role: "assistant", agentId: null, content, metadata: JSON.stringify({ type: "agent_completion_summary" }), tokenCount: Math.ceil(content.length / 4), createdAt: new Date().toISOString() }); }
		catch { return; }
		this.callbacks.onStreamToken(cid, mid, content, "project-manager");
		this.callbacks.onStreamComplete(cid, mid, { content, promptTokens: 0, completionTokens: 0 });
	}

	/** Invoke the PM with a compact event hint so it can decide next steps. */
	async invokePMWithEvent(hint: string): Promise<void> {
		const cid = this.activeConversationId;
		if (!cid || this.pmProcessing || this.stopped) return;
		const mid = crypto.randomUUID();
		try { await db.insert(messages).values({ id: mid, conversationId: cid, role: "assistant", agentId: null, content: "", metadata: null, tokenCount: 0, createdAt: new Date().toISOString() }); }
		catch { return; }
		this.callbacks.onStreamToken(cid, mid, "", null);
		await this._runPMProcessing(mid, cid, hint);
	}

	// -------------------------------------------------------------------------
	// Slash-command handlers
	// -------------------------------------------------------------------------

	/** Builds a markdown status report for /info without calling the LLM. */
	private async _handleStatusCommand(): Promise<string> {
		const { getStatusReport } = await import("../engine-manager");
		return getStatusReport();
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	/** Loads the AI provider row and resolves the model ID.
	 *  Checks project-level chatProviderId/chatModelId settings first,
	 *  then falls back to the global default provider. */
	private async getDefaultProviderRow(): Promise<{
		row: typeof aiProviders.$inferSelect;
		modelId: string;
	}> {
		// Check project-level provider/model override
		const [providerSetting, modelSetting] = await Promise.all([
			db.select({ value: settings.value }).from(settings)
				.where(eq(settings.key, `project:${this.projectId}:chatProviderId`)).limit(1),
			db.select({ value: settings.value }).from(settings)
				.where(eq(settings.key, `project:${this.projectId}:chatModelId`)).limit(1),
		]);

		const chatProviderId = providerSetting[0]?.value || null;
		const chatModelId = modelSetting[0]?.value || null;

		// If a project-level provider is set, use it
		if (chatProviderId) {
			const overrideRows = await db.select().from(aiProviders)
				.where(eq(aiProviders.id, chatProviderId)).limit(1);
			if (overrideRows.length > 0) {
				const row = overrideRows[0];
				// A disabled model must never run — fall back to the provider default.
				const enabledChatModel = chatModelId && !(await this.isModelDisabled(row.id, chatModelId)) ? chatModelId : null;
				const modelId = enabledChatModel ?? row.defaultModel ?? getDefaultModel(row.providerType);
				return { row, modelId };
			}
		}

		// Fall back to global default provider
		let rows = await db
			.select()
			.from(aiProviders)
			.where(eq(aiProviders.isDefault, 1))
			.limit(1);

		if (rows.length === 0) {
			rows = await db.select().from(aiProviders).limit(1);
		}

		if (rows.length === 0) {
			throw new Error(
				"No AI providers configured. Please add a provider in Settings.",
			);
		}

		const row = rows[0];
		// A disabled model must never run — fall back to the provider default.
		const enabledChatModel = chatModelId && !(await this.isModelDisabled(row.id, chatModelId)) ? chatModelId : null;
		const modelId =
			enabledChatModel ?? row.defaultModel ?? getDefaultModel(row.providerType);

		return { row, modelId };
	}

	/** True iff the model has an explicit `is_enabled = 0` row in model_preferences. */
	private async isModelDisabled(providerId: string, modelId: string): Promise<boolean> {
		const rows = await db.select({ isEnabled: modelPreferences.isEnabled })
			.from(modelPreferences)
			.where(and(eq(modelPreferences.providerId, providerId), eq(modelPreferences.modelId, modelId)))
			.limit(1);
		return rows.length > 0 && rows[0].isEnabled === 0;
	}

	/** Triggers AI summarization for a conversation in the background. */
	private async triggerSummarization(
		conversationId: string,
		providerRow: typeof aiProviders.$inferSelect,
		modelId: string,
	): Promise<void> {
		try {
			await summarizeConversation({
				conversationId,
				providerConfig: {
					id: providerRow.id,
					name: providerRow.name,
					providerType: providerRow.providerType,
					apiKey: providerRow.apiKey,
					baseUrl: providerRow.baseUrl,
					defaultModel: providerRow.defaultModel,
				},
				modelId,
			});
			// Compute remaining tokens after compaction for the UI indicator
			const remainingRows = await db
				.select({ content: messages.content })
				.from(messages)
				.where(eq(messages.conversationId, conversationId));
			const remainingTokens = remainingRows.reduce(
				(sum, m) => sum + Math.ceil((m.content?.length ?? 0) / 4),
				0,
			);
			// Drop the stale pre-compaction peak so the next pre-send check doesn't
			// re-trigger on it; the next completed stream repopulates this with the
			// real post-compaction usage. Mirrors the figure pushed to the UI bar.
			this.lastPromptTokens.set(conversationId, remainingTokens);
			this.callbacks.onConversationCompacted?.(conversationId, remainingTokens);
		} catch (err) {
			console.error(
				`[AgentEngine] Background summarization failed for conversation ${conversationId}:`,
				err,
			);
		}
	}

	/** Bump conversation.updatedAt and broadcast so the frontend re-sorts the sidebar. */
	private _touchConversation(conversationId: string): void {
		const now = new Date().toISOString();
		db.update(conversations)
			.set({ updatedAt: now })
			.where(eq(conversations.id, conversationId))
			.catch(() => {});
		this.callbacks.onConversationUpdated?.(conversationId, now);

		// If an agent is working in a separate task conversation, keep it above
		// the PM conversation by giving it a timestamp 1ms later.
		// Broadcast directly with projectId so the frontend can load the conv
		// into the sidebar even if it isn't cached in the store yet.
		const agentConvId = this.activeAgentConversationId;
		if (agentConvId && agentConvId !== conversationId) {
			const agentNow = new Date(new Date(now).getTime() + 1).toISOString();
			db.update(conversations)
				.set({ updatedAt: agentNow })
				.where(eq(conversations.id, agentConvId))
				.catch(() => {});
			import("../engine-manager").then(({ broadcastToWebview: bcast }) => {
				bcast("conversationUpdated", {
					conversationId: agentConvId,
					updatedAt: agentNow,
					projectId: this.projectId,
				});
			}).catch(() => {});
		}
	}

	private async autoTitleConversation(
		conversationId: string,
		firstUserMessage: string,
	): Promise<void> {
		const convRows = await db
			.select({ title: conversations.title })
			.from(conversations)
			.where(eq(conversations.id, conversationId));

		if (convRows.length === 0 || convRows[0].title !== "New conversation") {
			return;
		}

		const sourcePrefix = this.activeMetadata.source !== "app"
			? `[${this.activeMetadata.source}] `
			: "";
		const rawTitle = firstUserMessage.trim().replace(/\s+/g, " ");
		const maxLen = 40 - sourcePrefix.length;
		const truncated = rawTitle.length <= maxLen ? rawTitle : rawTitle.slice(0, maxLen - 3) + "...";
		const title = `${sourcePrefix}${truncated}`;

		await db
			.update(conversations)
			.set({ title, updatedAt: new Date().toISOString() })
			.where(eq(conversations.id, conversationId));

		this.callbacks.onConversationTitleChanged?.(conversationId, title);
	}
}
