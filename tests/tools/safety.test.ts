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
	it("returns 1000ms for attempt 0", () => {
		expect(getBackoffDelay(0)).toBe(1000);
	});

	it("returns 2000ms for attempt 1", () => {
		expect(getBackoffDelay(1)).toBe(2000);
	});

	it("returns 4000ms for attempt 2", () => {
		expect(getBackoffDelay(2)).toBe(4000);
	});

	it("caps at 30_000ms", () => {
		expect(getBackoffDelay(10)).toBe(30_000);
		expect(getBackoffDelay(100)).toBe(30_000);
	});

	it("delay increases exponentially up to the cap", () => {
		for (let i = 1; i <= 4; i++) {
			expect(getBackoffDelay(i)).toBeGreaterThan(getBackoffDelay(i - 1));
		}
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
