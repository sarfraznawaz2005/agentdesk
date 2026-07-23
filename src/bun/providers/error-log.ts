/**
 * error-log.ts — every AI provider call failure, in one file.
 *
 * Provider failures used to surface only as a raw AI SDK stack dumped to the
 * dev console by whichever call site happened to catch them, so a real outage
 * (e.g. opencode.ai/zen returning HTTP 500 to the Freelance auto-shortlist job)
 * looked like an application bug and was invisible in production, where there
 * is no console attached.
 *
 * The wrapper is applied once in createProviderAdapter, which every provider
 * call in the app goes through — the PM loop, sub-agents, Council, Scheduler,
 * Freelance, Playground, General Chat — so no call site has to remember to log.
 *
 * REDACTION: this writes to a plain-text file the user may share when reporting
 * a bug, so it deliberately records only what identifies the failure — endpoint,
 * status, retryability, the provider's own error body. It never records request
 * headers (bearer tokens), the request body (the full conversation), or the
 * provider's API key, and it scrubs anything key-shaped out of the URL and body.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { APICallError, RetryError, type LanguageModel } from "ai";
import { createLogger, fields } from "../lib/logger";

const logProviderError = createLogger("provider_errors");

/**
 * Who is making the current provider call, for attribution in the log.
 *
 * Without this the log records provider/model/phase but not the caller, so
 * four identical failures are indistinguishable between "one turn failing to
 * recover" and "four agents each failing once and recovering" — exactly the
 * question that arose when Mistral rejected `reasoning_effort` four times.
 *
 * AsyncLocalStorage rather than a module-level variable because agents run
 * concurrently (`run_agents_parallel` starts up to 5); a shared mutable
 * "current caller" would attribute failures to whichever agent wrote it last.
 */
const callerStore = new AsyncLocalStorage<string>();

/** Run `fn` with provider failures inside it attributed to `caller`. */
export function withProviderCaller<T>(caller: string, fn: () => T): T {
	return callerStore.run(caller, fn);
}

const MAX_BODY_CHARS = 500;

/**
 * Strip anything that looks like a credential. Belt-and-braces: the fields we
 * log should never contain one, but a provider is free to echo a query-string
 * key back in an error message, and this file is meant to be shareable.
 */
function redact(text: string): string {
	return text
		.replace(/(sk-|xai-|gsk_|pk-)[A-Za-z0-9_-]{8,}/g, "$1***")
		.replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1***")
		.replace(/([?&](?:api[-_]?key|key|token|access_token)=)[^&\s]+/gi, "$1***");
}

interface ProviderErrorFacts {
	kind: "api" | "retry" | "other";
	message: string;
	url?: string;
	statusCode?: number;
	isRetryable?: boolean;
	responseBody?: string;
	attempts?: number;
}

/** Pull the useful fields off an AI SDK error, unwrapping RetryError to its last cause. */
export function describeProviderError(err: unknown): ProviderErrorFacts {
	if (RetryError.isInstance(err)) {
		const last = err.errors[err.errors.length - 1];
		const inner = last === undefined ? undefined : describeProviderError(last);
		return {
			...(inner ?? { kind: "other", message: err.message }),
			kind: "retry",
			attempts: err.errors.length,
			message: inner?.message ?? err.message,
		};
	}
	if (APICallError.isInstance(err)) {
		return {
			kind: "api",
			message: err.message,
			url: err.url,
			statusCode: err.statusCode,
			isRetryable: err.isRetryable,
			responseBody: err.responseBody ?? undefined,
		};
	}
	return { kind: "other", message: err instanceof Error ? err.message : String(err) };
}

export interface ProviderCallContext {
	providerType: string;
	providerName: string;
	modelId: string;
	/** Which SDK entry point failed — a stream can fail mid-response, a generate cannot. */
	phase: "generate" | "stream";
}

