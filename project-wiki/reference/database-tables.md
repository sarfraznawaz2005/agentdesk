---
title: Database Tables Reference
type: reference
status: verified
verified_at: 2026-06-21
sources:
  - src/bun/db/schema.ts
  - src/bun/db/migrate.ts
  - src/bun/db/migrations/v1_initial-schema.ts
  - src/bun/db/migrations/v3_agent-sessions.ts
  - src/bun/db/migrations/v4_inline-agents.ts
  - src/bun/db/migrations/v33_external-issues.ts
  - src/bun/db/migrations/v49_agent-memories.ts
tags: [database]
---

# Database Tables Reference

AgentDesk persists everything in a single **SQLite (WAL)** database accessed
through **Drizzle ORM** (`better-sqlite3`). There are two ways a table can come
into existence, and the distinction matters when you change schema:

1. **Drizzle-managed** — declared in `src/bun/db/schema.ts`. This file is the
   single source of truth for these tables' column shapes (it is what
   `bun run db:generate` reads). At runtime, however, the actual `CREATE TABLE`
   statements come from the **versioned migration runner**, not from Drizzle
   push.
2. **Raw-SQL only** — created exclusively by a migration file's `run()` and never
   modelled in `schema.ts`. Drizzle has no type for these; you can only touch
   them via raw `sqlite.*` calls.

## How the schema actually gets created

The runner in `src/bun/db/migrate.ts:117` tracks applied migrations via
`PRAGMA user_version`, applies the pending `migrations[]` array
(`migrate.ts:69`) inside a transaction each, auto-backing-up first on an existing
DB. The latest version is **v49** (`migrate.ts`).

Two consequences for anyone editing the DB:

- **`schema.ts` is descriptive, not authoritative at runtime.** A new column in
  `schema.ts` does nothing until a matching migration `ALTER TABLE`s it in. See
  the project rule "Schema changes require a new migration file". This is why so
  many migrations are column-adds guarded by `PRAGMA table_info` checks.
- **`ensureRuntimeSchema()` (`migrate.ts:179`) re-runs a subset of
  `CREATE TABLE IF NOT EXISTS` / guarded-`ALTER` migrations on *every* startup,
  unconditionally** — a defensive net for the common dev case where a shared DB's
  `user_version` raced ahead of the actual schema (e.g. branch switching). So
  v27/v29/v30/v32–v43 are effectively self-healing.

## Drizzle-managed tables (`schema.ts`)

One row per table. "Key cols" lists the load-bearing / non-obvious columns, not
every column — read the cited line for the full definition.

