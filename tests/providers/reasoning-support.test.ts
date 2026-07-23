/**
 * reasoning-support.test.ts
 *
 * Every agent thinks at Medium by default, so `reasoning_effort` goes out on
 * every call. Mistral's devstral-latest, codestral-latest and
 * mistral-large-latest all reject it outright:
 *
 *   400 {"message":"reasoning_effort is not enabled for this model","code":"3051"}
 *
 * Verified live: 100% failure with the option, 100% success without it. Both
 * agent loops already stripped it and retried, but nothing remembered — so
 * EVERY run against such a model burned a doomed request first. This memo is
 * what turns that into one failure rather than one per run.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
	reasoningKey,
	isReasoningUnsupported,
	markReasoningUnsupported,
	resetReasoningSupport,
} from "../../src/bun/providers/reasoning-support";

const PROVIDER = "provider-uuid-1";
const OTHER_PROVIDER = "provider-uuid-2";

beforeEach(() => resetReasoningSupport());

describe("reasoning-support memo", () => {
	it("reports nothing unsupported before anything is recorded", () => {
		expect(isReasoningUnsupported(PROVIDER, "codestral-latest")).toBe(false);
	});

	it("remembers a rejection for that provider+model", () => {
		markReasoningUnsupported(PROVIDER, "codestral-latest");
		expect(isReasoningUnsupported(PROVIDER, "codestral-latest")).toBe(true);
	});

	it("scopes the memo per model", () => {
		// mistral-large rejects it too, but that must be discovered, not assumed —
		// a sibling model's rejection says nothing about this one.
		markReasoningUnsupported(PROVIDER, "codestral-latest");
		expect(isReasoningUnsupported(PROVIDER, "mistral-large-latest")).toBe(false);
	});

	it("scopes the memo per provider", () => {
		// The same model id behind a different provider (a proxy, a second key,
		// a gateway) may well support reasoning.
		markReasoningUnsupported(PROVIDER, "codestral-latest");
		expect(isReasoningUnsupported(OTHER_PROVIDER, "codestral-latest")).toBe(false);
	});

	it("is idempotent", () => {
		markReasoningUnsupported(PROVIDER, "codestral-latest");
		markReasoningUnsupported(PROVIDER, "codestral-latest");
		expect(isReasoningUnsupported(PROVIDER, "codestral-latest")).toBe(true);
	});

	it("keys on provider id, not a user-editable name", () => {
		// Provider names are renameable in Settings; a rename must not silently
		// discard the memo, nor two providers sharing a name collide.
		expect(reasoningKey(PROVIDER, "m")).not.toBe(reasoningKey(OTHER_PROVIDER, "m"));
		expect(reasoningKey(PROVIDER, "m")).toBe(reasoningKey(PROVIDER, "m"));
	});

	it("resets cleanly, so the memo cannot leak between tests", () => {
		markReasoningUnsupported(PROVIDER, "codestral-latest");
		resetReasoningSupport();
		expect(isReasoningUnsupported(PROVIDER, "codestral-latest")).toBe(false);
	});
});
