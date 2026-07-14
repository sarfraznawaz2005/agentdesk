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

---

## Stage A — Phase 0: Pre-flight (§4 Phase 0)

- [x] Confirm decision: replace `zhipu-ai-provider` with an in-house adapter (already decided, §5.4/§11.1)
- [x] Confirm Bun's Node-22 baseline is a non-issue — verified: Bun 1.3.14 installed, no runtime upgrade needed
- [x] Snapshot current token/cost numbers for known multi-tool-call conversations — **done 2026-07-14, findings updated into §5.2/§11.2/§9.1 of the migration doc**: PM-turn usage is real but final-step-only-exposed (`engine.ts:1136`); sub-agent-turn usage is **not persisted at all** (`token_count` is a content-length heuristic, confirmed on messages with 50-79 tool calls) — bigger gap than originally scoped, telemetry is the first real fix for it
- [x] Freeze: confirmed no new `ai`/`@ai-sdk/*` call sites landing on `main` mid-migration (working tree clean at branch cut, dedicated branch `ai-sdk-7-migration` created)

## Stage A — Phase 1: Dependency bump + automated codemods (§4 Phase 1)

- [ ] `bun add ai@7 @ai-sdk/anthropic@latest @ai-sdk/openai@latest @ai-sdk/openai-compatible@latest @ai-sdk/google@latest @ai-sdk/deepseek@latest @ai-sdk/groq@latest @ai-sdk/xai@latest`
- [ ] `npx @ai-sdk/codemod v7`
- [ ] Run `bun run typecheck` — capture the full error list (expected to be non-clean)
- [ ] Run `bun run lint` — capture the full error list
- [ ] Run `bun test` — capture the full result

### ⏸ Stage A → Stage B Checkpoint (§4, "Checkpoint" box) — do not skip

- [ ] Reviewed the actual post-codemod error surface against §4 Phase 2's predicted list
- [ ] If the real error surface differs meaningfully from the plan, updated `docs/ai-sdk-7-migration.md` (and this file) to match reality before proceeding
- [ ] Explicit go/no-go decision made to start Stage B (not started in the same sitting as Stage A by default)

---

## Stage B — Phase 2: Hand-migrate what the codemod can't reach (§4 Phase 2)

- [ ] **2.1** `engine-types.ts` — update `extractPMReasoning()`'s fallback chain for `outputTokenDetails.reasoningTokens`; verify `providerOptions.anthropic.thinking` still applies correctly (§5.7)
- [ ] **2.2** `media-followup.ts` — rebuild `buildMediaFollowUpMessage()`'s content parts against v7's canonical `file`/`file-data`/`file-url` shape (§5.5, highest-risk item)
  - [ ] Update `screenshot.ts`'s `toModelOutput` callback in lockstep
  - [ ] Update `audio.ts`'s `toModelOutput` callback in lockstep
- [ ] **2.3** `claude-subscription-cli-runner.ts` (~lines 355-371) — keep the independent media-stripping mirror conceptually in sync with 2.2 (not touched by the AI SDK rename itself)
- [ ] **2.4** `engine.ts` + `agent-loop.ts` core loops:
  - [ ] Rename `system` → `instructions`
  - [ ] Rename `fullStream` → `stream`
  - [ ] Rename `onStepFinish` → `onStepEnd`
  - [ ] Rename `stepCountIs` → `isStepCount` (engine.ts only — agent-loop.ts uses custom predicates)
  - [ ] Re-verify the hallucination guard (`step.reasoningText` regex) still works post-rename
  - [ ] Re-verify the transient-error retry loop against the new `finalStep`/`usage` split
- [ ] **2.5** The 9 independent surfaces — same renames as 2.4:
  - [ ] `rpc/dashboard.ts`
  - [ ] `rpc/dashboard-agent.ts`
  - [ ] `rpc/council.ts`
  - [ ] `rpc/skills-search-chat.ts`
  - [ ] `rpc/freelance-chat.ts`
  - [ ] `collections/chat.ts`
  - [ ] `rpc/freelance-wizard.ts` (×2 `stepCountIs` call sites)
  - [ ] `scheduler/task-executor.ts` — dynamic `await import("ai")`, check by hand (codemod may not reach it)
