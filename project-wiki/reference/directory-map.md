---
title: Directory Map (Structural Index)
type: reference
status: verified
verified_at: 2026-06-27
sources:
  - src/bun/index.ts
  - src/bun/rpc-registration.ts
  - src/bun/agents/tools/index.ts
  - src/bun/engine-manager.ts
  - src/mainview/router.tsx
  - src/mainview/lib/rpc.ts
  - src/shared/rpc/index.ts
  - electrobun.config.ts
  - package.json
tags: [structure, navigation]
---

# Directory Map (Structural Index)

**The lookup layer for "where does X live?"** This is the authoritative structural
index for the repo. AgentDesk is an [[backend-core|Electrobun]] app: a single
**Bun main process** (`src/bun/`) talks to a **React webview** (`src/mainview/`)
over a typed RPC bridge whose contracts live in `src/shared/`. Everything below
maps a file/dir to its role, and — more importantly — explains the *seams* that
grep can't show: the four entry points, the RPC boundary, and the per-agent tool
registry that gate how data flows through the app.

> Note: the repo-root `CLAUDE.md` layout section is the human map but has drifted
> in places (e.g. it omits `src/bun/rpc-groups/`, `src/bun/annotations/`,
> `src/bun/freelance/expert/`, `src/bun/claude/`, and the `council` / `playground`
> routes). This page is the verified structural truth.

## The four anchors (read these first)

Everything wires through four files. Find one of these and you can trace any feature:

| Anchor | File | What it bootstraps |
|---|---|---|
| Bun main entry | `src/bun/index.ts:1` | App lifecycle: migrations → seed → plugins → channels → cron/automation → issue-fixer poller → MCP → annotation/playground servers → `BrowserWindow`. Wires every subsystem's init/shutdown. |
| RPC registration | `src/bun/rpc-registration.ts:32` | `BrowserView.defineRPC<AgentDeskRPC>` — spreads the combined handler map (`requestHandlers`, imported from `remote/rpc-handlers.ts`) and wraps it with an error-toast broadcaster (`rpc-registration.ts:15`). `maxRequestTime: Infinity` so multi-minute agent runs don't time out. |
| Webview entry | `src/mainview/main.tsx:4` → `App.tsx:12` → `router.tsx` | React root; `RouterProvider` drives a hash-history router (`router.tsx:5`). |
| RPC client | `src/mainview/lib/rpc.ts:15` | `Electroview` instance + typed wrappers; the *only* path from React into Bun. Also dispatches DOM events for backend broadcasts (`rpc.ts:10`). |

The RPC contract type `AgentDeskRPC` is assembled in `src/shared/rpc/index.ts:1`
from one `*Requests` type per domain — this is the interface boundary both sides
compile against. See [[rpc-layer]] and [[rpc-client]].

## src/bun — the main process

### Orchestration core
| Path | Role |
|---|---|
| `src/bun/index.ts` | Main entry / lifecycle (see anchors). |
| `src/bun/engine-manager.ts` | One `AgentEngine` per project, cached in memory (`getOrCreateEngine` at `engine-manager.ts:459`, instantiation at `:623`); global abort registry; `broadcastToWebview`. See [[agent-engine]]. |
| `src/bun/rpc-registration.ts` | Wires all RPC handlers (see anchors). |
| `src/bun/windows-registry.ts` | Registers the Windows uninstaller entry. |

### `agents/` — agent engine & orchestration
| Path | Role |
|---|---|
| `agents/engine.ts` | `AgentEngine` — streams PM responses, runs inline sub-agents, hosts the soft plan-approval gate. [[agent-engine]] |
| `agents/agent-loop.ts` | Inline sub-agent executor; exports `READ_ONLY_AGENTS`. [[inline-agents-vs-sessions]] |
| `agents/review-cycle.ts` | Standalone auto code-review cycle (spawns code-reviewer on move to "review"). [[kanban-review-cycle]] |
| `agents/prompts.ts` | System-prompt builders (PM + sub-agents); excludes hidden agents (playground, issue-fixer). |
| `agents/context.ts` / `context-notes.ts` | Conversation context assembly + README/plan-as-notes sync. [[context-window-management]] |
| `agents/handoff.ts` | Handoff summaries between sequential tasks. |
| `agents/summarizer.ts` | Auto-compaction of long conversations. |
| `agents/project-snapshot.ts` | Directory-tree snapshot injected into agent context. |
| `agents/kanban-integration.ts` | Bridges kanban UI events → engine. |
| `agents/safety.ts` | Transient-error detection + backoff. |
| `agents/prompt-logger.ts` | Dumps prompts to disk for debugging. |
| `agents/last-msg-store.ts` | Stores last message per conversation (resume/recovery). |
| `agents/engine-types.ts` / `types.ts` | Engine callback + shared agent types. |

