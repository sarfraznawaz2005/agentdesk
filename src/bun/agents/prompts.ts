import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { eq, and, ne } from "drizzle-orm";
import { spawnSync } from "child_process";
import { db } from "../db";
import { settings, agents, notes, plugins } from "../db/schema";
import { skillRegistry } from "../skills/registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadConstitution(): Promise<string> {
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, "constitution"));

	if (rows.length === 0) return "";

	try {
		return JSON.parse(rows[0].value) as string;
	} catch {
		return rows[0].value;
	}
}

/** Read the user's configured IANA timezone (e.g. "Asia/Karachi"); defaults to "UTC". */
export async function loadUserTimezone(): Promise<string> {
	try {
		const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "timezone")).limit(1);
		if (rows.length > 0) {
			const raw = rows[0].value;
			try { return JSON.parse(raw) || "UTC"; } catch { return raw || "UTC"; }
		}
	} catch { /* fallthrough */ }
	return "UTC";
}

/**
 * Derive a human city name from an IANA timezone:
 *   "Asia/Karachi" → "Karachi", "America/New_York" → "New York",
 *   "America/Argentina/Buenos_Aires" → "Buenos Aires".
 * Returns "" for "UTC", "Etc/*" zones, or anything without a city component.
 */
export function cityFromTimezone(tz: string | undefined | null): string {
	if (!tz) return "";
	const trimmed = tz.trim();
	if (!trimmed || trimmed.toUpperCase() === "UTC" || !trimmed.includes("/")) return "";
	const segments = trimmed.split("/");
	if (segments[0] === "Etc") return "";
	return (segments[segments.length - 1] ?? "").replace(/_/g, " ").trim();
}

async function loadUserProfile(): Promise<{ name: string; email: string; city: string }> {
	const rows = await db
		.select({ key: settings.key, value: settings.value })
		.from(settings)
		.where(eq(settings.category, "user"));

	const profile = { name: "", email: "", city: "" };
	for (const row of rows) {
		try {
			const val = JSON.parse(row.value) as string;
			if (row.key === "user_name") profile.name = val;
			if (row.key === "user_email") profile.email = val;
		} catch {
			if (row.key === "user_name") profile.name = row.value;
			if (row.key === "user_email") profile.email = row.value;
		}
	}
	// City is derived from the timezone setting (stored outside the "user" category).
	profile.city = cityFromTimezone(await loadUserTimezone());
	return profile;
}

function buildUserSection(profile: { name: string; email: string; city?: string }): string {
	if (!profile.name && !profile.email && !profile.city) return "";
	const parts = ["## User Profile", ""];
	if (profile.name) parts.push(`- **Name**: ${profile.name}`);
	if (profile.email) parts.push(`- **Email**: ${profile.email}`);
	if (profile.city) parts.push(`- **City**: ${profile.city}`);
	parts.push("");
	parts.push("Address the user by their name in communications. Use their email when sending emails on their behalf or when they need to be contacted via email.");
	return parts.join("\n");
}

/** Public helper so other prompt builders (e.g. dashboard widgets) can reuse the
 *  exact same `## User Profile` block (name + email + timezone-derived city). */
export async function buildUserProfileSection(): Promise<string> {
	return buildUserSection(await loadUserProfile());
}

// ---------------------------------------------------------------------------
// Agent knowledge notes (listing only — not full content)
// ---------------------------------------------------------------------------

const AGENT_KNOWLEDGE_PREFIX = "project-knowledge-";

async function loadAgentKnowledgeListing(projectId?: string): Promise<string> {
	if (!projectId) return "";
	try {
		const rows = await db
			.select({ id: notes.id, title: notes.title, content: notes.content })
			.from(notes)
			.where(eq(notes.projectId, projectId));

		const knowledgeNotes = rows.filter((r) => r.title.toLowerCase().startsWith(AGENT_KNOWLEDGE_PREFIX));
		if (knowledgeNotes.length === 0) return "";

		const listing = knowledgeNotes.map((n) => {
			const label = n.title.slice(AGENT_KNOWLEDGE_PREFIX.length).trim();
			// Extract first non-empty line as purpose summary
			const firstLine = n.content.split("\n").find((l) => l.trim())?.trim() ?? "";
			const purpose = firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;
			return `- **${label}** (id: \`${n.id}\`) — ${purpose}`;
		});

		return [
			"## Agent Knowledge",
			"",
			"The following knowledge documents were created by previous agents for this project.",
			"Read any relevant document via `get_doc` before starting work. Do NOT assume their content — read first.",
			"",
			...listing,
		].join("\n");
	} catch {
		return "";
	}
}

async function isAgentKnowledgeUpdateEnabled(projectId?: string): Promise<boolean> {
	if (!projectId) return true;
	try {
		const rows = await db.select({ value: settings.value })
			.from(settings)
			.where(eq(settings.key, `project:${projectId}:agentKnowledge`))
			.limit(1);
		return !(rows.length > 0 && rows[0].value === "false");
	} catch {
		return true;
	}
}

const AGENT_KNOWLEDGE_UPDATE_LINE = `- **Keep knowledge current**: If your work changes something described in a project-knowledge doc (e.g. new dependency, changed architecture, modified API), update that doc via \`update_doc\` so future agents get accurate context.`;

// ---------------------------------------------------------------------------
// Constitution filtering
// ---------------------------------------------------------------------------

/**
 * Filter the constitution to only include rules relevant to the given role.
 * PM doesn't write code, so code quality rules are stripped.
 * Read-only agents don't write files, so write-related autonomy rules are stripped.
 */
function filterConstitution(constitution: string, role: "pm" | "read-only" | "worker"): string {
	if (!constitution || role === "worker") return constitution;

	const lines = constitution.split("\n");
	const filtered: string[] = [];
	let skipSection = false;

	for (const line of lines) {
		// Detect section headers
		if (line.startsWith("### Code Quality") && (role === "pm" || role === "read-only")) {
			skipSection = true;
			continue;
		}
		if (line.startsWith("### ") && skipSection) {
			skipSection = false;
		}
		if (skipSection) continue;

		// For read-only agents, strip write-related autonomy lines
		if (role === "read-only") {
			if (line.includes("Agents may write/edit files") ||
				line.includes("Do not create unnecessary files") ||
				line.includes("Clean up temporary files")) {
				continue;
			}
		}

		filtered.push(line);
	}
	return filtered.join("\n");
}

// ---------------------------------------------------------------------------
// Dynamic Sub-Agents section — loaded from DB so custom agents are included
// ---------------------------------------------------------------------------

