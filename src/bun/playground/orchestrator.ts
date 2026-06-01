// ---------------------------------------------------------------------------
// Playground orchestrator
//
// Runs the dedicated "playground-agent" via runInlineAgent — fully decoupled
// from the PM, kanban, and review-cycle paths. Conversation history lives in a
// JSON file in the OS temp folder (not the DB), and all agent activity is
// streamed to the Playground page via `agentdesk:playground-*` broadcasts.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import type { ModelMessage } from "ai";
import { eq } from "drizzle-orm";
import { runInlineAgent, type InlineAgentCallbacks, type MessagePart } from "../agents/agent-loop";
import type { ProviderConfig } from "../providers/types";
import type { PlaygroundPreviewDto, PlaygroundPartDto, PlaygroundTokensDto } from "../../shared/rpc/playground";
import { getDefaultModel } from "../providers/models";
import { db } from "../db";
import { aiProviders } from "../db/schema";
import { broadcastToWebview } from "../engine-manager";
import { autoApprovedShellTool } from "../agents/tools/shell";
import { createPlaygroundTools } from "../agents/tools/playground";
import { killJobsUnderPath } from "../agents/tools/process";
import { restartPlaygroundFileWatcher, stopPlaygroundFileWatcher } from "./server";
import {
	PLAYGROUND_FILES_DIR,
	CONVERSATION_FILE,
	PREVIEW_FILE,
	ensurePlaygroundDirs,
	wipePlayground,
	hasPlaygroundFiles,
} from "./paths";

const PLAYGROUND_CONVERSATION_ID = "playground";
const PLAYGROUND_PROJECT_ID = "playground";

// Keep conversation history bounded so context stays manageable across many turns.
const MAX_HISTORY_TURNS = 30;

interface ConvTurn {
	role: "user" | "assistant";
	content: string;
}

let running = false;
let abortController: AbortController | null = null;

// In-memory buffer of the current/last run's activity so the page can restore
// the live log when the user navigates away and back (same app session).
let activityParts: PlaygroundPartDto[] = [];
let lastStatus: string | null = null;
let lastSummary: string | null = null;
let lastTokens: PlaygroundTokensDto | null = null;
let lastError: string | null = null;
let lastUserMessage: string | null = null;

// ---------------------------------------------------------------------------
// Conversation JSON helpers
// ---------------------------------------------------------------------------

function loadConversation(): ConvTurn[] {
	try {
		if (!existsSync(CONVERSATION_FILE)) return [];
		const parsed = JSON.parse(readFileSync(CONVERSATION_FILE, "utf-8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(t): t is ConvTurn =>
				t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string",
		);
	} catch {
		return [];
	}
}

function saveConversation(turns: ConvTurn[]): void {
	try {
		ensurePlaygroundDirs();
		const trimmed = turns.slice(-MAX_HISTORY_TURNS);
		writeFileSync(CONVERSATION_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
	} catch (err) {
		console.error("[playground] failed to save conversation:", err);
	}
}

// ---------------------------------------------------------------------------
// Provider resolution (mirrors the enhancePrompt pattern). The agent-level
// provider/model override (none for playground-agent) is applied inside
// runInlineAgent, so we just supply a sensible default here.
// ---------------------------------------------------------------------------

async function resolveProviderConfig(): Promise<{ config: ProviderConfig; modelId: string }> {
	let providerRow = (await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1))[0];
	if (!providerRow) providerRow = (await db.select().from(aiProviders).limit(1))[0];
	if (!providerRow) throw new Error("No AI provider configured. Add one in Settings → Providers first.");

	const modelId = providerRow.defaultModel || getDefaultModel(providerRow.providerType);
	return {
		config: {
			id: providerRow.id,
			name: providerRow.name,
			providerType: providerRow.providerType,
			apiKey: providerRow.apiKey ?? "",
			baseUrl: providerRow.baseUrl ?? null,
			defaultModel: providerRow.defaultModel ?? null,
		},
		modelId,
	};
}

// ---------------------------------------------------------------------------
// Workspace context — the absolute playground path + a top-level file listing,
// injected into the agent's system prompt every turn so it always knows where
// it is working and what it has already built. (Top level only; the agent uses
// list_directory / read_file to drill into subfolders as needed.)
// ---------------------------------------------------------------------------

const LIST_IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", ".turbo", ".playground"]);
const LIST_MAX_ENTRIES = 100;

function listTopLevel(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => !LIST_IGNORE.has(e.name))
			.sort((a, b) => (a.isDirectory() !== b.isDirectory() ? (a.isDirectory() ? -1 : 1) : a.name.localeCompare(b.name)))
			.slice(0, LIST_MAX_ENTRIES)
			.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
	} catch {
		return [];
	}
}

