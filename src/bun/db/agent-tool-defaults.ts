/**
 * agent-tool-defaults.ts — default tool grants per built-in agent.
 *
 * Extracted from seed.ts so it can be imported WITHOUT pulling in the database
 * connection (seed.ts -> db/index -> connection -> electrobun Utils.paths).
 * tests/agents/agent-capabilities.test.ts checks these grants against the
 * dispatch-time capability rules, and Bun's mock.module leaks process-wide, so
 * a test that had to stub electrobun/bun just to read this table would affect
 * every other test file. Same reasoning as create-task-policy.ts.
 *
 * seed.ts re-exports getDefaultAgentTools, so existing importers are unchanged.
 */

// ---------------------------------------------------------------------------
// Per-agent tool assignments — reusable tool sets
// ---------------------------------------------------------------------------

/** Read-only file tools */
const FILE_READ = [
	"read_file", "list_directory", "search_files", "search_content",
	"directory_tree", "file_info", "is_binary", "read_image",
] as const;

/** File write/mutation tools */
const FILE_WRITE = [
	"write_file", "edit_file", "delete_file", "move_file", "append_file",
	"multi_edit_file", "patch_file", "copy_file", "create_directory",
] as const;

/** Advanced/niche file tools */
const FILE_ADVANCED = [
	"diff_text", "find_dead_code", "download_file", "checksum",
	"batch_rename", "file_permissions", "archive",
] as const;

/** Subset of FILE_ADVANCED tools broadly useful across most write agents */
const FILE_COMMON_ADVANCED = ["download_file", "find_dead_code", "diff_text"] as const;
/** FILE_COMMON_ADVANCED minus download_file, which writes to disk and is therefore
 * stripped from read-only agents — granting it produced a dead toggle. */
const FILE_COMMON_ADVANCED_READ = ["find_dead_code", "diff_text"] as const;

const SHELL = ["run_shell"] as const;

/**
 * Full kanban tools for implementer agents. NOTE: `create_task` is intentionally
 * NOT here — task creation is restricted to the task-planner (the sole task
 * author). See `restrictCreateTask` in tools/index.ts. Implementers still move,
 * update, and verify tasks; they just don't author new ones.
 */
const KANBAN = [
	"update_task", "move_task", "check_criteria", "check_all_criteria",
	"add_task_notes", "list_tasks", "get_task", "delete_task", "submit_review",
	"verify_implementation",
] as const;

/** Kanban tools for reviewers — excludes verify_implementation (only implementers call that) */
const KANBAN_REVIEWER = [
	"update_task", "move_task", "check_criteria", "check_all_criteria",
	"add_task_notes", "list_tasks", "get_task", "submit_review",
] as const;

/** Read-only kanban tools */
const KANBAN_READ = ["list_tasks", "get_task"] as const;

/** Read-only git tools. git_show is the only way to inspect a HISTORICAL commit —
 * git_log is metadata-only and git_diff covers just the working tree. */
const GIT_READ = ["git_status", "git_diff", "git_log", "git_fetch", "git_show"] as const;

/** Full git tools */
const GIT_WRITE = [
	"git_commit", "git_branch", "git_push", "git_pull",
	"git_pr", "git_stash", "git_reset", "git_cherry_pick",
] as const;

const WEB = ["web_search", "web_fetch", "http_request"] as const;
const LSP = ["lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_references", "lsp_document_symbols"] as const;
const PROCESS = ["run_background", "check_process", "kill_process", "list_background_jobs"] as const;
/** Read-only subset of PROCESS — inspect jobs without being able to spawn or kill one.
 * run_background/kill_process are in WRITE_TOOLS (run_background spawns a shell command),
 * so read-only agents get this subset instead of the full family. */
