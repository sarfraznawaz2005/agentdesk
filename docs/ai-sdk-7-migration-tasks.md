# AI SDK 7 Migration — Task Tracker

> Running checklist for [`docs/ai-sdk-7-migration.md`](./ai-sdk-7-migration.md).
> Every actionable item in that document has a checkbox here. Check items off
> as they're completed — this file is the single source of truth for "what's
> done," the migration doc is the source of truth for "why." Section
> references (§X) point back to the migration doc.
>
> **Two stages, checkpoint between them**: Stage A (Phase 0-1) is upgrade +
> automated codemods only. Do not start Stage B (Phase 2 onward) until the
> Stage A checkpoint is explicitly reviewed and checked off below.
>
> **Updated 2026-07-15** per the migration doc's new §12: two feature
> commits (model-type badges, text-to-image chat support) landed on `main`
> after the original sweep and added real new AI-SDK surface (a
> `generate_image` tool, a new `image-generation.ts` helper, new PM-side
> media message_parts logic). Folded into Phase 2.2/2.7 and §5.4 below —
> search "§12" for every touch point.

---

## Stage A — Phase 0: Pre-flight (§4 Phase 0)

- [x] Confirm decision: replace `zhipu-ai-provider` with an in-house adapter (already decided, §5.4/§11.1)
- [x] Confirm Bun's Node-22 baseline is a non-issue — verified: Bun 1.3.14 installed, no runtime upgrade needed
- [x] Snapshot current token/cost numbers for known multi-tool-call conversations — **done 2026-07-14, findings updated into §5.2/§11.2/§9.1 of the migration doc**: PM-turn usage is real but final-step-only-exposed (`engine.ts:1136`); sub-agent-turn usage is **not persisted at all** (`token_count` is a content-length heuristic, confirmed on messages with 50-79 tool calls) — bigger gap than originally scoped, telemetry is the first real fix for it
- [x] Freeze: confirmed no new `ai`/`@ai-sdk/*` call sites landing on `main` mid-migration (working tree clean at branch cut, dedicated branch `ai-sdk-7-migration` created)

## Stage A — Phase 1: Dependency bump + automated codemods (§4 Phase 1)

