import { describe, it, expect } from "bun:test";
import { isReviewerToolset } from "../../src/shared/agent-capabilities";

describe("isReviewerToolset", () => {
	it("is true for the code-reviewer grant shape (submit_review, no verify_implementation)", () => {
		expect(isReviewerToolset(["update_task", "move_task", "check_criteria", "list_tasks", "get_task", "submit_review"])).toBe(true);
	});
	it("is false for the implementer grant shape (has verify_implementation)", () => {
		expect(isReviewerToolset(["update_task", "move_task", "check_criteria", "list_tasks", "get_task", "submit_review", "verify_implementation"])).toBe(false);
	});
	it("is false for a read-only agent with no board-write tools", () => {
		expect(isReviewerToolset(["list_tasks", "get_task"])).toBe(false);
	});
	it("accepts a Set as well as an array", () => {
		expect(isReviewerToolset(new Set(["submit_review"]))).toBe(true);
	});
});
