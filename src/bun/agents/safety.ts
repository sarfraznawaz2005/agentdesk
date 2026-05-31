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

/**
 * Compute exponential back-off delay for the given retry attempt (0-indexed).
 * Capped at 30 seconds.
 */
export function getBackoffDelay(attempt: number): number {
	return Math.min(1000 * 2 ** attempt, 30_000);
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

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
	if (status === 429 || status === 503) return true;

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

