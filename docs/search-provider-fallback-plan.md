# Search Provider Fallback — Implementation Plan

> Status: **implemented.** Layers 1–3 below are complete (see
> `src/bun/agents/tools/web.ts`, `src/mainview/pages/settings/search-settings.tsx`,
> `docs/workflow.md`, `src/bun/db/seed.ts`). Verified via the fetch-mocked
> fallback matrix in `tests/agents/web-search.test.ts`, `bun run typecheck`,
> `bun run lint`, and the full `bun test` suite. `docs/prd.md` step 10 (adding
> a Web Tools row) was left as-is — it was a pre-existing documentation gap,
> not something this feature introduced. This document is kept as the design
> record.

## Context

Today the `web_search` agent tool (`src/bun/agents/tools/web.ts`) has a
two-tier engine model: use **Tavily** if `tavily_api_key` is set in
Settings → Integrations, else scrape **DuckDuckGo**. There is no Brave
option, and no automatic fallback when Tavily hits its rate limit / quota —
an agent's search just fails with an error string.

**Goal:** add **Brave Search** as a middle tier and make `web_search`
self-heal along a fixed hierarchy: **Tavily → Brave → DuckDuckGo**.
DuckDuckGo (no key required) is always the last resort. Agents keep calling
a single `web_search` tool; the fallback is deterministic in code, invisible
to the agent. Works identically for existing and new users because the tool
name and its agent assignments are unchanged.

## Foundation decisions (locked)

- **Single `web_search` tool, internal auto-fallback.** No new agent tools,
  no `seed.ts` `agent_tools` changes. Every agent that already has
  `web_search` inherits the upgrade for free. (The AI SDK has no structural
  notion of tool priority/fallback ordering, so exposing 3 separate engine
  tools instead would make fallback correctness depend on each model
  reliably following prompt text every call — fragile, especially on
  smaller/free models, and it burns extra context on 3 tool schemas instead
  of 1.)
- **Hierarchy:** Tavily (if key) → Brave (if key) → DuckDuckGo (always).
  Fall through to the next engine on rate-limit/quota, auth failure,
  network/timeout error, or zero parsed results — i.e. *any* error, per the
  original ask.

## Current implementation reference (as of this writing)

- `src/bun/agents/tools/web.ts`:
  - `getIntegrationKey(key)` (L13-20) — reads `settings` table,
    `category = "integrations"`, given `key`.
  - `withTimeout(abortSignal, ms)` (L40-42) — combines the AI SDK's run-level
    `abortSignal` with a short per-request timeout via `AbortSignal.any`.
  - `ddgSearch()` (L48-95) — raw HTML scraper against
    `https://html.duckduckgo.com/html/`, regex-parses `result__a` /
    `result__url` / `result__snippet` blocks. Returns a JSON **string**;
    on failure returns `{ error }` as a string (does not throw).
  - `tavilySearch()` (L97-150) — POSTs to `https://api.tavily.com/search`.
    Handles `401` (invalid key), `429` (rate limit), other non-OK. Returns a
    JSON **string**; on failure also returns `{ error }` as a string rather
    than throwing.
  - `webSearchTool` (L156-186) — `execute()` picks Tavily if a key exists,
    else DuckDuckGo. This is the entire routing logic today.
  - `webTools` export (L348-352) registers `web_search`, `web_fetch`,
    `http_request`.
- Settings: generic `settings` table (`src/bun/db/schema.ts` L9-22,
  `{key, value, category}`); Tavily key lives at
  `key="tavily_api_key"`, `category="integrations"`. Backend RPC
  (`src/bun/rpc/settings.ts` `getSettings`/`saveSetting`, wired in
  `src/bun/rpc-groups/settings-providers.ts`) is fully generic — no new RPC
  needed for a second key.
- UI: `src/mainview/pages/settings.tsx` (L90-95) renders the
  `integrations` tab's sub-tabs, currently `GitHub` +
  `Tavily Search` (→ `src/mainview/pages/settings/tavily-settings.tsx`,
  `TavilySettings` component — password-style input, eye toggle,
  `StatusDot`, Save/Remove via `rpc.saveSetting`/`rpc.getSettings`).
- Agent wiring: `src/bun/db/seed.ts` — `WEB = ["web_search", "web_fetch",
  "http_request"]` (L1366), spread into `defaultAgentTools` for
  `software-architect`, `frontend_engineer`, `backend-engineer`,
  `devops-engineer`, `security-expert`, `performance-expert`,
  `data-engineer`, `database-expert`, `ui-ux-designer`, `code-explorer`,
  `research-expert`, `api-designer`, `mobile-engineer`, `ml-engineer`,
  `playground-agent`. Runtime resolution via `getToolsForAgent()` in
  `src/bun/agents/tools/index.ts` (L103-177) — because we are not adding new
  tool *names*, none of this needs to change.
- Docs: `docs/workflow.md` mentions `web_search` at L524 (tool table) and
  L585 (key-files table); `docs/prd.md`'s "Built-in Tools" section (from
  L1192) has no Web Tools sub-table at all (pre-existing gap).

## Layer 1 — Backend engine + fallback (`src/bun/agents/tools/web.ts`)

