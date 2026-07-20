// ---------------------------------------------------------------------------
// Ambient Assistant — the cross-project voice-assistant turn behind Ambient
// Mode's "Talk to PM" (docs/ambient-pm-voice-plan.md Subsystem 2). Unlike the
// per-project AgentEngine (one instance per project, tied to a persisted
// conversation), this has no per-project scope or DB-backed conversation row —
// just an in-memory, FIFO-capped turn history (see conversationHistory below)
// shared across every turn for the life of the app process.
// Mirrors rpc/dashboard-agent.ts's shape (a standalone, non-project chat
// surface with its own tools) including its dual-path model invocation: the
// Claude Subscription direct-HTTP OAuth path 429s for anything but Haiku, so
// non-Haiku models must route through the official Agent SDK CLI runner
// instead (see CLAUDE.md's "Claude Subscription is a two-path AI provider"
// rule) — skipping that branch here would silently break this feature for
// any user on a Claude Subscription plan running Sonnet/Opus.
// ---------------------------------------------------------------------------

import { streamText, isStepCount, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { aiProviders } from "../db/schema";
import { createProviderAdapter } from "../providers";
import { getDefaultModel } from "../providers/models";
import { isHaikuModel } from "../providers/claude-subscription";
import { getActiveProjectAgentsList, getGlobalPendingApprovalCount, getRecentGlobalActivity, getOrCreateEngine } from "../engine-manager";
import { getProjectsList } from "../rpc/projects";
import { getProjectTaskStats, getReviewQueue } from "../rpc/kanban";
import { createConversation } from "../rpc/conversations";
import { getUnreadCount } from "../rpc/inbox";
import { getCronJobs } from "../rpc/cron";
import { getListingCounts } from "../rpc/freelance";
import { getCurrentBranch, getGitStatus } from "../rpc/git";
import { getPullRequests } from "../rpc/pulls";
import { logAmbient } from "./debug-log";

const TURN_TIMEOUT_MS = 120_000;

// In-memory turn history for the ambient assistant — there's no per-project
// conversation row backing this surface (see file header), so without this
// every question was answered with zero awareness of anything said earlier
// in the same voice session. Capped FIFO at 100 messages (oldest dropped
// first) rather than persisted, same tradeoff as dashboard-agent.ts's own
// sessionHistory: this is a live-session memory aid, not a durable record.
const MAX_HISTORY_MESSAGES = 100;
let conversationHistory: ModelMessage[] = [];

function pushHistory(message: ModelMessage) {
	conversationHistory.push(message);
	if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
		conversationHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES);
	}
}

// The CLI/SDK path's query() takes a single flattened prompt, not a
// ModelMessage[] — same constraint and same fix as dashboard-agent.ts's
// flattenHistoryForCli.
function flattenHistoryForCli(history: ModelMessage[]): string {
	return history.map((m) => {
		const text = typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? m.content.map((p) => (p && typeof p === "object" && "text" in p ? (p as { text?: string }).text ?? "" : "")).filter(Boolean).join("\n")
				: "";
		return `[${m.role}]\n${text}`;
	}).join("\n\n");
}

// A voice turn that's purely a closing remark ("thanks", "that's all", "bye")
// isn't a real request — routing it through the full tool-calling turn risks
// the model politely narrating or even invoking a tool on nothing. Matched
// against the WHOLE trimmed utterance (not a substring), so "thanks, also
// check the git status" correctly falls through to a real turn.
const CLOSING_REMARK_PATTERNS: RegExp[] = [
	/^(ok(ay)?[,\s]+)?(thanks|thank you|thx|cheers|ta)([,\s]+(a lot|so much|very much|man|buddy|mate))?[.!]*$/i,
	/^(that'?s|that will|that'?ll) (be )?all[.!]*$/i,
	/^(no(pe)?[,\s]*)?(that'?s it|nothing else|i'?m (all )?(done|good)|all good)([,\s]*(thanks?|thank you))?[.!]*$/i,
	/^(bye|goodbye|see ya|see you|catch you later)[.!]*$/i,
];

