/**
 * agent-loop.ts — Inline sub-agent executor
 *
 * Replaces sub-agent.ts. Runs a sub-agent inline in the main conversation:
 * the agent gets a fresh context (system prompt + task description only, NO
 * parent conversation history) and explores the codebase itself via tools.
 *
 * All tool calls and text output are persisted as message_parts in the main
 * conversation and streamed to the frontend via callbacks.
 */

import { generateText, type Tool, type ModelMessage } from "ai";
import { eq, inArray } from "drizzle-orm";
import { Utils } from "electrobun/bun";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { join, isAbsolute } from "path";
import { db } from "../db";
import { messages, messageParts, agents as agentsTable, aiProviders, conversations } from "../db/schema";
import type { ProviderConfig } from "../providers/types";
import { createProviderAdapter } from "../providers";
import { getDefaultModel, getContextLimit } from "../providers/models";
import { getAgentSystemPrompt } from "./prompts";
import { getToolsForAgent } from "./tools/index";
import { getPluginTools, applyAnthropicCaching } from "./engine-types";
import { getSetting } from "../rpc/settings";
import { FileTracker } from "./tools/file-tracker";
import { createTrackedFileTools } from "./tools/file-ops";
import { skillRegistry } from "../skills/registry";
import { logPrompt } from "./prompt-logger";
import { isTransientError, getBackoffDelay } from "./safety";

// ---------------------------------------------------------------------------
// Agent loop file logger — writes to {userData}/logs/agent-loop.log
// ---------------------------------------------------------------------------

let agentLogPath: string | null = null;

