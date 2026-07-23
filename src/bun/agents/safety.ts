// ---------------------------------------------------------------------------
// safety.ts — Loop detection, action timeout, and retry helpers
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ActionRecord {
	toolName: string;
	argsHash: string;
	timestamp: number;
}

export interface SafetyConfig {
	loopThreshold: number;
	actionTimeoutMs: number;
	maxRetries: number;
	enabled: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: SafetyConfig = {
	loopThreshold: 10,
	actionTimeoutMs: 900_000,
	maxRetries: 3,
	enabled: true,
};

// ---------------------------------------------------------------------------
// Sliding window store (max 10 entries per agent)
// ---------------------------------------------------------------------------

/** Sliding window of recent actions per agent, keyed by agent name/id. */
export const agentWindows: Map<string, ActionRecord[]> = new Map();

const MAX_WINDOW_SIZE = 10;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Produce a stable string key for a set of tool arguments. */
export function hashArgs(args: unknown): string {
	return JSON.stringify(args);
}

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

/**
 * Record an action for the given agent and check for a loop.
 *
 * A loop is detected when the last `config.loopThreshold` consecutive
 * records in the window all share the same toolName and argsHash.
 *
 * Returns `true` if a loop is detected, `false` otherwise.
 */
export function recordAction(
	agentId: string,
	toolName: string,
	args: unknown,
	config?: Partial<SafetyConfig>,
): boolean {
	const effectiveConfig = loadSafetyConfig(config);

	if (!effectiveConfig.enabled) return false;

	const record: ActionRecord = {
		toolName,
		argsHash: hashArgs(args),
		timestamp: Date.now(),
	};

	const window = agentWindows.get(agentId) ?? [];

	// Append the new record and keep the window bounded
	window.push(record);
	if (window.length > MAX_WINDOW_SIZE) {
		window.splice(0, window.length - MAX_WINDOW_SIZE);
	}
	agentWindows.set(agentId, window);

	// Need at least loopThreshold entries to detect a loop
	const threshold = effectiveConfig.loopThreshold;
	if (window.length < threshold) return false;

	// Check whether the last `threshold` entries are identical
	const tail = window.slice(-threshold);
	const first = tail[0];
	const isLoop = tail.every(
		(r) => r.toolName === first.toolName && r.argsHash === first.argsHash,
	);

	return isLoop;
}

/** Remove the sliding window for an agent (call after the agent terminates). */
export function clearAgentHistory(agentId: string): void {
	agentWindows.delete(agentId);
}

// ---------------------------------------------------------------------------
// Action timeout
// ---------------------------------------------------------------------------

/**
 * Create an AbortSignal that fires after `config.actionTimeoutMs` milliseconds.
 *
 * Returns both the signal and a `clear()` function to cancel the timeout
 * when the operation completes within time.
 */
export function createActionTimeout(config?: Partial<SafetyConfig>): {
	signal: AbortSignal;
	clear: () => void;
} {
	const effectiveConfig = loadSafetyConfig(config);
	const controller = new AbortController();

	const timer = setTimeout(() => {
		controller.abort(new Error(`Action timed out after ${effectiveConfig.actionTimeoutMs}ms`));
	}, effectiveConfig.actionTimeoutMs);

	return {
		signal: controller.signal,
		clear: () => clearTimeout(timer),
	};
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

const BASE_DELAY_MS = 1000;
/** Ceiling on the exponential term. Jitter is added on top, so the real
 *  maximum is MAX_BACKOFF_MS + BASE_DELAY_MS. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Exponential back-off with jitter for the given retry attempt (0-indexed):
 * ~1s, ~2s, ~4s … capped at ~30s.
 *
 * The jitter matters more than the exponent here. Agents fail together —
 * `run_agents_parallel` starts up to 5 at once (staggered only 1.5s apart), the
 * PM and a sub-agent can be mid-call simultaneously, and scheduler jobs
 * overlap. Without jitter every one of them retries at exactly 1s and 2s after
 * a shared rate-limit or overload event, re-creating the burst that caused it.
 * `fetchWithRetry` in tools/web.ts already does this for the same reason; the
 * provider-call path was the one place that did not.
 */
export function getBackoffDelay(attempt: number): number {
	const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_BACKOFF_MS);
	return Math.round(exponential + Math.random() * BASE_DELAY_MS);
}

/**
 * Longest `Retry-After` we will actually wait out inside an agent turn. A
 * provider asking for more than this is telling us the request cannot succeed
 * on any useful timescale — see getRetryDelay.
 */
export const MAX_HONOURED_RETRY_AFTER_MS = 60_000;

/**
 * Parse a `Retry-After` response header off a provider error, in milliseconds.
 *
 * Read structurally (`error.responseHeaders`) rather than by importing the AI
 * SDK's APICallError, to keep this module dependency-free. Both header forms
 * from RFC 9110 are handled: delta-seconds (`120`) and an HTTP-date
 * (`Wed, 21 Oct 2015 07:28:00 GMT`).
 *
 * Returns null when the header is absent, unparseable, or already in the past.
 */
export function getRetryAfterMs(error: unknown): number | null {
	if (typeof error !== "object" || error === null) return null;
	const headers = (error as { responseHeaders?: unknown }).responseHeaders;
	if (typeof headers !== "object" || headers === null) return null;

	const header = (name: string): string | null => {
		const v = Object.entries(headers as Record<string, unknown>).find(([k]) => k.toLowerCase() === name)?.[1];
		return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
	};

	// `retry-after-ms` is an OpenAI/Anthropic extension carrying sub-second
	// precision; the AI SDK's own retry reads it, so ours must too or we would
	// be strictly worse than what maxRetries:0 replaced.
	const msHeader = header("retry-after-ms");
	if (msHeader !== null) {
		const ms = Number(msHeader);
		if (Number.isFinite(ms)) return ms > 0 ? Math.round(ms) : null;
	}

	const raw = header("retry-after");
	if (raw === null) return null;

	const seconds = Number(raw);
	if (Number.isFinite(seconds)) return seconds > 0 ? Math.round(seconds * 1000) : null;

	const when = Date.parse(raw);
	if (Number.isNaN(when)) return null;
	const ms = when - Date.now();
	return ms > 0 ? ms : null;
}

/**
 * How long to wait before the next attempt, or null to stop retrying.
 *
 * A provider's own `Retry-After` is authoritative and beats any guess we make:
 * on 429/503 it states exactly when the limit clears, and retrying earlier is
 * not just wasted — several providers restart the window on a request that
 * arrives too soon, so guessing actively prolongs the outage.
 *
 * Returns null when the provider asked for longer than
 * MAX_HONOURED_RETRY_AFTER_MS. Retrying early in that case is the specific
 * harm above, and blocking an agent turn for minutes is worse than failing it,
 * so the caller should give up and report instead.
 */
export function getRetryDelay(error: unknown, attempt: number): number | null {
	const retryAfter = getRetryAfterMs(error);
	if (retryAfter === null) return getBackoffDelay(attempt);
	return retryAfter <= MAX_HONOURED_RETRY_AFTER_MS ? retryAfter : null;
}

/**
 * Run a one-shot model call, retrying transient provider failures.
 *
 * For `generateText`-style calls ONLY — anything awaited once, that produces no
 * output until it resolves. Do NOT wrap a `streamText` consumption loop with
 * this: tokens already emitted to the UI or to a broadcast cannot be un-emitted,
 * so a retry would duplicate them. Streaming callers need per-site rollback
 * (see `retractLiveParts` in agent-loop.ts) before they can retry safely.
 *
 * Exists because the ~13 surfaces that build their own model call — the
 * Freelance pipelines, Council, Ambient, Collections and the dashboard widgets —
 * had no transient handling at all beyond the SDK's own. That left them unable
 * to retry opencode Zen's `No provider available` (a 401 the SDK must treat as
 * permanent), which is exactly what killed the unattended auto-shortlist job.
 *
 * Pass `maxRetries: 0` to the wrapped SDK call so this owns retrying outright,
 * matching the agent loop — otherwise the SDK's attempts nest inside these.
 */
export async function withTransientRetry<T>(
	call: () => Promise<T>,
	opts: { maxRetries?: number; label?: string; abortSignal?: AbortSignal } = {},
): Promise<T> {
	// `label` attributes any provider failure inside to this caller in
	// provider_errors.log — see withProviderCaller in providers/error-log.ts.
	if (opts.label !== undefined) {
		const { label, ...rest } = opts;
		const { withProviderCaller } = await import("../providers/error-log");
		return withProviderCaller(label, () => withTransientRetry(call, rest));
	}
	const maxRetries = opts.maxRetries ?? 2;
	for (let attempt = 0; ; attempt++) {
		try {
			return await call();
		} catch (error) {
			if (opts.abortSignal?.aborted) throw error;
			if (attempt >= maxRetries || !isTransientError(error)) throw error;
			const delay = getRetryDelay(error, attempt);
			// Provider asked for longer than we will block — see getRetryDelay.
			if (delay === null) throw error;
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, delay);
				opts.abortSignal?.addEventListener(
					"abort",
					() => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); },
					{ once: true },
				);
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

/**
 * HTTP statuses that mean "the request never reached a model; try again".
 *
 * Mirrors the AI SDK's own rule (`APICallError`'s `isRetryable` default in
 * @ai-sdk/provider: 408, 409, 429, >= 500). That parity is load-bearing, not
 * cosmetic: the agent loop passes `maxRetries: 0` so the SDK does not retry at
 * all and this classifier is the ONLY retry authority. Anything the SDK would
 * have retried and this does not is a silently dropped retry.
 * `tests/tools/safety.test.ts` checks every status 100-599 against the SDK rule.
 *
 * This used to be a hand-picked list (429/503, later widened), which is how
 * five real failures ended up classified permanent — 500 generic faults, 502/504
 * gateways, Cloudflare 520-527, and Anthropic's 529 `overloaded_error`. Stating
 * the rule as a range instead of an enumeration makes that class of miss
 * impossible.
 *
 * One deliberate divergence: 501 Not Implemented. From an AI provider it means
 * the endpoint or feature does not exist, which no amount of retrying fixes —
 * retrying only delays an honest error by ~3s.
 */
export const RETRY_STATUS_EXCLUDED_5XX = 501;

function isTransientStatus(status: number): boolean {
	if (status === 408 || status === 409 || status === 429) return true;
	return status >= 500 && status !== RETRY_STATUS_EXCLUDED_5XX;
}

/**
 * Transient failures that arrive with a PERMANENT-looking status code, matched
 * on message because the status alone would be wrong.
 *
 * opencode Zen answers 401 for four unrelated conditions, distinguishable only
 * by the response body: `AuthError: Missing API key.` (permanent),
 * `ModelError: Model x is not supported` (permanent), and
 * `ModelError: No provider available` — which is upstream capacity being
 * momentarily exhausted, verified live as transient and per-model (two free
 * models returned it in the same second that four others answered fine, and the
 * same model then succeeded 14 times out of 15).
 *
 * Matched on the message and NEVER on the 401 itself: treating 401 as
 * retryable in general would make a genuinely wrong API key burn three
 * backed-off attempts on every single call.
 */
const NO_UPSTREAM_CAPACITY_MESSAGES = ["no provider available"];

/**
 * Gateway failures that arrive with no status code at all, because they happen
 * mid-stream rather than on the HTTP response.
 *
 * `Streaming response failed` is opencode Zen's own text for a stream it could
 * not finish — a known issue on its free tier (anomalyco/opencode#38024,
 * #35397, #37638), seen here when the PM tried to synthesise three agent
 * reports. `Provider returned error` is its equally generic sibling. Neither
 * string exists anywhere in this codebase; both arrive over the wire.
 *
 * Matched on text because there is nothing else to match on. Retrying is
 * additionally gated on nothing having been emitted yet (see engine.ts), so a
 * false positive costs one wasted attempt, never duplicated output.
 */
const STREAM_FAILURE_MESSAGES = ["streaming response failed", "provider returned error"];

/**
 * Returns `true` when the error looks transient (network hiccup, rate limit,
 * temporary server unavailability) and the operation is safe to retry.
 */
export function isTransientError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	const message = error.message.toLowerCase();
	const name = error.name.toLowerCase();

