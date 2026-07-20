// ---------------------------------------------------------------------------
// Ambient Assistant — the cross-project voice-assistant turn behind Ambient
// Mode's "Talk to PM" (docs/ambient-pm-voice-plan.md Subsystem 2). Unlike the
// per-project AgentEngine (one instance per project, tied to a persisted
// conversation), this has no per-project scope or DB-backed conversation row —
// just an in-memory, FIFO-capped turn history (see conversationHistory below)
// shared across every turn for the life of the app process.
// Mirrors rpc/dashboard.ts's PM widget shape (a standalone, non-project chat
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
import { aiProviders, projects } from "../db/schema";
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
import { join } from "path";
import { Utils } from "electrobun/bun";
import { buildUserProfileSection, loadUserTimezone, SECURITY_RULES_SECTION } from "../agents/prompts";
import { skillRegistry } from "../skills/registry";
import { skillTools } from "../agents/tools/skills";
import { webTools } from "../agents/tools/web";
import { kanbanTools } from "../agents/tools/kanban";
import { gitTools } from "../agents/tools/git";
import { schedulerTools } from "../agents/tools/scheduler";
import { fileOpsTools } from "../agents/tools/file-ops";
import { systemTools } from "../agents/tools/system";
import { processTools } from "../agents/tools/process";
import { createMemoryTools, buildMemoryIndexSection } from "../agents/tools/memory";
import { createThrottledAccumulator } from "../agents/throttled-accumulator";
import { logAmbient } from "./debug-log";

// The ambient assistant's memory (save_memory/recall_memory/delete_memory)
// deliberately reuses agent_memories — a per-(agentName, projectId) durable
// store — rather than global_memories (PM-only, shared by every real
// project's PM, about the user in general — see agents/tools/global-memory.ts's
// own header). "Agent-specific, not global" means this assistant's memories
// must be its OWN, isolated from both of those: not mixed into the shared
// global pool, and not a real project's PM memory either. agent_memories.projectId
// is a NOT NULL foreign key into `projects`, so there is no "no project"
// option — the fix is a real, hidden pseudo-project row (same isQuickChat=1
// hiding mechanism Quick Chat already uses to keep a project out of
// getProjectsList/Dashboard) that exists ONLY to give this assistant its own
// memory scope. Created once, cached in memory for the process lifetime.
const AMBIENT_MEMORY_AGENT_NAME = "ambient-assistant";
const AMBIENT_MEMORY_PROJECT_NAME = "__ambient_assistant_memory__";
let ambientMemoryProjectId: string | null = null;

async function ensureAmbientMemoryProjectId(): Promise<string> {
	if (ambientMemoryProjectId) return ambientMemoryProjectId;
	const existing = await db.select({ id: projects.id }).from(projects).where(eq(projects.name, AMBIENT_MEMORY_PROJECT_NAME)).limit(1);
	if (existing[0]) {
		ambientMemoryProjectId = existing[0].id;
		return ambientMemoryProjectId;
	}
	const id = crypto.randomUUID();
	await db.insert(projects).values({
		id,
		name: AMBIENT_MEMORY_PROJECT_NAME,
		description: "Internal — private memory storage for Ambient Mode's voice assistant. Not a real project; hidden from every project list.",
		workspacePath: join(Utils.paths.userData, "ambient", "memory-workspace"),
		status: "active",
		isQuickChat: 1,
	});
	logAmbient(`created hidden pseudo-project for ambient assistant memory: ${id}`);
	ambientMemoryProjectId = id;
	return id;
}

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

