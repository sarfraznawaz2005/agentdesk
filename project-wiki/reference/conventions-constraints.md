---
title: Conventions & Constraints
type: reference
status: verified
verified_at: 2026-07-04
sources:
  - CLAUDE.md
  - src/bun/rpc/github-api.ts
  - src/bun/db/migrate.ts
  - src/bun/db/seed.ts
  - src/bun/db/schema.ts
  - src/bun/agents/tools/kanban.ts
  - src/bun/agents/tools/create-task-policy.ts
  - src/bun/rpc-registration.ts
  - src/shared/rpc/index.ts
tags: [conventions, rules]
---

# Conventions & Constraints

**The non-negotiable invariants that keep AgentDesk shippable to its EXISTING
user base.** This page is the "why" behind the rules in `CLAUDE.md` Critical
Rules — each one is enforced somewhere in code, and breaking it tends to fail
silently (a prompt that won't pop until a user pushes, a schema column the
running code expects but the DB lacks, a kanban task that jumps to "done"
without review). Read this before adding a feature; the constraints below are
load-bearing.

## The interface boundaries (and why they exist)

AgentDesk has three hard boundaries. Crossing them is the most common source of
breakage because each one is a contract that two layers rely on independently.

1. **RPC contracts are the frontend↔backend boundary.** The React webview never
   touches the DB; it calls typed RPCs. The contract lives in
   `src/shared/rpc/*.ts` (one file per domain, re-exported from
   `src/shared/rpc/index.ts:1`), the implementation in `src/bun/rpc/*.ts`, and
   the wiring in `src/bun/rpc-registration.ts`. Handlers are assembled from
   per-domain groups and wrapped by `withErrorToast` so any throw surfaces as a
   toast in the UI (`src/bun/rpc-registration.ts:15`). Agent operations get
   `maxRequestTime: Infinity` because a sub-agent run can take minutes
   (`src/bun/rpc-registration.ts:34`). **Adding a feature = define the contract
   in `shared/rpc/`, implement in `bun/rpc/`, register in
   `rpc-registration.ts`, call via `src/mainview/lib/rpc.ts`.** Never reach
   around it with a direct DB call from the frontend — the types and the toast
   wrapper both depend on the boundary.

2. **`schema.ts` is the Drizzle source of truth; migrations are the only way to
   change it.** `src/bun/db/schema.ts` defines every Drizzle-managed table
   (`src/bun/db/schema.ts:9`). You must never alter `schema.ts` without adding a
   matching numbered migration under `src/bun/db/migrations/` — see the
   migration discipline section below for why this is enforced harder than it
   looks.

3. **Agent system prompts live in `seed.ts`, not in engine code.** Every
   built-in agent's `systemPrompt` is a field on a seed def
   (`src/bun/db/seed.ts:26`, e.g. the Architect prompt at
   `src/bun/db/seed.ts:163`). Edit the prompt there. The engine reads prompts
   from the DB, so an inline-edited prompt in `engine.ts` would be ignored and
   overwritten on next seed.

## Migration discipline (the part that bites)

The migration runner uses SQLite `PRAGMA user_version` to track applied
migrations (`src/bun/db/migrate.ts:137`). Each migration is its own file
exporting `name` + `run()`, registered in the `migrations` array
(`src/bun/db/migrate.ts:79`). Before any migration runs on an existing DB
(`user_version > 0`) the runner takes an automatic VACUUM-INTO backup, once per
session, and **aborts the whole migration if the backup fails**
(`src/bun/db/migrate.ts:165`) — data safety beats forward progress. Each
migration runs inside a `BEGIN`/`COMMIT` with `ROLLBACK` on error; the
`PRAGMA user_version` bump happens *outside* the transaction
(`src/bun/db/migrate.ts:184`).

The non-obvious part is `ensureRuntimeSchema()` (`src/bun/db/migrate.ts:199`):
a **defensive sanity check that runs on every startup, even when fully
migrated**. It re-invokes a set of idempotent migrations (`v27`, `v29`, `v32`,
`v33`, `v42`, …) and PRAGMA-guarded `ADD COLUMN`s
(`src/bun/db/migrate.ts:346`) to catch the case where `user_version` raced ahead
of the actual schema — e.g. a dev DB pulled between branches, or a hot-reload
that picked up new schema code without restarting the Bun process that runs
migrations. **This is why new migrations must be idempotent**: use
`CREATE TABLE IF NOT EXISTS`, or guard `ADD COLUMN` with a
`PRAGMA table_info(...)` check before altering — see the canonical pattern in
`src/bun/db/migrations/v34_external-issues-due-date.ts:11`. A non-idempotent
migration will throw when `ensureRuntimeSchema` re-runs it, even on a
correctly-migrated DB.

