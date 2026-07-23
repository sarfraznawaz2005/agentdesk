/**
 * agent-prompt-tools.test.ts
 *
 * Locks the second half of the capability invariant.
 *
 * agent-capabilities.test.ts checks that nothing GRANTS an agent a tool it
 * can't use. This one checks the mirror image: that nothing TELLS an agent to
 * use a tool it doesn't have. Both failure modes produce the same wasted
 * dispatch — an agent that reads an instruction it cannot follow, reports it
 * can't, and gets re-dispatched by a PM working from the same bad premise.
 *
 * Concrete mismatches this was written against, all of which were live:
 *   - research-expert's "Key Tools" listed `run_background` after that became
 *     a write tool and started being stripped at dispatch.
 *   - code-reviewer, being a write agent, received the kanban section telling
 *     it that calling `verify_implementation` was MANDATORY — a tool
 *     deliberately withheld from reviewers (KANBAN_REVIEWER).
 *   - every narrow custom agent received the docs, kanban, work-integrity and
 *     skills sections unconditionally, regardless of its grants.
 *
 * Coverage is the full composed prompt: the agent's own seed prompt plus every
 * static section prompt-sections.ts would select for it. It cannot cover
 * runtime-injected text (plugin prompts, MCP listings, workspace AGENTS.md) —
 * that content isn't ours and isn't static.
 */

import { describe, it, expect } from "bun:test";
import { isToolStrippedAtDispatch, READ_ONLY_AGENTS } from "../../src/shared/agent-capabilities";
// Both imported from the extracted pure modules, never from seed.ts — see
// those files' headers (importing seed.ts would open a DB connection).
import { getDefaultAgentTools } from "../../src/bun/db/agent-tool-defaults";
import { defaultAgentDefs } from "../../src/bun/db/agent-seed-defs";
import { selectPromptSections, pluginPromptApplies } from "../../src/bun/agents/prompt-sections";
import { defaultAgentTools } from "../../src/bun/db/agent-tool-defaults";

/**
 * Tools an agent holds without an `agent_tools` row.
 *
 * `log_decision` is granted purely by having a workspace (agent-loop.ts's
 * createDecisionsTool). `deep_research` is in research-expert's defaults but
 * the registry entry is a stub, overlaid at runtime with the run's resolved
 * provider bound in — listed here for the same reason: neither is a normal
 * grant, and without them the audit would report both as missing.
 */
const RUNTIME_INJECTED_TOOLS = ["log_decision", "deep_research"] as const;

/**
 * Agents with NO default grants receive the FULL registry at dispatch
 * (getToolsForAgent), so every tool mention in their prompt is satisfiable by
 * definition and there is nothing here to check.
 */
const FULL_REGISTRY_AGENTS = new Set(
	Object.keys(defaultAgentTools).length > 0
		? defaultAgentDefs.map((d) => d.name).filter((n) => (defaultAgentTools[n]?.length ?? 0) === 0)
		: [],
);

/**
 * Backticked tool names that refer to something OTHER than a tool this agent
 * should call. Kept deliberately tiny — every entry is a place where prose
 * mentions a tool by name for context, and each needs a reason.
 */
const ALLOWED_FOREIGN_MENTIONS: Record<string, readonly string[]> = {
	// The read-only kanban section names the three board-write tools precisely
	// in order to tell the agent it does NOT have them.
	"code-explorer": ["move_task", "check_criteria", "update_task"],
	"research-expert": ["move_task", "check_criteria", "update_task"],
	"task-planner": ["move_task", "check_criteria", "update_task"],
};