// Feeds the ambient voice pipeline's TTS streaming (see runAmbientAssistantTurn's
// handleTextDelta/onTextChunk below): extracts every complete sentence out of
// a growing text buffer, leaving any trailing incomplete one for the next
// call. Deliberately simple (no abbreviation handling for "Mr." / "3.14" —
// splitting a little too eagerly just produces a slightly shorter TTS chunk,
// not a wrong answer, so it's not worth the complexity of a real sentence
// tokenizer here) — sentence-ending punctuation followed by whitespace is
// "good enough" for chunking a spoken reply, not for grammatical correctness.
function extractCompleteSentences(buffer: string): { sentences: string[]; remainder: string } {
	const sentences: string[] = [];
	let remainder = buffer;
	const sentenceEnd = /[.!?]+(?=\s)\s*/;
	while (true) {
		const match = remainder.match(sentenceEnd);
		if (!match || match.index === undefined) break;
		const end = match.index + match[0].length;
		const sentence = remainder.slice(0, end).trim();
		if (sentence) sentences.push(sentence);
		remainder = remainder.slice(end);
	}
	return { sentences, remainder };
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

async function buildAmbientTools() {
	const ambientProjectId = await ensureAmbientMemoryProjectId();
	const memoryTools = createMemoryTools(AMBIENT_MEMORY_AGENT_NAME, ambientProjectId);
	return {
		list_projects: tool({
			description:
				"List every project in AgentDesk with its id, name, status, and workspace path. Call this first " +
				"whenever the user names a project — you need its id before calling get_project_status or dispatching " +
				"work to it, or its workspacePath before calling git_log/git_diff.",
			inputSchema: z.object({}),
			execute: async () => {
				const projectsList = await getProjectsList();
				return JSON.stringify(projectsList.map((p) => ({ id: p.id, name: p.name, status: p.status, workspacePath: p.workspacePath })));
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
		search_projects: tool({
			description:
				"Fuzzy-search projects by name or description — use this instead of list_projects when the user's spoken project " +
				"name might not match exactly (voice transcription can mishear names). Returns the closest matches, best first.",
			inputSchema: z.object({ query: z.string().describe("Search query matched against project names and descriptions.") }),
			execute: async ({ query }) => {
				const rows = await db.select({ id: projects.id, name: projects.name, description: projects.description, workspacePath: projects.workspacePath }).from(projects);
				const q = query.toLowerCase();
				const scored = rows
					.map((p) => {
						const name = p.name.toLowerCase();
						const desc = (p.description ?? "").toLowerCase();
						let score = 0;
						if (name === q) score = 100;
						else if (name.includes(q)) score = 80;
						else if (q.includes(name)) score = 60;
						else if (desc.includes(q)) score = 40;
						else for (const w of q.split(/\s+/)) {
							if (name.includes(w)) score += 20;
							else if (desc.includes(w)) score += 10;
						}
						return { ...p, score };
					})
					.filter((p) => p.score > 0)
					.sort((a, b) => b.score - a.score)
					.slice(0, 5);
				return JSON.stringify({ matches: scored });
			},
		}),
		// Skills — explicitly requested so the ambient assistant can load and
		// follow the same specialized instructions the main PM and dashboard
		// widget can (see buildSystemPrompt's "Available Skills" section below).
		read_skill: skillTools.read_skill.tool,
		find_skills: skillTools.find_skills.tool,
		// General web access — the ambient assistant otherwise has zero way to
		// answer anything outside AgentDesk's own data (e.g. "what's today's
		// exchange rate", general knowledge questions asked mid-conversation).
		web_search: webTools.web_search.tool,
		// Richer per-task detail than get_project_status's aggregate counts —
		// project-scoped, same as every other tool here.
		list_tasks: kanbanTools.list_tasks.tool,
		get_task: kanbanTools.get_task.tool,
		// Richer git detail alongside the existing get_git_status summary.
		git_log: gitTools.git_log.tool,
		git_diff: gitTools.git_diff.tool,
		// Lets a voice request like "remind me to check the build in 10 minutes"
		// actually create something, not just report on existing jobs
		// (get_scheduled_jobs above is read-only listing).
		create_cron_job: schedulerTools.create_cron_job,
		list_cron_jobs: schedulerTools.list_cron_jobs,
		// File exploration — project-scoped via the workspacePath list_projects/
		// search_projects now return, same as git_log/git_diff above.
		read_file: fileOpsTools.read_file.tool,
		file_info: fileOpsTools.file_info.tool,
		directory_tree: fileOpsTools.directory_tree.tool,
		search_files: fileOpsTools.search_files.tool,
		search_content: fileOpsTools.search_content.tool,
		// App/host environment introspection — no project scoping needed.
		environment_info: systemTools.environment_info.tool,
		get_env: systemTools.get_env.tool,
		// Sleep — lets a multi-step voice request pace itself (e.g. "check again
		// in a minute") without needing a full cron job for something this short.
		sleep: systemTools.sleep.tool,
		// Check whether a given process/port is running — useful for "is the dev
		// server still up" type status questions.
		check_process: processTools.check_process.tool,
		// Web access beyond search — fetch a specific URL's content, or make an
		// arbitrary HTTP request (API testing, checking a webhook, etc.).
		web_fetch: webTools.web_fetch.tool,
		http_request: webTools.http_request.tool,
		// Durable memory — save_memory/recall_memory/delete_memory — private to
		// this assistant (see ensureAmbientMemoryProjectId's comment above for
		// why this is neither the shared global-memory pool nor a real
		// project's own PM memory).
		save_memory: memoryTools.save_memory.tool,
		recall_memory: memoryTools.recall_memory.tool,
		delete_memory: memoryTools.delete_memory.tool,
	};
}

// Rebuilt fresh per turn (not a static const) — the whole point of the date/
// time and user-profile sections below is that they're only correct if
// recomputed every time, the same reasoning rpc/dashboard.ts's
// buildDashboardSystemPrompt applies to its own PM widget (the closest
// architectural sibling to this surface: same in-memory-only, cross-project,
// no-DB-conversation shape).
async function buildSystemPrompt(): Promise<string> {
	const userTimezone = await loadUserTimezone();
	const now = new Date();
	const localTime = now.toLocaleString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: userTimezone });

	let prompt =
		"You are `AgentDesk Project Manager` — the same Project Manager identity used everywhere else " +
		"in AgentDesk, answering here through Ambient Mode's cross-project voice interface, separate " +
		"from any single project's own PM chat.\n\n" +
		`Current time: ${localTime} (${userTimezone})\n\n` +
		"Answer questions about what's happening across the user's projects: active agents, task " +
		"completion, pending approvals, recent activity, code review backlog, unread channel messages, " +
		"scheduled jobs, freelance/Auto-Earn status, and per-project git status. Use the tools available " +
		"to check real data — never guess or make up numbers. When the user asks you to start, begin, or " +
		"take action on work for a named project, use dispatch_to_project rather than trying to do the " +
		"work yourself — you are a router to that project's own PM, not a coding agent. Keep replies " +
		"short and conversational, like a spoken answer, not a written report — one or two sentences " +
		"unless the user clearly asked for a list. If the user names a project, call list_projects (or " +
		"search_projects if the name might have been misheard) first to resolve it to an id before " +
		"calling any project-specific tool. You can also create reminders/scheduled jobs, search the " +
		"web, fetch a URL's content, or make direct HTTP requests for general questions outside " +
		"AgentDesk's own data, read installed skills for specialized instructions, explore and read a " +
		"project's files (read_file/file_info/directory_tree/search_files/search_content, using its " +
		"workspacePath), check whether a process/port is running (check_process), and check host/" +
		"environment details (environment_info/get_env). Use save_memory to remember durable facts across " +
		"conversations (user preferences, things they explicitly asked you to remember) and " +
		"recall_memory to retrieve them — this memory is private to you, separate from any project's " +
		"own PM.\n\n" +
		SECURITY_RULES_SECTION;

	const userSection = await buildUserProfileSection();
	if (userSection) prompt += `\n\n${userSection}`;

	const skills = skillRegistry.getAll();
	if (skills.length > 0) {
		const lines = skills.map((s) => {
			const agentTag = s.preferredAgent ? ` [agent: ${s.preferredAgent}]` : "";
			return `- **${s.name}**: ${s.description.slice(0, 120)}${agentTag}`;
		});
		prompt +=
			"\n\n## Available Skills\n\nThe following skills are installed. Use `read_skill` to load a " +
			"skill's full instructions before following it. Use `find_skills` to search by keyword.\n\n" +
			lines.join("\n");
	}

	// Your own memory index — private to this assistant, not the shared
	// global-memory pool or any real project's PM memory (see
	// ensureAmbientMemoryProjectId's comment). Empty until save_memory is used
	// at least once.
	const ambientProjectId = await ensureAmbientMemoryProjectId();
	const memorySection = await buildMemoryIndexSection(AMBIENT_MEMORY_AGENT_NAME, ambientProjectId);
	if (memorySection) prompt += `\n\n${memorySection}`;

	return prompt;
}

export interface RunAmbientAssistantTurnOptions {
	onPart?: (part: AmbientAssistantPart) => void;
	// Fired once per complete sentence as the answer streams in (real
	// token-level deltas — both the CLI path's onTextToken and streamText's
	// text-delta give these), so the caller can start speaking the answer
	// sentence-by-sentence instead of waiting for the whole thing to finish
	// generating. Never fires for a provider/path that doesn't stream deltas
	// (only the closing-remark shortcut and non-streaming fallbacks) — the
	// caller is expected to fall back to speaking the final `answer` string
	// directly if no chunks ever arrived.
	onTextChunk?: (chunk: string) => void;
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
	const tools = await buildAmbientTools();
	const signal = opts.abortSignal ? AbortSignal.any([opts.abortSignal, AbortSignal.timeout(TURN_TIMEOUT_MS)]) : AbortSignal.timeout(TURN_TIMEOUT_MS);
	pushHistory({ role: "user", content: question });

	// Streams the answer live, two ways, from the same token-level deltas
	// (CLI path's onTextToken, streamText's text-delta — see handleTextDelta
	// below): (1) a growing "text" part under one stable id, throttled via the
	// same createThrottledAccumulator every other "Full Streaming" path in
	// this codebase uses, so the tool-call pane shows the answer forming
	// instead of staying on "Thinking…" until it's all done; (2) complete
	// sentences handed to onTextChunk as they finish, so the caller can start
	// speaking the answer before the model has finished generating the rest
	// of it. `textPartId`/`textSortOrder` are allocated lazily on the first
	// delta, not upfront, so the part's position in the pane reflects when
	// text actually started streaming relative to any tool calls, exactly
	// like tool-call parts already get their own sortOrder assigned live.
	let textPartId: string | null = null;
	let textSortOrder: number | null = null;
	let sentenceRemainder = "";
	const textAccumulator = createThrottledAccumulator((accumulated) => {
		if (textPartId === null || textSortOrder === null) return;
		emitPart({
			id: textPartId, messageId, type: "text", content: accumulated,
			toolName: null, toolInput: null, toolOutput: null, toolState: null,
			sortOrder: textSortOrder, timeStart: null, timeEnd: null,
		});
	});
	function handleTextDelta(delta: string) {
		if (!delta) return;
		if (textPartId === null) {
			textPartId = crypto.randomUUID();
			textSortOrder = sortOrder++;
		}
		textAccumulator.push(delta);
		sentenceRemainder += delta;
		const { sentences, remainder } = extractCompleteSentences(sentenceRemainder);
		sentenceRemainder = remainder;
		for (const sentence of sentences) opts.onTextChunk?.(sentence);
	}

	const usingCli = provider.providerType === "claude-subscription" && !isHaikuModel(modelId);
	const tPrompt = performance.now();
	const systemPrompt = await buildSystemPrompt();
	logAmbient(`provider=${provider.providerType} model=${modelId} path=${usingCli ? "claude-cli" : "streamText"} historyLen=${conversationHistory.length} systemPromptBuilt in ${Math.round(performance.now() - tPrompt)}ms (${systemPrompt.length} chars)`);

	let fullText = "";
	const tCall = performance.now();

	if (usingCli) {
		const { runClaudeCliTask } = await import("../providers/claude-subscription-cli-runner");
		const orderByCallId = new Map<string, number>();
		const cliResult = await runClaudeCliTask({
			task: flattenHistoryForCli(conversationHistory),
			systemPrompt,
			tools,
			modelId,
			timeoutMs: TURN_TIMEOUT_MS,
			abortSignal: signal,
			verifyToolCall: false, // ambient status/dispatch turns may legitimately need zero tool calls
			onText: (text) => { fullText += text; },
			onReasoning: () => { /* not surfaced — matches dashboard-agent.ts's chat path */ },
			onTextToken: (delta) => handleTextDelta(delta),
			// A verification failure is retrying the whole attempt from scratch —
			// unlike fullText (built from the buffered/replayed onText, already
			// safe by construction), everything handleTextDelta built from the
			// live, unbuffered onTextToken stream belongs to the discarded
			// attempt and must not bleed into the retry's own text. The
			// accumulator has no reset-content method (only cancel-pending-timer),
			// so instead of trying to reuse it, drop the id/sortOrder entirely —
			// the next delta allocates a fresh one, same as a brand new turn would.
			onRetract: () => {
				logAmbient("ambient text stream retracted (verification retry) — discarding partial streamed text/chunks");
				textAccumulator.cancel();
				textPartId = null;
				textSortOrder = null;
				sentenceRemainder = "";
			},
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
			instructions: systemPrompt,
			messages: conversationHistory,
			tools,
			stopWhen: [isStepCount(20)],
			abortSignal: signal,
		});

		const orderByCallId = new Map<string, number>();
		for await (const part of result.stream) {
			if (part.type === "text-delta") {
				const delta = (part as { text?: string }).text ?? "";
				fullText += delta;
				handleTextDelta(delta);
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

	// Cancel (not flush) the accumulator's pending timer — the definitive
	// emitPart just below already delivers the complete `fullText` a moment
	// later, so letting the throttled timer ALSO fire here would just emit
	// the same content twice in a row (confirmed live: two back-to-back
	// "part received" broadcasts with identical content). Any trailing text
	// that never reached a sentence boundary (e.g. an answer with no closing
	// punctuation, or one short/fast enough that everything arrived in a
	// single delta before the first sentence-end match) still needs to reach
	// onTextChunk, though — otherwise the caller never speaks it.
	textAccumulator.cancel();
	if (sentenceRemainder.trim()) {
		opts.onTextChunk?.(sentenceRemainder.trim());
		sentenceRemainder = "";
	}

	pushHistory({ role: "assistant", content: fullText });

	// Reuses the same id/sortOrder the streamed updates above already used
	// (falls back to fresh ones only if no delta ever streamed in — e.g. a
	// provider/path without token-level streaming) so this is recognized as
	// the SAME part finishing, not a second one — sets the definitive final
	// content/timeEnd rather than leaving the pane on whatever the last
	// throttled update happened to contain.
	if (textPartId === null) textPartId = crypto.randomUUID();
	if (textSortOrder === null) textSortOrder = sortOrder++;
	emitPart({
		id: textPartId, messageId, type: "text", content: fullText,
		toolName: null, toolInput: null, toolOutput: null, toolState: null,
		sortOrder: textSortOrder, timeStart: null, timeEnd: new Date().toISOString(),
	});

	return { answer: fullText };
}
