/**
 * system.test.ts
 *
 * Tests for system tools: environment_info, get_env, sleep.
 *
 * These tools have no external AI/DB dependencies — they read from the
 * process environment and system APIs. The electrobun/bun module is mocked
 * only where get_agentdesk_paths uses it.
 *
 * Key security concern: get_env must block variables whose names match
 * secret patterns (key, token, secret, password, etc.).
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-system" } },
}));

// Import the tool registry after mocks.
const { systemTools } = await import("../../src/bun/agents/tools/system");

// ---------------------------------------------------------------------------
// Helper: execute a tool by name
// ---------------------------------------------------------------------------

async function execTool(name: keyof typeof systemTools, args: Record<string, unknown> = {}): Promise<unknown> {
	const entry = systemTools[name];
	if (!entry) throw new Error(`Unknown tool: ${name}`);
	// The Vercel AI SDK tool wraps execute — call it directly
	const result = await (entry.tool as { execute: (args: unknown, ctx: unknown) => Promise<string> })
		.execute(args, { abortSignal: undefined });
	return JSON.parse(result as string);
}

// ---------------------------------------------------------------------------
// environment_info
// ---------------------------------------------------------------------------

describe("environment_info", () => {
	it("returns an object with 'os', 'runtime', 'process', 'paths' keys", async () => {
		const result = await execTool("environment_info") as Record<string, unknown>;
		expect(result).toHaveProperty("os");
		expect(result).toHaveProperty("runtime");
		expect(result).toHaveProperty("process");
		expect(result).toHaveProperty("paths");
	});

	it("includes platform in the 'os' section", async () => {
		const result = await execTool("environment_info") as { os: { platform: string } };
		expect(typeof result.os.platform).toBe("string");
		expect(result.os.platform.length).toBeGreaterThan(0);
	});

	it("includes Bun version in 'runtime'", async () => {
		const result = await execTool("environment_info") as { runtime: { bun: string } };
		expect(typeof result.runtime.bun).toBe("string");
		// Bun version should be semver-like (digits and dots)
		expect(/^\d+\.\d+/.test(result.runtime.bun)).toBe(true);
	});

	it("includes a numeric 'cpus' count", async () => {
		const result = await execTool("environment_info") as { os: { cpus: number } };
		expect(typeof result.os.cpus).toBe("number");
		expect(result.os.cpus).toBeGreaterThanOrEqual(1);
	});

	it("includes 'cwd' in the process section", async () => {
		const result = await execTool("environment_info") as { process: { cwd: string } };
		expect(typeof result.process.cwd).toBe("string");
		expect(result.process.cwd.length).toBeGreaterThan(0);
	});

	it("includes 'home' in paths", async () => {
		const result = await execTool("environment_info") as { paths: { home: string } };
		expect(typeof result.paths.home).toBe("string");
	});

	it("does not include any key matching secret patterns in 'env'", async () => {
		const result = await execTool("environment_info") as { env: Record<string, string> };
		if (!result.env) return; // env section may be absent if no safe vars are set
		const keys = Object.keys(result.env);
		const secretPattern = /key|token|secret|password|credential|auth|private|apikey|api_key/i;
		for (const key of keys) {
			expect(secretPattern.test(key)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// get_env — secret blocking
// ---------------------------------------------------------------------------

describe("get_env — secret blocking", () => {
	it("blocks variables whose names contain 'key'", async () => {
		const result = await execTool("get_env", { names: ["API_KEY"] }) as { blocked?: string[]; values?: Record<string, string | null> };
		expect(result.blocked).toContain("API_KEY");
		expect(result.values?.["API_KEY"]).toBeUndefined();
	});

	it("blocks variables whose names contain 'token'", async () => {
		const result = await execTool("get_env", { names: ["GITHUB_TOKEN"] }) as { blocked?: string[] };
		expect(result.blocked).toContain("GITHUB_TOKEN");
	});

	it("blocks variables whose names contain 'secret'", async () => {
		const result = await execTool("get_env", { names: ["CLIENT_SECRET"] }) as { blocked?: string[] };
		expect(result.blocked).toContain("CLIENT_SECRET");
	});

	it("blocks variables whose names contain 'password'", async () => {
		const result = await execTool("get_env", { names: ["DB_PASSWORD"] }) as { blocked?: string[] };
		expect(result.blocked).toContain("DB_PASSWORD");
	});

	it("blocks variables whose names contain 'credential'", async () => {
		const result = await execTool("get_env", { names: ["AWS_CREDENTIALS"] }) as { blocked?: string[] };
		expect(result.blocked).toContain("AWS_CREDENTIALS");
	});

	it("blocks 'private' in variable name", async () => {
		const result = await execTool("get_env", { names: ["PRIVATE_KEY"] }) as { blocked?: string[] };
		expect(result.blocked).toContain("PRIVATE_KEY");
	});

	it("is case-insensitive for secret pattern matching", async () => {
		const result = await execTool("get_env", { names: ["my_api_key", "MY_TOKEN"] }) as { blocked?: string[] };
		expect(result.blocked).toContain("my_api_key");
		expect(result.blocked).toContain("MY_TOKEN");
	});

	it("does NOT block variables with safe names like 'HOME' or 'PATH'", async () => {
		const result = await execTool("get_env", { names: ["HOME", "PATH"] }) as {
			values?: Record<string, string | null>;
			blocked?: string[];
		};
		// These should appear in 'values', not 'blocked'
		expect(result.values).toBeDefined();
		expect(result.blocked ?? []).not.toContain("HOME");
		expect(result.blocked ?? []).not.toContain("PATH");
	});

	it("returns the value of a safe variable when it is set", async () => {
		// NODE_ENV is a safe env var that is often set in test environments
		const result = await execTool("get_env", { names: ["NODE_ENV"] }) as {
			values?: Record<string, string | null>;
		};
		expect(result.values).toBeDefined();
		// Value may be null if not set, but the key should be present
		expect("NODE_ENV" in (result.values ?? {})).toBe(true);
	});

	it("returns null for a safe variable that is not set", async () => {
		const result = await execTool("get_env", {
			names: ["__AGENTDESK_DEFINITELY_UNSET_VAR__"],
		}) as { values?: Record<string, string | null> };
		expect(result.values?.["__AGENTDESK_DEFINITELY_UNSET_VAR__"]).toBeNull();
	});

	it("handles a mix of blocked and safe variables in a single call", async () => {
		const result = await execTool("get_env", {
			names: ["HOME", "API_KEY", "PATH", "GITHUB_TOKEN"],
		}) as { values?: Record<string, string | null>; blocked?: string[] };

		// Safe vars should be in values
		expect("HOME" in (result.values ?? {})).toBe(true);
		expect("PATH" in (result.values ?? {})).toBe(true);

		// Secret vars should be in blocked
		expect((result.blocked ?? []).includes("API_KEY")).toBe(true);
		expect((result.blocked ?? []).includes("GITHUB_TOKEN")).toBe(true);

		// Secret vars should NOT appear in values
		expect((result.values ?? {})["API_KEY"]).toBeUndefined();
	});

	it("returns 'reason' alongside 'blocked' list", async () => {
		const result = await execTool("get_env", { names: ["MY_SECRET"] }) as {
			blocked?: string[];
			reason?: string;
		};
		expect(result.reason).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe("sleep", () => {
	it("sleeps for approximately the requested duration", async () => {
		const start = Date.now();
		const result = await execTool("sleep", { ms: 50 }) as { slept: number; requestedMs: number };
		const elapsed = Date.now() - start;

		// Should have slept at least 40ms (allow for timer imprecision)
		expect(elapsed).toBeGreaterThanOrEqual(40);
		expect(result.requestedMs).toBe(50);
	});

	it("caps sleep at 30 000ms", async () => {
		// We pass a huge value but it should be capped.
		// We cannot actually wait 30s, so we verify via the return value.
		const abortController = new AbortController();
		setTimeout(() => abortController.abort(), 100); // abort after 100ms

		const tool = systemTools["sleep"].tool as {
			execute: (args: unknown, ctx: { abortSignal: AbortSignal }) => Promise<string>;
		};
		const raw = await tool.execute({ ms: 999_999_999 }, { abortSignal: abortController.signal });
		const result = JSON.parse(raw) as { cappedAt: number | null; wokenEarly: boolean };

		expect(result.cappedAt).toBe(30_000);
		expect(result.wokenEarly).toBe(true);
	});

	it("returns wokenEarly:true when the signal is aborted shortly after execution starts", async () => {
		const abortController = new AbortController();
		// Abort after a short delay so the sleep tool has time to register its listener
		setTimeout(() => abortController.abort(), 50);

		const tool = systemTools["sleep"].tool as {
			execute: (args: unknown, ctx: { abortSignal: AbortSignal }) => Promise<string>;
		};
		const raw = await tool.execute({ ms: 5_000 }, { abortSignal: abortController.signal });
		const result = JSON.parse(raw) as { wokenEarly: boolean; slept: number };

		expect(result.wokenEarly).toBe(true);
	});

	it("includes cappedAt:null when ms is within the 30s limit", async () => {
		const result = await execTool("sleep", { ms: 50 }) as { cappedAt: number | null };
		expect(result.cappedAt).toBeNull();
	});
});
