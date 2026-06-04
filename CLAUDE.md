# AGENTS.md — AgentDesk

> This file is the **map**, not the manual. It orients AI agents quickly and
> points to the deeper sources of truth. Keep it short and current.

**Before starting any task, read and follow .agent-atlas/index.json — a codebase navigation layer providing domain docs, a keyword→file:line concepts index, conventions, and constraints.**

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
| `prd.md` | Full product requirements — features, DB schema overview, agent definitions, built-in tools and skills |
| `workflow.md` | End-to-end workflow architecture — state machine, message flow, approval gate, tool reference, key file map |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Electrobun 1.16.0 (Bun runtime + native webview) |
| Frontend | React 19, TanStack Router, Zustand, Tailwind CSS, Radix UI |
| Backend | Bun (TypeScript), Drizzle ORM |
| Database | SQLite (WAL mode) via `better-sqlite3` through Drizzle |
| AI | Vercel AI SDK (`ai` ^6.0) — provider-agnostic |
| AI Providers | Anthropic, OpenAI, Google Gemini, DeepSeek, Groq, xAI Grok, OpenRouter, Ollama |
| Channels | Discord (discord.js), WhatsApp (baileys), Email (imapflow + nodemailer) |
| Build | Vite (frontend) + Electrobun build (app bundle) |

---

## Repository Layout