| Table | schema.ts | Purpose | Key cols |
|---|---|---|---|
| `settings` | `:9` | Generic JSON key/value config store. Feature-branch name lives here under `currentFeatureBranch:<projectId>`; per-source issue config under category `issue_sources`. | `key` (unique), `value` (JSON), `category` |
| `ai_providers` | `:29` | Configured AI provider creds + prefs. **apiKey stored plaintext** (encryption deferred). | `providerType`, `apiKey`, `isDefault` (only one =1) |
| `projects` | `:59` | A project = local workspace dir + optional GitHub repo. | `workspacePath`, `githubUrl`, `workingBranch`, `status` |
| `agents` | `:83` | Built-in + custom agent definitions. `isBuiltin=1` for shipped agents. | `name`, `systemPrompt`, `useSystemPromptOnly`, `availableToPm`, `thinkingBudget` |
| `agent_tools` | `:126` | Tool allow-list per agent. **Zero rows = agent gets the full tool registry** (how Playground/Issue-Fixer agents get everything). | `agentId` (FK), `toolName`, `isEnabled` |
| `conversations` | `:141` | Chat threads per project. | `projectId` (FK), `isPinned`, `isArchived` |
| `messages` | `:152` | Chat messages. `hasParts=1` means rich content lives in `message_parts`. | `role`, `agentId`/`agentName`, `metadata` (JSON), `tokenCount`, `hasParts` |
| `message_parts` | `:653` | Decomposed message content for inline sub-agent rendering (text / tool_call / tool_result / reasoning / agent_start / agent_end). Cascade-deletes with its message. Originally raw-SQL (v4); now Drizzle-managed. | `messageId` (FK, cascade), `type`, `toolName`/`toolInput`/`toolOutput`/`toolState`, `sortOrder` |
| `conversation_summaries` | `:166` | Auto-compaction summaries; `messagesUpToId` marks the watermark. | `conversationId` (FK), `summaryText`, `messagesUpToId` |
| `notes` | `:178` | Agent/user docs within a project (the Docs page). | `projectId` (FK), `title`, `content`, `authorAgentId` |
| `agent_memories` | `:196` (v49) | Per-(agent + project) durable memory for the `save_memory`/`recall_memory`/`delete_memory` tools. Index (title+description) auto-injected into the agent's system prompt every run; full `content` recalled on demand. Distinct from `notes`/DECISIONS.md. Bounded by caps in `agents/tools/memory.ts` (2 KB content, soft 50/hard 100 with LRU evict). `UNIQUE(project_id, agent_name, title)` = dedup key (re-save updates in place). | `projectId` (FK), `agentName`, `title`, `description`, `content`, `recallCount`, `lastRecalledAt` |
| `kanban_tasks` | `:200` | Kanban board tasks. Flow `backlog→working→review→done`. | `column`, `priority`, `acceptanceCriteria` (JSON), `reviewRounds`, `blockedBy` (JSON), `verificationStatus` |
| `kanban_task_activity` | `:238` | Per-task audit log (moves/edits/comments). | `taskId` (FK), `type`, `actorId`, `data` (JSON) |
| `plugins` | `:259` | Installed plugins; optional `prompt` snippet injected into agent prompts. | `name` (unique), `enabled`, `settings` (JSON), `prompt` |
| `channels` | `:274` | External channel adapters (Discord/WhatsApp/Email). | `platform`, `config` (JSON), `enabled` |
| `deploy_environments` | `:288` | Named deploy targets per project. | `projectId` (FK), `command`, `branch`, `url` |
| `deploy_history` | `:299` | Deploy run log. | `environmentId` (FK), `status`, `triggeredBy`, `durationMs` |
| `prompts` | `:314` | Reusable chat prompt templates (`builtin`/`custom`). | `name`, `content`, `category` |
| `inbox_messages` | `:327` | Unified inbox messages from channels. | `sender`, `content`, `isRead`, `threadId`, `platform`, `category` |
| `whatsapp_sessions` | `:347` | Baileys auth state per channel (`creds`+`keys` JSON). | `channelId`, `creds`, `keys` |
| `notification_preferences` | `:355` | Per-platform/project notification toggles. | `platform`, `soundEnabled`/`badgeEnabled`/`bannerEnabled`, `muteUntil` |
| `inbox_rules` | `:366` | Conditional inbox automation (conditions→actions JSON). | `conditions`, `actions`, `enabled`, `priority` |
| `cron_jobs` | `:380` | Scheduled tasks (croner). `oneShot` for run-once. | `cronExpression`, `taskType`, `taskConfig` (JSON), `lastRunAt` |
| `cron_job_history` | `:399` | Cron execution log. | `jobId`, `status`, `output`, `durationMs` |
| `automation_rules` | `:413` | Event-triggered automations (trigger→actions). | `trigger`, `actions`, `enabled`, `lastTriggeredAt` |
| `pull_requests` | `:428` | Local PR tracking (GitHub-synced or local-only). | `prNumber`, `sourceBranch`/`targetBranch`, `state`, `linkedTaskId`, `mergeStrategy` |
| `pr_comments` | `:449` | Review comment threads on PRs. `file=null` = general comment. | `prId` (FK), `file`/`lineNumber`, `authorType` |
| `webhook_configs` | `:463` | GitHub webhook *polling* config (events array). | `events` (JSON), `enabled`, `lastPollAt` |
| `webhook_events` | `:478` | Event log from GitHub polling; `githubEventId` for O(1) dedup. | `eventType`, `payload` (JSON), `status`, `githubEventId` |
| `github_issues` | `:497` | **DEPRECATED** — see below. Superseded by `external_issues`; left read-only. | `githubIssueNumber`, `taskId`, `state` |
| `external_issues` | `:516` | Unified multi-source issue store (GitHub/Jira/Linear/GitLab/Trello/Kanboard) normalised into one table. | `source`, `sourceId`, `taskId` (kanban link), `state` (normalised), `priority`, `metadata` (JSON) |
| `issue_fixer_config` | `:541` | Per-project Issue Fixer config (PK = `projectId`, one row/project). | `enabled`, `keywords`/`labels` (JSON), `authMode`, `autonomy`, `cursorAt` |
| `issue_fix_runs` | `:573` | Issue Fixer run history. `triggerCommentId` dedups comment triggers. | `issueNumber`, `triggerType`, `status`, `branchName`, `prNumber`, `testPassed` |
| `branch_strategies` | `:603` | Per-project branching model (PK-unique `projectId`). | `model`, `defaultBranch`, `namingTemplate`, `protectedBranches` (JSON) |
| `cost_budgets` | `:624` | Spend alerts per project (or global when `projectId=null`). | `period`, `limitUsd` (string for precision), `alertThreshold` |
| `audit_log` | `:639` | User/system action audit trail. | `action`, `entityType`/`entityId`, `details` (JSON) |
| `project_activity` | `:898` | Per-(project, location) unread-agent-activity tracking. Unread when `lastActivityAt > lastSeenAt`. UNIQUE(project_id, location) added in v28. | `location`, `lastActivityAt`, `lastSeenAt` |
| `remote_sync_config` | `:912` | Per-project SFTP/FTP connection (PK = `projectId`). **Creds AES-256-GCM encrypted at rest**, master key in a userData file (not the DB). | `protocol`, `host`/`port`, `passwordEnc`/`privateKeyEnc`/`passphraseEnc`, `selections` (JSON), `excludePatterns` (JSON), `hostKeyFingerprint` |
| `remote_sync_items` | `:950` | Local↔remote file manifest (drives push diff detection). | `remotePath`/`localPath`, `size`, `remoteMtime`, `sha256` |
| `custom_env_vars` | `:968` | User-defined env vars from Settings. | `name` (unique), `value` |
| `remote_sync_runs` | `:978` | Remote-sync operation history (Activity tab). | `direction`, `status`, `okFiles`/`failedFiles`, `bytes` |
| `freelance_listings` | `:675` | Fetched job listings (Auto-Earn). `skills` JSON; wizard verdict + client-quality columns. `wizardBlockKind` (v44) records a not_workable verdict's origin — `non_software`/`skill_gate`/`client_quality` (pre-filter → yellow) vs `analysis` (Condition A/B → red/green); NULL on legacy rows. `resolveBlockKind()` (`freelance-wizard.ts`) normalizes column+legacy-reason into the `FreelanceBlockKind` surfaced on the listing DTO + `WizardFailedListing`. The shared `block-kind.ts` (`pillLabel`/`pillTone`/`isFilterBlockKind`) renders the verdict as a single bold word — `Workable` (green) / `Missing Skills` (amber — fixable account-state) / `Client Filter` (sky — client-preference) / `In-Person Work` + `Not Workable` (red — can't proceed) — on both the card pill (Filter icon vs Sparkles flags pre-filter vs AI verdict) and the Find Workable modal rows. The New-tab color chips filter listings by these buckets server-side via the `getListings` `kind` param (the red chip merges `non_software`+`analysis`, plus an `unanalyzed` = NULL-verdict bucket); the New tab also orders by `COALESCE(posted_at, fetched_at) DESC`. **`status`** enum is `new`/`shortlisted`/`approved`/`closed` (`FreelanceListingStatus`) — there is **no `done` value**: the UI **"Done"** tab maps to `status='closed'` (`listings-tab.tsx` FILTERS), and the card's **Mark Done** → `freelanceMarkListingDone` sets `closed`. | `platform`/`externalId`, `wizardVerdict`, `wizardBlockKind`, `wizardBlockers` (JSON), `fullDescription`, `clientRating`, `status`, `isDeleted` |
| `freelance_chat_messages` | `:706` | Per-listing AI chat history. | `listingId` (FK), `role`, `content` |
| `freelance_accounts` | `:722` | Connected freelance accounts (one row/platform). `profileSkills` JSON pre-filters unbiddable projects. | `platform` (unique), `selfUserId`, `autonomyMode`, `profileSkills` |
| `freelance_inbox_threads` | `:736` | Intercepted platform inbox threads. PK = platform thread id. `contextId` is the correlation key to listings. | `clientUserId`, `contextId`, `listingId`, `linkConfidence`, `lastMessageAt`, `unread` |
| `freelance_inbox_messages` | `:759` | Intercepted thread messages. PK = platform message id. | `threadId`, `fromUser`, `body`, `sentAt` |
| `freelance_inbox_users` | `:770` | Identity cache (render names not ids). PK = platform user id. | `username`/`displayName`, `role`, `country` |
| `freelance_outbox` | `:783` | Approval queue: drafted/queued replies & bids. `finalBody` = what was actually sent. | `kind` (reply/bid), `draftBody`/`finalBody`, `status`, `autonomyMode`, `scheduledFor` |
| `freelance_action_log` | `:801` | Audit trail powering the Behavior Governor's rate-limit decisions. | `action`, `outcome`, `detail` |
| `freelance_jobs` | `:816` | freelance-expert pipeline: one row/opportunity; a state machine. Idempotent on (platform, thread_id). | `state`, `threadId`/`listingId`/`projectId`, `bidAmount`, `earned`, `awardedAt` |
| `freelance_credentials` | `:839` | Encrypted vault for client-provided access (FTP/SFTP/git/CMS). `secretEnc` AES-256-GCM, never logged raw. | `jobId`, `kind`, `host`/`port`/`username`, `secretEnc` |
| `freelance_job_log` | `:854` | Per-job audit timeline of autonomous actions. | `jobId`, `action`, `outcome` |
| `freelance_job_facts` | `:867` | Client/project facts learned from conversation (NOT secrets), injected into agent context. | `jobId`, `category`, `detail` |
| `freelance_escalations` | `:876` | Needs-attention queue (agent → human). | `jobId`, `reason`, `severity`, `status` |

