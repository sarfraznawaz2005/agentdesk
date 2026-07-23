import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodTypeAny } from "zod";
import { asSchema, type FlexibleSchema, type Tool } from "ai";
import { readOAuthTokenOrNull, resolveClaudeCliPath } from "./claude-subscription";
import { logProviderCallError } from "./error-log";
import { extractImagePayload, imageToolModelOutput } from "../agents/tools/screenshot";

const MCP_SERVER_NAME = "agentdesk";
const STUCK_WARN_THRESHOLD = 5;

export interface ClaudeCliRunOpts {
	task: string;
	systemPrompt: string;
	tools: Record<string, Tool>;
	modelId: string;
	workspacePath?: string;
	timeoutMs: number;
	/** Externally-triggered cancellation (e.g. user clicks "stop") — forwarded
	 *  into the SDK's own abortController so the underlying subprocess is
	 *  actually killed, not just abandoned by the caller while it keeps running. */
	abortSignal?: AbortSignal;
	/** Set false to skip the "at least one real tool call must land, or fail
	 *  loudly" guard. That guard assumes the task inherently requires tool use
	 *  (true for sub-agents — every task is concrete and actionable), which is
	 *  the wrong assumption for PM chat: most turns are plain conversation
	 *  ("hi", "thanks", explaining something from context) that legitimately
	 *  need zero tool calls. Default true (the sub-agent-safe behavior). */
	verifyToolCall?: boolean;
	onText: (text: string) => void;
	onReasoning: (text: string) => void;
	onToolCallStart: (toolName: string, args: unknown) => string;
	onToolCallEnd: (callId: string, resultText: string, isError: boolean) => void;
	/** Live, per-token text delta as Claude generates — a raw, unbuffered,
	 *  cheap capability. Callers are responsible for throttling before this
	 *  reaches the UI (see agents/throttled-accumulator.ts) — this function
	 *  does no batching itself. Only ever fires when the caller opts in
	 *  (Full Streaming mode); never buffered/discarded on retry like onText —
	 *  a failed attempt's tokens are already visible by the time the retry
	 *  decision is made, so onRetract exists to tell the caller to clear them. */
	onTextToken?: (delta: string) => void;
	/** Live, per-token reasoning/thinking delta — same semantics as onTextToken. */
	onReasoningToken?: (delta: string) => void;
	/** Fired when a verification failure is about to trigger a retry — the
	 *  caller should discard whatever onTextToken/onReasoningToken content it
	 *  displayed live for the attempt that just failed. Never fired for the
	 *  attempt that ultimately succeeds (or the last, failing one — its
	 *  buffered text/reasoning simply never reaches onText/onReasoning, same
	 *  as before this capability existed). */
	onRetract?: () => void;
}

export interface ClaudeCliRunResult {
	status: "completed" | "failed" | "timeout" | "cancelled";
	summary: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		/** Tokens written to Anthropic's prompt cache this turn (first time a
		 *  reusable prefix — system prompt, tool schemas — is seen). Only ever
		 *  populated on this CLI/SDK path; other providers' usage objects don't
		 *  report this breakdown today. */
		cacheCreationInputTokens?: number;
		/** Tokens served FROM the prompt cache this turn (the actual savings —
		 *  billed at a fraction of the normal input-token rate). */
		cacheReadInputTokens?: number;
	};
	costUsd: number;
}

interface JsonSchemaProp {
	type?: string;
	enum?: unknown[];
	description?: string;
	items?: JsonSchemaProp;
	properties?: Record<string, JsonSchemaProp>;
	required?: string[];
	/** Dictionary-shaped objects (e.g. Zod's `z.record()`) encode as `type:"object"`
	 *  with NO `properties` — just this. Must be reconstructed as `z.record()`,
	 *  not the empty-shape `z.object({})` fallback: the MCP SDK's own
	 *  `validateToolInput()` parses incoming args against whatever Zod shape is
	 *  registered and forwards the PARSED (stripped) result to the tool handler
	 *  (confirmed by reading `@modelcontextprotocol/sdk`'s server/mcp.js), so an
	 *  empty-shape object would silently discard every key the model passes
	 *  (e.g. download_file's `headers` arg) before the tool ever saw them. */
	additionalProperties?: boolean | JsonSchemaProp;
}