```
src/
├── bun/                  # Bun backend (main process)
│   ├── agents/           # Agent engine, inline agent executor, review cycle
│   │   ├── engine.ts         # AgentEngine — PM streaming + inline sub-agent execution
│   │   ├── engine-types.ts   # Engine callback types, thinking options, PreviousFailureContext
│   │   ├── agent-loop.ts     # Inline sub-agent executor (runs agents in main conversation)
│   │   ├── review-cycle.ts   # Standalone code review cycle (auto-spawns reviewer, no WorkflowEngine dep)
│   │   ├── prompts.ts        # System prompt builders (PM + sub-agents)
│   │   ├── kanban-integration.ts  # Bridges kanban UI events to agent engine
│   │   ├── context.ts        # Conversation context building + summarization trigger
│   │   ├── context-notes.ts  # Syncs README/plan files as project notes for agent context
│   │   ├── handoff.ts        # Generates handoff summaries between sequential workflow tasks
│   │   ├── project-snapshot.ts  # Directory tree snapshot injected into agent context
│   │   ├── prompt-logger.ts  # Logs agent prompts to disk for debugging
│   │   ├── safety.ts         # Transient error detection + backoff helpers
│   │   ├── summarizer.ts     # Auto-compaction of long conversations (with tool result pruning)
│   │   ├── types.ts          # Shared agent types (AgentResult, etc.)
│   │   └── tools/            # Agent tool implementations
│   │       ├── index.ts           # Tool registry — assembles and filters tools per agent role
│   │       ├── pm-tools.ts        # PM tools: run_agent, run_agents_parallel, request_plan_approval,
│   │       │                      #   create_tasks_from_plan, set_feature_branch, clear_feature_branch,
│   │       │                      #   get_agent_status, project/conversation/doc/kanban read tools
│   │       ├── kanban.ts          # Kanban tools: create/move/update/get/delete tasks, submit_review
│   │       ├── notes.ts           # Notes tools: create_note, update_note, delete_note
│   │       ├── planning.ts        # define_tasks (pre-approval task definitions)
│   │       ├── file-ops.ts        # File tools: read/write/edit/multi_edit/append/delete/move/copy/
│   │       │                      #   patch_file, list_directory, directory_tree, search_files/content,
│   │       │                      #   diff_text, file_info, find_dead_code, is_binary, create_directory,
│   │       │                      #   download_file, checksum, batch_rename, file_permissions, archive
│   │       ├── file-tracker.ts    # Tracks file reads/writes per agent run (populates filesModified)
│   │       ├── truncation.ts      # Tool output truncation — saves full output to disk, returns preview
│   │       ├── shell.ts           # run_shell (with safety guards + approval gate)
│   │       ├── git.ts             # Git tools: status, diff, commit, branch, push, pull, fetch, log,
│   │       │                      #   pr, stash, reset, cherry_pick
│   │       ├── lsp.ts             # LSP tools: diagnostics, hover, completion, references, rename
│   │       ├── skills.ts          # Skills tools: read_skill, find_skills
│   │       ├── web.ts             # Web tools: web_search, web_fetch, http_request, enhanced_web_search
│   │       ├── system.ts          # System tools: environment_info, sleep
│   │       ├── scheduler.ts       # Cron/scheduler tools for agents
│   │       ├── screenshot.ts      # Screenshot capture tool
│   │       ├── process.ts         # Process tools: run_background, check_process, kill_process, list_background_jobs
│   │       ├── communication.ts   # Cross-agent messaging: request_human_input
│   │       └── ignore.ts          # File ignore pattern helpers
│   ├── db/               # Database layer
│   │   ├── schema.ts          # Drizzle schema — single source of truth for all Drizzle-managed tables
│   │   ├── connection.ts      # SQLite connection (WAL mode, corruption-safe)
│   │   ├── migrate.ts         # Migration runner
│   │   ├── seed.ts            # Built-in agent definitions + system prompts
│   │   ├── migrations/        # Versioned SQL migration files (v1–v8)
│   │   └── audit.ts           # Audit log helpers
│   ├── rpc/              # RPC handlers (one file per domain, registered in rpc-registration.ts)
│   │   ├── kanban.ts          # Kanban CRUD RPCs
│   │   ├── conversations.ts   # Conversation + message RPCs
│   │   ├── projects.ts        # Project CRUD RPCs
│   │   ├── settings.ts        # Global settings RPCs
│   │   ├── agents.ts          # Agent config RPCs
│   │   ├── git.ts             # Git operation RPCs
│   │   ├── deploy.ts          # Deploy environment + history RPCs
│   │   ├── notes.ts           # Notes RPCs
│   │   ├── inbox.ts / inbox-rules.ts  # Inbox RPCs
│   │   ├── cron.ts            # Cron job RPCs
│   │   ├── discord.ts / whatsapp.ts / email.ts  # Channel RPCs
│   │   ├── skills.ts          # Skills discovery + refresh RPCs
│   │   ├── lsp.ts             # LSP server management RPCs
│   │   ├── analytics.ts / audit.ts / automation.ts  # Analytics, audit log, automation RPCs
│   │   ├── github-issues.ts / github-api.ts / branch-strategy.ts  # GitHub RPCs (github-issues.ts: issue↔kanban two-way sync; github-api.ts: gitAuthArgs/githubAuthPrefix/pushBranchAuthenticated — token auth via inline header w/ credential helper DISABLED, never stores creds/prompts)
│   │   ├── pulls.ts           # Pull request RPCs
│   │   ├── notifications.ts   # Notification preference RPCs
│   │   ├── dashboard.ts / search.ts / providers.ts / prompts.ts  # Misc RPCs
│   │   └── (+ backup, db-viewer, export-import, health, maintenance, mcp, plugin-extensions, reset)
│   ├── channels/         # External channel adapters (Discord, WhatsApp, Email)
│   │   ├── manager.ts         # ChannelManager — routes inbound messages, broadcastTaskDoneNotification
│   │   ├── types.ts           # ChannelAdapter interface (incl. optional getDefaultRecipient())
│   │   ├── discord-adapter.ts
│   │   ├── whatsapp-adapter.ts
│   │   ├── email-adapter.ts
│   │   └── chunker.ts         # Long-message chunking for channel delivery
│   ├── providers/        # AI provider adapters
│   │   ├── index.ts           # createProviderAdapter() factory
│   │   ├── models.ts          # Model catalogue + getDefaultModel() + getContextLimit()
│   │   ├── anthropic.ts / openai.ts / openrouter.ts / ollama.ts
│   ├── scheduler/        # Cron + automation engine
│   │   ├── cron-scheduler.ts  # croner-based job scheduler (restart-safe)
│   │   ├── automation-engine.ts  # Event-triggered automation rules
│   │   └── event-bus.ts       # Internal pub/sub event bus
│   ├── plugins/          # Plugin system
│   │   ├── loader.ts / registry.ts / manifest.ts / api.ts / extensions.ts
│   │   └── lsp-manager/       # LSP server lifecycle management
│   ├── skills/           # Skills system
│   │   ├── loader.ts          # Parses SKILL.md, frontmatter, bash injection, substitutions
│   │   └── registry.ts        # In-memory SkillRegistry, dual-dir loading (bundled + user)
│   ├── discord/          # Discord bot
│   │   └── bot.ts             # DiscordBot — discord.js client wrapper (used by DiscordAdapter)
│   ├── issue-fixer/      # Issue Fixer — autonomous GitHub-issue → branch/PR resolution
│   │   ├── poller.ts          # 60s tick; polls enabled projects' issues/comments at their interval
│   │   ├── triggers.ts        # agentdesk-* keyword/label + authorization matching; dedup/cooldown/cursor
│   │   ├── orchestrator.ts    # per-project queue; runs the issue-fixer agent → branch/test/commit/push/PR (never merges)
│   │   ├── prompts.ts         # intent keywords + dynamic per-run task builder
│   │   ├── shell-guard.ts     # guarded auto-shell denylist (no merge/force-push/base-branch push)
│   │   ├── github.ts          # GitHub API client (issues/comments/PR comments, create PR, post comments)
│   │   ├── config.ts          # issue_fixer_config + issue_fix_runs persistence
│   │   └── notify.ts          # success/failure summaries to all connected channels
│   ├── remote-sync/      # Remote Sync — per-project SFTP/FTP file sync (Remote tab)
│   │   ├── crypto.ts          # AES-256-GCM credential encryption (key file under userData, separate from DB)
│   │   ├── client.ts          # Protocol-agnostic RemoteClient over ssh2-sftp-client (SFTP) + basic-ftp (FTP/FTPS)
│   │   ├── config.ts          # remote_sync_config + remote_sync_items (manifest) + remote_sync_runs persistence
│   │   └── engine.ts          # test/browse/pull/diff/push orchestration; per-project lock; broadcast progress
│   ├── engine-manager.ts # Creates + caches AgentEngine per project; global abort tracking
│   ├── rpc-registration.ts  # Registers all RPC handlers with Electrobun
│   └── index.ts          # Main Bun process entry point
│
├── mainview/             # React frontend (rendered in Electrobun webview)
│   ├── pages/            # Top-level route pages
│   │   ├── dashboard.tsx      # Project list + new project
│   │   ├── project.tsx        # Project view shell (chat + activity + kanban + git + deploy tabs)
│   │   ├── onboarding.tsx     # First-run provider setup
│   │   ├── settings/          # Settings sub-pages (general, providers, github, channels,
│   │   │                      #   notification-settings, appearance, ai-debug, constitution, etc.)
│   │   ├── inbox.tsx / agents.tsx / analytics.tsx / plugins.tsx / scheduler.tsx / skills.tsx
│   ├── components/       # Reusable UI components
│   │   ├── chat/              # Chat input, message list, message bubble, message parts, slash commands
│   │   ├── activity/          # Context panel (docs tab, files tab)
│   │   ├── notes/             # Full Docs page (notes-tab.tsx — list + markdown preview)
│   │   ├── kanban/            # Kanban board, columns, cards, task detail modal, stats bar
│   │   ├── git/               # Branch list, commit log, diff viewer, PR management,
│   │   │                      #   conflicts (view + abort + "Resolve with AI" → seeds a PM chat),
│   │   │                      #   GitHub issues (issue↔kanban link/create/auto-close), branch strategy
│   │   ├── deploy/            # Deploy tab
│   │   ├── remote-sync/       # Remote tab — SFTP/FTP sync (tab + connection form + lazy tree + push diff dialog)
│   │   ├── modals/            # new-project-modal.tsx, startup-health-dialog.tsx
│   │   ├── layout/            # app-shell.tsx, sidebar.tsx, topnav.tsx (+ project-branch-badge.tsx — live current-branch indicator next to the project name, polls getCurrentBranch)
│   │   └── ui/                # Primitive UI components (button, dialog, badge, mermaid-diagram, password-input, unified-diff, etc.)
│   ├── stores/           # Zustand state stores
│   │   ├── chat-store.ts      # Core conversation + message store
│   │   ├── chat-types.ts      # Message, ActiveInlineAgent, ChatState types
│   │   ├── chat-event-handlers.ts  # DOM event handlers for RPC broadcasts
│   │   └── kanban-store.ts    # Kanban task state
│   ├── lib/
│   │   ├── rpc.ts             # Typed RPC client (calls into Bun backend)
│   │   └── types.ts / utils.ts / date-utils.ts
│   └── router.tsx         # TanStack Router route definitions
│
└── shared/               # Types shared between Bun + frontend
    └── rpc/               # RPC contract types (one file per domain)
        └── index.ts       # Re-exports all RPC contracts
```

