/**
 * prompt-sections.ts — the static sub-agent prompt sections, plus the pure rule
 * for which of them a given agent actually receives.
 *
 * WHY THIS IS SEPARATE FROM prompts.ts
 *
 * These sections instruct an agent to call specific tools by name. Whether the
 * agent HAS those tools depends on its `agent_tools` grants and the read-only
 * dispatch strip — neither of which the section text knows anything about. So
 * the same drift that produced ungranted capability claims (see
 * shared/agent-capabilities.ts) also produced ungranted *instructions*: a
 * read-only agent told to call `move_task`, `research-expert` handed a Key
 * Tools list containing `run_background` after that became a write tool, and
 * every narrow custom agent told to call `list_docs` and `check_criteria`
 * regardless of what it was granted.
 *
 * Selection is expressed as data — each section declares the tools it
 * instructs the agent to use — so tests/agents/agent-prompt-tools.test.ts can
 * assert the invariant mechanically: every tool a section names must be in the
 * receiving agent's effective toolset.
 *
 * CONSTRAINT: no `db` import, no `Utils.paths`, no I/O. prompts.ts owns all of
 * that and composes these into the final prompt; this module must stay
 * importable from a test without opening a database.
 */

import { WRITE_TOOLS, isToolStrippedAtDispatch } from "../../shared/agent-capabilities";

// ---------------------------------------------------------------------------
// Section text
// ---------------------------------------------------------------------------

export const AGENT_KNOWLEDGE_UPDATE_LINE = `- **Keep knowledge current**: If your work changes something described in a project-knowledge doc (e.g. new dependency, changed architecture, modified API), update that doc via \`update_doc\` so future agents get accurate context.`;

export const EXECUTION_CONTEXT_WRITE = `## Execution Context

You are running **inline** in the main conversation. The Project Manager dispatched you via \`run_agent\`. Your tool calls and output are visible to the PM and the user in real time.

- You received ONLY a task description — you have NO conversation history. The task description is your entire context.
- You do NOT communicate with the user directly. The PM handles all user interaction.
- You do NOT spawn other agents. If a task requires skills outside your domain, note it in your final output.
- When your task is complete, provide a comprehensive summary in your final response.
- If you encounter an unrecoverable error, describe the error clearly in your final response.

## Critical Rules

1. **ALWAYS read existing files before modifying them.** Never overwrite code you haven't inspected.
2. **ALWAYS verify your code works after writing.** Check for import errors, type errors, and runtime issues.
3. **Fix LSP errors immediately** — do not move on with broken code.
4. **Never hallucinate** — do not claim a file exists, a function works, or a test passes unless you have verified it with actual tool calls.
5. **Think full-stack.** When you add or change backend logic, data models, or JS modules, check if the UI needs updating too — new HTML elements, form fields, display sections, or user-facing controls. Likewise, when changing the UI, make sure the underlying logic supports it. A feature that works in code but has no way for the user to see or interact with it is incomplete.`;

export const EXECUTION_CONTEXT_READONLY = `## Execution Context

You are running **inline** in the main conversation. The Project Manager dispatched you for a read-only task. Your tool calls and output are visible to the PM and the user in real time.

- You received ONLY a task description — you have NO conversation history. The task description is your entire context.
- You do NOT communicate with the user directly. The PM handles all user interaction.
- You do NOT spawn other agents. If a task requires skills outside your domain, note it in your final output.
- You have **read-only tools** — no file writes, no shell commands.
- When your task is complete, provide a comprehensive summary in your final response.
- If you encounter an unrecoverable error, describe the error clearly in your final response.`;

const TOKEN_EFFICIENCY_SECTION = `## Token Efficiency

- **Targeted file reads**: Use \`startLine\` and \`endLine\` on \`read_file\` to read only the relevant section instead of the entire file. Critical for large files (>200 lines).
- **Avoid re-reading unchanged files**: If you already read a file and haven't modified it, do not read it again.
- **Use search before read**: Use \`search_content\` or \`search_files\` to locate the exact file and line range before reading.`;

/** Token-efficiency advice for an agent granted read_file but not the search tools. */
const TOKEN_EFFICIENCY_SECTION_NO_SEARCH = `## Token Efficiency

- **Targeted file reads**: Use \`startLine\` and \`endLine\` on \`read_file\` to read only the relevant section instead of the entire file. Critical for large files (>200 lines).
- **Avoid re-reading unchanged files**: If you already read a file and haven't modified it, do not read it again.`;

