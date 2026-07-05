---
title: AgentDesk — Architecture Overview
type: overview
status: verified
verified_at: 2026-07-06
sources:
  - CLAUDE.md
  - docs/workflow.md
  - src/bun/index.ts
  - src/bun/agents/engine.ts
  - src/bun/engine-manager.ts
tags: [overview, architecture, orchestration, electrobun]
---

# AgentDesk — Architecture Overview

**AgentDesk is a cross-platform desktop app where autonomous AI agent teams run
the whole software-development lifecycle — planning, coding, reviewing, testing —
while humans only approve plans, deploy, and communicate.** The motto is *"99%
agent-driven. Humans approve, deploy, and communicate."* The single most
important thing to understand is the orchestration model: there is **no workflow
state machine**. A Project Manager (PM) agent is the sole orchestrator — it
classifies the request, plans, gets approval, dispatches specialist sub-agents
inline, and drives them to "done" — all inside one LLM streaming loop. See
[[pm-sole-orchestrator]].

This page is the 10,000-ft map. Every named subsystem links to its own page;
start at `index.md` for the full catalog.

---

## What it is, physically

AgentDesk is an **Electrobun** app: a Bun runtime process driving a native OS
webview (Electrobun is *not* Electron — different architecture/APIs). That gives
two halves connected by a typed RPC bridge:

| Half | Runtime | Role |
|---|---|---|
| **Backend** | Bun (TypeScript) main process | Agents, DB, AI providers, channels, git, schedulers, plugins — all business logic |
| **Frontend** | React 19 SPA in the webview | Chat, kanban, git, deploy, settings UI — no business logic, only RPC + render |

The Bun process boots in `src/bun/index.ts` in a deliberate order: global error
handlers → migrations (`runMigrations`) → seed (`seedDatabase`) → WAL checkpoint
timer → plugins, skills, schedulers, channels, MCP clients, the issue-fixer
poller, and the auxiliary servers, then creates the `BrowserWindow`. That startup
ordering is the [[backend-core]] story. The React side is a hash-routed TanStack
Router tree under a persistent `AppShell` — see [[frontend-architecture]].

---

## The two halves and the seam between them

All frontend → backend calls cross **one boundary**: Electrobun's typed RPC. The
contract lives in `src/shared/rpc/*.ts`, handlers in `src/bun/rpc/*.ts`,
registration in `src/bun/rpc-registration.ts`, and the renderer client in
`src/mainview/lib/rpc.ts`. The reverse direction (backend → frontend) is
**broadcasts**: the backend emits `agentdesk:*` events that the webview re-emits
as DOM `CustomEvent`s, which Zustand stores listen to. This is the spine of live
agent output reaching the chat UI.

- Boundary mechanics + "how to add an RPC end-to-end": [[rpc-layer]]
- Renderer-side bridge (defineRPC, broadcast re-emitters): [[rpc-client]]
- Stores driven by those events: [[frontend-stores]]
- The streaming/broadcast flow itself: [[message-streaming-broadcasts]]

> **Invariant:** the RPC contract is *the* interface. The frontend never touches
> the DB directly. See [[conventions-constraints]].

---

## The orchestration core

The heart is the [[agent-engine]]: `AgentEngine` (`src/bun/agents/engine.ts`)
streams PM responses and runs **inline sub-agents** in the same conversation. One
engine exists per project, cached by [[backend-core]]'s `EngineManager`
(`src/bun/engine-manager.ts`), which also owns the global abort registry and the
task-done channel broadcast.

Three design pillars define the model:

1. **PM as sole orchestrator** — no FSM. Workflow state lives in the PM's
   conversation context plus the kanban board. Transitions are enforced by a mix
   of prompt rules, tool-level code guards, and recomputed `[Next Action]` hints.
   Task *authorship* is code-restricted too: the PM has no `create_task` tool —
   only the task-planner can author kanban tasks; the PM reads/moves tasks and
   commits already-approved plans via `create_tasks_from_plan`.
   ([[pm-sole-orchestrator]])
