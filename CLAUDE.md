# AGENTS.md — AgentDesk

> This file is the **map**, not the manual. It orients AI agents quickly and
> points to the deeper sources of truth (`docs/prd.md`, `docs/workflow.md`).
> Keep it short and current.

---

## What Is This Project?

**AgentDesk** is a cross-platform desktop application (Electrobun + Bun +
React 19) where autonomous AI agent teams handle the full software development
lifecycle — planning, coding, reviewing, testing — with humans approving plans
and deployments only.

Motto: **99% agent-driven. Humans approve, deploy, and communicate.**

---

## Key Documents (Read These First)

| Document | What It Contains |
|---|---|
| `docs/prd.md` | Full product requirements — features, DB schema overview, agent definitions, built-in tools and skills |
| `docs/workflow.md` | End-to-end workflow architecture — message flow, approval gate, tool reference, key file map |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Electrobun 1.16.0 (Bun runtime + native webview) |
| Frontend | React 19, TanStack Router, Zustand, Tailwind CSS, Radix UI |
| Backend | Bun (TypeScript), Drizzle ORM |
| Database | SQLite (WAL mode) via `bun:sqlite` through Drizzle (`drizzle-orm/bun-sqlite`) |
| AI | Vercel AI SDK (`ai` ^6.0) — provider-agnostic |
| AI Providers | Anthropic, OpenAI, Google Gemini, DeepSeek, Groq, xAI Grok, OpenRouter, Ollama |
| Channels | Discord (discord.js), WhatsApp (baileys), Email (imapflow + nodemailer) |
| Build | Vite (frontend) + Electrobun build (app bundle) |

---

## Repository Layout

> High-level map. See `docs/workflow.md` for the verified key file map.

```
src/
├── bun/        # Bun main process. Subsystems: agents/ (engine, tools/, review-cycle),
│               #   db/ (Drizzle schema + migrations + seed), rpc/ + rpc-groups/, providers/,
│               #   channels/ + discord/, freelance/ (Auto-Earn), issue-fixer/, issue-sources/,
│               #   remote-sync/, playground/, scheduler/, plugins/, skills/, lsp/, mcp/,
│               #   notifications/, claude/, annotations/, lib/. Entry: index.ts;
│               #   engine-manager.ts; rpc-registration.ts; windows-registry.ts
├── mainview/   # React 19 webview: main.tsx/App.tsx/router.tsx, pages/, components/, stores/, lib/
└── shared/     # Types across the RPC boundary: rpc/ (index.ts assembles AgentDeskRPC), freelance/
```

The four wiring anchors — trace any feature from here: `src/bun/index.ts` (lifecycle),
`src/bun/rpc-registration.ts` (RPC server), `src/mainview/main.tsx` (webview root),
`src/mainview/lib/rpc.ts` (the only React→Bun path).

---

## Agent Orchestration

> Operating-model summary (the agent needs this every turn). Mechanism detail: `docs/workflow.md`.

- **PM is the sole orchestrator** — classifies requests, plans, dispatches agents, manages kanban directly. There is NO separate WorkflowEngine state machine. (`AgentEngine` in `src/bun/agents/engine.ts`; one engine per project via `EngineManager` in `src/bun/engine-manager.ts`.)
- **Plan → Approve → Execute**: PM calls `request_plan_approval` (plan card in chat), user approves, PM calls `create_tasks_from_plan`, then dispatches via `run_agent`.
- **Kanban flow**: **backlog → working → review → done**. Agents cannot skip columns; move to "done" is reserved for the review system via `submit_review`.
- **Sequential Single-Agent Model**: write agents run one at a time; read-only agents (`code-explorer`, `research-expert`, `task-planner` — the `READ_ONLY_AGENTS` set in `agent-loop.ts`) run in parallel via `run_agents_parallel`. Enforced by the `writeAgentRunning` guard in PM tools.
- **Automatic Code Review**: moving a task to "review" auto-spawns a code-reviewer (`review-cycle.ts`); `submit_review(approved)` → done, rejection → back to working (up to `maxReviewRounds`, default 2).
- **Inline Agent Execution**: sub-agents run inline in the main conversation (fresh context = system prompt + task), tool calls visible as message parts; `handoff.ts` summaries chain sequential tasks.
- **Feature Branch Workflow**: PM calls `set_feature_branch` (AI-named) before dispatch; `autoCommitTask` (in `review-cycle.ts`) switches/creates the branch before committing.
- **Context & caching**: progressive compaction at 60/70/85/90% of `getContextLimit(modelId)`, no iteration cap; Anthropic/OpenRouter system prompts use cache-control metadata.
- **Playground** (`src/bun/playground/`): isolated Artifacts-style live-preview builder driven by the `playground-agent`, fully decoupled from the PM/kanban/review paths.
- **Quick Chat** (`src/bun/quick-chat/`): OS Explorer/Finder "Open in AgentDesk" entry opens a reduced-chrome window against an arbitrary folder without creating a project first. Reuses the normal PM/engine, gated by a per-turn `quickChat` boolean (derived from `projects.isQuickChat`) that strips kanban/plan-approval PM tools and dispatched-agent kanban tools — no separate engine path. See `docs/quick-chat-plan.md` and `docs/workflow.md`'s Quick Chat section.