const PROCESS_READ = ["check_process", "list_background_jobs"] as const;
/** Read-only database inspection — see tools/data.ts for why this is not shell-gated. */
const DATA_READ = ["query_sqlite"] as const;
const SYSTEM = ["environment_info", "get_env", "get_agentdesk_paths", "sleep"] as const;
const NOTES = ["create_doc", "update_doc", "list_docs", "get_doc", "delete_doc"] as const;
const PLANNING = ["define_tasks"] as const;
const COMMUNICATION = ["request_human_input"] as const;
const SCREENSHOT = ["take_screenshot", "read_image", "generate_image"] as const;
const SKILLS = ["read_skill", "read_skill_file", "find_skills", "list_skills", "validate_skill"] as const;
const MEMORY = ["save_memory", "recall_memory", "delete_memory"] as const;

/**
 * Default tool assignments per agent. Keys are agent `name` values.
 * Only listed tools are enabled; all others are disabled.
 */
export const defaultAgentTools: Record<string, readonly string[]> = {
	// task-planner is the SOLE holder of create_task — it authors all kanban tasks.
	// (Carved out of the read-only write-tool filter in agent-loop.ts so it keeps
	// create_task despite being a read-only agent.)
	// GIT_READ added: planning against a repo whose recent history it cannot read
	// is a real handicap — git_log/git_show tell it what was just built.
	// WEB added: a planner sizing "add OAuth" or "migrate to Vite" with no way to
	// check what that actually involves is guessing; all three WEB tools are read-only.
	"task-planner": [...PLANNING, ...NOTES, ...KANBAN_READ, "create_task", ...FILE_READ, ...GIT_READ, ...WEB],
	// WEB added: architects evaluate libraries, look up patterns and technical docs; read_audio added: review voice notes/recordings attached to a task
	// execute_code added: scoped Python/JS execution in the real project workspace, same approval-gated tier as SHELL — see code-exec.ts
	"software-architect": [...FILE_READ, ...FILE_WRITE, ...FILE_COMMON_ADVANCED, ...SHELL, ...GIT_READ, ...NOTES, ...KANBAN, ...LSP, ...PROCESS, ...SCREENSHOT, ...SYSTEM, ...SKILLS, ...WEB, "read_audio", "execute_code"],
	// WEB added: frontend engineers constantly reference MDN, npm, framework docs; read_audio added: review voice notes/recordings attached to a task; execute_code added: see above
	"frontend_engineer": [...FILE_READ, ...FILE_WRITE, ...FILE_COMMON_ADVANCED, ...SHELL, ...KANBAN, ...LSP, ...SCREENSHOT, ...PROCESS, ...GIT_READ, ...SYSTEM, ...NOTES, ...SKILLS, ...WEB, "read_audio", "execute_code"],
	// WEB added: backend engineers look up API docs, packages; git_stash added (listed as Key Tool in system prompt); read_audio added: review voice notes/recordings attached to a task; execute_code added: see above
	"backend-engineer": [...FILE_READ, ...FILE_WRITE, ...FILE_COMMON_ADVANCED, ...SHELL, ...KANBAN, ...LSP, ...PROCESS, ...SCREENSHOT, ...GIT_READ, ...SYSTEM, ...NOTES, ...SKILLS, ...WEB, "git_stash", "read_audio", "execute_code", ...DATA_READ],
	// read_image added: review screenshots/mockups attached to a task or referenced in a diff; read_audio added: review voice notes/recordings attached to a task; execute_code added: see above
	// WEB added: a reviewer routinely needs to check a CVE, a library's intended usage, or a
	// framework's documented contract before calling a change correct or unsafe.
	"code-reviewer": [...FILE_READ, ...SHELL, ...KANBAN_REVIEWER, ...GIT_READ, ...LSP, ...SYSTEM, ...NOTES, ...SKILLS, ...WEB, "read_image", "read_audio", "execute_code"],
	// NOTES added: QA agents should document test findings/reports; SCREENSHOT added: visual/E2E testing; read_audio added: review voice notes/recordings attached to a task; execute_code added: see above
	// WEB added: testing-library/framework docs and error-message lookups are core to writing tests
	"qa-engineer": [...FILE_READ, ...FILE_WRITE, ...SHELL, ...KANBAN, ...LSP, ...PROCESS, ...GIT_READ, ...SYSTEM, ...SKILLS, ...NOTES, ...SCREENSHOT, ...WEB, "read_audio", "execute_code", ...DATA_READ],
	// WEB added: DevOps looks up Docker Hub, cloud docs, CI/CD platform docs; read_image/read_audio added: review dashboard/monitoring screenshots and voice notes; execute_code added: see above
	"devops-engineer": [...FILE_READ, ...FILE_WRITE, ...FILE_COMMON_ADVANCED, ...SHELL, ...KANBAN, ...GIT_READ, ...GIT_WRITE, ...PROCESS, ...SYSTEM, ...NOTES, ...SKILLS, ...WEB, "read_image", "read_audio", "execute_code"],
	// FILE_WRITE added: system prompt explicitly says "apply security fixes" using write/edit tools; execute_code added: see above
	"security-expert": [...FILE_READ, ...FILE_WRITE, ...SHELL, ...KANBAN, ...GIT_READ, ...LSP, ...WEB, ...SYSTEM, ...NOTES, ...SKILLS, "execute_code"],
	// SHELL added: needed to run doc generators (typedoc, mkdocs, openapi-generator, etc.)
	// generate_image added: illustrative diagrams/hero images/visuals for docs; execute_code added: see above
	"documentation-expert": [...FILE_READ, ...FILE_WRITE, ...KANBAN, ...NOTES, ...GIT_READ, ...SYSTEM, ...SKILLS, ...SHELL, "generate_image", "execute_code"],
	// git_stash added: listed as Key Tool in system prompt; read_audio added: review voice notes/recordings attached to a task; execute_code added: see above
	"debugging-specialist": [...FILE_READ, ...FILE_WRITE, ...FILE_COMMON_ADVANCED, ...SHELL, ...KANBAN, ...LSP, ...PROCESS, ...SCREENSHOT, ...GIT_READ, ...SYSTEM, ...NOTES, ...SKILLS, "git_stash", "read_audio", "execute_code", ...DATA_READ],
	// WEB added: performance engineers look up benchmarks, profiling tools; SCREENSHOT added: capture flamegraphs; read_audio added: review voice notes/recordings attached to a task; execute_code added: see above
	"performance-expert": [...FILE_READ, ...FILE_WRITE, ...FILE_COMMON_ADVANCED, ...SHELL, ...KANBAN, ...LSP, ...PROCESS, ...GIT_READ, ...SYSTEM, ...NOTES, ...SKILLS, ...WEB, ...SCREENSHOT, "read_audio", "execute_code"],
	// WEB added: data engineers look up format specs, API docs for data sources; execute_code added: see above
	"data-engineer": [...FILE_READ, ...FILE_WRITE, ...FILE_COMMON_ADVANCED, ...SHELL, ...KANBAN, ...LSP, ...PROCESS, ...GIT_READ, ...SYSTEM, ...NOTES, ...SKILLS, ...WEB, "execute_code", ...DATA_READ],
	// PROCESS added: run long migrations/VACUUM in background; WEB added: DB docs, EXPLAIN plan references; execute_code added: see above
	"database-expert": [...FILE_READ, ...FILE_WRITE, ...SHELL, ...KANBAN, ...LSP, ...GIT_READ, ...SYSTEM, ...NOTES, ...SKILLS, ...PROCESS, ...WEB, "execute_code", ...DATA_READ],
	// GIT_READ added: context on recent UI changes for design decisions; read_audio added: review voice notes/recordings attached to a task; execute_code added: see above
	"ui-ux-designer": [...FILE_READ, ...FILE_WRITE, ...SHELL, ...KANBAN, ...LSP, ...SCREENSHOT, ...WEB, ...SYSTEM, ...NOTES, ...SKILLS, ...GIT_READ, "read_audio", "execute_code"],
	// git_stash + git_cherry_pick added: both explicitly listed as Key Tools in system prompt; execute_code added: see above
	"refactoring-specialist": [...FILE_READ, ...FILE_WRITE, ...FILE_ADVANCED, ...SHELL, ...KANBAN, ...LSP, ...GIT_READ, ...SYSTEM, ...NOTES, ...SKILLS, "git_stash", "git_cherry_pick", "execute_code"],
	// Read-only agent — no SHELL, for the same reason spelled out on
	// research-expert below: run_shell is in WRITE_TOOLS (see
	// shared/agent-capabilities.ts) and is always stripped at dispatch, so
	// granting it only produced a Settings toggle that looked enabled but could
	// never run. That mismatch is exactly what made this agent report "I have no
	// shell" while the DB said otherwise. checksum/file_permissions/PROCESS_READ
	// are read-only and survive the strip; DATA_READ + git_show close the two
	// gaps that previously forced an escalation to a write agent just to read a
	// commit or a database.
	// read_audio: same rationale as every other agent that has it — a task may
	// reference a voice note; nothing about exploring a codebase excludes that.
	"code-explorer": [...FILE_READ, ...FILE_COMMON_ADVANCED_READ, ...GIT_READ, ...WEB, ...LSP, ...SYSTEM, ...KANBAN_READ, ...SKILLS, ...NOTES, ...PROCESS_READ, ...DATA_READ, "checksum", "file_permissions", "read_audio"],
	// Read-only agent — deliberately no write-capable families (FILE_WRITE,
	// GIT_WRITE, KANBAN, PLANNING). PROCESS_READ and SCREENSHOT added on top of
	// the original set per explicit request; no SHELL — run_shell is in
	// WRITE_TOOLS (shared/agent-capabilities.ts) and would always be silently
	// stripped at dispatch time anyway, so listing it would just be a toggle
	// that looks enabled but can never actually run. The full PROCESS family is
	// likewise out: run_background is "spawn a shell command in the background",
	// i.e. shell by another name.
	// "deep_research" is added as a literal, not via WEB, so it stays scoped to
	// research-expert only — WEB is shared by many other agents. read_audio
	// added: review voice notes/recordings referenced in research sources.
	"research-expert": [...FILE_READ, ...WEB, ...NOTES, ...SYSTEM, ...KANBAN_READ, ...SKILLS, ...PROCESS_READ, ...SCREENSHOT, ...DATA_READ, "deep_research", "read_audio"],
	// execute_code added: see software-architect's comment above
	"api-designer": [...FILE_READ, ...FILE_WRITE, ...FILE_COMMON_ADVANCED, ...SHELL, ...KANBAN, ...LSP, ...WEB, ...GIT_READ, ...SYSTEM, ...NOTES, ...SKILLS, "execute_code"],
	// WEB added: mobile engineers look up React Native, Expo, iOS/Android platform docs; read_audio added: review voice notes/recordings attached to a task; execute_code added: see software-architect's comment above
	"mobile-engineer": [...FILE_READ, ...FILE_WRITE, ...FILE_COMMON_ADVANCED, ...SHELL, ...KANBAN, ...LSP, ...PROCESS, ...GIT_READ, ...SYSTEM, ...SCREENSHOT, ...NOTES, ...SKILLS, ...WEB, "read_audio", "execute_code"],
	// execute_code added: see software-architect's comment above — especially useful for an ML agent's own quick data/model scripts
	// SCREENSHOT added: read_image lets it actually look at a plot/confusion matrix its own script just produced
	"ml-engineer": [...FILE_READ, ...FILE_WRITE, ...FILE_COMMON_ADVANCED, ...SHELL, ...KANBAN, ...LSP, ...PROCESS, ...WEB, ...GIT_READ, ...SYSTEM, ...NOTES, ...SKILLS, ...SCREENSHOT, "execute_code"],
	// Playground agent: no git, no kanban, no notes, no planning — just build + preview tools.
	// execute_code added: auto-approved for Playground (see playground/orchestrator.ts's extraTools override), same as its existing auto-approved run_shell.
	"playground-agent": [...FILE_READ, ...FILE_WRITE, "download_file", ...SHELL, ...WEB, ...LSP, ...PROCESS, "sleep", ...SKILLS, "execute_code"],
	// General Chat Assistant: standalone, workspace-less, ChatGPT-style — no
	// project/kanban/notes/planning/git tools, no file read/write/edit tools,
	// and no run_shell (no sandboxed workspace to safely scope it to; answers
	// are given directly in chat, never written to disk). A fixed, hand-picked
	// list — literal (not the FILE_READ/FILE_WRITE/etc. groups), matching an
	// explicit architectural decision, not just a filtered-down default set.
	// read_file/read_image/read_audio stay only so it can read something the
	// user attaches — it has no path to write to and no directory-browsing
	// tools to go looking for files on its own. No take_screenshot/environment_info
	// either — both are workspace/desktop-oriented and out of scope for a
	// workspace-less chat agent.
	// save_memory/recall_memory/delete_memory, todo_read/todo_write/todo_update_item,
	// execute_code, and deep_research are injected via extraTools at the
	// orchestrator call site (never as agent_tools rows) — see
	// src/bun/general-chat/orchestrator.ts. execute_code is a scoped Python/
	// JS runner cwd'd into the conversation's own ephemeral temp workspace —
	// see general-chat-code-exec.ts for why it doesn't need the full
	// run_shell/file-tools grant this agent deliberately lacks.
	"general-chat-assistant": [
		"find_skills", "generate_image", "http_request", "list_skills",
		"read_audio", "read_file", "read_image", "read_skill", "read_skill_file",
		"sleep", "validate_skill", "web_fetch", "web_search",
	],
};