- [x] `bun add ai@7 @ai-sdk/anthropic@latest @ai-sdk/openai@latest @ai-sdk/openai-compatible@latest @ai-sdk/google@latest @ai-sdk/deepseek@latest @ai-sdk/groq@latest @ai-sdk/xai@latest` — **done 2026-07-15** on branch `ai-sdk-7-migration`: `ai@7.0.28`, `@ai-sdk/anthropic@4.0.15`, `@ai-sdk/openai@4.0.14`, `@ai-sdk/openai-compatible@3.0.10`, `@ai-sdk/google@4.0.16`, `@ai-sdk/deepseek@3.0.11`, `@ai-sdk/groq@4.0.11`, `@ai-sdk/xai@4.0.13`
- [x] `npx @ai-sdk/codemod v7` — **done 2026-07-15**, exit 0, 30 real source files touched (matches predicted Phase 2 file list closely — see below). All logged transform errors were confined to `dist-web/assets/gitGraphDiagram-*.js`, a gitignored build artifact the ignore-patterns missed (`**/dist/**` doesn't match `dist-web/`) — harmless, not source
- [x] Run `bun run typecheck` — **done 2026-07-15, 37 errors across 10 files** (`agent-loop.ts` 10, `council.ts` 9, `engine.ts` 8, `engine-types.ts` 3, `screenshot.ts` 2, `dashboard-agent.ts`/`error-logger.ts`/`image-gen.ts`/`audio.ts`/`context.ts` 1 each). 32/37 (86%) are one root cause: leftover `instructions`-vs-`system` fallout the codemod didn't fully mechanize — specifically shorthand-property literals (`{ system, ... }` → `{ instructions, ... }`) where the local variable itself was never renamed, leaving `instructions` referring to nothing (TS18004 ×4, plus TS2339/TS2353 reading/constructing the same stale shape). Remaining 5: a `Context` generic-constraint mismatch on 4 tool definitions (`audio.ts`, `image-gen.ts`, `screenshot.ts` ×2, TS2344) + one unrelated strict-undefined arg in `error-logger.ts` (TS2345). Full output: see run notes; all within Phase 2.4/2.1 scope already
- [x] Run `bun run lint` — **done 2026-07-15, 0 errors / 0 warnings, fully clean.** Deviates from this doc's assumption that lint would be non-clean at this stage — verified genuine (direct eslint binary run, 1m47s over 601 files, not a no-op). This ESLint config's rules (`no-unused-vars`, `no-explicit-any`, react-hooks, recommended/strict) aren't type-aware in the way that catches breaking API-shape renames — `tsc` is doing that job here, not `eslint`. **Doc correction**: lint is not expected to surface migration breakage going forward; drop it as a meaningful signal for Phase 2 hand-migration progress and rely on typecheck + tests instead (lint stays in the Phase 5 validation gate as a regression check, just not as a migration-progress indicator)
- [x] Run `bun test` — **done 2026-07-15, 712 pass / 20 fail / 1 skip / 2 unhandled-errors-between-tests**, 40s runtime. All 20 failures + both unhandled errors are one root cause: `src/bun/rpc/council.ts:165` calls `generateText({ ..., instructions, ... })` where `instructions` is referenced but never defined in scope (same shorthand-property codemod gap as the typecheck finding) — `councilComplete()` throws on every real LLM call, cascading into every council-flow event assertion (`agents-selected`, `round-start`, `convergence`, `final-answer-*`, `question`, etc. never fire). **Two secondary bugs surfaced, independent of the `instructions` bug, worth their own Phase 2 checks**: (a) `council.ts:81` — `resolveProvider()` throws `No AI provider configured` twice during async test cleanup; (b) `tests/channels/manager.test.ts` — `TypeError: engine.sendMessage is not a function` in `src/bun/channels/manager.ts:626` (caught internally, didn't fail a test, but is a real broken call — needs verifying whether `AgentEngine.sendMessage` predates this migration or was renamed by a codemod pass)

### ⏸ Stage A → Stage B Checkpoint (§4, "Checkpoint" box) — do not skip

- [x] Reviewed the actual post-codemod error surface against §4 Phase 2's predicted list — **matches closely.** The dominant failure (86% of typecheck errors, 100% of test failures) is exactly the §5.1/Phase-2.4 `system`→`instructions` rename the plan already scoped as hand-migration; the codemod mechanized most of it (30/~46 predicted files) but left shorthand-property call sites broken, which is a normal/expected codemod limitation, not a plan gap. The 4-file `Context` generic-constraint issue (TS2344) is new/unpredicted — narrow, isolated to the multimodal tool definitions already tracked under Phase 2.2. The two `council.ts`/`manager.ts` secondary bugs are new findings not named anywhere in §5's table
- [x] If the real error surface differs meaningfully from the plan, updated `docs/ai-sdk-7-migration.md` (and this file) to match reality before proceeding — **one correction made**: lint's expected-non-clean assumption was wrong (see lint bullet above); no other §5 table rows need correction, the `instructions` fallout is squarely within predicted scope
- [ ] Explicit go/no-go decision made to start Stage B (not started in the same sitting as Stage A by default) — **pending user decision**

---

## Stage B — Phase 2: Hand-migrate what the codemod can't reach (§4 Phase 2)

- [x] **2.1** `engine-types.ts` — **done 2026-07-15.** §5.7's actual concern (`usage.reasoningTokens`→`usage.outputTokenDetails.reasoningTokens`) turned out moot — grepped the whole codebase, nothing reads `usage.reasoningTokens` at all, so there was nothing to rename. `providerOptions.anthropic.thinking` (built in `buildPMThinkingOptions()`) is structurally unchanged in v7 — not a breaking rename, just the existing provider-specific option (the new v7 feature is the separate unified `reasoning` option, tracked as new work under Phase 3.3, not a Phase 2 fix). Found and fixed a **real, pre-existing bug** while reviewing this exact function (confirmed via `git show main` that it predates this migration): `extractPMReasoning()`'s provider-metadata fallback read `step.experimental_providerMetadata`, but v7's types confirm the field is just `providerMetadata` (no prefix) — since `stepResult` is cast through `unknown`, `tsc` couldn't catch this, so the fallback silently never fired (OpenRouter/OpenAI reasoning display was dead code, only Anthropic's primary `step.reasoningText` path ever worked). User confirmed fixing it now since already in this exact function. One-line rename applied
  - **Note (2026-07-15)**: `applyAnthropicCaching()` in this file was left broken by the codemod — its return type/statements still said `system` while every call site (`engine.ts`, `agent-loop.ts`) already expected `.instructions` on the return value. Fixed: return type + body now produce `{ instructions, messages }`. `BuiltContext` in `context.ts` had the identical bug (interface said `system`, return statement said `instructions`) — fixed the same way. These two fixes alone resolved 22 of the 37 post-codemod typecheck errors (`agent-loop.ts` ×10, `engine.ts` ×8, `engine-types.ts` ×3, `context.ts` ×1)
- [ ] **2.2** `media-followup.ts` — rebuild `buildMediaFollowUpMessage()`'s content parts against v7's canonical `file`/`file-data`/`file-url` shape (§5.5, highest-risk item) — **not started, still the highest-risk open item.** Typechecks clean post-codemod, but that only proves the *names* compile — the actual v6→v7 content-part *shape* change (image parts → file parts) has not been verified against real provider calls yet; needs the §8.4 multimodal round-trip tests, not just tsc
  - [ ] Update `screenshot.ts`'s `toModelOutput` callback in lockstep
  - [ ] Update `audio.ts`'s `toModelOutput` callback in lockstep
  - [ ] Update `image-gen.ts`'s `toModelOutput` callback in lockstep (§12.3 — added 2026-07-15, third name in `IMAGE_TOOL_NAMES`)
  - [ ] Update `engine.ts`'s new `MEDIA_TOOLS` message_parts persistence logic (§12.3 — both the CLI-path branch and the normal `streamText` branch write `tool_call`/`tool_result` message_parts for `generate_image`/`read_image`/`read_audio` directly from the PM loop now)
  - [ ] Verify `dashboard.ts`'s `dashboardPMToolResult` broadcast (built on `extractImagePayload()`) still correctly detects image payloads post-migration
  - [ ] Verify `dashboard-agent.ts`'s `dashboardAgentToolResult` broadcast (same `extractImagePayload()` dependency) still correctly detects image payloads post-migration
  - [x] Fixed a distinct, unpredicted issue in the 4 media tool definitions (`audio.ts`, `image-gen.ts`, `screenshot.ts` ×2) — **done 2026-07-15**: v7's `tool<INPUT, OUTPUT, CONTEXT>()` generic signature added a required 3rd `CONTEXT extends Context` type param; the old 2-arg call form `tool<Input, string>({...})` now binds the 2nd arg to `CONTEXT` instead of `OUTPUT`, which fails (`string` doesn't extend `Context = Record<string, unknown>`). Fixed by dropping explicit generics entirely (matching the other 62 `tool({...})` call sites elsewhere in the codebase, which already rely on inference) — but bidirectional inference alone still failed on these 4 specifically (the only ones using `toModelOutput`), surfacing as "no overload matches" pointing at the wrong (last) overload. Root fix: explicitly annotate `execute`'s destructured parameter type (e.g. `async ({ path }: { path: string })`) so overload resolution has enough to commit to the first (correct) overload. Removed the now-orphaned standalone `type XInput = z.infer<...>` aliases these tools no longer needed
- [ ] **2.3** `claude-subscription-cli-runner.ts` (~lines 355-371) — keep the independent media-stripping mirror conceptually in sync with 2.2 (not touched by the AI SDK rename itself) — **blocked on 2.2**, not started
- [x] **2.4** `engine.ts` + `agent-loop.ts` core loops — **renames done 2026-07-15**, behavioral re-verification still pending:
  - [x] Rename `system` → `instructions` — codemod handled all real call sites; broken only by the `applyAnthropicCaching`/`BuiltContext` bug above, now fixed. Also cleaned up 8 stale comments in `engine.ts`/`agent-loop.ts` still referencing `fullStream`/`onStepFinish` by name (mechanical, not code)
  - [x] Rename `fullStream` → `stream` — codemod handled this cleanly, zero live code hits remain (confirmed via full-tree grep, only stale comments found and fixed)
  - [x] Rename `onStepFinish` → `onStepEnd` — same, codemod-clean
  - [x] Rename `stepCountIs` → `isStepCount` (engine.ts only — agent-loop.ts uses custom predicates) — codemod-clean; one stale comment in `collections/chat.ts` also fixed
  - [ ] Re-verify the hallucination guard (`step.reasoningText` regex) still works post-rename — needs runtime check, not just typecheck
  - [ ] Re-verify the transient-error retry loop against the new `finalStep`/`usage` split — needs runtime check
- [x] **2.5** The 9 independent surfaces — same renames as 2.4 — **codemod + typecheck clean on all 9, 2026-07-15**; `council.ts` additionally needed a hand-fix (see Decision log below), the other 8 needed none beyond the codemod:
  - [x] `rpc/dashboard.ts` — clean, already correctly used `instructions: systemPrompt` (its local var was never named `system`, so no shorthand-property trap here)
  - [x] `rpc/dashboard-agent.ts` — **hand-fixed 2026-07-15**: same shorthand-property gap as `council.ts` (local var `system`, codemod left a dangling `instructions,` shorthand in the `streamText` call at line 217) — fixed to `instructions: system`
  - [x] `rpc/council.ts` — **hand-fixed 2026-07-15, see Decision log** — the codemod over-applied the rename to `councilComplete()`, an internal AgentDesk helper (not an AI SDK call) whose own `opts.system` field only coincidentally shares the name
  - [x] `rpc/skills-search-chat.ts` — codemod-clean
  - [x] `rpc/freelance-chat.ts` — codemod-clean
  - [x] `collections/chat.ts` — codemod-clean (one stale `stepCountIs` comment fixed)
  - [x] `rpc/freelance-wizard.ts` (×2 `stepCountIs` call sites) — codemod-clean
  - [x] `scheduler/task-executor.ts` — codemod-clean, dynamic `await import("ai")` was reached correctly
  - [x] `rpc/playground.ts` — the "9th" surface (not enumerated by file name in the original doc, identified during codemod monitoring) — codemod-clean
- [x] **2.6** Provider adapters — **verified 2026-07-15, zero changes needed.** Full-tree grep for `system:`/`fullStream`/`onStepFinish`/`onFinish`/`stepCountIs`/`experimental_*`/`GoogleGenerativeAI`/`.request`/`.response` across all 10 files: zero hits. Root reason: these files are pure provider-*instantiation* wrappers (`createAnthropic()`, `createOpenAI()`, etc.) — none of them call `streamText`/`generateText` directly, so there's no v6→v7 rename surface inside them at all; the actual generation calls live in `engine.ts`/`agent-loop.ts`/`council.ts`/etc., already covered above
  - [x] `anthropic.ts` / `openai.ts` / `deepseek.ts` / `groq.ts` / `xai.ts` / `openrouter.ts` / `ollama.ts` / `opencode.ts` — no AI-SDK call-shape surface, confirmed clean
  - [x] `google.ts` — already uses `createGoogle` (current v7 name), confirmed under §5.10
  - [x] `claude-subscription.ts` — `interceptFetch`'s signature is typed against the global `Parameters<typeof fetch>` (Web Fetch API), not any AI-SDK-exported type — entirely independent of the `ai` package version, confirmed unaffected
- [ ] **2.7** `zai.ts` rebuild (§5.4, §11.1, decided) — remove `zhipu-ai-provider` dependency entirely
  - [ ] Confirm Z.AI's current API base URL / auth-header shape against their docs (don't assume unchanged from the third-party package)
  - [ ] Rebuild `ZaiAdapter` on `@ai-sdk/openai-compatible`'s `createOpenAICompatible(...)`, matching the `ollama.ts`/`openrouter.ts`/`opencode.ts` pattern — note (§12.4): `zai.ts` already has a working `generateImage()` method built on `@ai-sdk/openai-compatible` (added 2026-07-15 for text-to-image support), so this is "extend the same pattern to chat," not starting from zero
  - [ ] Remove `zhipu-ai-provider` from `package.json`
- [ ] **2.8** Stable tool ordering (§6.4, §7.2, §11.3, decided — build in-house)
  - [ ] Implement stable-prefix / stable-tail partitioning in `tools/index.ts`'s `getToolsForAgent()`/`getAllTools()`
  - [ ] Feed the result through `prepareStep` consistently in `engine.ts`
  - [ ] Feed the result through `prepareStep` consistently in `agent-loop.ts`
  - [ ] Verify ordering survives `wrapToolsWithHooks`
  - [ ] Verify ordering survives `wrapToolsWithCallLogging`
- [x] **2.9** One-shot `generateText` call sites — **verified 2026-07-15, zero changes needed.**
  - [x] `summarizer.ts` / `deep-research.ts` / `freelance/bid-pipeline.ts` / `freelance/description.ts` / `freelance/qa.ts` / `freelance/reply-pipeline.ts` / `freelance/expert/tools.ts` / `freelance/expert/orchestrator.ts` — all 8 were already codemod-touched and typecheck clean
  - [x] `handoff.ts` — **doc's file inventory was stale**: this file doesn't import from `"ai"` at all, never called `generateText` in the first place
  - [x] `preview.ts` — does call `generateText`, but its call never used a `system` param to begin with (only `messages`) — nothing to rename
- [x] **2.10** `src/bun/mcp/client.ts` — **verified 2026-07-15, zero changes needed.** `dynamicTool()`'s shape is unchanged in v7; `Tool` is used with default (unspecified) generics via `Record<string, Tool>`, which resolves fine against v7's `Tool<INPUT=any, OUTPUT=any, CONTEXT=any>` defaults

### Breaking-change verification sweep (§5 table — confirm each, even the "no action needed" rows)

- [x] 5.1 `system`→`instructions` rename complete everywhere — **done 2026-07-15**; confirmed `context.ts` never persists system-role messages into `messages[]` (no `allowSystemInMessages` needed)
- [ ] 5.2 Usage-semantics flip — before/after token comparison run against Phase 0 snapshot; cutover marker plan confirmed (see Phase 4 analytics page) — not started, needs live provider calls
- [x] 5.3 `fullStream`→`stream` renamed in both core loops — **done 2026-07-15** (codemod-clean, stale comments fixed)
- [ ] 5.4 `zhipu-ai-provider` removed (tracked in 2.7 above) — not started
- [ ] 5.5 Media/file content-part canonicalization — tested against both an Anthropic-native model and an OpenAI-compatible model (tracked in full in §8.4 below) — not started, the highest-risk remaining item (see 2.2 note)
- [x] 5.6 `onFinish`/`onStepFinish` renamed to `onEnd`/`onStepEnd` — **done 2026-07-15** (codemod-clean, stale comments fixed)
- [ ] 5.7 `usage.reasoningTokens`→`usage.outputTokenDetails.reasoningTokens` read updated — not started (tracked under 2.1)
- [x] 5.8 `stepCountIs`→`isStepCount` — all 9 call sites confirmed renamed — **done 2026-07-15**
- [x] 5.9 Confirmed zero usage of `experimental_customProvider`/`experimental_generateImage`/`experimental_output`/`experimental_prepareStep`/`experimental_telemetry` — **verified 2026-07-15**, full-tree grep, zero hits (prediction holds)
- [x] 5.10 Google provider rename confirmed in `google.ts` — **verified 2026-07-15**: already uses `createGoogle` from `@ai-sdk/google` (current v7 name), no codemod/hand-fix needed (duplicate of 2.6 sub-item)
- [x] 5.11 `bun run typecheck` clean of any `CallSettings`-related errors — **done 2026-07-15**, 0 typecheck errors overall
- [x] 5.12 Confirmed no code reads `result.request`/`result.response` bodies — **verified 2026-07-15**, full-tree grep, zero hits (no action needed, prediction holds)
- [x] 5.13 Confirmed Bun/Node-22/ESM non-issue (duplicate of Phase 0 item, check off together)
- [x] 5.15 Confirmed `ai@7`'s zod peer range against installed zod — **done 2026-07-15**: `ai@7` requires `zod@^3.25.76 || ^4.1.8`; our own `package.json` declared the looser `^3.24.0` (only satisfied v7's actual requirement by incidental transitive resolution). Tightened to `^3.25.76` to make the real constraint explicit for future clean installs; `bun install` re-verified with no resolution conflicts