---

## Database Tables (schema: `src/bun/db/schema.ts`)

Operational essentials:

- **Drizzle-managed** tables live in `src/bun/db/schema.ts` (single source of truth); changes require a new migration file in `src/bun/db/migrations/`.
- **Raw-SQL-migration** tables (not in schema.ts): `keyboard_shortcuts` (v1).
- `agent_sessions` / `agent_session_messages` were created in v3 and **dropped in v4** when the inline-agent model replaced persistent sessions.
- `github_issues` is **deprecated** (read-only), superseded by `external_issues` (unified multi-source store).
- Feature-branch name is persisted in `settings` under key `currentFeatureBranch:<projectId>` (category `git`).
- `projects.isQuickChat` (migration v57) flags a project created via the Quick Chat OS-Explorer entry; `getProjectsList` filters it out everywhere (Dashboard, PM `list_projects`/`search_projects`) until promoted via the Quick Chat window's "Create Project" button.

---

## Built-in Agent Roster (`src/bun/db/seed.ts`)

Operational essentials:

- **`project-manager`** is the orchestrator (talks to humans, dispatches sub-agents).
- **Read-only agents** (parallelizable via `run_agents_parallel`): `code-explorer`, `research-expert`, `task-planner`. All other roles (architect, backend/frontend/mobile/ml engineer, db-expert, api-designer, qa, devops, code-reviewer, debugging/performance/security/refactoring specialists, ui-ux, data-engineer, documentation) are write agents that run sequentially.
- **Hidden/special agents** (no `agent_tools` rows ⇒ full registry; hidden from the PM and the Agents page; never orchestrated): `playground-agent` (Playground only) and `issue-fixer` (Issue Fixer feature only; NEVER merges).

---

## RPC Pattern

All frontend → backend calls go through Electrobun's typed RPC system.

- **Contracts**: `src/shared/rpc/*.ts` — define input/output shapes
- **Handlers**: `src/bun/rpc/*.ts` — implement the logic
- **Grouping**: `src/bun/rpc-groups/*.ts` — bundle related handlers by domain
- **Registration**: `src/bun/rpc-registration.ts` — merges the rpc-groups into the Electrobun RPC server
- **Client**: `src/mainview/lib/rpc.ts` — typed caller used by React components

When adding a new RPC: define the contract in `src/shared/rpc/`, implement the
handler in `src/bun/rpc/`, wire it into a group in `src/bun/rpc-groups/` (merged
by `rpc-registration.ts`), and call it from the frontend via `src/mainview/lib/rpc.ts`.

---

## Dev Commands

```bash
bun run dev          # Start in dev mode (Vite build + Electrobun watch)
bun run dev:fast     # HMR mode (Vite dev server + Electrobun)
bun run build        # Production build
bun run build:canary # Canary build variant
bun run typecheck    # TypeScript type check (no emit)
bun run lint         # ESLint
bun run lint:fix     # ESLint with auto-fix
bun run format       # Prettier
bun run format:check # Prettier check
bun run db:generate  # Generate Drizzle migrations from schema changes
bun run db:migrate   # Run Drizzle migrations
bun run db:studio    # Open Drizzle Studio (DB browser)
```

---

## Constitution

These are rules you must ALWAYS follow. They govern *how* you work; the
**Critical Rules** section below covers AgentDesk-specific technical
contracts. Where the two would otherwise overlap, only one copy is kept
(here).