## Existing-users compatibility is a first-class constraint

AgentDesk ships to users who already have data, so "works for new users" is
never sufficient. Three patterns recur:

- **Hash-gated re-seeding.** Built-in prompts are re-upserted on launch so
  upgrades pick up improved prompts, but only when an FNV-1a hash of the bundled
  defs changes (`src/bun/db/seed.ts:14`, `src/bun/db/seed.ts:25`). A *missing*
  hash — i.e. an existing user on first upgrade to a hashing build — forces one
  upsert and then settles, so behaviour is identical for new and existing users,
  just cheaper (`src/bun/db/seed.ts:9`).
- **Inferred defaults for new settings.** When a per-project setting is added,
  its absence is interpreted to reproduce the *old* behaviour. The GitHub token
  source is the clearest example: an unset `githubTokenSource` is inferred from
  token presence (a project that already had a custom token defaults to
  `"custom"`, matching the legacy "present token is always used" behaviour),
  otherwise `"global"` (`src/bun/rpc/github-api.ts:72`).
- **Legacy key fallback chains.** `resolveGitHubToken` tries the per-project
  custom token (only when source is `"custom"`), then the global `github_pat`,
  then the legacy `githubToken`/`git` setting that the old `git_pr` tool wrote —
  so users who configured it the old way keep working
  (`src/bun/rpc/github-api.ts:94`, legacy reader at
  `src/bun/rpc/github-api.ts:45`).

## GitHub token auth: never invoke the credential helper

This is a hard-won rule. GitHub HTTPS network ops (clone/fetch/pull/push) must
authenticate via the resolved token supplied as an **inline `git -c` header with
the credential helper explicitly disabled**, never via a credential-helper or a
token embedded in the remote URL. The mechanism is `gitAuthArgs(token)`
(`src/bun/rpc/github-api.ts:127`): it sets `credential.helper=` (empty, so Git
Credential Manager is not consulted) plus a per-host `extraheader` carrying
Basic auth. For an existing repo, prefix git args with the result of
`await githubAuthPrefix({ workspacePath, projectId })`
(`src/bun/rpc/github-api.ts:146`), which returns `[]` (unchanged behaviour) for
non-HTTPS-github remotes or when no token is configured.