function isClosingRemark(text: string): boolean {
	const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
	return normalized.length > 0 && CLOSING_REMARK_PATTERNS.some((re) => re.test(normalized));
}

function closingRemarkReply(text: string): string {
	if (/^(bye|goodbye|see ya|see you|catch you later)/i.test(text.trim())) {
		return "Goodbye! Just tap Talk to PM whenever you need me again.";
	}
	return "You're welcome! Let me know if there's anything else.";
}

/**
 * Structurally the same shape as the persisted message-part rows
 * (`getMessageParts`'s response in shared/rpc/conversations.ts) so the tool-
 * call side pane (a later task) can reuse the same rendering code the normal
 * per-project chat UI already has for tool calls — this turn just never
 * writes these to the DB, only broadcasts them.
 */
export interface AmbientAssistantPart {
	id: string;
	messageId: string;
	type: "text" | "tool_call";
	content: string;
	toolName: string | null;
	toolInput: string | null;
	toolOutput: string | null;
	toolState: "running" | "complete" | "error" | null;
	sortOrder: number;
	timeStart: string | null;
	timeEnd: string | null;
}

async function getDefaultProvider() {
	const def = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
	if (def[0]) return def[0];
	const any = await db.select().from(aiProviders).limit(1);
	if (!any[0]) throw new Error("No AI provider configured.");
	return any[0];
}

