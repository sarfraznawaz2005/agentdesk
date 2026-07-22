import { APICallError } from "ai";

// Pure classifiers for "the provider/model rejected this capability at request
// time" errors. Kept in their own dependency-free module (only the `ai` package)
// so unit tests can exercise the REAL implementations — engine-types.ts, where
// these are re-exported from, is mock.module()'d wholesale by agent-loop.test.ts,
// and Bun module mocks leak process-wide, which would otherwise stub these out
// for every other test file too.

// Ways providers word a "this capability is off for this model" rejection:
// "does not support X" (Ollama), "X is not enabled for this model" (Mistral),
// "X is disabled / not available", etc. Kept as one shared alternation so the
// thinking and tools detectors below stay in sync.
const CAPABILITY_REJECTED = "not support|unsupported|not enabled|disabled|not available";

// Text to match a capability-rejection against: the top-level error message
// PLUS the raw responseBody. OpenAI-compatible providers (e.g. Mistral) set the
// message to just the HTTP status ("Bad Request") and put the real reason
// ("reasoning_effort is not enabled for this model") only in the JSON
// responseBody, so the message alone isn't enough.
function apiCallErrorText(err: APICallError): string {
	const body = typeof err.responseBody === "string" ? err.responseBody : "";
	return `${err.message}\n${body}`;
}

/**
 * True when a model-call error indicates the provider/model itself rejected
 * the request because it doesn't support extended thinking/reasoning (e.g.
 * Ollama's `"gemma3:1b" does not support thinking`, or Mistral's
 * `reasoning_effort is not enabled for this model` — a 400 whose message is
 * just "Bad Request" and whose real reason is in responseBody). These are
 * deterministic rejections, not transient — the same call fails again with the
 * same options — so callers should retry once with `reasoning` stripped instead
 * of surfacing it as a hard generation failure. Deliberately provider-agnostic
 * (text-based) since this can surface from any provider/model combination.
 *
 * Gated on APICallError first: the AI SDK has no structured, cross-provider
 * "which capability is unsupported" error for a runtime, server-side capability
 * rejection like this one (confirmed by reading @ai-sdk/openai-compatible's
 * own source — its UnsupportedFunctionalityError is for a different case, a
 * client-side "the SDK integration itself doesn't implement this" check, not
 * "the model rejected it at request time"). Requiring APICallError first at
 * least confirms this is a genuine provider HTTP-level rejection before the
 * text match runs, rather than matching against a network/parsing error whose
 * text might coincidentally contain similar words.
 */
export function isThinkingUnsupportedError(err: unknown): boolean {
	if (!APICallError.isInstance(err)) return false;
	const text = apiCallErrorText(err);
	return (
		new RegExp(`(?:thinking|reasoning)[^.]{0,40}(?:${CAPABILITY_REJECTED})`, "i").test(text) ||
		new RegExp(`(?:${CAPABILITY_REJECTED})[^.]{0,40}(?:thinking|reasoning)`, "i").test(text)
	);
}

/**
 * True when a model-call error indicates the provider/model rejected the
 * request because the model itself has no function/tool-calling capability
 * at all (e.g. small local Ollama models like gemma3:1b — Ollama's server
 * responds with `"<model>" does not support tools` the moment ANY tools
 * array is attached, even for a plain "hey" that never needed one — the PM
 * always attaches its full tool set to every turn). Unlike the thinking case
 * this is a much bigger capability loss: tools are how the PM actually does
 * anything (dispatch agents, kanban, files, ...), not an optional richness
 * feature — see warnToolsUnsupportedOnce's message. Still deterministic, not
 * transient, and still provider-agnostic by design.
 *
 * Gated on APICallError first — see isThinkingUnsupportedError's comment for
 * why: no structured SDK error exists for this runtime, server-side
 * rejection, so requiring a genuine API-level error first at least narrows
 * what the message-text match runs against.
 */
export function isToolsUnsupportedError(err: unknown): boolean {
	if (!APICallError.isInstance(err)) return false;
	const text = apiCallErrorText(err);
	return (
		new RegExp(`(?:tools?|tool calling|function calling)[^.]{0,40}(?:${CAPABILITY_REJECTED})`, "i").test(text) ||
		new RegExp(`(?:${CAPABILITY_REJECTED})[^.]{0,40}(?:tools?|tool calling|function calling)`, "i").test(text)
	);
}