/** Reconstructs a Zod raw shape from JSON Schema — the SDK's `tool()` wants a
 *  ZodRawShape, but AgentDesk's own `Tool.inputSchema` may be Zod OR (for
 *  MCP-passthrough tools like chrome-devtools) a `jsonSchema()`-wrapped
 *  schema, so everything is normalized through JSON Schema first via
 *  `asSchema()`. Falls back to z.unknown() for anything unrecognized rather
 *  than throwing, so one exotic field degrades gracefully instead of
 *  breaking the whole tool's registration. */
function jsonSchemaPropToZod(prop: JsonSchemaProp): ZodTypeAny {
	if (prop.enum) {
		const values = prop.enum as [string, ...string[]];
		return values.length > 0 ? z.enum(values) : z.string();
	}
	switch (prop.type) {
		case "string":
			return z.string();
		case "number":
		case "integer":
			return z.number();
		case "boolean":
			return z.boolean();
		case "array":
			return z.array(prop.items ? jsonSchemaPropToZod(prop.items) : z.unknown());
		case "object":
			if (prop.properties) return z.object(jsonSchemaToZodShape(prop));
			if (prop.additionalProperties && typeof prop.additionalProperties === "object") {
				return z.record(z.string(), jsonSchemaPropToZod(prop.additionalProperties));
			}
			if (prop.additionalProperties === true) return z.record(z.string(), z.unknown());
			return z.object({});
		default:
			return z.unknown();
	}
}

function jsonSchemaToZodShape(schema: JsonSchemaProp): Record<string, ZodTypeAny> {
	const shape: Record<string, ZodTypeAny> = {};
	const required = new Set(schema.required ?? []);
	for (const [key, prop] of Object.entries(schema.properties ?? {})) {
		let field = jsonSchemaPropToZod(prop);
		if (prop.description) field = field.describe(prop.description);
		if (!required.has(key)) field = field.optional();
		shape[key] = field;
	}
	return shape;
}

/** MCP-connected tools' execute() already resolves to a Zod-validated
 *  CallToolResult ({content: [...], isError?}) — the caller's own MCP client
 *  (see mcp/client.ts's dynamicTool) does the protocol round-trip and hands
 *  back the server's real response, which can carry actual image/audio/
 *  resource content blocks (e.g. a browser MCP server's screenshot tool).
 *  Detected structurally (content is an array of {type: string} blocks)
 *  since the wrapper below has no other way to tell an MCP tool from a
 *  native AgentDesk one. */
function looksLikeCallToolResult(value: unknown): value is { content: Array<{ type: string }>; isError?: boolean } {
	if (!value || typeof value !== "object") return false;
	const content = (value as { content?: unknown }).content;
	return Array.isArray(content) && content.every((c) => c && typeof c === "object" && typeof (c as { type?: unknown }).type === "string");
}

// `claude` spawns as a subprocess either way (SDK or bare CLI); its first
// tool-discovery pass can in principle fire before that handshake settles.
// Retried defensively since it's a real subprocess-timing surface. Safe
// because a retry only ever fires when no tool call carried all required
// arguments, so no side effect double-fires.
const MAX_CONNECTION_RACE_RETRIES = 2;