function buildAmbientTools() {
	return {
		list_projects: tool({
			description:
				"List every project in AgentDesk with its id, name, and status. Call this first whenever " +
				"the user names a project — you need its id before calling get_project_status or dispatching work to it.",
			inputSchema: z.object({}),
			execute: async () => {
				const projectsList = await getProjectsList();
				return JSON.stringify(projectsList.map((p) => ({ id: p.id, name: p.name, status: p.status })));
			},
		}),
		get_project_status: tool({
			description: "Get task completion counts (done/total) and the currently-active agent count for ONE specific project.",
			inputSchema: z.object({ projectId: z.string().describe("The project's id, from list_projects.") }),
			execute: async ({ projectId }) => {
				const [stats, activeAgents] = await Promise.all([getProjectTaskStats(), Promise.resolve(getActiveProjectAgentsList())]);
				const s = stats.find((x) => x.projectId === projectId);
				const a = activeAgents.find((x) => x.projectId === projectId);
				return JSON.stringify({ done: s?.done ?? 0, total: s?.total ?? 0, activeAgents: a?.agentCount ?? 0 });
			},
		}),
		list_active_agents: tool({
			description: "List every project that currently has at least one agent actively working, with how many agents are running on each.",
			inputSchema: z.object({}),
			execute: async () => JSON.stringify(getActiveProjectAgentsList()),
		}),
		get_recent_activity: tool({
			description:
				"Get a rolling log of the most recent cross-project events — agents starting or finishing, kanban tasks moving. " +
				"Useful for 'what just happened' or 'what did agents do recently' type questions.",
			inputSchema: z.object({}),
			execute: async () => JSON.stringify(getRecentGlobalActivity()),
		}),
		get_pending_approvals: tool({
			description: "Get the total count of shell-command and question approvals currently awaiting the user's response, across every project.",
			inputSchema: z.object({}),
			execute: async () => JSON.stringify({ count: getGlobalPendingApprovalCount() }),
		}),
		dispatch_to_project: tool({
			description:
				"Start real work on a project: creates a new conversation in that project and hands your " +
				"instruction to that project's own PM, which plans, asks for human approval if needed, and " +
				"dispatches agents — exactly as if the user had typed the instruction into that project's chat " +
				"themselves. Use this whenever the user asks you to start or begin work, build or implement a " +
				"feature, fix a bug, or otherwise take action on a NAMED project — never for a status question " +
				"(use get_project_status/list_active_agents/etc. for those instead). Always call list_projects " +
				"first to resolve the project name to its id before calling this.",
			inputSchema: z.object({
				projectId: z.string().describe("The target project's id, from list_projects."),
				instruction: z.string().describe("The task to hand to that project's PM, in the user's own words (lightly cleaned up is fine, but keep their intent intact)."),
			}),
			execute: async ({ projectId, instruction }) => {
				const projectsList = await getProjectsList();
				const project = projectsList.find((p) => p.id === projectId);
				if (!project) {
					return JSON.stringify({ error: `No project found with id "${projectId}". Call list_projects again and pick a real id from that list.` });
				}
				// An explicit title (rather than omitting it) opts out of
				// createConversation's own "reuse an empty conversation" behavior —
				// every dispatch gets its own new conversation, per the confirmed plan.
				const title = instruction.length > 60 ? `${instruction.slice(0, 57)}...` : instruction;
				const conversation = await createConversation(projectId, title);
				const engine = getOrCreateEngine(projectId);
				const result = await engine.sendMessage(conversation.id, instruction);
				return JSON.stringify({
					success: true,
					projectId,
					projectName: project.name,
					conversationId: conversation.id,
					messageId: result.messageId,
				});
			},
		}),
		get_review_queue: tool({
			description: "List every kanban task currently sitting in the 'review' column (code review backlog), across ALL projects, with project names attached.",
			inputSchema: z.object({}),
			execute: async () => JSON.stringify(getReviewQueue()),
		}),
		get_inbox_summary: tool({
			description: "Get the unread message count in the unified inbox (Discord/WhatsApp/Email combined), optionally scoped to one project.",
			inputSchema: z.object({ projectId: z.string().optional().describe("Resolve via list_projects if the user names a specific project; omit for the total across everything.") }),
			execute: async ({ projectId }) => JSON.stringify(await getUnreadCount(projectId)),
		}),
		get_scheduled_jobs: tool({
			description: "List active scheduled/cron jobs, with their next run time and whether they're currently running.",
			inputSchema: z.object({ projectId: z.string().optional().describe("Resolve via list_projects if the user names a specific project; omit for every job across all projects.") }),
			execute: async ({ projectId }) => JSON.stringify(await getCronJobs(projectId ? { projectId } : undefined)),
		}),
		get_freelance_summary: tool({
			description: "Get Auto-Earn/freelance status: counts of new, shortlisted, approved, and closed listings, plus how many have a bid placed.",
			inputSchema: z.object({}),
			execute: async () => JSON.stringify(await getListingCounts()),
		}),
		get_git_status: tool({
			description: "Get a project's current git branch, how many files are dirty (uncommitted changes), and how many open pull requests it has.",
			inputSchema: z.object({ projectId: z.string().describe("The project's id, from list_projects.") }),
			execute: async ({ projectId }) => {
				const [branch, status, openPrs] = await Promise.all([
					getCurrentBranch(projectId),
					getGitStatus(projectId),
					getPullRequests(projectId, "open"),
				]);
				return JSON.stringify({ branch: branch.branch, dirtyFileCount: status.files.length, openPullRequestCount: openPrs.length });
			},
		}),
	};
}

const SYSTEM_PROMPT =
	"You are AgentDesk's ambient voice assistant — a cross-project status and dispatch helper the " +
	"user talks to via a voice interface, separate from any single project's own PM chat. Answer " +
	"questions about what's happening across the user's projects: active agents, task completion, " +
	"pending approvals, recent activity, code review backlog, unread channel messages, scheduled " +
	"jobs, freelance/Auto-Earn status, and per-project git status. Use the tools available to check " +
	"real data — never guess or make up numbers. When the user asks you to start, begin, or take " +
	"action on work for a named project, use dispatch_to_project rather than trying to do the work " +
	"yourself — you are a router to that project's own PM, not a coding agent. Keep replies short " +
	"and conversational, like a spoken answer, not a written report — one or two sentences unless " +
	"the user clearly asked for a list. If the user names a project, call list_projects first to " +
	"resolve the name to an id before calling any project-specific tool.";