---

## Agent Orchestration

- **`AgentEngine`** (`src/bun/agents/engine.ts`) — streams PM responses; runs inline sub-agents; hosts soft approval gate for pending plans
- **`agent-loop.ts`** (`src/bun/agents/agent-loop.ts`) — inline sub-agent executor; exports `READ_ONLY_AGENTS` set
- **`review-cycle.ts`** (`src/bun/agents/review-cycle.ts`) — fully independent code review cycle; auto-spawns code-reviewer when tasks move to "review" column; no WorkflowEngine dependency
- **`handoff.ts`** (`src/bun/agents/handoff.ts`) — generates handoff summaries from modified files; prepended to next agent's task as `## Prior Work`
- **`EngineManager`** (`src/bun/engine-manager.ts`) — one AgentEngine per project, cached in memory; global abort controller registry; `broadcastTaskDoneNotification` via channels
- **PM is the sole orchestrator** — classifies requests, dispatches agents, manages kanban tasks directly. There is no separate WorkflowEngine state machine.
- **Plan → Approve → Execute flow**: PM calls `request_plan_approval` (shows plan card in chat), user replies "approve", PM calls `create_tasks_from_plan` then dispatches agents via `run_agent`
- Kanban flow: **backlog → working → review → done**. Agents cannot skip columns. Move to "done" is reserved for the review system via `submit_review`.
- **Sequential Single-Agent Model**: Write agents execute one at a time. Read-only agents (`code-explorer`, `research-expert`, `task-planner`) can run in parallel via `run_agents_parallel`. Enforcement: `writeAgentRunning` closure guard in PM tools.
- **Automatic Code Review**: When a task moves to "review", `review-cycle.ts` automatically spawns a code-reviewer. On `submit_review(approved)` → task moved to done. On rejection → back to working (up to `maxReviewRounds`, default 2).
- **Inline Agent Execution**: Sub-agents run inline in the main conversation via `run_agent` / `run_agents_parallel`. Each agent gets a fresh context (system prompt + task only) and its tool calls are visible as message parts in chat.
- **Feature Branch Workflow**: PM calls `set_feature_branch` (AI-generates branch name from conversation) before dispatching agents. `autoCommitTask` in `review-cycle.ts` switches to/creates the branch before committing.
- **Anthropic Prompt Caching**: System prompts include cache control metadata for Anthropic/OpenRouter providers (~90% cheaper on cache hits).
- **Context Window Management**: Agent loops track `lastPromptTokens / getContextLimit(modelId)`. Progressive compaction tiers at 60/70/85/90% context usage. No iteration cap — agents run until task complete or context truly full.
- **Playground** (`src/bun/playground/`): An Artifacts-style page (sidebar after Council) where the dedicated `playground-agent` (display name "Playground Agent"; ALL tools/skills/MCP — it has NO `agent_tools` rows, so `getToolsForAgent` returns the full registry) builds previewable artifacts into an OS-temp folder and renders them live in an in-page `<iframe>`. Reuses `runInlineAgent` via three new options (`priorMessages`, `persistToDb:false`, `extraTools`) — fully decoupled from the PM/kanban/review paths. Conversation persists to JSON in temp (not the DB); activity streams via `agentdesk:playground-*` broadcasts. `orchestrator.ts` runs the agent + injects an auto-approved `run_shell` + the `playground_render_preview`/`playground_reject` tools; `server.ts` is a `Bun.serve` static server (port 4760+) for static artifacts (the agent starts its own dev server for live SPAs). Dev servers the agent starts are persisted to `.playground/servers.json` (command + cwd) so that after an app restart — which kills them — they reappear in the toolbar "Servers" strip as **stopped** with a ▶ start button (`startPlaygroundDevServer` re-runs them via the shared `startBackgroundJob` in `process.ts`, then reloads the devserver preview iframe). Explicitly stopping a server (✕) removes it from `servers.json`. "New Playground" wipes temp + kills its dev servers (`killJobsUnderPath` in `process.ts`); "Create Project" promotes it via `createProjectHandler` + `fs.cpSync`.

