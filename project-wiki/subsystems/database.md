---
title: Database Layer
type: subsystem
status: verified
verified_at: 2026-07-04
sources:
  - src/bun/db/connection.ts
  - src/bun/db/index.ts
  - src/bun/db/migrate.ts
  - src/bun/db/seed.ts
  - src/bun/db/audit.ts
  - src/bun/db/schema.ts
  - src/bun/db/migrations/v1_initial-schema.ts
  - src/bun/db/migrations/v8_perf-indexes.ts
  - src/bun/index.ts
tags: [database, drizzle, sqlite]
---

# Database Layer

**A single embedded SQLite file, opened once, accessed two ways.** The whole app
shares one `bun:sqlite` `Database` handle (`src/bun/db/connection.ts:142`). Most
code talks to it through a Drizzle ORM wrapper (`src/bun/db/index.ts:7`); a
minority — migrations, seed backfills, audit logging — drops to raw prepared
statements on the same handle. The single most important thing to understand is
the **dual source of truth for schema**: Drizzle's `schema.ts` describes table
*shapes* for typed queries, but it does **not** create or alter tables. The
actual DDL lives entirely in hand-written, versioned migration files. If those
two drift, queries compile but fail at runtime.

## Key idea: two layers over one connection

`openDatabase()` (`src/bun/db/connection.ts:107`) creates exactly one
`new Database(dbFilePath)` where `dbFilePath` is `userData/agentdesk.db`
(`connection.ts:11`). It is exported as the singleton `sqlite`. `index.ts` wraps
that same handle with Drizzle (`drizzle(sqlite)`) and exports it as `db`. So:

- `db` (Drizzle) — typed `select/insert/update` for normal RPC handlers.
- `sqlite` (raw) — `prepare/exec/transaction` for migrations, `INSERT OR IGNORE`
  backfills in seed logic, and the audit log.

Both go through the **same Proxy-wrapped handle** (`connection.ts:59`), so every
`.exec/.prepare/.run/.all/.get` is intercepted to log failures to
`userData/logs/error.log` and console before re-throwing
(`connection.ts:36`, `connection.ts:18`). The logger is deliberately
self-contained — importing the normal error-logger would create a cycle
(`error-logger → audit → sqlite`), noted at `connection.ts:13`.

## Connection PRAGMAs (the tuning)

All set once at open time in `openDatabase()` (`connection.ts:117`–`136`),
applied *before* the Proxy wrap so PRAGMA noise stays out of the error log
(`connection.ts:138`):

| PRAGMA | Value | Why |
|---|---|---|
| `journal_mode` | WAL | concurrent reads during writes |
| `synchronous` | NORMAL | fewer fsyncs (safe under WAL) |
| `cache_size` | -64000 | 64 MB page cache |
| `mmap_size` | 268435456 | 256 MB mmap'd I/O for read-heavy analytics |
| `foreign_keys` | ON | SQLite disables FKs by default |
| `temp_store` | MEMORY | faster cascade deletes / complex queries |
| `busy_timeout` | 5000 | wait 5 s on a lock before erroring |

### WAL checkpoint discipline
WAL grows unbounded over a long session. `startWalCheckpointTimer()`
(`connection.ts:161`) runs `PRAGMA wal_checkpoint(TRUNCATE)` once at startup and
every 30 minutes thereafter (`connection.ts:153`, `connection.ts:155`). It is
fired from the main startup sequence at `src/bun/index.ts:174`. `closeDatabase()`
clears the timer before closing (`connection.ts:144`).

## Startup sequence

The order in `src/bun/index.ts` is load-bearing — schema must exist before any
seed write, and seed must run before the rest of the app touches `db`:

```
runMigrations()        // index.ts:150  — create/alter tables, set user_version
await seedDatabase()   // index.ts:151  — idempotent default data
startWalCheckpointTimer() // index.ts:174
```

## Migration discipline

The runner (`src/bun/db/migrate.ts`) uses SQLite's `PRAGMA user_version` as the
applied-migration counter — there is no migrations table. Each migration is a
module under `migrations/v<N>_<name>.ts` exporting `name: string` and
`run(): void`, statically imported and listed in the `migrations` array
(`migrate.ts:79`). Current head is v53 (`migrate.ts:135`).

`runMigrations()` (`migrate.ts:137`):
1. Reads `user_version`; if already at head, skips to the sanity check
   (`migrate.ts:142`).
2. Before the **first** pending migration on a non-empty DB (`user_version > 0`),
   takes a one-shot backup via `createBackup()` → `VACUUM INTO`
   (`migrate.ts:158`, `src/bun/rpc/backup.ts:31`). Backup failure **aborts** the
   whole upgrade (`migrate.ts:165`).
3. Runs each pending migration inside an explicit `BEGIN/COMMIT`, rolling back on
   error (`migrate.ts:171`–`181`). `PRAGMA user_version = N` is set **outside**
   the transaction because SQLite won't honor it inside one (`migrate.ts:184`).

### Two flavors of migration
- **DDL that mirrors `schema.ts`** — e.g. `v1_initial-schema.ts` is a wall of
  `CREATE TABLE IF NOT EXISTS` whose column definitions must match the Drizzle
  table in `schema.ts` by hand (compare `migrations/v1_initial-schema.ts:7` to
  `schema.ts:9`). **`schema.ts` is never the thing that builds the table.**
- **Pure data / index migrations** — e.g. `v8_perf-indexes.ts` only adds an index
  (`migrations/v8_perf-indexes.ts:11`); `v42` backfills a tool onto existing
  agents; `v26` deletes the legacy `general-agent` row.