/**
 * Runs one bounded sub-agent task through the official `@anthropic-ai/claude-agent-sdk`
 * instead of a direct API call — used for Claude Subscription models other than
 * Haiku, which 429 on the direct-HTTP OAuth path (see claude-subscription.ts's
 * isHaikuModel doc comment for why; confirmed empirically that faithfully
 * replicating the real CLI's headers still 429s — it's a server-side gate, not
 * a header AgentDesk is missing). The SDK drives the same `claude` binary a
 * real interactive session would, so it inherits working OAuth access to
 * Sonnet/Opus for free.
 *
 * IMPORTANT: `pathToClaudeCodeExecutable` is always passed, pointing at the
 * user's system-installed `claude` binary — AgentDesk does NOT install the
 * SDK's own optional per-platform binary (~249 MB vs ~2 MB for the SDK's JS
 * alone; see package.json). Verified empirically: with that optional binary
 * absent, the SDK works identically when this option is set, and hard-throws
 * ("Native CLI binary ... not found") with no PATH fallback when it isn't —
 * so this must never be omitted.
 *
 * Tools are registered in-process via `tool()`/`createSdkMcpServer()` with
 * `alwaysLoad: true` on every tool (SDK-documented as equivalent to the API's
 * `defer_loading: false`) — this keeps the whole tool catalog eagerly loaded
 * instead of going through Claude Code's deferred ToolSearch discovery, which
 * was confirmed unreliable at real agent tool-scale (~74 tools => ~0% real
 * tool calls landed) with the previous hand-rolled stdio-MCP-subprocess
 * bridge this file replaces. `tools: []` disables Claude Code's own built-in
 * tools (Bash/Edit/Read/...) outright, so only AgentDesk's own MCP tools are
 * ever reachable — one write path, one permission model, same invariant the
 * old --disallowedTools list enforced, expressed more simply.
 */
export async function runClaudeCliTask(opts: ClaudeCliRunOpts): Promise<ClaudeCliRunResult> {
	const requireVerification = opts.verifyToolCall !== false && Object.keys(opts.tools).length > 0;
	let attempt = 0;
	while (true) {
		attempt++;
		let goodToolCallHappened = false;
		// Buffer this attempt's text/reasoning rather than streaming it straight
		// to the caller's onText/onReasoning — verified live that a discarded
		// (no-real-tool-call) attempt still generates confident, plausible prose,
		// which would otherwise flash into the UI before being replaced by the
		// failure message once the retry discards it. Tool-call callbacks are
		// NOT buffered — those represent real side effects that already
		// happened and should stay visible regardless of whether this attempt
		// ultimately counts as a win.
		const buffered: Array<{ kind: "text" | "reasoning"; value: string }> = [];
		const attemptOpts: ClaudeCliRunOpts = {
			...opts,
			onText: (text) => buffered.push({ kind: "text", value: text }),
			onReasoning: (text) => buffered.push({ kind: "reasoning", value: text }),
		};
		const result = await runClaudeCliTaskOnce(attemptOpts, () => {
			goodToolCallHappened = true;
		});
		// A user-initiated cancellation is never retried (that's the opposite of
		// what clicking Stop means) and never subject to the tool-call
		// verification guard below (no tool call landing is expected — the run
		// was cut short, not a sign of fabrication).
		if (result.status === "cancelled") {
			for (const b of buffered) {
				if (b.kind === "text") opts.onText(b.value);
				else opts.onReasoning(b.value);
			}
			return result;
		}
		if (goodToolCallHappened || !requireVerification) {
			for (const b of buffered) {
				if (b.kind === "text") opts.onText(b.value);
				else opts.onReasoning(b.value);
			}
			return result;
		}
		if (attempt > MAX_CONNECTION_RACE_RETRIES) {
			console.error(
				`[ClaudeSubscriptionSDK] No tool call verified after ${attempt} attempts despite ${Object.keys(opts.tools).length} tool(s) offered — failing rather than trusting unverified output`,
			);
			// Buffered text intentionally NOT flushed — it's unverified/possibly
			// fabricated; it's already included, clearly labeled as such, in the
			// failure summary text below instead of being shown as a live answer.
			return {
				status: "failed",
				summary: `Claude (via Agent SDK) could not verify a real tool call after ${attempt} attempts, despite ${Object.keys(opts.tools).length} tool(s) being offered. Its response was not backed by an actual tool invocation and may be fabricated. Raw (unverified) response for reference:\n\n${result.summary}`,
				usage: result.usage,
				costUsd: result.costUsd,
			};
		}
		console.warn(`[ClaudeSubscriptionSDK] No tool call with real arguments landed on attempt ${attempt} — retrying`);
		// The failed attempt's live onTextToken/onReasoningToken deltas are
		// already visible in the UI (they're never buffered) — tell the caller
		// to discard them before the retry's fresh deltas start arriving.
		opts.onRetract?.();
	}
}

/**
 * Lightweight "Test Connection" check for non-Haiku models — used by
 * ClaudeSubscriptionAdapter.testConnection() (claude-subscription.ts), since
 * that adapter's own direct-HTTP path 429s for anything but Haiku. No tools
 * offered; just confirms the system `claude` binary resolves and the stored
 * OAuth credentials can actually complete one turn with the requested model.
 */
