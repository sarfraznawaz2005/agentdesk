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
- [x] Explicit go/no-go decision made to start Stage B — **go, given in chat 2026-07-15** ("ok start working on v7 migration in a new branch", reaffirmed per-item throughout Phase 2)

---

## Stage B — Phase 2: Hand-migrate what the codemod can't reach (§4 Phase 2)

- [x] **2.1** `engine-types.ts` — **done 2026-07-15.** §5.7's actual concern (`usage.reasoningTokens`→`usage.outputTokenDetails.reasoningTokens`) turned out moot — grepped the whole codebase, nothing reads `usage.reasoningTokens` at all, so there was nothing to rename. `providerOptions.anthropic.thinking` (built in `buildPMThinkingOptions()`) is structurally unchanged in v7 — not a breaking rename, just the existing provider-specific option (the new v7 feature is the separate unified `reasoning` option, tracked as new work under Phase 3.3, not a Phase 2 fix). Found and fixed a **real, pre-existing bug** while reviewing this exact function (confirmed via `git show main` that it predates this migration): `extractPMReasoning()`'s provider-metadata fallback read `step.experimental_providerMetadata`, but v7's types confirm the field is just `providerMetadata` (no prefix) — since `stepResult` is cast through `unknown`, `tsc` couldn't catch this, so the fallback silently never fired (OpenRouter/OpenAI reasoning display was dead code, only Anthropic's primary `step.reasoningText` path ever worked). User confirmed fixing it now since already in this exact function. One-line rename applied
  - **Note (2026-07-15)**: `applyAnthropicCaching()` in this file was left broken by the codemod — its return type/statements still said `system` while every call site (`engine.ts`, `agent-loop.ts`) already expected `.instructions` on the return value. Fixed: return type + body now produce `{ instructions, messages }`. `BuiltContext` in `context.ts` had the identical bug (interface said `system`, return statement said `instructions`) — fixed the same way. These two fixes alone resolved 22 of the 37 post-codemod typecheck errors (`agent-loop.ts` ×10, `engine.ts` ×8, `engine-types.ts` ×3, `context.ts` ×1)
- [x] **2.2** `media-followup.ts` — **investigated in full 2026-07-15; turned out to need almost no code change.** The doc's "highest-risk item" framing assumed a shape rebuild would be needed; static analysis against v7's actual type declarations disproved that:
  - [x] **`media-followup.ts` content-part shape**: `buildMediaFollowUpMessage()` already only ever constructed `{ type: 'file', data: <base64 string>, mediaType: <string> }` (the `image`-variant branch in its `MediaFollowUpPart` union type was declared but never actually used). Verified against v7's real types (`node_modules/@ai-sdk/provider-utils/dist/index.d.ts`): `ImagePart` is now `@deprecated` in favor of `FilePart` + `mediaType`, exactly the shape already in use; `FilePart.data: FileData | DataContent | URL | ProviderReference` accepts a bare `DataContent` (`string | Uint8Array | ArrayBuffer | Buffer`) directly — no tagged `{type:'data', data}` wrapper required; `UserContent = string | Array<TextPart | ImagePart | FilePart>` confirms `FilePart` is valid content. **Got compiler-level proof, not just reading**: removed the `mediaFollowUp as ModelMessage` type casts at both call sites (`engine.ts:895`, `agent-loop.ts:1476`) — typecheck only flagged an unused import (`ModelMessage` in `engine.ts`, cleaned up), zero structural type errors. The casts were unnecessary; the shape was already 100% valid
  - [x] `screenshot.ts`'s `toModelOutput` (shared `imageToolModelOutput()`) — verified its `{ type: 'text' as const, value: string }` return matches v7's real `ToolResultOutput` type's `'text'` variant exactly
  - [x] `audio.ts`'s `toModelOutput` (`audioToolModelOutput()`) — same shape, same verification
  - [x] `image-gen.ts`'s `toModelOutput` — reuses `imageToolModelOutput()` from `screenshot.ts`, already covered
  - [x] `engine.ts`'s `MEDIA_TOOLS` message_parts persistence logic — reads only `stepResult`'s `toolCalls`/`toolResults` and writes to AgentDesk's own `messageParts` Drizzle table; has no dependency on AI SDK's content-part wire shape at all (it's UI-persistence bookkeeping, not model-facing content)
  - [x] `dashboard.ts`/`dashboard-agent.ts`'s `extractImagePayload()`-based broadcasts — `extractImagePayload()` is pure `JSON.parse()` of AgentDesk's own custom envelope (`{image: {base64, mimeType}}`), zero AI-SDK-type dependency, version-independent by construction
  - **What's genuinely still open**: static/type-level analysis is thorough but isn't the same as a live round-trip against a real provider (§8.4) — the type system can't catch a provider adapter's internal `convertToXxxMessages()` mishandling a `FilePart` at runtime. That live verification is Phase 5's job and needs real provider API access; flagging it there rather than blocking on it here
  - [x] Fixed a distinct, unpredicted issue in the 4 media tool definitions (`audio.ts`, `image-gen.ts`, `screenshot.ts` ×2) — **done 2026-07-15**: v7's `tool<INPUT, OUTPUT, CONTEXT>()` generic signature added a required 3rd `CONTEXT extends Context` type param; the old 2-arg call form `tool<Input, string>({...})` now binds the 2nd arg to `CONTEXT` instead of `OUTPUT`, which fails (`string` doesn't extend `Context = Record<string, unknown>`). Fixed by dropping explicit generics entirely (matching the other 62 `tool({...})` call sites elsewhere in the codebase, which already rely on inference) — but bidirectional inference alone still failed on these 4 specifically (the only ones using `toModelOutput`), surfacing as "no overload matches" pointing at the wrong (last) overload. Root fix: explicitly annotate `execute`'s destructured parameter type (e.g. `async ({ path }: { path: string })`) so overload resolution has enough to commit to the first (correct) overload. Removed the now-orphaned standalone `type XInput = z.infer<...>` aliases these tools no longer needed
- [x] **2.3** `claude-subscription-cli-runner.ts` (~lines 355-371) — **verified 2026-07-15, zero changes needed.** Its media-stripping mirror constructs an **MCP protocol** content block (`{ type: "image", data, mimeType }`, per the Model Context Protocol spec `@anthropic-ai/claude-agent-sdk` uses), not a Vercel AI SDK `ModelMessage`/`FilePart` — this whole code path bypasses the `ai` package entirely (it's the Claude Agent SDK/CLI subprocess route), so it's structurally independent of and unaffected by this migration. Confirmed the "mirror" language in its own comment is conceptual (same idea, deliver real media bytes as a follow-up), not a literal shape match to `media-followup.ts`
- [x] **2.4** `engine.ts` + `agent-loop.ts` core loops — **renames done 2026-07-15**, behavioral re-verification still pending:
  - [x] Rename `system` → `instructions` — codemod handled all real call sites; broken only by the `applyAnthropicCaching`/`BuiltContext` bug above, now fixed. Also cleaned up 8 stale comments in `engine.ts`/`agent-loop.ts` still referencing `fullStream`/`onStepFinish` by name (mechanical, not code)
  - [x] Rename `fullStream` → `stream` — codemod handled this cleanly, zero live code hits remain (confirmed via full-tree grep, only stale comments found and fixed)
  - [x] Rename `onStepFinish` → `onStepEnd` — same, codemod-clean
  - [x] Rename `stepCountIs` → `isStepCount` (engine.ts only — agent-loop.ts uses custom predicates) — codemod-clean; one stale comment in `collections/chat.ts` also fixed
  - [ ] Re-verify the hallucination guard (`step.reasoningText` regex) still works post-rename — **still open.** `THINKING_DISPATCH_RE`/`DISPATCH_CLAIM_RE` are inline consts deep in `AgentEngine`'s live turn control flow, not standalone units — a headless script would have to duplicate the regexes (drift risk) rather than genuinely test them. Needs a live PM turn in the running app: ask the PM something that requires dispatching a sub-agent and confirm it either calls `run_agent` directly or self-corrects after a hallucinated text-only reply
  - [x] Re-verify the transient-error retry loop against the new `finalStep`/`usage` split — **done 2026-07-15, live-verified.** `isTransientError()`'s classifier logic (the part of the retry loop that IS a standalone, testable unit) is intact — 8/8 synthetic-error cases pass in `scripts/verify-ai-sdk-v7-live.ts` (429/503/ECONNRESET/network-fetch/`.status` property all correctly `true`; 401/validation-error/non-Error-thrown all correctly `false`). Separately, live multi-step tool-call runs against both providers confirmed `result.usage` (which the retry-path's token bookkeeping reads via `await result.usage`) behaves correctly post-migration — see 5.2 below
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
- [x] **2.7** `zai.ts` rebuild (§5.4, §11.1, decided) — **done 2026-07-15.**
  - [x] Confirmed Z.AI's current API base URL / auth-header shape by inspecting `zhipu-ai-provider`'s own compiled source (`node_modules/zhipu-ai-provider/dist/index.js`) rather than assuming: it hits `{baseURL}/chat/completions` with `Authorization: Bearer <apiKey>` — standard OpenAI-compatible shape, and its own hardcoded default (`baseURL: "https://api.z.ai/api/paas/v4"`) matches our existing `ZAI_BASE_URL` exactly. Also found the concrete reason this needed rebuilding, not just "decided in principle": `zhipu-ai-provider` depends on `@ai-sdk/provider@^3.0.3`/`@ai-sdk/provider-utils@^4.0.6`, a full major version behind our v7 stack's `@ai-sdk/provider@4.0.3`/`provider-utils@5.0.10` — bun couldn't hoist a shared version and nested zhipu's own old copies (`3.0.8`/`4.0.23`) instead, a live version-skew risk, not a hypothetical one
  - [x] Rebuilt `ZaiAdapter` on `@ai-sdk/openai-compatible`'s `createOpenAICompatible(...)`, matching the `opencode.ts` pattern exactly — `createModel()`/`listModels()`/`testConnection()` logic otherwise unchanged, `generateImage()` (already built on the same helper per §12.4) untouched
  - [x] Removed `zhipu-ai-provider` from `package.json` (`bun remove`) — confirmed zero remaining source references (the one `model-classification.ts` hit is an unrelated catalog-name-alias string, not an import)
- [x] **2.8** Stable tool ordering (§6.4, §7.2, §11.3, decided — build in-house) — **investigated + closed 2026-07-15, no new sorting algorithm needed.**
  - **Finding**: audited every tool-map transform in the real pipeline — `getToolsForAgent()`'s DB-filtered-subset build, `getAllTools()`, `wrapToolsWithHooks()`, `wrapToolsWithCallLogging()`, `excludeTools` stripping (`Object.fromEntries(Object.entries(tools).filter(...))`), and the `delete tools.verify_implementation`/`delete tools.git_commit` calls — and confirmed **every one already preserves relative key order** from the base `toolRegistry` (JS string-key insertion order is preserved by `Object.fromEntries`, `delete`, and rebuild-via-`for...of`; none of them sort or reorder). Also confirmed `prepareStep` in both `engine.ts` and `agent-loop.ts` never returns a `tools`/`activeTools` override today — tools are fixed once per call, never varied mid-turn. **Tool ordering is already stable by construction, end-to-end** — the "stable-prefix/stable-tail" sorting algorithm §6.4/§7.2 called for would be a no-op on the current pipeline's real input, so it was not built (avoids speculative code per project conventions)
  - [x] `getToolsForAgent()`/`getAllTools()` (`tools/index.ts`) — confirmed order-preserving by code inspection
  - [x] `prepareStep` in `engine.ts` / `agent-loop.ts` — confirmed neither ever overrides `tools` mid-run
  - [x] Verified ordering survives `wrapToolsWithHooks` — **regression test added** (`tests/agents/agent-loop.test.ts`), covering both its early-return path (no hooks) and its rebuild path (hooks configured)
  - [x] Verified ordering survives `wrapToolsWithCallLogging` — **regression test added**, same file, including a non-contiguous-subset case
  - [x] **New**: end-to-end pipeline regression test (filter → `wrapToolsWithHooks` → `wrapToolsWithCallLogging`, mirroring `agent-loop.ts`'s real sequence) — locks in the composed invariant, not just each function in isolation
  - **Side fix**: while wiring these tests, found and fixed a dormant instance of the exact `instructions`-shorthand codemod bug from §11 elsewhere in this same test file's `applyAnthropicCaching` mock (`(_, system, messages) => ({ instructions, messages })` — undefined `instructions` reference). Never triggered a visible failure because this file's existing assertions don't happen to exercise the compaction path that calls it, but would have thrown if they had. Fixed to `{ instructions: system, messages }`
  - **Exported `wrapToolsWithHooks`** from `agent-loop.ts` (was module-private) so it's directly unit-testable, matching the pattern `wrapToolsWithCallLogging` already follows in its own file
  - **Why a regression test and not new infrastructure**: with the user — since the invariant already holds and nothing needs sorting, a test that locks in "stays stable under future refactors" delivers the doc's actual goal (protect the prompt-cache investment) without adding a sorting algorithm with nothing to sort
- [x] **2.9** One-shot `generateText` call sites — **verified 2026-07-15, zero changes needed.**
  - [x] `summarizer.ts` / `deep-research.ts` / `freelance/bid-pipeline.ts` / `freelance/description.ts` / `freelance/qa.ts` / `freelance/reply-pipeline.ts` / `freelance/expert/tools.ts` / `freelance/expert/orchestrator.ts` — all 8 were already codemod-touched and typecheck clean
  - [x] `handoff.ts` — **doc's file inventory was stale**: this file doesn't import from `"ai"` at all, never called `generateText` in the first place
  - [x] `preview.ts` — does call `generateText`, but its call never used a `system` param to begin with (only `messages`) — nothing to rename
- [x] **2.10** `src/bun/mcp/client.ts` — **verified 2026-07-15, zero changes needed.** `dynamicTool()`'s shape is unchanged in v7; `Tool` is used with default (unspecified) generics via `Record<string, Tool>`, which resolves fine against v7's `Tool<INPUT=any, OUTPUT=any, CONTEXT=any>` defaults

### Breaking-change verification sweep (§5 table — confirm each, even the "no action needed" rows)

- [x] 5.1 `system`→`instructions` rename complete everywhere — **done 2026-07-15**; confirmed `context.ts` never persists system-role messages into `messages[]` (no `allowSystemInMessages` needed)
- [x] 5.2 Usage-semantics flip — **live-verified 2026-07-15, definitively resolved.** v7's own type declarations (`node_modules/ai/dist/index.d.ts`, `GenerateTextResult.usage` JSDoc) state plainly: "The total token usage of all steps. When there are multiple steps, the usage is the sum of all step usages" — `totalUsage` is now a `@deprecated` alias for the exact same value. Got empirical proof, not just doc-reading: `scripts/verify-ai-sdk-v7-live.ts` ran real 3-step tool-call turns against both OpenCode and Claude Haiku and confirmed `result.usage.outputTokens` exactly equals the arithmetic sum of every step's own `outputTokens` (OpenCode: 182 == 182 across 3 steps; Claude: 112 == 112 across 3 steps) — not just the last step's value, which is what a lingering v6 final-step-only semantics would have produced. `agent-loop.ts`'s existing `const totalUsage = await result.usage;` read already relies on exactly this "sum of all steps" behavior and is correctly matched by the real, installed v7. Cutover-marker plan (Phase 4.1) still stands as designed for the *historical* pre-migration data gap, which this doesn't change
- [x] 5.3 `fullStream`→`stream` renamed in both core loops — **done 2026-07-15** (codemod-clean, stale comments fixed)
- [x] 5.4 `zhipu-ai-provider` removed — **done 2026-07-15** (tracked in 2.7 above)
- [x] 5.5 Media/file content-part canonicalization — **fully done 2026-07-15**, type-level (2.2) + live round-trip. `scripts/verify-ai-sdk-v7-live.ts` sent `buildMediaFollowUpMessage()`'s exact `{ type: 'file', data: <base64>, mediaType: 'image/png' }` shape as a real follow-up user message to both providers — Claude Haiku (Anthropic-native) and OpenCode (OpenAI-compatible) both accepted it without a schema-validation error and correctly described the test image in their response, confirming both the wire shape and each provider adapter's message-conversion path handle it correctly post-migration. Full engine-level round trip (real `read_image`/`generate_image` tool + DB + UI broadcast) still belongs in §8.4's fuller pass, but the AI-SDK-level risk this row was actually about is closed
- [x] 5.6 `onFinish`/`onStepFinish` renamed to `onEnd`/`onStepEnd` — **done 2026-07-15** (codemod-clean, stale comments fixed)
- [x] 5.7 `usage.reasoningTokens`→`usage.outputTokenDetails.reasoningTokens` read updated — **confirmed moot under 2.1** (nothing in the codebase reads `usage.reasoningTokens`, so there was nothing to rename) and **live-spot-checked 2026-07-15**: `scripts/verify-ai-sdk-v7-live.ts` confirmed the real field name is `outputTokenDetails` on both providers (OpenCode returned `{"textTokens":11,"reasoningTokens":3}`; Claude Haiku returned `{}`, expected since that call didn't reason) — the v7 field shape is real and accessible whenever a future feature (Phase 3.3's unified `reasoning` option) needs it
- [x] 5.8 `stepCountIs`→`isStepCount` — all 9 call sites confirmed renamed — **done 2026-07-15**
- [x] 5.9 Confirmed zero usage of `experimental_customProvider`/`experimental_generateImage`/`experimental_output`/`experimental_prepareStep`/`experimental_telemetry` — **verified 2026-07-15**, full-tree grep, zero hits (prediction holds)
- [x] 5.10 Google provider rename confirmed in `google.ts` — **verified 2026-07-15**: already uses `createGoogle` from `@ai-sdk/google` (current v7 name), no codemod/hand-fix needed (duplicate of 2.6 sub-item)
- [x] 5.11 `bun run typecheck` clean of any `CallSettings`-related errors — **done 2026-07-15**, 0 typecheck errors overall
- [x] 5.12 Confirmed no code reads `result.request`/`result.response` bodies — **verified 2026-07-15**, full-tree grep, zero hits (no action needed, prediction holds)
- [x] 5.13 Confirmed Bun/Node-22/ESM non-issue (duplicate of Phase 0 item, check off together)
- [x] 5.15 Confirmed `ai@7`'s zod peer range against installed zod — **done 2026-07-15**: `ai@7` requires `zod@^3.25.76 || ^4.1.8`; our own `package.json` declared the looser `^3.24.0` (only satisfied v7's actual requirement by incidental transitive resolution). Tightened to `^3.25.76` to make the real constraint explicit for future clean installs; `bun install` re-verified with no resolution conflicts

---

## Stage B — Phase 3: Feature adoption (§4 Phase 3, §6, §11.4/§11.5 — all decided in-scope-now)

- [x] **3.1** Telemetry + tracing channel (§6.3) — **done 2026-07-15.**
  - **Upgrade over the original plan**: the doc's plan was written from external docs/blog analysis before the real v7 release and proposed subscribing to the raw `node:diagnostics_channel` (`ai:telemetry`) directly. Investigation of the actual installed v7 types found something better already built in: a first-class `Telemetry` integration interface (`onStart`/`onStepStart`/`onLanguageModelCallStart`/`onLanguageModelCallEnd`/`onToolExecutionStart`/`onToolExecutionEnd`/`onStepEnd`/`onEnd`/`onAbort`/`onError`) registered globally via `registerTelemetry(...)`. Its own type declaration confirms the key property: "Enable or disable telemetry. **Enabled by default when a telemetry integration is registered.**" — meaning `registerTelemetry()` gives the exact same "subscribe once, zero call-site changes" property the raw tracing-channel approach was chosen for, but with structured, typed events instead of one untyped envelope to hand-parse (built-in `performance` metrics on `onLanguageModelCallEnd` — `responseTimeMs`, `effectiveOutputTokensPerSecond`, `timeToFirstOutputMs` — map directly onto Phase 4.1's planned Latency/Throughput views with zero manual computation). Used `registerTelemetry()`, not the raw channel
  - [x] Subscribed globally in `src/bun/index.ts`, right after `await seedDatabase()` (must come after `runMigrations()` since the sink writes to the new table) — `registerTelemetry(telemetrySink)`
  - [x] Wired to a structured sink: new `ai_telemetry_events` SQLite table (migration `v59_ai-telemetry-events.ts`, Drizzle schema in `schema.ts`) — a single wide events table (not normalized per-event-type) with an `event_kind` discriminator (`start`/`language_model_call_end`/`tool_execution_end`/`end`/`abort`/`error`) and a `call_id` correlating every event within one generation. Captures token usage (including `inputTokenDetails.cacheReadTokens`/`cacheWriteTokens` for the planned cache-hit-rate view, and `outputTokenDetails.reasoningTokens`), per-call `performance` metrics, per-tool execution timing/success, and errors. Implementation in `src/bun/agents/telemetry-sink.ts` — every write is fire-and-forget/non-fatal (`.catch(() => {})`), matching the rest of the codebase's DB-write conventions
    - Schema includes a nullable `runtime_context` JSON column, empty until Phase 3.2 lands — v7's telemetry events already carry `runtimeContext` whenever a call sets one, so no future migration will be needed once 3.2 wires it through; the column just starts getting populated
    - Migration SQL syntax directly validated against a throwaway in-memory `bun:sqlite` DB (insert + select round-trip) since the project's `tests/helpers/db.ts` schema mirror only covers through v8, not v59
  - [x] Decided `prompt-logger.ts`'s fate: raw prompt-content debug logging (`logPrompt`, opt-in via `debug_prompts` setting) is unaffected and stays as-is. Added a doc-comment to `getPromptLogStats()`/`getPromptLogEntry()` (the regex-parsed stats path) marking them superseded by `ai_telemetry_events` and noting their only consumer (`analytics.tsx`'s Settings "Analytics" view) is scheduled for retirement in Phase 4.1 — no functional change yet, since that view still depends on them until the new page replaces it