/**
 * The vocabulary a backticked token is matched against: every tool granted to
 * at least one agent, plus the runtime-injected ones.
 *
 * Deliberately NOT `getToolDefinitions()` — importing the tool registry pulls
 * in every tool module and, through them, the DB connection, which a unit test
 * must not open. The trade is precise: a tool granted to SOME agent but named
 * in a DIFFERENT agent's prompt is caught (that is the entire mismatch class
 * this file exists for); a registry tool granted to NO agent and named in a
 * prompt would slip through. That combination cannot arise from the drift this
 * guards against, since a prompt only names tools someone was meant to have.
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
	...Object.values(defaultAgentTools).flatMap((list) => [...list]),
	...RUNTIME_INJECTED_TOOLS,
]);

/** Tool names a prompt tells the agent to call, in backticks: `read_file`. */
function extractToolMentions(prompt: string): string[] {
	const found = new Set<string>();
	for (const match of prompt.matchAll(/`([a-z_][a-z0-9_]{2,})`/g)) {
		if (KNOWN_TOOLS.has(match[1])) found.add(match[1]);
	}
	return [...found].sort();
}

/** The toolset an agent actually holds at dispatch, mirroring getToolsForAgent + the strip. */
function effectiveTools(agentName: string): Set<string> {
	const base = [...getDefaultAgentTools(agentName), ...RUNTIME_INJECTED_TOOLS];
	return new Set(base.filter((t) => !isToolStrippedAtDispatch(agentName, t)));
}

/**
 * The static sections an agent receives, with the most permissive flags on, so
 * the audit sees the MOST text it can be given rather than the least.
 */
function sectionsFor(agentName: string) {
	return selectPromptSections({
		agentName,
		grantedTools: [...getDefaultAgentTools(agentName), ...RUNTIME_INJECTED_TOOLS],
		readOnly: READ_ONLY_AGENTS.has(agentName),
		knowledgeUpdateEnabled: true,
		featureBranchEnabled: true,
	});
}

/** The agent's seed prompt plus every static section it would receive. */
function composedPrompt(agentName: string, seedPrompt: string): string {
	return [seedPrompt, ...sectionsFor(agentName).map((s) => s.text)].join("\n\n");
}

describe("no agent prompt names a tool the agent lacks", () => {
	for (const def of defaultAgentDefs) {
		if (FULL_REGISTRY_AGENTS.has(def.name)) continue;
		it(`${def.name}`, () => {
			const available = effectiveTools(def.name);
			const allowed = new Set(ALLOWED_FOREIGN_MENTIONS[def.name] ?? []);
			const missing = extractToolMentions(composedPrompt(def.name, def.systemPrompt))
				.filter((t) => !available.has(t) && !allowed.has(t));
			expect(missing).toEqual([]);
		});
	}

	it("covers every agent that has explicit grants", () => {
		const covered = defaultAgentDefs.filter((d) => !FULL_REGISTRY_AGENTS.has(d.name));
		expect(covered.length).toBeGreaterThanOrEqual(20);
		// A vocabulary that silently collapsed to a handful of names would make
		// every assertion above pass vacuously.
		expect(KNOWN_TOOLS.size).toBeGreaterThan(70);
	});
});

describe("selectPromptSections never emits a section naming an ungranted tool", () => {
	// The section variants are the part most likely to drift, because a section
	// is shared by ~20 agents while its `requires` list is written once.
	for (const def of defaultAgentDefs) {
		if (FULL_REGISTRY_AGENTS.has(def.name)) continue;
		it(`${def.name} — every selected section's requires are satisfied`, () => {
			const available = effectiveTools(def.name);
			for (const section of sectionsFor(def.name)) {
				const unmet = section.requires.filter((t) => !available.has(t));
				expect({ section: section.id, unmet }).toEqual({ section: section.id, unmet: [] });
			}
		});
	}

	it("a section's declared `requires` covers every tool its text names", () => {
		// Guards the audit itself: a section that gains a tool mention without
		// adding it to `requires` would silently stop being gated on that tool.
		// Run against a maximally-capable agent so no variant is filtered out.
		for (const readOnly of [false, true]) {
			const sections = selectPromptSections({
				agentName: "backend-engineer", // not read-only ⇒ nothing is stripped
				grantedTools: [...KNOWN_TOOLS],
				readOnly,
				knowledgeUpdateEnabled: true,
				featureBranchEnabled: true,
			});
			for (const section of sections) {
				const declared = new Set(section.requires);
				const mentioned = extractToolMentions(section.text);
				// The read-only kanban section names board-write tools precisely in
				// order to say the agent does NOT have them — the one exception.
				const foreign = new Set(section.id === "kanban_lifecycle" ? ["move_task", "check_criteria", "update_task"] : []);
				const undeclared = mentioned.filter((t) => !declared.has(t) && !foreign.has(t));
				expect({ section: section.id, readOnly, undeclared }).toEqual({ section: section.id, readOnly, undeclared: [] });
			}
		}
	});
});

