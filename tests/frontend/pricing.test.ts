/**
 * pricing.test.ts
 *
 * Tests for the client-side cost estimation helpers:
 *   - estimateCost  — USD cost from token counts + model ID
 *   - formatCost    — human-readable cost string
 *
 * These are pure functions with no external dependencies.
 */

import { describe, it, expect } from "bun:test";

const { estimateCost, formatCost } = await import("../../src/mainview/lib/pricing");

// ---------------------------------------------------------------------------
// estimateCost — Anthropic models
// ---------------------------------------------------------------------------

describe("estimateCost — Anthropic Claude models", () => {
	it("calculates cost for claude-3-5-sonnet at $3/$15 per MTok", () => {
		// 1M input + 1M output = $3 + $15 = $18
		const cost = estimateCost(1_000_000, 1_000_000, "claude-3-5-sonnet-20241022");
		expect(cost).toBeCloseTo(18, 4);
	});

	it("calculates cost for claude-3-haiku at $0.25/$1.25 per MTok", () => {
		// 1M input + 1M output = $0.25 + $1.25 = $1.50
		const cost = estimateCost(1_000_000, 1_000_000, "claude-3-haiku-20240307");
		expect(cost).toBeCloseTo(1.5, 4);
	});

	it("calculates cost for claude-3-opus at $15/$75 per MTok", () => {
		const cost = estimateCost(1_000_000, 1_000_000, "claude-3-opus-20240229");
		expect(cost).toBeCloseTo(90, 4);
	});

	it("calculates cost for claude-sonnet-4 at $3/$15 per MTok", () => {
		const cost = estimateCost(1_000_000, 1_000_000, "claude-sonnet-4-20250514");
		expect(cost).toBeCloseTo(18, 4);
	});

	it("calculates cost for claude-opus-4 at $15/$75 per MTok", () => {
		const cost = estimateCost(1_000_000, 1_000_000, "claude-opus-4-20250514");
		expect(cost).toBeCloseTo(90, 4);
	});

	it("calculates cost for claude-haiku-3-5 at $0.80/$4 per MTok", () => {
		const cost = estimateCost(1_000_000, 1_000_000, "claude-haiku-3-5-20241022");
		expect(cost).toBeCloseTo(4.8, 4);
	});
});

// ---------------------------------------------------------------------------
// estimateCost — OpenAI models
// ---------------------------------------------------------------------------

describe("estimateCost — OpenAI models", () => {
	it("calculates cost for gpt-4o at $2.50/$10 per MTok", () => {
		const cost = estimateCost(1_000_000, 1_000_000, "gpt-4o");
		expect(cost).toBeCloseTo(12.5, 4);
	});

	it("calculates cost for gpt-4o-mini at $0.15/$0.60 per MTok", () => {
		const cost = estimateCost(1_000_000, 1_000_000, "gpt-4o-mini");
		expect(cost).toBeCloseTo(0.75, 4);
	});

	it("calculates cost for gpt-4-turbo at $10/$30 per MTok", () => {
		const cost = estimateCost(1_000_000, 1_000_000, "gpt-4-turbo-2024-04-09");
		expect(cost).toBeCloseTo(40, 4);
	});

	it("calculates cost for o1 at $15/$60 per MTok", () => {
		const cost = estimateCost(1_000_000, 1_000_000, "o1-2024-12-17");
		expect(cost).toBeCloseTo(75, 4);
	});
});

// ---------------------------------------------------------------------------
// estimateCost — default fallback
// ---------------------------------------------------------------------------

describe("estimateCost — default fallback", () => {
	it("falls back to $3/$15 per MTok for an unknown model", () => {
		const cost = estimateCost(1_000_000, 1_000_000, "some-unknown-model-xyz");
		// Default price: $3 input + $15 output = $18
		expect(cost).toBeCloseTo(18, 4);
	});

	it("falls back to default pricing when modelId is undefined", () => {
		const cost = estimateCost(1_000_000, 1_000_000, undefined);
		expect(cost).toBeCloseTo(18, 4);
	});

	it("uses default when model id is an empty string", () => {
		const cost = estimateCost(1_000_000, 1_000_000, "");
		expect(cost).toBeCloseTo(18, 4);
	});
});

