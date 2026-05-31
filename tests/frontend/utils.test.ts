/**
 * utils.test.ts
 *
 * Tests for src/mainview/lib/utils.ts:
 *   - cn()              — Tailwind class merging via clsx + tailwind-merge
 *   - displayAgentName() — converts internal agent name strings to display labels
 *
 * No mocks needed — these are pure functions with no external side-effects.
 */

import { describe, it, expect } from "bun:test";
import { cn, displayAgentName } from "../../src/mainview/lib/utils";

// ---------------------------------------------------------------------------
// cn — Tailwind class merging
// ---------------------------------------------------------------------------

describe("cn", () => {
	it("returns a single class unchanged", () => {
		expect(cn("text-red-500")).toBe("text-red-500");
	});

	it("merges multiple classes", () => {
		const result = cn("flex", "items-center", "gap-2");
		expect(result).toContain("flex");
		expect(result).toContain("items-center");
		expect(result).toContain("gap-2");
	});

	it("returns an empty string when called with no arguments", () => {
		expect(cn()).toBe("");
	});

	it("ignores falsy values (undefined, null, false, empty string)", () => {
		const result = cn("text-sm", undefined, null, false, "", "font-bold");
		expect(result).toContain("text-sm");
		expect(result).toContain("font-bold");
		// No extra whitespace from falsy values
		expect(result).not.toMatch(/\s{2,}/);
	});

	it("resolves Tailwind conflicts — later class wins", () => {
		// tailwind-merge should keep 'text-blue-500' and remove 'text-red-500'
		const result = cn("text-red-500", "text-blue-500");
		expect(result).toContain("text-blue-500");
		expect(result).not.toContain("text-red-500");
	});

	it("resolves padding conflicts — later class wins", () => {
		const result = cn("p-2", "p-4");
		expect(result).toContain("p-4");
		expect(result).not.toContain("p-2");
	});

	it("handles conditional class objects", () => {
		const isActive = true;
		const result = cn("base-class", { "active-class": isActive, "inactive-class": !isActive });
		expect(result).toContain("active-class");
		expect(result).not.toContain("inactive-class");
	});

	it("handles an array of classes", () => {
		const result = cn(["flex", "gap-2"], "p-4");
		expect(result).toContain("flex");
		expect(result).toContain("gap-2");
		expect(result).toContain("p-4");
	});

	it("does not duplicate identical class names", () => {
		const result = cn("flex", "flex");
		const parts = result.trim().split(/\s+/);
		const flexCount = parts.filter((p) => p === "flex").length;
		expect(flexCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// displayAgentName
// ---------------------------------------------------------------------------

describe("displayAgentName — standard names", () => {
	it("capitalises the first letter of each word (hyphen-separated)", () => {
		expect(displayAgentName("backend-engineer")).toBe("Backend Engineer");
	});

	it("capitalises the first letter of each word (underscore-separated)", () => {
		expect(displayAgentName("frontend_engineer")).toBe("Frontend Engineer");
	});

	it("handles a single-word agent name", () => {
		expect(displayAgentName("orchestrator")).toBe("Orchestrator");
	});

	it("converts 'project-manager' correctly", () => {
		expect(displayAgentName("project-manager")).toBe("Project Manager");
	});

	it("converts 'code-reviewer' correctly", () => {
		expect(displayAgentName("code-reviewer")).toBe("Code Reviewer");
	});

	it("converts 'qa-engineer' correctly", () => {
		expect(displayAgentName("qa-engineer")).toBe("Qa Engineer");
	});

	it("converts 'devops-engineer' correctly", () => {
		expect(displayAgentName("devops-engineer")).toBe("Devops Engineer");
	});

	it("converts 'ui-ux-designer' correctly", () => {
		expect(displayAgentName("ui-ux-designer")).toBe("Ui Ux Designer");
	});

	it("converts 'software-architect' correctly", () => {
		expect(displayAgentName("software-architect")).toBe("Software Architect");
	});

	it("converts 'code-explorer' correctly", () => {
		expect(displayAgentName("code-explorer")).toBe("Code Explorer");
	});

	it("converts 'task-planner' correctly", () => {
		expect(displayAgentName("task-planner")).toBe("Task Planner");
	});
});

describe("displayAgentName — concurrent agent suffixes (#N)", () => {
	it("appends the branch number as a space-separated suffix", () => {
		expect(displayAgentName("frontend_engineer#2")).toBe("Frontend Engineer 2");
	});

	it("handles '#3' suffix", () => {
		expect(displayAgentName("backend-engineer#3")).toBe("Backend Engineer 3");
	});

	it("handles '#10' suffix", () => {
		expect(displayAgentName("code-reviewer#10")).toBe("Code Reviewer 10");
	});

	it("does not include the '#' character in the output", () => {
		const result = displayAgentName("qa-engineer#2");
		expect(result).not.toContain("#");
	});

	it("treats '#1' as a valid suffix", () => {
		expect(displayAgentName("frontend_engineer#1")).toBe("Frontend Engineer 1");
	});
});

describe("displayAgentName — edge cases", () => {
	it("handles an empty string without crashing", () => {
		expect(() => displayAgentName("")).not.toThrow();
	});

	it("handles a name with mixed separators (hyphen + underscore)", () => {
		// Both '-' and '_' are treated as word separators
		const result = displayAgentName("my-agent_name");
		expect(result).toBe("My Agent Name");
	});

	it("preserves already-capitalised names (maps each word)", () => {
		// displayAgentName lowercases then capitalises — but since it just does
		// charAt(0).toUpperCase() + slice(1), an already-upper word stays correct.
		const result = displayAgentName("backend-engineer");
		expect(result[0]).toBe("B");
	});
});