describe("regressions this audit was written for", () => {
	it("research-expert is not told to spawn background processes", () => {
		const def = defaultAgentDefs.find((d) => d.name === "research-expert");
		expect(def).toBeDefined();
		expect(def!.systemPrompt).not.toContain("`run_background`");
		expect(effectiveTools("research-expert").has("run_background")).toBe(false);
	});

	it("code-reviewer is not told verify_implementation is mandatory", () => {
		const available = effectiveTools("code-reviewer");
		expect(available.has("verify_implementation")).toBe(false);
		expect(available.has("submit_review")).toBe(true);
		const prompt = composedPrompt("code-reviewer", "");
		expect(prompt).not.toContain("`verify_implementation`");
		expect(prompt).toContain("`submit_review`");
	});

	it("an agent with no docs-write tools gets the read-only docs section", () => {
		const sections = selectPromptSections({
			agentName: "custom-narrow",
			grantedTools: ["read_file", "list_docs", "get_doc"],
			readOnly: true,
			knowledgeUpdateEnabled: false,
			featureBranchEnabled: false,
		});
		const docs = sections.find((s) => s.id === "cross_agent_knowledge");
		expect(docs).toBeDefined();
		expect(docs!.text).not.toContain("`create_doc`");
		expect(docs!.text).toContain("`list_docs`");
	});

	// Found by running the real app: the LSP Manager plugin's snippet was
	// injected into every agent, so research-expert and task-planner — granted
	// no lsp_* tools — were each told to use five tools they do not have. The
	// plugin registers its own copies under `plugin__lsp_manager__*`, a name the
	// prose never mentions, so the instruction was unfollowable under any name.
	describe("plugin prompt snippets are gated on the agent's toolset", () => {
		const KNOWN = new Set(["lsp_diagnostics", "lsp_hover", "read_file", "run_shell"]);
		const LSP_SNIPPET = "## LSP Tools\n\n- `lsp_diagnostics` — errors for a file\n- `lsp_hover` — type signatures";

		it("is skipped for an agent with none of the tools it names", () => {
			const r = pluginPromptApplies(LSP_SNIPPET, new Set(["read_file"]), KNOWN);
			expect(r.applies).toBe(false);
			expect(r.names).toEqual(["lsp_diagnostics", "lsp_hover"]);
		});

		it("is injected for an agent holding any of them", () => {
			expect(pluginPromptApplies(LSP_SNIPPET, new Set(["read_file", "lsp_hover"]), KNOWN).applies).toBe(true);
		});

		it("a snippet naming no known tool is always injected", () => {
			// Pure behavioural guidance has no tool requirement to fail.
			const r = pluginPromptApplies("Always prefer small commits.", new Set<string>(), KNOWN);
			expect(r).toEqual({ applies: true, names: [] });
		});

		it("unrecognised backticked words are not treated as tool requirements", () => {
			// `tsc` and `npm_run_build` are not registered tools — they must not
			// gate the snippet, or prose would silently suppress a valid prompt.
			const r = pluginPromptApplies("Run `tsc` or `npm_run_build` first.", new Set<string>(), KNOWN);
			expect(r).toEqual({ applies: true, names: [] });
		});
	});

	it("an agent with no docs tools at all gets no docs section", () => {
		const sections = selectPromptSections({
			agentName: "custom-minimal",
			grantedTools: ["read_file"],
			readOnly: true,
			knowledgeUpdateEnabled: false,
			featureBranchEnabled: false,
		});
		expect(sections.find((s) => s.id === "cross_agent_knowledge")).toBeUndefined();
		expect(sections.find((s) => s.id === "kanban_lifecycle")).toBeUndefined();
	});
});