> **Note — CLAUDE.md drift:** the CLAUDE.md "Database Tables" list pre-dates the
> freelance-expert pipeline. The tables `freelance_jobs`, `freelance_credentials`,
> `freelance_job_log`, `freelance_job_facts`, `freelance_escalations`
> (`schema.ts:816`–`887`, migrations v38/v39) and `custom_env_vars`
> (`schema.ts:968`, v32) are real Drizzle-managed tables **not** listed there.
> `custom_env_vars` is also not flagged as raw-SQL — it is Drizzle-managed.

## Raw-SQL-only tables (migrations, not in `schema.ts`)

| Table | Created | Purpose |
|---|---|---|
| `keyboard_shortcuts` | v1, `v1_initial-schema.ts:458` | Customisable keyboard shortcut bindings (`action` unique, `is_custom` flag). Never modelled in Drizzle. |
| `remote_identity` / `remote_devices` | v47, `v47_remote-access-devices.ts` | Web-app remote-access: the desktop's own relay pairing identity (single row) and the list of paired browser devices (pairing secret + ECDH public key, encrypted at rest). Helpers in `remote/manager.ts`. |
| `pending_approvals` | v48, `v48_pending-approvals.ts` | Durability mirror (TASK-478) of in-memory plan/approval state: `kind` ∈ `shell`\|`question`\|`plan_tasks`, `payload` JSON, `expires_at`. Write-through from `planning.ts` (task defs) and `engine-manager.ts` (shell/question). Read/cleared via `db/pending-approvals.ts`; orphaned shell/question rows reconciled on startup. |