### 1. Safety (non-negotiable)
- NEVER run destructive commands (`rm -rf /`, `format`, `DROP DATABASE`, force-push, etc.) without explicit human approval.
- NEVER access files outside the project workspace directory.
- NEVER expose API keys, secrets, or credentials in code, logs, commits, or chat.
- NEVER make network requests to unknown or unauthorized endpoints.
- NEVER modify system files or configs outside the project.
- These override every other rule below, including "just finish the task."

### 2. Clarify Before Acting
Don't assume. Don't hide confusion. Surface tradeoffs — before writing code, not after.
- State assumptions explicitly. If genuinely uncertain, stop and ask — especially before anything hard to reverse or wide-impact.
- If multiple valid interpretations exist, present them; don't silently pick one.
- If a simpler approach exists than the one implied by the request, say so and push back.
- If requirements are ambiguous, conflicting, or underspecified, ask upfront rather than guessing and course-correcting later.
- If a requested change or feature is an anti-pattern or violates well-established best practices, explain the issue and ask for confirmation before proceeding.

### 3. Simplicity First
Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked. No abstractions for single-use code. No unrequested "flexibility" or "configurability."
- Prefer simple, boring solutions over clever ones.
- SOLID, KISS, DRY, YAGNI, separation of concerns, composition over inheritance.
- Small, single-responsibility classes/functions with clear boundaries. No god-files, no circular references. A method doing two jobs gets split.
- Self-test: if you wrote 200 lines that could be 50, rewrite it. Ask "would a senior engineer call this overcomplicated?" — if yes, simplify.

### 4. Surgical Changes
Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting. Don't refactor what isn't broken. Match existing style even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it unless it's dead code *your own change* just orphaned (unused imports/vars/functions you caused).
- Test: every changed line should trace directly to the request.

### 5. Code Quality
- Follow the project's existing conventions.
- **Error handling policy:** handle errors at real boundaries — I/O, network calls, parsing, user input. Do NOT add defensive checks/handling for states that cannot occur given the code's own invariants. Every error that IS handled must be surfaced (logged/thrown to the global handler) — never swallowed silently.
- Strict typing & null-safety (nullable-reference checks on, warnings as errors). No `dynamic` to dodge the type system, no null-forgiving `!`, no cast-then-ignore. Make illegal states unrepresentable (sealed types, enums, records).
- No blocking UI (desktop apps).
- Comments: only for non-obvious logic (hidden constraints, workarounds, surprising behavior). No docstrings/JSDoc on obvious methods, constructors, getters, simple utilities — self-documenting code over comment noise.
- Don't introduce known security vulnerabilities (OWASP Top 10).
- Don't reinvent solved problems: use a free, permissively-licensed, well-maintained, popular library when one correctly does the job. Conversely, don't pull in a heavy dependency for something trivial — weigh every dependency against startup time, RAM, and bundle size.
- Always use Context7 MCP when library/API documentation, code generation, or setup/configuration steps are needed, without waiting to be explicitly asked.

### 6. Completeness
- Finish to the real end-to-end Definition of Done. No stubs, no `// later`, no TODO placeholders standing in for the actual implementation.

### 7. Goal-Driven Execution
Turn tasks into verifiable goals and loop until they're met, rather than stopping at "looks right."
- "Add validation" → write tests for invalid inputs, then make them pass.
- "Fix the bug" → write a test that reproduces it, then make it pass.
- "Refactor X" → confirm tests pass before and after.
- For multi-step tasks, state a brief plan first (create todos before implementing):
  1. [Step] → verify: [check]
  2. [Step] → verify: [check]
- Weak success criteria ("make it work") force constant back-and-forth — define strong ones so you can work independently.

### 8. Reporting & Honesty
- Be honest about state: if tests fail, show the output; if a step was skipped, say so. Never report a task as done when a quality gate hasn't actually passed.
- At the end of every task, give one combined wrap-up covering: (a) any flaws/gaps in the original requirements or risky assumptions you made, (b) anywhere the requested approach was suboptimal plus a concrete alternative with tradeoffs, and (c) other suggestions/improvements worth considering. One critique, not a checklist repeated in two places.

### 9. Resource Limits
- Respect token/context budgets. Don't create unnecessary files or bloat the codebase.
- Clean up temporary files and temporary processes you created once you're done, after verifying they're no longer needed.