export async function testClaudeSubscriptionSdkConnection(
	modelId: string,
): Promise<{ success: boolean; error?: string }> {
	if (!readOAuthTokenOrNull()) {
		return { success: false, error: "Not logged into Claude Code. Run `claude` in a terminal to log in." };
	}
	try {
		for await (const msg of query({
			prompt: "Reply with exactly: OK",
			options: {
				model: modelId,
				pathToClaudeCodeExecutable: resolveClaudeCliPath(),
				tools: [],
				maxTurns: 1,
				// Same isolation-mode reasoning as the main runner below — this
				// connection check shouldn't trigger the user's own Claude Code hooks.
				settingSources: [],
			},
		})) {
			if (msg.type === "result") {
				if (msg.subtype !== "success" || msg.is_error) {
					const errors = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.join("; ") : "";
					return { success: false, error: errors || `Claude Code returned an error (${msg.subtype}).` };
				}
				return { success: true };
			}
		}
		return { success: false, error: "No response from Claude Code." };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Literal substring confirmed via live testing — the SDK throws this exact
		// message when it can't resolve a `claude` binary (no bundled binary, and
		// pathToClaudeCodeExecutable didn't resolve to a real file).
		if (message.includes("Native CLI binary")) {
			return { success: false, error: "Claude Code CLI not found. Install it from claude.com/code, then run `claude` once in a terminal to log in." };
		}
		return { success: false, error: message };
	}
}