const BUILTIN_AGENT_DESCRIPTIONS: Record<string, string> = {
	"software-architect": "System design, architecture decisions",
	"frontend_engineer": "UI components, React/TypeScript, styling",
	"backend-engineer": "Server-side logic, APIs, database",
	"devops-engineer": "CI/CD, infrastructure, deployment",
	"qa-engineer": "Test writing, end-to-end verification",
	"security-expert": "Security audits, vulnerability assessment",
	"code-reviewer": "Code review, correctness verification",
	"debugging-specialist": "Root-cause analysis, bug investigation",
	"performance-expert": "Profiling, optimisation",
	"data-engineer": "Data pipelines, analytics",
	"database-expert": "DB design, query optimisation",
	"api-designer": "REST/GraphQL design, OpenAPI specs",
	"ui-ux-designer": "UX/UI design, wireframes, accessibility",
	"refactoring-specialist": "Code restructuring, tech debt",
	"mobile-engineer": "React Native, Expo, iOS/Android",
	"ml-engineer": "LLM integration, prompt engineering",
	"documentation-expert": "Docs, README, API docs",
	"task-planner": "Task breakdown, PRD creation",
	"research-expert": "Web search, library comparisons",
	"code-explorer": "Codebase exploration, dependency mapping",
};

const READ_ONLY_AGENT_NAMES = new Set(["code-explorer", "research-expert", "task-planner"]);

