/**
 * agent-routing.test.ts
 *
 * The PM's routing table is only useful if it describes the roster that
 * actually exists. These lock the ways it can silently stop doing so:
 * an agent added to the seed with no profile (it falls back to the first
 * sentence of its system prompt and competes on a job title), a hand-off
 * pointing at an agent that was renamed or removed, or the primary tier
 * quietly growing back to the full roster it exists to trim.
 */

import { describe, it, expect } from "bun:test";
import { BUILTIN_AGENT_PROFILES, describeProfile, BUILTIN_AGENT_DESCRIPTIONS } from "../../src/bun/agents/agent-routing";
import { defaultAgentDefs } from "../../src/bun/db/agent-seed-defs";
import { READ_ONLY_AGENTS } from "../../src/shared/agent-capabilities";

/** Built-ins the PM never orchestrates, so they need no routing profile. */
const NOT_PM_DISPATCHABLE = new Set([
	"playground-agent",
	"issue-fixer",
	"freelance-expert",
	"general-chat-assistant",
	"project-manager",
]);

const DISPATCHABLE = defaultAgentDefs.map((d) => d.name).filter((n) => !NOT_PM_DISPATCHABLE.has(n));

describe("routing profiles match the real roster", () => {
	it("every PM-dispatchable agent has a profile", () => {
		expect(DISPATCHABLE.filter((n) => !BUILTIN_AGENT_PROFILES[n])).toEqual([]);
	});

	it("no profile names an agent that does not exist", () => {
		const real = new Set(defaultAgentDefs.map((d) => d.name));
		expect(Object.keys(BUILTIN_AGENT_PROFILES).filter((n) => !real.has(n))).toEqual([]);
	});

	it("every `preferInstead` target is a real, dispatchable agent", () => {
		const dispatchable = new Set(DISPATCHABLE);
		const broken: string[] = [];
		for (const [name, profile] of Object.entries(BUILTIN_AGENT_PROFILES)) {
			for (const target of Object.keys(profile.preferInstead ?? {})) {
				if (!dispatchable.has(target)) broken.push(`${name} → ${target}`);
				if (target === name) broken.push(`${name} → itself`);
			}
		}
		expect(broken).toEqual([]);
	});
});

describe("tiering stays meaningful", () => {
	const primary = Object.entries(BUILTIN_AGENT_PROFILES).filter(([, p]) => p.tier === "primary");

	it("the primary tier stays small enough to be a shortlist", () => {
		// The whole point is shrinking the default choice space. Past ~10 it is
		// no longer a shortlist and the split stops buying anything.
		expect(primary.length).toBeGreaterThanOrEqual(5);
		expect(primary.length).toBeLessThanOrEqual(10);
	});

	it("all three read-only agents are primary", () => {
		// They are the cheapest, safest dispatch and run in parallel — the PM
		// should reach for them first, not hunt for them among specialists.
		for (const name of READ_ONLY_AGENTS) {
			expect(BUILTIN_AGENT_PROFILES[name]?.tier).toBe("primary");
		}
	});
});

describe("descriptions are derived, never hand-written", () => {
	it("BUILTIN_AGENT_DESCRIPTIONS matches describeProfile for every agent", () => {
		for (const [name, profile] of Object.entries(BUILTIN_AGENT_PROFILES)) {
			expect(BUILTIN_AGENT_DESCRIPTIONS[name]).toBe(describeProfile(profile));
		}
	});

	it("a profile with hand-offs renders them; one without does not", () => {
		expect(describeProfile({ useWhen: "X", tier: "primary" })).toBe("X");
		expect(describeProfile({ useWhen: "X", preferInstead: { "code-explorer": "reading code" }, tier: "primary" }))
			.toBe("X. **Instead use**: reading code → code-explorer");
	});

	it("read-only agents' descriptions say so", () => {
		// Capabilities and description are shown side by side, but the PM
		// previously inferred a shell from a bare "Read-only" label — the
		// limitation is repeated in prose deliberately.
		for (const name of READ_ONLY_AGENTS) {
			expect(BUILTIN_AGENT_DESCRIPTIONS[name]).toContain("Cannot run commands or edit files");
		}
	});
});