	// HTTP status codes embedded in message strings (common AI SDK pattern)
	if (message.includes("429") || message.includes("503")) return true;

	// Rate limit / quota phrases
	if (message.includes("rate limit") || message.includes("rate_limit")) return true;
	if (message.includes("too many requests")) return true;
	if (message.includes("quota")) return true;

	// Provider has no upstream capacity right now — see the constant above for
	// why this is matched on the message rather than the status it arrives with.
	if (NO_UPSTREAM_CAPACITY_MESSAGES.some((m) => message.includes(m))) return true;

	// Gateway gave up mid-stream — no status code to classify on.
	if (STREAM_FAILURE_MESSAGES.some((m) => message.includes(m))) return true;

	// Network-level transients
	if (message.includes("econnreset") || name.includes("econnreset")) return true;
	if (message.includes("timeout") || name.includes("timeout")) return true;
	if (message.includes("socket hang up")) return true;
	if (message.includes("network")) return true;
	if (message.includes("enotfound")) return true;
	if (message.includes("etimedout")) return true;
	if (message.includes("unable to connect")) return true; // Bun fetch error
	if (message.includes("fetch failed")) return true; // Node/Bun fetch error
	if (message.includes("econnrefused")) return true;

	// HTTP status code on error object (some SDKs attach .status or .statusCode)
	const anyErr = error as unknown as Record<string, unknown>;
	const status = anyErr["status"] ?? anyErr["statusCode"];
	if (typeof status === "number" && isTransientStatus(status)) return true;

	return false;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/** Merge caller-supplied overrides with DEFAULT_CONFIG. */
export function loadSafetyConfig(overrides?: Partial<SafetyConfig>): SafetyConfig {
	if (!overrides) return { ...DEFAULT_CONFIG };
	return { ...DEFAULT_CONFIG, ...overrides };
}