const LSP_DIAGNOSTICS_SECTION = `## LSP Diagnostics

File write/edit tools automatically return LSP diagnostics (type errors, lint issues) after each change. **You MUST address these before moving on:**
1. After every \`write_file\`, \`edit_file\`, \`multi_edit_file\`, or \`patch_file\` — read the diagnostics in the tool result.
2. If there are **errors** (not warnings): fix them immediately before proceeding to the next file or task step.
3. Before moving a task to "review", ensure there are **zero LSP errors** in files you modified. Warnings are acceptable if intentional.
4. If an error is a false positive or unfixable (e.g. missing third-party types), note it in your report — do not silently ignore errors.`;

const CROSS_AGENT_KNOWLEDGE_SHARING_WRITE = `## Cross-Agent Knowledge Sharing

You have access to project docs via \`list_docs\`, \`get_doc\`, \`create_doc\`, \`update_doc\`, and \`delete_doc\`.
- **Before starting**: Call \`list_docs\` to check if previous agents left architecture decisions, API docs, or context you should know about.
- **Never create a duplicate doc**: Before calling \`create_doc\`, check the \`list_docs\` results for an existing doc with the same or a similarly-worded title. If one exists, call \`get_doc\` to read its full current content, then call \`update_doc\` with the merged result (old content that's still accurate + your new information) instead of creating a second doc. Only call \`create_doc\` when no matching doc exists.
- **During work**: Create or update docs for important decisions, API contracts, gotchas, or anything another agent working on the same project would need to know.
- **Title convention**: Use clear prefixes like "Architecture: ...", "API: ...", "Gotcha: ..." so other agents can find relevant docs quickly.
- **Agent knowledge**: Documents titled "project-knowledge- ..." are listed (title + purpose only) below under "Prior Agents Knowledge". Use \`get_doc\` to read the full content of any relevant document before starting work.
- **Curation**: Use \`delete_doc\` to remove a doc that is stale, wrong, or fully superseded — not as a substitute for \`update_doc\`.
{agent_knowledge_update}`;

const CROSS_AGENT_KNOWLEDGE_SHARING_READONLY = `## Cross-Agent Knowledge Sharing

You have access to project docs via \`list_docs\`, \`get_doc\`, \`create_doc\`, \`update_doc\`, and \`delete_doc\`.
- **Before starting**: Call \`list_docs\` to check if previous agents left architecture decisions, API docs, or context you should know about.
- **Never create a duplicate doc**: Before calling \`create_doc\`, check the \`list_docs\` results for an existing doc with the same or a similarly-worded title. If one exists, call \`get_doc\` to read its full current content, then call \`update_doc\` with the merged result instead of creating a second doc. Only call \`create_doc\` when no matching doc exists.
- **Agent knowledge**: Documents titled "project-knowledge- ..." are listed below under "Prior Agents Knowledge". Use \`get_doc\` to read any relevant document. Use \`create_doc\` to persist important project knowledge for future agents (e.g. "project-knowledge- Tech Stack", "project-knowledge- Architecture Overview") — or \`update_doc\` if one already exists.
- **Curation**: Use \`delete_doc\` to remove a doc that is stale, wrong, or fully superseded — not as a substitute for \`update_doc\`.`;

/**
 * Docs guidance for an agent granted only the read half of the notes family —
 * a custom agent with `create_doc`/`update_doc`/`delete_doc` unticked in
 * Settings → Agents → Tools. It previously received the full section and was
 * told to author docs with tools it did not have.
 */
const CROSS_AGENT_KNOWLEDGE_SHARING_READ_ONLY_DOCS = `## Cross-Agent Knowledge Sharing

You can READ project docs via \`list_docs\` and \`get_doc\` — you cannot create, update, or delete them.
- **Before starting**: Call \`list_docs\` to check if previous agents left architecture decisions, API docs, or context you should know about.
- **Agent knowledge**: Documents titled "project-knowledge- ..." are listed below under "Prior Agents Knowledge". Use \`get_doc\` to read the full content of any relevant document before starting work.
- If your work produces knowledge worth persisting, state it in your final response — whoever dispatched you can record it.`;

