---
title: Glossary
type: glossary
status: verified
verified_at: 2026-06-27
sources:
  - CLAUDE.md
  - src/bun/agents/engine.ts
  - src/bun/db/seed.ts
tags: [glossary, terminology]
---

# Glossary

Alphabetized glossary of AgentDesk-specific terms. Each entry gives a short
definition and, where useful, a `[[wikilink]]` to the page that covers it in
depth.

## A

**Agent Engine** — The orchestration core that streams the PM's responses,
dispatches inline sub-agents, hosts the soft approval gate, and drives the
automatic code-review cycle. There is no separate workflow state machine; the
PM LLM loop *is* the orchestrator. See [[agent-engine]].

**Agent tools** — The per-role tool registry. Tools are assembled in
`tools/index.ts` and filtered by `getToolsForAgent` (an agent with **zero**
`agent_tools` rows gets the full registry), then per-run bound with workspace,
file tracking, and read-only/exclude filtering. See [[agent-tools]].

**Approval gate** — see **Plan approval gate**.

**Auto-Earn** — Opt-in (off by default, gated by `freelance_autoearn_enabled`)
extension that autonomously reads the freelance platform inbox and drafts/sends
replies and bids over the freelancer's *own* real session, never as a flagged
bot. Every send passes the [[freelance-autoearn|Behavior Governor]] and an
anomaly circuit breaker. See [[freelance-autoearn]], [[auto-earn-end-to-end]].

**autoCommitTask** — The function in `review-cycle.ts` that, when a task is
approved, switches to (or creates) the active feature branch and commits the
task's work before moving it to done. See [[kanban-review-cycle]],
[[feature-branch-workflow]].

## B

**Backend core** — The Bun main-process layer: boot/startup ordering in
`index.ts`, the EngineManager engine cache, the global abort/approval registry,
shared lib utilities, and the annotation/preview server. See [[backend-core]].

**Behavior Governor** — The Auto-Earn safety gate (`freelance/session/governor.ts`)
that every send must pass: min-gap, hourly caps (stricter for bids) plus a daily
bid budget, active-hours windows, in-flight-send guard, near-duplicate (trigram)
guard, and a humanized reply-latency floor, all audited in
`freelance_action_log`. See [[freelance-autoearn]], [[freelance-own-session]].

**Bucket** — A column/list/status grouping within an external issue tracker
(e.g. a Trello list, a Kanboard column, a Jira status). Issue Sources can filter
sync to selected buckets, stored as `config.buckets`. See [[issue-sources]].

## C

**Channels** — External messaging adapters (Discord, WhatsApp, Email) behind a
singleton `ChannelManager` that routes inbound platform messages into the agent
engine and relays PM replies plus task-done broadcasts back out. See
[[channels]].

**Claude Subscription provider** — A provider that reuses Claude Code's stored
OAuth token, impersonates the CLI's headers, refreshes by spawning the `claude`
CLI on a 401, and is gated by a local marker file. See [[claude-subscription]].

**Context compaction** — How a long inline sub-agent conversation is shrunk in
place as context fills, via a progressive 60/70/85/90% compaction ladder (with
tool-result pruning) and no iteration cap. Distinct from the PM conversation's
durable summarization. See [[context-window-management]].

**Context window management** — The umbrella mechanism for reclaiming context:
durable PM-conversation summarization (delete + merge) plus the inline sub-agent
compaction ladder. See [[context-window-management]].

## D

**Database** — The single SQLite file (WAL mode) accessed via Drizzle (`db`) and
raw statements (`sqlite`), migrated by a `user_version` runner with auto-backup
and an idempotent `ensureRuntimeSchema` safety net, then seeded idempotently on
every launch. See [[database]], [[database-tables]].

**Drizzle** — The TypeScript ORM (over `better-sqlite3`) that manages most of
AgentDesk's tables; `src/bun/db/schema.ts` is the single source of truth for
Drizzle-managed tables. Schema changes require a matching migration file. See
[[database]].

## E

**EngineManager** — Creates and caches one `AgentEngine` per project in memory,
tracks the global abort controllers, and broadcasts task-done notifications via
channels. See [[backend-core]].

**External issues** — The unified `external_issues` table storing normalized
issues from all six trackers (GitHub/Jira/Linear/GitLab/Trello/Kanboard),
superseding the deprecated `github_issues` table. See [[issue-sources]],
[[database-tables]].

## F

**Feature branch** — An opt-in per-project mode where the PM declares an
AI-generated `feature/<slug>` name (persisted in `settings` under
`currentFeatureBranch:<projectId>`) via `set_feature_branch`; `autoCommitTask`
switches to/creates it before each task commit. See [[feature-branch-workflow]].

**Frontend architecture** — The React 19 SPA inside Electrobun's webview:
hash-routed TanStack Router under a persistent AppShell, Zustand stores fed by
`agentdesk:*` window events, Radix + Tailwind primitives, and a typed RPC
bridge. See [[frontend-architecture]], [[frontend-pages]],
[[frontend-components]].

## G

**GitHub token auth** — The convention that git network ops authenticate via an
inline per-command HTTP header with the credential helper disabled (never URLs
embedding tokens, never Git Credential Manager). Use `gitAuthArgs(token)` /
`githubAuthPrefix(...)`. See [[github-token-auth]].

## H

**Handoff** — A generated summary of the prior task's modified files, prepended
to the next sequential agent's task as `## Prior Work` to carry continuity
between stateless inline agents. See [[inline-agents-vs-sessions]].

## I