/** Build the workspace context block (absolute path + top-level listing) for the system prompt. */
function buildWorkspaceContext(): string {
	const header =
		`## Playground Workspace\n\n` +
		`- **Absolute path on this machine**: \`${PLAYGROUND_FILES_DIR}\`\n` +
		`- This is your working directory. All file operations and shell commands default here — never write outside it.`;

	const entries = listTopLevel(PLAYGROUND_FILES_DIR);
	if (entries.length === 0) {
		return `${header}\n- The folder is currently **empty** — build your artifact here.`;
	}

	return (
		`${header}\n\n### Current files (top level, built in earlier turns)\n\`\`\`\n${entries.join("\n")}\n\`\`\`\n\n` +
		`Treat this request as a change to the work above: \`read_file\` the relevant files before editing ` +
		`(use \`list_directory\` to drill into any subfolders), make targeted edits, then call \`playground_render_preview\` again.`
	);
}

function serializePart(part: MessagePart): PlaygroundPartDto {
	return {
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
	};
}

/** Mirror the frontend store's part accumulation so getPlaygroundState can restore it. */
function bufferPart(part: PlaygroundPartDto): void {
	const idx = activityParts.findIndex((p) => p.id === part.id);
	if (idx >= 0) activityParts[idx] = part;
	else activityParts.push(part);
}