### 10. Project-Specific Rules
- Email restriction (see global `~/.claude/CLAUDE.md` for the full rule): never use `eteamid@gmail.com`, `sarfraz@onsupport.com`, or any "eteam" address; ask which email to use whenever a task requires one.
- Commits follow Conventional Commits style. Never commit without user confirmation unless the user or project scope has already explicitly authorized it.
- This app has **existing users** — every feature or change must keep working for existing users, not just new ones.
- Keep `CLAUDE.md` and `docs/workflow.md` updated whenever they deviate from current code.

---

## Critical Rules

- **PM is the sole orchestrator.** It handles planning, approval, task creation, and agent dispatch directly — no separate workflow engine.
- **Kanban task flow is enforced**: backlog → working → review → done. Agents cannot skip columns.
- **Code review is automatic**: When a task moves to "review", `review-cycle.ts` spawns a code-reviewer.
- **RPC contracts in `src/shared/rpc/` are the interface boundary.** Change
   them when adding features; never bypass them with direct DB calls from the
   frontend.
- **Schema changes require a new migration file** in `src/bun/db/migrations/`.
   Never alter `schema.ts` without adding the corresponding migration.
- **Agent system prompts live in `src/bun/db/seed.ts`.** Edit there, not
   inline in engine code.
- **GitHub git network ops (clone/fetch/pull/push) must authenticate via the token, not the
   system credential helper.** Prefix the git args with `gitAuthArgs(token)` (for an existing
   repo, `await githubAuthPrefix({ workspacePath, projectId })`) from `rpc/github-api.ts` — this
   supplies auth via an inline header with `credential.helper=` (empty) so Git Credential Manager
   is never invoked. NEVER embed `x-access-token:<token>@github.com` in a URL while a helper is
   active (git stores it as an account → "Select an account" prompts on the user's own pushes),
   and never persist the token via `git config`/`git remote set-url`.
- **Follow the task workflow**: `Plan → Approve → Execute → Done`.
   Use `aitasks` CLI for all task tracking (see Task Management section below)
- Use `electrobun` skill for `electrobun` development.
- **Claude Subscription is a two-path AI provider — when touching AI-provider-invoking code, check
   both paths.** `providerType: "claude-subscription"` only behaves like a normal provider (full
   AI-SDK `ModelMessage[]`, native multi-turn history, streaming, native tool/image content) for
   **Haiku**, over a direct-HTTP OAuth adapter. Every other model (Sonnet/Opus) 429s on that path
   and instead routes through a fundamentally different mechanism — the official Agent SDK spawning
   a real `claude` CLI subprocess (`runClaudeCliTask` in `src/bun/providers/claude-subscription-cli-runner.ts`),
   which takes a single flattened text prompt (no native multi-message array, no image/audio content
   unless explicitly converted to an MCP content block) and wraps tools through its own layer. Gate:
   `providerType === "claude-subscription" && !isHaikuModel(modelId)` (the `isClaudeSubscriptionViaCli`
   pattern in `agent-loop.ts`/`engine.ts`; `isHaikuModel`/`internalCallModelId` in
   `providers/claude-subscription.ts`). **Scope — only applies to code that creates/calls an AI
   provider model directly**: a new chat/agent surface, a tool whose `execute()` spins up its own
   `generateText`/`streamText` call, anything assembling conversation history for a model, or a tool
   returning non-text content. When you touch that kind of code, verify it either (a) reuses an
   already-routed path (`runInlineAgent`, the PM loop) and inherits the fix for free, (b) needs the
   full CLI/SDK branch because it's conversational or tool-using (mirror the pattern already applied
   in `rpc/dashboard.ts`, `collections/chat.ts`, `rpc/freelance-chat.ts`, `rpc/skills-search-chat.ts`,
   `rpc/dashboard-agent.ts`, `rpc/council.ts`, `scheduler/task-executor.ts`), or (c) just needs the
   `internalCallModelId` Haiku-swap because it's a bounded one-shot completion with no tools (mirror
   `agents/tools/deep-research.ts`, `agents/tools/preview.ts`, `agents/summarizer.ts`). Not relevant
   to UI-only changes, DB/schema work, or anything that never touches an AI provider call.