## Deprecated and dropped tables

- **`github_issues` — deprecated, still present.** Superseded by
  `external_issues`. Migration **v33** (`v33_external-issues.ts:11`) creates
  `external_issues`, then copies all `github_issues` rows in as
  `source='github'`, preserving UUIDs and task links, guarded by
  `WHERE NOT EXISTS` so the defensive re-run is idempotent
  (`v33_external-issues.ts:47`). The old table is **intentionally left in place,
  read-only**, so the upgrade is reversible. `rpc/github-issues.ts` is now a thin
  shim delegating to `issues.ts` (source='github') for the kanban task-detail
  modal.

- **Dropped tables (gone from the live DB):** created in v3, dropped in v4 when
  the inline-agent model replaced persistent agent sessions
  (`v4_inline-agents.ts:40`):
  - `agent_session_messages` (created `v3_agent-sessions.ts:27`)
  - `agent_sessions` (created `v3_agent-sessions.ts:14`)
  - `agent_task_results` (created `v1_initial-schema.ts:475`) — also dropped in
    v4. This one is **not mentioned in CLAUDE.md's drop note**, which only cites
    the two `agent_session*` tables.

## Gotchas / Constraints

- **Never edit `schema.ts` without a migration.** Drizzle push is not the runtime
  path; the `migrations[]` array is. A column you add to `schema.ts` will be
  invisible until an `ALTER TABLE` migration adds it (and `db:generate` won't help
  existing users — every change must survive an upgrade, per the project's
  "EXISTING users" rule).