1. **Introduce a typed failure signal.** Add a small `SearchEngineError`
   (carries `engine` + reason). Refactor `tavilySearch()` and `ddgSearch()`
   so that on any failure (429/quota, 401/403, non-OK, network/timeout,
   empty parse) they **throw** `SearchEngineError` instead of returning a
   JSON error string; on success they return a result **object** (not a
   pre-stringified one). This is what lets the orchestrator distinguish "try
   next engine" from "done" without re-parsing JSON strings.
2. **Add `braveSearch(query, apiKey, maxResults, abortSignal)`** following
   the existing helper style:
   - `GET https://api.search.brave.com/res/v1/web/search?q=…&count=…` with
     headers `X-Subscription-Token: <key>`, `Accept: application/json`,
     reusing the existing `withTimeout()` guard.
   - Map `web.results[]` → `{ title, url, snippet }` (Brave uses
     `description` for the snippet field).
   - `429` → throw (rate-limit/quota); `401`/`403` → throw (invalid key);
     other non-OK / network error → throw.
3. **New `getIntegrationKey("brave_api_key")`** read — the helper is already
   generic, this is just a second call site.
4. **Rewrite `web_search`'s `execute()`** to build an ordered engine list
   from whichever keys exist (Tavily first, then Brave), always appending
   DuckDuckGo last. Loop through it: try each engine, on
   `SearchEngineError` record the reason and continue to the next, return
   the first success (`JSON.stringify`d). Tag the payload with
   `engine: "tavily" | "brave" | "duckduckgo"` so behavior is observable and
   testable end-to-end. If every engine fails (DuckDuckGo included), return
   `{ error: "All search engines failed", details: [...] }`.
5. **Update the tool `description`** to state the Tavily → Brave →
   DuckDuckGo routing and that DuckDuckGo needs no key.

## Layer 2 — Settings UI (single "Search" sub-tab)

6. **New `src/mainview/pages/settings/search-settings.tsx`** — one page
   holding **both** key inputs (Tavily + Brave), each mirroring the current
   `tavily-settings.tsx` pattern (password input + eye toggle +
   `StatusDot` + Save/Remove via `rpc.saveSetting(key, val, "integrations")`,
   load via `rpc.getSettings("integrations")`). Keys reused verbatim:
   `tavily_api_key`, new `brave_api_key`. Add a **"How agents use this"**
   note card explaining the Tavily → Brave → DuckDuckGo hierarchy and that
   DuckDuckGo is the always-on no-key fallback used whenever a configured
   engine errors or hits its limit.
7. **`src/mainview/pages/settings.tsx`** — replace the `integrations`
   sub-tab entry `{ value: "tavily", label: "Tavily Search", content:
   <TavilySettings /> }` with `{ value: "search", label: "Search", content:
   <SearchSettings /> }`. Remove the now-unused `TavilySettings` import and
   delete `tavily-settings.tsx` — its content is absorbed by the new page.

## Layer 3 — Docs & prompts

8. `docs/workflow.md` — update the two `web_search` references (tool table
   ~L524, key-files table ~L585) to describe "Tavily → Brave → DuckDuckGo".
9. `src/bun/db/seed.ts` — update the `research-expert` system-prompt line
   describing `web_search` (currently "Tavily-quality … DuckDuckGo
   otherwise") to mention Brave as the middle tier. (No `agent_tools`/`WEB`
   constant changes — tool name and assignments are unchanged.)
10. `docs/prd.md` — (optional, pre-existing gap) add the missing Web Tools
    row for `web_search` to the "Built-in Tools" section.

## Verification (when implemented)

- `bun run typecheck` + `bun run lint`.
- **Unit (fetch-mocked) fallback matrix:** no keys → duckduckgo; valid
  Tavily → tavily; Tavily 429 + Brave key → brave; both 429 → duckduckgo;
  assert the `engine` tag in each case. This is the primary correctness
  check since it doesn't depend on live provider behavior.
- **Live agent smoke test via the OpenCode free provider:** drive
  `research-expert` (or any `web_search`-equipped agent) end-to-end and
  confirm a real result comes back, with the served `engine` matching
  whichever keys are configured. Note: per prior evaluation, OpenCode's free
  models list a "public" key but live chat-completions calls can return 401
  — if that's still the case, this smoke test's tool-calling path may not
  be exercisable through OpenCode's free tier and the unit-level tests above
  become the authoritative verification, with only manual QA (real keys)
  covering the live path.
- **UI:** launch via `.\run.ps1` → `localhost:5173`, Settings →
  Integrations → Search; save/remove each key; confirm existing users'
  previously-saved Tavily key still loads correctly on the new page.

## Notes / risks

- DuckDuckGo remains a **regex HTML scraper** (brittle by nature) — it's the
  last resort, so a fallback-to-DDG failure surfaces the aggregated error
  from all three engines. No change to that fragility here.
- Brave's free tier is rate-limited (~1 req/s); the 429 → fall-through path
  is exactly what handles that.
- Existing saved Tavily keys are untouched (same `tavily_api_key` settings
  key, same category) — no DB migration needed for this feature.