### `agents/tools/` — the agent tool registry
`tools/index.ts` is the **filter seam**: `getToolsForAgent(name)`
(`tools/index.ts:100`) reads `agent_tools` rows and returns only enabled tools —
unless an agent has **zero** rows, in which case it gets the full registry (this
is why `playground-agent` / `issue-fixer` see everything). One file per tool family:

| Path | Tools |
|---|---|
| `tools/index.ts` | Registry assembly + per-agent filtering. [[agent-tools]] |
| `tools/pm-tools.ts` | `run_agent`, `run_agents_parallel`, plan-approval, task creation, feature-branch, status reads. |
| `tools/kanban.ts` | create/move/update/get/delete tasks, `submit_review`. |
| `tools/file-ops.ts` | read/write/edit/patch/list/tree/search/diff/archive/etc. |
| `tools/file-tracker.ts` | Per-run read/write tracking → `filesModified`. |
| `tools/shell.ts` | `run_shell` (safety guards + approval gate). |
| `tools/git.ts` | status/diff/commit/branch/push/pull/pr/stash/reset/cherry_pick. |
| `tools/lsp.ts` | diagnostics/hover/completion/references/rename. [[lsp]] |
| `tools/web.ts` | web_search / web_fetch / http_request. |
| `tools/skills.ts` | read_skill / find_skills. [[skills]] |
| `tools/notes.ts` · `planning.ts` · `system.ts` · `process.ts` · `scheduler.ts` · `screenshot.ts` · `communication.ts` · `truncation.ts` · `ignore.ts` | Notes CRUD, `define_tasks`, env/sleep, background jobs, cron, screenshot capture, `request_human_input`, output truncation-to-disk, ignore patterns. |
| `tools/playground.ts` · `preview.ts` | Playground render/reject + preview tools. [[playground]] |

### `db/` — database layer
| Path | Role |
|---|---|
| `db/schema.ts` | Drizzle schema — single source of truth for Drizzle-managed tables. [[database]] |
| `db/connection.ts` | SQLite (WAL, corruption-safe) connection. |
| `db/migrate.ts` | Migration runner. |
| `db/seed.ts` | Built-in agent roster + system prompts. |
| `db/migrations/` | Versioned migrations **v1–v43** (`v1_initial-schema.ts` … `v43_freelance-client-quality.ts`). Raw-SQL tables not in schema.ts (e.g. `keyboard_shortcuts`) are created here. |
| `db/audit.ts` · `summaries.ts` · `maintenance.ts` · `error-logger.ts` · `index.ts` | Audit log, conversation summaries, startup maintenance, global error capture, `db` export. |

### `rpc/` and `rpc-groups/` — the handler layer
`rpc/*.ts` = one implementation file per domain (~55 files: `kanban.ts`,
`conversations.ts`, `projects.ts`, `git.ts`, `deploy.ts`, `issues.ts`,
`freelance*.ts`, `playground.ts`, `council.ts`, `pulls.ts`, `discord/whatsapp/email.ts`,
`updater*.ts`, etc.). `rpc-groups/*.ts` = **eight aggregator modules** that bundle
those handlers: `settings-providers`, `projects-system`, `conversations-control`,
`agents-kanban-notes`, `git-analytics`, `channels-inbox-scheduler`,
`plugins-tools`, `features` (+ `setting-callbacks` for `onSettingChange`). All
eight are combined into one `requestHandlers` map in `remote/rpc-handlers.ts:31`
(single source of truth for both transports), which `rpc-registration.ts:12`
imports and spreads into `defineRPC`. See [[rpc-layer]].