---

## Database Tables (schema: `src/bun/db/schema.ts`)

**Drizzle-managed** (in schema.ts):

`settings` · `ai_providers` · `projects` · `agents` · `agent_tools` ·
`conversations` · `messages` · `message_parts` · `conversation_summaries` · `notes` ·
`kanban_tasks` · `kanban_task_activity` · `plugins` · `channels` ·
`deploy_environments` · `deploy_history` · `prompts` · `inbox_messages` ·
`whatsapp_sessions` · `notification_preferences` · `inbox_rules` ·
`cron_jobs` · `cron_job_history` · `automation_rules` ·
`pull_requests` · `pr_comments` · `webhook_configs` · `webhook_events` ·
`github_issues` · `branch_strategies` · `cost_budgets` · `audit_log` ·
`issue_fixer_config` · `issue_fix_runs` · `project_activity` ·
`remote_sync_config` · `remote_sync_items` · `remote_sync_runs`

**Raw SQL migrations** (created by migration files, not in schema.ts):


`keyboard_shortcuts` (v1)

> Note: `agent_sessions` and `agent_session_messages` tables were created in v3 but dropped in v4 when the inline agent model replaced persistent agent sessions. `message_parts` is now managed by Drizzle in `schema.ts`.

> Feature branch name is persisted in `settings` table under key `currentFeatureBranch:<projectId>` with category `git`.