const DECISIONS_LOG_SECTION = `## Decisions Log (CRITICAL)

A shared \`DECISIONS.md\` file in the workspace tracks architectural and design decisions across all agents. **This is how agents stay coordinated. Read it at session start — it is loaded fresh in your prompt under "Architectural Decisions".**

- **At session start**: DECISIONS.md content is injected into your prompt under the "Architectural Decisions" section. Read it before doing any work.
- **Before making any design choice** (tech stack, naming convention, data structure, API shape, auth strategy, file organization): check the "Architectural Decisions" section to see if a prior agent already decided.
- **After making a decision**: call \`log_decision\` with a clear title, rationale, and impact. Future agents will see it in their prompt.
- **Never contradict a logged decision** without explicitly noting why and logging the change.
- Examples of decisions to log: "Use camelCase for JS, snake_case for DB columns", "Auth via JWT stored in httpOnly cookie", "State management via Zustand", "API prefix /api/v1".`;

const WORK_INTEGRITY_SECTION = `## Work Integrity

- **Complete ALL assigned work** — never skip steps, cut corners, or leave acceptance criteria half-done. If your task has 5 criteria, all 5 must be fully implemented and verified.
- **Never mark criteria as checked unless truly done** — use \`check_criteria\` only after you have implemented AND verified the criterion.
- **Do not give up prematurely** — if something is difficult, try alternative approaches. Only report inability after genuine effort. Explain exactly what you tried and what failed.
- **Report honestly** — if you could not complete something, say so clearly in your report. A partial honest report is far more valuable than a fabricated complete one.`;

/** Work integrity for an agent without `check_criteria` (custom agents with kanban unticked). */
const WORK_INTEGRITY_SECTION_NO_CRITERIA = `## Work Integrity

- **Complete ALL assigned work** — never skip steps, cut corners, or leave acceptance criteria half-done. If your task has 5 criteria, all 5 must be fully implemented and verified.
- **Do not give up prematurely** — if something is difficult, try alternative approaches. Only report inability after genuine effort. Explain exactly what you tried and what failed.
- **Report honestly** — if you could not complete something, say so clearly in your report. A partial honest report is far more valuable than a fabricated complete one.`;

const KANBAN_TASK_LIFECYCLE_WRITE = `## Kanban Task Lifecycle

If your task context includes a kanban task ID:
1. **Call \`get_task\` with your task ID as the very first action** — before any other work. This returns the authoritative description, exact acceptance criteria list, and current state from the kanban board. The criteria listed in your prompt may be a summary or out of sync; the kanban board is the source of truth. You MUST know the real criteria count before calling \`check_criteria\`.
2. **Call \`list_docs\` and read the project plan or PRD document** — this is MANDATORY before starting any implementation. Call \`list_docs\` with your project ID to get all project documents, then scan the returned titles and call \`get_doc\` on any document whose title contains "Plan:", "Product Requirements Document", or "PRD". This gives you the overall picture of the project and how your task fits into it. If no matching document is found in the list, continue with your assigned task — do not block on it.
3. Use \`move_task\` to move the task to "working" when you start.
4. Work through all acceptance criteria returned by \`get_task\` (not the ones in your prompt).
5. Use \`check_criteria\` with **all indices in a single call** once you have verified them — e.g. \`criteria_index=[0,1,2]\` for a 3-criterion task. Never call \`check_criteria\` one index at a time. Use the exact count from \`get_task\`, not from your prompt.
6. Verify there are no LSP errors in files you modified (fix any that remain).
7. **Call \`verify_implementation\`** — this is MANDATORY. The task cannot move to review without passing this check. Pass your honest self-assessment via the structured checklist. If it fails, fix the gaps and call it again. On pass, the task automatically moves to review.
   - Do NOT call \`move_task\` to review — \`verify_implementation\` handles that on pass.
   - Moving to "done" is **reserved for the automated review system** — never move tasks to "done" yourself.
8. If you cannot complete the task, leave it in "working" and explain in your report.`;

/**
 * Reviewer variant. `code-reviewer` is granted KANBAN_REVIEWER, which
 * deliberately omits `verify_implementation` ("only implementers call that") —
 * yet it is a write agent, so it received the section above telling it that
 * calling `verify_implementation` was MANDATORY. It reaches "done" via
 * `submit_review` instead.
 */