- [x] **3.2** Runtime context + typed tool context (§6.1) — **done 2026-07-15.**
  - [x] Replaced hand-rolled `__projectId`/`__conversationId` stamping in `agent-loop.ts` with the v7 mechanism. Scope check confirmed the blast radius was contained: `__projectId`/`__conversationId` were read ONLY by `run_shell` (`shell.ts`) and `request_human_input` (`communication.ts`), both ONLY stamped by `agent-loop.ts` (the PM in `engine.ts` never offers either tool). `run_shell` has 4 other independent call sites (freelance-chat/freelance-wizard/recommendations/skills-search) but all of them use the `autoApprove=true` variant, which never reads the projectId-gated approval path — confirmed unaffected before touching anything
  - [x] Migrated scoped tool config to per-tool `context` via `contextSchema`: added `contextSchema` (both fields optional, matching the prior graceful-fallback behavior for call sites that don't supply one) to `run_shell` and `request_human_input`; their `execute()` now reads `context.projectId`/`context.conversationId` instead of `rawArgs.__projectId`/`__conversationId`. `agent-loop.ts`'s `streamText` call supplies `toolsContext: { run_shell: {...}, request_human_input: {...} }` — required a narrow, commented `as never` cast, since AgentDesk's tool sets are always a runtime-assembled `Record<string, Tool>` (DB/role-driven, never a literal object), so TS can't infer `InferToolSetContext` through the generic type; the object's shape was verified by hand against each tool's own `contextSchema`
    - `communication.ts`'s `request_human_input` already had an unrelated input field literally named `context` (free-text background for the question) — renamed the new execute-option destructure to `toolContext` locally to avoid confusion between the two
    - Updated `tests/tools/shell-approval.test.ts`'s `runShell()` test helper, which simulated the OLD mechanism directly (stuffing `__projectId`/`__conversationId` into the tool's first `args` parameter) — now passes them via the second parameter's `context` field, matching the real call shape. All 6 tests still pass
  - [x] **Bonus, not originally scoped but a direct synergy with Phase 3.1's telemetry sink**: added a separate, global `runtimeContext: { agentName, projectId, conversationId }` (distinct from the per-tool `toolsContext` above) to both `agent-loop.ts`'s and `engine.ts`'s (PM) `streamText` calls — this flows automatically into every telemetry event's `runtimeContext` field with zero sink changes needed (exactly as designed in 3.1's schema comment), meaning the eventual Analytics page can now attribute usage/cost/latency to a specific agent role and project, not just a provider/model. The PM's own turn is the higher cost-significance surface per Phase 0's usage-tracking finding, so this closes a real, previously-noted gap
  - [x] Confirmed this lands before 3.4 (tool approval) — done, in this same commit
- [x] **3.3** Unified `reasoning` option (§6.5) — **done 2026-07-15, full replacement (user-confirmed, accepting the Anthropic budget-depth change below).**
  - [x] Migrated off `providerOptions.anthropic.thinking` — **for every provider, not just where it was already used.** Confirmed by reading each provider package's own compiled source (not just doc claims): `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible` (covers Ollama/OpenCode/OpenRouter/Z.AI), `@ai-sdk/google`, `@ai-sdk/groq`, `@ai-sdk/deepseek`, and `@ai-sdk/xai` all genuinely forward the unified `reasoning` option — meaning providers that previously got **zero** thinking/reasoning configuration (everything except anthropic/openrouter/claude-subscription) now get real reasoning-budget control for the first time, not just a simplification of existing code
    - `engine-types.ts`'s `buildPMThinkingOptions(budget, providerType)` (~30 lines of per-provider branching) replaced with `buildReasoningOptions(budget)` — a 3-line, fully provider-agnostic function (`{ reasoning: budget }`); same replacement for `agent-loop.ts`'s `buildThinkingOptions`. Both call sites (`engine.ts`, `agent-loop.ts`) updated
    - **Known, accepted behavior change for Anthropic** (flagged to the user before implementing, confirmed to proceed): traced `@ai-sdk/anthropic`'s actual internal math (`mapReasoningToProviderBudget`) — v7 maps `low`/`medium`/`high` to **10%/30%/60% of `maxOutputTokens`**, not AgentDesk's old fixed token counts (2000/8000/16000, ratio ~1:4:8, which doesn't match the SDK's 1:3:6 ratio at any shared base — there is no `maxOutputTokens` value that reproduces all three old levels simultaneously). Actual thinking depth per level now scales with whatever `maxOutputTokens` a call resolves to, rather than being a fixed constant. The SDK's own `minReasoningBudget` floor (1024 tokens default) protects against degenerate low budgets, so the old manual "floor" computation (`Math.max(maxTokens ?? 0, budgetTokens + 1000)`) was removed as redundant, not just simplified away
    - Live-verified (not just read) against both real test providers: `reasoning: "low"` sent to Claude Haiku (Anthropic-native) and OpenCode's free model (OpenAI-compatible) — both accepted cleanly, zero errors, zero "unsupported" warnings
    - **Left untouched, a separate mechanism**: the `"custom"` provider type's model-*creation*-time thinking injection (`ProviderAdapter.createModel(modelId, thinkingBudgetTokens?)`, still fed by the pre-existing `THINKING_BUDGET_TOKENS` constant in both files) — this solves a different problem (some self-hosted models need a non-standard `enable_thinking`-style flag baked into model config, not expressible via a per-call option) and is complementary to, not replaced by, the new unified option
  - [x] Kept `extractPMReasoning()`'s existing fallback chain untouched, exactly as planned — it extracts reasoning *text* (a different concern from the reasoning *budget/effort* config this item changes) and already has its own fix from earlier this session (§2.1's `experimental_providerMetadata`→`providerMetadata` correction)
  - [x] OpenRouter verified as part of the "confirmed by reading provider source" pass above — OpenRouter proxies requests through `@ai-sdk/openai-compatible` (not a bespoke adapter), which is confirmed to forward `reasoning_effort` correctly
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