**Inline sub-agent** — A sub-agent run *inline* in the main conversation via
`run_agent` / `run_agents_parallel`, each with a fresh context (system prompt +
task only) and tool calls visible as message parts in chat. Replaced the dropped
persistent `agent_sessions` model. See [[agent-engine]],
[[inline-agents-vs-sessions]].

**Issue Fixer** — The per-project autonomous GitHub-issue → branch/PR resolver:
outbound polling + a hidden `issue-fixer` agent that only edits files while the
orchestrator owns the git lifecycle and **never merges** (3-layer enforcement).
See [[issue-fixer]].

**Issue Sources** — The multi-source issue integration layer: per-tracker
adapters normalize GitHub/Jira/Linear/GitLab/Trello/Kanboard into
`external_issues`, with config, sync (fetch→diff→reconcile, 100-cap), bucket
filtering, kanban link, create-from-task, and best-effort auto-close on task
done. See [[issue-sources]].

## K

**Kanban columns (backlog / working / review / done)** — The enforced task flow.
Agents cannot skip columns; `backlog → working → review → done` only. Moving a
task into **review** auto-spawns a code-reviewer, and moving to **done** is
reserved for the review system via `submit_review`. See [[kanban-review-cycle]].

## L

**LSP** — Lazy, pooled language-server integration: spawn-on-demand LSP clients
over JSON-RPC/stdio giving agents diagnostics, hover, definition, references, and
document symbols. See [[lsp]].

## M

**maxReviewRounds** — The cap (default 2) on review iterations: a rejected task
goes back to working and is re-reviewed until approved or the cap is hit. See
[[kanban-review-cycle]].

**MCP (Model Context Protocol)** — AgentDesk acting as an MCP *client*: config
storage, connection lifecycle, sub-agent-only tool exposure, and resilience. See
[[mcp]].

**Message parts** — The per-bubble structured pieces of an agent message (text,
tool calls, etc.) persisted to the `message_parts` table and rendered as
distinct UI parts. See [[message-streaming-broadcasts]].

## N

**Notifications** — OS-level desktop notifications via two paths: the ungated
`sendDesktopNotification` (Windows toast workaround) and the preference-gated
`sendNativeNotification` for channel messages, backed by
`notification_preferences`. See [[notifications]].

## P

**Plan approval gate** — The soft gate where the PM calls
`request_plan_approval` (showing a plan card in chat), the user replies
"approve", and the PM then calls `create_tasks_from_plan` and dispatches agents.
See [[plan-approve-execute]], [[pm-sole-orchestrator]].

**Playground** — An Artifacts-style live-preview builder where the dedicated
`playground-agent` (full tool/skill/MCP registry) builds web-renderable
artifacts into an OS-temp folder and renders them in an in-page iframe, reusing
`runInlineAgent` via `priorMessages` / `persistToDb:false` / `extraTools`. See
[[playground]].

**Plugins** — The in-process plugin framework (manifest + `activate(api)`)
contributing agent tools, prompts, file-change callbacks, and UI extensions; it
also hosts the LSP Manager plugin. See [[plugins]].

**PM / Project Manager** — The sole orchestrator agent (`project-manager`). It
talks to humans, classifies requests, plans, manages the approval gate and
kanban tasks, and dispatches inline sub-agents — there is no separate workflow
engine. See [[agent-engine]], [[pm-sole-orchestrator]].

**Providers** — The provider-agnostic adapter layer: `createProviderAdapter()`
maps a stored config to an AI SDK `LanguageModel`; adapters only build the model
handle while thinking budgets, prompt caching, and context limits are applied one
layer up. See [[providers]].

## R

**Read-only agents** — Agents that may run in parallel via
`run_agents_parallel` because they don't write: `code-explorer`,
`research-expert`, and `task-planner` (the `READ_ONLY_AGENTS` set). Write agents
run one at a time. See [[agent-roster]], [[agent-engine]].

**Remote Sync** — Per-project SFTP/FTP/FTPS file sync (pull/push) with
AES-256-GCM credential encryption, a local↔remote SHA manifest for diffing, and
a protocol-agnostic `RemoteClient`. See [[remote-sync]].

**RPC contract** — The typed input/output shapes in `src/shared/rpc/*.ts` that
form the frontend↔backend interface boundary; handlers live in `src/bun/rpc/`,
are registered in `rpc-registration.ts`, and are called via
`src/mainview/lib/rpc.ts`. Never bypass with direct DB calls from the frontend.
See [[rpc-layer]], [[rpc-client]], [[conventions-constraints]].

## S

**Scheduler / Automation** — Cron jobs (croner, restart-safe via DB re-arm and
missed-run recovery) and event-triggered automation rules, both funneling
through one `executeTask()` sink over an in-process event bus. See
[[scheduler-automation]].

**Sequential write-agent guard** — The `writeAgentRunning` closure guard in PM
tools that enforces one write agent at a time. See [[agent-engine]],
[[plan-approve-execute]].

**Skills** — Filesystem `SKILL.md` capabilities with dual-dir loading
(bundled + user override), a compact prompt listing, and on-demand `read_skill`
resolution (bash injection + arg substitution). See [[skills]].

**submit_review** — The tool the auto-spawned code-reviewer calls to conclude a
review: on approval the task moves to done; on rejection it returns to working
(up to `maxReviewRounds`). It is the only sanctioned path into the done column.
See [[kanban-review-cycle]].

**Summarization** — The durable PM-conversation compaction (delete + merge into
`conversation_summaries`) triggered as the conversation grows; distinct from the
inline sub-agent compaction ladder. See [[context-window-management]].

## Related

- [[agent-engine]]
- [[agent-roster]]
- [[kanban-review-cycle]]
- [[plan-approve-execute]]
- [[conventions-constraints]]

## Open questions

- None.