// Every built-in agent gets request_human_input by default, so any of them can ask
// the user a question via the modal dialog. Applied here (rather than repeating
// ...COMMUNICATION on every line above) and picked up for existing installs by
// seedAgentTools()'s "add missing default tools" pass.
//
// EXCEPT the autonomous background agents (playground-agent here; freelance-expert and
// issue-fixer aren't in this map). They run without a human watching and must never
// raise a blocking dialog — they escalate via channels/notify instead.
const NO_HUMAN_INPUT_AGENTS = new Set(["playground-agent", "freelance-expert", "issue-fixer"]);
for (const key of Object.keys(defaultAgentTools)) {
	if (NO_HUMAN_INPUT_AGENTS.has(key)) continue;
	if (!defaultAgentTools[key].includes("request_human_input")) {
		defaultAgentTools[key] = [...defaultAgentTools[key], ...COMMUNICATION];
	}
}

// Every interactive agent gets the memory tools (save/recall/delete) by default
// so it can remember per-project learnings and user "remember this" requests.
// Existing installs pick these up via seedAgentTools()'s "add missing default
// tools" pass. EXCEPT the Playground agent — it runs in an isolated, project-less
// sandbox where memory has nothing to scope to. Assistant is also excluded: its
// save_memory/recall_memory/delete_memory are bound to the Assistant-exclusive
// general_chat_memories table via extraTools injection, NOT the shared,
// project-scoped agent_memories tool implementation these MEMORY tool rows
// would otherwise wire up.
const NO_MEMORY_AGENTS = new Set(["playground-agent", "general-chat-assistant"]);
for (const key of Object.keys(defaultAgentTools)) {
	if (NO_MEMORY_AGENTS.has(key)) continue;
	const missing = MEMORY.filter((t) => !defaultAgentTools[key].includes(t));
	if (missing.length > 0) {
		defaultAgentTools[key] = [...defaultAgentTools[key], ...missing];
	}
}

/**
 * Returns the default tool names for a given agent name.
 * Used by the reset-to-defaults RPC.
 */
export function getDefaultAgentTools(agentName: string): string[] {
	const tools = defaultAgentTools[agentName];
	if (!tools) return [];
	return [...new Set(tools)];
}