function logAgent(line: string): void {
	try {
		if (!agentLogPath) {
			const dir = join(Utils.paths.userData, "logs");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			agentLogPath = join(dir, "agent-loop.log");
		}
		appendFileSync(agentLogPath, `[${new Date().toISOString()}] ${line}\n`);
	} catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Tool-result error classification
// ---------------------------------------------------------------------------

/**
 * Tools whose output is file/match CONTENT that can legitimately start with
 * "Error" or contain an `error` field (e.g. a log file, a grep hit). For these
 * we trust only the SDK's own tool-error channel, never the string heuristics.
 */
const CONTENT_RESULT_TOOLS = new Set(["read_file", "search_content", "search_files"]);

/**
 * Heuristically decide whether a tool's string result represents a failure.
 *
 * Tools in this codebase return errors as strings (they catch and return rather
 * than throw), in several shapes:
 *   - a leading "Error …" / "Failed …" / "Blocked …" message,
 *   - a `"success":false` envelope,
 *   - a JSON `{ "error": "<message>" }` / `{ "valid": false }` envelope,
 *   - run_shell's `{ "exitCode": null, … }` (command blocked / denied / never ran).
 *
 * The model always sees the raw result text regardless of this verdict — this
 * only drives the ✓/✗ (and red styling) shown to the human in the UI. Kept
 * conservative to avoid false-flagging successful output.
 */
export function toolResultIsError(toolName: string, resultStr: string): boolean {
	if (CONTENT_RESULT_TOOLS.has(toolName)) return false;
	if (/^\s*(error|failed|blocked)\b/i.test(resultStr)) return true;

	// Prefer a structured verdict from the top-level JSON envelope. When the
	// result parses cleanly as an object we decide from its OWN fields and stop —
	// we never scan a nested response body, so e.g. http_request returning a
	// remote payload that happens to contain `"success":false` is NOT mis-flagged.
	const trimmed = resultStr.trimStart();
	if (trimmed.startsWith("{")) {
		try {
			const o = JSON.parse(resultStr) as Record<string, unknown>;
			if (o && typeof o === "object") {
				if (o.success === true) return false;
				if (o.success === false) return true;
				if (typeof o.error === "string" && o.error.trim() !== "") return true;
				if (o.valid === false) return true;
				// run_shell: a null exitCode means the command never ran
				// (blocked, denied, or spawn failure) — that is a failure.
				if ("exitCode" in o && o.exitCode === null) return true;
				return false; // parsed cleanly as a non-error envelope — trust it
			}
		} catch { /* partial/truncated JSON — fall through to the heuristic below */ }
	}

	// Non-JSON / unparseable result: last-resort substring heuristic.
	return resultStr.includes('"success":false');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessagePart {
	id: string;
	messageId: string;
	type: "text" | "tool_call" | "tool_result" | "reasoning" | "agent_start" | "agent_end";
	content: string;
	toolName?: string;
	toolInput?: string;
	toolOutput?: string;
	toolState?: "pending" | "running" | "success" | "error";
	sortOrder: number;
	agentName?: string;
	timeStart?: string;
	timeEnd?: string;
}

export interface InlineAgentCallbacks {
	onPartCreated(part: MessagePart): void;
	onPartUpdated(messageId: string, partId: string, updates: Partial<MessagePart>): void;
	onTextDelta(messageId: string, delta: string): void;
	onAgentStart(messageId: string, agentName: string, agentDisplayName: string, task: string): void;
	onAgentComplete(messageId: string, agentName: string, status: string, summary: string, filesModified: string[], tokensUsed: { prompt: number; completion: number; contextLimit?: number }): void;
	/** Notify frontend that a new agent message row was created so it appears in chat. */
	onMessageCreated?(messageId: string, conversationId: string, agentName: string, content: string): void;
}

export interface InlineAgentOptions {
	conversationId: string;
	agentName: string;
	agentDisplayName: string;
	task: string;
	projectContext: string;
	providerConfig: ProviderConfig;
	modelId?: string;
	kanbanTaskId?: string;
	abortSignal?: AbortSignal;
	callbacks: InlineAgentCallbacks;
	workspacePath?: string;
	projectId: string;
	/** Project-level thinking budget (low/medium/high). */
	projectThinkingBudget?: string | null;
	/** Project-level max tokens override. */
	projectMaxTokens?: number | null;
	/** If true, agent gets only read-only tools (no file writes, no shell, no git writes). */
	readOnly?: boolean;
	/** Max wall-clock duration in ms before stopping. Default: 600_000 (10 min). */
	timeoutMs?: number;
	/**
	 * Prior conversation turns to prepend before the current task. Used by the Playground,
	 * which stores its history in a JSON file (not the DB) and threads it here for follow-ups.
	 * Note: once rule-based compaction fires (>70% context) these are folded into a summary.
	 */
	priorMessages?: ModelMessage[];
	/**
	 * When false, skip ALL messages/message_parts/conversation DB writes — callbacks still
	 * fire (they drive the UI + any external persistence). Used by the Playground so it does
	 * not create orphan rows for its ephemeral, JSON-backed conversation. Default: true.
	 */
	persistToDb?: boolean;
	/**
	 * Extra tools merged into (and overriding) the agent's assembled tool set. Used by the
	 * Playground to inject its preview/reject tools and an auto-approved run_shell.
	 */
	extraTools?: Record<string, Tool>;
	/**
	 * Tool names to remove from the assembled set. Used by the Playground to drop tools that
	 * would block with no UI to satisfy them (e.g. request_human_input).
	 */
	excludeTools?: string[];
}

export interface InlineAgentResult {
	status: "completed" | "failed" | "cancelled" | "context_full" | "timeout";
	summary: string;
	filesModified: string[];
	tokensUsed: { prompt: number; completion: number; total: number; contextLimit?: number };
	messageIds: string[];
}

// ---------------------------------------------------------------------------
// Thinking budget helpers (reused from sub-agent pattern)
// ---------------------------------------------------------------------------

const THINKING_BUDGET_TOKENS: Record<string, number> = {
	low: 2000,
	medium: 8000,
	high: 16000,
};

function buildThinkingOptions(
	budget: string | null,
	providerType: string,
	maxTokens?: number,
): Record<string, unknown> {
	if (!budget) return {};
	const budgetTokens = THINKING_BUDGET_TOKENS[budget] ?? 8000;
	const safeMaxTokens = Math.max(maxTokens ?? 0, budgetTokens + 1000);

	if (providerType === "anthropic" || providerType === "openrouter" || providerType === "claude-subscription") {
		return {
			maxTokens: safeMaxTokens,
			providerOptions: {
				anthropic: { thinking: { type: "enabled", budgetTokens } },
			},
		};
	}

	if (providerType === "custom") {
		return { maxTokens: safeMaxTokens };
	}

	return {};
}

// ---------------------------------------------------------------------------
// Read-only tool filter
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set([
	"write_file", "edit_file", "multi_edit_file", "append_file", "delete_file",
	"move_file", "copy_file", "create_directory", "patch_file", "batch_rename",
	"archive", "download_file",
	"run_shell",
	"git_commit", "git_push", "git_branch", "git_stash", "git_reset",
	"git_cherry_pick",
	"create_task", "move_task", "update_task", "delete_task",
]);

/**
 * Agents that only read/explore — safe to run in parallel.
 * All other agents are considered "write" agents and must run one at a time.
 */
export const READ_ONLY_AGENTS = new Set([
	"code-explorer",
	"research-expert",
	"task-planner",
]);

function filterReadOnlyTools(tools: Record<string, Tool>): Record<string, Tool> {
	const filtered: Record<string, Tool> = {};
	for (const [name, tool] of Object.entries(tools)) {
		if (!WRITE_TOOLS.has(name)) {
			filtered[name] = tool;
		}
	}
	return filtered;
}

// ---------------------------------------------------------------------------
// Between-task compaction — prune tool outputs after agent completes
// ---------------------------------------------------------------------------

const PRUNE_MIN_OUTPUT_CHARS = 500; // Only prune outputs larger than this

function pruneToolOutput(toolName: string, toolInput: string | null, toolOutput: string): string {
	const len = toolOutput.length;
	if (len < PRUNE_MIN_OUTPUT_CHARS) return toolOutput;

	const lines = toolOutput.split("\n").length;
	const input = toolInput ? (() => { try { return JSON.parse(toolInput); } catch { return {}; } })() : {};

	switch (toolName) {
		case "read_file": {
			const path = input.path ?? input.file_path ?? "file";
			return `[Read ${shortPath(path)} (${lines} lines)]`;
		}
		case "write_file": {
			const path = input.path ?? input.file_path ?? "file";
			return `[Wrote ${shortPath(path)} (${lines} lines)]`;
		}
		case "edit_file":
		case "multi_edit_file": {
			const path = input.path ?? input.file_path ?? "file";
			return `[Edited ${shortPath(path)}]`;
		}
		case "run_shell": {
			const cmd = String(input.command ?? "").slice(0, 80);
			const firstLines = toolOutput.split("\n").slice(0, 5).join("\n");
			return `[Shell: ${cmd}]\n${firstLines}\n... (${lines} lines total)`;
		}
		case "directory_tree": {
			const path = input.path ?? "workspace";
			return `[Directory tree: ${shortPath(path)} (${lines} entries)]`;
		}
		case "search_content": {
			const query = String(input.query ?? input.pattern ?? "");
			const matchCount = (toolOutput.match(/\n/g) || []).length;
			return `[Searched for "${query.slice(0, 50)}": ~${matchCount} results]`;
		}
		case "search_files": {
			const pattern = String(input.pattern ?? "");
			return `[Found files matching "${pattern.slice(0, 50)}": ${lines} results]`;
		}
		case "list_directory": {
			const path = input.path ?? "directory";
			return `[Listed ${shortPath(path)} (${lines} entries)]`;
		}
		default: {
			// Generic: keep first 3 lines + truncation notice
			const firstLines = toolOutput.split("\n").slice(0, 3).join("\n");
			return `${firstLines}\n... (${len} chars, ${lines} lines — pruned)`;
		}
	}
}

/**
 * Prune tool outputs for completed agent messages to reduce token usage.
 * Called between tasks to keep the conversation manageable.
 *
 * @param messageIds - Message IDs belonging to the completed agent
 * @returns Number of parts pruned
 */
export async function pruneAgentToolResults(messageIds: string[]): Promise<number> {
	if (messageIds.length === 0) return 0;

	// Fetch all relevant parts in one query instead of one per message
	const allParts = await db.select({
		id: messageParts.id,
		toolName: messageParts.toolName,
		toolInput: messageParts.toolInput,
		toolOutput: messageParts.toolOutput,
		type: messageParts.type,
	})
		.from(messageParts)
		.where(inArray(messageParts.messageId, messageIds));

	const updates: Array<{ id: string; toolOutput: string }> = [];

	for (const part of allParts) {
		if (part.type !== "tool_call" || !part.toolOutput) continue;
		if (part.toolOutput.length < PRUNE_MIN_OUTPUT_CHARS) continue;

		const prunedOutput = pruneToolOutput(
			part.toolName ?? "unknown",
			part.toolInput,
			part.toolOutput,
		);

		if (prunedOutput.length < part.toolOutput.length) {
			updates.push({ id: part.id, toolOutput: prunedOutput });
		}
	}

	if (updates.length === 0) return 0;

	// Batch all UPDATEs in one transaction — avoids N separate fsync/commit cycles
	(db as unknown as { transaction: (fn: () => void) => void }).transaction(() => {
		for (const u of updates) {
			db.update(messageParts)
				.set({ toolOutput: u.toolOutput })
				.where(eq(messageParts.id, u.id))
				.run();
		}
	});

	return updates.length;
}

// ---------------------------------------------------------------------------
// Between-iteration compaction — prune old tool results in conversation
// ---------------------------------------------------------------------------

/**
 * Compact old tool-result messages in the conversation to reduce prompt tokens.
 * Keeps the most recent `keepRecent` tool messages in full; older ones get
 * their result replaced with a short summary via pruneToolOutput().
 *
 * Mutates the messages array in-place.
 */
function compactToolResultsInMessages(msgs: ModelMessage[], keepRecent: number): void {
	const toolIndices: number[] = [];
	for (let i = 0; i < msgs.length; i++) {
		if (msgs[i].role === "tool") toolIndices.push(i);
	}

	const toCompact = toolIndices.slice(0, Math.max(0, toolIndices.length - keepRecent));

	// Don't prune read_file results — agents need file content as working memory.
	// Only prune verbose outputs (shell, tree, search, etc.) that the agent has
	// already processed and doesn't need verbatim anymore.
	const SKIP_PRUNE_TOOLS = new Set(["read_file", "write_file", "edit_file", "multi_edit_file", "patch_file", "append_file"]);

	for (const idx of toCompact) {
		const msg = msgs[idx] as unknown as { role: "tool"; content: Array<{ type: string; toolCallId: string; toolName: string; result: unknown }> };
		if (!Array.isArray(msg.content)) continue;

		for (const part of msg.content) {
			if (part.type !== "tool-result") continue;
			if (SKIP_PRUNE_TOOLS.has(part.toolName)) continue;
			const res = typeof part.result === "string" ? part.result : JSON.stringify(part.result ?? "");
			if (res.length > PRUNE_MIN_OUTPUT_CHARS) {
				part.result = pruneToolOutput(part.toolName ?? "unknown", null, res);
			}
		}
	}

}


/**
 * Strip verbose text from old assistant messages when very close to budget.
 * Keeps tool-call parts intact (needed for conversation structure) but replaces
 * text content with a brief note. Only affects messages before the last 2.
 */
function stripOldAssistantText(msgs: ModelMessage[]): void {
	// Find assistant message indices
	const assistantIndices: number[] = [];
	for (let i = 0; i < msgs.length; i++) {
		if (msgs[i].role === "assistant") assistantIndices.push(i);
	}

	// Keep last 2 assistant messages in full
	const toStrip = assistantIndices.slice(0, Math.max(0, assistantIndices.length - 2));

	for (const idx of toStrip) {
		const msg = msgs[idx];
		if (typeof msg.content === "string" && msg.content.length > 200) {
			(msg as { content: string }).content = "(earlier reasoning omitted to save context)";
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content as Array<{ type: string; text?: string }>) {
				if (part.type === "text" && part.text && part.text.length > 200) {
					part.text = "(earlier reasoning omitted to save context)";
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Rule-based conversation compaction (zero tokens, instant)
// ---------------------------------------------------------------------------

/**
 * Build a structured compaction summary from agent messages using only
 * deterministic heuristics — no LLM call, zero token cost.
 *
 * Sections: Goal, Scope, Tools Used, Recent Requests, Pending Work,
 *           Key Files, Current Work, Timeline.
 */
function buildRuleBasedCompaction(msgs: ModelMessage[], originalTask: string): string {
	const toolNames: string[] = [];
	const filePaths: string[] = [];
	const pendingLines: string[] = [];
	let lastAssistantText = "";
	const timelineEntries: string[] = [];
	const PENDING_KEYWORDS = /\b(todo|next step|next:|remaining|pending|still need|still to|will need|should also|don't forget)\b/i;

	for (const msg of msgs) {
		const role = msg.role;
		let textContent = "";

		if (typeof msg.content === "string") {
			textContent = msg.content;
		} else if (Array.isArray(msg.content)) {
			const parts = msg.content as Array<{ type: string; text?: string; toolName?: string; args?: unknown; input?: unknown; result?: unknown }>;
			for (const part of parts) {
				if (part.type === "text" && part.text) {
					textContent += part.text + " ";
				} else if ((part.type === "tool-call" || part.type === "tool_call") && part.toolName) {
					toolNames.push(part.toolName);
					// Extract file paths from tool args
					const args = (part.args ?? part.input) as Record<string, unknown> | null;
					if (args) {
						for (const key of ["path", "file_path", "source", "destination"]) {
							const val = args[key];
							if (typeof val === "string" && val.length > 0 && !filePaths.includes(val)) {
								filePaths.push(val);
							}
						}
					}
				}
			}
		}

		// Timeline entry (compact)
		if (textContent.trim()) {
			const label = role === "assistant" ? "[A]" : role === "user" ? "[U]" : "[T]";
			timelineEntries.push(`${label} ${textContent.trim().slice(0, 120).replace(/\n/g, " ")}`);
		}

		if (role === "assistant" && textContent.trim()) {
			lastAssistantText = textContent.trim();
			// Collect pending-work hints
			for (const line of textContent.split("\n")) {
				if (PENDING_KEYWORDS.test(line) && line.trim().length > 10) {
					pendingLines.push(line.trim().slice(0, 150));
				}
			}
		}

		// Extract file paths from text
		const pathMatches = textContent.match(/[^\s"'`]+\.[a-zA-Z]{1,6}/g) ?? [];
		for (const p of pathMatches) {
			if ((p.startsWith("/") || p.startsWith("./") || p.startsWith("src/")) && !filePaths.includes(p)) {
				filePaths.push(p);
			}
		}
	}

	const userMsgs = msgs.filter((m) => m.role === "user");
	const recentUserRequests = userMsgs.slice(-3).map((m) => {
		const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
		return `- ${t.trim().slice(0, 200).replace(/\n/g, " ")}`;
	});

	const dedupedTools = [...new Set(toolNames)];
	const dedupedFiles = [...new Set(filePaths)].slice(0, 20);
	const dedupedPending = [...new Set(pendingLines)].slice(0, 10);

	const sections: string[] = [
		`## Goal\n${originalTask.slice(0, 400)}`,
		`## Scope\n- Messages: ${msgs.length} (user: ${userMsgs.length}, assistant: ${msgs.filter((m) => m.role === "assistant").length})\n- Tool calls: ${toolNames.length}`,
	];

	if (dedupedTools.length > 0) {
		sections.push(`## Tools Used\n${dedupedTools.map((t) => `- ${t}`).join("\n")}`);
	}
	if (recentUserRequests.length > 0) {
		sections.push(`## Recent Requests\n${recentUserRequests.join("\n")}`);
	}
	if (dedupedPending.length > 0) {
		sections.push(`## Pending Work\n${dedupedPending.map((l) => `- ${l}`).join("\n")}`);
	}
	if (dedupedFiles.length > 0) {
		sections.push(`## Key Files\n${dedupedFiles.join("\n")}`);
	}
	if (lastAssistantText) {
		sections.push(`## Current Work\n${lastAssistantText.slice(0, 500)}`);
	}
	if (timelineEntries.length > 0) {
		const shown = timelineEntries.slice(-15);
		sections.push(`## Timeline (last ${shown.length} entries)\n${shown.join("\n")}`);
	}

	return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// AI-powered conversation compaction
// ---------------------------------------------------------------------------

const COMPACTION_SYSTEM_PROMPT = `You are a conversation compaction agent. Your job is to summarize a sub-agent's
work-in-progress so it can continue with a much smaller context window.

Produce a structured summary in this exact format:

## Goal
<The original task the agent was asked to do — one sentence>

## Completed
<Bullet list of what has been done so far, with specific file paths and line numbers>

## In Progress
<What was being worked on when compaction triggered, if anything>

## Remaining
<What still needs to be done to complete the original task>

## Key Discoveries
<Important findings, gotchas, or decisions that affect remaining work>

## Modified Files
<List of files created or modified, one per line>

Be specific and concrete. Include file paths, function names, error messages, and
line numbers. The agent resuming this work has NO access to the prior conversation —
your summary is all it gets.`;

/**
 * Run AI-powered compaction on the agent's conversation. Calls the LLM with
 * the current messages and a compaction prompt to produce a structured summary,
 * then replaces the conversation with: [user: original task] + [assistant: summary]
 * + [user: "Continue working..."].
 *
 * Returns true if compaction succeeded, false if it failed (caller should fall
 * back to rule-based compaction).
 */
async function aiCompactConversation(
	agentMessages: ModelMessage[],
	originalTask: string,
	model: Parameters<typeof generateText>[0]["model"],
	providerType: string,
): Promise<boolean> {
	try {
		// Build a compact representation of the conversation for the compaction agent
		const conversationDump = agentMessages.map((msg, i) => {
			const role = msg.role.toUpperCase();
			let content = "";
			if (typeof msg.content === "string") {
				content = msg.content;
			} else if (Array.isArray(msg.content)) {
				const parts = msg.content as Array<{ type: string; text?: string; toolName?: string; result?: unknown }>;
				content = parts.map((p) => {
					if (p.type === "text" && p.text) return p.text;
					if (p.type === "tool-call" && p.toolName) return `[Tool call: ${p.toolName}]`;
					if (p.type === "tool-result") {
						const res = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? "");
						return `[Tool result: ${res.slice(0, 300)}${res.length > 300 ? "..." : ""}]`;
					}
					return "";
				}).filter(Boolean).join("\n");
			}
			// Cap each message to avoid blowing up the compaction call itself
			if (content.length > 2000) {
				content = content.slice(0, 2000) + "\n... (truncated for compaction)";
			}
			return `[${role} #${i}]\n${content}`;
		}).join("\n\n");

		const compactionMessages: ModelMessage[] = [
			{
				role: "user" as const,
				content: `Here is the conversation to compact:\n\n${conversationDump}\n\nProduce the structured summary now.`,
			},
		];

		const cached = applyAnthropicCaching(providerType, COMPACTION_SYSTEM_PROMPT, compactionMessages);

		const compactionResult = await generateText({
			model,
			system: cached.system,
			messages: cached.messages,
		});

		const summary = compactionResult.text;
		if (!summary || summary.length < 50) return false;

		// Replace conversation with compacted version
		agentMessages.length = 0;
		agentMessages.push(
			{ role: "user" as const, content: originalTask },
			{ role: "assistant" as const, content: summary },
			{
				role: "user" as const,
				content: "Continue working from where you left off. The summary above describes your progress so far. Do NOT repeat already-completed work — pick up from the next remaining item.",
			},
		);

		logAgent(`AI compaction: ${conversationDump.length} chars → ${summary.length} chars summary`);
		return true;
	} catch (err) {
		logAgent(`AI compaction failed, falling back to rule-based: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Tool hooks — pre/post execution shell commands
// ---------------------------------------------------------------------------

/**
 * Read a project hook command string from settings.
 * Key format: project:<projectId>:hook:<hookType>
 */
async function getHookCommand(projectId: string | undefined, hookType: "preToolUse" | "postToolUse"): Promise<string | null> {
	if (!projectId) return null;
	try {
		const value = await getSetting(`hook:${hookType}`, `project:${projectId}`);
		return value && value.trim() ? value.trim() : null;
	} catch {
		return null;
	}
}

/**
 * Wrap all tools with pre/post hook execution.
 * - PreToolUse: runs before the tool. Exit code 2 = deny (returns error to agent).
 * - PostToolUse: runs after the tool with output. Non-fatal.
 * - Env vars: HOOK_TOOL_NAME, HOOK_TOOL_INPUT, HOOK_TOOL_OUTPUT, HOOK_TOOL_IS_ERROR
 */
function wrapToolsWithHooks(
	tools: Record<string, Tool>,
	preHook: string | null,
	postHook: string | null,
	workspacePath?: string,
): Record<string, Tool> {
	if (!preHook && !postHook) return tools;

	const wrapped: Record<string, Tool> = {};
	for (const [name, toolDef] of Object.entries(tools)) {
		const orig = toolDef as Tool & { execute: (args: unknown, opts: unknown) => Promise<unknown> };
		if (typeof orig.execute !== "function") {
			wrapped[name] = toolDef;
			continue;
		}
		wrapped[name] = {
			...toolDef,
			execute: async (args: unknown, execOpts: unknown): Promise<unknown> => {
				const inputStr = JSON.stringify(args ?? {});
				const env: NodeJS.ProcessEnv = { ...process.env, HOOK_TOOL_NAME: name, HOOK_TOOL_INPUT: inputStr.slice(0, 4096) };
				const cwd = workspacePath ?? process.cwd();

				// --- PreToolUse hook ---
				if (preHook) {
					try {
						const result = spawnSync(preHook, { shell: true, encoding: "utf-8", env, cwd, timeout: 10_000 });
						if (result.status === 2) {
							const denial = (result.stdout ?? "").trim() || `Tool "${name}" blocked by PreToolUse hook`;
							return denial;
						}
					} catch { /* non-fatal — allow tool to run */ }
				}

				// --- Execute tool ---
				let output: unknown;
				let isError = false;
				try {
					output = await orig.execute(args, execOpts);
				} catch (err) {
					isError = true;
					output = err instanceof Error ? err.message : String(err);
					throw err; // re-throw so AI SDK handles it
				} finally {
					// --- PostToolUse hook ---
					if (postHook) {
						try {
							const outStr = typeof output === "string" ? output : JSON.stringify(output ?? "");
							const postEnv: NodeJS.ProcessEnv = {
								...env,
								HOOK_TOOL_OUTPUT: outStr.slice(0, 4096),
								HOOK_TOOL_IS_ERROR: isError ? "1" : "0",
							};
							spawnSync(postHook, { shell: true, encoding: "utf-8", env: postEnv, cwd, timeout: 10_000 });
						} catch { /* non-fatal */ }
					}
				}

				return output;
			},
		} as Tool;
	}
	return wrapped;
}

// ---------------------------------------------------------------------------
// Short path helpers
// ---------------------------------------------------------------------------

function shortPath(p: unknown): string {
	if (typeof p !== "string") return "";
	const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.length <= 2 ? parts.join("/") : `.../${parts.slice(-2).join("/")}`;
}

function truncate(s: string, maxLen: number): string {
	return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}

function describeToolCall(toolName: string, args: unknown): string {
	const a = args as Record<string, unknown>;
	switch (toolName) {
		case "read_file": {
			const rLine = a.startLine ? `:${a.startLine}${a.endLine ? `-${a.endLine}` : ""}` : "";
			return `Reading ${shortPath(a.path)}${rLine}`;
		}
		case "write_file": return `Writing ${shortPath(a.path)}`;
		case "edit_file": return `Editing ${shortPath(a.path)}`;
		case "multi_edit_file": return `Multi-editing ${shortPath(a.path)}`;
		case "list_directory": return `Scanning ${shortPath(a.path) || "directory"}`;
		case "directory_tree": return `Listing tree: ${shortPath(a.path) || "workspace"}`;
		case "run_shell": return `Running: ${truncate(String(a.command ?? ""), 80)}`;
		case "search_content": return `Searching: ${truncate(String(a.query ?? ""), 50)}`;
		case "search_files": return `Finding files: ${truncate(String(a.pattern ?? ""), 50)}`;
		case "git_status": return "Checking git status";
		case "git_diff": return "Reviewing changes";
		case "git_commit": return `Committing: ${truncate(String(a.message ?? ""), 60)}`;
		case "web_search": return `Searching: ${truncate(String(a.query ?? ""), 60)}`;
		case "web_fetch": return "Fetching URL";
		default: return toolName.replace(/_/g, " ");
	}
}

// ---------------------------------------------------------------------------
// runInlineAgent
// ---------------------------------------------------------------------------

export async function runInlineAgent(opts: InlineAgentOptions): Promise<InlineAgentResult> {
	const {
		conversationId, agentName, agentDisplayName, task: rawTask, projectContext,
		providerConfig, abortSignal, callbacks, workspacePath, projectId,
	} = opts;
	const task = rawTask || "(no task description provided)";
	// When false (Playground), skip all DB persistence — callbacks still fire to drive the UI.
	const persist = opts.persistToDb !== false;

	const messageIds: string[] = [];
	let sortOrder = 0;
	let completionTokens = 0;

	// --- 1. Resolve provider/model overrides from agent DB row ---
	let effectiveProviderConfig = providerConfig;
	let effectiveModelId = opts.modelId ?? providerConfig.defaultModel ?? getDefaultModel(providerConfig.providerType);
	let effectiveMaxTokens: number | undefined;
	let effectiveTemperature: number | undefined;
	let effectiveThinkingBudget: string | null = null;

	const systemPromptPromise = getAgentSystemPrompt(agentName, workspacePath, projectId);
	const toolsPromise = getToolsForAgent(agentName);

	try {
		const agentRows = await db
			.select({
				providerId: agentsTable.providerId,
				modelId: agentsTable.modelId,
				temperature: agentsTable.temperature,
				maxTokens: agentsTable.maxTokens,
				thinkingBudget: agentsTable.thinkingBudget,
			})
			.from(agentsTable)
			.where(eq(agentsTable.name, agentName))
			.limit(1);

		if (agentRows.length > 0) {
			const row = agentRows[0];
			if (row.providerId) {
				const providerRows = await db.select().from(aiProviders).where(eq(aiProviders.id, row.providerId)).limit(1);
				if (providerRows.length > 0) {
					const pr = providerRows[0];
					effectiveProviderConfig = {
						id: pr.id, name: pr.name, providerType: pr.providerType,
						apiKey: pr.apiKey, baseUrl: pr.baseUrl, defaultModel: pr.defaultModel,
					};
				}
			}
			if (row.modelId) effectiveModelId = row.modelId;
			if (row.temperature) effectiveTemperature = parseFloat(row.temperature);
			if (row.maxTokens) effectiveMaxTokens = row.maxTokens;
			if (row.thinkingBudget) effectiveThinkingBudget = row.thinkingBudget;
		}

		if (!effectiveThinkingBudget && opts.projectThinkingBudget) {
			effectiveThinkingBudget = opts.projectThinkingBudget;
		}
		if (opts.projectMaxTokens) {
			effectiveMaxTokens = opts.projectMaxTokens;
		}
	} catch {
		// Fall through to defaults
	}

	const adapter = createProviderAdapter(effectiveProviderConfig);
	const customThinkingTokens =
		effectiveProviderConfig.providerType === "custom" && effectiveThinkingBudget
			? (THINKING_BUDGET_TOKENS[effectiveThinkingBudget] ?? 8000)
			: undefined;
	const model = adapter.createModel(effectiveModelId, customThinkingTokens);

	// --- 2. Load system prompt + tools ---
	const [systemPromptBase, baseTools] = await Promise.all([systemPromptPromise, toolsPromise]);

	let systemPrompt = systemPromptBase;
	if (workspacePath) {
		systemPrompt = `Workspace: ${workspacePath}\nAll file operations must stay within this directory.\n\n${systemPrompt}`;
	}
	if (projectContext) {
		systemPrompt += `\n\n## Project Context\n${projectContext}`;
	}

	// --- 3. Set up file tracker + tools ---
	const fileTracker = new FileTracker();
	const trackedFileTools = createTrackedFileTools(fileTracker, undefined, workspacePath, [skillRegistry.dir]);
	const pluginTools = await getPluginTools();
	const { getMcpTools } = await import("../mcp/client");
	const mcpTools = getMcpTools();
	// Stuck loop detection only applies to MCP tools — built-in tools are harmless to repeat.
	const mcpToolNames = new Set(Object.keys(mcpTools));
	// Decisions log tool — only for write agents with a workspace
	const { createDecisionsTool } = await import("./tools/notes");
	// Decisions tool available to all agents with a workspace (including read-only like task-planner)
	const decisionsTools = workspacePath ? createDecisionsTool(workspacePath) : {};
	const decisionsToolMap: Record<string, Tool> = {};
	for (const [k, v] of Object.entries(decisionsTools)) decisionsToolMap[k] = v.tool;
	// extraTools are merged last so they override built-ins (e.g. Playground injects an
	// auto-approved run_shell + its preview/reject tools). The workspace-cwd wrapper below
	// still applies to an overridden run_shell, keeping shell scoped to the workspace.
	let tools: Record<string, Tool> = { ...baseTools, ...trackedFileTools, ...pluginTools, ...mcpTools, ...decisionsToolMap, ...(opts.extraTools ?? {}) };

	// Inject workspace path as default for directory/path tools so agents don't need to guess it
	if (workspacePath) {
		const wrapDirTool = (original: Tool, paramName: string) => {
			const orig = original as Tool & { execute: (args: Record<string, unknown>) => Promise<unknown> };
			return {
				...original,
				execute: async (args: Record<string, unknown>) => {
					if (!args[paramName] && !args.path && !args.directory) {
						args[paramName] = workspacePath;
					}
					// Accept both 'path' and 'directory' as fallback for each other
					if (!args[paramName] && args.path) args[paramName] = args.path;
					if (!args[paramName] && args.directory) args[paramName] = args.directory;
					return orig.execute(args);
				},
			} as Tool;
		};
		if (tools.list_directory) tools.list_directory = wrapDirTool(tools.list_directory, "directory");
		if (tools.search_files) tools.search_files = wrapDirTool(tools.search_files, "directory");
		if (tools.directory_tree) tools.directory_tree = wrapDirTool(tools.directory_tree, "path");
		if (tools.search_content) tools.search_content = wrapDirTool(tools.search_content, "directory");
		// Shell wrapper: default to workspace, resolve relative paths against workspace
		if (tools.run_shell) {
			const origShell = tools.run_shell as Tool & { execute: (args: Record<string, unknown>, opts: unknown) => Promise<unknown> };
			tools.run_shell = {
				...tools.run_shell,
				execute: async (args: Record<string, unknown>, execOpts: unknown) => {
					const wd = args.workingDirectory as string | undefined;
					if (!wd) {
						args.workingDirectory = workspacePath;
					} else if (!isAbsolute(wd)) {
						args.workingDirectory = join(workspacePath ?? "", wd);
					}
					return origShell.execute(args, execOpts);
				},
			} as Tool;
		}
	}

	if (opts.readOnly) {
		tools = filterReadOnlyTools(tools);
	}

	// Drop explicitly excluded tools. Names support a trailing "*" for prefix matching
	// (e.g. Playground removes request_human_input and all chrome-devtools_* MCP tools).
	if (opts.excludeTools?.length) {
		const exact = new Set(opts.excludeTools.filter((n) => !n.endsWith("*")));
		const prefixes = opts.excludeTools.filter((n) => n.endsWith("*")).map((n) => n.slice(0, -1));
		tools = Object.fromEntries(
			Object.entries(tools).filter(([k]) => !exact.has(k) && !prefixes.some((p) => k.startsWith(p))),
		);
	}

	// When auto-commit is enabled, remove git_commit from agent tools — the
	// review cycle commits on task completion automatically.
	try {
		const autoCommitEnabled = await getSetting("autoCommitEnabled", "git");
		if (autoCommitEnabled === "true") {
			delete tools.git_commit;
		}
	} catch { /* non-fatal */ }

	// Apply pre/post tool hooks if configured for this project
	const [preHook, postHook] = await Promise.all([
		getHookCommand(projectId, "preToolUse"),
		getHookCommand(projectId, "postToolUse"),
	]);
	if (preHook || postHook) {
		tools = wrapToolsWithHooks(tools, preHook, postHook, workspacePath);
	}

	// --- 4. Insert agent_start message ---
	const startMsgId = crypto.randomUUID();
	const startTime = new Date().toISOString();
	if (persist) {
		await db.insert(messages).values({
			id: startMsgId,
			conversationId,
			role: "assistant",
			agentName,
			content: `**${agentDisplayName}**`,
			hasParts: 1,
			tokenCount: 0,
			createdAt: new Date().toISOString(),
		});
	}
	messageIds.push(startMsgId);

	// Bump conversation's updatedAt so it sorts to the top of the sidebar
	const { broadcastToWebview } = await import("../engine-manager");
	if (persist) {
		db.update(conversations).set({ updatedAt: startTime }).where(eq(conversations.id, conversationId)).catch(() => {});
		broadcastToWebview("conversationUpdated", { conversationId, updatedAt: startTime, projectId });
	}

	// Notify frontend so the message bubble appears in chat
	callbacks.onMessageCreated?.(startMsgId, conversationId, agentName, `**${agentDisplayName}**`);

	const startPart: MessagePart = {
		id: crypto.randomUUID(),
		messageId: startMsgId,
		type: "agent_start",
		content: task,
		agentName,
		sortOrder: sortOrder++,
		timeStart: startTime,
	};
	if (persist) {
		await db.insert(messageParts).values({
			id: startPart.id,
			messageId: startPart.messageId,
			type: startPart.type,
			content: startPart.content,
			sortOrder: startPart.sortOrder,
			timeStart: startPart.timeStart,
		});
	}
	callbacks.onPartCreated(startPart);
	callbacks.onAgentStart(startMsgId, agentName, agentDisplayName, task);

	// --- 5. Build agent messages (fresh context + optional prior turns) ---
	// priorMessages threads multi-turn history (e.g. Playground follow-ups stored in JSON).
	const agentMessages: ModelMessage[] = [
		...(opts.priorMessages ?? []),
		{ role: "user" as const, content: task },
	];

	// --- 6. Run generateText loop with guardrails ---
	const CONTEXT_LIMIT = getContextLimit(effectiveModelId, projectId);
	const TIMEOUT_MS = opts.timeoutMs ?? 1_800_000; // 30 minutes
	const STUCK_WARN_THRESHOLD = 10;
	const STUCK_STOP_THRESHOLD = 15;

	function hashToolCall(toolName: string, args: unknown): string {
		return `${toolName}:${JSON.stringify(args)}`;
	}

	const MAX_RETRIES = 2;
	let retryAttempt = 0;

	retry: while (true) {
		// On first attempt: agentMessages already has the initial task (set above).
		// On retry: agentMessages retains the compacted history from completed steps,
		// so the LLM can continue from where it left off rather than starting over.
		// Only the per-attempt control state (abort controllers, timers, flags) is reset.

		const recentToolCalls: string[] = [];
		const timeoutController = new AbortController();
		const timeoutId = setTimeout(() => timeoutController.abort(), TIMEOUT_MS);
		const stuckController = new AbortController();
		const contextFullController = new AbortController();
		const startMs = Date.now();

		const compositeController = new AbortController();
		const onAbort = () => compositeController.abort();
		timeoutController.signal.addEventListener("abort", onAbort);
		stuckController.signal.addEventListener("abort", onAbort);
		contextFullController.signal.addEventListener("abort", onAbort);
		if (abortSignal) abortSignal.addEventListener("abort", onAbort);

		let stopReason: string | null = null;
		let aiCompactionDone = false;
		let lastPromptTokens = 0;
		let pendingStuckWarning: string | null = null;

	try {
		await logPrompt(agentName, systemPrompt, agentMessages, effectiveModelId);
		const toolCount = Object.keys(tools).length;
		logAgent(`${agentName} START | model=${effectiveModelId} | contextLimit=${CONTEXT_LIMIT} | tools=${toolCount} | systemPromptChars=${systemPrompt.length} | task=${task.slice(0, 120)}`);

		// --- Single generateText call with prepareStep + stopWhen ---
		// prepareStep handles context compaction between steps.
		// stopWhen handles termination (context full, abort, stuck loop).
		const COMPACT_KEEP_RECENT = 5;

		const cached = applyAnthropicCaching(effectiveProviderConfig.providerType, systemPrompt, agentMessages);
		const result = await generateText({
			model,
			system: cached.system,
			messages: cached.messages,
			tools,
			abortSignal: compositeController.signal,
			...(effectiveTemperature !== undefined && { temperature: effectiveTemperature }),
			...(effectiveMaxTokens !== undefined && { maxTokens: effectiveMaxTokens }),
			...buildThinkingOptions(effectiveThinkingBudget, effectiveProviderConfig.providerType, effectiveMaxTokens),

			// --- Stop when no more tool calls or guardrails trigger ---
			stopWhen: [
				// Natural completion: model has no more tool calls
				({ steps }) => {
					if (steps.length === 0) return false;
					const last = steps[steps.length - 1];
					return !last.toolCalls || last.toolCalls.length === 0;
				},
				// Guardrail: stop reason set (context full, stuck loop, timeout)
				() => !!stopReason,
			],

			// --- Context compaction between steps ---
			prepareStep: async ({ steps, messages: stepMessages }) => {
				if (steps.length === 0) return undefined; // First step — no compaction needed

				// Inject stuck loop warning if set by onStepFinish
				if (pendingStuckWarning) {
					const warning = pendingStuckWarning;
					pendingStuckWarning = null;
					agentMessages.push({ role: "user" as const, content: warning });
					const recached = applyAnthropicCaching(effectiveProviderConfig.providerType, systemPrompt, agentMessages);
					return recached.system !== undefined
						? { messages: recached.messages, system: recached.system }
						: { messages: recached.messages };
				}

				const contextRatio = lastPromptTokens / CONTEXT_LIMIT;
				const stepCount = steps.length;

				logAgent(`${agentName} step=${stepCount} | context=${lastPromptTokens}/${CONTEXT_LIMIT} (${Math.round(contextRatio * 100)}%) | completion=${completionTokens} | msgs=${stepMessages.length}`);

				// Progressive compaction based on context window usage
				if (contextRatio > 0.90 && aiCompactionDone) {
					logAgent(`${agentName} context full (${Math.round(contextRatio * 100)}%) after compaction — stopping`);
					stopReason = "context_full";
					contextFullController.abort();
					return { activeTools: [] }; // Disable all tools to force stop
				} else if (contextRatio > 0.70 && !aiCompactionDone && stepMessages.length > 5) {
					// Rule-based compaction first (zero tokens, instant).
					// Fall back to AI compaction only if the rule-based summary is too large (>8k chars)
					// which indicates a very unusual conversation that benefits from LLM reasoning.
					logAgent(`${agentName} compaction=rule-based (${Math.round(contextRatio * 100)}% context, ${stepMessages.length} msgs)`);
					const ruleSummary = buildRuleBasedCompaction(agentMessages, task);
					if (ruleSummary.length < 8000) {
						agentMessages.length = 0;
						agentMessages.push(
							{ role: "user" as const, content: task },
							{ role: "assistant" as const, content: ruleSummary },
							{ role: "user" as const, content: "Continue working from where you left off. The summary above describes your progress so far. Do NOT repeat already-completed work — pick up from the next remaining item." },
						);
						aiCompactionDone = true;
					} else {
						logAgent(`${agentName} compaction=rule-based-large, escalating to AI`);
						const compacted = await aiCompactConversation(agentMessages, task, model, effectiveProviderConfig.providerType);
						aiCompactionDone = true;
						if (!compacted) {
							logAgent(`${agentName} compaction=AI-failed, stripping`);
							compactToolResultsInMessages(agentMessages, 5);
							stripOldAssistantText(agentMessages);
						}
					}
					// Return compacted messages
					const recached = applyAnthropicCaching(effectiveProviderConfig.providerType, systemPrompt, agentMessages);
					return recached.system !== undefined
						? { messages: recached.messages, system: recached.system }
						: { messages: recached.messages };
				} else if (contextRatio > 0.85 && aiCompactionDone) {
					logAgent(`${agentName} compaction=post-compact-strip (${Math.round(contextRatio * 100)}%)`);
					compactToolResultsInMessages(agentMessages, 5);
					stripOldAssistantText(agentMessages);
					const recached = applyAnthropicCaching(effectiveProviderConfig.providerType, systemPrompt, agentMessages);
					return recached.system !== undefined
						? { messages: recached.messages, system: recached.system }
						: { messages: recached.messages };
				} else if (contextRatio > 0.60) {
					logAgent(`${agentName} compaction=aggressive (${Math.round(contextRatio * 100)}%, keep 5)`);
					compactToolResultsInMessages(agentMessages, 5);
				} else {
					compactToolResultsInMessages(agentMessages, COMPACT_KEEP_RECENT);
				}

				return undefined; // Use default messages
			},

			// --- Step callbacks for broadcasting + guardrails ---
			onStepFinish: (stepResult) => {
				const step = stepResult as {
					text?: string;
					reasoningText?: string;
					toolCalls?: Array<{ toolName: string; input?: unknown; args?: unknown; toolCallId: string }>;
					toolResults?: Array<{ toolName: string; output?: unknown; result?: unknown; toolCallId: string }>;
					usage?: { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
				};

				// Track usage — lastPromptTokens = current context size (NOT accumulated)
				// AI SDK v6 uses inputTokens/outputTokens; fall back to v5 promptTokens/completionTokens
				if (step.usage) {
					lastPromptTokens = step.usage.inputTokens ?? step.usage.promptTokens ?? lastPromptTokens;
					completionTokens += step.usage.outputTokens ?? step.usage.completionTokens ?? 0;
				}

				// --- Guardrail: Timeout check ---
				if (Date.now() - startMs > TIMEOUT_MS) {
					stopReason = "timeout";
					timeoutController.abort();
					return;
				}

				// --- Guardrail: Stuck loop detection ---
				for (const tc of step.toolCalls ?? []) {
					if (!mcpToolNames.has(tc.toolName)) continue;
					const hash = hashToolCall(tc.toolName, tc.input ?? tc.args);
					recentToolCalls.push(hash);
					if (recentToolCalls.length > 20) recentToolCalls.shift();

					const count = recentToolCalls.filter((h) => h === hash).length;
					if (count >= STUCK_STOP_THRESHOLD) {
						logAgent(`${agentName}: stuck loop STOP — ${tc.toolName} called ${count}x with same args, aborting`);
						stopReason = "stuck_loop";
						stuckController.abort();
						return;
					}
					if (count >= STUCK_WARN_THRESHOLD) {
						logAgent(`${agentName}: stuck loop warning — ${tc.toolName} called ${count}x with same args`);
						// Schedule warning injection via prepareStep (onStepFinish can't return messages).
						// The agent will see this before its next step and can self-correct.
						pendingStuckWarning = `[SYSTEM WARNING] You have called "${tc.toolName}" ${count} times in a row with identical arguments and received the same result each time. This tool is not making progress. Do NOT call "${tc.toolName}" again with the same arguments. Try a completely different approach: read the relevant source file directly or use a different verification method.`;
					}
				}

				// Emit reasoning
				const reasoning = typeof step.reasoningText === "string" ? step.reasoningText : "";
				if (reasoning) {
					const reasoningPart: MessagePart = {
						id: crypto.randomUUID(),
						messageId: startMsgId,
						type: "reasoning",
						content: reasoning,
						sortOrder: sortOrder++,
					};
					if (persist) db.insert(messageParts).values({
						id: reasoningPart.id, messageId: reasoningPart.messageId,
						type: reasoningPart.type, content: reasoningPart.content,
						sortOrder: reasoningPart.sortOrder,
					}).catch(() => {});
					callbacks.onPartCreated(reasoningPart);
				}

				// Emit text
				if (step.text) {
					const textPart: MessagePart = {
						id: crypto.randomUUID(),
						messageId: startMsgId,
						type: "text",
						content: step.text,
						sortOrder: sortOrder++,
					};
					if (persist) db.insert(messageParts).values({
						id: textPart.id, messageId: textPart.messageId,
						type: textPart.type, content: textPart.content,
						sortOrder: textPart.sortOrder,
					}).catch(() => {});
					callbacks.onPartCreated(textPart);
				}

				// Emit tool calls + results
				for (const tc of step.toolCalls ?? []) {
					const tcArgs = tc.input ?? tc.args;
					const toolCallPart: MessagePart = {
						id: crypto.randomUUID(),
						messageId: startMsgId,
						type: "tool_call",
						content: describeToolCall(tc.toolName, tcArgs),
						toolName: tc.toolName,
						toolInput: JSON.stringify(tcArgs),
						toolState: "running",
						sortOrder: sortOrder++,
						timeStart: new Date().toISOString(),
					};
					if (persist) db.insert(messageParts).values({
						id: toolCallPart.id, messageId: toolCallPart.messageId,
						type: toolCallPart.type, content: toolCallPart.content,
						toolName: toolCallPart.toolName, toolInput: toolCallPart.toolInput,
						toolState: toolCallPart.toolState, sortOrder: toolCallPart.sortOrder,
						timeStart: toolCallPart.timeStart,
					}).catch(() => {});
					callbacks.onPartCreated(toolCallPart);

					// Find matching result
					const tr = (step.toolResults ?? []).find(
						(r: { toolCallId?: string }) => r.toolCallId === tc.toolCallId,
					);
					const endTime = new Date().toISOString();
					if (tr) {
						const trAny = tr as Record<string, unknown>;
						// v6: tool errors have type='tool-error' with error field instead of output
						const isToolError = trAny.type === "tool-error";
						const trOutput = isToolError
							? (trAny.error instanceof Error ? trAny.error.message : String(trAny.error ?? "Tool execution failed"))
							: (trAny.output ?? trAny.result);
						const resultStr = typeof trOutput === "string" ? trOutput : JSON.stringify(trOutput);
						// Tools return errors as strings (they catch rather than throw), in several
						// shapes — leading "Error/Failed/Blocked", "success":false, or a JSON
						// { error: "..." } envelope. toolResultIsError() covers them all (and excludes
						// read/search whose content can legitimately start with "Error").
						const isError = isToolError || toolResultIsError(tc.toolName, resultStr);
						// Image tools return large base64 payloads — give them a much higher limit
						// so the frontend can render the actual image instead of truncated JSON.
						const isImageTool = tc.toolName === "read_image"
							|| tc.toolName === "take_screenshot"
							|| tc.toolName.includes("screenshot");
						const toolOutputLimit = isImageTool ? 500_000 : 10_000;
						const updates: Partial<MessagePart> = {
							toolOutput: resultStr.length > toolOutputLimit ? resultStr.slice(0, toolOutputLimit) + "\n... (truncated)" : resultStr,
							toolState: isError ? "error" : "success",
							timeEnd: endTime,
						};
						if (persist) db.update(messageParts)
							.set({ toolOutput: updates.toolOutput, toolState: updates.toolState, timeEnd: updates.timeEnd })
							.where(eq(messageParts.id, toolCallPart.id))
							.catch(() => {});
						callbacks.onPartUpdated(startMsgId, toolCallPart.id, updates);
					} else {
						// No matching result — mark as done to clear spinner
						if (persist) db.update(messageParts)
							.set({ toolState: "success", timeEnd: endTime })
							.where(eq(messageParts.id, toolCallPart.id))
							.catch(() => {});
						callbacks.onPartUpdated(startMsgId, toolCallPart.id, { toolState: "success", timeEnd: endTime } as Partial<MessagePart>);
					}
				}
			},
		});

		clearTimeout(timeoutId);
		const elapsed = Math.round((Date.now() - startMs) / 1000);
		const rawFinish = result.rawFinishReason ?? result.finishReason;
		const totalUsage = result.usage;
		const totalPrompt = totalUsage?.inputTokens ?? lastPromptTokens;
		const totalCompletion = totalUsage?.outputTokens ?? completionTokens;
		logAgent(`${agentName} END | status=completed | finish=${rawFinish} | totalTokens=${totalPrompt + totalCompletion} (prompt=${totalPrompt} completion=${totalCompletion}) | context=${lastPromptTokens}/${CONTEXT_LIMIT} (${Math.round(lastPromptTokens / CONTEXT_LIMIT * 100)}%) | elapsed=${elapsed}s | steps=${result.steps?.length ?? 0} | aiCompacted=${aiCompactionDone}`);

		// --- 8. Build summary ---
		const filesModified = fileTracker.getModifiedFiles();
		const summary = result.text || "(completed via tool calls)";

		// --- 9. Insert agent_end part ---
		const endTime = new Date().toISOString();
		const endPart: MessagePart = {
			id: crypto.randomUUID(),
			messageId: startMsgId,
			type: "agent_end",
			content: summary,
			agentName,
			sortOrder: sortOrder++,
			timeEnd: endTime,
		};
		if (persist) {
			await db.insert(messageParts).values({
				id: endPart.id, messageId: endPart.messageId,
				type: endPart.type, content: endPart.content,
				sortOrder: endPart.sortOrder, timeEnd: endPart.timeEnd,
			});
		}
		callbacks.onPartCreated(endPart);

		// Update the message content with summary
		// tokenCount here reflects content size for context indicator, not total API usage
		const contentTokenEstimate = Math.ceil(summary.length / 4);
		if (persist) {
			await db.update(messages)
				.set({
					content: summary,
					tokenCount: contentTokenEstimate,
				})
				.where(eq(messages.id, startMsgId));
		}

		callbacks.onAgentComplete(startMsgId, agentName, "completed", summary, filesModified, { prompt: totalPrompt, completion: totalCompletion });

		// Bump conversation updatedAt at completion so it stays above the PM conversation
		// when the user navigates away and back (PM touches its own conv after this returns).
		const completionTime = new Date().toISOString();
		if (persist) {
			db.update(conversations).set({ updatedAt: completionTime }).where(eq(conversations.id, conversationId)).catch(() => {});
			broadcastToWebview("conversationUpdated", { conversationId, updatedAt: completionTime, projectId });
		}

		return {
			status: "completed",
			summary,
			filesModified,
			tokensUsed: { prompt: totalPrompt, completion: totalCompletion, total: totalPrompt + totalCompletion, contextLimit: CONTEXT_LIMIT },
			messageIds,
		};

	} catch (error: unknown) {
		clearTimeout(timeoutId);
		logAgent(`${agentName} END | status=error | stopReason=${stopReason ?? "exception"} | context=${lastPromptTokens}/${CONTEXT_LIMIT} | completion=${completionTokens} | elapsed=${Math.round((Date.now() - startMs) / 1000)}s | aiCompacted=${aiCompactionDone} | error=${error instanceof Error ? error.message : String(error)}`);

		const isUserAbort = abortSignal?.aborted === true;
		const isTimeout = stopReason === "timeout" || timeoutController.signal.aborted;
		const isContextFull = stopReason === "context_full";
		const isStuck = stopReason === "stuck_loop";

		let status: InlineAgentResult["status"];
		let summary: string;
		const elapsed = Math.round((Date.now() - startMs) / 1000);

		if (isUserAbort) {
			status = "cancelled";
			summary = `Cancelled by user after ${elapsed}s`;
		} else if (isContextFull) {
			status = "context_full";
			summary = `Agent stopped: context window full (${Math.round(lastPromptTokens / 1000)}k / ${Math.round(CONTEXT_LIMIT / 1000)}k tokens) after ${elapsed}s — compaction could not free enough space`;
		} else if (isTimeout) {
			status = "timeout";
			summary = `Agent stopped: timeout after ${elapsed}s (limit: ${Math.round(TIMEOUT_MS / 1000)}s)`;
		} else if (isStuck) {
			status = "failed";
			summary = `Agent stopped: stuck loop detected — same tool call repeated ${STUCK_STOP_THRESHOLD}+ times`;
		} else {
			const errorMessage = error instanceof Error ? error.message : String(error);
			status = "failed";
			summary = `Failed: ${errorMessage}`;
		}

		// Retry on transient provider errors (e.g., connection timeout when agents spawn in parallel)
		if (!isUserAbort && !isContextFull && !isStuck && !isTimeout && isTransientError(error) && retryAttempt < MAX_RETRIES) {
			retryAttempt++;
			const delay = getBackoffDelay(retryAttempt - 1);
			logAgent(`${agentName} transient error, retry ${retryAttempt}/${MAX_RETRIES} after ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
			await new Promise(r => setTimeout(r, delay));
			continue retry;
		}

		// Insert agent_end error part
		const endPart: MessagePart = {
			id: crypto.randomUUID(),
			messageId: startMsgId,
			type: "agent_end",
			content: summary,
			agentName,
			sortOrder: sortOrder++,
			toolState: "error",
			timeEnd: new Date().toISOString(),
		};
		if (persist) await db.insert(messageParts).values({
			id: endPart.id, messageId: endPart.messageId,
			type: endPart.type, content: endPart.content,
			sortOrder: endPart.sortOrder, toolState: endPart.toolState,
			timeEnd: endPart.timeEnd,
		}).catch(() => {});
		callbacks.onPartCreated(endPart);

		// Update message — tokenCount reflects content size for context indicator
		if (persist) await db.update(messages)
			.set({ content: summary, tokenCount: Math.ceil(summary.length / 4) })
			.where(eq(messages.id, startMsgId))
			.catch(() => {});

		// Move kanban task back to backlog on failure (not cancellation)
		if (opts.kanbanTaskId && status !== "cancelled") {
			try {
				const { moveKanbanTask } = await import("../rpc/kanban");
				await moveKanbanTask(opts.kanbanTaskId, "backlog");
			} catch { /* non-fatal */ }
		}

		const filesModified = fileTracker.getModifiedFiles();
		callbacks.onAgentComplete(startMsgId, agentName, status, summary, filesModified, { prompt: lastPromptTokens, completion: completionTokens });

		const completionTime = new Date().toISOString();
		if (persist) {
			db.update(conversations).set({ updatedAt: completionTime }).where(eq(conversations.id, conversationId)).catch(() => {});
			import("../engine-manager").then(({ broadcastToWebview: bcast }) => {
				bcast("conversationUpdated", { conversationId, updatedAt: completionTime, projectId });
			}).catch(() => {});
		}

		return {
			status,
			summary,
			filesModified,
			tokensUsed: { prompt: lastPromptTokens, completion: completionTokens, total: lastPromptTokens + completionTokens, contextLimit: CONTEXT_LIMIT },
			messageIds,
		};
	}
	} // end retry loop
}
