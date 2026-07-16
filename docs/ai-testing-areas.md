# AI Testing Areas — Domains I Can Test Without a Human

> Reference document, not migration-specific. Lists the categories of testing/
> verification an AI agent (me, in this environment) can genuinely perform
> end-to-end without requiring a human — for any feature, in any future
> session, not just the AI SDK migration. Use this to quickly decide "can I
> verify this myself?" before asking the user to test something manually.
>
> **Standing preference across all categories**: prefer methods that produce
> text (console output, DOM snapshots, DB rows, RPC return values, structured
> accessibility trees) over screenshots. A screenshot is the most expensive
> verification method available (large image tokens) and should only be used
> when the thing under test is **genuinely visual** — layout, color, spacing,
> an actual rendered image's content — and no text-based signal can confirm
> it. Even then, prefer a single targeted screenshot over repeated ones.

---

## 1. Static & type-safety verification

- `bun run typecheck` (tsc --noEmit), `bun run lint` (ESLint), `bun run format:check` (Prettier) — zero-cost-to-run, deterministic, catch an entire class of migration/refactor breakage before anything executes.
- Grep-based sweeps for deprecated APIs, dead code, leftover TODOs, or a specific pattern's every call site (e.g. confirming a rename reached every file).
- Zod/Drizzle schema shape review by reading the schema file directly — confirms a migration's shape matches what code expects, without running anything.
- Dependency auditing: reading `package.json`/lockfile for version drift, peer-dependency mismatches, or duplicate nested copies of a package (`bun pm ls`, or inspecting `node_modules/<pkg>/package.json` directly).

## 2. Automated test suites

- Running the existing suite (`bun test`) and reading pass/fail/skip counts and specific failure output.
- Writing new unit/integration tests that reproduce a reported bug, then confirming they go red → green across a fix.
- Writing throwaway standalone scripts (`bun run scripts/foo.ts`, deleted after use) to exercise one function/module/library call in isolation with real inputs — the pattern used for `scripts/verify-ai-sdk-v7-live.ts` this migration: talk to the real dependency directly, skip the full app stack, get empirical proof instead of trusting documentation.

## 3. Database-level verification

- Direct SQL queries (`sqlite3.exe` via the PowerShell tool on this machine, or a throwaway Bun script using `bun:sqlite`) against the dev DB to confirm: rows actually persisted, a migration's schema matches `schema.ts`, foreign-key integrity, a specific column's value distribution across N rows (e.g. "does `promptTokens` come back non-zero for 59/59 messages").
- Cross-referencing two independent tables (e.g. `messages.metadata` vs. `ai_telemetry_events`) to confirm a finding isn't a one-table fluke.
- Before/after row-count or row-shape diffs around an operation, to confirm a write path actually did what the code claims.

## 4. RPC / backend-logic verification (no UI needed)

- Calling backend RPC handlers or exported functions directly from a script, bypassing the React UI entirely — faster and cheaper than driving a browser when the thing under test is backend logic, not rendering (e.g. tool schema validation, a service function's error handling, an approval-gate function's branching).
- Simulating edge-case inputs (malformed payloads, concurrent calls, boundary values) that would be tedious or slow to trigger by clicking through the UI.
- Reused for regression once broken: any bug reproduced by a script becomes a permanent, cheap-to-rerun check.

## 5. Browser automation — DOM/console/network first, screenshots last resort

Two distinct tool families exist here; pick deliberately (see `docs/BROWSER-TESTING.md` for the parallel concern of *AgentDesk's own agents* driving a browser — this section is about *me* testing AgentDesk's own UI):

- **claude-in-chrome** (my own Chrome extension automation) — used to drive AgentDesk's dev-mode web UI (`localhost:5173` after `.\run.ps1`) or any other page needing a real, possibly-logged-in browser context.
- **chrome-devtools MCP** — a throwaway automation-flagged Chromium instance; good for public pages, performance traces, and Lighthouse audits, but carries no saved logins and is more likely to be challenged by bot detection.