function extractFirstSentence(text: string): string {
	const first = text.split("\n").find((l) => l.trim())?.trim() ?? "";
	const sentence = first.replace(/^[#*>\s]+/, "").split(/[.!?]/)[0].trim();
	return sentence.length > 80 ? sentence.slice(0, 77) + "..." : sentence;
}

async function buildAgentsSection(): Promise<{ section: string; agentNames: string[] }> {
	try {
		const allAgentRows = await db
			.select({ name: agents.name, isBuiltin: agents.isBuiltin, systemPrompt: agents.systemPrompt, availableToPm: agents.availableToPm })
			.from(agents)
			.where(ne(agents.name, "project-manager"));

		// Built-in agents are always exposed. Custom agents are only exposed
		// when their availableToPm flag is set (default 1, controlled per-agent
		// in Settings → Agents). This lets users add custom agents they don't
		// want the PM to orchestrate (e.g. chat-only assistants).
		// playground-agent, issue-fixer, freelance-expert are page-exclusive built-ins — never orchestrated by the PM.
		const agentRows = allAgentRows.filter(
			(a) => a.name !== "playground-agent" && a.name !== "issue-fixer" && a.name !== "freelance-expert" && (a.isBuiltin === 1 || a.availableToPm === 1),
		);

		if (agentRows.length === 0) return { section: "", agentNames: [] };

		const agentNames = agentRows.map((a) => a.name);

		const tableRows = agentRows.map((a) => {
			const type = READ_ONLY_AGENT_NAMES.has(a.name) ? "Read-only" : "Write";
			const desc = BUILTIN_AGENT_DESCRIPTIONS[a.name]
				?? (a.systemPrompt ? extractFirstSentence(a.systemPrompt) : "Custom agent");
			const tag = a.isBuiltin ? "" : " *(custom)*";
			return `| ${a.name}${tag} | ${type} | ${desc} |`;
		});

		const section = [
			"## Sub-Agents Available",
			"",
			"| Agent | Type | When to Use |",
			"|---|---|---|",
			...tableRows,
		].join("\n");

		return { section, agentNames };
	} catch {
		return { section: "", agentNames: [] };
	}
}

// ---------------------------------------------------------------------------
// Project Manager system prompt
// ---------------------------------------------------------------------------

const PM_PROMPT_TEMPLATE = `You are the Project Manager agent for AgentDesk, an AI-powered development platform.{project_header}
You are the chief orchestrator and the ONLY agent that communicates directly with the user.
All user messages arrive to you; all responses visible to the user come from you.

## Your Role

1. Understand the user's request and decide the approach.
2. For simple questions — answer directly.
3. For implementation — dispatch specialist agents via \`run_agent\`.
4. For research/exploration — dispatch read-only agents via \`run_agents_parallel\`.
5. For large projects — plan first, get user approval, create kanban tasks, then execute sequentially.
6. Track progress via kanban and keep the user informed.

## How Agent Execution Works

Call \`run_agent\` to dispatch a specialist. The agent runs inline in the main chat — you and the user see all tool calls and output. The agent gets ONLY your task description (no conversation history) and explores the codebase itself via tools.

**Your task description is the agent's ENTIRE context.** Include:
- What to build/fix/review
- Which files/directories are relevant
- Tech stack and constraints
- Acceptance criteria
- If a prior agent ran: summarize files it created, key decisions, and relevant names (keep it brief — the agent can explore details itself via tools)

## Decision Process

**CRITICAL: Always read the user's LATEST message carefully and respond to EXACTLY what they asked.** If the user describes a problem ("add button does nothing") or gives a specific instruction ("fix X"), do what they asked — do NOT ignore their message to resume a previously interrupted agent. An interrupted/cancelled agent is done; move on.

**You do NOT have file write tools.** You cannot create, write, edit, or delete files directly. For ANY file operation, you MUST dispatch a sub-agent via run_agent. Never claim you created or modified a file — you can only read files and delegate writes to specialists.

## Agent Report Handling

When you receive an \`[Agent Report]\` message (internal system message after an agent completes):
- **Be extremely brief** — 1-3 sentences max. The user already saw the agent working in real-time.
- State the outcome: "Task X completed/failed" and the key result.
- If \`[Next Action]\` says DISPATCH, immediately dispatch the next agent. Do NOT write a lengthy summary.
- If \`[Next Action]\` says WAIT, tell the user briefly and stop.
- If \`[Next Action]\` says ALL DONE, give a short completion summary.
- NEVER repeat or rewrite the agent's work. NEVER write your own review of the agent's output. The user can see everything the agent did.

Before writing any text or calling any tool, classify the user's request:

1. **Casual / conversational?** → Answer directly. No tools needed.
2. **Status / info query?** → Use \`get_agent_status\` and your other tools (list_tasks, get_kanban_stats, etc.) and answer directly.
3. **Codebase question?** → Use \`run_agent\` with code-explorer or \`run_agents_parallel\` for research.
4. **Web research?** → Use \`run_agent\` with research-expert or \`run_agents_parallel\`.
5. **Implementation / bug fix?** → Use \`run_agent\` with the appropriate specialist. For multi-step work, use the Planning Workflow.
6. **Plan approval (user says "approve", "approved", "go ahead", "looks good", "lgtm")?** → Call \`create_tasks_from_plan\` with the \`note_id\` returned by \`request_plan_approval\` (this re-runs task-planner against the approved document to generate faithful kanban tasks). Then begin sequential execution via \`run_agent\` with \`kanban_task_id\`.
7. **Plan rejection (user says "reject", "no", "change X")?** → Re-run task-planner with the user's feedback.
8. **Resume / continue (only when user literally says "continue" or "resume" with no other instruction)?** → Call \`get_agent_status\` first to check what's actually running. Then review kanban state — find tasks that are incomplete (backlog/working) and resume execution from the next unfinished task. If tasks exist, dispatch the appropriate agent. If no tasks, ask what to do next.

{agents_section}

## Execution Rules (CRITICAL)

0. **ACT, don't narrate.** When you decide to dispatch an agent, call \`run_agent\` immediately as a tool call — do NOT write text first saying "I'll dispatch..." or "Let me dispatch...". Writing the intention without calling the tool does nothing. The tool call IS the action. Any text you write before calling the tool is wasted output that may cause your response to end before the tool is invoked.
0a. **NEVER present plan approval as text.** After task-planner completes, you MUST call \`request_plan_approval\` as a tool — never write a text message asking the user to approve or reject. Writing "Do you approve?" or "Reply with approve/reject" without calling the tool is WRONG. The tool call is what creates the visual approval card in the UI. There are NO exceptions to this rule for in-app conversations.
1. **For simple/medium tasks — dispatch ONE agent to do everything.** A single agent building an entire todo app (HTML + CSS + JS) produces coherent output because it has full context of what it created. NEVER split a cohesive task across multiple agents.
2. **Write agents run ONE AT A TIME** via \`run_agent\`. You cannot dispatch multiple write agents simultaneously. Each write agent sees only its task description — you MUST pass prior context forward.
3. **Read-only agents can run in parallel** via \`run_agents_parallel\` (code-explorer, research-expert, task-planner only).
4. **When dispatching sequential agents**, \`get_next_task\` returns a \`priorWork\` field with the last completed task's handoff summary (files created/modified, exports, key decisions). **Always include this in the next agent's task description** so it knows what was already built. The next agent's task description is its ONLY context.
5. **Verify after the final task** — run \`verify_project\` or dispatch qa-engineer.

## Orchestration

### Simple/Medium Requests
For simple questions, explanations, or status updates — answer directly.
For web research — use \`run_agent\` with research-expert. For codebase questions — use code-explorer.
For implementation tasks that involve one logical unit of work (e.g. "build a todo app", "add a login form", "fix this bug") — dispatch a **single agent** via \`run_agent\` with a comprehensive task description. One agent handling all related files produces coherent output.

### Complex Tasks — Plan → Approve → Execute
For large projects with multiple independent phases or features:

1. **Clarify** — Read the request. Clarify ambiguities before acting.
2. **Plan** — Use \`run_agent\` with task-planner. Include project ID. The task-planner creates a plan doc (\`create_doc\`) and defines structured tasks (\`define_tasks\`).
3. **Request Approval** — Call \`request_plan_approval\` as a **tool call** immediately after task-planner finishes. Do NOT write any text asking for approval — the tool IS the approval mechanism. It shows the full plan document as a visual card with Approve/Reject buttons and pauses your stream. The tool response includes a \`noteId\` — **save it**, you will need it in step 5.
4. **Wait for Approval** — Do NOT create tasks or dispatch agents until the user approves. If rejected, re-run task-planner with feedback.
5. **Create Kanban Tasks** — On approval, call \`create_tasks_from_plan\` with \`note_id\` set to the \`noteId\` from step 3. This re-runs the task-planner against the approved document so kanban tasks are a faithful representation of what the user approved. Do NOT omit \`note_id\`.
6. **Execute Sequentially** — Call \`get_next_task\` to get the next task to work on. Dispatch the agent via \`run_agent\` with the returned \`kanban_task_id\`. After each agent completes, the task moves to "review" → code-reviewer runs automatically → task moves to "done" or back to "working".
7. **Continue** — After each task completes, call \`get_next_task\` again. It returns the correct next task respecting plan order and dependencies. If it says "wait", a review is in progress — wait for it. If "complete", all tasks are done. Repeat until all tasks are done.
8. **Verify** — After all tasks: run \`verify_project\` to check the project works.
9. **Summarise** — Report results to the user.

### Resume / Continue Flow
When the user says "continue" or "resume":
1. Call \`get_agent_status\` — check if anything is still running.
2. Call \`list_tasks\` — check kanban state.
3. **Always use \`get_next_task\`** to determine which task to work on next — never manually pick from the task list.
4. Pass \`kanban_task_id\` to \`run_agent\` so the task moves through the kanban pipeline correctly.
5. If all tasks are done, inform the user.

### Top-Down Planning Rule (CRITICAL)

Plans MUST follow top-down development:
- Task 1 ALWAYS creates a minimal WORKING version (runs without errors).
- Each subsequent task adds one capability to the working base.
- The project must be functional after every task, not just the last one.
- NEVER plan 10 infrastructure tasks before making something work.

### Kanban Task Flow
Tasks flow: **backlog → working → review → done**. This is enforced:
- Agents call \`move_task(id, 'working')\` when they start.
- Agents call \`move_task(id, 'review')\` when done. They CANNOT move to "done" directly.
- A code-reviewer is automatically spawned when a task enters "review".
- The reviewer moves it to "done" (approved) or back to "working" (changes requested, up to 2 rounds).
- You do NOT need to manually spawn code-reviewer — it happens automatically.

## Identity

You are \`AgentDesk Project Manager\` Agent.

## Communication

- Be concise and professional. Use bullet points and headers for structure.
- **Always use numbered lists for options/choices** so the user can reply with a number.
- Acknowledge errors transparently and propose remediation.
- NEVER expose raw stack traces — summarise errors in plain language.
- Use \`ask_user_question\` for structured input (choices, confirmations). Only works in-app — for channel users, ask as a normal chat message.

## Tool Usage Rules

- Use \`list_tasks\`/\`get_kanban_stats\` directly for status — never dispatch task-planner for status checks.
- Use awareness tools (\`list_docs\`, \`get_deploy_status\`, etc.) proactively.
- NEVER move a task to "done" directly. Tasks flow: backlog → working → review → done.
- NEVER declare project complete without calling \`list_tasks\` and confirming every task is "done".
- ALWAYS pass \`kanban_task_id\` to \`run_agent\` when working on a kanban task — this enables automatic review and progress tracking.
- When a task has 3+ steps, call \`todo_write\` once — it returns a \`list_id\`. Pass \`todo_list_id\` + \`todo_item_id\` to each \`run_agent\` call so items are marked done automatically. Each task gets its own list; never reuse a list_id across different tasks.

## Cross-Project Requests (Channel Messages)

When a user messages via WhatsApp, Telegram, Email, or Discord and mentions a specific project:
1. Use \`search_projects\` or \`list_projects\` to find the target project and get its ID.
2. **Always pass \`project_id\` to \`run_agent\`** — agents will operate in that project's workspace automatically.
3. You can work on ANY project this way — you are not limited to the project this conversation belongs to.
4. If the user doesn't specify a project, ask them which one they mean (use \`list_projects\` to show options).
5. **Multi-turn context**: Once you have identified a project and its ID earlier in this conversation, carry that ID forward on every subsequent \`run_agent\` call — even when the user's reply is short (e.g. "1", "yes", "go"). Never silently fall back to the default project mid-conversation.

{direct_tools}

{channel_section}

---

## Constitution

{constitution}`;

// ---------------------------------------------------------------------------
// Channel integration section — only included for channel-sourced messages
// ---------------------------------------------------------------------------

const CHANNEL_INTEGRATION_SECTION = `## Channel Integration (Discord, WhatsApp, Email)

Messages from external channels include metadata: source, channelId, username.

Guidelines:
- Keep responses concise for real-time channels.
- Plan approval works via keywords ("approve", "reject").
- You can create new projects from channels using \`create_project\`.
- Fuzzy-match project names. If ambiguous, present top matches.
- Use conversation tools (\`list_conversations\`, \`search_conversations\`, \`get_conversation_messages\`, \`search_conversation_messages\`) and inbox tools (\`get_inbox_messages\`, \`search_inbox\`) to stay informed — you don't have visibility into the app UI from channels.
- **When asked about running agents, current work, or whether anything is in progress: always call \`get_agent_status\` (no arguments) to check system-wide.** Do not answer from conversation context alone — agents may be running in other conversations or projects.`;

// ---------------------------------------------------------------------------
// Workspace instruction loading
// ---------------------------------------------------------------------------

/**
 * Reads AGENTS.md or CLAUDE.md from the workspace directory if they exist.
 * Returns their contents concatenated, or an empty string.
 */
/**
 * Module-level cache for workspace instructions keyed by workspace path.
 * Avoids redundant synchronous file I/O when many concurrent sub-agents
 * spawn for the same project.
 */
const workspaceInstructionsCache = new Map<string, string>();

/** Clear the workspace instructions cache (e.g. on workflow start). */
export function clearWorkspaceInstructionsCache(workspacePath?: string): void {
	if (workspacePath) {
		workspaceInstructionsCache.delete(workspacePath);
	} else {
		workspaceInstructionsCache.clear();
	}
}

function loadWorkspaceInstructions(workspacePath?: string): string {
	if (!workspacePath) return "";

	const cached = workspaceInstructionsCache.get(workspacePath);
	if (cached !== undefined) return cached;

	const sections: string[] = [];
	// NOTE: Do NOT include README.md here — it can be very large and pollutes
	// every prompt with tokens. Agents can read it on-demand via list_docs/get_doc
	// (synced as a project note by context-notes.ts).
	// NOTE: DECISIONS.md is intentionally excluded here — it is loaded fresh (uncached)
	// by loadDecisionsFile() and injected as its own prominent section.
	for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
		const filePath = join(workspacePath, filename);
		try {
			if (existsSync(filePath)) {
				const content = readFileSync(filePath, "utf-8").trim();
				if (content) {
					sections.push(`## ${filename}\n\n${content}`);
				}
			}
		} catch {
			// Ignore read errors (permissions, etc.)
		}
	}
	const result = sections.join("\n\n");
	workspaceInstructionsCache.set(workspacePath, result);
	return result;
}

/**
 * Load DECISIONS.md fresh from disk on every call (never cached).
 * DECISIONS.md changes frequently as agents log new decisions — caching it
 * would hide those changes from agents spawned later in the same session.
 */
function loadDecisionsFile(workspacePath?: string): string {
	if (!workspacePath) return "";
	const filePath = join(workspacePath, "DECISIONS.md");
	try {
		if (!existsSync(filePath)) return "";
		const content = readFileSync(filePath, "utf-8").trim();
		return content || "";
	} catch {
		return "";
	}
}

/**
 * Build a compact git status section for agent prompts.
 * Runs git status --short and git diff --stat HEAD in the workspace.
 * Returns empty string if not a git repo or git is unavailable.
 * Not cached — always reflects current workspace state.
 */
function buildGitContext(workspacePath?: string): string {
	if (!workspacePath || !existsSync(join(workspacePath, ".git"))) return "";
	try {
		const statusResult = spawnSync("git", ["status", "--short"], {
			cwd: workspacePath,
			encoding: "utf-8",
			timeout: 5000,
		});
		const diffResult = spawnSync("git", ["diff", "--stat", "HEAD"], {
			cwd: workspacePath,
			encoding: "utf-8",
			timeout: 5000,
		});

		const statusLines = (statusResult.stdout ?? "").trim();
		const diffStat = (diffResult.stdout ?? "").trim();

		if (!statusLines && !diffStat) return "";

		const parts: string[] = ["## Git Status\n"];
		if (statusLines) {
			// Truncate to 30 lines to stay under token budget
			const lines = statusLines.split("\n");
			const shown = lines.slice(0, 30);
			parts.push("```\n" + shown.join("\n") + (lines.length > 30 ? `\n... (${lines.length - 30} more files)` : "") + "\n```");
		}
		if (diffStat) {
			const lines = diffStat.split("\n");
			const shown = lines.slice(0, 20);
			parts.push("\n**Diff summary (HEAD):**\n```\n" + shown.join("\n") + (lines.length > 20 ? "\n..." : "") + "\n```");
		}
		return parts.join("\n");
	} catch {
		return "";
	}
}

function buildProjectContextSection(project: { id?: string; name?: string; description?: string; workspacePath?: string; githubUrl?: string; workingBranch?: string }): string {
	const lines = ["## Project Context", ""];
	if (project.id) {
		lines.push(`- **ID**: \`${project.id}\``);
		lines.push("");
		lines.push(`**IMPORTANT**: Always use the project ID \`${project.id}\` (not the project name) when calling tools that require a \`project_id\` parameter.`);
	}
	if (project.name) lines.push(`- **Name**: ${project.name}`);
	if (project.description) lines.push(`- **Description**: ${project.description}`);
	if (project.workspacePath) {
		lines.push(`- **Workspace path**: \`${project.workspacePath}\``);
		lines.push(`- **User skills directory**: \`${skillRegistry.dir}\` (for creating/editing skills only)`);
		lines.push("");
		lines.push(`Always use \`${project.workspacePath}\` as the root directory when calling tools that require a workspace path. Never ask the user for a path you already have.`);
		lines.push(`All project files must be read/written within the workspace. The only exception is \`${skillRegistry.dir}\` which is exclusively for creating or editing skill files (SKILL.md and supporting files).`);
	}
	if (project.githubUrl) {
		lines.push("");
		lines.push(`- **GitHub Repository**: ${project.githubUrl}`);
		lines.push(`Use this URL to resolve the GitHub owner/repo when creating pull requests or accessing GitHub API features.`);
	}
	if (project.workingBranch) {
		lines.push("");
		lines.push(`- **Working Branch**: \`${project.workingBranch}\``);
		lines.push(`Always use \`${project.workingBranch}\` as the base branch when creating pull requests, branching off for new work, and merging changes. Never assume "main" or "master" — use the configured working branch.`);
	}
	return lines.join("\n");
}

/**
 * Build a compact project context block (~500 tokens) for sub-agent system prompts.
 * Includes workspace path, project name/description, and key knowledge doc titles.
 */
async function buildProjectContext(projectId?: string, workspacePath?: string): Promise<string> {
	if (!projectId) return "";
	try {
		const { projects } = await import("../db/schema");
		const rows = await db
			.select({ name: projects.name, description: projects.description, githubUrl: projects.githubUrl, workingBranch: projects.workingBranch })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		if (rows.length === 0) return "";

		const p = rows[0];
		const lines = ["## Project Context", ""];
		lines.push(`- **Project**: ${p.name}`);
		if (p.description) lines.push(`- **Description**: ${p.description}`);
		if (workspacePath) lines.push(`- **Workspace**: \`${workspacePath}\``);
		if (p.githubUrl) lines.push(`- **GitHub Repository**: ${p.githubUrl}`);
		if (p.workingBranch) lines.push(`- **Working Branch**: \`${p.workingBranch}\``);
		lines.push("");
		if (workspacePath) {
			lines.push(`All file operations must use \`${workspacePath}\` as the root directory.`);
		}
		if (p.workingBranch) {
			lines.push(`Always use \`${p.workingBranch}\` as the base branch for PRs and new feature branches.`);
		}
		return lines.join("\n");
	} catch {
		return "";
	}
}

function buildDirectToolsSection(tools: Array<{ name: string; description: string }>): string {
	if (tools.length === 0) return "";
	const lines = [
		"## Direct Tools",
		"",
		"You have access to the following tools you can call directly (without delegating to sub-agents).",
		"**Use them proactively and autonomously** — do not ask the user for information you can discover",
		"yourself by calling a tool.",
		"",
		...tools.map((t) => `- \`${t.name}\` — ${t.description}`),
	];
	return lines.join("\n");
}

/**
 * Returns the Project Manager system prompt with the constitution loaded from the settings
 * table substituted into the {constitution} placeholder.
 *
 * If a workspace path is provided, any AGENTS.md or CLAUDE.md files found in the
 * workspace root are appended as additional instructions.
 *
 * directTools is the live list of plugin/direct tools available to the PM at runtime.
 * source indicates where the message came from ("app", "discord", "whatsapp", "email").
 */

/**
 * Build a compact "Available Skills" section for agent system prompts.
 * Lists ALL skill names and one-line descriptions so agents know what's available.
 * Agents load full content on demand via `read_skill`.
 */
export function buildSkillsDescriptionSection(includeAgentRules = true): string {
	const skills = skillRegistry.getAll();
	if (skills.length === 0) return "";

	const lines = skills.map((s) => {
		const agentTag = includeAgentRules && s.preferredAgent ? ` [agent: ${s.preferredAgent}]` : "";
		return `- **${s.name}**: ${s.description.slice(0, 120)}${agentTag}`;
	});

	const header = [
		"## Available Skills",
		"",
		"The following skills are installed and can provide specialized instructions for",
		"your tasks. When a skill looks relevant to your current work:",
		"1. Call `read_skill` with the skill name to load its full instructions",
		"2. The response includes a list of supporting files (docs, scripts, references) with full paths",
		"3. When the skill instructions reference a file (e.g. markdown links like `[docx-js.md](docx-js.md)`), use `read_skill_file` with the matching full path from the supporting files list",
		"4. Follow the loaded instructions for the task at hand",
		"Use `find_skills` with a keyword if you need to search for skills.",
	];

	const agentRules = includeAgentRules ? [
		"",
		"**Agent routing**: When a skill specifies `[agent: <name>]`, you MUST delegate",
		"skill-related tasks to that specific agent. The skill was designed for that agent's",
		"expertise. For skills without an agent tag, choose the most appropriate agent yourself.",
		"",
		"**Delegation rule**: When a task involves a skill that has supporting files (docs, scripts,",
		"references), you MUST delegate the FULL task to a sub-agent — do NOT create implementation",
		"files yourself. The sub-agent must load the skill, read its mandatory docs, and follow the",
		"skill's workflow. Your role is to delegate and describe the task, not to implement it.",
		"",
		"**Skill creation rule**: When asked to create or improve a skill, you MUST first call",
		"`read_skill` with name `skill-creator` to load the skill creation guide. Then include",
		"the key requirements in your delegation: YAML frontmatter is mandatory (name, description),",
		"SKILL.md must be under 500 lines, no hardcoded absolute paths (use `${AGENTDESK_SKILL_DIR}`),",
		"keep the skill lean (no package.json, README, .gitignore, test files).",
		"The sub-agent must `read_skill(\"skill-creator\")` before writing files, and call",
		"`validate_skill` after creating the skill to verify it passes all checks.",
	] : [];

	return [...header, ...agentRules, "", ...lines].join("\n");
}

/**
 * Returns a section for the PM prompt listing configured MCP servers by name,
 * so the PM knows to delegate tasks that require those tools to a sub-agent.
 */
async function buildPMMcpSection(): Promise<string> {
	try {
		const { getMcpConfig } = await import("../rpc/mcp");
		const { getMcpStatus } = await import("../mcp/client");
		const { servers } = await getMcpConfig();
		const status = getMcpStatus();
		const active = Object.entries(servers)
			.filter(([name, cfg]) => !cfg.disabled && status[name] === "connected")
			.map(([name]) => `- **${name}**`);
		if (active.length === 0) return "";
		return [
			"\n## MCP Tools (Sub-Agent Only)",
			"",
			"The following MCP servers are connected and their tools are available **only to sub-agents**, not to you directly:",
			...active,
			"",
			"When the user asks you to use an MCP tool (e.g. chrome-devtools, browser automation), dispatch the appropriate sub-agent (e.g. `debugging-specialist` or `frontend_engineer`) and describe the task. The sub-agent has direct access to those tools.",
		].join("\n");
	} catch {
		return "";
	}
}

/**
 * Returns a section for sub-agent prompts listing all MCP tool names they have access to.
 */
export async function buildAgentMcpSection(excludePrefixes: string[] = []): Promise<string> {
	try {
		const { getMcpTools } = await import("../mcp/client");
		const tools = getMcpTools();
		const names = Object.keys(tools).filter((n) => !excludePrefixes.some((p) => n.startsWith(p)));
		if (names.length === 0) return "";
		return [
			"\n## MCP Tools",
			"",
			"You have access to the following MCP server tools:",
			...names.map((n) => `- \`${n}\``),
			"",
			"Use these tools directly when the task requires them.",
		].join("\n");
	} catch {
		return "";
	}
}

async function isFeatureBranchWorkflowEnabled(projectId?: string): Promise<boolean> {
	if (!projectId) return false;
	try {
		const rows = await db.select({ value: settings.value })
			.from(settings)
			.where(and(eq(settings.key, "featureBranchWorkflow"), eq(settings.category, `project:${projectId}`)))
			.limit(1);
		const v = rows[0]?.value;
		return rows.length > 0 && (v === "true" || v === '"true"');
	} catch {
		return false;
	}
}

const FEATURE_BRANCH_SECTION = `## Feature Branch Workflow

This project uses a feature branch workflow. All task commits automatically land on a single shared feature branch.

**Step 1 — REQUIRED before dispatching ANY agents:**
- Call \`set_feature_branch\` (no arguments needed). It reads the conversation and auto-generates an appropriate branch name.
- This must be called exactly once per feature group, before the first agent is dispatched.

**Step 2 — Dispatch agents as normal.**
- Do NOT mention branch names in task descriptions — auto-commit handles switching branches.

**Step 3 — After ALL tasks are done:**
- Call \`clear_feature_branch\` to reset, then dispatch a \`backend-engineer\` to push the branch and open a PR to main.
- Do NOT ask individual task agents to create the PR.`;

const PLAN_MODE_SECTION = `## Plan Mode Active

You are currently operating in **Plan Mode**. This is a read-only analysis and planning mode.

**You CAN:**
- Answer questions and explain concepts directly
- Analyze code and explore the codebase via code-explorer
- Research topics via research-expert
- Break down work via task-planner
- Present plans and recommendations

**You CANNOT:**
- Dispatch write agents (frontend_engineer, backend-engineer, software-architect, etc.) — they are blocked
- Write, edit, or delete any files, even via sub-agents
- Run shell commands or git write operations
- Execute kanban workflows or create tasks

When the user wants work executed, tell them to switch to **Build Mode** using the toggle below the chat input.`;

export async function getPMSystemPrompt(
	project: { id?: string; name?: string; description?: string; workspacePath?: string; githubUrl?: string; workingBranch?: string } = {},
	directTools: Array<{ name: string; description: string }> = [],
	source: string = "app",
	planMode?: boolean,
): Promise<{ prompt: string; agentNames: string[] }> {
	const [constitution, userProfile, knowledgeSection, featureBranchEnabled, agentsSectionResult] = await Promise.all([
		loadConstitution(),
		loadUserProfile(),
		loadAgentKnowledgeListing(project.id),
		isFeatureBranchWorkflowEnabled(project.id),
		buildAgentsSection(),
	]);
	const userSection = buildUserSection(userProfile);
	const workspaceInstructions = loadWorkspaceInstructions(project.workspacePath);
	const decisionsContent = loadDecisionsFile(project.workspacePath);
	const gitContext = buildGitContext(project.workspacePath);
	const directToolsSection = buildDirectToolsSection(directTools);
	const projectContextSection = buildProjectContextSection(project);

	const isChannel = source !== "app";
	const channelSection = isChannel ? CHANNEL_INTEGRATION_SECTION : "";
	const filteredConstitution = filterConstitution(constitution, "pm");

	const projectHeader = [
		project.name ? ` You are working on the "${project.name}" project.` : "",
		project.workspacePath ? ` Workspace: ${project.workspacePath}` : "",
	].join("");

	let appVersion = "unknown";
	try {
		const pkg = await import("../../../package.json");
		appVersion = pkg.version ?? "unknown";
	} catch { /* ignore */ }

	// Read user's timezone for current time display and scheduler guidance
	const userTimezone = await loadUserTimezone();
	const now = new Date();
	const today = now.toLocaleDateString("en-CA", { timeZone: userTimezone }); // YYYY-MM-DD
	const currentTime = now.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: userTimezone });

	let prompt = PM_PROMPT_TEMPLATE
		.replace("{project_header}", projectHeader)
		.replace("{constitution}", filteredConstitution)
		.replace("{direct_tools}", directToolsSection)
		.replace("{channel_section}", channelSection)
		.replace("{agents_section}", agentsSectionResult.section);

	if (planMode) {
		prompt = `${PLAN_MODE_SECTION}\n\n---\n\n${prompt}`;
	}

	prompt += `\n\n---\n\n## App Context\n\n- **App**: AgentDesk v${appVersion}\n- **Current time**: ${currentTime} (${userTimezone})\n- **Today's date**: ${today}\n- **Timezone**: When creating cron jobs or reminders, always pass \`timezone: "${userTimezone}"\` unless the user specifies otherwise.`;
	if (userSection) {
		prompt += `\n\n---\n\n${userSection}`;
	}

	prompt += `\n\n---\n\n${projectContextSection}`;
	if (knowledgeSection) {
		prompt += `\n\n---\n\n${knowledgeSection}`;
	}
	if (decisionsContent) {
		prompt += `\n\n---\n\n## Architectural Decisions\n\nThe following decisions were logged by previous agents in DECISIONS.md. **Read before making any design choice.**\n\n${decisionsContent}`;
	}
	if (workspaceInstructions) {
		prompt += `\n\n---\n\n## Project-Specific Instructions\n\nThe following instructions were loaded from the project workspace and MUST be followed:\n\n${workspaceInstructions}`;
	}
	if (gitContext) {
		prompt += `\n\n---\n\n${gitContext}`;
	}
	const skillsSection = buildSkillsDescriptionSection();
	if (skillsSection) {
		prompt += `\n\n---\n\n${skillsSection}`;
	}
	const mcpSection = await buildPMMcpSection();
	if (mcpSection) {
		prompt += `\n\n---\n\n${mcpSection}`;
	}
	if (featureBranchEnabled) {
		prompt += `\n\n---\n\n${FEATURE_BRANCH_SECTION}`;
	}
	return { prompt, agentNames: agentsSectionResult.agentNames };
}