async function runClaudeCliTaskOnce(
	opts: ClaudeCliRunOpts,
	onGoodToolCall: () => void,
): Promise<ClaudeCliRunResult> {
	const recentCalls: string[] = [];

	// Created up-front (not after sdkTools, as it logically follows) so each
	// tool's execute() can be given the SAME signal that fires on timeout or
	// external abort — without this, killing the `claude` subprocess on abort
	// does NOT cancel an in-flight AgentDesk tool call (e.g. run_shell), since
	// that's a separate in-process async operation the subprocess being killed
	// has no effect on. Well-behaved tools already check options.abortSignal
	// on the normal generateText/streamText path; this brings the CLI/SDK path
	// to the same standard.
	const abortController = new AbortController();

	const sdkTools = Object.entries(opts.tools).map(([name, aiTool]) => {
		let jsonSchema: JsonSchemaProp = { type: "object", properties: {} };
		try {
			const schema = (aiTool as { inputSchema?: unknown }).inputSchema as FlexibleSchema<unknown> | undefined;
			jsonSchema = (asSchema(schema).jsonSchema as JsonSchemaProp | undefined) ?? jsonSchema;
		} catch (err) {
			console.warn(`[ClaudeSubscriptionSDK] Schema conversion failed for tool "${name}", registering with an empty schema:`, err);
		}
		const requiredFields = jsonSchema.required ?? [];

		return tool(
			name,
			(aiTool as { description?: string }).description ?? "",
			jsonSchemaToZodShape(jsonSchema),
			async (args) => {
				const argsObj = (args ?? {}) as Record<string, unknown>;
				const hash = `${name}:${JSON.stringify(argsObj)}`;
				recentCalls.push(hash);
				if (recentCalls.length > 20) recentCalls.shift();
				const repeatCount = recentCalls.filter((h) => h === hash).length;
				if (repeatCount >= STUCK_WARN_THRESHOLD) {
					const warning = `[SYSTEM WARNING] You have called "${name}" ${repeatCount} times in a row with identical arguments and received the same result each time. This tool is not making progress. Do NOT call "${name}" again with the same arguments — try a different approach.`;
					return { content: [{ type: "text" as const, text: warning }], isError: true };
				}

				const hasAllRequired = requiredFields.every((f) => argsObj[f] !== undefined);
				if (requiredFields.length === 0 || hasAllRequired) onGoodToolCall();

				const callId = opts.onToolCallStart(name, args);
				try {
					const execute = (aiTool as unknown as {
						execute: (a: unknown, o: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
					}).execute;
					const result = await execute(args, { toolCallId: callId, abortSignal: abortController.signal });
					const resultText = typeof result === "string" ? result : JSON.stringify(result);

					// MCP tool results are already a CallToolResult — pass them straight
					// through so real image/audio/resource content blocks survive,
					// instead of collapsing them into a JSON-stringified text blob that
					// strips their visual content (see looksLikeCallToolResult doc).
					if (looksLikeCallToolResult(result)) {
						opts.onToolCallEnd(callId, resultText, result.isError ?? false);
						return result as CallToolResult;
					}

					// read_image/take_screenshot embed a base64 image payload inside
					// their JSON string result — deliver it as a real MCP image content
					// block instead of dumping the whole base64 blob as literal text
					// (huge token cost, and the model never actually sees an image),
					// mirroring what buildMediaFollowUpMessage does for every other
					// provider on the normal AI-SDK path (agents/tools/media-followup.ts).
					const image = extractImagePayload(result);
					if (image) {
						opts.onToolCallEnd(callId, resultText, false);
						const textPart = imageToolModelOutput(resultText);
						return {
							content: [
								{ type: "text" as const, text: textPart.value },
								{ type: "image" as const, data: image.base64, mimeType: image.mimeType },
							],
						};
					}

					opts.onToolCallEnd(callId, resultText, false);
					return { content: [{ type: "text" as const, text: resultText }] };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					opts.onToolCallEnd(callId, message, true);
					return { content: [{ type: "text" as const, text: message }], isError: true };
				}
			},
			{ alwaysLoad: true },
		);
	});

	const server = createSdkMcpServer({ name: MCP_SERVER_NAME, tools: sdkTools });
	const allowedTools = Object.keys(opts.tools).map((name) => `mcp__${MCP_SERVER_NAME}__${name}`);

	// Real timeout and external (user-clicked-stop) cancellation both fire the
	// SAME abortController — that's the only way to actually kill the `claude`
	// subprocess for either case — but they must be reported as DIFFERENT
	// result statuses. Collapsing them (as an earlier version of this code
	// did) misreports a user-initiated stop as "task timed out", which the PM
	// treats as an ordinary agent failure and auto-continues past — the exact
	// opposite of what clicking Stop means. Track which one actually fired.
	let didTimeOut = false;
	const timeoutHandle = setTimeout(() => {
		didTimeOut = true;
		abortController.abort();
	}, opts.timeoutMs);
	const onExternalAbort = () => abortController.abort();
	opts.abortSignal?.addEventListener("abort", onExternalAbort);

	let summary = "";
	let usage: ClaudeCliRunResult["usage"] = { inputTokens: 0, outputTokens: 0 };
	let costUsd = 0;
	let finalStatus: "completed" | "failed" = "completed";
	let wasAborted = false;
	// Populated on a safety/content-policy refusal (msg.type "system",
	// subtype "model_refusal_no_fallback"/"model_refusal_fallback") — the SDK
	// emits this as its OWN message type, distinct from a "result" message, so
	// without handling it explicitly here a refused turn either falls through
	// with no readable detail or (observed live) the query() iterator throws
	// afterward with an Error whose own `.message` is empty. Captured so both
	// the "result" handling below and the outer catch's error-enrichment can
	// fall back to it instead of surfacing a blank "Agent failed: " message.
	let refusalDetail: string | null = null;

	try {
		for await (const msg of query({
			prompt: opts.task,
			options: {
				model: opts.modelId,
				systemPrompt: opts.systemPrompt,
				mcpServers: { [MCP_SERVER_NAME]: server },
				tools: [], // Disable all of Claude Code's own built-in tools (Bash/Edit/Read/...) — only AgentDesk's own MCP tools are ever reachable.
				allowedTools,
				pathToClaudeCodeExecutable: resolveClaudeCliPath(),
				cwd: opts.workspacePath,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				abortController,
				// SDK isolation mode — omitting this loads the user's real
				// ~/.claude/settings.json (and any project/local settings) by
				// default, so their own Claude Code hooks (e.g. Stop/PermissionRequest
				// desktop notifications) would fire for every AgentDesk-driven
				// session. AgentDesk already fully controls tools/permissions/model
				// itself here, so it never needed those files — an empty array
				// excludes them entirely without touching the user's own `claude`
				// CLI/desktop app usage, which is a separate process invocation.
				settingSources: [],
				// Emits `stream_event` messages (raw Anthropic content_block_delta
				// events) alongside the existing complete `assistant` messages —
				// gives real per-token text/thinking deltas for onTextToken/
				// onReasoningToken without changing what onText/onReasoning receive.
				// Only meaningfully used when a caller actually wires those up
				// (Full Streaming mode) — harmless, ignored overhead otherwise.
				includePartialMessages: true,
			},
		})) {
			if (msg.type === "stream_event") {
				const event = msg.event;
				if (event.type === "content_block_delta") {
					const delta = event.delta;
					if (delta.type === "text_delta" && delta.text) opts.onTextToken?.(delta.text);
					else if (delta.type === "thinking_delta" && delta.thinking) opts.onReasoningToken?.(delta.thinking);
				}
			} else if (msg.type === "assistant") {
				for (const block of msg.message.content ?? []) {
					if (block.type === "text" && block.text) opts.onText(block.text);
					if (block.type === "thinking" && block.thinking) opts.onReasoning(block.thinking);
				}
			} else if (msg.type === "system" && (msg.subtype === "model_refusal_no_fallback" || msg.subtype === "model_refusal_fallback")) {
				const category = msg.api_refusal_category ? ` (category: ${msg.api_refusal_category})` : "";
				const explanation = msg.api_refusal_explanation ? ` — ${msg.api_refusal_explanation}` : "";
				refusalDetail = `Model declined to respond (safety refusal)${category}${explanation}`;
			} else if (msg.type === "result") {
				if (msg.subtype === "success") {
					// An empty/falsy `result` on a refused turn (is_error true, no text
					// generated) previously surfaced as a blank summary — fall back to
					// the refusal detail captured above when there's nothing else to show.
					summary = msg.result || (msg.is_error ? refusalDetail ?? "" : "");
					finalStatus = msg.is_error ? "failed" : "completed";
				} else {
					const errors = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.join("; ") : "";
					summary = `Claude (via Agent SDK) stopped: ${msg.subtype}${errors ? ` — ${errors}` : refusalDetail ? ` — ${refusalDetail}` : ""}`;
					finalStatus = "failed";
				}
				usage = {
					inputTokens: msg.usage.input_tokens ?? 0,
					outputTokens: msg.usage.output_tokens ?? 0,
					cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
					cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
				};
				costUsd = msg.total_cost_usd ?? 0;
			}
		}
	} catch (err) {
		if (!abortController.signal.aborted) {
			// This path never builds a LanguageModel — the Agent SDK drives a
			// `claude` CLI subprocess — so createProviderAdapter's model wrapper
			// cannot see its failures. Logged here so provider_errors.log covers
			// BOTH claude-subscription routes, not just the Haiku/direct-HTTP one.
			logProviderCallError(err, {
				providerType: "claude-subscription",
				providerName: "Claude Subscription (CLI)",
				modelId: opts.modelId,
				phase: "stream",
			});
		}
		if (abortController.signal.aborted) {
			wasAborted = true;
		} else if (err instanceof Error && !err.message && refusalDetail) {
			// Observed live: a safety refusal can end the query() iterator with a
			// thrown Error whose own `.message` is empty (the SDK evidently expects
			// the model_refusal_* message above to be the caller's channel for detail,
			// not the exception itself). Without this, that surfaces all the way up
			// to the PM as "Agent failed: " with nothing after the colon.
			throw new Error(refusalDetail, { cause: err });
		} else {
			throw err;
		}
	} finally {
		clearTimeout(timeoutHandle);
		opts.abortSignal?.removeEventListener("abort", onExternalAbort);
	}

	if (wasAborted) {
		if (didTimeOut) {
			return { status: "timeout", summary: "claude-subscription (Agent SDK) task timed out", usage, costUsd };
		}
		return { status: "cancelled", summary: "Cancelled by user", usage, costUsd };
	}

	const fallbackSummary = finalStatus === "failed" ? "(no error details available)" : "(completed with no text output)";
	return { status: finalStatus, summary: summary || fallbackSummary, usage, costUsd };
}