**Why:** embedding `x-access-token:<token>@github.com` in a URL while a helper
is active makes Git *store* an `x-access-token` account in the user's credential
manager. That pollutes their GCM and triggers an interactive "Select an account"
GUI on the user's *own* pushes — and during autonomous flows (Issue Fixer) there
is no human present to dismiss it. The contract is spelled out on
`pushBranchAuthenticated` (`src/bun/rpc/github-api.ts:183`), which additionally
pushes only the explicitly-named branch (refspec `branch:branch`, no "default to
current branch") so it can never accidentally push a base branch, and redacts
the token from any error output (`src/bun/rpc/github-api.ts:161`).

## Kanban flow enforcement: backlog → working → review → done

The column lifecycle is enforced in the agent tool, not by convention. The
`move_task` tool only accepts `backlog | working | review` as destinations —
`done` is deliberately absent from its enum (`src/bun/agents/tools/kanban.ts:262`)
— while the `create_task` enum lists all four
(`src/bun/agents/tools/kanban.ts:131`). At execute time three guards apply:

- **No moving out of "done":** the review system owns that transition; an agent
  attempting it gets an error (`src/bun/agents/tools/kanban.ts:291`).
- **No skipping columns:** `backlog → review` is rejected with an instruction to
  go through "working" first (`src/bun/agents/tools/kanban.ts:314`).
- **All acceptance criteria must be checked before "review":** `move_task` calls
  `checkAllCriteriaMet` and refuses with a list of unmet criteria
  (`src/bun/agents/tools/kanban.ts:80`).

The only path *into* "done" is the automatic review system: `submit_review`,
which only the code-reviewer agent should call, moves an approved task to "done"
(`src/bun/agents/tools/kanban.ts:639`). Moving a task to "review" also notifies
the review cycle to spawn the reviewer (`src/bun/agents/tools/kanban.ts:336`).
This is why **the PM is the sole orchestrator and there is no separate workflow
engine** — the kanban tools themselves encode the state machine, and
`review-cycle.ts` reacts to the "review" notification independently.

Task *authorship* is restricted the same way (since 2026-06-30): **only the
`task-planner` holds `create_task`** — it is the sole author of kanban tasks.
The restriction is enforced in three places: the default tool assignment
(`src/bun/db/seed.ts:1366`), a runtime strip applied to every other agent's tool
set on both the allowlist and full-registry paths (`restrictCreateTask`,
`src/bun/agents/tools/create-task-policy.ts:23`, applied in
`src/bun/agents/tools/index.ts:163` and `:174`), and an idempotent seed pass
that deletes stale `create_task` rows older installs seeded onto implementer
agents (`src/bun/db/seed.ts:1743`). The PM never gets it either — its inline
toolset omits `create_task` (`src/bun/agents/engine.ts:516`); to add a task it
dispatches the task-planner.

## Naming conventions (observed, not always consistent)

- **Internal agent names are kebab-case** in `seed.ts` — `project-manager`,
  `backend-engineer` — with one historical exception: `frontend_engineer` uses
  an underscore (`src/bun/db/seed.ts:191`). This is a wart, not a pattern;
  match the *existing* name when referencing an agent, don't normalise it.
- **DB tables are `snake_case`** (`sqliteTable("settings", …)`), columns
  `snake_case` mapped to camelCase Drizzle fields.
- **Migration files** are `v<N>_<kebab-description>.ts` and export a `name`
  string (the description, no `v<N>` prefix) plus `run()`.
- **RPC contract files** are one-per-domain kebab-case under `src/shared/rpc/`,
  exporting a `<Domain>Requests` type.
- **Settings keys** for per-project state use the `project:<id>:<field>`
  convention (`src/bun/rpc/github-api.ts:31`); the feature branch is stored as
  `currentFeatureBranch:<projectId>` under category `git` (see CLAUDE.md).

## Key files

| File | Role |
|---|---|
| `src/bun/rpc-registration.ts` | Wires all RPC handler groups; `withErrorToast`; `maxRequestTime: Infinity` |
| `src/shared/rpc/index.ts` | Aggregates per-domain RPC contracts into `AgentDeskRPC` |
| `src/bun/db/schema.ts` | Drizzle source of truth — never alter without a migration |
| `src/bun/db/migrate.ts` | `user_version` runner + auto-backup + `ensureRuntimeSchema` defensive re-run |
| `src/bun/db/migrations/v34_external-issues-due-date.ts` | Canonical idempotent (PRAGMA-guarded `ADD COLUMN`) migration |
| `src/bun/db/seed.ts` | Built-in agent prompts; hash-gated re-seeding for existing users |
| `src/bun/rpc/github-api.ts` | Token resolution chain + credential-helper-free git auth |
| `src/bun/agents/tools/kanban.ts` | Kanban column-transition + criteria enforcement; `submit_review` → done |

## Gotchas / Constraints

- **A new migration MUST be idempotent** — `ensureRuntimeSchema` may re-run it
  on an already-migrated DB. Use `IF NOT EXISTS` / PRAGMA guards.
- **`PRAGMA user_version` is bumped outside the transaction** — a crash between
  COMMIT and the bump will re-run the migration on next start, so idempotency
  also protects against that window.
- **Never embed a token in a git URL while a helper is active** — it pollutes
  the user's credential store and breaks their manual pushes.
- **Editing an agent prompt in engine code does nothing** — prompts are read
  from the DB, seeded from `seed.ts`.
- **`done` is not a valid `move_task` destination** — only `submit_review`
  finalises a task; tests/tools that try to set `done` directly will fail.
- **Only the task-planner may hold `create_task`** — `restrictCreateTask` strips
  it from every other agent at tool-build time, regardless of `agent_tools` rows
  (`src/bun/agents/tools/create-task-policy.ts:23`); the PM's inline toolset
  omits it by construction.
- **`frontend_engineer` is the one underscore agent name** — don't "fix" it.

## Related
- [[directory-map]]
- [[agent-engine]]
- [[kanban-review-cycle]]
- [[database-tables]]
- [[github-token-auth]]

## Open questions
- Is there an ESLint/Prettier-enforced naming lint, or are conventions purely
  convention? (`bun run lint` exists per CLAUDE.md; the rule set was not read.)
- Are plugin-defined RPCs subject to the same `shared/rpc` contract boundary, or
  do they register dynamically outside it? (Not verified here.)