function bufferPartUpdate(partId: string, updates: Partial<PlaygroundPartDto>): void {
	const idx = activityParts.findIndex((p) => p.id === partId);
	if (idx >= 0) activityParts[idx] = { ...activityParts[idx], ...updates };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isPlaygroundRunning(): boolean {
	return running;
}

export interface PlaygroundState {
	running: boolean;
	hasFiles: boolean;
	preview: PlaygroundPreviewDto | null;
	parts: PlaygroundPartDto[];
	lastStatus: string | null;
	lastSummary: string | null;
	tokens: PlaygroundTokensDto | null;
	error: string | null;
	lastUserMessage: string | null;
	path: string;
	/** Persisted conversation turns (user prompts + assistant summaries) — survives restart. */
	history: ConvTurn[];
}

export function getPlaygroundState(): PlaygroundState {
	let preview: PlaygroundPreviewDto | null = null;
	try {
		if (existsSync(PREVIEW_FILE)) preview = JSON.parse(readFileSync(PREVIEW_FILE, "utf-8")) as PlaygroundPreviewDto;
	} catch {
		preview = null;
	}
	return {
		running,
		hasFiles: hasPlaygroundFiles(),
		preview,
		parts: activityParts,
		lastStatus,
		lastSummary,
		tokens: lastTokens,
		error: lastError,
		lastUserMessage,
		history: loadConversation(),
		path: PLAYGROUND_FILES_DIR,
	};
}

/**
 * Run the Playground Agent on a user message. Returns immediately is NOT done —
 * callers should not await for UI purposes; progress streams via broadcasts.
 * Throws synchronously only if a run is already active.
 */
export async function runPlayground(userMessage: string, consoleErrors?: string[]): Promise<void> {
	if (running) throw new Error("A playground run is already in progress. Stop it first.");
	ensurePlaygroundDirs();

	// The task sent to the agent = the user's message, plus any console messages the live
	// preview captured (so the agent can fix real runtime errors). The SAVED history keeps
	// only the clean user message — we don't pollute the transcript with console dumps.
	let taskForAgent = userMessage;
	if (consoleErrors?.length) {
		taskForAgent +=
			"\n\n---\n[Live preview console output — the current preview reported these messages. " +
			"Read the relevant files, fix any that are genuine errors affecting the page, and re-render. Ignore benign warnings.]\n" +
			consoleErrors.slice(0, 40).map((e) => `- ${e}`).join("\n");
	}

	running = true;
	abortController = new AbortController();
	// Reset the activity buffer for the new run (mirrors the frontend store).
	activityParts = [];
	lastStatus = null;
	lastSummary = null;
	lastError = null;
	lastUserMessage = userMessage;
	broadcastToWebview("playgroundRunStarted", { message: userMessage });

	try {
		const prior = loadConversation();
		const priorMessages: ModelMessage[] = prior.map((t) => ({ role: t.role, content: t.content }));

		const { config, modelId } = await resolveProviderConfig();

		// Absolute playground path (OS-specific, computed at module load) + a fresh recursive
		// file tree of work done so far — injected into the system prompt every turn.
		const projectContext = buildWorkspaceContext();

		// Inject playground-only tools + an auto-approved shell (no approval prompts;
		// the agent-loop cwd-wrapper scopes it to the playground workspace).
		const extraTools = {
			...createPlaygroundTools(),
			run_shell: autoApprovedShellTool,
		};

		const callbacks: InlineAgentCallbacks = {
			onPartCreated: (part) => {
				const serialized = serializePart(part);
				bufferPart(serialized);
				broadcastToWebview("playgroundPart", { part: serialized });
			},
			onPartUpdated: (_messageId, partId, updates) => {
				const patch = {
					content: updates.content,
					toolOutput: updates.toolOutput,
					toolState: updates.toolState,
					timeEnd: updates.timeEnd,
				};
				bufferPartUpdate(partId, patch);
				broadcastToWebview("playgroundPartUpdated", { partId, updates: patch });
			},
			onTextDelta: () => {
				/* parts carry the text; no token-level streaming needed for the playground */
			},
			onAgentStart: (_messageId, _agentName, _displayName, task) => {
				broadcastToWebview("playgroundAgentStart", { task });
			},
			onAgentComplete: (_messageId, _agentName, status, summary, filesModified, tokensUsed) => {
				lastStatus = status;
				lastSummary = summary;
				lastTokens = tokensUsed;
				broadcastToWebview("playgroundAgentComplete", {
					status,
					summary,
					filesModified,
					tokensUsed,
				});
			},
		};

		const result = await runInlineAgent({
			conversationId: PLAYGROUND_CONVERSATION_ID,
			agentName: "playground-agent",
			agentDisplayName: "Playground Agent",
			task: taskForAgent,
			projectContext,
			providerConfig: config,
			modelId,
			callbacks,
			workspacePath: PLAYGROUND_FILES_DIR,
			projectId: PLAYGROUND_PROJECT_ID,
			persistToDb: false,
			priorMessages,
			extraTools,
			// request_human_input would block forever (no UI to answer it). chrome-devtools_* MCP
			// tools attach to a separate external browser and can't see the in-app preview, so the
			// General Agent must never use them — remove them from its toolset entirely.
			excludeTools: ["request_human_input", "chrome-devtools_*"],
			abortSignal: abortController.signal,
		});

		// Persist the turn pair to JSON for context threading on the next message.
		const turns = loadConversation();
		turns.push({ role: "user", content: userMessage });
		turns.push({ role: "assistant", content: result.summary });
		saveConversation(turns);
	} catch (err) {
		lastError = err instanceof Error ? err.message : String(err);
		broadcastToWebview("playgroundRunError", { error: lastError });
	} finally {
		running = false;
		abortController = null;
		broadcastToWebview("playgroundRunComplete", {});
	}
}

/** Abort the in-flight run (if any). */
export function stopPlayground(): void {
	abortController?.abort();
}

/**
 * Wipe the playground: abort any run, kill dev servers it started, delete all
 * files + conversation + preview, and notify the page to reset.
 */
export function newPlayground(): void {
	stopPlayground();
	try {
		killJobsUnderPath(PLAYGROUND_FILES_DIR);
	} catch (err) {
		console.error("[playground] failed to kill dev servers:", err);
	}
	// Release our own handle on the directory before deleting it, then re-establish it after.
	stopPlaygroundFileWatcher();
	try {
		wipePlayground();
	} catch (err) {
		// Rare on Windows if a file is still locked after retries — surface it rather than
		// leaving the page in a half-reset state with no feedback.
		console.error("[playground] wipe failed:", err);
		restartPlaygroundFileWatcher();
		throw new Error(
			"Could not fully clear the playground — a file may still be in use (e.g. a dev server). Close it and try again.",
			{ cause: err },
		);
	}
	activityParts = [];
	lastStatus = null;
	lastSummary = null;
	lastTokens = null;
	lastError = null;
	lastUserMessage = null;
	restartPlaygroundFileWatcher();
	broadcastToWebview("playgroundReset", {});
}

/** Stop everything on app shutdown (no wipe — temp is reused next launch). */
export function shutdownPlayground(): void {
	stopPlayground();
	try {
		killJobsUnderPath(PLAYGROUND_FILES_DIR);
	} catch {
		/* ignore */
	}
}