### Feature subsystems (each owns init/shutdown called from `index.ts`)
| Dir | Role | Wiki |
|---|---|---|
| `channels/` | Discord / WhatsApp / Email adapters + `ChannelManager`. | [[channels]] |
| `providers/` | AI provider adapters (anthropic, openai, google, deepseek, groq, xai, openrouter, ollama, zai, opencode) + `models.ts` catalogue + factory `index.ts`. | [[providers]] |
| `claude/` | `feature-flag.ts` — Claude subscription/Max gating. | [[claude-subscription]] |
| `scheduler/` | Cron scheduler, automation engine, event bus, task executor. | [[scheduler-automation]] |
| `plugins/` | Plugin loader/registry/manifest/api/extensions + `lsp-manager/`. | [[plugins]] |
| `skills/` | SKILL.md loader + in-memory registry (bundled + user dirs). | [[skills]] |
| `lsp/` | LSP client/installer/jsonrpc/servers. | [[lsp]] |
| `mcp/` | `client.ts` — MCP client init/shutdown. | [[mcp]] |
| `discord/` | `bot.ts` — discord.js wrapper used by the adapter. | [[channels]] |
| `issue-fixer/` | Autonomous GitHub-issue → branch/PR engine (poller/triggers/orchestrator/prompts/shell-guard/github/config/notify). NEVER merges. | [[issue-fixer]] |
| `issue-sources/` | Multi-source issue adapters: github/jira/linear/gitlab/trello/kanboard + registry + config-store + types. | [[issue-sources]] |
| `remote-sync/` | Per-project SFTP/FTP sync (client/config/crypto/engine). | [[remote-sync]] |
| `remote/` | Opt-in remote access (TASK-474+): local WebSocket RPC server + relay client/session that dispatch into the SAME `requestHandlers` map (`remote/rpc-handlers.ts`) the Electrobun bridge uses, plus broadcast forwarding. Gated off unless enabled, so existing users are unaffected. |
| `freelance/` | Auto-Earn freelance engine (see below). | [[freelance-autoearn]] |
| `annotations/` | Agentation toolbar server + preview window + injected script. |
| `notifications/` | Desktop / native OS notifications. |
| `playground/` | Artifacts-style preview: orchestrator + static `Bun.serve` server + temp paths. | [[playground]] |
| `lib/` | Cross-cutting helpers: `git-runner.ts`, `secret-crypto.ts`, `path-utils.ts`, `install-mode.ts`, `encrypt-existing-secrets.ts`. |

### `freelance/` — Auto-Earn (largest subsystem)
| Path | Role |
|---|---|
| `freelance/reply-pipeline.ts` · `bid-pipeline.ts` | Draft/send replies + bids. |
| `freelance/session/{governor,humanize,ingest,normalizer}.ts` | Behavior governor (caps/dedup/pacing), human-paced typing, inbox interception, message normalization. [[auto-earn-end-to-end]] |
| `freelance/{description,similarity,watchdog,fetcher,rss-fetcher,normalizer,budget,currency-exchange}.ts` | Full-description cache, trigram near-dup guard, stuck-row recovery, listing fetch, etc. |
| `freelance/expert/{jobs,notify,orchestrator,tools,vault}.ts` | Expert delivery pipeline (autonomous project execution). |
| `freelance/{feature-flag,settings,auto-earn-settings,events,qa,project-bootstrap,humanizer-prompt}.ts` | Gating, settings, events, QA, bootstrap. |

## src/mainview — the React webview

| Path | Role |
|---|---|
| `main.tsx` / `App.tsx` | React root + `RouterProvider`. |
| `router.tsx` | TanStack hash router; ~14 routes registered via `createRoute` (`router.tsx:32`+): index/dashboard, agents, settings, project, inbox, scheduler, analytics, onboarding, prompts, skills, db-viewer, **council**, **freelance**, **playground**. |
| `lib/rpc.ts` | Typed RPC client (the React→Bun seam). |
| `lib/` | `theme.ts`, `pricing.ts`, `header-context.tsx`, `use-agent-colors.ts`, `global-error-handler.ts`, `date-utils.ts`, `types.ts`, `utils.ts`. |

### `pages/` — route components
Top-level: `dashboard`, `project` (the tab shell: chat/kanban/git/deploy/issues/remote),
`agents`, `inbox`, `scheduler`, `analytics`, `onboarding`, `prompts`, `skills`,
`council`, `freelance`, `playground`, `plugin-db-viewer`, `settings`.
`pages/settings/` holds ~18 sub-pages (general, providers, github, channels-per-platform,
notification-settings, appearance, ai-debug, constitution, data, env-vars, health,
mcp, audit-log, recommendations, tavily-settings). See [[frontend-pages]].

### `components/` — grouped by feature (mirrors backend domains)
`chat/` (input, message list/bubble/parts, tool-call-card, shell-approval, plan-diff),
`kanban/`, `git/` (branch-list, diff-viewer, pull-requests, conflict-resolver,
branch-strategy), `activity/` (context panel + docs/files tabs), `notes/`,
`issues/` + `issue-fixer/`, `deploy/`, `remote-sync/`, `freelance/`, `scheduler/`,
`inbox/`, `dashboard/`, `analytics/`, `project-settings/`, `layout/` (app-shell,
sidebar, topnav, project-branch-badge, project-switcher), `modals/`, and `ui/`
(~35 Radix-based primitives + `mermaid-diagram`, `unified-diff`, `password-input`).
See [[frontend-components]].