export interface RunAmbientAssistantTurnOptions {
	onPart?: (part: AmbientAssistantPart) => void;
	abortSignal?: AbortSignal;
	// Lets the caller's own turn id double as the broadcast messageId, so a
	// frontend that tracks multiple turns (e.g. a barge-in leaving an older
	// turn still running server-side) can route each streamed part to the
	// turn that actually produced it, instead of guessing via "whichever turn
	// is currently active." Falls back to a fresh id for other callers.
	messageId?: string;
}

export async function runAmbientAssistantTurn(question: string, opts: RunAmbientAssistantTurnOptions = {}): Promise<{ answer: string }> {
	const messageId = opts.messageId ?? crypto.randomUUID();
	let sortOrder = 0;
	const emitPart = (part: AmbientAssistantPart) => opts.onPart?.(part);

	if (isClosingRemark(question)) {
		logAmbient(`"${question}" matched as a closing remark — skipping the full turn`);
		const answer = closingRemarkReply(question);
		pushHistory({ role: "user", content: question });
		pushHistory({ role: "assistant", content: answer });
		emitPart({
			id: crypto.randomUUID(), messageId, type: "text", content: answer,
			toolName: null, toolInput: null, toolOutput: null, toolState: null,
			sortOrder: sortOrder++, timeStart: null, timeEnd: new Date().toISOString(),
		});
		return { answer };
	}

	const provider = await getDefaultProvider();
	const modelId = provider.defaultModel ?? getDefaultModel(provider.providerType);
	const tools = buildAmbientTools();
	const signal = opts.abortSignal ? AbortSignal.any([opts.abortSignal, AbortSignal.timeout(TURN_TIMEOUT_MS)]) : AbortSignal.timeout(TURN_TIMEOUT_MS);
	pushHistory({ role: "user", content: question });

	const usingCli = provider.providerType === "claude-subscription" && !isHaikuModel(modelId);
	logAmbient(`provider=${provider.providerType} model=${modelId} path=${usingCli ? "claude-cli" : "streamText"} historyLen=${conversationHistory.length}`);

	let fullText = "";
	const tCall = performance.now();

	if (usingCli) {
		const { runClaudeCliTask } = await import("../providers/claude-subscription-cli-runner");
		const orderByCallId = new Map<string, number>();
		const cliResult = await runClaudeCliTask({
			task: flattenHistoryForCli(conversationHistory),
			systemPrompt: SYSTEM_PROMPT,
			tools,
			modelId,
			timeoutMs: TURN_TIMEOUT_MS,
			abortSignal: signal,
			verifyToolCall: false, // ambient status/dispatch turns may legitimately need zero tool calls
			onText: (text) => { fullText += text; },
			onReasoning: () => { /* not surfaced — matches dashboard-agent.ts's chat path */ },
			onTextToken: () => { /* no token-level throttled broadcast needed for a one-shot turn */ },
			onRetract: () => { /* no throttled accumulator in play here to reset */ },
			onToolCallStart: (toolName, args) => {
				const callId = crypto.randomUUID();
				const order = sortOrder++;
				orderByCallId.set(callId, order);
				logAmbient(`tool_call start: ${toolName}(${JSON.stringify(args)})`);
				emitPart({
					id: callId, messageId, type: "tool_call", content: "",
					toolName, toolInput: JSON.stringify(args), toolOutput: null, toolState: "running",
					sortOrder: order, timeStart: new Date().toISOString(), timeEnd: null,
				});
				return callId;
			},
			onToolCallEnd: (callId, resultText, isError) => {
				const order = orderByCallId.get(callId) ?? sortOrder++;
				logAmbient(`tool_call ${isError ? "error" : "complete"}: ${resultText}`);
				emitPart({
					id: callId, messageId, type: "tool_call", content: "",
					toolName: null, toolInput: null, toolOutput: resultText, toolState: isError ? "error" : "complete",
					sortOrder: order, timeStart: null, timeEnd: new Date().toISOString(),
				});
			},
		});
		logAmbient(`claude-cli path status=${cliResult.status} in ${Math.round(performance.now() - tCall)}ms`);
		if (cliResult.status === "failed") throw new Error(cliResult.summary);
		if (cliResult.status === "timeout") throw new Error("The ambient assistant took too long to respond and was stopped.");
		// A genuine user-triggered cancel (barge-in) — must throw rather than fall
		// through to the fullText fallback below, which would otherwise push
		// cliResult.summary ("Cancelled by user") into conversationHistory and
		// emit it as a real answer, as if the assistant had actually said that.
		if (cliResult.status === "cancelled") throw new Error(cliResult.summary);
		if (!fullText.trim()) fullText = cliResult.summary;
	} else {
		const adapter = createProviderAdapter({
			id: provider.id, name: provider.name, providerType: provider.providerType,
			apiKey: provider.apiKey, baseUrl: provider.baseUrl, defaultModel: provider.defaultModel,
		});
		const result = streamText({
			model: adapter.createModel(modelId),
			instructions: SYSTEM_PROMPT,
			messages: conversationHistory,
			tools,
			stopWhen: [isStepCount(20)],
			abortSignal: signal,
		});

		const orderByCallId = new Map<string, number>();
		for await (const part of result.stream) {
			if (part.type === "text-delta") {
				fullText += (part as { text?: string }).text ?? "";
			} else if (part.type === "tool-call") {
				const order = sortOrder++;
				orderByCallId.set(part.toolCallId, order);
				const input = (part as Record<string, unknown>).input ?? (part as Record<string, unknown>).args;
				logAmbient(`tool_call start: ${part.toolName}(${typeof input === "string" ? input : JSON.stringify(input)})`);
				emitPart({
					id: part.toolCallId, messageId, type: "tool_call", content: "",
					toolName: part.toolName, toolInput: typeof input === "string" ? input : JSON.stringify(input),
					toolOutput: null, toolState: "running", sortOrder: order,
					timeStart: new Date().toISOString(), timeEnd: null,
				});
			} else if (part.type === "tool-result") {
				const order = orderByCallId.get(part.toolCallId) ?? sortOrder++;
				const output = (part as Record<string, unknown>).output ?? (part as Record<string, unknown>).result;
				logAmbient(`tool_call complete: ${typeof output === "string" ? output : JSON.stringify(output)}`);
				emitPart({
					id: part.toolCallId, messageId, type: "tool_call", content: "",
					toolName: part.toolName, toolInput: null,
					toolOutput: typeof output === "string" ? output : JSON.stringify(output),
					toolState: "complete", sortOrder: order, timeStart: null, timeEnd: new Date().toISOString(),
				});
			} else if (part.type === "error") {
				const err = (part as { error: unknown }).error;
				logAmbient(`streamText error part: ${err instanceof Error ? err.message : String(err)}`);
				throw err instanceof Error ? err : new Error(String(err));
			}
		}
		if (!fullText.trim()) {
			try { fullText = await result.text; } catch { /* not available */ }
		}
		logAmbient(`streamText path finished in ${Math.round(performance.now() - tCall)}ms`);
	}

	if (!fullText.trim()) throw new Error("The ambient assistant returned an empty response. Check your provider quota or default model.");

	pushHistory({ role: "assistant", content: fullText });

	emitPart({
		id: crypto.randomUUID(), messageId, type: "text", content: fullText,
		toolName: null, toolInput: null, toolOutput: null, toolState: null,
		sortOrder: sortOrder++, timeStart: null, timeEnd: new Date().toISOString(),
	});

	return { answer: fullText };
}
