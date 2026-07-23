/**
 * safety.test.ts
 *
 * Tests for safety.ts — loop detection, action timeout, backoff, transient
 * error classification, and config loading.
 *
 * No external dependencies — all logic is pure.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
	recordAction,
	clearAgentHistory,
	agentWindows,
	hashArgs,
	getBackoffDelay,
	getRetryAfterMs,
	getRetryDelay,
	withTransientRetry,
	MAX_HONOURED_RETRY_AFTER_MS,
	RETRY_STATUS_EXCLUDED_5XX,
	isTransientError,
	loadSafetyConfig,
	createActionTimeout,
	DEFAULT_CONFIG,
} from "../../src/bun/agents/safety";

// Clean up shared agentWindows state before every test
beforeEach(() => {
	agentWindows.clear();
});

// ---------------------------------------------------------------------------
// hashArgs
// ---------------------------------------------------------------------------

describe("hashArgs", () => {
	it("returns a stable JSON string for a simple object", () => {
		const result = hashArgs({ path: "/src/index.ts", line: 42 });
		expect(result).toBe(JSON.stringify({ path: "/src/index.ts", line: 42 }));
	});

	it("returns the same string for the same args on repeated calls", () => {
		const args = { tool: "write_file", content: "hello" };
		expect(hashArgs(args)).toBe(hashArgs(args));
	});

	it("returns different strings for different args", () => {
		const a = hashArgs({ path: "/a.ts" });
		const b = hashArgs({ path: "/b.ts" });
		expect(a).not.toBe(b);
	});

	it("handles null args", () => {
		expect(() => hashArgs(null)).not.toThrow();
		expect(hashArgs(null)).toBe("null");
	});

	it("handles primitive number args", () => {
		expect(hashArgs(42)).toBe("42");
	});
});

// ---------------------------------------------------------------------------
// recordAction — loop detection
// ---------------------------------------------------------------------------

describe("recordAction — no loop", () => {
	it("returns false for the first recorded action", () => {
		const isLoop = recordAction("agent-1", "read_file", { path: "/a.ts" }, { loopThreshold: 3 });
		expect(isLoop).toBe(false);
	});

	it("returns false when actions vary in tool name", () => {
		recordAction("agent-1", "read_file", { path: "/a.ts" }, { loopThreshold: 3 });
		recordAction("agent-1", "write_file", { path: "/a.ts" }, { loopThreshold: 3 });
		const isLoop = recordAction("agent-1", "git_status", {}, { loopThreshold: 3 });
		expect(isLoop).toBe(false);
	});

	it("returns false when actions vary in args", () => {
		recordAction("agent-2", "read_file", { path: "/a.ts" }, { loopThreshold: 3 });
		recordAction("agent-2", "read_file", { path: "/b.ts" }, { loopThreshold: 3 });
		const isLoop = recordAction("agent-2", "read_file", { path: "/c.ts" }, { loopThreshold: 3 });
		expect(isLoop).toBe(false);
	});

	it("returns false when count is below threshold", () => {
		recordAction("agent-3", "run_shell", { command: "ls" }, { loopThreshold: 5 });
		recordAction("agent-3", "run_shell", { command: "ls" }, { loopThreshold: 5 });
		const isLoop = recordAction("agent-3", "run_shell", { command: "ls" }, { loopThreshold: 5 });
		// 3 repetitions with threshold 5 — not a loop yet
		expect(isLoop).toBe(false);
	});
});

describe("recordAction — loop detected", () => {
	it("returns true when threshold consecutive identical actions are recorded", () => {
		const agentId = "loopy-agent";
		const threshold = 4;
		for (let i = 0; i < threshold - 1; i++) {
			const result = recordAction(agentId, "read_file", { path: "/loop.ts" }, { loopThreshold: threshold });
			expect(result).toBe(false);
		}
		// Nth call should trigger the loop
		const isLoop = recordAction(agentId, "read_file", { path: "/loop.ts" }, { loopThreshold: threshold });
		expect(isLoop).toBe(true);
	});

	it("does NOT detect a loop when a different action breaks the streak", () => {
		const agentId = "almost-loopy";
		const threshold = 3;
		recordAction(agentId, "read_file", { path: "/a.ts" }, { loopThreshold: threshold });
		recordAction(agentId, "read_file", { path: "/a.ts" }, { loopThreshold: threshold });
		// Different tool — breaks the streak
		recordAction(agentId, "git_status", {}, { loopThreshold: threshold });
		// Back to same action
		const isLoop = recordAction(agentId, "read_file", { path: "/a.ts" }, { loopThreshold: threshold });
		expect(isLoop).toBe(false);
	});

	it("returns false when safety is disabled", () => {
		const agentId = "disabled-agent";
		for (let i = 0; i < 10; i++) {
			const result = recordAction(agentId, "read_file", { path: "/loop.ts" }, { enabled: false, loopThreshold: 3 });
			expect(result).toBe(false);
		}
	});
});

describe("recordAction — sliding window", () => {
	it("maintains a sliding window of max 10 entries", () => {
		const agentId = "window-agent";
		for (let i = 0; i < 15; i++) {
			recordAction(agentId, "tool", { i }, { loopThreshold: 10 });
		}
		const window = agentWindows.get(agentId)!;
		expect(window.length).toBeLessThanOrEqual(10);
	});

	it("different agents maintain independent windows", () => {
		recordAction("agent-x", "read_file", { path: "/a.ts" }, { loopThreshold: 5 });
		recordAction("agent-y", "write_file", { path: "/b.ts" }, { loopThreshold: 5 });

		expect(agentWindows.get("agent-x")).toBeTruthy();
		expect(agentWindows.get("agent-y")).toBeTruthy();
		expect(agentWindows.get("agent-x")![0].toolName).toBe("read_file");
		expect(agentWindows.get("agent-y")![0].toolName).toBe("write_file");
	});
});

// ---------------------------------------------------------------------------
// clearAgentHistory
// ---------------------------------------------------------------------------

describe("clearAgentHistory", () => {
	it("removes the window for the given agent", () => {
		recordAction("agent-clear", "read_file", {}, { loopThreshold: 5 });
		expect(agentWindows.has("agent-clear")).toBe(true);

		clearAgentHistory("agent-clear");
		expect(agentWindows.has("agent-clear")).toBe(false);
	});

	it("is a no-op for an agent that never had a window", () => {
		expect(() => clearAgentHistory("ghost-agent")).not.toThrow();
	});

	it("does not affect other agents", () => {
		recordAction("keep-agent", "read_file", {}, { loopThreshold: 5 });
		recordAction("remove-agent", "write_file", {}, { loopThreshold: 5 });

		clearAgentHistory("remove-agent");

		expect(agentWindows.has("keep-agent")).toBe(true);
		expect(agentWindows.has("remove-agent")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getBackoffDelay
// ---------------------------------------------------------------------------

describe("getBackoffDelay", () => {
	// Jittered: the exponential term plus 0-1000ms, so assertions are ranges.
	// Without jitter, agents that fail together (run_agents_parallel starts 5
	// at 1.5s apart; PM + sub-agent overlap) all retried at exactly the same
	// two instants, re-creating the burst that rate-limited them.
	const JITTER_MS = 1000;

	it("returns ~1000ms for attempt 0", () => {
		expect(getBackoffDelay(0)).toBeGreaterThanOrEqual(1000);
		expect(getBackoffDelay(0)).toBeLessThanOrEqual(1000 + JITTER_MS);
	});

	it("returns ~2000ms for attempt 1", () => {
		expect(getBackoffDelay(1)).toBeGreaterThanOrEqual(2000);
		expect(getBackoffDelay(1)).toBeLessThanOrEqual(2000 + JITTER_MS);
	});

	it("returns ~4000ms for attempt 2", () => {
		expect(getBackoffDelay(2)).toBeGreaterThanOrEqual(4000);
		expect(getBackoffDelay(2)).toBeLessThanOrEqual(4000 + JITTER_MS);
	});

	it("caps the exponential term at 30_000ms", () => {
		for (const attempt of [10, 100]) {
			expect(getBackoffDelay(attempt)).toBeGreaterThanOrEqual(30_000);
			expect(getBackoffDelay(attempt)).toBeLessThanOrEqual(30_000 + JITTER_MS);
		}
	});

	it("grows exponentially despite the jitter", () => {
		// Jitter is one base unit, strictly less than the gap between steps, so
		// the ordering can never invert.
		for (let i = 1; i <= 4; i++) {
			expect(getBackoffDelay(i)).toBeGreaterThan(getBackoffDelay(i - 1));
		}
	});

	it("spreads concurrent retriers instead of aligning them", () => {
		const delays = new Set(Array.from({ length: 40 }, () => getBackoffDelay(0)));
		// 40 agents retrying the same failed attempt must not land on one instant.
		expect(delays.size).toBeGreaterThan(20);
	});
});

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------

describe("getRetryAfterMs / getRetryDelay", () => {
	const withHeaders = (headers: Record<string, string>) =>
		Object.assign(new Error("Rate limited"), { statusCode: 429, responseHeaders: headers });

	it("parses delta-seconds", () => {
		expect(getRetryAfterMs(withHeaders({ "retry-after": "12" }))).toBe(12_000);
	});

	it("parses an HTTP-date", () => {
		const when = new Date(Date.now() + 20_000).toUTCString();
		const ms = getRetryAfterMs(withHeaders({ "retry-after": when }));
		// Second-resolution header, so allow a little slack either side.
		expect(ms).toBeGreaterThan(18_000);
		expect(ms).toBeLessThanOrEqual(20_000);
	});

	it("is case-insensitive about the header name", () => {
		expect(getRetryAfterMs(withHeaders({ "Retry-After": "5" }))).toBe(5_000);
	});

	it("returns null for absent, empty, unparseable or past values", () => {
		expect(getRetryAfterMs(withHeaders({}))).toBeNull();
		expect(getRetryAfterMs(withHeaders({ "retry-after": "  " }))).toBeNull();
		expect(getRetryAfterMs(withHeaders({ "retry-after": "soon" }))).toBeNull();
		expect(getRetryAfterMs(withHeaders({ "retry-after": "0" }))).toBeNull();
		expect(getRetryAfterMs(withHeaders({ "retry-after": new Date(Date.now() - 60_000).toUTCString() }))).toBeNull();
		expect(getRetryAfterMs(new Error("no headers at all"))).toBeNull();
		expect(getRetryAfterMs(null)).toBeNull();
	});

	it("prefers the provider's Retry-After over our own backoff", () => {
		// The provider knows when its limit clears; our exponential guess does not.
		expect(getRetryDelay(withHeaders({ "retry-after": "7" }), 0)).toBe(7_000);
	});

	it("falls back to jittered backoff when there is no Retry-After", () => {
		const delay = getRetryDelay(new Error("socket hang up"), 0);
		expect(delay).toBeGreaterThanOrEqual(1000);
		expect(delay).toBeLessThanOrEqual(2000);
	});

	it("gives up rather than retrying early when the wait is too long", () => {
		// Retrying before the stated time is what makes some providers restart
		// the window — failing fast is strictly better than guessing.
		expect(getRetryDelay(withHeaders({ "retry-after": "3600" }), 0)).toBeNull();
		expect(getRetryDelay(withHeaders({ "retry-after": String(MAX_HONOURED_RETRY_AFTER_MS / 1000 + 1) }), 0)).toBeNull();
	});

	it("honours a wait exactly at the limit", () => {
		expect(getRetryDelay(withHeaders({ "retry-after": String(MAX_HONOURED_RETRY_AFTER_MS / 1000) }), 0))
			.toBe(MAX_HONOURED_RETRY_AFTER_MS);
	});

	it("reads retry-after-ms, the OpenAI/Anthropic sub-second extension", () => {
		// The AI SDK's own retry reads this header, so ours must too — otherwise
		// maxRetries:0 traded away behaviour we did not replace.
		expect(getRetryAfterMs(withHeaders({ "retry-after-ms": "1500" }))).toBe(1500);
		// It wins over retry-after when both are present, matching the SDK.
		expect(getRetryAfterMs(withHeaders({ "retry-after-ms": "250", "retry-after": "9" }))).toBe(250);
	});
});

// ---------------------------------------------------------------------------
// withTransientRetry
// ---------------------------------------------------------------------------

describe("withTransientRetry", () => {
	const transient = () => Object.assign(new Error("Internal server error"), { statusCode: 500 });
	const permanent = () => Object.assign(new Error("Incorrect API key"), { statusCode: 401 });

	it("returns the value when the call succeeds first time", async () => {
		let calls = 0;
		const out = await withTransientRetry(async () => { calls++; return "ok"; });
		expect(out).toBe("ok");
		expect(calls).toBe(1);
	});

	it("retries a transient failure and returns the eventual success", async () => {
		let calls = 0;
		const out = await withTransientRetry(async () => {
			calls++;
			if (calls < 3) throw transient();
			return "recovered";
		}, { maxRetries: 2 });
		expect(out).toBe("recovered");
		expect(calls).toBe(3);
	});

	it("gives up after maxRetries and rethrows the original error", async () => {
		let calls = 0;
		await expect(withTransientRetry(async () => { calls++; throw transient(); }, { maxRetries: 2 }))
			.rejects.toThrow("Internal server error");
		expect(calls).toBe(3); // original + 2 retries, matching the agent loop
	});

	it("does not retry a permanent failure", async () => {
		let calls = 0;
		await expect(withTransientRetry(async () => { calls++; throw permanent(); }))
			.rejects.toThrow("Incorrect API key");
		expect(calls).toBe(1);
	});

	it("retries Zen's 401 'No provider available' — the case that killed auto-shortlist", async () => {
		let calls = 0;
		const out = await withTransientRetry(async () => {
			calls++;
			if (calls === 1) throw Object.assign(new Error("No provider available"), { statusCode: 401 });
			return "ok";
		});
		expect(out).toBe("ok");
		expect(calls).toBe(2);
	});

	it("stops immediately once aborted", async () => {
		const ac = new AbortController();
		let calls = 0;
		await expect(withTransientRetry(async () => { calls++; ac.abort(); throw transient(); }, { abortSignal: ac.signal }))
			.rejects.toThrow();
		expect(calls).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// isTransientError
// ---------------------------------------------------------------------------

describe("isTransientError", () => {
	it("returns false for non-Error values", () => {
		expect(isTransientError("string error")).toBe(false);
		expect(isTransientError(null)).toBe(false);
		expect(isTransientError(42)).toBe(false);
		expect(isTransientError({ code: "ECONNRESET" })).toBe(false);
	});

	it("returns true for 429 in the message", () => {
		expect(isTransientError(new Error("Request failed with status 429"))).toBe(true);
	});

	it("returns true for 503 in the message", () => {
		expect(isTransientError(new Error("503 Service Unavailable"))).toBe(true);
	});

	it("returns true for rate limit phrase", () => {
		expect(isTransientError(new Error("rate limit exceeded"))).toBe(true);
		expect(isTransientError(new Error("rate_limit hit"))).toBe(true);
	});

	it("returns true for 'too many requests'", () => {
		expect(isTransientError(new Error("Too Many Requests"))).toBe(true);
	});

	it("returns true for quota errors", () => {
		expect(isTransientError(new Error("quota exceeded for this project"))).toBe(true);
	});

	it("returns true for ECONNRESET", () => {
		expect(isTransientError(new Error("read ECONNRESET"))).toBe(true);
	});

	it("returns true for timeout errors", () => {
		expect(isTransientError(new Error("Request timeout"))).toBe(true);
	});

	it("returns true for socket hang up", () => {
		expect(isTransientError(new Error("socket hang up"))).toBe(true);
	});

	it("returns true for network errors", () => {
		expect(isTransientError(new Error("network error"))).toBe(true);
	});

	it("returns true for fetch failed", () => {
		expect(isTransientError(new Error("fetch failed"))).toBe(true);
	});

	it("returns true for ECONNREFUSED", () => {
		expect(isTransientError(new Error("connect ECONNREFUSED 127.0.0.1:3000"))).toBe(true);
	});

	it("returns true when error has .status = 429", () => {
		const err = Object.assign(new Error("API error"), { status: 429 });
		expect(isTransientError(err)).toBe(true);
	});

	it("returns true when error has .statusCode = 503", () => {
		const err = Object.assign(new Error("API error"), { statusCode: 503 });
		expect(isTransientError(err)).toBe(true);
	});

	it("returns false for a generic logic error", () => {
		expect(isTransientError(new Error("undefined is not a function"))).toBe(false);
	});

	it("returns false for a null pointer error", () => {
		expect(isTransientError(new Error("Cannot read property 'id' of null"))).toBe(false);
	});

	it("returns false for a 400 bad request (non-transient)", () => {
		expect(isTransientError(new Error("400 Bad Request"))).toBe(false);
	});

	// -------------------------------------------------------------------
	// Real provider failure shapes.
	//
	// The status list was 429/503 only, so five of the error shapes below
	// were classified permanent and ended an agent run outright — each one a
	// failure a retry a second later would have cleared. Verified live
	// against opencode Zen: the same free model returned "No provider
	// available" and then succeeded 14 of the next 15 calls.
	// -------------------------------------------------------------------
	describe("real provider failure shapes", () => {
		const withStatus = (statusCode: number, message = "API error") =>
			Object.assign(new Error(message), { statusCode });

		const TRANSIENT: Array<[string, Error]> = [
			["500 generic provider fault", withStatus(500, "Internal server error")],
			["502 bad gateway", withStatus(502, "Bad Gateway")],
			["504 gateway timeout", withStatus(504, "Gateway Timeout")],
			["520 Cloudflare unknown error", withStatus(520, "Web server returned an unknown error")],
			["527 Cloudflare railgun error", withStatus(527, "Railgun error")],
			["529 Anthropic overloaded_error", withStatus(529, "Overloaded")],
			// Zen answers 401 for this, so it must match on the message alone.
			["Zen 'No provider available'", withStatus(401, "No provider available")],
		];

		for (const [label, err] of TRANSIENT) {
			it(`retries: ${label}`, () => expect(isTransientError(err)).toBe(true));
		}

		const PERMANENT: Array<[string, Error]> = [
			// The two Zen 401s that look identical to the transient one at the
			// status level. Retrying either is pure waste.
			["Zen 'Missing API key.'", withStatus(401, "Missing API key.")],
			["Zen 'Model x is not supported'", withStatus(401, "Model x is not supported")],
			["401 wrong key", withStatus(401, "Incorrect API key provided")],
			["403 forbidden", withStatus(403, "Forbidden")],
			["404 unknown model", withStatus(404, "The model does not exist")],
			["400 invalid tool schema", withStatus(400, "Invalid schema for tool")],
			["501 not implemented", withStatus(501, "Not Implemented")],
		];

		for (const [label, err] of PERMANENT) {
			it(`does not retry: ${label}`, () => expect(isTransientError(err)).toBe(false));
		}

		it("ignores a non-numeric status rather than coercing it", () => {
			expect(isTransientError(Object.assign(new Error("API error"), { status: "429" }))).toBe(false);
		});

		// Mid-stream gateway deaths carry no status code — the HTTP response was
		// already a success when the stream started. opencode Zen's own text for
		// this is a known free-tier issue (anomalyco/opencode#38024/#35397/#37638);
		// it reached a user here with no status, no retry and no log entry.
		it("retries a gateway that died mid-stream, despite having no status", () => {
			expect(isTransientError(new Error("Streaming response failed"))).toBe(true);
			expect(isTransientError(new Error("Provider returned error"))).toBe(true);
		});

		it("matches those case-insensitively", () => {
			expect(isTransientError(new Error("STREAMING RESPONSE FAILED"))).toBe(true);
		});

		it("does not treat an unrelated 'failed' message as transient", () => {
			// The stream-failure rule is two specific phrases, not "contains failed".
			expect(isTransientError(new Error("Tool execution failed"))).toBe(false);
			expect(isTransientError(new Error("Validation failed for parameter x"))).toBe(false);
		});
	});

	// -------------------------------------------------------------------
	// Parity with the AI SDK's own retry rule.
	//
	// Both streamText call sites pass `maxRetries: 0`, so the SDK performs no
	// retries and this classifier is the only retry authority. Every status
	// the SDK WOULD have retried must therefore still be retried here, or
	// disabling its retries silently loses coverage.
	//
	// The SDK rule is APICallError's isRetryable default in @ai-sdk/provider:
	//   statusCode === 408 || 409 || 429 || statusCode >= 500
	// -------------------------------------------------------------------
	describe("parity with the AI SDK retry rule", () => {
		const sdkWouldRetry = (s: number) => s === 408 || s === 409 || s === 429 || s >= 500;
		const weRetry = (s: number) => isTransientError(Object.assign(new Error("API error"), { statusCode: s }));

		it("retries every status the SDK would have retried, except 501", () => {
			const dropped: number[] = [];
			for (let s = 100; s <= 599; s++) {
				if (sdkWouldRetry(s) && !weRetry(s)) dropped.push(s);
			}
			// 501 Not Implemented is the one deliberate divergence — see
			// RETRY_STATUS_EXCLUDED_5XX. Anything else here is lost coverage.
			expect(dropped).toEqual([RETRY_STATUS_EXCLUDED_5XX]);
		});

		it("adds nothing beyond the SDK rule at the status level", () => {
			// Message-based rules (e.g. "no provider available" on a 401) are
			// intentionally broader; this checks the STATUS rule only, so an
			// accidental `status >= 400` can never creep in.
			const extra: number[] = [];
			for (let s = 100; s <= 599; s++) {
				if (!sdkWouldRetry(s) && weRetry(s)) extra.push(s);
			}
			expect(extra).toEqual([]);
		});

		it("covers the specific codes that were being dropped before", () => {
			// Each of these ended an agent run outright under the old 429/503 list.
			for (const s of [500, 502, 504, 520, 524, 527, 529, 408, 409]) {
				expect(weRetry(s)).toBe(true);
			}
		});
	});
});

// ---------------------------------------------------------------------------
// loadSafetyConfig
// ---------------------------------------------------------------------------

describe("loadSafetyConfig", () => {
	it("returns a copy of DEFAULT_CONFIG when no overrides are provided", () => {
		const config = loadSafetyConfig();
		expect(config).toEqual(DEFAULT_CONFIG);
	});

	it("merges overrides with defaults", () => {
		const config = loadSafetyConfig({ loopThreshold: 5, maxRetries: 1 });
		expect(config.loopThreshold).toBe(5);
		expect(config.maxRetries).toBe(1);
		// Non-overridden fields keep defaults
		expect(config.actionTimeoutMs).toBe(DEFAULT_CONFIG.actionTimeoutMs);
		expect(config.enabled).toBe(DEFAULT_CONFIG.enabled);
	});

	it("does not mutate DEFAULT_CONFIG", () => {
		const originalThreshold = DEFAULT_CONFIG.loopThreshold;
		loadSafetyConfig({ loopThreshold: 999 });
		expect(DEFAULT_CONFIG.loopThreshold).toBe(originalThreshold);
	});

	it("can disable safety by overriding enabled: false", () => {
		const config = loadSafetyConfig({ enabled: false });
		expect(config.enabled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// createActionTimeout
// ---------------------------------------------------------------------------

describe("createActionTimeout", () => {
	it("returns an AbortSignal and a clear function", () => {
		const { signal, clear } = createActionTimeout({ actionTimeoutMs: 60_000 });
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(typeof clear).toBe("function");
		clear();
	});

	it("signal is not aborted initially", () => {
		const { signal, clear } = createActionTimeout({ actionTimeoutMs: 60_000 });
		expect(signal.aborted).toBe(false);
		clear();
	});

	it("clears the timeout without aborting the signal", () => {
		const { signal, clear } = createActionTimeout({ actionTimeoutMs: 60_000 });
		clear();
		expect(signal.aborted).toBe(false);
	});

	it("aborts the signal after the timeout elapses", async () => {
		const { signal } = createActionTimeout({ actionTimeoutMs: 30 });
		await new Promise((r) => setTimeout(r, 80));
		expect(signal.aborted).toBe(true);
	});
});