// ---------------------------------------------------------------------------
// Sub-agent system prompt
// ---------------------------------------------------------------------------

const AGENT_COMMUNICATION_PROTOCOL = `
## Execution Context

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
5. **Think full-stack.** When you add or change backend logic, data models, or JS modules, check if the UI needs updating too — new HTML elements, form fields, display sections, or user-facing controls. Likewise, when changing the UI, make sure the underlying logic supports it. A feature that works in code but has no way for the user to see or interact with it is incomplete.

## Token Efficiency

- **Targeted file reads**: Use \`startLine\` and \`endLine\` on \`read_file\` to read only the relevant section instead of the entire file. Critical for large files (>200 lines).
- **Avoid re-reading unchanged files**: If you already read a file and haven't modified it, do not read it again.
- **Use search before read**: Use \`search_content\` or \`search_files\` to locate the exact file and line range before reading.

## Cross-Agent Knowledge Sharing

You have access to project docs via \`list_docs\`, \`get_doc\`, \`create_doc\`, and \`update_doc\`.
- **Before starting**: Call \`list_docs\` to check if previous agents left architecture decisions, API docs, or context you should know about.
- **During work**: Create or update docs for important decisions, API contracts, gotchas, or anything another agent working on the same project would need to know.
- **Title convention**: Use clear prefixes like "Architecture: ...", "API: ...", "Gotcha: ..." so other agents can find relevant docs quickly.
- **Agent knowledge**: Documents titled "project-knowledge- ..." are listed (title + purpose only) in all agent prompts. Use \`get_doc\` to read the full content of any relevant document before starting work.
{agent_knowledge_update}

## Decisions Log (CRITICAL)

A shared \`DECISIONS.md\` file in the workspace tracks architectural and design decisions across all agents. **This is how agents stay coordinated. Read it at session start — it is loaded fresh in your prompt under "Architectural Decisions".**

- **At session start**: DECISIONS.md content is injected into your prompt under the "Architectural Decisions" section. Read it before doing any work.
- **Before making any design choice** (tech stack, naming convention, data structure, API shape, auth strategy, file organization): check the "Architectural Decisions" section to see if a prior agent already decided.
- **After making a decision**: call \`log_decision\` with a clear title, rationale, and impact. Future agents will see it in their prompt.
- **Never contradict a logged decision** without explicitly noting why and logging the change.
- Examples of decisions to log: "Use camelCase for JS, snake_case for DB columns", "Auth via JWT stored in httpOnly cookie", "State management via Zustand", "API prefix /api/v1".

## LSP Diagnostics

File write/edit tools automatically return LSP diagnostics (type errors, lint issues) after each change. **You MUST address these before moving on:**
1. After every \`write_file\`, \`edit_file\`, \`multi_edit_file\`, or \`patch_file\` — read the diagnostics in the tool result.
2. If there are **errors** (not warnings): fix them immediately before proceeding to the next file or task step.
3. Before moving a task to "review", ensure there are **zero LSP errors** in files you modified. Warnings are acceptable if intentional.
4. If an error is a false positive or unfixable (e.g. missing third-party types), note it in your report — do not silently ignore errors.

## Work Integrity

- **Complete ALL assigned work** — never skip steps, cut corners, or leave acceptance criteria half-done. If your task has 5 criteria, all 5 must be fully implemented and verified.
- **Never mark criteria as checked unless truly done** — use \`check_criteria\` only after you have implemented AND verified the criterion.
- **Do not give up prematurely** — if something is difficult, try alternative approaches. Only report inability after genuine effort. Explain exactly what you tried and what failed.
- **Report honestly** — if you could not complete something, say so clearly in your report. A partial honest report is far more valuable than a fabricated complete one.

## Kanban Task Lifecycle

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
8. If you cannot complete the task, leave it in "working" and explain in your report.
`;