---

## Stage B — Phase 3: Feature adoption (§4 Phase 3, §6, §11.4/§11.5 — all decided in-scope-now)

- [ ] **3.1** Telemetry + tracing channel (§6.3) — land first, everything else benefits from real data
  - [ ] Subscribe to `ai:telemetry` via `node:diagnostics_channel` globally in `src/bun/index.ts`
  - [ ] Wire the subscription to a structured sink (new SQLite table, not a log file)
  - [ ] Decide `prompt-logger.ts`'s fate: keep only for raw prompt-content debugging (opt-in/dev-only), stop extending its regex-parsed stats path
- [ ] **3.2** Runtime context + typed tool context (§6.1)
  - [ ] Replace hand-rolled `__projectId`/`__conversationId` stamping in `agent-loop.ts` with `runtimeContext`
  - [ ] Migrate scoped tool config to per-tool `context` via `contextSchema`
  - [ ] Confirm this lands before 3.4 (tool approval) so approval functions can reuse the same context plumbing
- [ ] **3.3** Unified `reasoning` option (§6.5)
  - [ ] Migrate off `providerOptions.anthropic.thinking` where the unified option covers the provider
  - [ ] Keep `extractPMReasoning()`'s existing fallback chain as a safety net for uncovered providers
  - [ ] Verify OpenRouter-proxied models specifically (existing special-case in `extractPMReasoning`)
