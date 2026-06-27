# AGENTS.md — AgentDesk

> **MANDATORY FIRST ACTION — NO EXCEPTIONS**
> Read `project-wiki/index.md` before ANY response to a coding task, question,
> or request, then open the specific page(s) it points to. This is not optional.
> The wiki is the project's knowledge base — it explains **how** subsystems work
> and **why** they are built that way, with `file:line` anchors back to the code.
> `project-wiki/reference/directory-map.md` is the "where does X live?" lookup.
> See `project-wiki/WIKI.md` for the wiki's structure and the
> **ingest / query / lint** protocol (query the wiki first; when you learn
> something durable, write it back; flag/fix stale pages as code changes).

> **MANDATORY LAST ACTION — AFTER ANY CODE CHANGE, NO EXCEPTIONS**
> Before you consider a coding task done, update the `project-wiki/` page(s) that
> document the code you touched — in the SAME change — and bump their `verified_at`
> to today's date. Code and its wiki page travel together; a code change is not
> complete until its page reflects reality. If you added a new subsystem/flow/
> decision/gotcha, create the page and link it from `project-wiki/index.md`.
> Then run `bun run wiki:check` and confirm it reports **no stale pages and no
> missing sources** for what you changed. The `.githooks/pre-commit` hook lists
> which pages your staged change touches — treat that list as your update checklist.
> "I'll update the wiki later" is not acceptable: later never comes and the next
> agent inherits a lie.

> This file is the **map**, not the manual. It orients AI agents quickly and
> points to the deeper sources of truth (chiefly the `project-wiki/`).
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
| `project-wiki/index.md` | **The knowledge base** — catalog of subsystem/flow/decision/gotcha/reference pages. Start here. |
| `project-wiki/overview.md` | 10,000-ft architecture narrative |
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

> High-level map. The authoritative, file-by-file index (kept verified against
> the code) lives in `project-wiki/reference/directory-map.md`.

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
`src/mainview/lib/rpc.ts` (the only React→Bun path). Full per-file detail:
**`project-wiki/reference/directory-map.md`** + the relevant `project-wiki/subsystems/*` page.

---

## Agent Orchestration

> Operating-model summary (the agent needs this every turn). Mechanism detail:
> `project-wiki/subsystems/agent-engine.md`, `project-wiki/flows/*`, and
> `project-wiki/decisions/pm-sole-orchestrator.md`.

- **PM is the sole orchestrator** — classifies requests, plans, dispatches agents, manages kanban directly. There is NO separate WorkflowEngine state machine. (`AgentEngine` in `src/bun/agents/engine.ts`; one engine per project via `EngineManager` in `src/bun/engine-manager.ts`.)
- **Plan → Approve → Execute**: PM calls `request_plan_approval` (plan card in chat), user approves, PM calls `create_tasks_from_plan`, then dispatches via `run_agent`.
- **Kanban flow**: **backlog → working → review → done**. Agents cannot skip columns; move to "done" is reserved for the review system via `submit_review`.
- **Sequential Single-Agent Model**: write agents run one at a time; read-only agents (`code-explorer`, `research-expert`, `task-planner` — the `READ_ONLY_AGENTS` set in `agent-loop.ts`) run in parallel via `run_agents_parallel`. Enforced by the `writeAgentRunning` guard in PM tools.
- **Automatic Code Review**: moving a task to "review" auto-spawns a code-reviewer (`review-cycle.ts`); `submit_review(approved)` → done, rejection → back to working (up to `maxReviewRounds`, default 2).
- **Inline Agent Execution**: sub-agents run inline in the main conversation (fresh context = system prompt + task), tool calls visible as message parts; `handoff.ts` summaries chain sequential tasks.
- **Feature Branch Workflow**: PM calls `set_feature_branch` (AI-named) before dispatch; `autoCommitTask` (in `review-cycle.ts`) switches/creates the branch before committing.
- **Context & caching**: progressive compaction at 60/70/85/90% of `getContextLimit(modelId)`, no iteration cap; Anthropic/OpenRouter system prompts use cache-control metadata.
- **Playground** (`src/bun/playground/`): isolated Artifacts-style live-preview builder driven by the `playground-agent`, fully decoupled from the PM/kanban/review paths. Detail: `project-wiki/subsystems/playground.md`.

---

## Database Tables (schema: `src/bun/db/schema.ts`)

> Full per-table reference (every table, purpose, key columns, deprecated/dropped status):
> **`project-wiki/reference/database-tables.md`**. The Auto-Earn/freelance data model and
> its bot-avoidance design are detailed in `project-wiki/subsystems/freelance-autoearn.md`.

Operational essentials:

- **Drizzle-managed** tables live in `src/bun/db/schema.ts` (single source of truth); changes require a new migration file in `src/bun/db/migrations/`.
- **Raw-SQL-migration** tables (not in schema.ts): `keyboard_shortcuts` (v1).
- `agent_sessions` / `agent_session_messages` were created in v3 and **dropped in v4** when the inline-agent model replaced persistent sessions.
- `github_issues` is **deprecated** (read-only), superseded by `external_issues` (unified multi-source store).
- Feature-branch name is persisted in `settings` under key `currentFeatureBranch:<projectId>` (category `git`).

---

## Built-in Agent Roster (`src/bun/db/seed.ts`)

> Full roster (every agent: name, display name, read-only?, role + the hidden/special
> agents) is in **`project-wiki/reference/agent-roster.md`**. Operational essentials:

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
- If you are unsure about any requirement, behavior, or implementation detail, ask clarifying questions **before** writing code.
- At every step, provide a **high-level explanation** of what changes were made and why.
- After implementing changes or new features, always provide a list of **suggestions or improvements**, even if they differ from the user's original request.
- If the user requests a change or feature that is an **anti-pattern** or violates well-established best practices, clearly explain the issue and ask for confirmation before proceeding.
- Always use Context7 MCP when I need library/API documentation, code generation, setup or configuration steps without me having to explicitly ask.
- Always follow established best practices in your implementations.
- Simplicity is key. If something can be done in easy way without complexity, prefer that.
- Follow established principles such as DRY, KISS, SOLID, etc. for coding tasks.
- Always create todos before implementations.
- Always keep `CLAUDE.md`, the `project-wiki/` pages, and `docs/workflow.md` updated if they deviate from current code.
- **Keep the wiki fresh as you code** — this is the **MANDATORY LAST ACTION** at the top of this file, restated as a rule: when you change code, update the affected `project-wiki/` page(s) in the SAME change and bump their `verified_at`, then run `bun run wiki:check` until it reports no stale/missing references. The `.githooks/pre-commit` hook lists which pages your staged change touches (non-blocking); the hook only *detects* drift — repairing the prose is your job (see `project-wiki/WIKI.md`). Bumping `verified_at` without actually re-reading the code against the page is forbidden — the date asserts you verified it.
- Always ask questions if you have any confusion or better suggestions even if they differ with user.
- This app has EXISTING users, so any features implemented or changes need to ensure it works not only for new users but also existing users.

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