Within either, prefer in this order:
1. **`read_page`/`get_page_text`/accessibility snapshot** — structured, text-only representation of the DOM; confirms content, state, and structure without an image.
2. **Console messages** (`read_console_messages` / `list_console_messages`) — confirms client-side errors, warnings, or app-emitted debug logs.
3. **Network requests** (`read_network_requests` / `list_network_requests`) — confirms an RPC call fired, its payload shape, status code, and response body.
4. **`evaluate_script`/`javascript_tool`** — query specific DOM properties directly (e.g. an `<img>` element's `naturalWidth`/`complete` state to confirm an image actually loaded, without ever rendering a screenshot).
5. **Screenshot** — only when the assertion is inherently visual (layout correctness, an actual image's visible content, color contrast) and steps 1-4 can't settle it. Take one, not several, and crop mentally to what matters before deciding whether a second is needed.

## 6. Log & telemetry analysis

- Reading application/dev-console logs for confirmation that expects no UI check at all (e.g. a background job fired, a retry happened, a scheduled task ran).
- Structured telemetry tables (this app's `ai_telemetry_events`) as an independent, text-based signal for things that would otherwise need a live visual check (token counts, cache hits, latency, tool execution success/failure).

## 7. Git/version-control archaeology

- `git log -S'<pattern>' -p`, `git blame`, `git show <ref>:<path>` to determine whether a bug predates a given branch/change, when a specific line was introduced, or whether a regression is genuinely new.
- Comparing a clean base-branch checkout's behavior against the current branch to isolate "did my change cause this" from "this was already broken."

## 8. Documentation/config drift detection

- Cross-referencing `CLAUDE.md`/architecture docs against the actual current code to flag stale claims (a renamed function, a removed table, a changed default) before they mislead a future session.

## 9. Dependency & library research

- Context7 MCP, WebFetch, WebSearch against official docs, changelogs, GitHub issue trackers, and security advisories — to verify a library's real behavior, breaking changes, or known vulnerabilities, rather than relying on a model's possibly-stale training knowledge. Preferred over guessing whenever a specific library/API version's behavior matters.

## 10. Performance & resource profiling

- Chrome DevTools performance trace + insights (`performance_start_trace`/`performance_analyze_insight`), Lighthouse audits, heap snapshots — for load time, render cost, memory growth, and other quantifiable metrics, all returned as structured data rather than images.
- Timestamp-diffing log lines to measure a specific operation's wall-clock duration without any visual profiling tool.

## 11. Security scanning

- Grepping for hardcoded secrets/credentials, unsafe string-built SQL, unauthenticated network calls to unexpected hosts, or missing auth/permission checks around a sensitive code path.
- Confirming a fix doesn't introduce a new OWASP-Top-10-class issue by re-reading the diff with that lens before considering a task done.

## 12. Concurrency & race-condition testing

- Scripted parallel calls (e.g. dispatching N operations simultaneously) to surface race conditions in shared state, DB write contention, or double-processing bugs that are rare or slow to hit by hand.

## 13. Build & packaging verification

- Inspecting the actual production build/artifact output (not just dev mode, which can take a different code path) to confirm bundling, native-binary copying, and icon/asset embedding actually happened — a dev-mode-only check can miss a bug that only exists in the packaged build.

---

## Where I stop and a human is required (the complement of this list)

Kept short here since it's the mirror image of the above — full detail belongs in whatever human-testing document is relevant to the task at hand:

- Anything requiring **entering credentials/secrets** (API keys, passwords, tokens) — prohibited for me regardless of who supplies the value.
- Anything touching a **real external account or production data** the user cares about (a live Freelancer profile, real GitHub issues/PRs, a real Discord/WhatsApp account) where an automated dry run risks an unintended real-world side effect.
- **Genuinely subjective/aesthetic judgment** — "does this look good," voice/audio quality, a generated image's visual appeal — where no text-based or structural signal can substitute for a human's own perception.
- **Installing new local system software** or **granting new OAuth/account permissions** — explicit-permission-required actions I should surface and ask about, not perform unilaterally.