- **The Claude Subscription CLI/SDK path (`claude-subscription-cli-runner.ts`) always passes
   `settingSources: []` to `query()`, on both call sites.** Without it, the SDK loads the user's
   real `~/.claude/settings.json` (plus any project/local settings) by default, so their own Claude
   Code hooks (e.g. Stop/PermissionRequest desktop notifications) fire for every AgentDesk-driven
   session, indistinguishable from their own manual `claude` CLI/desktop app usage. AgentDesk
   already fully controls tools/permissions/model itself for this path, so it never needed those
   files — do not remove this option, and do not add a new `query()` call site for this provider
   without it.
- **New native/binary dependencies must ship their platform binaries, and never load eagerly at
   startup.** Bun's bundler flattens `src/bun` into one file, so any package with a `.node`
   addon or per-platform optional-dependency binary (`onnxruntime-node`, `sharp`, etc.) needs an
   explicit copy rule in `electrobun.config.ts`'s `build.copy` — verify by inspecting the actual
   packaged `build/`/`artifacts/` output, not just `bun run dev` (dev mode doesn't hit the same
   bundling path). Separately, any module that statically imports such a dependency must not sit
   on the `rpc-registration.ts` import graph (loaded unconditionally on every boot) unless the
   whole app needs it to start — gate it behind a dynamic `import()` at the point of use instead,
   so a broken/missing native binding only disables that one feature instead of crashing the app
   for every user before the window even opens (this exact chain — `@huggingface/transformers` →
   `sharp` eagerly imported via the Collections RPC group — shipped in v2.5.6/`773c233` and broke
   startup for all users; see fix in the following commit).

---

<!-- aitasks:instructions -->

## AITasks — Agent Task Protocol (v1.4.1)

You have access to the `aitasks` CLI. This is your single source of truth for
all work in this project. Follow this protocol without exception.

### Environment Setup

Set your agent ID once so all commands use it automatically:
```
export AITASKS_AGENT_ID=<your-unique-agent-id>
```

Use a stable, descriptive ID (e.g. `claude-sonnet-4-6`, `agent-backend-1`).
For machine-readable output on any command, add `--json` or set `AITASKS_JSON=true`.

---

### Discovering Work

```bash
aitasks list                          # All tasks, sorted by priority
aitasks list --status ready           # Only tasks available to claim
aitasks list --status in_progress     # Currently active work
aitasks next                          # Highest-priority unblocked ready task (recommended)
aitasks next --claim --agent <id>     # Auto-claim and start the best task (one-liner)
aitasks show TASK-001                 # Full detail on a specific task
aitasks search <query>                # Full-text search across titles, descriptions, notes
aitasks deps TASK-001                 # Show dependency tree (what blocks what)
aitasks delete TASK-001               # Delete a task (no need to claim first)
```

---

### Starting a Task

**Option 1: One-liner (recommended)**
```bash
aitasks next --claim --agent $AITASKS_AGENT_ID
```
This finds the best task, claims it, and starts it in one command.

**Option 2: Step by step**
1. Find available work:
   ```bash
   aitasks next --agent $AITASKS_AGENT_ID
   ```

2. Claim it (prevents other agents from taking it):
   ```bash
   aitasks claim TASK-001 --agent $AITASKS_AGENT_ID
   ```
   This will FAIL if the task is blocked. Fix blockers first.

3. Start it when you begin active work:
   ```bash
   aitasks start TASK-001 --agent $AITASKS_AGENT_ID
   ```

**Bulk operations:** You can claim, start, or complete multiple tasks at once:
```bash
aitasks claim TASK-001 TASK-002 TASK-003 --agent $AITASKS_AGENT_ID
aitasks start TASK-001 TASK-002 --agent $AITASKS_AGENT_ID
aitasks done TASK-001 TASK-002 TASK-003 --agent $AITASKS_AGENT_ID  # all criteria must be verified
```

**Pattern matching:** Use wildcards to match multiple tasks:
```bash
aitasks claim TASK-0* --agent $AITASKS_AGENTID    # Claims TASK-001, TASK-002, ..., TASK-009
aitasks done TASK-01* --agent $AITASKS_AGENT_ID   # Claims TASK-010 through TASK-019
```

---

### During Implementation

After every significant decision, discovery, or file change:
```bash
aitasks note TASK-001 "Discovered rate limit of 100 req/min — added backoff in src/retry.ts:L44" --agent $AITASKS_AGENT_ID
```