---

## Built-in Agent Roster (`src/bun/db/seed.ts`)

Read-only agents (can run in parallel via `run_agents_parallel`): `code-explorer`, `research-expert`, `task-planner`

| Internal Name | Display Name | Read-only | Role |
|---|---|---|---|
| `project-manager` | Project Manager | — | Orchestrator — talks to humans, runs sub-agents inline via `run_agent` / `run_agents_parallel` |
| `task-planner` | Task Planner | Yes | Creates plan docs + structured task definitions via `define_tasks` |
| `code-explorer` | Code Explorer | Yes | Codebase exploration, dependency mapping |
| `research-expert` | Research Expert | Yes | Web research, technical investigation |
| `software-architect` | Software Architect | No | System design and architecture decisions |
| `backend-engineer` | Backend Engineer | No | Server-side implementation |
| `frontend_engineer` | Frontend Engineer | No | UI implementation |
| `database-expert` | Database Expert | No | DB schema design, query optimisation, indexing, migrations |
| `api-designer` | API Designer | No | REST/GraphQL/gRPC design, OpenAPI specs |
| `mobile-engineer` | Mobile Engineer | No | React Native, Expo, iOS/Android |
| `ml-engineer` | ML Engineer | No | LLM integration, prompt engineering, RAG, vector stores |
| `code-reviewer` | Code Reviewer | No | Reviews completed work (auto-spawned by review-cycle.ts) |
| `qa-engineer` | QA Engineer | No | Runs tests, verifies acceptance criteria |
| `devops-engineer` | DevOps Engineer | No | Deployments, CI/CD, infrastructure |
| `documentation-expert` | Documentation Expert | No | Documentation generation |
| `debugging-specialist` | Debugging Specialist | No | Root-cause analysis and bug fixing |
| `performance-expert` | Performance Expert | No | Profiling and optimization |
| `security-expert` | Security Expert | No | Security review and hardening |
| `ui-ux-designer` | UI/UX Designer | No | Interface and experience design |
| `data-engineer` | Data Engineer | No | Data pipelines and storage |
| `refactoring-specialist` | Refactoring Specialist | No | Code restructuring and technical debt reduction |
| `playground-agent` | Playground Agent | No | Exclusive to the Playground page — builds previewable artifacts with ALL tools/skills/MCP (no `agent_tools` rows ⇒ full registry). Hidden from the PM (excluded in `prompts.ts`) AND from the Agents page (excluded in `getAgentsList`); never orchestrated. Internal name was `general-agent` but collided with users' own custom agents, so it was renamed; migration v26 deletes the legacy `general-agent` row once on upgrade. |
| `issue-fixer` | Issue Fixer | No | Exclusive to the per-project **Issue Fixer** feature — autonomously resolves GitHub issues and opens PRs. ALL tools/skills/MCP incl. chrome-devtools + git tools (no `agent_tools` rows ⇒ full registry); `request_human_input`/`git_push`/`git_pr` excluded at run time. Hidden from the PM (`prompts.ts`) AND the Agents page (`getAgentsList`); never orchestrated. Inserted idempotently by `seed.ts` (no migration needed — new name, no collision). NEVER merges. |

---

## RPC Pattern

All frontend → backend calls go through Electrobun's typed RPC system.

- **Contracts**: `src/shared/rpc/*.ts` — define input/output shapes
- **Handlers**: `src/bun/rpc/*.ts` — implement the logic
- **Registration**: `src/bun/rpc-registration.ts` — wires handlers to Electrobun
- **Client**: `src/mainview/lib/rpc.ts` — typed caller used by React components

When adding a new RPC: define the contract in `src/shared/rpc/`, implement the
handler in `src/bun/rpc/`, register it in `rpc-registration.ts`, and call it
from the frontend via `src/mainview/lib/rpc.ts`.

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

- **Before starting any task, read and follow .agent-atlas/index.json — a codebase navigation layer providing domain docs, a keyword→file:line concepts index, conventions, and constraints.**
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
- Always keep `CLAUDE.md` and `workflow.md` updated if they deviates from current code.
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

---

### MUST FOLLOW THIS RULE:

Before starting any task, read and follow .agent-atlas/index.json — a codebase navigation layer providing domain docs, a keyword→file:line concepts index, conventions, and constraints.

---