const KANBAN_TASK_LIFECYCLE_REVIEWER = `## Kanban Task Lifecycle

If your task context includes a kanban task ID:
1. **Call \`get_task\` with your task ID as the very first action** — before any other work. This returns the authoritative description, exact acceptance criteria list, and current state from the kanban board. The criteria listed in your prompt may be a summary or out of sync; the kanban board is the source of truth.
2. **Call \`list_docs\` and read the project plan or PRD document** if one exists — call \`list_docs\` with your project ID, then \`get_doc\` on any title containing "Plan:", "Product Requirements Document", or "PRD", for context on how this task fits the project. If none is found, continue — do not block on it.
3. Review the work against every acceptance criterion returned by \`get_task\` (not the ones in your prompt).
4. Use \`check_criteria\` with **all indices in a single call** for criteria you have verified — e.g. \`criteria_index=[0,1,2]\`. Never call it one index at a time.
5. **Record your verdict with \`submit_review\`** — approving moves the task to "done", rejecting sends it back to "working" with your findings. The implementing agent runs its own pre-review self-verification step; that is not yours to call.
6. Never move a task to "done" with \`move_task\` — \`submit_review\` owns that transition.`;

// Read-only agents have NO kanban write tools — move_task and check_criteria are
// both in WRITE_TOOLS and are stripped at dispatch. An earlier version of this
// section instructed them to call both, which meant every read-only agent given a
// kanban task was told to use tools that were not in its schema. The PM owns the
// board transitions for these agents instead.
const KANBAN_TASK_LIFECYCLE_READONLY = `## Kanban Task Lifecycle

If your task context includes a kanban task ID:
1. **Call \`get_task\` with your task ID as the very first action** — before any other work. This returns the authoritative acceptance criteria list. Never infer the criteria count from your prompt.
2. **Call \`list_docs\` and read the project plan or PRD document** — this is MANDATORY before starting any work. Call \`list_docs\` with your project ID, then scan the returned titles and call \`get_doc\` on any document whose title contains "Plan:", "Product Requirements Document", or "PRD". This gives you the overall picture of the project and how your task fits into it. If no matching document is found in the list, continue with your assigned task — do not block on it.
3. Work through all acceptance criteria returned by \`get_task\` (not the ones in your prompt).
4. **You cannot move the task or check off criteria** — you are a read-only agent and have no board-write tools. Do NOT attempt to call \`move_task\`, \`check_criteria\`, or \`update_task\`; they are not available to you.
5. Instead, state in your final response which criteria your findings satisfy and which remain open. The Project Manager reads your report and updates the board.
6. If you cannot complete the task, say so plainly in your final response and explain what blocked you.`;

/** Kanban guidance for an agent that can read the board but not write to it and has no docs tools. */
const KANBAN_TASK_LIFECYCLE_READ_ONLY_MINIMAL = `## Kanban Task Lifecycle

If your task context includes a kanban task ID:
1. **Call \`get_task\` with your task ID as the very first action** — this returns the authoritative acceptance criteria list. Never infer the criteria count from your prompt.
2. Work through all acceptance criteria returned by \`get_task\` (not the ones in your prompt).
3. **You cannot move the task or check off criteria** — state in your final response which criteria your findings satisfy and which remain open. Whoever dispatched you updates the board.`;

const FEATURE_BRANCH_INSTRUCTION = `## Feature Branch Workflow

This project uses a feature branch workflow. Auto-commit will handle switching to the correct feature branch when your task is complete. Your only responsibility: **never commit directly to main or master**. Use \`git_status\` to check the current branch before committing if you commit manually.`;

/** Feature-branch note for an agent without `git_status`. */
const FEATURE_BRANCH_INSTRUCTION_NO_GIT = `## Feature Branch Workflow

This project uses a feature branch workflow. Auto-commit will handle switching to the correct feature branch when your task is complete. Your only responsibility: **never commit directly to main or master**.`;

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Slots a sub-agent prompt can fill. Order here is not the render order. */
export type PromptSectionId =
	| "execution_context"
	| "token_efficiency"
	| "lsp_diagnostics"
	| "cross_agent_knowledge"
	| "decisions_log"
	| "work_integrity"
	| "kanban_lifecycle"
	| "feature_branch";