### The defensive `ensureRuntimeSchema()` net
After migrations (and even when already at head), `ensureRuntimeSchema()`
(`migrate.ts:199`) re-runs a curated set of *idempotent* migration `run()`s
unconditionally — v27/v29/v30/v32/v33/v34/v35/v36/v38/v39/v40/v41/v42/v43/v44/v45/v48/v50/v51 — and
hand-checks for late-added `agents` columns (`migrate.ts:343`–`357`). This exists
because in dev, a hot-reload can pick up new schema code while `user_version`
already raced ahead (e.g. a shared dev DB pulled between branches), leaving the
running code expecting columns the DB lacks. Every branch here must be safe to
run repeatedly — that is why those migrations are written as
`CREATE TABLE IF NOT EXISTS` or PRAGMA-guarded `ADD COLUMN`. This is the practical
reason new tables/columns should use idempotent DDL.

## Seeding

`seedDatabase()` (`src/bun/db/seed.ts:1453`) runs on **every** launch and must be
fully idempotent. It seeds default `settings` (only when the table is empty,
`seed.ts:1457`), a versioned `constitution` that re-publishes on a
`CONSTITUTION_VERSION` bump (`seed.ts:1477`), a default MCP config, a "Free"
provider for fresh installs (`seed.ts:1560`), the built-in agent roster, prompt
templates, and per-agent tool assignments.

The expensive part — re-upserting ~22 built-in agent prompts — is gated by an
FNV-1a hash of the bundled agent defs stored in `settings`
(`seed.ts:14`, `seed.ts:1583`). On an unchanged launch the upsert is skipped
entirely; on an app upgrade the hash changes and prompts/colors/display-names are
updated **without ever touching custom agents** (`seed.ts:1600`–`1631`). Hidden
built-in agents (`playground-agent`, `issue-fixer`, `freelance-expert`) are then
normalized to `availableToPm: 0` so the PM never orchestrates them
(`seed.ts:1633`–`1653`). `seedAgentTools()` (`seed.ts:1691`) seeds a default tool
set only for agents with zero `agent_tools` rows, then top-up-adds any missing
default tools — preserving user customisation. One targeted exception: it also
**removes** stale `create_task` rows from every agent except the `task-planner`
(the sole task author since 2026-06-30), so existing installs' Agents pages
reflect the restriction (`seed.ts:1743`–`1761`; runtime is enforced separately by
`restrictCreateTask`). See [[agent-roster]] and seed for the roster details.

## Audit log

`logAudit()` (`src/bun/db/audit.ts:35`) is fire-and-forget: a lazily-prepared
`INSERT` into `audit_log` that **never throws** (`audit.ts:45`). The statement is
lazy because `audit.ts` can be imported before `runMigrations()` creates the
table (`audit.ts:18`).

## Key files

| File | Role |
|---|---|
| `src/bun/db/connection.ts` | Opens the single `bun:sqlite` handle, sets PRAGMAs (WAL), Proxy-wraps for error logging, WAL checkpoint timer |
| `src/bun/db/index.ts` | Wraps the handle with Drizzle → exports `db` |
| `src/bun/db/schema.ts` | Drizzle table definitions (typed query shapes) — **not** DDL |
| `src/bun/db/migrate.ts` | `user_version`-based runner + auto-backup + `ensureRuntimeSchema()` net |
| `src/bun/db/migrations/v*.ts` | Hand-written DDL/data migrations; each exports `name` + `run()` |
| `src/bun/db/seed.ts` | Idempotent default data (settings, agents, tools, prompts) seeded every launch |
| `src/bun/db/audit.ts` | Never-throws audit log writer (raw prepared statement) |

## Gotchas / Constraints

- **`schema.ts` does not create tables.** Editing it alone changes nothing at
  runtime. A schema change requires a matching migration file *and* an entry in
  the `migrations` array (`migrate.ts:79`). Drifting the two yields queries that
  type-check but fail at runtime.
- **`user_version`, not a migrations table.** Manually bumping it (or a dev
  hot-reload doing so) can skip real DDL — the reason `ensureRuntimeSchema()`
  exists. New migrations should be idempotent so they survive that net.
- **`PRAGMA user_version` must be set outside any transaction** (`migrate.ts:184`).
- **Seed runs on every launch**, so it must never repeatedly delete or overwrite
  user data — destructive one-shots (like removing `general-agent`) belong in a
  migration (`seed.ts:1578`), not in seed. (The one sanctioned exception is the
  idempotent removal of stale `create_task` rows from non-task-planner agents,
  `seed.ts:1743` — it targets only a built-in default the app itself seeded.)
- **One connection, shared everywhere.** Heavy synchronous work on `sqlite`
  blocks all DB access; the 5 s `busy_timeout` only covers external lock
  contention (e.g. the background vacuum worker that reopens `dbFilePath`).
- The "corruption-safe" phrasing in CLAUDE.md overstates `connection.ts` — the
  resilience is really WAL + auto-backup-before-migration + the Proxy error
  logger, not active integrity-check/recovery on open.
- Tables created only by raw migrations (e.g. `keyboard_shortcuts`) have **no**
  Drizzle model — they're queried via raw `sqlite` only. See
  [[database-tables]].

## Related

- [[database-tables]] — full table catalog (Drizzle-managed vs raw-SQL)
- [[agent-roster]] — the agents seeded here
- [[rpc-layer]] — handlers that consume `db`

## Open questions

- Is the background vacuum worker (referenced at `connection.ts:9`) still wired
  up, and where? Confirm it opens `dbFilePath` read/write and how it coordinates
  with the main handle's WAL checkpoint.
- `agent_sessions`/`agent_session_messages` were created in v3 and dropped in v4
  (inline-agent rewrite) — verify no residual code references them.