// ---------------------------------------------------------------------------
// estimateCost — proportional scaling
// ---------------------------------------------------------------------------

describe("estimateCost — token proportionality", () => {
	it("scales linearly with token count", () => {
		const model = "claude-3-5-sonnet-20241022";
		const half = estimateCost(500_000, 500_000, model);
		const full = estimateCost(1_000_000, 1_000_000, model);
		expect(full).toBeCloseTo(half * 2, 6);
	});

	it("returns 0 for 0 tokens", () => {
		expect(estimateCost(0, 0, "gpt-4o")).toBe(0);
	});

	it("accounts for input and output tokens separately", () => {
		const model = "gpt-4o-mini"; // $0.15 in, $0.60 out per MTok
		const inputOnly = estimateCost(1_000_000, 0, model);
		const outputOnly = estimateCost(0, 1_000_000, model);
		expect(inputOnly).toBeCloseTo(0.15, 4);
		expect(outputOnly).toBeCloseTo(0.60, 4);
		// Together they should sum correctly
		expect(inputOnly + outputOnly).toBeCloseTo(0.75, 4);
	});
});

// ---------------------------------------------------------------------------
// estimateCost — model substring matching
// ---------------------------------------------------------------------------

describe("estimateCost — model substring matching", () => {
	it("matches gpt-4o-mini before gpt-4o (more-specific-first ordering)", () => {
		// gpt-4o-mini should NOT match gpt-4o pricing ($2.50 in)
		const miniCost = estimateCost(1_000_000, 0, "gpt-4o-mini-2024-07-18");
		const fullCost = estimateCost(1_000_000, 0, "gpt-4o-2024-11-20");
		// mini: $0.15, full: $2.50
		expect(miniCost).toBeCloseTo(0.15, 4);
		expect(fullCost).toBeCloseTo(2.50, 4);
	});

	it("matches partial model IDs with version suffixes", () => {
		// claude-3-5-sonnet with an additional version string should still match
		const cost = estimateCost(1_000_000, 0, "claude-3-5-sonnet-20241022");
		expect(cost).toBeCloseTo(3, 4);
	});
});

// ---------------------------------------------------------------------------
// formatCost
// ---------------------------------------------------------------------------

describe("formatCost — zero and negative values", () => {
	it("returns '$0.00' for zero cost", () => {
		expect(formatCost(0)).toBe("$0.00");
	});

	it("returns '$0.00' for negative cost (should not happen but handled)", () => {
		expect(formatCost(-1)).toBe("$0.00");
	});
});

describe("formatCost — sub-cent amounts", () => {
	it("returns '<$0.01' for amounts between 0 and 0.01", () => {
		expect(formatCost(0.001)).toBe("<$0.01");
		expect(formatCost(0.005)).toBe("<$0.01");
		expect(formatCost(0.0099)).toBe("<$0.01");
	});
});

describe("formatCost — cent-level amounts (< $1)", () => {
	it("returns '$X.XXX' (3 decimal places) for amounts < $1", () => {
		expect(formatCost(0.01)).toBe("$0.010");
		expect(formatCost(0.5)).toBe("$0.500");
		expect(formatCost(0.75)).toBe("$0.750");
	});
});

describe("formatCost — dollar amounts (>= $1)", () => {
	it("returns '$X.XX' (2 decimal places) for amounts >= $1", () => {
		expect(formatCost(1)).toBe("$1.00");
		expect(formatCost(1.5)).toBe("$1.50");
		expect(formatCost(18)).toBe("$18.00");
		expect(formatCost(100.99)).toBe("$100.99");
	});

	it("rounds to 2 decimal places for dollar amounts", () => {
		expect(formatCost(1.999)).toBe("$2.00");
		expect(formatCost(10.004)).toBe("$10.00");
	});
});

describe("formatCost — boundary at $0.01", () => {
	it("formats $0.01 as '$0.010' (3 decimal places, not '<$0.01')", () => {
		// 0.01 is NOT less than 0.01 so it should use the $X.XXX branch
		expect(formatCost(0.01)).not.toBe("<$0.01");
		expect(formatCost(0.01)).toBe("$0.010");
	});
});
