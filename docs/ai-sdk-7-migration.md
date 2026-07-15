# AI SDK 7 Migration Plan

> Status: **planning document, not yet executed.** Written 2026-07-14 against
> `ai@6.0.158` (installed) and AI SDK 7.0 (released 2026-06-25). Supersede or
> delete once the migration is complete — don't let this drift like
> `docs/prd.md` did.
>
> **Decisions locked in 2026-07-14** (see §11 for the full log): replace
> `zhipu-ai-provider` with an in-house adapter; build stable tool ordering
> in-house; correct historical cost data where feasible (with a caveat — see
> §5.2); fold all §6/§9 feature-adoption items into this same initiative
> rather than deferring them to separate later PRs; and **run Phase 0-1
> (upgrade + automated codemods) as an isolated first stage**, checkpointing
> before any hand-migration or feature work begins (§4's checkpoint box).
> Track execution against
> [`docs/ai-sdk-7-migration-tasks.md`](./ai-sdk-7-migration-tasks.md) — a
> flat checkbox list mirroring every actionable item in this document.
>
> **Updated 2026-07-15 (§12)**: two feature commits landed on `main` after
> the original sweep — a `generate_image` tool + `image-generation.ts`
> helper, new PM-side media message_parts logic in `engine.ts`, and a
> `generateImage()` method on several provider adapters (incl. `zai.ts`).
> No phase/decision changes, but real new touch points inside already-planned
> work — see §12 for the full breakdown.

---

## 1. Executive Summary

AgentDesk's entire AI SDK footprint is **backend-only** — there is no
`@ai-sdk/react`/`useChat()` anywhere in `src/mainview/` (the historical PRD's
claim to the contrary is stale; the real frontend streaming path is a custom
RPC broadcast system, see §2). That significantly *shrinks* the migration
surface: no UI message-part types to update, no React hook behavior to
re-verify.

What's left is still substantial: **~64 files** touch `ai`/`@ai-sdk/*` as of
2026-07-15 (62 from the original sweep + `image-generation.ts` and
`image-gen.ts`, added since — see §12), split across **12 provider
adapters**, **2 core streaming loops** (`engine.ts` for the PM, `agent-loop.ts`
for sub-agents) that must move in lockstep, and **9 independent chat/agent
surfaces** that each re-implement their own `streamText`/`generateText` loop
outside the PM system. One provider
(`zai.ts`, via the third-party `zhipu-ai-provider` package) is an **external
blocker** — it's pinned to `ai@^6.0.35` and won't compile against v7 until
upstream ships a compatible release, unless we replace it (recommended, see
§5.4).

The good news: AgentDesk already avoids most of the API surface that changed
hardest. Zero usage of `generateObject`/`streamObject`/`embed`/
`wrapLanguageModel`/`extractReasoningMiddleware`/`smoothStream`/
`createProviderRegistry`/`experimental_telemetry`. Structured output is
deliberately done via tool calls with Zod enums instead of `generateObject`
(for cross-provider portability — see `deep-research.ts:15-22`), so that
whole category of breaking changes is a non-issue.

The bad news, concentrated in a few places: the hand-built multimodal content
parts in `media-followup.ts` (used by *every* streaming call site via
`prepareStep`) sit squarely inside v7's canonicated file-part format change —
this is the single highest-risk item in the migration. There's also a real,
concrete **correctness question**, not just a rename: v7's migration guide
states `result.usage` was **final-step-only** in v6 and becomes **all-steps
total** in v7 (the reverse of what `totalUsage` used to mean). If AgentDesk's
cost/token accounting (`messages.metadata.promptTokens/completionTokens`) has
been reading `result.usage` from multi-step PM/agent turns (`stopWhen:
[stepCountIs(100)]`), historical token counts for tool-heavy turns may have
been undercounted — worth an explicit before/after check (§5.2).

---

## 2. Current State — What AgentDesk Runs Today

### 2.1 Installed versions

| Package | package.json | Resolved | Role |
|---|---|---|---|
| `ai` | `^6.0.141` | `6.0.158` | Core SDK |
| `@ai-sdk/anthropic` | `^3.0.64` | `3.0.69` | Anthropic + Claude Subscription (Haiku path) |
| `@ai-sdk/openai` | `^3.0.48` | — | OpenAI |
| `@ai-sdk/openai-compatible` | `^2.0.37` | — | Custom, OpenRouter, Ollama, OpenCode |
| `@ai-sdk/google` | `^3.0.53` | — | Google Gemini |
| `@ai-sdk/deepseek` | `^2.0.26` | — | DeepSeek |
| `@ai-sdk/groq` | `^3.0.31` | — | Groq |
| `@ai-sdk/xai` | `^3.0.74` | — | xAI Grok |
| `@anthropic-ai/claude-agent-sdk` | `^0.3.207` | — | Claude Subscription non-Haiku path (CLI subprocess) |
| `@modelcontextprotocol/sdk` | `^1.29.0` | — | MCP client |
| `zhipu-ai-provider` (3rd-party) | `^0.3.0` | `0.3.0` | Z.AI/GLM — **peer-deps on `ai@^6.0.35`, `zod@4.3.5`** |
| `zod` | `^3.24.0` | `3.25.76` | Tool/schema validation everywhere |

No `@ai-sdk/react`, no `ai/react`, no `@ai-sdk/otel`.

### 2.2 Architecture summary (for readers who haven't internalized `docs/workflow.md`)

- **PM is the sole orchestrator** (`src/bun/agents/engine.ts`, `AgentEngine`,
  one per project). Runs its own `streamText` loop with `stopWhen:
  [stepCountIs(100)]`, a hallucination guard, transient-error retries, and a
  non-Haiku Claude-Subscription branch that skips AI SDK entirely
  (`runClaudeCliTask`).
- **Sub-agents run inline** via `src/bun/agents/agent-loop.ts`'s
  `runInlineAgent()` — fresh context per agent, own `streamText` loop, a
  4-tier context-compaction ladder, stuck-loop detection, same
  Claude-Subscription CLI branch.
- **9 more independent surfaces** each run their own `streamText`/
  `generateText` + `tool()` loop outside the PM/agent-loop system:
  `rpc/dashboard.ts`, `rpc/dashboard-agent.ts`, `rpc/council.ts`,
  `rpc/skills-search-chat.ts`, `rpc/freelance-chat.ts`, `collections/chat.ts`,
  `rpc/freelance-wizard.ts`, `scheduler/task-executor.ts`, plus several
  `generateText`-only files in `src/bun/freelance/`.
- **Streaming to the frontend is NOT `useChat()`.** It's a custom RPC
  broadcast system (`AgentEngineCallbacks` → `engine-manager.ts` →
  `broadcastToProject`/`broadcastToWebview` → Zustand `chat-store.ts`). The
  v7 migration is entirely backend-scoped.
- **Structured output** is deliberately tool-calls-with-Zod-enums, never
  `generateObject` — an explicit portability decision (see
  `deep-research.ts:15-22`, `rpc/freelance-wizard.ts:911`).
- **Multimodal (images/audio)** never gets stored in durable message history
  as content parts — `context.ts`'s `buildContext()` returns plain-text
  `ModelMessage[]` only. Media is delivered *live*, per-turn, via
  `media-followup.ts`'s `buildMediaFollowUpMessage()`, injected through
  `prepareStep` in both `engine.ts` and `agent-loop.ts`. This is the one
  mechanism every single streaming call site depends on.
- **Two-path Claude Subscription provider**: Haiku goes through a normal
  `@ai-sdk/anthropic` adapter; Sonnet/Opus go through
  `@anthropic-ai/claude-agent-sdk`'s `query()`, spawning the user's `claude`
  CLI as a subprocess — a completely separate execution path with its own
  hand-rolled JSON-Schema↔Zod tool bridge, documented in full in
  `docs/claude-subscription-architecture.md`.
- **No telemetry, no OpenTelemetry, no middleware.** Cost/reasoning
  extraction is done by hand per-provider (`extractPMReasoning()` in
  `engine-types.ts`, scanning `experimental_providerMetadata` namespaces).
  Logging is a custom file-based `prompt-logger.ts` (opt-in, dev only) plus
  console-only `tool-call-logging.ts`.

---

## 3. External Sources Analyzed

| Source | Key takeaway |
|---|---|
| [AI SDK 7.0 Migration Guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0) | Full breaking-change list + codemod suite (`npx @ai-sdk/codemod v7`) |
| [Vercel Blog — AI SDK 7](https://vercel.com/blog/ai-sdk-7) | Feature narrative: agent context/approval/durability, telemetry overhaul, HarnessAgent, realtime/video (experimental) |
| [Vercel Changelog — AI SDK 7](https://vercel.com/changelog/ai-sdk-7) | Condensed breaking-change + feature list, same release |
| [AI SDK Core — Telemetry: Tracing Channel](https://ai-sdk.dev/docs/ai-sdk-core/telemetry#tracing-channel) | `node:diagnostics_channel`-based telemetry (`ai:telemetry`), no integration registration needed |
| [@aisdk tweet, 2026-06-22](https://x.com/aisdk/status/2069091483895070791) | Announces the tracing channel: *"Trace AI SDK calls without a custom integration... a Node.js tracing channel for observability providers to follow model calls and tool executions."* Reinforces the docs above — **recommend integrating**, see §7.1. |
| [@zirkelc_ tweet, 2026-07-06](https://x.com/zirkelc_/status/2074135664287694907) | Third-party package `ai-tool-set`: AI SDK sends tools in `tools`-record order, so toggling a tool on/off shifts every tool after it and invalidates the provider's prompt-cache for the tool block. `ai-tool-set` keeps always-on tools in a stable prefix and sorts conditional tools to the tail, flowing through `inferTools()`/`activeTools`/`prepareStep`. **Directly relevant** — AgentDesk already relies on Anthropic prompt caching and varies tool sets per agent role/Quick-Chat/Playground/Issue-Fixer. See §7.2. |

Both tweets are dated after this assistant's training cutoff (January 2026);
content was fetched live via browser automation, not recalled.

---

## 4. Migration Plan

Do this as a dedicated feature-branch task, not incrementally alongside other
work — the two core loops (`engine.ts`, `agent-loop.ts`) gate every other
surface in the app, so a half-migrated state breaks everything at once.

**Two stages, not one continuous pass** (decided 2026-07-14): Stage A is
Phase 0 + Phase 1 only — upgrade the dependencies, run the automated
codemods, verify the resulting state is sound. Stage B (Phase 2 onward —
all hand-migration, feature adoption, and new UI) only starts once Stage A's
checkpoint (below) has been reviewed. Don't let Stage B bleed into the same
sitting as Stage A by default.

### Phase 0 — Pre-flight (no code changes)

1. **Decided**: replace `zhipu-ai-provider` with an in-house
   `@ai-sdk/openai-compatible` adapter (§5.4) — build this in Phase 2, not
   blocking the branch cut on upstream.
2. Confirm Bun's Node-22 baseline is a non-issue: Bun doesn't enforce
   `package.json#engines.node`, and Bun's own Node-compat layer already
   exceeds Node 22 feature coverage (confirmed `node:diagnostics_channel`
   including `TracingChannel` works on Bun). No runtime upgrade needed.
3. Snapshot current token/cost numbers for a few known multi-tool-call
   conversations (via `messages.metadata`) — needed to sanity-check the
   `usage` aggregation semantics change in §5.2 after migrating, and to
   establish the pre-migration cutover point (§5.2's cost-data decision).
4. Freeze: no new `ai`/`@ai-sdk/*` call sites land on `main` until the
   migration branch merges (or they'll need re-touching).

### Phase 1 — Dependency bump + automated codemods

```bash
bun add ai@7 @ai-sdk/anthropic@latest @ai-sdk/openai@latest \
  @ai-sdk/openai-compatible@latest @ai-sdk/google@latest \
  @ai-sdk/deepseek@latest @ai-sdk/groq@latest @ai-sdk/xai@latest
npx @ai-sdk/codemod v7
```

The codemod suite auto-handles the mechanical renames (§5 table, "Codemod?"
column). Run `bun run typecheck` immediately after — it will not compile
clean; that's expected. Triage the remaining errors by file, working outward
from `engine-types.ts` (shared helpers) → `engine.ts`/`agent-loop.ts` (core
loops) → the 9 independent surfaces → provider adapters → tools.

> ### ⏸ Checkpoint — stop here before continuing
>
> **Decided 2026-07-14: Phases 0-1 run as their own isolated step.** Bump the
> dependencies, run the codemod suite, and get a full read on where things
> stand — `bun run typecheck` output, `bun run lint`, and a plain `bun test`
> run — **before** writing or hand-editing a single line for Phase 2 onward.
> The point of this checkpoint is to see the *actual* post-codemod error
> surface first (which is mechanical, how much is the genuinely hard stuff
> from §5.2/§5.5/§5.4/etc.) rather than planning Phase 2's hand-edits against
> this document's prediction of what the codemod will and won't reach. If the
> real error surface differs meaningfully from §4 Phase 2's list, update this
> document to match reality before proceeding — don't silently work around a
> stale plan. Do not start Phase 2 in the same sitting as Phase 0-1 without
> confirming this checkpoint passed.
>
> **Checkpoint reached 2026-07-15** on branch `ai-sdk-7-migration`: codemod
> touched 30 real source files cleanly (exit 0; the only transform failures
> were on a gitignored `dist-web/` build artifact the ignore-patterns missed).
> `bun run typecheck` — 37 errors / 10 files, 86% one root cause (leftover
> `system`→`instructions` shorthand-property fallout the codemod couldn't
> mechanize, squarely Phase 2.4 scope). `bun test` — 712 pass / 20 fail / 1
> skip, all failures cascading from the same `instructions`-undefined bug at
> `council.ts:165`, plus two independent secondary bugs surfaced
> (`council.ts:81` duplicate provider-config error; `channels/manager.ts:626`
> `engine.sendMessage is not a function`). `bun run lint` — **fully clean**,
> which corrects this section's implicit assumption: ESLint's configured
> rules here aren't type-aware enough to catch breaking API-shape renames, so
> lint is not a useful Phase 2 progress signal going forward — rely on
> typecheck + tests. Full detail in `ai-sdk-7-migration-tasks.md`'s Phase 1
> section. No other §5 table predictions need correction. **Go/no-go on Stage
> B: pending user decision.**

### Phase 2 — Hand-migrate what the codemod can't reach

The codemod rewrites call sites; it does not redesign the media-content-part
shim or re-derive usage semantics. Hand-migrate, in this order (each is a
hard dependency of the next):

1. **`engine-types.ts`** — shared helpers (`applyAnthropicCaching`,
   `extractPMReasoning`, thinking-budget `providerOptions`). Update
   `extractPMReasoning()`'s fallback chain for v7's `outputTokenDetails.
   reasoningTokens` restructuring; verify `providerOptions.anthropic.thinking`
   still applies the same way alongside v7's new top-level `reasoning` option
   (prefer migrating to the unified option — see §5.7).
2. **`media-followup.ts`** — rebuild `buildMediaFollowUpMessage()`'s content
   parts against v7's canonical `file` shape (`{ type: 'file', mediaType,
   data }` for messages; `{ type: 'file-data', data, mediaType }` /
   `{ type: 'file-url', ... }` for tool results). Update `screenshot.ts`'s and
   `audio.ts`'s `toModelOutput` callbacks in lockstep — they build the
   tool-result side of the same handshake.
3. **`claude-subscription-cli-runner.ts`** (lines ~355-371) — independently
   mirrors the media-stripping logic for the CLI/SDK path (it bypasses
   `streamText` entirely). Not touched by the AI SDK content-part rename
   itself, but keep its shape conceptually in sync with #2 so a future reader
   isn't confused by two divergent "how do we send an image" patterns.
4. **`engine.ts` + `agent-loop.ts`** — the two core loops. Rename `system` →
   `instructions`, `fullStream` → `stream`, `onStepFinish` → `onStepEnd`,
   `stepCountIs` → `isStepCount`. Re-verify the hallucination guard (reads
   `step.reasoningText` via thinking-block regex) and the transient-error
   retry loop still see the fields they expect on the new `finalStep`/`usage`
   split.
5. **The 9 independent surfaces** — same renames, lower risk each (they're
   simpler loops), but there are 9 of them: `rpc/dashboard.ts`,
   `rpc/dashboard-agent.ts`, `rpc/council.ts`, `rpc/skills-search-chat.ts`,
   `rpc/freelance-chat.ts`, `collections/chat.ts`, `rpc/freelance-wizard.ts`,
   `scheduler/task-executor.ts` (dynamic `await import("ai")` — codemod may
   not reach this one, check by hand).
6. **Provider adapters** (`src/bun/providers/*.ts`) — mechanical for 10 of
   12. `google.ts` needs the `GoogleGenerativeAI` → `Google` rename check.
   `claude-subscription.ts`'s `interceptFetch` wrapper — verify the
   wrapped-`fetch` signature AI SDK passes through hasn't changed shape (v7
   kept `fetch` as a construction option; low risk, but it's a hand-rolled
   interceptor so worth a direct look).
7. **`zai.ts` rebuild (decided, §5.4)** — remove the `zhipu-ai-provider`
   dependency entirely. Rebuild `ZaiAdapter` on `@ai-sdk/openai-compatible`'s
   `createOpenAICompatible({ baseURL: "https://open.bigmodel.cn/api/paas/v4",
   ... })` (confirm the exact base URL/auth-header shape against Z.AI's
   current API docs — don't assume it's unchanged from what the third-party
   package used), following the same pattern as `ollama.ts`/
   `openrouter.ts`/`opencode.ts`. This removes an external version-lockstep
   risk permanently, not just for this migration.
8. **Stable tool ordering (decided, §6.4/§7.2)** — implement in-house in the
   tool-assembly pipeline (`tools/index.ts`'s `getToolsForAgent()` /
   `getAllTools()`), not via the third-party `ai-tool-set` package: partition
   each agent's resolved tool set into an always-on stable-ordered prefix and
   a conditionally-active tail (sorted deterministically, e.g. alphabetical),
   and feed the result through `prepareStep` consistently in both
   `engine.ts` and `agent-loop.ts`. Verify against `wrapToolsWithHooks`/
   `wrapToolsWithCallLogging` — the ordering must survive those wrapping
   layers unchanged.
9. **One-shot `generateText` call sites** — `summarizer.ts`, `handoff.ts`,
   `deep-research.ts`, `preview.ts`, and the freelance pipeline files
   (`bid-pipeline.ts`, `description.ts`, `qa.ts`, `reply-pipeline.ts`,
   `expert/tools.ts`, `expert/orchestrator.ts`). Same `system`→`instructions`
   rename; lowest risk category (no streaming, no tool loop).
10. **MCP client** (`src/bun/mcp/client.ts`) — `dynamicTool`/`jsonSchema`
    imports; verify signatures unchanged (not called out as breaking in the
    guide, but it's the one place using AI SDK's dynamic-tool machinery
    directly rather than static `tool()`).

### Phase 3 — Feature adoption (same initiative, not deferred)

Per the 2026-07-14 decision, all of §6's new-capability items land as part
of this same effort, sequenced right after Phase 2's behavior-preserving
renames are typechecking clean — not held for a separate later PR. Order
matters here because several depend on each other:

1. **Telemetry + tracing channel (§6.3)** — subscribe to `ai:telemetry`
   once, globally, in `src/bun/index.ts`. Land this *first* among the
   feature-adoption items: everything else in this phase (and the new
   analytics page in §9) benefits from having real event data to validate
   against while building.
2. **Runtime context + typed tool context (§6.1)** — replace the hand-rolled
   `__projectId`/`__conversationId` stamping in `agent-loop.ts` with
   `runtimeContext`/`contextSchema`. Do this before tool-approval (#4) since
   approval functions receive `runtimeContext` too — build the context
   plumbing once, use it in both places.
3. **Unified `reasoning` option (§6.5)** — migrate off
   `providerOptions.anthropic.thinking` where the unified option covers the
   provider; keep `extractPMReasoning()`'s fallback chain for providers it
   doesn't yet cover (verify OpenRouter-proxied models specifically).
4. **Native tool approval (§6.2)** — evaluate whether `toolApproval`
   composes cleanly with the existing shell-approval modal wiring; if so,
   generalize gating to `git_push`/`git_pr` for regular worker agents and
   file deletes outside the workspace root, feeding the analytics page's
   approval-event tracking.
5. **First-class timeouts (§6.6)** — replace `agent-loop.ts`'s hand-rolled
   `TIMEOUT_MS` and `safety.ts`'s timeout helpers. Handle with extra care —
   this is exactly the code class that previously caused the Stop-button
   correctness bugs documented in `claude-subscription-architecture.md`; test
   abort/timeout interaction thoroughly (§8.7) before merging this step.
6. **`uploadFile` prototype (§6.7)** — provider-dependent; prototype against
   Anthropic/OpenAI only once the media-content-part rework (§5.5) is stable,
   since both touch `media-followup.ts`.
7. **HarnessAgent prototype spike (§6.8)** — scheduled now per the
   2026-07-14 decision, scoped strictly as a spike (evaluate feasibility
   against the Claude Subscription two-path branching), not a switch. Apply
   the same prototype-first rigor `claude-subscription-architecture.md`
   already used for the four alternatives it rejected — this item is
   explicitly allowed to conclude "not yet," the same way that doc's mechanism
   #1/#2 did.

### Phase 4 — New UI built on Phase 3's telemetry (§9)

Once Phase 3.1 (telemetry) has been live long enough to accumulate real
event data: build the AI Usage/Cost Analytics page (§9.1, including its
cache-savings view — no separate Dashboard widget), the streaming
performance indicator (§9.2), and the provider-health view (§9.4). These
are UI-only additions with no further backend migration risk.

### Phase 5 — Validation

See §8 (Post-Migration Smoke Testing & Validation Plan). This covers both
the base migration *and* Phase 3's feature additions (the checklist already
includes prompt-caching and Stop-button items relevant to Phase 3.5's
timeout rework) — do not merge any of Phases 1-4 to `main` until the full
checklist passes. Given the expanded scope (everything landing in one
initiative instead of spread across separate PRs), budget for this being a
larger validation pass than a migration-only change would need — consider
running Phase 5 incrementally after Phase 2 (behavior-preserving) and again
after Phase 3/4 (new capabilities), rather than only once at the very end,
so a regression is traceable to the phase that introduced it.

---

## 5. Breaking Changes & Mitigations

| # | Change (v6 → v7) | Codemod? | AgentDesk impact | Mitigation |
|---|---|---|---|---|
| 5.1 | `system` → `instructions`; system messages in `messages[]` rejected by default | Yes (`rename-system-to-instructions`) | ~20+ call sites across both core loops, all 9 independent surfaces, all one-shot `generateText` calls | Run codemod, verify. `context.ts`'s `buildContext()` already skips system-role messages when building history, so `allowSystemInMessages` opt-in is **not needed** — confirmed no persisted system messages ever flow into `messages[]`. |
| 5.2 | `result.usage` semantics flip: was final-step-only in v6, is all-steps-total in v7 (`totalUsage` deprecated, `finalStep.usage` is the new final-step accessor) | No — semantic, not mechanical | **Correctness-relevant, verified 2026-07-14 (§11.2).** Confirmed at `engine.ts:1136` — PM turns (`stopWhen:[stepCountIs(100)]`) read `result.usage` once after the full multi-step stream and persist it to `messages.metadata`. **Sub-agent turns are a separate, bigger gap**: `agent-loop.ts` never persists real usage at all — `messages.metadata` is `NULL` and `token_count` is an explicit content-length heuristic, not API usage (confirmed via direct DB query, messages with 50-79 tool calls). | **Decided 2026-07-14: correct historical numbers where feasible** — see §11.2's full verified writeup. PM-turn numbers get a **cutover marker** (no per-step data existed to recompute from). Sub-agent-turn cost has **no historical data at all** to correct — label it as absent, not approximate, anywhere it's surfaced (§9.1). Telemetry (Phase 3.1) is the first real cost trail sub-agent turns will ever have. **Live-verified 2026-07-15**: `scripts/verify-ai-sdk-v7-live.ts` confirmed against two real providers that `result.usage` is genuinely the sum of all step usages in the installed v7 (matching `agent-loop.ts`'s existing `await result.usage` read exactly) — see `ai-sdk-7-migration-tasks.md` §5.2 for the concrete numbers. |
| 5.3 | `fullStream` → `stream` (old name kept as deprecated alias) | Yes | `engine.ts` and `agent-loop.ts`'s core part-consumption loops both iterate `result.fullStream` | Low urgency (alias works), but migrate for future-proofing — do it in Phase 2.4 alongside the other core-loop renames. |
| 5.4 | Third-party provider (`zhipu-ai-provider`) pinned to `ai@^6.0.35` | N/A — external package | `zai.ts` (Z.AI/GLM provider) won't resolve against `ai@7` until upstream updates | **Decided 2026-07-14**: replace `zhipu-ai-provider` with an in-house `@ai-sdk/openai-compatible` adapter (Phase 2.7), matching the pattern already used for `ollama.ts`/`openrouter.ts`/`opencode.ts`. Removes an external dependency *and* the version-lockstep risk entirely, not just for this migration but permanently. |
| 5.5 | Media/file content-part canonicalization: `{type:'image'}` → `{type:'file', mediaType:'image', data}`; tool-result `{type:'media'}` → `{type:'file-data'}` / `{type:'file-url'}` | Partial (`replace-image-message-part-with-file`) | **Highest-risk item.** `media-followup.ts`'s `buildMediaFollowUpMessage()` hand-builds content parts consumed by *every* streaming call site via `prepareStep`; `screenshot.ts`/`audio.ts`'s `toModelOutput` build the tool-result side | Hand-migrate per Phase 2.2. Test explicitly against both an Anthropic-native model and an OpenAI-compatible model (Ollama or OpenRouter) — this is the one shim explicitly built because "not every provider's tool-result content can carry binary," so verify the new shape still degrades correctly on both families. **Turned out to need no rebuild** — 2026-07-15 investigation found the existing shape already matched v7's canonical `FilePart`, proven via compiler (removing a defensive `as ModelMessage` cast surfaced zero errors) and **live-verified** against Claude Haiku + OpenCode, both correctly accepting the real content and describing a test image — see `ai-sdk-7-migration-tasks.md` §2.2/§5.5. |
| 5.6 | `onFinish` → `onEnd`, `onStepFinish` → `onStepEnd` (old names kept as deprecated aliases) | Yes | `onStepFinish` is the **authoritative persistence hook** in both `engine.ts` and `agent-loop.ts` — every tool call/text chunk gets written to `message_parts` there | Low urgency functionally (alias works) but rename anyway in Phase 2.4 since it's touched in the same pass as `fullStream`/`instructions`. |
| 5.7 | Reasoning: provider-agnostic top-level `reasoning` option; `usage.reasoningTokens` → `usage.outputTokenDetails.reasoningTokens` | Yes (usage field), No (reasoning option adoption) | `extractPMReasoning()` in `engine-types.ts` hand-scans `experimental_providerMetadata` per-provider namespace; thinking budgets set via `providerOptions.anthropic.thinking` | Update the usage-field read (mechanical). **Separately**, evaluate migrating to the new unified `reasoning` option — see §6.5, this is a simplification opportunity, not just a breaking-change fix. **Confirmed 2026-07-15**: nothing in the codebase read `usage.reasoningTokens` to begin with, so there was no field to rename — `outputTokenDetails.reasoningTokens` live-verified present and correctly named on both test providers, ready for Phase 3.3. Separately fixed an unrelated dead-fallback bug found in the same review: `extractPMReasoning()` read the stale `experimental_providerMetadata` name instead of v7's `providerMetadata`. |
| 5.8 | `stepCountIs` → `isStepCount` | Yes | 9 call sites (`engine.ts`, `dashboard.ts`, `dashboard-agent.ts`, `freelance-chat.ts`, `skills-search-chat.ts`, `collections/chat.ts`, `freelance-wizard.ts` ×2, `scheduler/task-executor.ts`) | Codemod handles all of these; `agent-loop.ts` doesn't use `stepCountIs` (uses custom predicate functions in `stopWhen`) so it's unaffected here. |
| 5.9 | `experimental_customProvider`/`experimental_generateImage`/`experimental_output`/`experimental_prepareStep`/`experimental_telemetry` graduate to stable names | Yes | **None used** — grep confirmed zero hits for all of these | No action needed. |
| 5.10 | Google provider: `GoogleGenerativeAI` types/functions → `Google` | Partial | `google.ts`'s `createGoogleGenerativeAI()` call | Verify the exact rename after `bun add @ai-sdk/google@latest` — check whether the factory function itself is renamed or just internal types; codemod should catch it, confirm with a direct read of `google.ts` post-codemod. |
| 5.11 | `CallSettings` type restructuring | N/A (types) | TypeScript-only; any file with an explicit `CallSettings` type annotation | Will surface as a `bun run typecheck` error if present — no separate action needed beyond the standard typecheck pass. |
| 5.12 | Request/response bodies excluded from results by default (`include.requestBody`/`responseBody` now opt-in) | N/A | `prompt-logger.ts` logs system+messages manually *before* the call, not from `result` — unaffected | No action needed; confirmed no code reads `result.request`/`result.response` bodies. |
| 5.13 | Node.js 22+ / ESM-only requirement | N/A | Bun runtime, already `"type": "module"` | No action — Bun doesn't enforce `engines.node` and already exceeds Node 22 API coverage (verified for `diagnostics_channel`). |
| 5.14 | Context system split: `experimental_context` → stable `context` (via `contextSchema`) + `runtimeContext` | N/A (not previously used) | **Not a breaking change for us** — `experimental_context` was never used. But directly relevant as a *new* capability, see §6.1. | N/A here; tracked as a feature-adoption item, not a migration blocker. |
| 5.15 | Zod peer range | N/A | `zod@3.25.76` resolved; `ai@6` already accepted `^3.25.76 \|\| ^4.1.8` | Confirm `ai@7`'s peer range post-bump (not explicitly called out as changed in the sources reviewed); if it narrows, bump `zod` — low risk given current version is already recent. |

---

## 6. New/Extra Features We Should Utilize

### 6.1 Runtime context + typed tool context (`runtimeContext`, `toolsContext`, `contextSchema`)

**Direct replacement candidate** for a hand-rolled mechanism already in
`agent-loop.ts`: tools like `run_shell` and `request_human_input` are
currently wrapped to *stamp* hidden `__projectId`/`__conversationId`
arguments onto every call post-hoc. v7's `runtimeContext` (shared,
orchestration-level) and per-tool `context` (via `contextSchema`, scoped so a
tool only sees what it's declared) is exactly this pattern, formalized and
typed. Migrating would:
- Remove the hand-rolled wrapping logic in `agent-loop.ts`.
- Make it structurally impossible for a tool to receive another tool's scoped
  context (currently relies on the wrapper being applied correctly, not a
  type-level guarantee).
- Flow cleanly through `prepareStep` for step-by-step context adjustments
  AgentDesk already does for other reasons (media follow-up injection,
  compaction ladder).

**Decided 2026-07-14: in scope now**, Phase 3.2 — sequenced right after
telemetry so tool-approval (§6.2) can build on the same context plumbing.

**Implemented 2026-07-15.** Confirmed the blast radius before touching
anything: `__projectId`/`__conversationId` were read only by `run_shell` and
`request_human_input`, stamped only by `agent-loop.ts` (the PM never offers
either tool); `run_shell`'s 4 other independent call sites all use an
`autoApprove=true` variant that never reads the gated path, so they were
unaffected. Added `contextSchema` to both tools (fields optional, preserving
prior graceful-fallback behavior) and wired `toolsContext` at the real
`streamText` call — a narrow, commented `as never` cast was needed since
AgentDesk's tool sets are always a runtime-assembled `Record<string, Tool>`
(DB/role-driven), not a literal object TS can infer `InferToolSetContext`
through. **Bonus synergy with §6.3's telemetry**: also added a separate
global `runtimeContext` (agent/project/conversation) to both `agent-loop.ts`
and `engine.ts`'s `streamText` calls — flows automatically into every
telemetry event with zero sink changes, closing the per-surface-attribution
gap that plain telemetry alone couldn't fill. Full detail in
`ai-sdk-7-migration-tasks.md` §3.2.

### 6.2 Tool approval (`toolApproval`, HMAC-signed)

AgentDesk already has a bespoke "shell approval gate" for `run_shell`
(`tools/shell.ts`) and a separate `ask_user_question`/`request_human_input`
flow. v7's native `toolApproval` (per-tool functions, catch-all functions,
optional HMAC signing to prevent argument tampering) could **generalize**
gating beyond shell commands — e.g., `git_push`, `git_pr` in normal worker
agents (already excluded entirely for `issue-fixer` by omission, but not
formally gated for regular agents), or file deletes outside the workspace
root. **Decided 2026-07-14: in scope now**, Phase 3.4 — evaluate whether
replacing the custom shell-approval UI plumbing with the native mechanism
reduces code without losing the existing UX (the current approval flow is
wired through `AgentEngineCallbacks` to a specific webview modal); if it
composes cleanly, generalize gating to `git_push`/`git_pr`/out-of-workspace
deletes. If the evaluation shows it doesn't fit cleanly, keep the existing
shell-approval gate as-is rather than forcing a bad fit — this phase is
allowed to conclude "not now" on the generalization specifically, same as
§6.8's spike.

**Evaluated 2026-07-15 — concluded "not now."** `toolApproval` is a
stop-and-resume-via-new-call mechanism (an approval-pending tool call
terminates the whole `streamText`/`generateText` call; resuming means issuing
a brand-new call with a `tool-approval-response` message appended), whereas
AgentDesk's existing gate is an in-band `await` inside the tool's own
`execute()` — the surrounding call, stream, step loop, and telemetry `callId`
never stop. Adopting the native shape would mean re-architecting both step
loops (`agent-loop.ts`, `engine.ts`) to persist/resume state and would
fragment telemetry correlation, for no capability the existing gate lacks.
Kept the shell-approval gate as-is; no code changes. Full detail in
`ai-sdk-7-migration-tasks.md` §3.4.

### 6.3 Global telemetry + Node.js tracing channel

**The single biggest opportunity in this migration.** AgentDesk today has
zero telemetry — cost/usage tracking is manual (`result.usage` → DB), and the
only "observability" is `prompt-logger.ts` (opt-in, file-based, dev-focused)
and `tool-call-logging.ts` (console-only). With **9+ independent call sites**
each re-implementing their own loop, there is no unified view of latency,
token cost, cache hit rate, or failure rate across the whole app.

The tracing channel (`ai:telemetry` via `node:diagnostics_channel`, confirmed
working on Bun) solves this **without touching any of the 9+ call sites
individually** — subscribe once, globally, in `src/bun/index.ts`'s startup
path:

```ts
import { tracingChannel } from "node:diagnostics_channel";
import { AI_SDK_TELEMETRY_TRACING_CHANNEL } from "ai";

tracingChannel(AI_SDK_TELEMETRY_TRACING_CHANNEL).subscribe({
  start(message) {
    // forward to a structured sink: SQLite table, or replace
    // prompt-logger.ts's regex log with real structured events
  },
});
```

This is genuinely low-risk (no new dependency needed — it's built into `ai`
itself) and high-value: it's the foundation for the "AI Usage / Cost
Analytics" page idea in §9.1. Recommend adopting per the analysis in §7.1.

**Implemented 2026-07-15, upgraded over this plan**: the actual installed v7
ships a first-class `Telemetry` integration interface (`registerTelemetry()`)
rather than requiring hand-parsing of the raw tracing-channel envelope — its
own types confirm telemetry is "enabled by default when a telemetry
integration is registered," giving the same zero-call-site-changes property
with structured, typed lifecycle events instead. Used that instead of the raw
`node:diagnostics_channel` subscription shown above. Full implementation
detail (schema, sink, prompt-logger.ts's decided fate) in
`ai-sdk-7-migration-tasks.md` §3.1.

### 6.4 Stable tool ordering (protect existing prompt-cache investment)

AgentDesk already uses Anthropic prompt caching (`applyAnthropicCaching()`,
`providerOptions.anthropic.cacheControl`) — real cost/latency savings that
depend on the request being *byte-identical* across turns. But tool sets
vary per agent role (`getToolsForAgent`), Quick Chat (`excludeTools`
stripping kanban tools), Playground, and Issue Fixer — if any of that
filtering changes tool *order* (not just membership) between turns, it
silently invalidates the cached prefix. **Decided 2026-07-14: build in-house**
(Phase 2.8), not via the third-party `ai-tool-set` package — keep always-on
tools in a fixed prefix, sort conditionally-active tools to a stable tail,
feed the result through `prepareStep` consistently. Landing this in Phase 2
(alongside the core migration) rather than Phase 3 protects the existing
cache investment from day one of the v7 cutover, instead of leaving it
exposed during the feature-adoption phase.

### 6.5 Unified `reasoning` option

v7's provider-agnostic `reasoning` option maps to OpenAI, Anthropic, Google,
Groq, xAI, Bedrock, Fireworks, and DeepSeek — which is nearly AgentDesk's
entire provider list. Currently, thinking/reasoning is configured with
provider-specific `providerOptions.anthropic.thinking` and extracted with a
hand-rolled per-provider fallback chain in `extractPMReasoning()`. Migrating
to the unified option (where supported) would let one code path replace
several provider-specific branches — a genuine simplification, not just a
"nice to have." **Decided 2026-07-14: in scope now**, Phase 3.3, with a
careful diff against `extractPMReasoning()`'s existing fallback behavior
(don't regress providers the unified option doesn't yet cover — verify
OpenRouter-proxied models specifically, since AgentDesk's `extractPMReasoning`
explicitly special-cases `openrouter`). Keep the existing fallback chain as a
safety net for any provider the unified option doesn't cover rather than
deleting it outright.

**Implemented 2026-07-15, full replacement (user-confirmed).** Confirmed by
reading each provider package's own source that `@ai-sdk/anthropic`,
`@ai-sdk/openai`, `@ai-sdk/openai-compatible` (covers Ollama/OpenCode/
OpenRouter/Z.AI), `@ai-sdk/google`, `@ai-sdk/groq`, `@ai-sdk/deepseek`, and
`@ai-sdk/xai` all genuinely forward it — a bigger win than "simplification,"
since providers that previously got zero reasoning configuration now get real
control. **Known, accepted trade-off**: Anthropic's mapping is percentage-of-
`maxOutputTokens` (10/30/60% for low/medium/high) rather than AgentDesk's old
fixed token counts (2000/8000/16000) — flagged to the user before
implementing since there's no `maxOutputTokens` value that reproduces all
three old levels simultaneously (the ratios don't match), confirmed to
proceed anyway. Live-verified against two real providers (Claude Haiku,
OpenCode) — accepted cleanly, no errors or warnings. `extractPMReasoning()`
untouched, as planned. Full detail in `ai-sdk-7-migration-tasks.md` §3.3.

### 6.6 First-class timeouts

`agent-loop.ts` hand-rolls `TIMEOUT_MS` (default 30 min) and
`safety.ts`/`createActionTimeout()`; the Claude-Subscription CLI path
separately distinguishes cancelled-vs-timeout on one shared
`AbortController`. v7's granular timeout budgets (total/per-step/per-chunk/
per-tool, with a proper `TimeoutError` type carrying an abort reason) could
replace some of this. **Decided 2026-07-14: in scope now**, Phase 3.5 —
but sequenced *last* among the Phase 3 items and given extra validation time
(§8.7), since this is exactly the class of code most likely to reintroduce
the Stop-button correctness bugs documented in
`claude-subscription-architecture.md` if touched carelessly. "In scope now"
does not mean "rushed" — this is the one Phase 3 item where taking an extra
validation pass is worth more than shipping it alongside everything else.

**Implemented 2026-07-15 — deliberately narrow.** Left `TIMEOUT_MS`/
`timeoutController` and the `isUserAbort`/`isTimeout`/`isContextFull`/
`isStuck` detection completely untouched — they distinguish causes by
checking independently-owned controller objects directly, which is more
precise than anything achievable by inspecting a v7-native timeout's merged
`AbortSignal`/`DOMException` reason, so replacing them would be a strictly
worse mechanism for an already-solved problem. Added only `timeout: {
chunkMs: 120_000 }` to both the sub-agent and PM `streamText` calls — a
genuinely new guardrail (stalled-stream detection) AgentDesk lacked
entirely, chosen specifically because it's orthogonal to tool execution
duration and can't conflict with `run_shell`'s own configurable timeout the
way a global `toolMs` would. Live-verified the one property that mattered
most: a manually-aborted stream's `signal.reason` comes back unmodified with
`chunkMs` set, proving it can't interfere with Stop-button detection. Full
detail in `ai-sdk-7-migration-tasks.md` §3.5.

### 6.7 `uploadFile` (upload-once, reference-later)

`media-followup.ts` re-sends full base64 image/audio payloads on every
`prepareStep` follow-up within a turn. For long screenshot-heavy debugging
sessions, this repeats significant bandwidth/context. v7's `uploadFile` API
(upload once, pass a lightweight reference on subsequent calls) could reduce
this — **provider-dependent** (check Anthropic/OpenAI Files-API-equivalent
support; won't help local Ollama). **Decided 2026-07-14: in scope now**
(Phase 3.6), sequenced strictly after the media-content-part rework (§5.5)
is validated, since they touch the same code — building this before §5.5
lands would mean rebuilding it twice.

**Prototyped and productionized 2026-07-15.** Confirmed live against
Anthropic — via the Claude Subscription OAuth path, since no direct Anthropic
API key exists in this dev environment — that Anthropic's Files REST endpoint
accepts the same OAuth bearer token as chat completions, so upload-once/
reference-later genuinely works there. OpenAI remains unverified (no real key
available; every OpenAI-*compatible* custom provider confirmed to have no
Files API at all, so this only ever helps real Anthropic/OpenAI accounts).
Built into production: `ProviderAdapter.getFilesApi?()` (Anthropic, Claude
Subscription, real OpenAI only), wired through `media-followup.ts` with a
transparent fallback to the original inline-base64 path whenever no Files API
is available or an upload fails. Full detail in
`ai-sdk-7-migration-tasks.md` §3.6.

### 6.8 HarnessAgent (experimental) — spike, don't switch yet

v7 introduces `HarnessAgent` for wrapping external harnesses (Claude Code,
Codex, Deep Agents, OpenCode, Pi) behind AI SDK's own `Agent` interface. This
is **directly relevant** to the long-standing two-path Claude Subscription
branching (`isClaudeSubscriptionViaCli`) spread across ~9 call sites — in
principle, it could unify the CLI/SDK path under the same interface as every
other provider. But `docs/claude-subscription-architecture.md` already
evaluated four alternative unification mechanisms (local proxies, persistent
sessions) and rejected all of them on reliability grounds after real
prototyping — not for lack of a clean abstraction, but because the current
architecture has been validated against nearly every real AgentDesk feature
and the alternatives hadn't. `HarnessAgent` is marked **experimental** in v7's own release notes.
**Decided 2026-07-14: schedule a prototype spike now** (Phase 3.7), but
strictly scoped as a spike — evaluate feasibility, don't switch the
production path. Apply the exact same rigor
`claude-subscription-architecture.md` used for the four mechanisms it
already rejected (real prototyping against actual AgentDesk features:
streaming + tools + abort + concurrency, not toy scenarios), and this spike
is explicitly allowed to conclude "not yet" — that's a valid, useful
outcome, not a failure of the spike. Whatever the outcome, add a dated entry
to `claude-subscription-architecture.md`'s "if a future session wants to
revisit this" section recording what was found.

**Evaluated 2026-07-15 — concluded "not yet."** Didn't need a full
streaming/tools/abort prototype: `HarnessAgent` itself isn't exported by any
published `ai` package version (stable or canary — checked both directly).
The Claude Code harness adapter that does exist requires a network-sandbox
bridge (WebSocket, port exposure, cloud-sandbox-shaped contract) —
fundamentally mismatched with AgentDesk's need for direct, unsandboxed access
to the real local project directory. Full detail and the re-check condition
for a future session are in `claude-subscription-architecture.md`'s
2026-07-15 addendum.

---

## 7. Analysis: Should We Integrate the Referenced Sources?

### 7.1 Telemetry Tracing Channel — **yes, integrate**

Confirmed via both the official docs and the `@aisdk` announcement tweet: no
new dependency, works on Bun, and directly addresses AgentDesk's current
telemetry gap (zero observability across 9+ independent LLM-calling
surfaces). Low implementation cost (one subscription point), no changes to
the 9+ call sites required to get baseline coverage. See §6.3 and §9.1 for
the concrete plan (subscribe → structured sink → analytics page).

### 7.2 `ai-tool-set` (`@zirkelc_`) — **integrate the underlying technique, build it in-house**

The problem it describes is real for AgentDesk specifically (prompt caching
+ per-agent-role tool filtering, §6.4). **Decided 2026-07-14**: build the
stable-prefix / stable-tail ordering logic directly in
`tools/index.ts` rather than taking on the third-party package — it's a
small, well-specified algorithm (partition into always-on vs. conditional,
sort each deterministically, concatenate), not a large dependency surface,
and avoids a second third-party AI-SDK-adjacent package needing its own
v7-compatibility tracking (the same category of problem `zhipu-ai-provider`
just caused, §5.4). Landed in Phase 2.8, ahead of the rest of Phase 3, so the
existing prompt-cache investment is protected from day one of the cutover.

---

## 8. Post-Migration Smoke Testing & Validation Plan

Do not merge the migration branch until every item below passes. Organize by
subsystem, referencing the areas CLAUDE.md calls out as must-work-correctly.

### 8.1 Automated gates (run first, cheapest signal)

- [ ] `bun run typecheck` — zero errors
- [ ] `bun run lint` — zero errors
- [ ] `bun test` — full suite green
- [ ] Grep for leftover deprecated-alias usage (`fullStream`, `onStepFinish`,
      `onFinish`, `system:` in `streamText`/`generateText` calls,
      `stepCountIs`) — should be zero outside intentionally-deferred items

### 8.2 Provider connectivity (one `streamText` call each)

- [ ] Anthropic (direct API key)
- [ ] OpenAI
- [ ] Google Gemini
- [ ] DeepSeek
- [ ] Groq
- [ ] xAI Grok
- [ ] OpenRouter
- [ ] Ollama (local)
- [ ] OpenCode
- [ ] Z.AI — **skip if §5.4 blocker unresolved; explicitly note as a known gap, don't silently pass**
- [ ] Claude Subscription — Haiku path (direct HTTP)
- [ ] Claude Subscription — Sonnet/Opus path (CLI/SDK subprocess)

### 8.3 Core orchestration flow (end-to-end)

- [ ] New feature request → PM plans (task-planner inline) → plan card
      presented → approve → `create_tasks_from_plan` → kanban tasks in
      backlog
- [ ] Sequential single-agent dispatch: worker agent moves task to
      `working` → completes → moves to `review` → `review-cycle.ts`
      auto-spawns code-reviewer → `submit_review(approved)` → task moves to
      `done`
- [ ] Review rejection path: `submit_review(changes_requested)` → task
      returns to `working` → re-dispatch → up to `maxReviewRounds`
- [ ] Parallel read-only agents via `run_agents_parallel`
      (`code-explorer`/`research-expert`/`task-planner`)
- [ ] Kanban drag-drop (human moves Backlog→Working) triggers dispatch via
      `kanban-integration.ts`
- [ ] Plan rejection + re-planning loop (task-planner re-invoked with
      feedback, `update_note`)
- [ ] Agent failure handling: force a worker agent to fail, confirm the
      `[Next Action] INVESTIGATE` hint reaches the PM and it decides
      sensibly (not an automated retry loop)

### 8.4 Multimodal (highest-risk area, test thoroughly)

- [ ] `take_screenshot` tool round trip on an Anthropic-native model
- [ ] `take_screenshot` tool round trip on an OpenAI-compatible model
      (Ollama or OpenRouter) — confirms the content-part shim degrades
      correctly on both families
- [ ] `read_image` tool round trip
- [ ] `read_audio` tool round trip (WAV/MP3)
- [ ] Chat file-upload attachment (image) reaches the model correctly
- [ ] Claude Subscription CLI path: image tool result reaches the model via
      the independent MCP content-block bridge in
      `claude-subscription-cli-runner.ts`

### 8.5 Independent chat/agent surfaces

- [ ] Dashboard chat (project-less)
- [ ] Dashboard-agent chat
- [ ] Collections chat widget
- [ ] Skills-search chat
- [ ] Freelance chat
- [ ] Freelance wizard (bounded `generateText` flow)
- [ ] Council (model-comparison feature)
- [ ] Scheduler cron-triggered agent task (`task-executor.ts`)
- [ ] Playground (verify it still inherits correctly via `runInlineAgent()`)

### 8.6 Quick Chat and Issue Fixer

- [ ] Quick Chat window: kanban/plan-approval tools correctly excluded,
      streaming still functions, no `[Next Action]` kanban lookup crash on
      the empty-board guard
- [ ] Issue Fixer: at least one dry-run poll→trigger→fix→PR cycle;
      confirm it still never calls `git merge`/force-push/etc.
      (`shell-guard.ts` denylist unaffected by this migration, but verify
      the agent's tool set still excludes `git_pr`/`git_push` correctly
      post-migration)

### 8.7 Cross-cutting correctness

- [ ] **Stop button / abort correctness** across all paths — explicitly a
      documented historical bug class (three compounding fixes were needed
      previously); re-verify carefully since `streamText`'s internals
      changed. Test: abort mid-stream on (a) normal `streamText` path, (b)
      Claude Subscription CLI path, (c) mid-tool-call.
  - [ ] Verify the [`ai-retry`](https://x.com/zirkelc_/status/2003352682007003638)-style transient-error retry loops (`MAX_PM_RETRIES`, `MAX_RETRIES` in `safety.ts`) still correctly distinguish abort from transient-error from permanent-error under v7 (the guide doesn't call out `AbortError` handling as changed, but it's adjacent to enough renamed surface to warrant a direct check)
- [ ] Prompt caching still functional — inspect request shape for
      `cache_control` presence, or Anthropic usage dashboard cache-hit
      metrics if available
- [ ] Token usage/cost persisted per message — compare against the Phase
      0.3 pre-migration snapshot for known multi-tool-call conversations
      (§5.2's usage-semantics flip)
- [ ] Reasoning/thinking extraction — spot-check on Anthropic, OpenRouter,
      and one plain-OpenAI model (`extractPMReasoning()`'s three-way
      fallback)
- [ ] MCP client tool wrapping — one real MCP server end-to-end
      (`dynamicTool`/`jsonSchema`)
- [ ] Context compaction/summarization trigger — force a conversation past
      the compaction threshold, confirm `summarizeConversation()`'s
      chunked `generateText` calls still work post-`instructions`-rename
- [ ] Zod schema validation spot check — a complex nested tool schema
      (`verify_implementation` in `kanban.ts`) still validates correctly

---

## 9. New Pages & Features — In Scope for This Initiative

Per the 2026-07-14 decision, these land as Phase 4 (UI) on top of Phase 3's
backend adoption — same initiative, not a someday-later backlog.

### 9.1 AI Usage / Cost Analytics page — what telemetry actually buys it

This is the direct answer to "does telemetry help the analytics page": **it
is the analytics page's entire data source.** Today, the only thing close to
this is `prompt-logger.ts`'s regex-parsed "Analytics" settings view — opt-in,
dev-focused, built from log-scraping the *outgoing* prompt text, and it has
no visibility into the 9+ independent chat/agent surfaces except by manually
adding a `logPrompt()` call to each one. The tracing channel replaces all of
that with one subscription point emitting a structured event per model
call, per step, per tool execution, per embed/rerank — automatically, for
every one of those 9+ surfaces, with zero per-surface instrumentation.

Concretely, each `ai:telemetry` event carries (per the v7 docs/blog): call
ID, model identifier, provider, token usage (input/output/cache/reasoning,
now correctly split via `inputTokenDetails`/`outputTokenDetails`), finish
reason, per-step response time, output tokens/sec, and time-to-first-output.
Tool-execution events carry tool name, duration, and success/error. That
maps directly onto a real dashboard, not a log viewer:

- **Cost & token breakdown** — filterable by project, agent role
  (PM/backend-engineer/code-reviewer/etc.), provider, and date range. Stacked
  by input/output/cache-read/reasoning tokens.
- **Cache hit rate & $ saved** — Anthropic cache-read vs. cache-write token
  ratio, directly measuring whether the stable-tool-ordering fix (§6.4,
  landing in Phase 2) is actually working — this is the metric that proves
  or disproves that fix's value, so sequencing telemetry after it (Phase 2
  before Phase 3.1) means day-one data confirms the cache fix rather than
  measuring a broken baseline first. This lives only on the analytics page —
  no separate Dashboard widget.
- **Latency** — p50/p95/p99 per provider/model, plus TTFT distribution —
  useful for deciding which provider to default new agents to.
- **Throughput** — output tokens/sec per provider/model, a genuine
  input into "is this local Ollama model too slow for interactive use."
- **Error/retry rate** — per provider, split by transient (429/503/timeout,
  caught by `safety.ts`'s `isTransientError`) vs. permanent, surfaced
  per-provider so a flaky provider is visible before a user reports it.
- **Reasoning token usage** — for thinking-enabled models, how much of the
  token budget goes to reasoning vs. final output.
- **Tool execution stats** — per-tool duration and failure rate across all
  agent roles — e.g., is `run_shell` timing out disproportionately on one
  project.
- **Cost trend over time** with the §5.2 cutover marker baked in — but not
  uniformly: PM-turn totals before the migration date get a "may undercount
  tool-heavy turns" flag (real but imprecise data exists); sub-agent-turn
  cost before telemetry lands has **no historical data at all** and should
  be shown as absent/blank for that period, not estimated. Don't conflate
  the two — sub-agent work is most of AgentDesk's actual spend, so a chart
  that quietly shows "$0" pre-telemetry for that segment would be
  misleading in the opposite direction (looks like zero cost, not
  untracked cost).

This replaces `prompt-logger.ts`'s settings view rather than living
alongside it — once the tracing-channel sink exists, keep the file-based
prompt logger only for its original purpose (raw prompt-content debugging,
still opt-in/dev-only) and stop extending its regex-parsed stats path.

### 9.2 Streaming performance indicator (tokens/sec, time-to-first-token)

v7's per-step performance stats feed directly into the existing
`onContextUsage` callback path already wired to the chat UI's context-usage
indicator — a small, low-risk addition once telemetry is wired up (Phase
3.1), giving users the kind of live throughput feedback Claude Code's own
TUI shows, right in the AgentDesk chat window.

### 9.3 Native tool-approval UI, generalized beyond shell commands

**Dropped 2026-07-15** — §6.2 (Phase 3.4)'s evaluation concluded
`toolApproval` doesn't compose cleanly with the existing approval-modal
wiring (it's a stop-and-resume-via-new-call mechanism, not a drop-in for the
in-band `await` AgentDesk's shell gate already uses), so there's no native
approval-event stream to feed a UI or the analytics page. `git_push`/`git_pr`
generalization and file-delete gating remain un-scoped, unrelated future
work, not a consequence of this migration.

### 9.4 Provider health / status page

New, using the same telemetry sink as §9.1: per-provider uptime and
error-rate trend over time, built from the error/retry-rate data telemetry
already captures. AgentDesk already has provider fallback logic
(`createProviderAdapterWithFallback()`) — this page makes visible *when* and
*why* a fallback triggered, instead of that being invisible unless a user
happens to notice a model switch.

### 9.5 Voice/TTS synergy

Correction from a prior-session memory note: that memory (`voice-input-whisper.md`)
described only a `demo/voice-input` Whisper prototype, but per direct
confirmation, AgentDesk **already ships** a Web-Speech-API-based voice-input
field on chat inputs across the app — this is live, not a prototype. That
existing feature is speech-to-text via the browser's built-in Web Speech
API, so it's independent of any AI SDK provider and unaffected by this
migration either way.

What v7 actually adds on top: a stable `generateSpeech` API for a "read
summary aloud" TTS option on PM completion summaries (output side — nothing
comparable exists today) and a stable `transcribe` API as a possible
higher-quality fallback for contexts where Web Speech API isn't available or
reliable (and separately, as a fallback path for `read_audio` when the
target model doesn't support native audio input). Scope this as two small,
independent additions rather than a replacement of the existing Web Speech
input — verify current Web Speech coverage across all chat surfaces (in-app,
Quick Chat, Dashboard, etc.) before deciding whether `transcribe` is worth
adding as a fallback anywhere.

---

## 10. Things Upstream Improved/Fixed That We Should Incorporate

- **Structured-output JSON repair** — even though AgentDesk deliberately
  avoids `generateObject` for portability (§2.2), the underlying JSON-repair
  improvements in v7 could reduce reliance on `deep-research.ts`'s and
  `freelance-wizard.ts`'s defensive `extractJsonFromText()` bracket-balancing
  parser as a *fallback*, without changing the core "ask for strict JSON,
  parse defensively" strategy. Low priority, not urgent.
- **Consistent lifecycle callback naming** (`onStart`/`onEnd`/
  `onStepStart`/`onStepEnd`/`onToolExecutionStart`/`onToolExecutionEnd`) —
  once adopted (§5.6), this gives every one of the 9+ independent surfaces a
  uniform hook shape, making the eventual telemetry/logging unification
  (§6.3) easier to apply consistently across all of them.
- **Per-step performance stats** — see §9.2, direct UI feature opportunity.

---

## 11. Decision Log (2026-07-14)

The five items originally raised as open questions are now resolved. Keeping
the record here so a future reader understands *why* the plan looks the way
it does, not just what it says.

1. **`zhipu-ai-provider` blocker (§5.4)** — **resolved: replace with an
   in-house `@ai-sdk/openai-compatible` adapter.** Landed in Phase 2.7, not
   gating the branch cut on upstream.
2. **Usage-semantics flip (§5.2)** — **resolved: correct historical numbers
   where feasible.** One important constraint discovered while updating this
   doc, surfaced here for visibility rather than buried in a table cell:
   AgentDesk only ever persisted the *final aggregate* `usage` per turn
   (`messages.metadata`), never per-step usage, and `prompt-logger.ts` logs
   outgoing prompts only, not response usage. There is no stored data to
   retroactively recompute a corrected historical total from — the
   undercounting (if confirmed) isn't reversible after the fact without
   re-running the original conversations against the original models, which
   isn't practical. The feasible version of "correct": a cutover marker on
   any cumulative cost view (§9.1, §5.2) rather than a silent, potentially
   misleading continuous chart. If exact historical correction turns out to
   matter more than this document assumes (e.g. for a billing dispute or
   audit), flag that explicitly — it would need a different approach than
   anything in this plan.
   >
   > **Verified against the dev DB on 2026-07-14 (Phase 0.3), and the
   > picture is more specific than the theory above:**
   > - `engine.ts:1136` — `const usage = await result.usage;` — is exactly
   >   the code path the v6→v7 semantics flip affects, read once after the
   >   whole `stopWhen:[stepCountIs(100)]` PM turn completes, persisted into
   >   `messages.metadata.promptTokens/completionTokens`. Confirmed present
   >   and real, at that exact line — this part of the original theory holds.
   > - But: a direct query of the dev DB found **zero PM messages with any
   >   associated `tool_call` message_parts** — every PM message in this
   >   local dataset with populated `metadata` was a single-step, no-tool
   >   turn (e.g. a plain "hi" greeting). So the undercounting risk is
   >   code-confirmed but not yet empirically observed locally — it would
   >   show up on heavier, longer-running PM conversations (production data,
   >   not this lightly-used dev instance).
   > - **Bigger, separate finding**: sub-agent messages (`agent-loop.ts`,
   >   `runInlineAgent`) don't persist real API usage into `messages.metadata`
   >   at all — `metadata` is `NULL` on every sub-agent completion message
   >   checked (including ones with 50-79 tool calls), and `token_count` is
   >   an explicit **content-length heuristic** (`Math.ceil(text.length/4)`,
   >   the code's own comment at `agent-loop.ts:1765`/`1860` says outright
   >   *"reflects content size for context indicator, not total API usage"*).
   >   Real per-step usage *is* tracked in memory
   >   (`lastPromptTokens`/`completionTokens`, accumulated across
   >   `onStepFinish` with a final `result.usage.outputTokens` cross-check at
   >   line 1730) but only flows into `onAgentComplete`/handoff-summary
   >   token counts — never into a durable per-message cost record. **This
   >   means sub-agent work — the majority of AgentDesk's actual token spend
   >   — currently has no queryable historical cost trail at the message
   >   level, independent of the v6→v7 migration.** Telemetry adoption
   >   (§6.3/Phase 3.1) doesn't just fix the PM's final-step-only gap, it's
   >   the first real cost visibility sub-agent turns will ever have. Update
   >   §9.1's cutover-marker copy accordingly: pre-telemetry sub-agent cost
   >   data isn't "approximate," it's **absent**, which is a stronger
   >   statement to put in front of users than "may undercount."
3. **`ai-tool-set` package (§7.2)** — **resolved: build in-house**, avoiding
   a second third-party AI-SDK-adjacent dependency needing its own
   v7-compatibility tracking (the exact problem `zhipu-ai-provider` just
   caused). Landed in Phase 2.8.
4. **Scope of Phase 4 (now Phase 3/4)** — **resolved: everything in scope
   now**, folded into this same initiative rather than deferred to separate
   later PRs. §4's phase plan reflects this: Phase 3 sequences all of §6's
   feature-adoption items (telemetry → runtime context → unified reasoning →
   tool approval → timeouts → uploadFile → HarnessAgent spike) immediately
   after the core migration typechecks clean; Phase 4 builds the new UI
   (§9) on top of Phase 3's telemetry once it has real data. Timeout rework
   (Phase 3.5) and the HarnessAgent spike (Phase 3.7) are still explicitly
   allowed to run longer or conclude "not yet" — "in scope now" means
   planned and started in this initiative, not that every item is
   guaranteed to ship in a first pass regardless of what validation finds.
5. **HarnessAgent (§6.8)** — **resolved: schedule a prototype spike now**
   (Phase 3.7), strictly scoped as evaluation against the Claude Subscription
   two-path branching, not a production switch. Whatever it finds gets
   logged in `claude-subscription-architecture.md`.

---

## 12. Codebase Changes Since This Doc Was Written (2026-07-15)

Two feature commits (`81c48f5` "model capabilities cache and classification",
`bddfb5a` "media tool support for inline rendering") landed on `main` after
this document's original codebase sweep (§2, Appendix A). Both are unrelated
in *purpose* to the AI SDK migration — they implement
[`docs/model-type-badges-plan.md`](./model-type-badges-plan.md) and
[`docs/text-to-image-chat-support-plan.md`](./text-to-image-chat-support-plan.md)
— but `bddfb5a` adds real new AI-SDK-touching surface that the original
sweep couldn't have seen. Verified directly against the current `main` on
2026-07-15 (not from the plan docs' own claims, which were written mid-way
through the now-reverted v7 experiment and are stale on that point — see
below).

### 12.1 `model-classification.ts` (from `81c48f5`) — no migration impact

Confirmed via direct grep: zero imports from `ai` or `@ai-sdk/*`. It's pure
`fetch()` against two external catalogs (Vercel AI Gateway, models.dev). Not
part of the migration surface. The new `model_capabilities_cache` DB table
(migration v58) is likewise unrelated to AI SDK version.

### 12.2 `image-generation.ts` (from `bddfb5a`) — new AI-SDK call site, one correction to §5.9

New shared helper (`src/bun/providers/image-generation.ts`), imported by
`openai.ts`, `ollama.ts`, `openrouter.ts`, `opencode.ts`, and `zai.ts`.
`generateImageOpenAICompatible()` calls **`generateImage`** (imported
directly from `"ai"`, alongside `APICallError`) — the stable v7 name, not
`experimental_generateImage`. Two raw-fetch strategies
(`generateImageNvidia`, `generateImageMistral`) have no AI SDK dependency at
all (plain `fetch`).

**Correction to §5.9's table row**: that row said "None used — grep
confirmed zero hits for `experimental_customProvider`/
`experimental_generateImage`/..." — no longer accurate for
`experimental_generateImage`'s stable counterpart specifically. Verified
directly: **the currently-installed `ai@6.0.158` already exports the stable
`generateImage` name** (confirmed via `node_modules/ai`'s type
declarations), and `image-generation.ts` already uses it, not the
`experimental_` prefix. Practical effect: **this is a non-event for the real
v7 upgrade** — no rename needed here when Phase 1's codemod runs, since the
code is already on the post-graduation name. Worth noting only so a future
reader isn't confused by §5.9 saying "none used" when a real, working
`generateImage()` call site now exists.

### 12.3 `image-gen.ts` (the `generate_image` tool) — extends the §5.5 highest-risk item

New tool file (`src/bun/agents/tools/image-gen.ts`) follows the exact
`tool()` + Zod `inputSchema` + `toModelOutput` pattern documented in §2.2/§8.4
for `screenshot.ts`/`audio.ts` — confirmed via direct read, not assumed.
Concretely, this is a **third name added to the media-content-part shim**:

- `media-followup.ts`'s `IMAGE_TOOL_NAMES` set is now
  `["read_image", "take_screenshot", "generate_image"]` (was two names when
  this doc's original sweep ran).
- `agent-loop.ts`'s truncation allowlist (`isImageTool` check, giving
  media-tool output a 500,000-char limit instead of the default 10,000) now
  also matches `generate_image`.
- **New**: `engine.ts` (the PM's own loop) gained a parallel `MEDIA_TOOLS`
  set (`generate_image`, `read_image`, `read_audio`) with its own
  `message_parts` persistence logic — in *both* the CLI-path branch (§8a,
  `onToolCallStart`/`onToolCallEnd` callbacks) and the normal `streamText`
  branch (§8b, step-processing loop) — so the PM's own direct media-tool
  calls render inline in the main chat, not just sub-agent calls routed
  through `agent-loop.ts`. **This corrects §11.2's verified finding**: that
  finding stated "zero PM messages have any associated `tool_call`
  message_parts" in the dev DB — true when checked (2026-07-14), but
  `bddfb5a` (2026-07-15) adds the *first* code path where the PM directly
  writes `tool_call` message_parts, specifically and only for these three
  media tools. Doesn't change the `result.usage`/final-step-only finding
  (unrelated code path, no usage data involved), but **it does mean §5.5's
  media-content-part canonicalization work now touches `engine.ts` too**,
  not just `agent-loop.ts`/`media-followup.ts` — add it explicitly to the
  Phase 2.2 hand-migration list (done in the tasks file).
- **Dashboard chat widgets** (`dashboard.ts`, `dashboard-agent.ts`, part of
  the "9 independent surfaces" in §2.2) now also register `generate_image`
  (reusing `imageGenTools.generate_image.tool`) and broadcast new events
  (`dashboardPMToolResult`, `dashboardAgentToolResult`) built on
  `extractImagePayload()` from `screenshot.ts` — another two spots that now
  depend on the media tool-output shape and need re-verification once §5.5
  is migrated.

### 12.4 `zai.ts` gained a `generateImage()` method — relevant to the §5.4/§11.1 replacement plan

`zai.ts`'s new `generateImage()` builds "a throwaway openai-compatible
instance just for this call" via `generateImageOpenAICompatible()` — meaning
`zai.ts` **already contains working `@ai-sdk/openai-compatible`-based code**
for its image path, even though chat generation still goes through the
third-party `zhipu-ai-provider` package. This doesn't change the §5.4/§11.1
decision (still: replace `zhipu-ai-provider` with an in-house
`@ai-sdk/openai-compatible` adapter, Phase 2.7) — if anything it **de-risks
it slightly**, since the pattern is already proven working for this exact
provider on one code path; Phase 2.7 is "extend this same approach to chat,"
not "prove it works from scratch."

`google.ts`, `deepseek.ts`, `groq.ts`, `xai.ts`, `anthropic.ts`, and
`claude-subscription.ts` were **not** touched by `bddfb5a` — no
`generateImage()` was added to those adapters (matches
`text-to-image-chat-support-plan.md`'s own live-tested finding that those
providers aren't confirmed image-capable). No new migration surface there.

### 12.5 Net effect on the migration plan

No phase numbering changes — these are additions *within* already-planned
phases, not new phases:

- Phase 2.2 (`media-followup.ts` rebuild) now explicitly includes
  `image-gen.ts`'s `toModelOutput` and `engine.ts`'s new `MEDIA_TOOLS`
  message_parts logic, not just `screenshot.ts`/`audio.ts`.
- Phase 2.7 (`zai.ts` rebuild) is marginally lower-risk than originally
  scoped — half the file already proves the target pattern works.
- §8.4 (multimodal smoke testing) needs `generate_image` added to its
  round-trip test list, on both the main chat and the Dashboard widgets, and
  specifically testing the failure path (per
  `text-to-image-chat-support-plan.md`'s own finding that most
  image-capable candidates fail with billing/entitlement errors in
  practice — confirm those failures still surface as readable tool-result
  errors post-migration, not crashes).
- No new provider adapters, no new breaking-change categories, no change to
  the Decision Log (§11) resolutions themselves.

---

## Appendix A: Full File Inventory (from codebase analysis, 2026-07-14)

For the complete ~62-file, line-numbered breakdown this document is built
from (every `tool()`/`streamText`/`generateText` call site, provider adapter
matrix, message/DB schema detail, and error-handling inventory), see the
research notes — regenerate via the same codebase sweep if this document goes
stale. Key files to re-check first if re-running the sweep:

- `src/bun/agents/engine.ts`, `src/bun/agents/agent-loop.ts` (core loops)
- `src/bun/agents/engine-types.ts` (shared helpers)
- `src/bun/agents/tools/media-followup.ts`, `screenshot.ts`, `audio.ts`
  (multimodal shim)
- `src/bun/providers/*.ts` (12 adapters)
- `src/bun/providers/claude-subscription.ts`,
  `claude-subscription-cli-runner.ts` (two-path provider)
- `src/bun/agents/safety.ts` (error/retry helpers)
- `src/bun/mcp/client.ts` (dynamic tool bridge)

## Appendix B: Command Reference

```bash
# Dependency bump
bun add ai@7 @ai-sdk/anthropic@latest @ai-sdk/openai@latest \
  @ai-sdk/openai-compatible@latest @ai-sdk/google@latest \
  @ai-sdk/deepseek@latest @ai-sdk/groq@latest @ai-sdk/xai@latest

# Automated codemods (run from repo root)
npx @ai-sdk/codemod v7

# Or target a specific codemod
npx @ai-sdk/codemod <codemod-name> <path>

# Agent-assisted migration skill (alternative/supplement to manual Phase 2)
npx skills add vercel/ai --skill migrate-ai-sdk-v6-to-v7

# Validation gates
bun run typecheck
bun run lint
bun test
```
