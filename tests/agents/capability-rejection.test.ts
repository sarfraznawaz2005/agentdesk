import { describe, expect, it } from "bun:test";
import { APICallError } from "ai";
// Import from capability-errors (the real source) rather than engine-types,
// which agent-loop.test.ts mock.module()'s wholesale — Bun module mocks leak
// process-wide and would otherwise stub these to () => false here.
import { isThinkingUnsupportedError, isToolsUnsupportedError } from "../../src/bun/agents/capability-errors";

// Build an APICallError shaped like a real provider 400. For OpenAI-compatible
// providers (e.g. Mistral) the top-level message is just the HTTP status and
// the real reason lives only in the JSON responseBody.
function apiError(message: string, responseBody?: string): APICallError {
	return new APICallError({
		message,
		url: "https://example.test/v1/chat/completions",
		requestBodyValues: {},
		statusCode: 400,
		responseBody,
		isRetryable: false,
	});
}

const mistralReasoningBody = JSON.stringify({
	object: "error",
	message: "reasoning_effort is not enabled for this model",
	type: "invalid_request_invalid_args",
	param: null,
	code: "3051",
	raw_status_code: 400,
});

describe("isThinkingUnsupportedError", () => {
	it("matches Mistral's reasoning_effort rejection carried only in responseBody", () => {
		expect(isThinkingUnsupportedError(apiError("Bad Request", mistralReasoningBody))).toBe(true);
	});

	it("matches Ollama-style rejection carried in the message", () => {
		expect(isThinkingUnsupportedError(apiError('"gemma3:1b" does not support thinking'))).toBe(true);
	});

	it("ignores an unrelated 400 (e.g. bad API key)", () => {
		expect(isThinkingUnsupportedError(apiError("Bad Request", '{"message":"invalid api key"}'))).toBe(false);
	});

	it("ignores errors that aren't APICallError", () => {
		expect(isThinkingUnsupportedError(new Error("reasoning is not enabled"))).toBe(false);
	});
});

describe("isToolsUnsupportedError", () => {
	it("matches a tools rejection carried only in responseBody", () => {
		const body = JSON.stringify({ message: "tools is not enabled for this model" });
		expect(isToolsUnsupportedError(apiError("Bad Request", body))).toBe(true);
	});

	it("matches Ollama-style tools rejection in the message", () => {
		expect(isToolsUnsupportedError(apiError('"gemma3:1b" does not support tools'))).toBe(true);
	});

	it("ignores an unrelated 400", () => {
		expect(isToolsUnsupportedError(apiError("Bad Request", '{"message":"invalid api key"}'))).toBe(false);
	});
});