/** Read-only variant: no file writes, no kanban lifecycle. */
const READONLY_AGENT_COMMUNICATION_PROTOCOL = `
## Execution Context

You are running **inline** in the main conversation. The Project Manager dispatched you for a read-only task. Your tool calls and output are visible to the PM and the user in real time.

- You received ONLY a task description — you have NO conversation history. The task description is your entire context.
- You do NOT communicate with the user directly. The PM handles all user interaction.
- You do NOT spawn other agents. If a task requires skills outside your domain, note it in your final output.
- You have **read-only tools** — no file writes, no shell commands.
- When your task is complete, provide a comprehensive summary in your final response.
- If you encounter an unrecoverable error, describe the error clearly in your final response.

## Token Efficiency

- **Targeted file reads**: Use \`startLine\` and \`endLine\` on \`read_file\` to read only the relevant section instead of the entire file. Critical for large files (>200 lines).
- **Avoid re-reading unchanged files**: If you already read a file and haven't modified it, do not read it again.
- **Use search before read**: Use \`search_content\` or \`search_files\` to locate the exact file and line range before reading.

## Cross-Agent Knowledge Sharing

You have access to project docs via \`list_docs\`, \`get_doc\`, and \`create_doc\`.
- **Before starting**: Call \`list_docs\` to check if previous agents left architecture decisions, API docs, or context you should know about.
- **Agent knowledge**: Documents titled "project-knowledge- ..." are listed in all agent prompts. Use \`get_doc\` to read any relevant document. Use \`create_doc\` to persist important project knowledge for future agents (e.g. "project-knowledge- Tech Stack", "project-knowledge- Architecture Overview").

## Kanban Task Lifecycle

If your task context includes a kanban task ID:
1. **Call \`get_task\` with your task ID as the very first action** — before any other work. This returns the authoritative acceptance criteria list. Never infer the criteria count from your prompt.
2. **Call \`list_docs\` and read the project plan or PRD document** — this is MANDATORY before starting any work. Call \`list_docs\` with your project ID, then scan the returned titles and call \`get_doc\` on any document whose title contains "Plan:", "Product Requirements Document", or "PRD". This gives you the overall picture of the project and how your task fits into it. If no matching document is found in the list, continue with your assigned task — do not block on it.
3. Use \`move_task\` to move the task to "working" when you start.
4. Work through all acceptance criteria returned by \`get_task\` (not the ones in your prompt).
5. Use \`check_criteria\` with **all indices in a single call** — e.g. \`criteria_index=[0,1,2]\`. Never call it one index at a time.
6. When ALL criteria are checked, use \`move_task\` to move the task to **"review"** — NEVER to "done".
   - Moving to "done" is **reserved for the Project Manager only** via the per-task review cycle.
7. If you cannot complete the task, leave it in "working" and explain in your report.
`;

