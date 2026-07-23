/**
 * provider-error-log.test.ts
 *
 * provider_errors.log is a plain-text file a user may attach to a bug report,
 * so the two things that matter are that it captures enough to diagnose an
 * outage and that it never captures a credential.
 *
 * Written after opencode.ai/zen started returning HTTP 500 to the Freelance
 * auto-shortlist job: the only trace was a raw AI SDK stack on the dev console,
 * invisible in production and easily mistaken for an application bug.
 */

import { describe, it, expect } from "bun:test";
import { APICallError, RetryError } from "ai";
import { describeProviderError, withProviderErrorLogging } from "../../src/bun/providers/error-log";

/** The exact shape opencode.ai/zen returned. */
function zen500(): APICallError {
	return new APICallError({
		message: "Internal server error",
		url: "https://opencode.ai/zen/v1/chat/completions",
		requestBodyValues: { messages: [{ role: "user", content: "a private prompt" }] },
		statusCode: 500,
		responseHeaders: { authorization: "Bearer sk-live-do-not-log-me" },
		responseBody: '{"type":"error","error":{"type":"error","message":"Internal server error"}}',
		isRetryable: true,
	});
}

describe("describeProviderError", () => {
	it("extracts the diagnostic fields from an APICallError", () => {
		expect(describeProviderError(zen500())).toEqual({
			kind: "api",
			message: "Internal server error",
			url: "https://opencode.ai/zen/v1/chat/completions",
			statusCode: 500,
			isRetryable: true,
			responseBody: '{"type":"error","error":{"type":"error","message":"Internal server error"}}',
		});
	});

	it("unwraps a RetryError to its last cause and records the attempt count", () => {
		const facts = describeProviderError(
			new RetryError({
				message: "Failed after 3 attempts",
				reason: "maxRetriesExceeded",
				errors: [zen500(), zen500(), zen500()],
			}),
		);
		expect(facts.kind).toBe("retry");
		expect(facts.attempts).toBe(3);
		// The useful detail must survive the unwrap, not be replaced by the
		// generic "Failed after N attempts" wrapper message.
		expect(facts.statusCode).toBe(500);
		expect(facts.url).toBe("https://opencode.ai/zen/v1/chat/completions");
	});

	it("degrades to a plain message for a non-SDK error", () => {
		expect(describeProviderError(new Error("socket hang up")))
			.toEqual({ kind: "other", message: "socket hang up" });
		expect(describeProviderError("boom")).toEqual({ kind: "other", message: "boom" });
	});

	it("passes mid-stream chunks through untouched", async () => {
		// doStream()'s promise resolves when the connection OPENS, so a provider
		// that dies partway through emits an `error` PART instead of rejecting —
		// invisible to the caller's catch. That is how opencode Zen's
		// "Streaming response failed" reached a user with no log entry at all.
		// The observer must see it without altering the stream in any way.
		const parts = [
			{ type: "text-delta", text: "hello " },
			{ type: "error", error: new Error("Streaming response failed") },
			{ type: "text-delta", text: "world" },
		];
		const model = {
			doGenerate: async () => ({}),
			doStream: async () => ({
				stream: new ReadableStream({
					start(c) { for (const p of parts) c.enqueue(p); c.close(); },
				}),
				extra: "preserved",
			}),
		};

		const wrapped = withProviderErrorLogging(model as never, {
			providerType: "opencode", providerName: "Free", modelId: "deepseek-v4-flash-free", phase: "stream",
		}) as unknown as { doStream: () => Promise<{ stream: ReadableStream; extra: string }> };

		const out = await wrapped.doStream();
		expect(out.extra).toBe("preserved"); // other result fields survive the wrap

		const received: unknown[] = [];
		for await (const chunk of out.stream as unknown as AsyncIterable<unknown>) received.push(chunk);
		expect(received).toEqual(parts); // same parts, same order, nothing swallowed
	});

	it("never surfaces request headers or the request body", () => {
		// Those carry the bearer token and the full conversation respectively.
		const facts = describeProviderError(zen500()) as Record<string, unknown>;
		expect(Object.keys(facts).sort()).toEqual(
			["isRetryable", "kind", "message", "responseBody", "statusCode", "url"],
		);
		expect(JSON.stringify(facts)).not.toContain("sk-live-do-not-log-me");
		expect(JSON.stringify(facts)).not.toContain("a private prompt");
	});
});