- **`agent_tools` empty-set semantics are load-bearing.** An agent with zero
  `agent_tools` rows receives the *entire* tool registry (this is how
  `playground-agent` and `issue-fixer` get all tools). Inserting even one row
  switches the agent to allow-list mode. See [[playground]] / the agent roster.
- **Booleans are `INTEGER` 0/1**, timestamps are `TEXT` (`CURRENT_TIMESTAMP` /
  `datetime('now')`), and "JSON" columns are `TEXT` holding serialized JSON — no
  native JSON type. `cost_budgets.limitUsd` is deliberately `TEXT` to avoid float
  drift (`schema.ts:629`).
- **Encrypted-at-rest columns are not in the DB's trust boundary alone.**
  `remote_sync_config.*Enc` and `freelance_credentials.secretEnc` are AES-256-GCM
  with the key file outside SQLite; never log or return them raw.
- **`message_parts` migrated managers.** It began as a raw-SQL table (v4) and is
  now Drizzle-managed (`schema.ts:653`) — both define the same shape; don't add a
  second `CREATE`.
- **`PRAGMA user_version` can lie on shared/dev DBs.** Hence
  `ensureRuntimeSchema()` re-applies idempotent table/column creation every boot
  (`migrate.ts:179`). When adding a defensively-critical table, add it there too.

## Related
- [[schema-migrations]]
- [[issue-tracker]]
- [[auto-earn]]
- [[agent-roster]]
- [[directory-map]]

## Open questions
- `ai_providers.apiKey` is still plaintext (`schema.ts:37`) — the planned
  encryption phase has no migration yet; confirm whether it is still on the
  roadmap.
- `webhook_configs`/`webhook_events` describe GitHub *polling*; verify these are
  still wired vs. superseded by the issue-fixer poller.