2. **Inline sub-agents, not sessions** — v4 dropped the persistent
   `agent_sessions` tables. Each sub-agent gets a *fresh* context (system prompt +
   task only), its tool calls render as message parts, and continuity between
   sequential tasks comes from handoff summaries, not shared history.
   ([[inline-agents-vs-sessions]])
3. **Sequential write agents** — only one write agent runs at a time
   (`writeAgentRunning` guard); read-only agents (`code-explorer`,
   `research-expert`, `task-planner`) may run in parallel via
   `run_agents_parallel`. ([[agent-roster]])

Agents act through a **role-filtered tool registry** ([[agent-tools]]):
`getToolsForAgent` returns the full registry only when an agent has zero
`agent_tools` rows; tools are bound per run with workspace, file tracking, and
read-only/exclude filters. Tools reach into [[providers]] (the provider-agnostic
AI SDK adapter layer), [[skills]] (filesystem SKILL.md capabilities), [[lsp]]
(on-demand language servers), and [[mcp]] (AgentDesk-as-MCP-client). Agent system
prompts are seeded — never inlined in engine code — into [[database]] via
`seed.ts` (see [[conventions-constraints]]).

---

## The core lifecycle: plan → approve → execute → review → done

This is the spine of the whole product, and the one flow every contributor must
internalise:

```
Human request
  → PM runs task-planner inline (run_agent)
  → task-planner: create_note (Docs plan) + define_tasks (structured, pre-approval)
  → PM: request_plan_approval → plan card in chat / chunked to channels → PM turn ends
  → Human: "approve"  (PM LLM interprets approval intent; no pre-LLM keyword gate)
  → PM: create_tasks_from_plan → kanban tasks created in "backlog" (deterministic, no LLM)
  → PM: run_agent(worker, task) → agent works → move_task(..., "review")
  → review-cycle auto-spawns code-reviewer → submit_review(approved) → task "done"
  → repeat for each task → PM delivers completion summary
```

- The planning-through-dispatch half: [[plan-approve-execute]]
- The column enforcement + auto-review half: [[kanban-review-cycle]]

Two hard rules separate the phases. **Kanban tasks are created only after
approval** — the plan note is the pre-approval communication artifact, kanban is
the post-approval execution artifact. And **agents may move tasks to `working`
and `review` but never `done`** — only the review cycle (`review-cycle.ts`, via
`submit_review`) promotes to done, retrying up to `maxReviewRounds` (default 2)
before a force-done with a warning note. The column flow
`backlog → working → review → done` is enforced; agents cannot skip columns.

Surrounding flows keep this sane at scale:

- **Feature-branch workflow** — opt-in mode where the PM declares an AI-generated
  `feature/<slug>` (stored in `settings`) and `autoCommitTask` switches to it
  before each commit. ([[feature-branch-workflow]])
- **Context-window management** — durable PM-conversation summarization plus the
  inline sub-agent 60/70/85/90% progressive compaction ladder; no iteration cap.
  ([[context-window-management]])
- **Handoff summaries** — each finished agent's modified files become a
  `## Handoff Summary` note on the completed kanban task, surfaced to the PM as
  `get_next_task`'s `priorWork` field; the PM prompt instructs it to fold that
  into the next agent's task description. (see [[agent-engine]])

---

## Feature verticals

Around the orchestration core sit largely-decoupled feature verticals. Each is a
self-contained subsystem the PM/kanban path does not depend on:

| Vertical | What it does | Page |
|---|---|---|
| **Channels** | Discord/WhatsApp/Email two-way sync — inbound messages enter the same `engine.sendMessage`, PM replies + task-done broadcasts go back out | [[channels]] |
| **Issue Fixer** | Autonomous GitHub-issue → branch/PR via outbound polling + a hidden agent that only edits files; orchestrator owns git and **never merges** | [[issue-fixer]] |
| **Issue Sources** | Multi-tracker integration (GitHub/Jira/Linear/GitLab/Trello/Kanboard) normalised into `external_issues`; link/create/auto-close vs kanban | [[issue-sources]] |
| **Remote Sync** | Per-project SFTP/FTP/FTPS pull/push with AES-256-GCM credential encryption + SHA manifest diffing | [[remote-sync]] |
| **Playground** | Artifacts-style live-preview builder; the `playground-agent` builds web artifacts into a temp folder rendered in an in-page iframe | [[playground]] |
| **Freelance Auto-Earn** | Opt-in autonomous bid/reply over the user's *own* freelance session, gated by a Behavior Governor + anomaly breaker | [[freelance-autoearn]] |
| **Scheduler & Automation** | Cron jobs (restart-safe) + event-triggered rules, both funneling through one `executeTask()` sink | [[scheduler-automation]] |
| **Plugins** | In-process manifest + `activate(api)` framework contributing tools/prompts/UI; hosts the LSP Manager | [[plugins]] |
| **Notifications** | OS desktop toasts via ungated + preference-gated paths | [[notifications]] |

Several verticals encode hard-won decisions worth reading before touching them:
[[freelance-own-session]] (never fingerprint-spoof an owned account),
[[bid-feasibility-buildability]] (verdicts judge only "can agents code 100% of
the ask"), and [[github-token-auth]] (inline-header auth, credential helper
disabled).

---

## Data + AI substrate

- **Database** — a single SQLite file (WAL mode) accessed two ways: Drizzle ORM
  (`db`) for managed tables in `schema.ts`, and raw statements (`sqlite`) for a
  few migration-only tables. A `user_version` migration runner with auto-backup
  plus an idempotent `ensureRuntimeSchema` safety net keeps existing users'
  databases forward-compatible — **schema changes require a new migration file**.
  ([[database]], full table list in [[database-tables]])
- **AI providers** — `createProviderAdapter()` maps a stored config to an AI SDK
  `LanguageModel`. Adapters only build the model handle; thinking budgets, prompt
  caching, and context limits are applied one layer up. Anthropic/OpenAI/Gemini/
  DeepSeek/Groq/xAI/OpenRouter/Ollama, plus [[claude-subscription]] (reuses
  Claude Code's OAuth token). ([[providers]])

---

## How the pieces connect (one mental model)

```
                 ┌──────────────── React SPA (webview) ────────────────┐
   user types →  │  chat / kanban / git / deploy / settings UI          │
                 │  Zustand stores ← agentdesk:* DOM CustomEvents        │
                 └───────▲────────────────────────────────┬─────────────┘
                  typed RPC (lib/rpc.ts)            broadcasts │
                 ┌───────┴────────────────────────────────▼─────────────┐
                 │  rpc-registration.ts → rpc/*.ts handlers              │
                 │  EngineManager → AgentEngine (per project)            │
                 │    PM loop → run_agent → inline sub-agent             │
                 │      tools → providers / file-ops / git / skills      │
                 │      kanban → review-cycle → done                     │
                 │  SQLite (Drizzle + raw) · channels · schedulers       │
                 │  issue-fixer · remote-sync · playground · freelance   │
                 └──────────────────────────────────────────────────────┘
   external in →  Discord / WhatsApp / Email / GitHub issues  (→ engine)
```

A request — from in-app chat *or* a channel — lands at
`AgentEngine.sendMessage`, passes the soft approval gate, drives the PM loop, and
streams output back over broadcasts to the stores that paint the UI. Everything
else hangs off that spine.

---

## Where to go next

- New here? Read [[plan-approve-execute]] + [[kanban-review-cycle]] to understand
  the product's core loop, then [[agent-engine]] for the implementation.
- Looking for a file? [[directory-map]] is the navigable repo map.
- Build/release/dev commands: [[tech-stack-build-release]].
- The rules you must not break: [[conventions-constraints]].

---

## Related
- [[pm-sole-orchestrator]]
- [[agent-engine]]
- [[plan-approve-execute]]
- [[kanban-review-cycle]]
- [[rpc-layer]]
- [[backend-core]]
- [[frontend-architecture]]
- [[database]]
- [[directory-map]]
- [[conventions-constraints]]

## Open questions
- None. (This page is intentionally a map; depth lives in the linked pages, and
  any drift there should be fixed on those pages, then re-summarised here.)