### `stores/` — Zustand state
`chat-store.ts` (+ `chat-types.ts`, `chat-event-handlers.ts`, `message-queue.ts`),
`kanban-store.ts`, `freelance-engine-store.ts`, `issue-fixer-store.ts`,
`remote-sync-store.ts`, `playground-store.ts`, `unread-store.ts`. See [[frontend-stores]].

## src/shared — the contract boundary
`shared/rpc/index.ts` assembles `AgentDeskRPC` from per-domain `*Requests` types
(`activity`, `agents`, `analytics`, `conversations`, `council`, `dashboard`,
`deploy`, `env-vars`, `freelance`, `git`, `inbox`, `integrations`, `issue-fixer`,
`issues`, `kanban`, `lsp`, `notes`, `playground`, `plugins`, `projects`,
`providers`, `recommendations`, `remote-sync`, `settings`, `skills`, `system`,
`updater`, `webview`, `whats-new`). `shared/freelance/` holds cross-cutting
freelance descriptors (`platforms.ts`, `write-steps.ts`, `attention.ts`).
`shared/freelance-currencies.ts` + `shared/rpc.ts` are root re-exports.

## Project-root directories
| Path | Role |
|---|---|
| `docs/` | Design docs: `prd.md`, `workflow.md`, `auto-earn-plan.md`, `issue-fixer-plan.md`, `sequential-agent-model.md`, `skills.md`, `freelance.md`, plus proposals. |
| `plugins/db-viewer/` | The one bundled plugin (manifest + index). [[plugins]] |
| `skills/` | Bundled SKILL.md skills: `agentdesk-guide`, `docx/xlsx/pptx/pdf` (with `scripts/`), `frontend-design`, `humanizer`, `freelance-writing`, `live-browser`, `screenshot`, `skill-creator`, `weather`. [[skills]] |
| `assets/` | App icons (`icon.ico/png`, `tray-icon.png`) + `uninstall.ps1`. |
| `.github/workflows/release.yml` | The only CI workflow (release). |
| `packaging/msix/` | Windows MSIX packaging. |
| `tests/` | Bun tests mirroring backend dirs (`agents/`, `channels/`, `db/`, `frontend/`). |
| `build/` · `dist/` · `node_modules/` | Generated/installed — not source. |
| `electrobun.config.ts` | App bundle config (entry points, build). |
| `drizzle.config.ts` / `vite.config.ts` / `tailwind.config.js` / `eslint.config.js` / `tsconfig.json` | Build & lint config. |
| `package.json` | Scripts (`dev`, `build`, `typecheck`, `db:*`) + deps. |
| `run.ps1` / `push.ps1` / `release.ps1` / `pending.ps1` (+ `.bat` wrappers) | Local dev/release automation. |

## Gotchas / Constraints
- **This page is the authoritative structural index** for the repo.
- **The CLAUDE.md layout has drifted** — it predates `rpc-groups/`, `annotations/`,
  `claude/`, `freelance/expert/`, and the `council`/`playground` routes. Trust this
  page + the actual filesystem over CLAUDE.md for structure.
- **There is no `WorkflowEngine`** — the PM (`agents/engine.ts`) is the sole
  orchestrator; older docs reference a state machine that no longer exists. [[pm-sole-orchestrator]]
- **Adding an RPC touches 4 places**: contract in `src/shared/rpc/<domain>.ts`,
  handler in `src/bun/rpc/<domain>.ts`, an aggregator in `src/bun/rpc-groups/`,
  and a wrapper in `src/mainview/lib/rpc.ts`. Skipping the aggregator means the
  handler is never registered.
- **An agent's tools depend on its `agent_tools` rows** — zero rows = full
  registry (intentional for hidden agents), not "no tools". See `tools/index.ts:100`.
- **Migrations are the only way to change tables** — never edit `schema.ts`
  without a paired `db/migrations/vN_*.ts`.

## Related
- [[backend-core]] — how the Bun process boots and the webview connects.
- [[rpc-layer]] / [[rpc-client]] — the RPC boundary in depth.
- [[agent-engine]] / [[agent-tools]] — the orchestration core this map points at.
- [[database]] — the schema + migration story.
- [[frontend-architecture]] — how pages/components/stores fit together.

## Open questions
- Exact route→page mapping for `council` and `playground` is verified to exist in
  `router.tsx:98/110` but their full feature scope lives in [[playground]] and a
  (not-yet-written) council page.
- `src/bun/annotations/` (Agentation toolbar) has no dedicated wiki page yet.