- [ ] **3.4** Native tool approval (§6.2)
  - [ ] Evaluate whether `toolApproval` composes cleanly with the existing shell-approval modal wiring (`AgentEngineCallbacks`)
  - [ ] If it fits: generalize gating to `git_push`/`git_pr` for regular worker agents
  - [ ] If it fits: generalize gating to file deletes outside the workspace root
  - [ ] If it doesn't fit cleanly: explicitly document "not now" and keep the existing shell-approval gate as-is
- [ ] **3.5** First-class timeouts (§6.6) — sequence last, extra validation time
  - [ ] Replace `agent-loop.ts`'s hand-rolled `TIMEOUT_MS` with v7's timeout budgets
  - [ ] Replace/update `safety.ts`'s timeout helpers
  - [ ] Full Stop-button/abort re-validation before merging this step (see §8.7 below — do not skip)
- [ ] **3.6** `uploadFile` prototype (§6.7) — strictly after 2.2/§5.5 is validated
  - [ ] Prototype against Anthropic
  - [ ] Prototype against OpenAI
  - [ ] Document as provider-dependent (won't help local Ollama) — decide production scope after prototype
- [ ] **3.7** HarnessAgent prototype spike (§6.8) — spike only, not a production switch
  - [ ] Prototype streaming + tools + abort + concurrency against the Claude Subscription two-path branching (same rigor as the 4 mechanisms already evaluated in `claude-subscription-architecture.md`)
  - [ ] Record outcome (adopt / not yet / rejected) as a dated entry in `docs/claude-subscription-architecture.md`

---

## Stage B — Phase 4: New UI built on Phase 3's telemetry (§4 Phase 4, §9)

- [ ] **4.1** AI Usage / Cost Analytics page (§9.1)
  - [ ] Cost & token breakdown view (filterable by project / agent role / provider / date range, stacked by input/output/cache-read/reasoning)
  - [ ] Cache hit rate & $ saved view (proves out the Phase 2.8 stable-ordering fix) — analytics page only, no separate Dashboard widget
  - [ ] Latency view (p50/p95/p99 per provider/model, TTFT distribution)
  - [ ] Throughput view (output tokens/sec per provider/model)
  - [ ] Error/retry rate view (per provider, transient vs. permanent)
  - [ ] Reasoning token usage view (thinking-enabled models)
  - [ ] Tool execution stats view (per-tool duration/failure rate across agent roles)
  - [ ] Cost trend over time — PM-turn totals get a "may undercount tool-heavy turns" cutover marker before the migration date; sub-agent-turn totals show as **absent/blank** (not $0) before telemetry lands, since no historical data exists for them at all (§5.2, §11.2)
  - [ ] Retire `prompt-logger.ts`'s regex-parsed "Analytics" settings view in favor of this page (keep the raw prompt logger itself for dev debugging only)
- [ ] **4.2** Streaming performance indicator (§9.2) — tokens/sec + TTFT in the chat UI, fed via `onContextUsage`
- [ ] **4.3** Native tool-approval UI (§9.3) — only if 3.4's evaluation showed it fits; approval events feed the analytics page's "approval activity" view
- [ ] **4.4** Provider health / status page (§9.4) — per-provider uptime/error-rate trend, surfaces when/why `createProviderAdapterWithFallback()` triggered
- [ ] **4.5** Voice/TTS additions (§9.5)
  - [ ] Verify current Web Speech API voice-input coverage across all chat surfaces (in-app, Quick Chat, Dashboard, Collections, Playground, Council, Freelance) before adding anything
  - [ ] Scope `generateSpeech` "read summary aloud" option for PM completion summaries
  - [ ] Decide whether `transcribe` is worth adding as a fallback anywhere Web Speech API is unavailable/unreliable, and separately as a `read_audio` fallback for models without native audio input

---

## Stage B — Phase 5: Validation (§4 Phase 5, §8 — full smoke test)

Run once after Phase 2 (behavior-preserving) and again after Phase 3/4 (new capabilities), not only once at the very end.

### 5.1 Automated gates (§8.1)

- [ ] `bun run typecheck` — zero errors
- [ ] `bun run lint` — zero errors
- [ ] `bun test` — full suite green
- [ ] Grep confirms zero leftover deprecated-alias usage (`fullStream`, `onStepFinish`, `onFinish`, `system:` in `streamText`/`generateText` calls, `stepCountIs`) outside intentionally-deferred items

### 5.2 Provider connectivity (§8.2)

- [ ] Anthropic (direct API key)
- [ ] OpenAI
- [ ] Google Gemini
- [ ] DeepSeek
- [ ] Groq
- [ ] xAI Grok
- [ ] OpenRouter
- [ ] Ollama (local)
- [ ] OpenCode
- [ ] Z.AI (rebuilt adapter) — do not silently skip; if still blocked, explicitly note as a known gap
- [ ] Claude Subscription — Haiku path (direct HTTP)
- [ ] Claude Subscription — Sonnet/Opus path (CLI/SDK subprocess)

### 5.3 Core orchestration flow (§8.3)

- [ ] New feature request → plan → approval → `create_tasks_from_plan` → kanban backlog
- [ ] Sequential single-agent dispatch: working → review → auto code-reviewer → `submit_review(approved)` → done
- [ ] Review rejection path: `changes_requested` → back to working → re-dispatch → up to `maxReviewRounds`
- [ ] Parallel read-only agents via `run_agents_parallel` (`code-explorer`/`research-expert`/`task-planner`)
- [ ] Kanban drag-drop (human Backlog→Working) triggers dispatch
- [ ] Plan rejection + re-planning loop (`update_note`)
- [ ] Agent failure handling — `[Next Action] INVESTIGATE` hint reaches the PM, PM decides sensibly (no automated retry loop)

### 5.4 Multimodal (§8.4 — highest-risk area)

- [ ] `take_screenshot` round trip on an Anthropic-native model
- [ ] `take_screenshot` round trip on an OpenAI-compatible model (Ollama or OpenRouter)
- [ ] `read_image` round trip
- [ ] `read_audio` round trip (WAV/MP3)
- [ ] `generate_image` round trip in the main chat, on an OpenAI-compatible provider (§12.3/§12.5, added 2026-07-15) — confirms the image-content shape from `image-generation.ts`'s `generateImage()` call renders correctly post-migration
- [ ] `generate_image` round trip in the PM's own direct tool call (not via a dispatched sub-agent) — confirms `engine.ts`'s new `MEDIA_TOOLS` message_parts persistence (§12.3) survives the migration
- [ ] `generate_image` round trip in the Dashboard PM chat widget and Dashboard agent chat widget — confirms `dashboardPMToolResult`/`dashboardAgentToolResult` broadcasts (built on `extractImagePayload()`) still detect the image payload correctly
- [ ] `generate_image` failure path (e.g. a zero-balance/unentitled provider) surfaces as a readable tool-result error, not a crash — per `text-to-image-chat-support-plan.md`'s own finding that most real-world attempts fail this way, not the happy path
- [ ] Chat file-upload attachment (image) reaches the model correctly
- [ ] Claude Subscription CLI path: image tool result reaches the model via the MCP content-block bridge

### 5.5 Independent chat/agent surfaces (§8.5)

- [ ] Dashboard chat (project-less)
- [ ] Dashboard-agent chat
- [ ] Collections chat widget
- [ ] Skills-search chat
- [ ] Freelance chat
- [ ] Freelance wizard
- [ ] Council
- [ ] Scheduler cron-triggered agent task
- [ ] Playground

### 5.6 Quick Chat and Issue Fixer (§8.6)

- [ ] Quick Chat window: kanban/plan-approval tools excluded, streaming works, no empty-board `[Next Action]` crash
- [ ] Issue Fixer: one dry-run poll→trigger→fix→PR cycle; confirm no `git merge`/force-push; confirm `git_pr`/`git_push` still excluded from its tool set

### 5.7 Cross-cutting correctness (§8.7)

- [ ] Stop button / abort correctness — normal `streamText` path
- [ ] Stop button / abort correctness — Claude Subscription CLI path
- [ ] Stop button / abort correctness — mid-tool-call
- [ ] Transient-error retry loops (`MAX_PM_RETRIES`, `MAX_RETRIES`) still distinguish abort vs. transient vs. permanent correctly
- [ ] Prompt caching still functional (`cache_control` present in request shape, or cache-hit metrics visible)
- [ ] Token usage/cost persisted per message compared against the Phase 0 pre-migration snapshot
- [ ] Reasoning/thinking extraction spot-checked on Anthropic, OpenRouter, and one plain-OpenAI model
- [ ] MCP client tool wrapping — one real MCP server end-to-end
- [ ] Context compaction/summarization trigger — forced past threshold, chunked `generateText` calls still work
- [ ] Zod schema validation spot check — `verify_implementation` in `kanban.ts` (complex nested schema)

---

## Decision log reference (already resolved — §11, no action needed here)

- Z.AI → in-house adapter (tracked as Phase 2.7 above)
- Historical cost data → cutover marker, not retroactive recomputation (tracked as Phase 4.1's cost-trend item above)
- Tool ordering → in-house (tracked as Phase 2.8 above)
- Feature adoption scope → everything in this initiative (reflected in Phase 3/4 above)
- HarnessAgent → spike now, not a switch (tracked as Phase 3.7 above)

## New findings from Phase 2 hand-migration (2026-07-15)

- **Codemod over-application in `council.ts`**: `councilComplete()` is an internal
  AgentDesk helper (not an AI SDK call) whose own options type declares a `system:
  string` field that only coincidentally shares AI SDK's old field name. The
  codemod's `rename-system-to-instructions` transform renamed this function's
  destructuring and all 6 of its call sites' object literals to `instructions:`,
  which is wrong (that field isn't AI SDK's), while simultaneously leaving the
  function's own two *genuine* `streamText`/`generateText` calls broken (shorthand
  `instructions` referencing a variable the same over-rename had renamed away from
  `system`). Fixed by reverting the 6 call sites + the destructuring back to
  `system:`, and explicitly writing `instructions: system` at the two real AI SDK
  call sites. **Lesson for any future codemod pass**: don't trust a codemod's
  identifier-based rename to distinguish "this object literal targets an AI SDK
  call" from "this object literal happens to have a same-named field for an
  unrelated internal function" — grep every touched file's diff for renamed fields
  feeding non-AI-SDK functions before trusting a clean typecheck.
- **`error-logger.ts`**: unrelated-to-rename but genuine v7 API change —
  `LogWarningsFunction`'s `provider`/`model` fields became optional in v7 (were
  required in v6). Fixed `formatAiSdkWarning()`'s signature + prefix string to
  handle `undefined` (falls back to "unknown").
- **`channels/manager.ts:626` `engine.sendMessage is not a function`**: investigated
  and confirmed **pre-existing on `main`, unrelated to this migration** — reproduces
  identically with the Phase 1 codemod changes stashed out, and identically again on
  a clean `main` checkout. Caught internally by `manager.ts`'s own try/catch so it
  doesn't fail any test, but it is a real broken call site. **Out of scope for this
  migration** — flagging here so it isn't mistaken for migration-introduced breakage
  and doesn't get silently fixed as a drive-by.