export interface PromptSection {
	id: PromptSectionId;
	/**
	 * Every tool this section's text instructs the agent to call. The audit test
	 * asserts each one is in the agent's effective toolset — so a section that
	 * gains a tool mention must gain it here too, or the test fails.
	 */
	requires: readonly string[];
	text: string;
}

/** One slot's variants, most capable first. The first satisfiable one wins; none ⇒ slot omitted. */
type Variants = readonly PromptSection[];

export interface PromptSectionContext {
	agentName: string;
	/**
	 * Tool names the agent will actually hold at dispatch. Callers pass GRANTED
	 * names (agent_tools rows, or the full registry when it has none) plus any
	 * runtime-injected tool the prompt builder knows about — `log_decision` is
	 * granted purely by having a workspace, never by a row. The read-only strip
	 * is applied here so callers cannot forget it.
	 */
	grantedTools: readonly string[];
	readOnly: boolean;
	knowledgeUpdateEnabled: boolean;
	featureBranchEnabled: boolean;
}

const EXECUTION_CONTEXT: Variants = [
	{ id: "execution_context", requires: [], text: EXECUTION_CONTEXT_WRITE },
];
const EXECUTION_CONTEXT_RO: Variants = [
	{ id: "execution_context", requires: [], text: EXECUTION_CONTEXT_READONLY },
];

const TOKEN_EFFICIENCY: Variants = [
	{ id: "token_efficiency", requires: ["read_file", "search_content", "search_files"], text: TOKEN_EFFICIENCY_SECTION },
	{ id: "token_efficiency", requires: ["read_file"], text: TOKEN_EFFICIENCY_SECTION_NO_SEARCH },
];

const LSP_DIAGNOSTICS: Variants = [
	{ id: "lsp_diagnostics", requires: ["write_file", "edit_file", "multi_edit_file", "patch_file"], text: LSP_DIAGNOSTICS_SECTION },
];

const CROSS_AGENT_KNOWLEDGE_FULL: Variants = [
	{ id: "cross_agent_knowledge", requires: ["list_docs", "get_doc", "create_doc", "update_doc", "delete_doc"], text: CROSS_AGENT_KNOWLEDGE_SHARING_WRITE },
	{ id: "cross_agent_knowledge", requires: ["list_docs", "get_doc"], text: CROSS_AGENT_KNOWLEDGE_SHARING_READ_ONLY_DOCS },
];
const CROSS_AGENT_KNOWLEDGE_RO: Variants = [
	{ id: "cross_agent_knowledge", requires: ["list_docs", "get_doc", "create_doc", "update_doc", "delete_doc"], text: CROSS_AGENT_KNOWLEDGE_SHARING_READONLY },
	{ id: "cross_agent_knowledge", requires: ["list_docs", "get_doc"], text: CROSS_AGENT_KNOWLEDGE_SHARING_READ_ONLY_DOCS },
];

const DECISIONS_LOG: Variants = [
	{ id: "decisions_log", requires: ["log_decision"], text: DECISIONS_LOG_SECTION },
];

const WORK_INTEGRITY: Variants = [
	{ id: "work_integrity", requires: ["check_criteria"], text: WORK_INTEGRITY_SECTION },
	{ id: "work_integrity", requires: [], text: WORK_INTEGRITY_SECTION_NO_CRITERIA },
];

const KANBAN_LIFECYCLE_WRITE: Variants = [
	{
		id: "kanban_lifecycle",
		requires: ["get_task", "list_docs", "get_doc", "move_task", "check_criteria", "verify_implementation"],
		text: KANBAN_TASK_LIFECYCLE_WRITE,
	},
	{
		id: "kanban_lifecycle",
		requires: ["get_task", "list_docs", "get_doc", "move_task", "check_criteria", "submit_review"],
		text: KANBAN_TASK_LIFECYCLE_REVIEWER,
	},
	{ id: "kanban_lifecycle", requires: ["get_task"], text: KANBAN_TASK_LIFECYCLE_READ_ONLY_MINIMAL },
];
const KANBAN_LIFECYCLE_RO: Variants = [
	{ id: "kanban_lifecycle", requires: ["get_task", "list_docs", "get_doc"], text: KANBAN_TASK_LIFECYCLE_READONLY },
	{ id: "kanban_lifecycle", requires: ["get_task"], text: KANBAN_TASK_LIFECYCLE_READ_ONLY_MINIMAL },
];