Always note:
- Architectural decisions and why alternatives were rejected
- File paths and line numbers of key changes
- External dependencies added
- Gotchas, edge cases, or known limitations
- If you split a task into subtasks

Creating subtasks:
```bash
aitasks create --title "Write unit tests for auth" --desc "Add unit tests covering all auth edge cases" --ac "All tests pass" --ac "Coverage ≥ 90%" --parent TASK-001 --priority high --type chore --agent $AITASKS_AGENT_ID
```

If you discover your task is blocked by something:
```bash
aitasks block TASK-001 --on TASK-002,TASK-003
```

View dependencies:
```bash
aitasks deps TASK-001    # Shows what this task is blocked by and what it blocks
```

---

### Completing a Task

> **A task is only complete when its status is `done`. Verified criteria, implementation notes, and `review` status do NOT mean the task is done. You have not finished a task until `aitasks done` has succeeded.**

You MUST verify every acceptance criterion before marking done.

1. View all criteria:
   ```bash
   aitasks show TASK-001
   ```

2. Check off each criterion with concrete evidence:
   ```bash
   aitasks check TASK-001 0 --evidence "curl -X GET /users/999 returns 404 with body {error:'not found'}"
   aitasks check TASK-001 1 --evidence "unit test UserService.patch_invalid passes, see test output line 47"
   aitasks check TASK-001 2 --evidence "integration test suite passes: 12/12 green"
   ```

3. Mark done (will FAIL if any criterion is unchecked):
   ```bash
   aitasks done TASK-001 --agent $AITASKS_AGENT_ID
   ```

> The task is only done when `aitasks done` completes successfully. Do not treat a task as finished until you see the done confirmation.

---

### Undoing Mistakes

Made a mistake? Use undo to revert the last action:
```bash
aitasks undo TASK-001    # Undoes the last action (claim, start, done, check, note, etc.)
```

Undoable actions:
- claimed → unclaims the task
- started → reverts to ready status
- completed → reverts to in_progress
- criterion_checked → removes the verification
- note_added → removes the implementation note

---

### Abandoning a Task

If you must stop working on a task, NEVER silently abandon it:
```bash
aitasks unclaim TASK-001 --agent $AITASKS_AGENT_ID --reason "Blocked on missing API credentials — needs human input"
```

---

### Rules

1. **A task is only complete when its status is `done`.** No other status — not criteria-verified, not `review`, not `in_progress` — counts as complete. Your work on a task is not finished until `aitasks done` succeeds.
2. Never mark a task done without checking EVERY acceptance criterion with evidence.
3. Never start a task you haven't claimed.
4. Never silently abandon a task — always unclaim with a reason.
5. Add implementation notes continuously, not just at the end.
6. If a task needs splitting, create subtasks BEFORE marking parent done.
7. Your evidence strings must be concrete and verifiable — not vague affirmations.
8. Always provide --desc, at least one --ac, and --agent when creating a task. All three are required.

---

### Quick Reference

```
aitasks next [--claim] [--agent <id>]       Find best task (optionally auto-claim/start)
aitasks list [--status <s>] [--json]        List tasks
aitasks show <id>                           Full task detail (includes time tracking)
aitasks search <query>                      Search titles, descriptions, notes
aitasks deps <id>                           Show dependency tree
aitasks create --title <t> --desc <d> --ac <c> [--ac <c> ...] --agent <id>   Create a task
aitasks claim <id...> --agent <id>          Claim task(s) - supports patterns like TASK-0*
aitasks start <id...> --agent <id>          Begin work on task(s)
aitasks note <id> <text> --agent <id>       Add implementation note
aitasks check <id> <n> --evidence <text>    Verify acceptance criterion n
aitasks done <id...> --agent <id>           Mark task(s) complete (only valid completion)
aitasks block <id> --on <id,...>            Mark as blocked
aitasks unblock <id> --from <id>            Remove a blocker
aitasks unclaim <id> --agent <id>           Release task
aitasks undo <id>                           Undo last action on task
aitasks delete <id...>                      Delete task(s) - no claim required
aitasks log <id>                            Full event history
aitasks agents                              List active agents
aitasks export --format json                Export all tasks
```

**Time tracking:** The `show` command displays duration for in-progress and completed tasks (e.g., "2h 34m" or "1d 5h ongoing").

<!-- aitasks:instructions:end -->

