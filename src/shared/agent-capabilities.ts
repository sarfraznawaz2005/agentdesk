/**
 * agent-capabilities.ts — the single source of truth for what an agent can do.
 *
 * Capability truth used to live in five hand-maintained places that never
 * imported each other: the dispatch-time filter (agent-loop.ts), two divergent
 * copies of the read-only agent list in prompts.ts, the seed defaults, and the
 * Settings → Agents UI. Every one of them restated the rules from memory, so
 * they drifted — the PM was told `code-explorer` was "Read-only" with no
 * definition and inferred it had a shell, Settings showed `run_shell` enabled
 * for an agent that could never run it, and one prompt list referenced an
 * agent (`explore`) that does not exist while omitting one that does
 * (`task-planner`).
 *
 * Everything that *describes* a capability must now derive it from the same
 * functions that *enforce* it. tests/agents/agent-capabilities.test.ts locks
 * that invariant.
 *
 * CONSTRAINT: this module is imported by the webview bundle (Settings →
 * Agents), so it must stay free of `bun:*`, drizzle, node builtins and any
 * other main-process-only import. Pure constants and pure functions only.
 */

/**
 * Tools that can mutate the workspace, git state, the kanban board, or agent
 * memory. Stripped from read-only agents at dispatch by filterReadOnlyTools.
 *
 * `run_background` and `kill_process` belong here even though they read as
 * "process" tools: run_background's own description is "Spawn a shell command
 * as a background process", so leaving it out made "read-only agents cannot
 * run commands" false — research-expert held it via the PROCESS family.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
	"write_file", "edit_file", "multi_edit_file", "append_file", "delete_file",
	"move_file", "copy_file", "create_directory", "patch_file", "batch_rename",
	"archive", "download_file",
	"run_shell", "execute_code",
	"run_background", "kill_process",
	"git_commit", "git_push", "git_branch", "git_stash", "git_reset",
	"git_cherry_pick",
	"create_task", "move_task", "update_task", "delete_task",
]);

// save_memory / delete_memory are deliberately NOT write tools. This filter
// exists to prevent workspace and git races between concurrently-dispatched
// agents (see WRITE_CONCURRENCY_EXEMPT_AGENTS in agent-loop.ts: "genuinely
// never touches project files"); memory tools write rows to agent_memories,
// scoped per agent+project, and cannot race a file edit. Classing them as
// "write" merely because they mutate something meant every read-only agent was
// granted save_memory, had it stripped at dispatch, and was then handed a
// system prompt from buildMemoryIndexSection saying "Save new ones with
// `save_memory`" — an instruction it had no tool to follow. Read-only agents
// are exactly the ones whose findings are worth remembering.

/**
 * Agents that only read/explore — safe to run in parallel with each other and
 * with a write agent, because none of their tools can touch files or git.
 */
export const READ_ONLY_AGENTS: ReadonlySet<string> = new Set([
	"code-explorer",
	"research-expert",
	"task-planner",
]);

/**
 * Per-agent exceptions to the write-tool strip. task-planner is read-only
 * (parallelizable, no file/shell/git writes) yet is the sole task author, so
 * it keeps `create_task` despite that tool being in WRITE_TOOLS.
 */
export const READ_ONLY_WRITE_EXCEPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
	"task-planner": new Set(["create_task"]),
};

/**
 * Whether `toolName` is silently removed from `agentName`'s toolset at
 * dispatch, regardless of what its agent_tools rows say. This is the one
 * predicate the dispatch filter, the PM prompt builder and the Settings UI all
 * answer with — so a granted-but-stripped tool can never again be presented as
 * available.
 */
export function isToolStrippedAtDispatch(agentName: string, toolName: string): boolean {
	if (!READ_ONLY_AGENTS.has(agentName)) return false;
	if (READ_ONLY_WRITE_EXCEPTIONS[agentName]?.has(toolName)) return false;
	return WRITE_TOOLS.has(toolName);
}

/** Structured capability facts for one agent, derived from its effective toolset. */
export interface AgentCapabilities {
	readOnly: boolean;
	shell: boolean;
	fileWrite: boolean;
	gitRead: boolean;
	gitWrite: boolean;
	/** Write tools granted in the DB but removed at dispatch. Empty for write agents. */
	strippedTools: string[];
}

const SHELL_TOOLS = ["run_shell", "execute_code", "run_background"] as const;
const FILE_WRITE_TOOLS = ["write_file", "edit_file", "multi_edit_file", "patch_file", "append_file"] as const;
const GIT_READ_TOOLS = ["git_status", "git_diff", "git_log", "git_show"] as const;
const GIT_WRITE_TOOLS = ["git_commit", "git_push", "git_branch", "git_reset"] as const;

/**
 * Derive an agent's capabilities from its GRANTED tool names (pre-strip). The
 * strip is applied here, so callers pass raw agent_tools rows and still get the
 * truth about what the agent can actually do once dispatched.
 */
export function describeCapabilities(agentName: string, grantedTools: readonly string[]): AgentCapabilities {
	const effective = new Set(grantedTools.filter((t) => !isToolStrippedAtDispatch(agentName, t)));
	const strippedTools = grantedTools.filter((t) => isToolStrippedAtDispatch(agentName, t)).sort();
	const has = (names: readonly string[]) => names.some((n) => effective.has(n));

	return {
		readOnly: READ_ONLY_AGENTS.has(agentName),
		shell: has(SHELL_TOOLS),
		fileWrite: has(FILE_WRITE_TOOLS),
		gitRead: has(GIT_READ_TOOLS),
		gitWrite: has(GIT_WRITE_TOOLS),
		strippedTools,
	};
}

/**
 * One-line capability summary for the PM's Sub-Agents table.
 *
 * Deliberately compact: 16 of the built-in write agents hold near-identical
 * toolsets, so spelling each one out would repeat the same string 16 times for
 * no routing value. The uniform case collapses to "full write · shell", and
 * the column's real job is to be a FILTER (can this agent do the job at all?)
 * — the description column is the SELECTOR (which agent is the right fit?).
 */
export function summarizeCapabilities(caps: AgentCapabilities): string {
	if (!caps.readOnly && caps.shell && caps.fileWrite) {
		return caps.gitWrite ? "full write · shell · git-write" : "full write · shell";
	}

	const parts: string[] = ["read"];
	if (caps.gitRead) parts.push("git-read");
	if (caps.shell) parts.push("shell");
	else parts.push("no shell");
	if (caps.fileWrite) parts.push("file-write");
	else parts.push("no writes");
	return parts.join(" · ");
}

/**
 * True for an agent that records a verdict on someone else's work rather than
 * implementing its own — it holds `submit_review` but is deliberately denied
 * `verify_implementation` ("only implementers call that", see KANBAN_REVIEWER
 * in db/agent-tool-defaults.ts).
 *
 * Derived from the toolset rather than matched on the name so custom review
 * agents behave the same as the built-in `code-reviewer`, and so this can never
 * drift from the grants. `prompt-sections.ts` picks its reviewer variant on the
 * same distinction via that section's `requires`.
 *
 * Callers use this to keep review dispatch off the implementer path: a reviewer
 * must NOT have its task moved to "working" (submit_review rejects any task not
 * in "review", so the move only forces the agent to move it back), and must not
 * be handed implementer instructions naming tools it does not have.
 */
export function isReviewerToolset(tools: Iterable<string>): boolean {
	const set = tools instanceof Set ? tools : new Set(tools);
	return set.has("submit_review") && !set.has("verify_implementation");
}