const FEATURE_BRANCH: Variants = [
	{ id: "feature_branch", requires: ["git_status"], text: FEATURE_BRANCH_INSTRUCTION },
	{ id: "feature_branch", requires: [], text: FEATURE_BRANCH_INSTRUCTION_NO_GIT },
];

/**
 * The static sections `agentName` receives, in render order, with every
 * tool-name mention guaranteed to be in its effective toolset.
 *
 * `{agent_knowledge_update}` in the docs section is still substituted by the
 * caller — it is a text placeholder, not a tool reference.
 */
export function selectPromptSections(ctx: PromptSectionContext): PromptSection[] {
	const effective = new Set(
		ctx.grantedTools.filter((t) => !isToolStrippedAtDispatch(ctx.agentName, t)),
	);
	const pick = (variants: Variants): PromptSection | null =>
		variants.find((v) => v.requires.every((t) => effective.has(t))) ?? null;

	const slots: Array<Variants | null> = [
		ctx.readOnly ? EXECUTION_CONTEXT_RO : EXECUTION_CONTEXT,
		TOKEN_EFFICIENCY,
		ctx.readOnly ? null : LSP_DIAGNOSTICS,
		ctx.readOnly ? CROSS_AGENT_KNOWLEDGE_RO : CROSS_AGENT_KNOWLEDGE_FULL,
		ctx.readOnly ? null : DECISIONS_LOG,
		ctx.readOnly ? null : WORK_INTEGRITY,
		ctx.readOnly ? KANBAN_LIFECYCLE_RO : KANBAN_LIFECYCLE_WRITE,
		ctx.featureBranchEnabled && !ctx.readOnly ? FEATURE_BRANCH : null,
	];

	const selected: PromptSection[] = [];
	for (const variants of slots) {
		if (!variants) continue;
		const section = pick(variants);
		if (section) selected.push(section);
	}
	return selected;
}

/** Look up one selected section's text, or "" if the agent didn't qualify for it. */
export function sectionText(sections: readonly PromptSection[], id: PromptSectionId): string {
	return sections.find((s) => s.id === id)?.text ?? "";
}

/**
 * Whether `agentName` can write files/run commands, used to pick the write vs
 * read-only prompt shape for CUSTOM agents — the three built-in READ_ONLY_AGENTS
 * are identified by name instead. A custom agent the user built with every write
 * tool unticked should read the read-only prompt, not be told it can edit files.
 */
export function hasNoWriteCapability(agentName: string, grantedTools: readonly string[]): boolean {
	return !grantedTools.some((t) => WRITE_TOOLS.has(t) && !isToolStrippedAtDispatch(agentName, t));
}

/** Backticked tool names in `text` that are real registered tools. */
export function toolNamesMentioned(text: string, knownTools: ReadonlySet<string>): string[] {
	return [...new Set([...text.matchAll(/`([a-z_][a-z0-9_]{2,})`/g)].map((m) => m[1]))]
		.filter((t) => knownTools.has(t))
		.sort();
}

/**
 * Whether a plugin's prompt snippet should be injected into this agent's prompt.
 *
 * Enabling a plugin is an app-wide toggle, but its prompt is per-agent text.
 * The LSP Manager's snippet ("use `lsp_diagnostics` …") was reaching
 * `research-expert` and `task-planner`, which are granted no `lsp_*` tools —
 * both were told to use five tools they do not have. Same defect as the
 * read-only kanban section, but arriving from user data, so the static
 * `selectPromptSections` gating cannot see it.
 *
 * The requirement comes from the snippet's own tool mentions, not the
 * manifest's `tools` array, because a plugin registers its tools under a
 * prefixed name (`plugin__<name>__<tool>`) that never matches what the prose
 * tells the agent to type. What matters is whether the agent can follow the
 * instruction as written. A snippet naming no known tool is pure behavioural
 * guidance, so it always applies.
 */
export function pluginPromptApplies(
	snippet: string,
	effectiveTools: ReadonlySet<string>,
	knownTools: ReadonlySet<string>,
): { applies: boolean; names: string[] } {
	const names = toolNamesMentioned(snippet, knownTools);
	return { applies: names.length === 0 || names.some((t) => effectiveTools.has(t)), names };
}