/** Append one line to provider_errors.log. Never throws. */
export function logProviderCallError(err: unknown, ctx: ProviderCallContext): void {
	const f = describeProviderError(err);
	const body = f.responseBody ? redact(f.responseBody).slice(0, MAX_BODY_CHARS) : undefined;
	logProviderError(
		fields({
			caller: callerStore.getStore(),
			provider: ctx.providerName,
			type: ctx.providerType,
			model: ctx.modelId,
			phase: ctx.phase,
			kind: f.kind,
			status: f.statusCode,
			retryable: f.isRetryable,
			attempts: f.attempts,
			url: f.url ? redact(f.url) : undefined,
			error: redact(f.message),
			body: body && body !== redact(f.message) ? body : undefined,
		}),
	);
}

/** Shape of an AI SDK v2 language model, narrowed to the two call methods. */
type CallableModel = {
	doGenerate: (options: unknown) => Promise<unknown>;
	doStream: (options: unknown) => Promise<unknown>;
};

function isCallableModel(model: unknown): model is CallableModel {
	return (
		typeof model === "object" && model !== null &&
		typeof (model as CallableModel).doGenerate === "function" &&
		typeof (model as CallableModel).doStream === "function"
	);
}

/**
 * Attach mid-stream error logging to a doStream() result.
 *
 * `doStream()`'s promise resolves the moment the connection opens, so the
 * try/catch below only ever sees CONNECTION failures. A provider that dies
 * partway through delivering tokens surfaces that as an `error` part inside the
 * stream — invisible to the caller's catch and, until this existed, absent from
 * provider_errors.log entirely. That gap is how opencode Zen's own
 * "Streaming response failed" (a known issue on its free tier) reached a user
 * with no trace in the log at all.
 *
 * Observation only: every chunk is passed through untouched and no error is
 * swallowed, converted or re-ordered.
 */
function logStreamErrors(result: unknown, ctx: ProviderCallContext): unknown {
	if (typeof result !== "object" || result === null) return result;
	const holder = result as { stream?: unknown };
	if (!(holder.stream instanceof ReadableStream)) return result;

	const seen = new WeakSet<object>();
	const observer = new TransformStream({
		transform(chunk, controller) {
			// AI SDK v2 stream parts: { type: "error", error: unknown }.
			if (chunk && typeof chunk === "object" && (chunk as { type?: unknown }).type === "error") {
				const err = (chunk as { error?: unknown }).error;
				// A part can legitimately be re-emitted; log each distinct error once.
				if (!(typeof err === "object" && err !== null && seen.has(err))) {
					if (typeof err === "object" && err !== null) seen.add(err);
					logProviderCallError(err, { ...ctx, phase: "stream" });
				}
			}
			controller.enqueue(chunk);
		},
	});

	return { ...holder, stream: (holder.stream as ReadableStream).pipeThrough(observer) };
}

/**
 * Wrap a model so any failure from doGenerate/doStream is recorded before it
 * propagates. Logging only — the error is always re-thrown unchanged, so retry,
 * fallback and every caller's own error handling behave exactly as before.
 *
 * A `LanguageModel` may be a plain string (AI SDK gateway id) rather than a
 * model object; those are returned untouched.
 */
export function withProviderErrorLogging(model: LanguageModel, ctx: ProviderCallContext): LanguageModel {
	if (!isCallableModel(model)) return model;

	return new Proxy(model, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (prop !== "doGenerate" && prop !== "doStream") return value;
			if (typeof value !== "function") return value;

			const isStream = prop === "doStream";
			const phase = isStream ? "stream" : "generate";
			return async function (this: unknown, ...args: unknown[]) {
				try {
					const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
					return isStream ? logStreamErrors(out, ctx) : out;
				} catch (err) {
					// An abort is the user pressing Stop, not a provider failure.
					if (!(err instanceof DOMException && err.name === "AbortError")) {
						logProviderCallError(err, { ...ctx, phase });
					}
					throw err;
				}
			};
		},
	}) as LanguageModel;
}