- [ ] **2.6** Provider adapters — mechanical pass on all `src/bun/providers/*.ts`:
  - [ ] `anthropic.ts`
  - [ ] `openai.ts`
  - [ ] `google.ts` — specifically verify `GoogleGenerativeAI` → `Google` rename (§5.10)
  - [ ] `deepseek.ts`
  - [ ] `groq.ts`
  - [ ] `xai.ts`
  - [ ] `openrouter.ts`
  - [ ] `ollama.ts`
  - [ ] `opencode.ts`
  - [ ] `claude-subscription.ts` — verify `interceptFetch`'s wrapped-`fetch` signature is unchanged
- [ ] **2.7** `zai.ts` rebuild (§5.4, §11.1, decided) — remove `zhipu-ai-provider` dependency entirely
  - [ ] Confirm Z.AI's current API base URL / auth-header shape against their docs (don't assume unchanged from the third-party package)
  - [ ] Rebuild `ZaiAdapter` on `@ai-sdk/openai-compatible`'s `createOpenAICompatible(...)`, matching the `ollama.ts`/`openrouter.ts`/`opencode.ts` pattern
  - [ ] Remove `zhipu-ai-provider` from `package.json`
- [ ] **2.8** Stable tool ordering (§6.4, §7.2, §11.3, decided — build in-house)
  - [ ] Implement stable-prefix / stable-tail partitioning in `tools/index.ts`'s `getToolsForAgent()`/`getAllTools()`
  - [ ] Feed the result through `prepareStep` consistently in `engine.ts`
  - [ ] Feed the result through `prepareStep` consistently in `agent-loop.ts`
  - [ ] Verify ordering survives `wrapToolsWithHooks`
  - [ ] Verify ordering survives `wrapToolsWithCallLogging`
- [ ] **2.9** One-shot `generateText` call sites — `system`→`instructions` rename only:
  - [ ] `summarizer.ts`
  - [ ] `handoff.ts`
  - [ ] `deep-research.ts`
  - [ ] `preview.ts`
  - [ ] `freelance/bid-pipeline.ts`
  - [ ] `freelance/description.ts`
  - [ ] `freelance/qa.ts`
  - [ ] `freelance/reply-pipeline.ts`
  - [ ] `freelance/expert/tools.ts`
  - [ ] `freelance/expert/orchestrator.ts`
- [ ] **2.10** `src/bun/mcp/client.ts` — verify `dynamicTool`/`jsonSchema` signatures unchanged

### Breaking-change verification sweep (§5 table — confirm each, even the "no action needed" rows)

- [ ] 5.1 `system`→`instructions` rename complete everywhere; confirmed `context.ts` never persists system-role messages into `messages[]` (no `allowSystemInMessages` needed)
- [ ] 5.2 Usage-semantics flip — before/after token comparison run against Phase 0 snapshot; cutover marker plan confirmed (see Phase 4 analytics page)
- [ ] 5.3 `fullStream`→`stream` renamed in both core loops
- [ ] 5.4 `zhipu-ai-provider` removed (tracked in 2.7 above)
- [ ] 5.5 Media/file content-part canonicalization — tested against both an Anthropic-native model and an OpenAI-compatible model (tracked in full in §8.4 below)
- [ ] 5.6 `onFinish`/`onStepFinish` renamed to `onEnd`/`onStepEnd`
- [ ] 5.7 `usage.reasoningTokens`→`usage.outputTokenDetails.reasoningTokens` read updated
- [ ] 5.8 `stepCountIs`→`isStepCount` — all 9 call sites confirmed renamed
- [ ] 5.9 Confirmed zero usage of `experimental_customProvider`/`experimental_generateImage`/`experimental_output`/`experimental_prepareStep`/`experimental_telemetry` (no action expected, verify still true post-codemod)
- [ ] 5.10 Google provider rename confirmed in `google.ts` (duplicate of 2.6 sub-item, check off together)
- [ ] 5.11 `bun run typecheck` clean of any `CallSettings`-related errors
- [ ] 5.12 Confirmed no code reads `result.request`/`result.response` bodies (no action expected)
- [ ] 5.13 Confirmed Bun/Node-22/ESM non-issue (duplicate of Phase 0 item, check off together)
- [ ] 5.15 Confirmed `ai@7`'s zod peer range against installed `zod@3.25.76`; bumped zod if the range narrowed

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