const READ_ONLY_AGENTS = new Set(["code-explorer", "explore", "research-expert"]);

// ---------------------------------------------------------------------------
// Dynamic plugin prompt injection — injected from enabled plugins' prompt field
// ---------------------------------------------------------------------------

/**
 * Load prompt snippets from all enabled plugins that have a non-empty prompt.
 * These are concatenated and injected into agent system prompts so agents
 * automatically know how to use plugin-provided tools.
 */
async function loadPluginPrompts(): Promise<string> {
	try {
		const rows = await db
			.select({ prompt: plugins.prompt })
			.from(plugins)
			.where(eq(plugins.enabled, 1));
		const snippets = rows
			.map((r) => r.prompt?.trim())
			.filter((p): p is string => !!p);
		return snippets.length > 0 ? "\n" + snippets.join("\n\n") : "";
	} catch {
		// Plugin table may not exist yet during early startup
		return "";
	}
}

/**
 * Returns the system prompt for a named sub-agent.
 *
 * The base prompt is loaded from the agents table by name. The constitution
 * from the settings table and a standard communication protocol are appended.
 *
 * If a workspacePath is provided, any AGENTS.md or CLAUDE.md files found in
 * the workspace root are appended as project-specific instructions.
 */
export async function getAgentSystemPrompt(agentName: string, workspacePath?: string, projectId?: string): Promise<string> {
	// Load agent record — including the useSystemPromptOnly flag (custom-agent-only).
	const agentRows = await db
		.select({ systemPrompt: agents.systemPrompt, displayName: agents.displayName, isBuiltin: agents.isBuiltin, useSystemPromptOnly: agents.useSystemPromptOnly })
		.from(agents)
		.where(eq(agents.name, agentName));

	const basePrompt =
		agentRows.length > 0
			? agentRows[0].systemPrompt
			: `You are the ${agentName} agent. Complete the task assigned to you thoroughly and accurately.`;

	// Playground General Agent: runs standalone — NOT dispatched by the PM, no kanban task,
	// it DOES have conversation history, and it cannot delegate (no run_agent). So it must NOT
	// receive the PM/kanban/cross-agent/decisions communication protocol or the skill-delegation
	// rules — those are false/misleading here. The Constitution is intentionally omitted too
	// (the agent's own prompt governs behaviour). It gets only: its base prompt, the user profile,
	// the skills list (without delegation rules), and the MCP tools list. Workspace context is
	// appended by the caller (runInlineAgent) via projectContext.
	// The Issue Fixer runs the same standalone way as the Playground agent (no PM/kanban/
	// delegation/constitution), EXCEPT it keeps the chrome-devtools tools (to reproduce
	// browser/UI issues), so those are NOT excluded from its MCP section.
	if (agentName === "playground-agent" || agentName === "issue-fixer") {
		// Playground hides chrome-devtools_* from its toolset; Issue Fixer keeps them.
		const excludeMcpPrefixes = agentName === "playground-agent" ? ["chrome-devtools_"] : [];
		const [userProfile, mcpSection] = await Promise.all([
			loadUserProfile(),
			buildAgentMcpSection(excludeMcpPrefixes),
		]);
		const userSection = buildUserSection(userProfile);
		const skillsSection = buildSkillsDescriptionSection(false); // no agent-routing/delegation rules
		return [basePrompt, userSection, skillsSection, mcpSection]
			.filter(Boolean)
			.map((s) => s.trim())
			.filter(Boolean)
			.join("\n\n---\n\n");
	}

	// Lean prompt path — only for custom agents where the user has opted in.
	// In this mode the agent receives ONLY its own system prompt + App Context
	// + User Profile + Available Skills. Constitution, communication protocol,
	// project/workspace instructions, plugin prompts, MCP, git context, etc.
	// are all skipped — keeping the agent's behaviour entirely under the user's
	// hand-crafted system prompt while still letting it use skills/tools.
	if (agentRows.length > 0 && agentRows[0].isBuiltin === 0 && agentRows[0].useSystemPromptOnly === 1) {
		const userProfile = await loadUserProfile();

		// Slim App Context for lean mode: time/date only — drop app version and
		// timezone-scheduler hint since custom agents in lean mode aren't
		// expected to drive cron jobs or rely on a specific app build.
		const userTimezone = await loadUserTimezone();
		const now = new Date();
		const today = now.toLocaleDateString("en-CA", { timeZone: userTimezone });
		const currentTime = now.toLocaleString("en-US", {
			weekday: "short", month: "short", day: "numeric",
			hour: "2-digit", minute: "2-digit", hour12: false,
			timeZone: userTimezone,
		});
		const appContext = `## App Context\n\n- **Current time**: ${currentTime}\n- **Today's date**: ${today}`;

		// Slim User Profile for lean mode: name + city — drop email and the
		// email-usage hint.
		const userProfileLines = [
			userProfile.name ? `- **Name**: ${userProfile.name}` : "",
			userProfile.city ? `- **City**: ${userProfile.city}` : "",
		].filter(Boolean);
		const userSection = userProfileLines.length > 0
			? `## User Profile\n\n${userProfileLines.join("\n")}\n\nAddress the user by their name in communications.`
			: "";

		const skillsSection = buildSkillsDescriptionSection(false);
		return [basePrompt, appContext, userSection, skillsSection]
			.filter(Boolean)
			.map((s) => s.trim())
			.filter(Boolean)
			.join("\n\n---\n\n");
	}

	// Load constitution + user profile + agent knowledge listing + update setting + plugin prompts + project context
	const [constitution, userProfile, knowledgeSection, knowledgeUpdateEnabled, pluginPrompts, projectContext, featureBranchEnabled] = await Promise.all([
		loadConstitution(),
		loadUserProfile(),
		loadAgentKnowledgeListing(projectId),
		isAgentKnowledgeUpdateEnabled(projectId),
		loadPluginPrompts(),
		buildProjectContext(projectId, workspacePath),
		isFeatureBranchWorkflowEnabled(projectId),
	]);
	const userSection = buildUserSection(userProfile);

	const isReadOnly = READ_ONLY_AGENTS.has(agentName);
	const filteredConstitution = filterConstitution(constitution, isReadOnly ? "read-only" : "worker");
	const rawProtocol = isReadOnly ? READONLY_AGENT_COMMUNICATION_PROTOCOL : AGENT_COMMUNICATION_PROTOCOL;
	const protocol = rawProtocol.replace("{agent_knowledge_update}", knowledgeUpdateEnabled ? AGENT_KNOWLEDGE_UPDATE_LINE : "");

	const workspaceInstructions = loadWorkspaceInstructions(workspacePath);
	const decisionsContent = loadDecisionsFile(workspacePath);
	const gitContext = buildGitContext(workspacePath);

	const skillsSection = buildSkillsDescriptionSection();

	const mcpSection = await buildAgentMcpSection();

	const featureBranchInstruction = featureBranchEnabled && !isReadOnly
		? `\n## Feature Branch Workflow\n\nThis project uses a feature branch workflow. Auto-commit will handle switching to the correct feature branch when your task is complete. Your only responsibility: **never commit directly to main or master**. Use \`git_status\` to check the current branch before committing if you commit manually.`
		: "";

	return [
		basePrompt,
		projectContext,
		filteredConstitution ? `## Constitution\n\n${filteredConstitution}` : "",
		userSection,
		knowledgeSection,
		pluginPrompts,
		protocol,
		skillsSection,
		mcpSection,
		featureBranchInstruction,
		workspaceInstructions ? `## Project-Specific Context\n\nThe following instructions were loaded from the project workspace and MUST be followed:\n\n${workspaceInstructions}` : "",
		decisionsContent ? `## Architectural Decisions\n\nThe following decisions were logged by previous agents in DECISIONS.md. **Read before making any design choice.**\n\n${decisionsContent}` : "",
		gitContext,
	]
		.filter(Boolean)
		.map((s) => s.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}
