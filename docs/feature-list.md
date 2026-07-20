# AgentDesk — Feature List & Regression-Check Reference

> **Purpose**: a permanent, living inventory of every feature/functionality in
> AgentDesk, with file pointers. When a big architectural change happens in
> the future (a new AI SDK major version, a database/ORM swap, a rewrite of
> the agent orchestration model, an Electrobun upgrade, etc.), use this
> document to know what exists and what specifically needs re-checking — so
> nothing regresses silently.
>
> **This is not a migration doc.** It doesn't track "what's done" for any one
> initiative — see `ai-sdk-7-migration-tasks.md` for that kind of thing.
> This document tracks "what exists," permanently, across every area of the
> app.
>
> **Keep this updated.** Per the project rule in `CLAUDE.md`, whenever a new
> feature is added (or a tracked one is removed/substantially reworked),
> update the relevant section here in the same change.
>
> **Format**: each feature has a one/two-sentence description, **Key files**
> (paths + key exported function/component names — deliberately not line
> numbers, since those go stale fast), **Data** (DB tables involved, if any),
> and **Watch for** (the one thing most likely to break silently if this area
> is touched carelessly during a big refactor).

---

## How to use this document

1. **Scope your change first.** Figure out which of the 9 feature areas
   below (plus the Database/RPC reference) your change actually touches —
   most big changes only genuinely affect 2-4 of them.
2. **Read every "Watch for" line in the affected sections.** These are the
   specific, concrete failure modes found by deliberately re-reading the
   actual code — not generic advice.
3. **Check the cross-cutting hotspots** below regardless of which section
   you're touching — several files/patterns show up as a dependency of
   almost everything else in the app.
4. **Check the "Known dead/orphaned code" list** before assuming something
   is reachable, or before "cleaning up" something that looks unused —
   several of these are deliberate half-finished features, not garbage.

### Cross-cutting hotspots (relevant to almost any big change)

- **`src/bun/agents/telemetry-sink.ts`** — the single global AI SDK
  `Telemetry` integration. Directly coupled to the AI SDK's own `Telemetry`
  interface shape (event field names, `performance`/`usage` sub-objects). A
  new AI SDK major version changing this interface breaks analytics
  **silently** (writes fail non-fatally — the app keeps running, but the
  Analytics/AI Usage tab quietly goes blank). Check this first after any AI
  SDK bump.
- **The Claude Subscription two-path pattern** (`providerType ===
  "claude-subscription"`) — Haiku goes through a real AI-SDK `streamText`
  call; every other model goes through a completely different CLI/SDK
  subprocess bridge (`claude-subscription-cli-runner.ts`) that bypasses the
  AI SDK entirely. Any new code that creates/calls an AI provider model
  directly must gate on `isClaudeSubscriptionViaCli` and handle both paths.
  See "Agent Orchestration Core" and "Providers, Models & AI Analytics"
  below.
- **`applyAnthropicCaching()`** (`src/bun/agents/engine-types.ts`) — prompt
  caching only applies to `anthropic`/`openrouter`/`claude-subscription`
  provider types. Must be re-applied any time `context.messages` is mutated
  mid-turn (media follow-ups, compaction) or caching silently drops for that
  step.
- **Tool merge order in `agent-loop.ts`** — base tools → tracked file tools →
  plugin tools → MCP tools → decisions tool → caller `extraTools`. A new
  tool module added to the static registry but not layered into this merge
  won't get its per-run bindings (file tracking, workspace scoping) even
  though it's technically present in `getAllTools()`.
- **The four-file RPC wiring pattern** (contract in `src/shared/rpc/` →
  handler in `src/bun/rpc/` → grouping in `src/bun/rpc-groups/` →
  registration in `src/bun/remote/rpc-handlers.ts`/`rpc-registration.ts` →
  client call in `src/mainview/lib/rpc.ts`) — see the Database & RPC
  Reference appendix for the full merge chain. Never bypass this with a
  direct DB call from the frontend.
- **`src/bun/remote/rpc-handlers.ts`** specifically — the single place a new
  RPC group must be registered for BOTH the native Electrobun bridge and the
  remote/web WebSocket transport to see it. A group wired only into
  `rpc-registration.ts` is silently unavailable over Remote Access/web,
  which desktop-only testing will never catch.
- **`isTransientError()` / retry classification** (`src/bun/agents/safety.ts`)
  — shared by both the PM loop and the sub-agent loop's retry logic. A new
  AI-SDK error shape/name not added here silently stops being retried.
- **Streaming mode** (`getStreamingMode()`, `src/bun/agents/streaming-mode.ts`)
  — governs whether text/reasoning stream progressively, once per step, or
  not at all, across nearly every chat surface in the app. A refactor of the
  streaming pipeline must re-verify all three modes, not just the default.
- **In-memory-only state that resets on app restart** — several important
  invariants live ONLY in process memory, not the DB: `writeAgentRunning`
  dispatch guard, `activeReviews`/`reviewRounds`/`taskCommitHashes` (review
  cycle), `planBatches` (plan recap tracking), `jobStore` (background
  processes), MCP server connections, engine instances themselves. A crash
  or restart mid-operation can leave these needing manual reconciliation —
  don't assume DB state alone tells the whole story when debugging something
  that "used to be running."

### Known dead/orphaned code (don't assume these work; don't delete blindly)

These were found by deliberately checking whether something is actually
reachable, not just present in the codebase. Two different lessons apply
depending on which kind it is:

- **Genuinely unreachable UI, real backend behind it** — a future "why
  doesn't this work" or "let's finish this" investigation should start here,
  not from scratch:
  - **Command Palette** (Cmd+K) — fully built and RPC-wired
    (`src/mainview/components/command-palette.tsx`,
    `src/bun/rpc/search.ts`'s `globalSearch`), but nothing anywhere calls
    `setPaletteOpen(true)` — no keyboard shortcut, no menu item, no button.
  - **Branch Strategy UI** — a complete branching-model config page
    (`src/mainview/components/git/branch-strategy.tsx`) with a working RPC
    backend (`src/bun/rpc/branch-strategy.ts`) and DB table
    (`branch_strategies`), but the component is never imported/rendered
    anywhere in `git-tab.tsx`.
  - **Conversation cost estimate** — a fully-implemented `$` cost tooltip
    (`src/mainview/components/chat/conversation-cost.tsx`) that's simply not
    mounted anywhere in the current chat UI.
  - **Archive/restore in the conversation sidebar** — the UI code path
    exists in `conversation-sidebar.tsx`, but `ChatLayout` never passes it
    the props needed to reach it.
- **Vestigial — no real behavior, safe to ignore or repurpose**:
  - **`keyboard_shortcuts` table** — created in the very first migration,
    zero readers/writers anywhere in the current codebase.
  - **Project-level `constitutionMode` setting** — the key exists
    (`DEFAULT_PROJECT_SETTINGS`) but nothing reads it; there's no actual
    per-project constitution override today despite the setting appearing to
    support one.
  - **`WaitingRow`** in `message-list.tsx` — pre-built but hardcoded
    unreachable ("PM no longer waits for agents").
  - **Native mobile app** — `docs/mobile-app-prd.md` describes a route that
    was never built; the actually-shipped companion experience is the
    browser-based Remote Access pairing feature (same React source, a
    separate Vite build target), not a native app.

---

## Agent Orchestration Core

### PM Turn Loop (AgentEngine.sendMessage / _runPMProcessing)
The Project Manager's own conversational loop: persists the user message, builds context, resolves provider/model, and drives a `streamText` (or CLI-bridge) call with PM-specific tools. One `AgentEngine` instance exists per project (`EngineManager`). Handles slash commands (`/info`, `/preview`) via hardcoded, non-LLM paths before ever invoking the model.
**Key files:**
- `src/bun/agents/engine.ts` — `AgentEngine` class, `sendMessage`, `_runPMProcessing`
- `src/bun/agents/engine-manager.ts` (at `src/bun/engine-manager.ts`) — `getOrCreateEngine`, callback wiring, `broadcastToProject`
**Data:** `messages`, `conversations`, `projects`, `agents`, `settings`
**Watch for:** any `streamText`/`generateText` call-shape change (options like `stopWhen`, `prepareStep`, `onStepEnd`, `timeout`, `runtimeContext`, `toolsContext`) must be mirrored in both this loop and `agent-loop.ts`'s sub-agent loop — they are deliberately kept structurally parallel.

### Sequential PM processing lock
`sendMessage` aborts any in-flight PM stream + running sub-agents, then installs a lock promise (`pmProcessingPromise`) so back-to-back `sendMessage` calls (double-click, rapid events, agent-report restarts) queue instead of racing. Guarantees only one PM generation is ever active per project.
**Key files:**
- `src/bun/agents/engine.ts` — `pmProcessing`, `pmProcessingPromise`, `pmAbort` fields in `sendMessage`
**Data:** none (in-memory only)
**Watch for:** the lock-release path (`lockResolve`) has multiple early-return bail-outs (empty content, missing conversation) that must each still release the lock or every future `sendMessage` on that engine deadlocks forever.

### Claude Subscription CLI/SDK bridge (dual-path provider)
`providerType: "claude-subscription"` behaves like a normal AI-SDK provider only for Haiku (direct-HTTP OAuth adapter). Every other model (Sonnet/Opus) routes through `runClaudeCliTask`, which spawns the real `claude` CLI via the official Agent SDK with `settingSources: []` (so the user's own Claude Code hooks never fire). This bridge exists identically in both the PM loop and the sub-agent loop, each with its own callback-to-MessagePart mapping.
**Key files:**
- `src/bun/agents/engine.ts` — `isClaudeSubscriptionViaCli` branch (step 8a), flattens `context.messages` into a single transcript
- `src/bun/agents/agent-loop.ts` — `isClaudeSubscriptionViaCli` branch (step 4b), flattens `priorMessages` + task
- `src/bun/providers/claude-subscription-cli-runner.ts` — `runClaudeCliTask`
- `src/bun/providers/claude-subscription.ts` — `isHaikuModel`, `internalCallModelId`
**Data:** none directly; writes `messages`/`messageParts` same as the normal path
**Watch for:** known, disclosed limitations on this path — no hallucination-retry/dispatch-enforcement, no mid-stream plan-approval early-stop, no post-stream ground-truth correction (PM side); no `stuck_loop`/context-ratio-based compaction control (sub-agent side, since `query()` runs its own opaque loop). Any new streamText-loop-only refinement must be explicitly evaluated for whether it needs a CLI-path equivalent or is an accepted gap. Both branches must always resolve with a `status`, never reject the outer promise (see the fix applied 2026-07-16 for the CLI branch specifically) — a rejection here skips `callbacks.onAgentComplete`, which is what clears the frontend's busy-state UI.

### Sequential single-agent dispatch (`run_agent`)
The PM's primary dispatch tool. Fire-and-forget: launches `runInlineAgent` in the background, immediately stops the PM stream, and later restarts the PM via `onAgentDone` once the sub-agent's promise resolves. Enforces "one write agent at a time" via a closure-scoped `writeAgentRunning` flag plus a module-level `dispatchingAgents` Set (closes a race where the AI SDK runs parallel tool calls via `Promise.all` and two `run_agent` calls could both pass the running-check before either registers).
**Key files:**
- `src/bun/agents/tools/pm-tools.ts` — `createPMTools`, `run_agent` tool, `dispatchingAgents` Set
- `src/bun/agents/agent-loop.ts` — `runInlineAgent` (the actual execution)
**Data:** `kanban_tasks` (move to working/review/backlog), `agents`
**Watch for:** the `dispatchInitiated`/`releaseGuards` cleanup contract — a synchronous throw before the background `.then/.catch` chain attaches must release `writeAgentRunning`/`dispatchingAgents` itself, or all future write-agent dispatch deadlocks until app restart.

### Parallel read-only agent dispatch (`run_agents_parallel`)
Runs up to 5 read-only agents (`READ_ONLY_AGENTS`: `code-explorer`, `research-expert`, `task-planner`) concurrently via `Promise.allSettled`, with a staggered 1.5s-per-index start delay to avoid overwhelming the provider. Rejects any non-read-only agent in the batch.
**Key files:**
- `src/bun/agents/tools/pm-tools.ts` — `run_agents_parallel` tool
- `src/bun/agents/agent-loop.ts` — `READ_ONLY_AGENTS`, `READ_ONLY_WRITE_EXCEPTIONS`, `filterReadOnlyTools`
- `src/bun/agents/tools/simple-dispatch.ts` — equivalent blocking variant for the scheduler's project-less mode
**Data:** none new beyond `run_agent`'s
**Watch for:** `READ_ONLY_AGENTS`/`WRITE_TOOLS` sets must stay in sync with `docs/prd.md`'s agent-roster description; the task-planner's `create_task` exception (`READ_ONLY_WRITE_EXCEPTIONS`) is the one deliberate crack in the read-only filter.

### Inline agent execution model (`runInlineAgent`)
Sub-agents run inline in the main conversation with a fresh context (system prompt + task only, NO parent history) and explore the codebase themselves. All tool calls/text are persisted as `messageParts` and streamed to the frontend live. Supports Playground-specific knobs (`priorMessages`, `persistToDb: false`, `extraTools`, `excludeTools`, `streamingModeOverride`) that let the Playground reuse the exact same executor without DB writes.
**Key files:**
- `src/bun/agents/agent-loop.ts` — `runInlineAgent`, `InlineAgentOptions`, `InlineAgentResult`
**Data:** `messages`, `message_parts`, `agents`, `ai_providers`, `conversations`
**Watch for:** any AI-SDK message/part shape change ripples through the `onStepEnd` tool-call/tool-result mapping to `MessagePart`; the `persist` flag gates every DB write, so a refactor must not accidentally make a write unconditional (would break Playground).

### Full Streaming / Hybrid / No Streaming modes
A global setting (`getStreamingMode`) controls whether text/reasoning are progressively streamed as live, updated `MessagePart`s ("full"), emitted once per step ("hybrid", the historical default), or suppressed from live broadcast entirely ("none" — bookkeeping still happens for persistence). Implemented via `createThrottledAccumulator` so live UI updates are throttled/batched rather than firing per-token.
**Key files:**
- `src/bun/agents/streaming-mode.ts` — `getStreamingMode`, `StreamingMode`
- `src/bun/agents/throttled-accumulator.ts` — `createThrottledAccumulator`
- `src/bun/agents/engine.ts` — `isFullStreaming`/`isNoStreaming`, PM-side live text/reasoning accumulators
- `src/bun/agents/agent-loop.ts` — `pushLiveDelta`, `finalizeLivePart`, `retractLiveParts` (sub-agent side)
**Data:** `message_parts` (live-updated rows in "full" mode)
**Watch for:** `onPartsRemoved`/`retractLiveParts` — the mechanism for discarding a live-streamed part when a Claude Subscription CLI attempt fails tool-call verification and retries; a stream-shape change must preserve the retract path or stale text will linger in the UI.

### Handoff summaries between sequential tasks
After a sub-agent completes with modified files, a handoff summary is generated (deterministic regex extraction for small diffs ≤3 files/<200 lines, else an AI-summarized version) and appended (never overwritten) to the kanban task's `importantNotes`, alongside any `follow_up_issues` surfaced as "Suggested Next Steps" for the next agent.
**Key files:**
- `src/bun/agents/handoff.ts` — `generateHandoffSummary`, `redactSecrets`, `extractCompletionReport`, `extractFollowUpIssues`
- `src/bun/agents/tools/pm-tools.ts` — the `runInlineAgent(...).then(...)` block that calls `generateHandoffSummary` and appends to `kanban_tasks.importantNotes`
**Data:** `kanban_tasks.importantNotes`
**Watch for:** `redactSecrets`/`SENSITIVE_FILE_RE` — any file-reading refactor here must keep credential redaction in place since this content can be relayed to a channel (Discord/WhatsApp/Email).

### Hallucination / dispatch-enforcement guard (PM-only)
When the PM was expected to call `run_agent` (either via an injected `[Next Action] DISPATCH` hint or a detected claim of having dispatched) but instead only produced prose, the engine retries up to `MAX_HALLUCIN_RETRIES` (2) times: it strips the hallucinated text from the in-memory context, injects a correction message, and narrows `activeTools` to dispatch-only tools (provider-agnostic alternative to `toolChoice: 'required'`, which some providers silently ignore). Detection uses three vectors in order: engine-injected hint, a regex over the extended-thinking block ("let me dispatch"/"I'll call run_agent"), then a regex over the response text as fallback.
**Key files:**
- `src/bun/agents/engine.ts` — `isDispatchExpected`, `THINKING_DISPATCH_RE`, `DISPATCH_CLAIM_RE`, `hallucinRetries` loop
**Data:** none (in-memory context correction only, never poisons DB history)
**Watch for:** this is PM-loop-only; the CLI/SDK bridge branch explicitly does NOT reimplement it (disclosed limitation).

### Post-stream ground-truth correction
A second-layer safety net after in-stream hallucination retries are exhausted: checks the actual running-agent count (not text inference) after the stream completes, and if zero, schedules a `[DISPATCH CORRECTION]` re-injection via a deferred `sendMessage` call. Guarded against infinite correction loops by checking the message doesn't itself start with `[DISPATCH CORRECTION]`.
**Key files:**
- `src/bun/agents/engine.ts` — `postStreamCorrectionNeeded`, `postStreamDetectionSource`, step 11 block
**Data:** none
**Watch for:** the `setTimeout(..., 150)` defer exists specifically to run after `pmProcessingPromise` resolves — calling `sendMessage` synchronously from inside `_runPMProcessing` would deadlock on its own lock.

### Stuck-loop / repeated-tool-call detection (sub-agent only)
Only applies to MCP tools (`mcpToolNames`) — built-in tools are considered harmless to repeat. Hashes `(toolName, args)` per step; at 10 repeats injects a system warning (via `pendingStuckWarning`, delivered on the next `prepareStep`); at 15 repeats aborts the run entirely (`stuckController.abort()`, status `"failed"`).
**Key files:**
- `src/bun/agents/agent-loop.ts` — `STUCK_WARN_THRESHOLD`, `STUCK_STOP_THRESHOLD`, `hashToolCall`, `recentToolCalls`
- `src/bun/agents/safety.ts` — separate, currently-unused-by-this-path `recordAction`/`agentWindows` sliding-window loop detector (legacy/general-purpose utility, not wired into `agent-loop.ts`'s own inline hash-based detector)
**Data:** none (in-memory per-run)
**Watch for:** `safety.ts`'s `recordAction` and `agent-loop.ts`'s inline stuck-loop logic are two independent implementations of a similar idea — a refactor should not assume they're the same code path.

### Timeout guardrails
Two independent timeout layers per sub-agent run: a native AI SDK v7 `timeout: { chunkMs: 120_000 }` (stalled-stream detection — no new streamed delta within the window) and a wall-clock `TIMEOUT_MS` (default 30 min, `opts.timeoutMs` override) enforced via a separate `timeoutController`. The PM's own loop has only the `chunkMs` guard — no total-timeout ceiling, by design (a human is present to click Stop).
**Key files:**
- `src/bun/agents/agent-loop.ts` — `TIMEOUT_MS`, `timeoutController`, `compositeController`
- `src/bun/agents/engine.ts` — `timeout: { chunkMs: 120_000 }` on the PM's `streamText` call
- `src/bun/agents/safety.ts` — `createActionTimeout` (general-purpose helper, `DEFAULT_CONFIG.actionTimeoutMs`)
**Data:** none
**Watch for:** a chunk-timeout abort isn't specially classified — it falls into the generic failure path and relies on `isTransientError()` matching "timeout" in the message for the retry to kick in.

### Context compaction — sub-agent (progressive, `prepareStep`-driven)
Compaction thresholds keyed off `contextRatio = lastPromptTokens / CONTEXT_LIMIT`: >90% after already compacting → stop with `context_full`; >70% (first crossing) → rule-based compaction (zero-token, deterministic — `buildRuleBasedCompaction`), escalating to AI-summarized compaction (`aiCompactConversation`) only if the rule-based summary exceeds 8000 chars; >85% post-compaction → strip old assistant text + prune tool outputs further; >60% → aggressive pruning (keep last 5 tool results); else → light pruning (keep last `COMPACT_KEEP_RECENT`=5).
**Key files:**
- `src/bun/agents/agent-loop.ts` — `prepareStep` compaction ladder, `buildRuleBasedCompaction`, `aiCompactConversation`, `compactToolResultsInMessages`, `stripOldAssistantText`, `pruneToolOutput`
**Data:** none (in-memory `agentMessages` mutation only, per-run)
**Watch for:** `SKIP_PRUNE_TOOLS` (never prunes `read_file`/`write_file`/`edit_file` etc. — agents need file content as working memory) must stay aligned with any new file-editing tool added later.

### Context compaction — PM turn (next-turn, single-limit trigger)
Unlike the sub-agent's progressive ladder, the PM uses ONE limit (`contextWindowLimit`, via `getContextLimit`) governing both the UI context bar and compaction. Measures the real last-turn prompt tokens (`lastPromptTokens` map, falls back to char estimate) at the START of the NEXT turn — never mid-stream — and if at/over the limit, calls `summarizeConversation` (full AI compaction of the durable DB history) before proceeding. Throws a user-facing error if the durable history still exceeds the window post-compaction.
**Key files:**
- `src/bun/agents/engine.ts` — step 4.1 in `_runPMProcessing`, `lastPromptTokens` map, `triggerSummarization`
- `src/bun/agents/summarizer.ts` — `summarizeConversation`
**Data:** `messages` (rewrites/compacts durable conversation history)
**Watch for:** this is a fundamentally different compaction strategy from the sub-agent's — a refactor unifying them must preserve that the PM's compaction is durable/DB-level while the sub-agent's is ephemeral/in-memory-per-run.

### Between-task tool-output pruning
After a dispatched agent completes, if the PM conversation's context utilization is ≥60%, the just-finished sub-agent's verbose tool outputs (in its own `messageParts` rows) are pruned via `pruneAgentToolResults` — distinct from full conversation compaction, which only the engine's next-turn check triggers.
**Key files:**
- `src/bun/agents/agent-loop.ts` — `pruneAgentToolResults`, `pruneToolOutput`
- `src/bun/agents/tools/pm-tools.ts` — the `ctx.utilizationPercent >= 60` check in `run_agent`'s completion handler
**Data:** `message_parts.tool_output`
**Watch for:** batched in one `db.transaction` to avoid N separate fsync/commit cycles — a refactor must not silently drop that batching.

### Retry / transient-error classification
A shared classifier (`isTransientError`) recognizes rate-limits (429/503), network errors (ECONNRESET, ETIMEDOUT, "fetch failed", etc.) as safe-to-retry. Both the PM loop (`MAX_PM_RETRIES`=3) and sub-agent loop (`MAX_RETRIES`=2, wrapped in an outer `retry:` labeled while-loop that preserves compacted history across attempts) use it with exponential backoff (`getBackoffDelay`, capped at 30s).
**Key files:**
- `src/bun/agents/safety.ts` — `isTransientError`, `getBackoffDelay`
- `src/bun/agents/engine.ts` — PM retry `while (true)` loop
- `src/bun/agents/agent-loop.ts` — sub-agent `retry:` labeled loop
**Data:** none
**Watch for:** a new AI SDK error shape/name must be added to `isTransientError`'s matchers or it will silently stop being retried (surfaces as a hard failure instead).

### Abort / Stop button plumbing
`AgentEngine.stopAll()` aborts the PM's own `AbortController` (`pmAbort`) and calls an injected `abortAgentsFn` (wired to `abortAllAgents`). Every dispatched sub-agent's `AbortController` is tracked in a project-scoped registry (`registerAgentController`/`unregisterAgentController`) so `stopGeneration` (stop everything) and `stopAgent` (stop one by name) can target them individually. A `stopped` flag on the engine additionally short-circuits new inline-agent launches until the next `sendMessage` clears it.
**Key files:**
- `src/bun/agents/engine.ts` — `stopAll`, `stopAllAndReset`, `isStopped`, `pmAbort`
- `src/bun/engine-manager.ts` — `registerAgentController`, `unregisterAgentController`, `abortAllAgents`, `abortAgentByName`, `getRunningAgentCount`/`getRunningAgentNames`
- `src/bun/rpc-groups/conversations-control.ts` — `stopGeneration`, `stopAgent`, `stopAllAgents` RPC handlers
- `src/mainview/stores/chat-store.ts` — `stopGeneration`, `stopAgent` actions (clear `activeInlineAgent`/`runningAgentCount` optimistically, then re-sync)
**Data:** none (in-memory controller registry)
**Watch for:** a user-initiated cancellation (`result.status === "cancelled"`) must NOT trigger PM auto-continue (`onAgentDone` explicitly skips the DISPATCH/next-task logic for `"cancelled"`) — "Stop" means stop everything, not "move to the next task."

### Engine lifecycle (EngineManager)
One `AgentEngine` per project, lazily created via `getOrCreateEngine` and cached in a `Map`. Capped at `ENGINE_MAP_MAX_SIZE` (50); when exceeded, the oldest fully-idle engine (not processing, zero running agents) is evicted via `evictOldestIdleEngine`. `removeEngine` tears down an engine's state (stop-all, abort agents, reset shell auto-approve, clear message queue) when a project is deleted.
**Key files:**
- `src/bun/engine-manager.ts` — `getOrCreateEngine`, `evictOldestIdleEngine`, `removeEngine`, `engines` Map
**Data:** none (engines are pure in-memory objects; no DB table backs them)
**Watch for:** engine callbacks close over `projectId` at creation time via `broadcastToProject` — any new callback added to `AgentEngineCallbacks` must be wired here too or it silently becomes a no-op.

### Quick Chat tool stripping
Quick Chat (project-less, OS-Explorer-launched) sessions have no kanban board. The PM's own tool set omits kanban/plan-approval tools entirely (`quickChat` boolean derived from `projects.isQuickChat`, checked per-turn — not cached), and every dispatched sub-agent additionally has `QUICK_CHAT_EXCLUDED_TOOLS` (create_task, move_task, submit_review, verify_implementation, define_tasks, etc.) stripped via `runInlineAgent`'s `excludeTools`.
**Key files:**
- `src/bun/agents/tools/pm-tools.ts` — `QUICK_CHAT_EXCLUDED_TOOLS`, the `if (deps.quickChat)` tool-deletion block at the end of `createPMTools`
- `src/bun/agents/engine.ts` — `quickChat` derivation, conditional `list_tasks`/`get_task` inclusion
**Data:** `projects.isQuickChat`
**Watch for:** `effectiveQuickChat` in `run_agent` is derived from the TARGET project (supports cross-project dispatch from a quick-chat PM into a real project, and vice versa) — must not be conflated with the origin conversation's own `deps.quickChat`.

### Cross-project dispatch
`run_agent`/task-execution tools accept an optional `project_id` override so a channel-originated PM turn (WhatsApp/Discord/Email, which has no meaningful "default" project) can dispatch into any project. Resolves `effectiveProjectId`/`effectiveWorkspacePath`/`effectiveQuickChat` from that target project, and registers the abort controller under the target project (not the routing conversation's project) so dashboard agent counts/stop-all operate correctly.
**Key files:**
- `src/bun/agents/tools/pm-tools.ts` — `isCrossProject`, `effectiveProjectId` resolution in `run_agent`
**Data:** `projects`
**Watch for:** cross-project + channel-conversation combination creates/reuses a per-project "channel conversation" (`getOrCreateProjectChannelConversation`) so agent streaming lands in the right place, distinct from the routing conversation that keeps PM replies.

### Plan approval flow (`request_plan_approval` / `create_tasks_from_plan`)
After `task-planner` stages structured task definitions (via `define_tasks`, stored per-project in an in-memory buffer), the PM calls `request_plan_approval` to present a plan card (in-app: broadcast + persisted message; channel: text message asking for "approve"/"reject" reply). On approval, `create_tasks_from_plan` drains the staged definitions and creates real `kanban_tasks` rows, resolving `blocked_by` indices to real task IDs. A code-level enforcement path in `run_agent`'s completion handler shows the approval card automatically even if the PM's own LLM call forgets to call `request_plan_approval` — prevents the PM from presenting a plan as plain, uncommitted text.
**Key files:**
- `src/bun/agents/tools/pm-tools.ts` — `request_plan_approval`, `create_tasks_from_plan` tools; the automatic-approval-card block inside `run_agent`'s `.then()`
- `src/bun/agents/tools/planning.ts` — `peekTaskDefinitions`, `drainTaskDefinitions`, `recordPlanBatch` (staged task-definition buffer, keyed by projectId)
**Data:** `kanban_tasks`, `notes` (the plan document), `messages` (persisted plan card)
**Watch for:** the `hasActiveTasks` guard prevents a spurious re-plan (task-planner called by mistake) from re-showing an approval card over an in-progress workflow.

### `get_next_task` prioritization
Deterministic priority order the PM is instructed to always use instead of manually picking from `list_tasks`: (1) tasks in "review" (wait, or dispatch `code-reviewer` if no reviewer running), (2) tasks in "working" (re-dispatch — likely interrupted), (3) oldest unblocked "backlog" task (respects plan/dependency order via `blocked_by`).
**Key files:**
- `src/bun/agents/tools/pm-tools.ts` — `get_next_task` tool
**Data:** `kanban_tasks` (column, blockedBy, createdAt/updatedAt)
**Watch for:** mirrors (but is independently implemented from) the `nextAction` hint-computation block in `engine.ts`'s `onAgentDone` callback — the two must stay logically consistent or the PM gets contradictory guidance depending on which path fires.

### Auto-continue "Next Action" hint injection
When a dispatched agent completes, `onAgentDone` (in `engine.ts`) computes a deterministic `[Next Action]` hint (WAIT / DISPATCH / MOVE TO REVIEW / REVIEW NEEDED / ALL DONE / BLOCKED / INVESTIGATE) by inspecting live kanban state + running-agent count, then restarts the PM via `sendMessage` with a synthetic `[Agent Report] ...` message carrying that hint. This is what lets the PM "auto-continue" through a task queue without a separate workflow-engine state machine.
**Key files:**
- `src/bun/agents/engine.ts` — `onAgentDone` callback (the large `nextAction` computation block), `isAutoExecuteEnabled` gate
**Data:** `kanban_tasks`
**Watch for:** the `agentFailed` branch deliberately skips DISPATCH hints (forces the PM to investigate rather than blindly re-dispatch into an infinite failure loop); the auto-execute project setting only gates the "DISPATCH next backlog task" decision, not WAIT/REVIEW/DONE/INVESTIGATE.

### Todo list tool + auto-advance
The PM's own lightweight working-memory list (`todo_write`/`todo_read`/`todo_update_item`), persisted in `settings` (not a dedicated table), rendered as a special message in the main chat. `run_agent` accepts `todo_list_id`/`todo_item_id` to auto-mark an item done on successful completion; if the LLM omits those, `autoAdvanceTodo` auto-marks the first pending item done as a fallback.
**Key files:**
- `src/bun/agents/tools/pm-tools.ts` — `todo_write`, `todo_read`, `todo_update_item`, `autoMarkTodoDone`, `autoAdvanceTodo`, `getActiveTodoStatus`
**Data:** `settings` (keys `pm_todos:<conversationId>:<listId>`, `pm_active_todo:<conversationId>`)
**Watch for:** `getActiveTodoStatus` is injected into the `[Agent Report]` restart message so the PM always sees remaining items without re-querying — a message-format change must keep this string parseable/visible to the model.

### PM reasoning / thinking budget
Resolves a per-turn thinking budget with priority: chat-level override > agent (PM) row default > project default. Uses the AI SDK v7 unified `reasoning` option (`buildReasoningOptions`) for standard providers; the "custom" provider type additionally gets an `enable_thinking`-style token count baked into model creation (`THINKING_BUDGET_TOKENS`) for self-hosted models needing that shape instead.
**Key files:**
- `src/bun/agents/engine-types.ts` — `buildReasoningOptions`, `extractPMReasoning`, `THINKING_BUDGET_TOKENS`
- `src/bun/agents/engine.ts` — `pmThinkingBudget` resolution, `pmCustomThinkingTokens`
- `src/bun/agents/agent-loop.ts` — equivalent `buildThinkingOptions`/`effectiveThinkingBudget` for sub-agents (separately resolved per-agent-row + project fallback)
**Data:** `agents.thinkingBudget`, `settings` (`project:<id>:thinkingBudget`, `project:<id>:chatThinkingLevel`)
**Watch for:** known accepted behavior change — Anthropic's SDK maps reasoning levels to a PERCENTAGE of `maxOutputTokens` (10/30/60%) rather than AgentDesk's old fixed token counts, so depth now scales with whatever `maxOutputTokens` resolves to.

### Anthropic prompt caching
For Anthropic, OpenRouter, and Claude Subscription's Haiku sub-path, moves the system prompt into a `system`-role message with `cacheControl: { type: "ephemeral" }` metadata (Anthropic's ~90%-cheaper cache-hit pricing). No-ops for other providers.
**Key files:**
- `src/bun/agents/engine-types.ts` — `applyAnthropicCaching`
**Data:** none
**Watch for:** must be re-applied (`recached = applyAnthropicCaching(...)`) any time `context.messages` is mutated mid-turn (e.g. `prepareStep`'s media follow-up injection, compaction) — a stale cached instructions object would silently drop caching for that step.

### Media follow-up message construction
When a tool call returns real media bytes (`read_image`, `take_screenshot`, `read_audio`, `generate_image`), `buildMediaFollowUpMessage` converts them into a follow-up user message in the one wire format every provider actually accepts as vision/audio input, injected via `prepareStep` in both the PM and sub-agent loops.
**Key files:**
- `src/bun/agents/tools/media-followup.ts` — `buildMediaFollowUpMessage`
- `src/bun/agents/engine.ts` / `src/bun/agents/agent-loop.ts` — both `prepareStep` callbacks
**Data:** none
**Watch for:** relies on `adapter.getFilesApi?.()` — a provider adapter refactor must keep that optional accessor intact or media follow-ups silently stop working for providers that need a Files API upload step.

### Streaming performance indicator
Each `streamText` call's `onLanguageModelCallEnd` reports throughput (`outputTokensPerSecond`/`effectiveOutputTokensPerSecond`) and time-to-first-output, broadcast live to the frontend context bar via `onStreamPerformance`.
**Key files:**
- `src/bun/agents/engine.ts` / `src/bun/agents/agent-loop.ts` — `onLanguageModelCallEnd` handler
- `src/bun/engine-manager.ts` — `onStreamPerformance` callback → `streamPerformance` broadcast
**Data:** none
**Watch for:** a per-call option, distinct from the global Telemetry sink (which has no per-conversation broadcast route) — do not conflate the two when refactoring telemetry.

### Runtime telemetry context
Every `streamText` call passes a `runtimeContext` object (`agentName`, `projectId`, `conversationId`) that flows into every telemetry event, enabling the Analytics/AI Usage page to attribute cost/latency to a specific agent role and project.
**Key files:**
- `src/bun/agents/engine.ts` / `src/bun/agents/agent-loop.ts` — `runtimeContext: { agentName, projectId, conversationId }`
- `src/bun/agents/telemetry-sink.ts` — consumes `runtimeContext`
**Data:** feeds AI Usage analytics tables
**Watch for:** a `streamText`/`generateText` options-shape change must preserve this field or usage attribution silently degrades to provider/model-only.

### Tool-call logging wrapper
Wraps the PM's tool set so every tool call/result is captured for the "Analytics → Messages" prompt-logging view, independent of the AI SDK's own step callbacks.
**Key files:**
- `src/bun/agents/tool-call-logging.ts` — `wrapToolsWithCallLogging`
- `src/bun/agents/engine.ts` — applied once to `pmTools`
**Data:** feeds `logPrompt` (see `prompt-logger.ts`)
**Watch for:** only wraps the PM's tools today — sub-agent tool calls are logged separately via `logPrompt` calls at the end of `runInlineAgent`.

### Pre/Post tool-use hooks
Project-configurable shell-command hooks (`preToolUse`/`postToolUse`) run before/after every sub-agent tool call. A `PreToolUse` hook exiting with code 2 denies the tool call (returns the hook's stdout as the "result" instead of executing). Env vars (`HOOK_TOOL_NAME`, `HOOK_TOOL_INPUT`, `HOOK_TOOL_OUTPUT`, `HOOK_TOOL_IS_ERROR`) are passed to the hook process.
**Key files:**
- `src/bun/agents/agent-loop.ts` — `getHookCommand`, `wrapToolsWithHooks`
**Data:** `settings` (`project:<id>:hook:preToolUse`/`postToolUse`)
**Watch for:** applied only to sub-agents, not the PM's own direct tool calls (e.g. `read_file`, `preview_project`).

### Tool-result error classification
A shared heuristic (`toolResultIsError`) decides whether a tool's string result represents a failure — tools in this codebase catch and return error strings rather than throwing, in several shapes (leading "Error"/"Failed"/"Blocked", `"success":false`, JSON `{error:...}` envelope, `run_shell`'s null `exitCode`). Drives only the UI's ✓/✗ styling — the model always sees the raw text regardless.
**Key files:**
- `src/bun/agents/agent-loop.ts` — `toolResultIsError`, `CONTENT_RESULT_TOOLS` (tools whose content can legitimately start with "Error", e.g. `read_file`)
- `src/bun/agents/engine.ts` — reuses the same `toolResultIsError` import for the PM's own tool-result display
**Data:** none
**Watch for:** kept deliberately conservative to avoid false-flagging legitimate output as an error; a new tool returning errors in a novel shape needs an explicit case here or it silently renders "success" in the UI for a real failure.

### `create_task` access policy
`create_task` is restricted to a single agent (`task-planner`) — the sole author of kanban tasks. Enforced centrally so both the allowlist path and the zero-`agent_tools`-rows "full registry" path (hidden/special agents) can't accidentally grant it elsewhere. The PM itself never gets `create_task` at all (its tool set is hand-assembled in `engine.ts`) — to add a task, the PM must dispatch `task-planner`.
**Key files:**
- `src/bun/agents/tools/create-task-policy.ts` — `CREATE_TASK_AGENT`, `restrictCreateTask`
**Data:** none directly (policy only)
**Watch for:** a new "task-authoring" agent role would need this constant updated, not just a new `agent_tools` row — the allowlist alone isn't the enforcement point.

### Simple dispatch (scheduler `agent_task_simple` mode)
A minimal, BLOCKING `run_agent`/`run_agents_parallel` pair for the project-less scheduled-task mode — unlike the PM's fire-and-forget dispatch (which relies on a persistent conversation to resume via `[Agent Report]`), there's no conversation to resume, so `execute()` awaits `runInlineAgent` to completion and returns the result directly as the tool's output within a single `generateText` `stopWhen` loop.
**Key files:**
- `src/bun/agents/tools/simple-dispatch.ts` — `createSimpleDispatchTools`
**Data:** none (uses `persistToDb: false`, same as Playground)
**Watch for:** duplicates `READ_ONLY_AGENTS`/re-entrancy-guard logic from `pm-tools.ts` in a simplified, single-run-scoped form — a change to the read-only agent set or dispatch-guard semantics must be applied to both.

### Interactive gates — Shell approval & Ask User Question
Two blocking, human-in-the-loop mechanisms that pause a running agent mid-execution: shell command approval (project setting `shellApprovalMode`: "ask"/"auto") and `request_human_input`/`askUserQuestion`. Both broadcast a request to the project's window (or Quick Chat window), persist a pending-approval row for reconnect/restart durability, push an OS desktop notification, and optionally relay to connected channels (Discord/WhatsApp/Email) so a reply can resolve them remotely. Auto-deny/auto-timeout after a fixed window if unanswered.
**Key files:**
- `src/bun/engine-manager.ts` — `installShellApprovalHandler`, `resolveShellApproval`, `askUserQuestion`, `resolveUserQuestion`, `getPendingChannelInteraction`, `reconcilePendingApprovalsOnStartup`
- `src/bun/db/pending-approvals.ts` — durable pending-approval persistence
**Data:** `pending_approvals`
**Watch for:** `getPendingChannelInteraction` assumes at most one open interactive request per project at a time (an invariant of the Sequential Single-Agent Model) — introducing genuine multi-agent concurrency would break its "first match" resolution logic.

### Frontend: inline-agent activity state
The chat store tracks `activeInlineAgent` (badge shown for the currently running sub-agent), `runningAgentCount`, and `pmThinkingText`, driven by `agentInlineStart`/`agentInlineComplete`/`pmThinking` RPC broadcast events. `syncRunningAgents` re-syncs this state from the backend after navigation/reconnect (fixes a stuck spinner if events were missed while the page wasn't mounted).
**Key files:**
- `src/mainview/stores/chat-store.ts` — `activeInlineAgent`, `runningAgentCount`, `stopGeneration`, `stopAgent`, `syncRunningAgents`, `clearActivity`
- `src/mainview/stores/chat-event-handlers.ts` — `onAgentInlineStart`, `onAgentInlineComplete` (event → store updates), `onCompactionStarted`/`onConversationCompacted`
**Data:** none (pure frontend state, hydrated from backend RPC broadcasts)
**Watch for:** `onAgentInlineComplete`'s `clearAgent` logic falls back to "count drops to zero" in addition to messageId match — needed because `syncRunningAgents` restores the badge with a synthetic `sync-<agentName>` messageId that will never match a real completion event's messageId. This is also the exact mechanism that a CLI-bridge-branch rejection (rather than resolution) can starve — see the "Claude Subscription CLI/SDK bridge" entry above.

---

## Kanban & Review Cycle

### Kanban column enforcement (agents cannot skip columns)
Agent-facing `move_task` tool enforces a strict state machine: `backlog → working` and `working → review` are the only forward moves; `working → backlog` and `review → working` are allowed backward moves; `backlog → review` is explicitly rejected. Only the review system (`review-cycle.ts` / `submit_review`) may move a task to `done` — the tool description tells agents "NEVER move a task to done."
**Key files:**
- `src/bun/agents/tools/kanban.ts` — `move_task` (invalid-transition check, done-column lock, position no-op guard)
**Data:** `kanban_tasks.column`
**Watch for:** the transition table is a plain boolean expression inline in `move_task`'s `execute()` — adding a new column or relaxing a transition means editing this one function; the enforcement exists ONLY in the agent tool, not in the RPC layer (see "Human drag-and-drop" below) or the DB.

### Acceptance criteria (creation, checking, gating)
Every task requires at least one acceptance criterion (JSON array of `{text, checked}`, tolerant of plain-text/newline input via `parseCriteria`). `check_criteria`/`check_all_criteria` mark criteria checked with a per-task async lock (`criteriaLocks`) to avoid read-modify-write races from concurrent tool calls. Moving a task to "review" is blocked (`checkAllCriteriaMet`) unless every criterion is checked.
**Key files:**
- `src/bun/agents/tools/kanban.ts` — `parseCriteria`, `normalizeTaskCriteria`, `checkAllCriteriaMet`, `check_criteria`, `check_all_criteria`, `criteriaLocks`
- `src/mainview/components/kanban/task-detail-modal.tsx` — human criteria UI (`parseCriteria` client copy, `toggleCriterion`, `addCriterion`, `removeCriterion`, `doneBlockMessage` client-side Done guard)
- `src/mainview/components/kanban/kanban-card.tsx` — criteria progress badge (`checked/total`)
**Data:** `kanban_tasks.acceptance_criteria` (JSON text column)
**Watch for:** two independent `parseCriteria` implementations exist (backend `agents/tools/kanban.ts` and frontend `task-detail-modal.tsx`) — keep their tolerant-parsing behavior in sync or criteria can silently render/count differently between the agent and the human UI.

### verify_implementation gate before review
Mandatory self-verification tool an implementing agent must call before `move_task("review")` will succeed — checks `task.verificationStatus === "passed"`. Requires a completeness checklist (`all_acceptance_criteria_met`, `ui_reflects_logic`, `logic_supports_ui`, `no_lsp_errors`, `feature_is_user_accessible`); a `pass` verdict with any false checklist item is rejected server-side even if the agent claims pass. On genuine pass: appends a structured "## Completion Report" (JSON: summary, files_changed, decisions_made, api_contracts, follow_up_issues, verification_evidence) to `importantNotes` (append-only, numbered by round via a regex count of prior reports), triggers `autoCommitTask`, then auto-moves the task to "review" and notifies the review cycle.
**Key files:**
- `src/bun/agents/tools/kanban.ts` — `verify_implementation` tool, `verificationStatus` reset logic in `move_task` (cleared on move back to working/backlog)
- `src/bun/agents/handoff.ts` — `extractCompletionReport` / `extractFollowUpIssues` (reads back the same JSON block, taking the LAST match so re-verification rounds don't return stale data)
**Data:** `kanban_tasks.verification_status` ("passed" | "failed" | null), `kanban_tasks.important_notes`
**Watch for:** `verificationStatus` is the sole gate checked by `move_task` — a code path that moves a task to "review" without going through `verify_implementation` (e.g. a future bulk-move RPC) will bypass this entirely, since the RPC layer (`rpc/kanban.ts`) has no equivalent check.

### Auto code-review spawn on move-to-review
Moving a task to "review" (via `verify_implementation` or a raw `move_task("review")` call) fires `notifyTaskInReview(projectId, taskId)`, which spawns an inline `code-reviewer` agent (self-contained — no WorkflowEngine dependency), passing it the task ID, git-diff-finding instructions (using the auto-commit hash if available, else `git log`/`git diff HEAD~1`), and a review checklist. The reviewer is instructed to call `get_task` first (not trust assumptions) and must call `submit_review` before finishing.
**Key files:**
- `src/bun/agents/review-cycle.ts` — `notifyTaskInReview` (main entry point), `spawnReviewAgent`, `activeReviews` Set (duplicate-spawn guard), `isReviewActive`/`getActiveReviewCount`
- `src/bun/agents/tools/kanban.ts` — `notifyTaskInReviewHandler` (dynamic import of `review-cycle.ts` to avoid circular-init issues), called from both `move_task` and `verify_implementation`
**Data:** `kanban_tasks.column`, in-memory `activeReviews` (lost on app restart — a task stuck mid-review after a crash needs a manual nudge)
**Watch for:** `notifyTaskInReview` is fire-and-forget (`(async () => {...})()`), never awaited by callers — errors inside are caught internally and force-complete the task to `done` as a fail-safe; a bug here can silently mark broken work "done".

### submit_review verdict → done / back-to-working
`submit_review` (intended for the code-reviewer agent only, not enforced by role) records `[Review APPROVED]`/`[Review CHANGES REQUESTED]: <summary>` into `importantNotes`, then moves the task directly to `done` (approved) or `working` (changes_requested) via `moveKanbanTask` — bypassing `move_task`'s transition/criteria checks entirely since it calls the RPC layer directly.
**Key files:**
- `src/bun/agents/tools/kanban.ts` — `submit_review` tool
- `src/bun/agents/review-cycle.ts` — `getSubmitReviewDetails` (reads back the most recent `submit_review` tool-call input from `message_parts` for this task, used as the authoritative verdict over the reviewer's free-text summary)
**Data:** `message_parts` (tool_call rows for `submit_review`), `kanban_tasks.important_notes`, `kanban_tasks.column`
**Watch for:** nothing restricts which agent role may call `submit_review` — it's purely a convention encoded in the tool description and the reviewer's dispatch prompt; a misbehaving fix-agent could call it directly to force `done`.

### Review verdict heuristic fallback
If the reviewer never calls `submit_review` (or the agent run didn't complete), `review-cycle.ts` falls back to scanning the reviewer's free-text summary for clean/negative keyword signals (`reviewSummaryHasIssues`) to guess a verdict, and separately detects genuine cancellation (`isAgentCancelled`) vs. failure so a user-initiated stop doesn't get treated as "changes requested."
**Key files:**
- `src/bun/agents/review-cycle.ts` — `reviewSummaryHasIssues`, `isAgentCancelled`
**Data:** none (pure string heuristics over the agent's summary text)
**Watch for:** this is a brittle keyword list (`"lgtm"`, `"no issues"`, `"must fix"`, etc.) — only exercised when the reviewer skips `submit_review`; changes to reviewer prompts that alter its natural phrasing can flip verdicts silently.

### Review rejection → back to working → re-dispatch loop (maxReviewRounds)
On `changes_requested`, the task moves back to `working`, the review-cycle waits (poll loop, 5-minute cap) for any concurrently-running PM-dispatched agent to finish, releases the `activeReviews` guard (so the fix agent's own eventual `move_task("review")` can re-trigger review), then spawns the task's `assignedAgentId` (default `backend-engineer`) as a fix agent with the reviewer's structured per-issue feedback verbatim. Round count (`reviewRounds` in-memory Map) increments each cycle; once `currentRounds >= maxRounds - 1`, the loop force-completes the task to `done` with a warning note instead of looping again. `maxReviewRounds` is read per-project from `settings` (default 2).
**Key files:**
- `src/bun/agents/review-cycle.ts` — `getMaxReviewRounds`, `reviewRounds` Map, the round/force-complete branch inside `notifyTaskInReview`
**Data:** `settings` key `project:<projectId>:maxReviewRounds` (category implicit in key), `kanban_tasks.review_rounds` column (DB-persisted counter — note the review-cycle's actual gating uses the in-memory `reviewRounds` Map, not this DB column; the DB column exists on the schema but isn't the value read for the max-rounds decision)
**Watch for:** round counters and `activeReviews`/`taskCommitHashes`/`taskConversations` are ALL in-memory Maps — an app restart mid-review-cycle resets round counts to 0 (a task could loop past its intended max) and loses the task↔conversation binding.

### Auto-commit before review (autoCommitTask)
When `verify_implementation` passes, `autoCommitTask` stages all changes (`git add -A`) and commits with a configurable message template (`commitMessageFormat` setting, default `"feat: {task}"`, supports `{task}`/`{description}`/`{date}` placeholders), gated by the `autoCommitEnabled` git setting. Initializes a git repo (`ensureGitInit`) if none exists. Captures the resulting commit hash (`taskCommitHashes` map) so the reviewer's dispatch prompt can reference `git show <hash>` directly instead of guessing which commit to diff.
**Key files:**
- `src/bun/agents/review-cycle.ts` — `autoCommitTask`, `ensureGitInit`, `taskCommitHashes` Map
**Data:** `settings` keys `autoCommitEnabled` (category `git`), `commitMessageFormat` (category `git`); no DB table for the commit hash (in-memory only, lost on restart)
**Watch for:** all git failures (add/commit) are logged and swallowed (`console.warn`) — a broken git state (e.g. merge conflict, detached HEAD) silently skips the commit and the reviewer falls back to `git log`/`git diff HEAD~1` instructions, which can point at the wrong commit if other work landed in between.

### Feature branch workflow tie-in
When `featureBranchWorkflow` is enabled for a project, `autoCommitTask` ensures every task's commit lands on the same feature branch: prefers the PM-declared name (`set_feature_branch` tool, AI-generated from recent conversation context, checked against existing branches and PR source branches to avoid collisions) persisted under `currentFeatureBranch:<projectId>`, falling back to a slug derived from the task title if none was set. Creates the branch via `git checkout -b` if it doesn't exist, otherwise switches to it.
**Key files:**
- `src/bun/agents/review-cycle.ts` — feature-branch branch inside `autoCommitTask`
- `src/bun/agents/tools/pm-tools.ts` — `set_feature_branch` tool (AI-named branch generation, dedup against `getGitBranches` + `pull_requests.sourceBranch`)
**Data:** `settings` keys `project:<projectId>:featureBranchWorkflow`, `currentFeatureBranch:<projectId>` (category `git`)
**Watch for:** branch-name collisions are only checked at `set_feature_branch` time (a point-in-time snapshot); a branch created by another process between that check and the first `autoCommitTask` call could still collide.

### Plan → Approve → create_tasks_from_plan (task-planner + PM handoff)
`task-planner` (a read-only agent) calls `define_tasks` during planning to stage structured task definitions (title, description, assigned_agent, priority, blocked_by index array, acceptance_criteria) in-memory AND write-through to `pending_approvals` (survives a desktop restart between planning and approval). If the plan spans both frontend and backend agents, a synthetic "Define shared interfaces and contracts" task (assigned to `software-architect`) is auto-injected as task 0 and all other tasks are re-blocked on it. After the human approves, PM calls `create_tasks_from_plan`, which drains the staged definitions, creates real kanban tasks in `backlog` (resolving `blocked_by` indices to real task IDs), and records the whole batch (`recordPlanBatch`) for later recap generation.
**Key files:**
- `src/bun/agents/tools/planning.ts` — `define_tasks` tool, `taskDefinitionSchema`, `pendingTaskDefinitions`/`getTaskDefinitions`/`drainTaskDefinitions`/`restoreTaskDefinitions`, `recordPlanBatch`/`findCompletedPlanBatch`/`markPlanBatchRecapped`, cross-layer contract-task injection
- `src/bun/agents/tools/pm-tools.ts` — `create_tasks_from_plan` tool, `request_plan_approval` tool (plan card shown to the human; explicitly does NOT re-run task-planner to avoid truncated re-generation)
**Data:** `pending_approvals` table (kind `plan_tasks`, keyed `plan_tasks:<projectId>`), `kanban_tasks` (created rows), in-memory `planBatches` Map (recap tracking, lost on restart)
**Watch for:** `define_tasks` REPLACES the whole pending list on each call (not append) — a task-planner that calls it twice loses the first batch; `create_tasks_from_plan` is a no-op error if definitions were never staged (e.g. task-planner never called `define_tasks`, or the app restarted after planning but before `pending_approvals` was written).

### create_task restricted to task-planner
`create_task` (direct single-task creation, distinct from the plan-batch flow above) is stripped from every agent's tool set except `task-planner` via a small dedicated policy module, applied both to the normal allowlist path and the "zero `agent_tools` rows ⇒ full registry" path.
**Key files:**
- `src/bun/agents/tools/create-task-policy.ts` — `CREATE_TASK_AGENT`, `restrictCreateTask`
**Data:** none (pure in-memory tool-map filtering)
**Watch for:** the PM's own tool set never includes `create_task` at all (built inline in `engine.ts`, omitted directly) — to add a single ad hoc task the PM must dispatch `task-planner`, not call the tool itself.

### get_next_task (execution-order arbitration)
PM tool that centralizes "what should happen next" so the PM never hand-picks from `list_tasks`: (1) any task in `review` → tells PM to wait if a reviewer is already running, else to dispatch `code-reviewer`; (2) any task in `working` → re-dispatch its assigned agent (handles an interrupted run), attaching the most recently completed task's "## Handoff Summary" as `priorWork`; (3) oldest unblocked `backlog` task (`blockedBy` IDs all in the done set) in creation order; (4) `complete` if all tasks are done, else `blocked` listing which tasks are stuck on unmet dependencies.
**Key files:**
- `src/bun/agents/tools/pm-tools.ts` — `get_next_task` tool
**Data:** `kanban_tasks` (column, blocked_by, assigned_agent_id, created_at, updated_at, important_notes)
**Watch for:** the backlog "unblocked" check does a `JSON.parse` on `blockedBy` with a silent catch-and-treat-as-unblocked fallback — a corrupted `blocked_by` value fails open (task becomes dispatchable) rather than failing closed.

### run_agent dispatch guard (Sequential Single-Agent Model)
`run_agent`'s `writeAgentRunning` boolean guard (function-scoped closure state, not persisted) blocks dispatching a second write agent while one is active, and separately blocks dispatching anything new while any task sits in the `review` column (points the PM at `get_next_task`/reviewer dispatch instead). Read-only agents (`code-explorer`, `research-expert`, `task-planner` — the `READ_ONLY_AGENTS` set) are exempt and may run via the parallel path.
**Key files:**
- `src/bun/agents/tools/pm-tools.ts` — `writeAgentRunning`, `run_agent` tool (guard checks near lines with the `"A write agent is already running"` and `"task(s) in review column"` error messages), `run_agents_parallel` tool
- `src/bun/agents/agent-loop.ts` — `READ_ONLY_AGENTS` Set (single source of truth also consumed by `run_agents_parallel`'s validation)
**Data:** none (in-memory closure state per PM tool-set instantiation)
**Watch for:** `writeAgentRunning` lives in a closure captured once per `createKanbanTools`/PM-tools construction — verify its lifetime matches one PM turn/session as intended; a stale `true` from an aborted call path that forgot to reset it (several `if (!isReadOnly) writeAgentRunning = false;` reset sites scattered through `run_agent`'s error branches) would permanently wedge dispatch for that session.

### Handoff notes / completion reports appended to kanban task notes
`importantNotes` is the single free-text ledger for a task's whole lifecycle: `verify_implementation`'s "## Completion Report" (JSON block, round-numbered), `submit_review`'s "[Review APPROVED/CHANGES REQUESTED]" lines, and (for chained sequential tasks) a "## Handoff Summary" generated from the diff of files an agent touched — small diffs get a deterministic regex-based summary (exports, CSS classes, DOM IDs/selectors, Python defs), large diffs get an AI-generated summary, and credential-shaped strings are redacted (`redactSecrets`) before ever being read into a summary or prompt; whole files matching a sensitive-filename pattern (`.env`, `.pem`, `id_rsa`, etc.) are never read, only named. All writes are append-only — never overwritten — so the round-by-round audit trail survives repeated review-reject cycles.
**Key files:**
- `src/bun/agents/handoff.ts` — `generateHandoffSummary`, `redactSecrets`, `SENSITIVE_FILE_RE`, `buildDeterministicSummary`, `extractCompletionReport`, `extractFollowUpIssues`
- `src/bun/agents/tools/kanban.ts` — `verify_implementation`'s append logic (`priorReports` regex count → `roundLabel`), `submit_review`'s append logic, `add_task_notes` tool (freeform append, agent-facing)
**Data:** `kanban_tasks.important_notes` (single unstructured text column carrying multiple structured sub-sections)
**Watch for:** because everything is one text column with regex-parsed sub-sections, any future writer that OVERWRITES `importantNotes` instead of appending destroys the whole audit trail (this exact bug was previously fixed on this path); a new field added here must follow the append convention.

### Plan completion recap
When every kanban task in a previously-recorded `PlanBatch` reaches `done`, the review cycle synthesizes one "Plan Completion Recap" note aggregating each task's completion-report summary (falling back to raw `importantNotes` text), and marks the batch recapped so it never fires twice.
**Key files:**
- `src/bun/agents/review-cycle.ts` — `maybeGeneratePlanRecap` (called from the `finally` block of `notifyTaskInReview` whenever a task lands in `done`)
- `src/bun/agents/tools/planning.ts` — `findCompletedPlanBatch`/`markPlanBatchRecapped`
**Data:** `notes` table (via `rpc/notes.ts` `createNote`), in-memory `planBatches` (lost on restart — mid-plan restart means no recap is ever generated for that batch)
**Watch for:** silent no-op by design when batch tracking was lost to a restart — don't mistake a missing recap note for a bug without checking whether the app restarted mid-plan.

### Auto-continue: PM dispatch of next task after review passes
After a task passes review and moves to `done`, `triggerPMAutoContinue` builds an explicit `[Next Action]` hint (DISPATCH a specific task/agent, ALL DONE, or BLOCKED) and injects it as a synthetic message into the PM's active conversation — deliberately concrete text instead of a vague "continue" to avoid hallucinated re-planning. Respects the project's `autoExecute` setting: when off, a would-be DISPATCH hint is swapped for a PAUSED hint so the PM reports completion and waits for the user instead of auto-dispatching.
**Key files:**
- `src/bun/agents/review-cycle.ts` — `triggerPMAutoContinue`
- `src/bun/rpc/projects.ts` — `isAutoExecuteEnabled` (read live on every call so the Project Settings toggle applies immediately, not just at session start)
**Data:** `kanban_tasks` (queried fresh for backlog/working state), project `autoExecute` setting
**Watch for:** guarded by `eng.isProcessing() || getRunningAgentCount(projectId) > 0` plus a fixed 1s delay to let the review cycle "settle" — a race here (agent starts between the check and the `sendMessage`) would double-dispatch; this is a heuristic wait, not a lock.

### Task dependencies / blocking (blocked_by)
Tasks carry a JSON array of blocker task IDs (`blockedBy`). Enforced only at read/dispatch time (`get_next_task`'s backlog scan, the kanban card's lock-icon UI) — never as a DB constraint or write-time validation. `create_tasks_from_plan` resolves plan-relative indices to real task IDs when creating the batch.
**Key files:**
- `src/bun/agents/tools/pm-tools.ts` — `get_next_task` (blocked-check loop), `create_tasks_from_plan` (index→ID resolution)
- `src/mainview/components/kanban/kanban-card.tsx` — lock emoji + dashed border when `blockedBy` parses to a non-empty array
**Data:** `kanban_tasks.blocked_by` (JSON text column, no FK/constraint)
**Watch for:** nothing prevents a cycle in `blocked_by` (A blocks B blocks A) — such a task would simply never appear "unblocked" in `get_next_task`, silently stalling the plan with no error surfaced anywhere.

### Human drag-and-drop across any column (RPC layer bypasses agent-tool guards)
`dnd-kit`-based board lets a human drag any card to any column. This calls `useKanbanStore.moveTask` → `rpc.moveKanbanTask` → `rpc/kanban.ts`'s `moveKanbanTask` directly — which has NO transition-table check, NO acceptance-criteria check, and NO `verificationStatus` check (those all live only in the agent-facing `move_task` tool in `agents/tools/kanban.ts`). A human can drag a card straight from `backlog` to `done`, or into `review` with unmet criteria, with the RPC layer accepting it unconditionally. The `TaskDetailModal`'s column `<select>` has one client-side-only guard: it refuses to fire `moveTask` to `done` if `doneBlockMessage` (unmet/zero criteria) is set — but this check does not exist for drag-and-drop, and moving into `done` this way never spawns a code-reviewer (that only happens via `notifyTaskInReview`, which is only called from the agent tools).
**Key files:**
- `src/mainview/components/kanban/kanban-board.tsx` — `DndContext`/`handleDragEnd` (computes target column + position from `over`/`active`, calls `moveTask`)
- `src/mainview/stores/kanban-store.ts` — `moveTask` (optimistic update + `rpc.moveKanbanTask`)
- `src/bun/rpc/kanban.ts` — `moveKanbanTask` (unconditional move + activity log + done-column side effects: desktop notification, channel broadcast, `closeExternalIssueForTask`)
- `src/mainview/components/kanban/task-detail-modal.tsx` — `saveColumn` (client-side Done guard, `doneBlockMessage`)
**Data:** `kanban_tasks.column`, `kanban_task_activity` (logs the move with `actorId` null for human-initiated moves via the store, since no actorId is passed through)
**Watch for:** this is the single biggest divergence in the whole area — any new automated-workflow invariant (criteria gating, review spawning, verification status) added to `move_task` must be deliberately considered for the human path too, or a human can trivially skip the entire review cycle by drag-and-drop or the status dropdown.

### Kanban board UI — filtering, sorting, stats, column rendering
Board renders 4 fixed columns (`backlog`/`working`/`review`/`done`) with per-column color theming, live counts, and a "+" add-task affordance per column. Supports client-side search (title/description substring), priority filter, assigned-agent filter, and sort (priority/due-date/created-at) — all computed via `useMemo` over the full task list, not server-side. `KanbanStatsBar` shows per-column + total counts. A "New Conv. per task" per-project toggle (persisted via `project:<id>:newConvPerTask` setting) is surfaced in the filter bar. A "Delete All" action bulk-deletes every task in the project (no column filter, no confirmation dialog shown at this call site).
**Key files:**
- `src/mainview/components/kanban/kanban-board.tsx` — `COLUMNS`, `PRIORITY_ORDER`, filter/sort `useMemo`, `handleNewConvPerTaskChange`, `handleDeleteAll`
- `src/mainview/components/kanban/kanban-column.tsx` — `useDroppable`, column theming (`columnStyles`/`columnLabels`), `SortableContext`
- `src/mainview/components/kanban/kanban-card.tsx` — card rendering (priority badge, criteria progress, due date, blocked lock icon, assigned-agent avatar)
- `src/mainview/components/kanban/kanban-stats-bar.tsx` — `KanbanStatsBar`
- `src/mainview/components/kanban/kanban-filters.tsx` — `KanbanFilters` (search/sort/priority-filter/agent-filter/delete-all/new-conv-toggle controls)
- `src/mainview/pages/project.tsx` — Kanban tab wiring (`activeTab === "kanban"`, mounts `KanbanBoard` + always-mounted `TaskDetailModal`, kanban counts in the tab header)
**Data:** `kanban_tasks` (via `useKanbanStore`), setting `project:<projectId>:newConvPerTask`
**Watch for:** `handleDeleteAll` has no per-item confirmation and no undo — it fires `Promise.all` over every task ID currently loaded, which is filtered-view-independent (deletes ALL tasks in the project regardless of active search/filter, since it maps over `tasks` not `filteredTasks`).

### Real-time board sync (agent-driven changes → live UI)
Every kanban-mutating tool (`create_task`, `update_task`, `move_task`, `check_criteria`, `check_all_criteria`, `add_task_notes`, `delete_task`, `submit_review`, `verify_implementation`) fires a best-effort `notifyKanban` → `broadcastToWebview("kanbanTaskUpdated", ...)` after its DB write. The frontend's `remote-transport.ts` maps this to a `agentdesk:kanban-task-updated` DOM CustomEvent, which the Zustand store listens for and reconciles via a **coalesced** full reload (a burst of moves from one PM run collapses into a single re-fetch once the burst settles, not one re-fetch per event) — but only when the event's `projectId` matches the currently-active project.
**Key files:**
- `src/bun/agents/tools/kanban.ts` — `notifyKanban` helper (lazy dynamic import of `engine-manager` to dodge circular-init)
- `src/mainview/lib/remote-transport.ts` — `kanbanTaskUpdated` event-name mapping
- `src/mainview/lib/rpc.ts` — broadcast subscription wiring (`kanbanTaskUpdated` handler)
- `src/mainview/stores/kanban-store.ts` — `coalescedReloadTasks`, the `agentdesk:kanban-task-updated` window listener, `pendingReloadProjectId`
**Data:** none new — reuses `kanban_tasks` fetched via `getKanbanTasks`
**Watch for:** `notifyKanban` swallows all errors ("board will sync on next manual refresh") — if broadcast silently fails repeatedly, the human board can drift from DB truth until the user manually switches tabs/projects (which re-triggers `loadTasks`).

### GitHub issue linkage on a kanban task
From the task detail modal, a human can create a GitHub issue directly from a task's description (disabled until a description exists) or see the linked issue number if one already exists for that task, via a separate `github_issues` lookup keyed by `taskId`. Moving a task to `done` (via `moveKanbanTask`) best-effort closes any linked external issue across all configured issue sources.
**Key files:**
- `src/mainview/components/kanban/task-detail-modal.tsx` — `createGithubIssue`, `ghIssueNumber`/`ghBusy` state, `rpc.getGithubIssues`/`rpc.createGithubIssueFromTask`
- `src/bun/rpc/kanban.ts` — `closeExternalIssueForTask` call inside `moveKanbanTask`'s done-column branch
- `src/bun/rpc/issues.ts`, `src/bun/rpc/github-issues.ts` — issue-side implementation (`github_issues` is deprecated/read-only, superseded by `external_issues`)
**Data:** `github_issues` (deprecated, read-only) and/or `external_issues` (current unified store) — the modal's read path (`getGithubIssues`) and the close path (`closeExternalIssueForTask`, multi-source) are NOT the same table, worth double-checking during any issue-tracker refactor
**Watch for:** the modal's linked-issue lookup fetches ALL github issues for the project and filters client-side (`issues.find(i => i.taskId === taskId)`) rather than a targeted query — fine at small scale, worth revisiting if a project accumulates many linked issues.

### Kanban task activity log
Every create/update/move logs a row to `kanban_task_activity` (type: created/moved/updated/etc., actorId, JSON `data` snapshot of the change). Exposed via `getTaskActivity`; deleting a task cascades a manual delete of its activity rows first (no DB-level FK cascade).
**Key files:**
- `src/bun/rpc/kanban.ts` — `logActivity`, `getTaskActivity`, the manual cascade in `deleteKanbanTask`
**Data:** `kanban_task_activity` (FK `task_id → kanban_tasks.id`, not `ON DELETE CASCADE` — enforced manually in application code)
**Watch for:** because the FK isn't cascade-configured at the DB level, any NEW code path that deletes a `kanban_tasks` row (bulk delete, migration, etc.) without also deleting matching `kanban_task_activity` rows will leave orphaned activity records.

### Project-level task stats (dashboard rollup)
A raw-SQL aggregate (`SUM(CASE WHEN column='done'...)`) grouped by `project_id` powers the cross-project dashboard cards showing done/total counts, run synchronously via the raw `sqlite` handle rather than Drizzle's query builder.
**Key files:**
- `src/bun/rpc/kanban.ts` — `getProjectTaskStats` (raw SQL, `sqlite.prepare(...).all()`)
**Data:** `kanban_tasks` (raw SQL against the underlying `kanban_tasks` table name)
**Watch for:** hand-written SQL means a schema rename of `kanban_tasks`/`column`/`project_id` won't be caught by TypeScript — must be updated manually alongside any Drizzle schema change to this table.

---

## Providers, Models & AI Analytics

### Provider adapter abstraction (`ProviderAdapter` interface)
Every AI provider (Anthropic, OpenAI, Google, DeepSeek, Groq, xAI, OpenRouter, Ollama, Z.AI, OpenCode, Claude Subscription, custom) is wrapped in a common `ProviderAdapter` interface with `createModel`, `listModels`, `testConnection`, and optional `generateImage`/`getFilesApi`. A factory (`createProviderAdapter`) switches on `providerType` to instantiate the right class.
**Key files:**
- `src/bun/providers/types.ts` — `ProviderAdapter`/`ProviderConfig` interface contract
- `src/bun/providers/index.ts` — `createProviderAdapter()` factory switch, `createProviderAdapterWithFallback()` (primary→fallback on failed `testConnection`), re-exports `getContextLimit`/`getDefaultModel`/`dedupeModels`
**Data:** `ai_providers` table (via `ProviderConfig`)
**Watch for:** Adding a new provider type means updating the `SUPPORTED_TYPES` array AND the switch statement AND `PROVIDER_DEFAULT_MODELS` in `models.ts` AND the frontend `BASE_PROVIDER_TYPE_OPTIONS` — four places, easy to miss one. `LanguageModel` type and `createModel()` signature are AI-SDK-version-sensitive (v7's `LanguageModel` shape, thinking/reasoning options).

### Anthropic adapter
Wraps `@ai-sdk/anthropic`'s `createAnthropic`. Exposes a Files API (`.files()`) for upload-once media. Thinking/reasoning is configured via `providerOptions.anthropic` at the `streamText`/`generateText` call site, not here.
**Key files:**
- `src/bun/providers/anthropic.ts` — `AnthropicAdapter`; live model list via `GET /v1/models`, falls back to hardcoded `ANTHROPIC_MODELS`
**Data:** none directly (reads `ai_providers` row via `ProviderConfig`)
**Watch for:** `getFilesApi()` depends on `@ai-sdk/anthropic`'s `.files()` existing — an AI SDK major bump could change or remove this surface.

### OpenAI adapter (also backs "custom" provider type)
Dual-mode: real OpenAI uses `@ai-sdk/openai`'s `.chat()` (deliberately NOT the Responses API, to keep tool-calling compatibility); any custom base URL uses `@ai-sdk/openai-compatible` instead. Also injects non-standard `enable_thinking`/`thinking_budget` body params for Qwen/vLLM/SGLang-style backends via fetch interception, with runtime self-healing (`THINKING_PARAMS_UNSUPPORTED` set) when a strict backend (e.g. Mistral) 422s on those fields.
**Key files:**
- `src/bun/providers/openai.ts` — `OpenAIAdapter`; `normalizeBaseUrl`, `joinUrl`, thinking-param fetch interceptor, `generateImage()` routes to NVIDIA/Mistral/generic OpenAI-compatible paths by hostname
**Data:** none directly
**Watch for:** the `isCustom` branch is what every "custom OpenAI-compatible" and several first-class-but-OpenAI-compatible providers (Ollama, OpenRouter, Z.AI, OpenCode) implicitly resemble — a v7+ change to `@ai-sdk/openai-compatible`'s request shape affects all of them at once. `THINKING_PARAMS_UNSUPPORTED` is in-memory only (resets on app restart).

### Google (Gemini) adapter
Thin wrapper over `@ai-sdk/google`'s `createGoogle`. No thinking-budget passthrough on `createModel` (second param not used).
**Key files:**
- `src/bun/providers/google.ts` — `GoogleAdapter`; live model list filtered to `generateContent`-capable, `gemini`-prefixed ids
**Data:** none directly
**Watch for:** hardcoded `FALLBACK_MODELS` list goes stale as Gemini model names change; live list is the primary source.

### DeepSeek adapter
Thin wrapper over `@ai-sdk/deepseek`.
**Key files:**
- `src/bun/providers/deepseek.ts` — `DeepSeekAdapter`
**Data:** none directly
**Watch for:** no thinking-budget support in `createModel`; `deepseek-reasoner` relies on the SDK's own native reasoning surfacing.

### Groq adapter
Thin wrapper over `@ai-sdk/groq`. `listModels()` intentionally no longer filters out non-chat models (whisper/tool-use/guard) — the Models page badges them by type instead (`model-classification.ts`).
**Key files:**
- `src/bun/providers/groq.ts` — `GroqAdapter`
**Data:** none directly
**Watch for:** same fallback-list staleness pattern as other adapters.

### xAI (Grok) adapter
Thin wrapper over `@ai-sdk/xai`; live list filtered to `grok`-prefixed ids.
**Key files:**
- `src/bun/providers/xai.ts` — `XaiAdapter`
**Data:** none directly

### Z.AI adapter
OpenAI-compatible (`@ai-sdk/openai-compatible`) against `https://api.z.ai/api/paas/v4`. `listModels()` returns a static list (no live discovery endpoint used).
**Key files:**
- `src/bun/providers/zai.ts` — `ZaiAdapter`; `generateImage()` hits Z.AI's own `images/generations`
**Data:** none directly
**Watch for:** `ZAI_MODELS` is a hand-maintained static list — new GLM releases require a code change, unlike every other adapter's live discovery.

### OpenRouter adapter
OpenAI-compatible against `https://openrouter.ai/api/v1`. `listModels()` also returns a static list (no live fetch here — but see the separate `checkModelToolSupportHandler` RPC which DOES hit OpenRouter's live `/models` for parameter support).
**Key files:**
- `src/bun/providers/openrouter.ts` — `OpenRouterAdapter`
**Data:** none directly
**Watch for:** `OPENROUTER_MODELS` static list goes stale; the important dynamic behavior for OpenRouter is the tool_choice detection (separate feature below), not model listing.

### Ollama adapter (local)
OpenAI-compatible against a local `http://localhost:11434/v1` (or user-configured `baseUrl`). Live model discovery via Ollama's own `/api/tags` (not the OpenAI-compatible `/models` endpoint). `testConnection()` does a two-step check: reachability then a minimal generation.
**Key files:**
- `src/bun/providers/ollama.ts` — `OllamaAdapter`
**Data:** none directly
**Watch for:** hardcoded `apiKey: "ollama"` (Ollama ignores it) — don't accidentally require a real key here. Cost-rate lookup (`model-classification.ts`) special-cases `ollama` as always-free.

### OpenCode adapter (free-tier provider)
OpenAI-compatible against `https://opencode.ai/zen/v1`, defaulting to a `"public"` API key for the free tier. Cross-references the OpenCode `/models` endpoint (primary/authoritative for availability) against the models.dev catalog (secondary filter for which of those are genuinely free, `cost.input === 0`) — both fetched in parallel with independent timeouts, 5-minute in-memory cache.
**Key files:**
- `src/bun/providers/opencode.ts` — `OpenCodeAdapter`, `fetchFreeModels()`
**Data:** none directly
**Watch for:** the dual-source intersection logic (`availableFromApi.filter(id => freeFromCatalog.has(id))`) is fragile — if models.dev restructures its schema or the "opencode" catalog key disappears, `listModels()` silently degrades to API-only (still functional, just unfiltered by free-tier status).

### Claude Subscription adapter — direct-HTTP OAuth path (Haiku only)
Uses Claude Code's own stored OAuth credentials (`~/.claude/.credentials.json`) to call the Anthropic API directly via `createAnthropic({ authToken })` with CLI-mimicking headers (`anthropic-beta`, `user-agent: claude-cli/...`). **Only reliable for Haiku models** — Sonnet/Opus 429 on this path regardless of headers sent (verified empirically, a server-side gate). Auto-refreshes the token on 401 by spawning `claude -p hi`. Caps `max_tokens` at 8192 to avoid exhausting the Max subscription's per-minute output-token quota.
**Key files:**
- `src/bun/providers/claude-subscription.ts` — `ClaudeSubscriptionAdapter`, `isHaikuModel()`, `internalCallModelId()` (routes any tool's own standalone internal LLM call to Haiku when on this provider), `resolveClaudeCliPath()`, `loadOAuthToken`/`tryRefreshOAuthToken`
**Data:** reads `~/.claude/.credentials.json` (not a DB table)
**Watch for:** THE big gotcha for this whole codebase — see CLAUDE.md's "Claude Subscription is a two-path AI provider" critical rule. Any new code that creates/calls an AI provider model directly must gate on `providerType === "claude-subscription" && !isHaikuModel(modelId)` and route non-Haiku through the CLI/SDK runner instead of `createModel()`.

### Claude Subscription — Agent SDK/CLI path (Sonnet/Opus)
Non-Haiku Claude Subscription models route through `@anthropic-ai/claude-agent-sdk`'s `query()`, which spawns the real `claude` CLI subprocess. Takes a single flattened text prompt (no native multi-message array), wraps AgentDesk tools via `tool()`/`createSdkMcpServer()` with `alwaysLoad: true`, and disables Claude Code's own built-in tools (`tools: []`) so only AgentDesk's MCP tools are reachable. Includes a "verify at least one real tool call landed" retry guard (up to `MAX_CONNECTION_RACE_RETRIES`) to catch a race where the CLI answers before tool-discovery settles, plus live per-token streaming via `stream_event`/`includePartialMessages`, and safety-refusal detection (`model_refusal_no_fallback`/`model_refusal_fallback`).
**Key files:**
- `src/bun/providers/claude-subscription-cli-runner.ts` — `runClaudeCliTask()`, `testClaudeSubscriptionSdkConnection()`, `jsonSchemaToZodShape()` (Zod reconstruction from AI-SDK JSON Schema for the SDK's `tool()`)
**Data:** none directly; usage/cost surfaced via `ClaudeCliRunResult.usage`/`costUsd` (cache creation/read tokens only ever populated on this path)
**Watch for:** MUST always pass `settingSources: []` on both `query()` call sites (main runner + connection check) — omitting it loads the user's real `~/.claude/settings.json` and fires their personal Claude Code hooks for every AgentDesk turn (explicit CLAUDE.md rule). Also must always pass `pathToClaudeCodeExecutable` — AgentDesk does not bundle the SDK's optional 249MB native binary. As of 2026-07-16, a safety refusal (`model_refusal_no_fallback`) is captured into a `refusalDetail` fallback and the runner call site in `agent-loop.ts` is wrapped so it always resolves with a `status` rather than rejecting — never regress that.

### Provider factory & fallback
`createProviderAdapter()` switch statement instantiates the right adapter class by `providerType`; `createProviderAdapterWithFallback()` layers automatic primary→fallback switching when the primary's `testConnection()` fails.
**Key files:**
- `src/bun/providers/index.ts`
**Data:** none directly
**Watch for:** the `SUPPORTED_TYPES` const array must stay in sync with the switch cases — nothing enforces it at compile time.

### Provider CRUD (Add/Edit/Delete)
Full lifecycle for saved provider configs: name/type/apiKey/baseUrl/defaultModel/isDefault. Name uniqueness (case-insensitive) and duplicate-baseUrl checks on insert; setting `isDefault` clears the flag on all other rows inside a SQL transaction. Editing a provider clears its `model_capabilities_cache` rows so model-type badges are recomputed.
**Key files:**
- `src/bun/rpc/providers.ts` — `getProvidersList`, `saveProviderHandler`, `deleteProviderHandler`, `getProviderApiKeyHandler`, `normalizeBaseUrl`
- `src/mainview/pages/settings/providers.tsx` — `ProvidersSettings`, `ProviderDialog` (Add/Edit form), `ProviderCard`
**Data:** `ai_providers` table; cascading delete of `model_capabilities_cache`/`model_preferences` rows (FK `onDelete: "cascade"`)
**Watch for:** `apiKey` is stored in plain text in SQLite (documented as "Phase 1, encryption planned later" — still true). The RPC never returns `apiKey` in `getProvidersList` — only via the explicit `getProviderApiKeyHandler` used solely by the edit dialog.

### Test Connection
Two RPC entry points: `testProviderWithCredentialsHandler` (tests unsaved form values, used by the Add/Edit dialog) and `testProviderHandler` (tests a saved provider by id, persists result to `isValid` column). Each adapter's own `testConnection()` implementation does a minimal `generateText` call (or, for Ollama, a reachability probe first).
**Key files:**
- `src/bun/rpc/providers.ts` — `testProviderWithCredentialsHandler`, `testProviderHandler`
- `src/mainview/pages/settings/providers.tsx` — dialog "Test Connection" button + card-level "Test Connection" (fires `agentdesk:provider-test-result` custom DOM event)
**Data:** `ai_providers.isValid` column (0/1)
**Watch for:** the card-level test flow listens for a global `agentdesk:provider-test-result` window CustomEvent rather than awaiting the RPC promise directly — a refactor here needs to preserve that event contract or the "Testing..." spinner never resolves.

### Model catalog discovery (`listModels`)
Every adapter exposes `listModels()`: live network fetch (Anthropic/OpenAI/Google/DeepSeek/Groq/xAI/Ollama/OpenCode) or a static list (OpenRouter, Z.AI) with a hardcoded fallback list on fetch failure. Backs the "Default Model" dropdown in the provider dialog and onboarding.
**Key files:**
- Each `src/bun/providers/*.ts` adapter's `listModels()`
- `src/bun/rpc/providers.ts` — `listProviderModelsHandler` (unsaved credentials, onboarding), `listProviderModelsByIdHandler` (saved provider), `getConnectedProviderModelsHandler` (all providers at once, for the Models settings page)
- `src/bun/providers/models.ts` — `dedupeModels()` (some providers like Mistral list the same id twice)
**Data:** none directly (network-only, not cached in DB)
**Watch for:** `getConnectedProviderModelsHandler` always force-includes the provider's saved `defaultModel` even if the live list omits it (e.g. a renamed/retired model still shown so the UI doesn't silently blank the field).

### Model-type classification & badges (models.dev / AI Gateway catalogs)
Classifies every discovered model id into a taxonomy (`language | embedding | image | video | transcription | speech | realtime | reranking | unknown`) using two shared, 24h-cached network catalogs in tiered fallback: Tier 1 Vercel AI Gateway (`ai-gateway.vercel.sh/v1/models`, authoritative `type` field) → Tier 2 models.dev (`models.dev/api.json`, modality-based inference) → Tier 3 id-substring heuristics (regex on "embed"/"rerank"/"whisper"/"dall-e" etc.) → default "language". Results persist in a DB cache so only genuinely new model ids trigger a network classification.
**Key files:**
- `src/bun/providers/model-classification.ts` — `classifyModels()`, `getGatewayCatalog()`, `getModelsDevCatalog()`, `lookupGateway()`, `resolveModelsDevCatalogKey()`, `idHeuristicType()`
- `src/bun/rpc/providers.ts` — `getModelTypesHandler` (cache-read-through, seeds newly-classified non-chat models as `isEnabled: 0` in `model_preferences` unless the user has an explicit preference)
- `src/mainview/pages/settings/models.tsx` — type filter chips, `ModelTypeBadge` per row
**Data:** `model_capabilities_cache` (provider_id, model_id, model_type, source, computed_at — unique on provider+model), reads/writes `model_preferences`
**Watch for:** classification cache is invalidated wholesale on provider edit (`saveProviderHandler` deletes all `model_capabilities_cache` rows for that provider id) — an AI-SDK bump changing model id formats (e.g. a new vendor-prefix convention) would silently reclassify everything as "unknown"/"default" until the catalogs catch up.

### Cost-rate lookup via models.dev (`getModelCostRate`)
Looks up $/million-token rates for a (provider, modelId) telemetry pair by reusing the same models.dev catalog fetch/cache as classification. Splits the AI SDK's own telemetry `provider` string (always `${base}.${suffix}`, e.g. `"anthropic.messages"`) on `.` to recover AgentDesk's provider-type key. Returns `"free"` for Ollama, `null` for `custom` (no vendor to guess) or an unrecognized model id, or a rate object.
**Key files:**
- `src/bun/providers/model-classification.ts` — `getModelCostRate()`, `getModelsDevCatalogFetchedAt()`
**Data:** none (in-memory catalog cache, no DB table)
**Watch for:** documented known imprecision — `"claude-subscription"` is mapped to the `"anthropic"` catalog entry for pricing purposes even though its Haiku path is a flat-monthly subscription, not metered; telemetry can't distinguish it from a real Anthropic API key's calls (both emit `provider="anthropic.messages"`). A schema change would be needed to fix this properly — don't "fix" it without adding that column.

### Per-agent model/provider override
Each row in the `agents` table can override `providerId`, `modelId`, `temperature`, `maxTokens`, and `thinkingBudget` independently of the project/global default. Edited via the Agents settings page, not the Models page.
**Key files:**
- `src/mainview/pages/agents.tsx` — agent edit form (provider/model/temperature/maxTokens/thinkingBudget fields)
- `src/bun/db/schema.ts` — `agents` table (`providerId`, `modelId`, `temperature`, `maxTokens`, `thinkingBudget` columns)
**Data:** `agents` table
**Watch for:** `null` on any of these columns means "inherit" — code resolving an agent's effective model must fall through to project/global default rather than treating `null` as a hard error.

### Default provider selection
Exactly one `ai_providers` row can have `isDefault = 1`; enforced by clearing the flag on all rows inside a transaction before setting it on the target row (both insert and update paths). `getProvidersList()` always sorts the default provider first.
**Key files:**
- `src/bun/rpc/providers.ts` — `saveProviderHandler` (transaction-wrapped clear-then-set), `getProvidersList` (sort)
**Data:** `ai_providers.isDefault`
**Watch for:** the clear-then-set is wrapped in `sqlite.exec("BEGIN"/"COMMIT"/"ROLLBACK")` directly (bypassing Drizzle's own transaction API) — a schema/driver change touching `src/bun/db/connection.ts` needs to preserve this raw transaction capability.

### Per-model preferences (enable/disable, favorite, last-used)
Global, app-wide (not per-project) sparse preference table: absence of a row implies enabled/not-favorite/never-used. Backs the chat model picker's Latest/Favorites sections and the Models settings page. Includes a bulk "enable/disable all models of a provider" master toggle.
**Key files:**
- `src/bun/rpc/providers.ts` — `getModelPreferencesHandler`, `setModelEnabledHandler`, `setModelsEnabledHandler` (bulk), `setModelFavoriteHandler`, `recordModelUsageHandler`, `upsertModelPreference()` (shared upsert helper)
- `src/mainview/pages/settings/models.tsx` — `ModelsSettings` (search, type-filter chips, per-provider "enable all" switch, per-model favorite star + enable switch); listens for `agentdesk:providers-changed` and `agentdesk:model-preferences-changed` window events for cross-view sync
**Data:** `model_preferences` table (unique on providerId+modelId)
**Watch for:** newly-classified non-chat models (embedding/image/etc.) are auto-seeded as `isEnabled: 0` — "unless the user already has an explicit preference row" — a careless migration or bulk-insert could accidentally clobber a user's explicit re-enable of e.g. an embedding model they use directly.

### `tool_choice` support detection (OpenRouter)
Before letting a sub-agent run on an OpenRouter model, live-checks OpenRouter's `/models` endpoint's `supported_parameters` field for `tool_choice` support; if absent, surfaces a warning in the provider dialog since a forced tool_choice is unreliable there. No-ops (`supportsToolChoice: true`) for every non-OpenRouter provider.
**Key files:**
- `src/bun/rpc/providers.ts` — `checkModelToolSupportHandler`
- `src/mainview/pages/settings/providers.tsx` — `toolChoiceWarning` state, debounced check on model/provider-type change
**Data:** none (live network check only)
**Watch for:** this is the concrete mechanism behind the "toolChoice not portable" pitfall — many providers/gateways (Ollama, several OpenRouter-proxied models) don't reliably honor a forced `tool_choice`; don't assume this check generalizes to non-OpenRouter providers without adding equivalent detection.

### Claude Subscription feature flag & enablement check
`isClaudeSubscriptionEnabled()` is now unconditionally `true` (historically gated behind a locally-installed `claude` CLI marker file; the Agent SDK dependency now handles graceful degradation instead). Frontend calls `getClaudeSubscriptionEnabledHandler` to decide whether to show the "Claude Subscription" option in the provider-type dropdown at all.
**Key files:**
- `src/bun/claude/feature-flag.ts` — `isClaudeSubscriptionEnabled()`
- `src/bun/rpc/providers.ts` — `getClaudeSubscriptionEnabledHandler`
- `src/mainview/pages/settings/providers.tsx` — conditionally appends `CLAUDE_SUBSCRIPTION_OPTION` to the provider-type select
**Data:** none
**Watch for:** kept as a function specifically so the RPC/UI plumbing needs no changes if this ever needs to become conditional again — don't inline `true` at call sites.

### Image generation (per-provider)
Optional `generateImage()` on the adapter interface. Shared generic implementation (`generateImageOpenAICompatible`) covers OpenAI/custom/OpenRouter/Ollama/OpenCode/Z.AI via the standard `images/generations` OpenAI-compatible contract; two hostname-sniffed exceptions (NVIDIA NIM's `genai` endpoint, Mistral's beta Agents/Conversations tool-based flow with no single-call image endpoint) get dedicated implementations.
**Key files:**
- `src/bun/providers/image-generation.ts` — `generateImageOpenAICompatible()`, `generateImageNvidia()`, `generateImageMistral()`, `describeImageGenError()` (maps APICallError status codes to human messages), `hostnameOf()`
- Adapter `generateImage()` methods in `openai.ts`, `zai.ts`, `openrouter.ts`, `ollama.ts`, `opencode.ts`
**Data:** none directly
**Watch for:** NVIDIA/Mistral image models are invisible to `classifyModels()` (they never appear in the chat-models `/v1/models` listing this classification pipeline uses) — there's a separate `DOCUMENTED_IMAGE_MODELS` override elsewhere (`agents/tools/image-gen.ts`) for surfacing them in the UI at all.

### Common outbound HTTP headers
Every provider adapter's outgoing HTTP requests carry a shared `User-Agent`/`HTTP-Referer`/`X-Title` header set (deliberately impersonating an `opencode`-style client), evaluated once at module load.
**Key files:**
- `src/bun/providers/headers.ts` — `PROVIDER_HEADERS`
**Data:** none
**Watch for:** touched by essentially every adapter constructor — a header format some provider starts rejecting would be a single-file fix, but breaks everything simultaneously if changed carelessly.

### Context window limit setting
Per-project (falls back to global) setting controlling when progressive compaction kicks in (60/70/85/90% thresholds elsewhere in the engine). Defaults to 1M tokens; minimum enforced value 1000 (UI enforces a higher min of 50k, step 1000). In-memory cached per project/global key.
**Key files:**
- `src/bun/providers/models.ts` — `getContextLimit()`, `clearContextLimitCache()`, `DEFAULT_CONTEXT_LIMIT`
**Data:** `settings` table, keys `project:<projectId>:contextWindowLimit` and global `contextWindowLimit`
**Watch for:** cache is only cleared via explicit `clearContextLimitCache()` call — a settings-save path that doesn't call this leaves stale limits in memory until restart.

### Default model per provider type
Static per-provider-type fallback (`PROVIDER_DEFAULT_MODELS`) used whenever a provider row has no `defaultModel` set — e.g. `testConnection()` calls, onboarding.
**Key files:**
- `src/bun/providers/models.ts` — `getDefaultModel()`
**Data:** none (hardcoded map)
**Watch for:** must be kept in sync manually as providers retire/rename their flagship models; stale entries only surface as a runtime 404 from the provider, not a build-time error.

### Streaming mode setting (Full / Hybrid / None)
Global (not per-project) setting with three modes: `"hybrid"` (default — most chat surfaces stream live, but Claude Subscription's Sonnet/Opus and sub-agent cards do not), `"none"` (every surface delivers one complete response), `"full"` (everything streams token-by-token, including Claude Subscription Sonnet/Opus and Playground).
**Key files:**
- `src/mainview/pages/settings/streaming.tsx` — `StreamingSettings`, `StreamingMode` type
- Persisted via generic `rpc.getSetting`/`saveSetting("streamingMode", value, "ai")` — no dedicated RPC handler
**Data:** `settings` table, key `streamingMode`, category `ai`
**Watch for:** this setting's real enforcement lives in the engine/agent-loop streaming logic (not this settings-page file) — the three-way behavior described in the UI copy must stay accurate to whatever `agent-loop.ts`/`engine.ts` actually do; this is a common drift point since the UI text is hand-maintained prose describing code elsewhere.

### Prompt debug logging
Toggle to log full outgoing prompts to `<dataDir>/logs/prompts.log` (auto-rotates at 5MB) for raw-text debugging — distinct from the AI Usage analytics tab (which shows token/cost/latency, not raw prompt text). Displayed via the Analytics page's own "Prompts" tab (see below), not just the raw log file.
**Key files:**
- `src/mainview/pages/settings/ai-debug.tsx` — `AiDebugSettings` (toggle, view log, clear log)
- Persisted via `rpc.saveSetting("debug_prompts", checked, "ai")`; log file ops via `rpc.clearPromptLog()`/`rpc.openPromptLog()`
**Data:** `settings` table key `debug_prompts` (category `ai`); log file on disk, not DB
**Watch for:** explicitly unaffected by the telemetry-sink rework — this is a separate, older, regex-parsed logging path (`prompt-logger.ts`) that still exists independently; don't assume telemetry replaces it.

### AI telemetry sink (v7 global telemetry integration)
Single global `Telemetry` interface implementation registered once at app startup (`registerTelemetry()` in `src/bun/index.ts`). Because AI SDK v7 telemetry is "enabled by default when a telemetry integration is registered," every `streamText`/`generateText` call site across 9+ independent surfaces (PM chat, sub-agents, Playground, Council, Freelance chat, Skills search chat, Dashboard agent, scheduler tasks, etc.) reports here automatically with zero per-call-site code changes. One wide events table, not normalized per event kind (`start | language_model_call_end | tool_execution_end | end | abort | error`), correlated by `callId`. Every insert is fire-and-forget/non-fatal.
**Key files:**
- `src/bun/agents/telemetry-sink.ts` — `telemetrySink: Telemetry` object; `onStart`, `onLanguageModelCallEnd`, `onToolExecutionEnd`, `onEnd`, `onAbort`, `onError` handlers; `serializeRuntimeContext()`
**Data:** writes `ai_telemetry_events` (one row per lifecycle event)
**Watch for:** THE highest-blast-radius file for any future AI SDK major bump — it's coupled directly to v7's `Telemetry` interface shape (`OperationStartEvent`/`GenerateTextEndEvent`/etc. field names like `event.performance.responseTimeMs`, `event.usage.inputTokenDetails.cacheReadTokens`). A new AI SDK version changing this interface breaks analytics silently (writes fail non-fatally, so the app keeps running but analytics quietly go blank) rather than throwing where anyone would notice.

### AI telemetry event schema
Deliberately a single wide table (not normalized per event-kind) so every column is nullable except the identifying fields; which columns are populated depends entirely on `eventKind`.
**Key files:**
- `src/bun/db/schema.ts` — `aiTelemetryEvents` (`ai_telemetry_events`) table definition, with indexes on `callId`, `(eventKind, createdAt)`, `(provider, modelId, createdAt)`
**Data:** `ai_telemetry_events`
**Watch for:** any new event kind or field added to the AI SDK's telemetry events needs a matching nullable column here plus a matching `insert()` call in `telemetry-sink.ts` — schema changes require a new Drizzle migration per project convention.

### AI Usage cost & token breakdown view
"AI Usage" analytics tab: total calls, input/output/cache-read/cache-write/reasoning token totals, estimated $ cost (via `getModelCostRate`), $ saved by prompt caching, cost coverage % (how much of total tokens have a known price), tokens-over-time line chart, tokens-by-provider and tokens-by-agent donut charts, cost-by-model table. Filterable by project/agent/provider/day-range.
**Key files:**
- `src/bun/rpc/analytics.ts` — `getTelemetryUsage()` (totals, `byModel` cost breakdown, `tokensPerDay`, `byProvider`, `byAgent`, filter option lists)
- `src/mainview/pages/analytics.tsx` — `UsageTab`, `formatUsd`/`formatTokens`/`formatMs` helpers
- `src/mainview/components/analytics/charts.tsx` — `LineChart`, `DonutChart`, `BarChart`, `StatCard` (shared, reused across all analytics tabs)
**Data:** reads `ai_telemetry_events` (event_kind='end' for token/cost totals); joins back to the 'start' event by `call_id` for project/agent-scoped latency/throughput/tool-stat queries since those events don't carry `runtime_context` themselves
**Watch for:** `costUsd` is `null` (not `0`) when `pricedTokens === 0` and there ARE model-token rows — the UI must keep distinguishing "genuinely $0" from "unknown/unpriced" or costs silently misreport as free. Cost coverage % below 99% triggers an explicit disclaimer in the UI — don't remove that without also fixing the underlying pricing gap.

### Cache hit rate view
Derived stat: `cacheReadTokens / (cacheReadTokens + inputTokens)`, shown as a percentage stat card on the AI Usage tab, alongside a separate "$ saved by caching" stat computed from the delta between full input-rate and cache-read-rate pricing.
**Key files:**
- `src/bun/rpc/analytics.ts` — `getTelemetryUsage()`'s `cacheHitRate`/`costSavedUsd` computation
**Data:** `ai_telemetry_events` (cache_read_tokens, cache_write_tokens, input_tokens columns)
**Watch for:** `costSavedUsd` is only computed when both the input rate AND cache-read rate are known for a model (models.dev catalog) — silently 0 (not "unknown") for unpriced models, unlike `costUsd`'s null-vs-zero distinction. This exists specifically to validate the stable-tool-ordering prompt-caching fix — a regression there would show up as this number dropping.

### Latency & throughput views
p50/p95 response-time and average time-to-first-output stat cards, plus a per-(provider, model) average output-tokens/sec horizontal bar chart. Sourced from `language_model_call_end` events (the only event kind carrying per-call timing), which requires a LEFT JOIN back to the `start` event for project/agent filtering since `language_model_call_end` itself carries no `runtime_context`.
**Key files:**
- `src/bun/rpc/analytics.ts` — `getTelemetryUsage()`'s `latencyRows`/`throughputRows` queries, `percentile()` helper, `joinedEventFilter()`
- `src/mainview/pages/analytics.tsx` — `UsageTab`'s latency stat cards, `BarChart` throughput section
**Data:** `ai_telemetry_events` (event_kind='language_model_call_end': response_time_ms, time_to_first_output_ms, output_tokens_per_second)
**Watch for:** the join-back-to-`start`-event pattern (`joinedEventFilter`) is a workaround for telemetry's own event-shape limitation, not an arbitrary design choice — a future AI SDK version that adds `runtimeContext` to `language_model_call_end`/`tool_execution_end` events directly would let this be simplified, but until then any project/agent-scoped query on those event kinds needs the same join.

### Tool execution stats view
Per-tool call count, average duration, and failure rate table, sourced from `tool_execution_end` events (also requires the join-back-to-`start` for project/agent filtering).
**Key files:**
- `src/bun/rpc/analytics.ts` — `getTelemetryUsage()`'s `toolRows` query
- `src/mainview/pages/analytics.tsx` — tool stats table (`toolStats`)
**Data:** `ai_telemetry_events` (event_kind='tool_execution_end': tool_name, tool_execution_ms, tool_success)
**Watch for:** failure rate is `AVG(1.0 - tool_success)` — `tool_success` is stored as 0/1 integer; a schema change to that column's semantics (e.g. tri-state) would silently corrupt this average rather than error.

### Provider health / error-rate tab
System-wide (no project/agent filter — deliberately, since this is meant as an infra-health view) per-provider call volume, error count/rate (derived from `finish_reason='error'` on `end` events — the only per-provider-attributable error signal telemetry captures), average response time, and a calls-per-day trend line, with a Healthy/Degraded badge at >5% error rate.
**Key files:**
- `src/bun/rpc/analytics.ts` — `getProviderHealth()`
- `src/mainview/pages/analytics.tsx` — `ProvidersTab`
**Data:** `ai_telemetry_events` (event_kind='end', provider, finish_reason, response_time_ms)
**Watch for:** explicitly documented exclusion — the SDK's global `onError` callback carries no `callId`/`provider` (confirmed against the v7 `Telemetry` type), so provider-agnostic errors (e.g. a network failure before any provider/model is resolved) can't be attributed here and are intentionally left out rather than guessed at. An AI SDK version that starts including provider info on `onError` would be a real opportunity to close this gap.

### Prompts tab (raw per-call prompt inspection)
Fourth Analytics sub-tab, sourced from the regex-parsed `prompts.log` file (see "Prompt debug logging" above), not `ai_telemetry_events` — complements the AI Usage tab's aggregate cost/latency stats with the exact raw system prompt + message array actually sent for one specific call. Summary bar (log size/entry count/total tokens), a per-entry stacked token bar chart (system vs. messages, colored by agent, click-to-open), a sortable table, and a detail dialog with System Prompt / Messages sub-tabs — the Messages sub-tab parses the JSON message array into role-colored cards (user/assistant/tool/system, with tool-call/tool-result/reasoning part rendering) rather than a flat JSON dump. Shows an empty state pointing at the Debug toggle when prompt logging is off.
**Key files:**
- `src/bun/agents/prompt-logger.ts` — `getPromptLogStats()` (header-line regex parse, most-recent-first), `getPromptLogEntry()` (full system prompt + messages body for one timestamp)
- `src/bun/rpc-groups/settings-providers.ts` — `getPromptLogStats`/`getPromptLogEntry` handlers; `src/shared/rpc/system.ts` — contract types
- `src/mainview/pages/analytics.tsx` — `PromptsTab`, `TokenBarChart`, `ConversationView`/`MessagePartView`, `PromptDetailDialog`
**Data:** parses `<dataDir>/logs/prompts.log` on each load — no DB table
**Watch for:** was removed in the Phase 4.1 AI Usage rework (2026-07-15) on the assumption the new telemetry-backed tab superseded it, then restored (2026-07-16) once it became clear the two answer different questions — telemetry gives aggregate cost/latency, this gives raw per-call prompt content, which telemetry doesn't and can't capture. Don't re-remove this as "duplicate" of AI Usage.

### Project Dashboard analytics tab (adjacent, non-AI-provider-specific)
Kanban-task-derived stats (tasks over time, by-status/by-priority donuts, activity heatmap, avg completion time) — included here only because it shares the `AnalyticsPage` shell and `charts.tsx` components with the AI Usage/Provider Health/Prompts tabs, not because it reads AI telemetry.
**Key files:**
- `src/bun/rpc/analytics.ts` — `getProjectStats()`, `getAnalyticsSummary()`
- `src/mainview/pages/analytics.tsx` — `DashboardTab`, `AnalyticsPage` (tab shell shared by all four sub-tabs)
**Data:** `kanban_tasks`, `kanban_task_activity`, `messages`, `conversations` (NOT `ai_telemetry_events`)
**Watch for:** not provider/AI-SDK-version-sensitive at all — flagged here only so a reader doesn't mistake it for part of the telemetry surface when scanning `analytics.tsx`.

---

## Tools, Skills, MCP & Plugins

### Tool registry assembly & per-agent filtering
Central registry (`toolRegistry`) merges every static tool module into one map; `getToolsForAgent()` resolves the actual tool set for a given agent name (all tools if the agent has zero `agent_tools` rows, otherwise only the enabled ones), overlaying agent-bound kanban/communication tools and applying `restrictCreateTask`. Results are cached per-agent-name and invalidated via `clearToolCache()`.
**Key files:**
- `src/bun/agents/tools/index.ts` — `toolRegistry`, `registerTools`, `getToolsForAgent`, `getAllTools`, `getToolDefinitions`, `deepResearchStub`
- `src/bun/agents/tools/create-task-policy.ts` — `restrictCreateTask`
**Data:** `agents`, `agent_tools`
**Watch for:** the "zero rows = full registry" fallback silently grants ALL tools (including hidden/dangerous ones) to any agent whose `agent_tools` seeding is incomplete; the module-level cache means a new tool module isn't visible to a running process without `clearToolCache()`.

### Per-run tool overlay & merge order (agent-loop.ts)
Beyond the static registry, `agent-loop.ts` builds the actual per-run tool map by layering: base tools → tracked file tools (bound to a fresh `FileTracker`) → plugin tools (`getPluginTools()`) → MCP tools (`getMcpTools()`) → decisions tool (bound to `workspacePath`) → caller `extraTools` (e.g. Playground overrides) — then conditionally overlays real memory tools (project-bound) and the real `deep_research` tool (research-expert only, runtime-bound to the resolved provider/model). Directory/path tools and shell get a workspace-default wrapper afterward.
**Key files:**
- `src/bun/agents/agent-loop.ts` — tool merge order, workspace-default wrapping for `list_directory`/`search_files`/`directory_tree`/`search_content`/shell
- `src/bun/agents/engine-types.ts` — `getPluginTools()` (filters `getAllTools()` down to names any plugin actually `registerTool()`'d)
**Data:** none directly (in-memory per-run)
**Watch for:** merge order matters — `extraTools` intentionally overrides built-ins (Playground's auto-approved shell); a new tool module added to the static registry but not layered here won't get its per-run bindings (tracking, workspace scoping) even if present in `getAllTools()`.

### File read/write/edit tools (untracked, static registry)
Core file manipulation tools: `read_file`, `write_file`, `edit_file`, `multi_edit_file`, `patch_file` (fuzzy unified-diff apply with up to 50-line offset), `append_file`, `delete_file`, `move_file`, `copy_file`, `list_directory`, `search_files`, `search_content` (ripgrep-backed with JS-grep fallback), `directory_tree`, `file_info`, `is_binary`, `create_directory`, `download_file`, `checksum`, `batch_rename`, `file_permissions`, `archive` (zip/tar.gz), `find_dead_code`, `diff_text`.
**Key files:**
- `src/bun/agents/tools/file-ops.ts` — all tool definitions; `validatePath` (workspace-boundary enforcement); `requireContent`/`requireArg` (guards against models omitting body); `readFileText` (BOM-preserving)
- `src/bun/agents/tools/text-edit.ts` — `literalReplace`, `detectEol`, `toLf`/`fromLf` (EOL/BOM-robust matching for edit_file/patch_file)
**Data:** none
**Watch for:** `validatePath` is the only directory-traversal guard for the static (untracked) tools — the tracked variants add a workspace + `allowedPaths` boundary on top; `EMPTY_REJECT_EXTENSIONS` blocks blank writes for code/markup files unless `allowEmpty` is set, which affects Playground's html/js output.

### Tracked file tools (per-agent-instance, freshness-checked)
`createTrackedFileTools()` produces read/write/edit/multi_edit/patch/append/delete/move variants bound to a per-run `FileTracker` — `edit_file`/`multi_edit_file`/`patch_file` reject with "modified externally" if the on-disk mtime changed since the agent last read/wrote the file (detects a concurrent agent or external edit). These override the static registry entries at runtime.
**Key files:**
- `src/bun/agents/tools/file-tracker.ts` — `FileTracker` class (`track`, `checkFreshness`, `trackWrite`, `getModifiedFiles`)
- `src/bun/agents/tools/file-ops.ts` — `createTrackedFileTools()`, `FileConflictCallback`
**Data:** none (in-memory, GC'd per run)
**Watch for:** freshness check has only 1ms mtime tolerance — filesystems with coarse mtime resolution could false-positive "modified externally"; the tracker is never persisted, so it can't detect cross-process conflicts spanning restarts.

### Tool-output truncation
Caps tool output at line/byte limits (default 500 lines/40KB, tool-specific presets for read_file/shell/search/tree); overflow is saved to a temp file on disk (`truncated-outputs/`) with a hint pointing the model to `read_file` with a line range. 7-day retention cleanup.
**Key files:**
- `src/bun/agents/tools/truncation.ts` — `truncateOutput`, `initTruncationDir`, `truncateReadFile`/`truncateShellOutput`/`truncateSearchResults`/`truncateTree`, `cleanupTruncationFiles`
**Data:** none (writes to `<userData>/truncated-outputs/`)
**Watch for:** if `initTruncationDir` is never called, it silently falls back to OS temp — any change to app-data path resolution should verify this still gets initialized at startup.

### Shell execution with approval gating
`run_shell` executes commands via a resolved cross-platform shell (Git Bash on Windows, zsh on macOS, bash/sh on Linux), blocks a hardcoded list of dangerous patterns, and — unless `autoApprove` — calls a pluggable `ShellApprovalHandler` before running, with a per-project "always allow" session set. Kills the whole process tree (Windows: `taskkill /t /f`; Unix: process-group SIGTERM→SIGKILL) on abort/timeout.
**Key files:**
- `src/bun/agents/tools/shell.ts` — `makeShellTool`, `resolveShell`, `isBlockedCommand`, `setShellApprovalHandler`, `resetShellAutoApprove`, `sessionAutoApprovedProjects`, `autoApprovedShellTool` (used by freelance/skills-search/recommendations contexts, no gate)
**Data:** none (approval handler is wired in-memory from engine/RPC layer)
**Watch for:** `sessionAutoApprovedProjects` MUST stay per-project — collapsing it to a single boolean would let approving one project's shell command silently auto-approve every other project's agents too; `contextSchema` (projectId/conversationId) is how the AI SDK v7 runtime-context mechanism attributes a call to the right project instead of "whichever engine touched most recently."

### Background process management
`run_background` spawns a long-running detached process (stdout/stderr redirected to a log file, never inherited fds — avoids leaking the AI provider's keep-alive socket into a child on Windows), confirms liveness via a 600ms probe, and returns a `jobId`. `check_process` tails its log; `kill_process` process-tree-kills it; `list_background_jobs` enumerates all tracked jobs. Playground uses `killJobsUnderPath`/`getRunningJobsUnderPath`/`killJobById` to manage dev servers scoped to a workspace path.
**Key files:**
- `src/bun/agents/tools/process.ts` — `startBackgroundJob`, `jobStore` (module-level, shared across all agents in-process), `killJobsUnderPath`, `getRunningJobsUnderPath`, `killJobById`
**Data:** none (in-memory `jobStore`, max 100 jobs with LRU-ish pruning)
**Watch for:** `stdio: "ignore"` is load-bearing — passing inherited fds re-introduces the Windows socket-leak bug that hung the next streamed model call; `jobStore` is process-global, so jobs survive across projects/agents until explicitly killed or the app restarts.

### System/environment introspection tools
`environment_info` (OS/runtime/paths/allowlisted env vars), `get_env` (reads named env vars, blocks anything matching a secret-name pattern), `get_agentdesk_paths` (DB/logs/LSP/plugins paths), `sleep` (capped at 30s, abortable).
**Key files:**
- `src/bun/agents/tools/system.ts` — `SAFE_ENV_KEYS` allowlist, `SECRET_PATTERNS` regex, `MAX_SLEEP_MS`
**Data:** none
**Watch for:** `SECRET_PATTERNS` is a name-based heuristic (`key|token|secret|password|credential|auth|private|apikey|api_key`) — a secret stored under a differently-named env var would leak through `get_env`.

### Git tools
`git_status`, `git_diff`, `git_commit` (applies the configured commit-message template), `git_branch` (list/create/switch), `git_push` (never executes directly — returns `{requiresApproval, command}` for the engine to gate), `git_pull`/`git_fetch` (auto-authenticate GitHub remotes via `githubAuthPrefix`), `git_log`, `git_pr` (create/list GitHub PRs via REST API, token resolved per-project), `git_stash` (save/pop/list/drop), `git_reset` (soft/mixed only — `--hard` intentionally unsupported), `git_cherry_pick` (auto-aborts on conflict).
**Key files:**
- `src/bun/agents/tools/git.ts` — all git tool definitions; `getGitSetting`/`formatCommitMessage`
- `src/bun/lib/git-runner.ts` — `runGit`
- `src/bun/rpc/github-api.ts` — `githubAuthPrefix`, `resolveGitHubToken`
**Data:** `settings` (category `git`, e.g. `commitMessageFormat`), GitHub token resolution
**Watch for:** `git_push` returning `requiresApproval` rather than running is the ONLY safety gate on pushes — any refactor of the engine's approval-handling must preserve honoring that shape; GitHub auth must keep going through `gitAuthArgs`/`githubAuthPrefix`, never a stored credential helper (see CLAUDE.md's GitHub rule).

### Web search tool (multi-engine fallback)
`web_search` tries Exa → Tavily → DuckDuckGo (first configured/available engine wins), each with retry-with-backoff on 429/5xx. Supports rolling (`dateRange`) or exact (`startDate`/`endDate`) date filtering per engine's own API shape.
**Key files:**
- `src/bun/agents/tools/web.ts` — `webSearchTool`, `exaSearch`/`tavilySearch`/`ddgSearch`, `SearchEngineError`, `fetchWithRetry`, date-range helpers
**Data:** `settings` (category `integrations`: `exa_api_key`, `tavily_api_key`)
**Watch for:** DuckDuckGo path scrapes HTML via regex — fragile to DDG markup changes; a wrong API key returns a distinct 401/403 `SearchEngineError` rather than falling through silently.

### Web fetch & HTTP request tools
`web_fetch` (HTML-stripped-to-text page fetch, capped at 15K chars by default, up to 100K via `maxChars`) and `http_request` (raw arbitrary-method HTTP call for API testing, no HTML stripping). Both share an SSRF guard (`isBlockedUrl`) blocking loopback/private/link-local/cloud-metadata hosts.
**Key files:**
- `src/bun/agents/tools/web.ts` — `webFetchTool`, `httpRequestTool`, `fetchPageText` (shared with deep_research), `isBlockedUrl`, `BLOCKED_HOSTNAME_PATTERNS`, `stripHtml` (html-to-text based)
**Data:** none
**Watch for:** SSRF guard is hostname/scheme-based only (no DNS-rebinding protection) — proportionate for engine-returned URLs in deep_research, not a hardened gateway; changing `fetchPageText`'s never-throw contract would break deep_research's parallel-fetch-many-URLs loop.

### Deep research tool (research-expert only)
Runs its own internal multi-step LLM loop inside a single tool call: plan sub-queries → search+dedupe → fetch up to 12 full pages in parallel (concurrency-capped) → optional one refinement round on an evaluated gap → synthesize a long-form cited markdown report. Never asks clarifying questions (must run unattended via schedules). The static registry only holds a stub (`deepResearchStub`); the real, runtime-bound tool is built per-run in `agent-loop.ts` bound to the resolved provider/model (internally swapped to Haiku for Claude Subscription via `internalCallModelId`).
**Key files:**
- `src/bun/agents/tools/deep-research.ts` — `createDeepResearchTool`, `plannerSystem`/`evaluatorSystem`/`synthesisSystem`, `coercePlan`/`coerceEvaluation`, `fetchSourcesWithConcurrencyCap`
- `src/bun/agents/tools/index.ts` — `deepResearchStub` (registry placeholder)
**Data:** none
**Watch for:** the stub must NEVER execute directly (indicates an upstream wiring bug); internal timeout (8 min) is deliberately under the shared 30-min run budget — best-effort partial report is returned if interrupted mid-synthesis.

### Multimodal tools — screenshot, image read/generation, audio read
`take_screenshot` (headless Chrome/Chromium PNG capture of a URL or project's Dev Server URL), `read_image` (PNG/JPG/GIF/WebP/BMP, resized to fit 1280px longest edge, re-encoded JPEG), `generate_image` (auto-picks an image-capable model from configured providers, OpenAI-compatible-shaped providers only), `read_audio` (WAV/MP3 only — no transcoding, Anthropic doesn't support audio input at all). All route the actual base64 bytes through a synthetic follow-up user message (`buildMediaFollowUpMessage`) rather than the tool-result text, since only Anthropic's API supports real media in a tool-result block.
**Key files:**
- `src/bun/agents/tools/screenshot.ts` — `takeScreenshotTool`, `readImageTool`, `captureScreenshot` (Chrome discovery via `CHROME_PATHS`), `resizeToFit` (Jimp), `extractImagePayload`, `imageToolModelOutput`
- `src/bun/agents/tools/image-gen.ts` — `generateImageTool`, `findEligibleImageModel`, `DOCUMENTED_IMAGE_MODELS` (hardcoded provider/model overrides undiscoverable via `/models`)
- `src/bun/agents/tools/audio.ts` — `readAudioTool`, `extractAudioPayload`, `SUPPORTED_AUDIO_EXTS`
- `src/bun/agents/tools/media-followup.ts` — `buildMediaFollowUpMessage`, `IMAGE_TOOL_NAMES`/`AUDIO_TOOL_NAMES`, Files-API upload-by-reference path (Anthropic/OpenAI only) vs. inline-base64 fallback
**Data:** `settings` (project-scoped `devServerUrl`), `ai_providers`, `model_capabilities_cache`
**Watch for:** the base64 payload must never leak into the tool-result text on OpenAI-compatible providers (tokenizes character-by-character, can blow a small model's context budget) — any new media tool must follow the same `toModelOutput` strip + follow-up-message re-delivery pattern, and must be added to `IMAGE_TOOL_NAMES`/`AUDIO_TOOL_NAMES` in `media-followup.ts` or its bytes will silently never reach the model.

### LSP diagnostics/navigation tools
`lsp_diagnostics` (errors/warnings, single or parallel multi-file), `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_document_symbols` — all spawn/reuse a language server on demand via the LSP plugin.
**Key files:**
- `src/bun/agents/tools/lsp.ts` — all tool definitions, `ensureOpen` (opens/notifies documents), `formatDiagnostics`, `severityLabel`, `symbolKindLabel`
- `src/bun/plugins/lsp-manager/index.ts` — `getOrSpawnServer`, `openDocs`, `pluginSettings`
- `src/bun/lsp/servers.ts` — `getServerForExtension`
**Data:** none directly (LSP server processes are managed by the LSP plugin)
**Watch for:** LSP diagnostics are also auto-appended as a suffix to file-ops write/edit results via `notifyFileChange` — a change to the LSP plugin's file-change callback contract affects both this tool file and every write/edit tool in `file-ops.ts`.

### Decisions log tool (`log_decision`)
Appends architectural/design decisions to `DECISIONS.md` in the workspace, factory-created per-run bound to `workspacePath`; also mirrors the file into the project's Docs tab (upserts a note titled "DECISIONS.md").
**Key files:**
- `src/bun/agents/tools/notes.ts` — `createDecisionsTool`
**Data:** `notes` (RPC), workspace `DECISIONS.md` file
**Watch for:** project lookup for the Docs-tab mirror matches by workspace-path basename substring (`like` query) — fragile if two projects share a folder-name suffix; failure of that sync is intentionally non-fatal (decision is still logged to disk).

### Notes/docs tools (create_doc, update_doc, list_docs, get_doc, delete_doc)
CRUD over project documents, available to all agents; resolves a `project_id` that may be a UUID or a (partial, case-insensitive) project name.
**Key files:**
- `src/bun/agents/tools/notes.ts` — `notesTools`, `resolveProjectId`
- `src/bun/rpc/notes.ts` — `createNote`/`updateNote`/`getProjectNotes`/`getNote`/`deleteNote`
**Data:** `notes` table, `projects`
**Watch for:** `resolveProjectId`'s partial-name fallback can silently match the wrong project if names overlap.

### Per-agent-per-project memory tools
`save_memory`/`recall_memory`/`delete_memory` — durable, per-(agent,project) facts distinct from `log_decision` (shared architectural decisions) and `notes` (project docs). An always-on compact index (title+description, up to 30 items) is injected into the agent's system prompt every run; full content is pulled on-demand via `recall_memory`. Soft cap 50 (warns to consolidate), hard cap 100 (LRU-evicts coldest on insert). Registry holds unbound stubs; `agent-loop.ts` overlays the real bound tools only when `projectId`+`agentName` are known.
**Key files:**
- `src/bun/agents/tools/memory.ts` — `createMemoryTools`, `getMemoryIndex`, `buildMemoryIndexSection` (prompt injection), `evictColdest`, unbound `memoryTools` stubs
**Data:** `agent_memories` (unique `(project_id, agent_name, title)` dedup index)
**Watch for:** re-saving an existing title updates in place (not a duplicate) — any change to the dedup/eviction logic must preserve the "re-save = update" contract agents are told about in the tool description.

### request_human_input tool (ask-user-a-question)
Blocks the calling agent until the human answers (or the engine's timeout elapses), popping both an in-app modal and an OS desktop notification; supports free-text or multiple-choice (`options`). Factory-created per-agent so the dialog can show the asking agent's display name.
**Key files:**
- `src/bun/agents/tools/communication.ts` — `createCommunicationTools`, `communicationTools` (static default bound to `"unknown"`)
- `src/bun/engine-manager.ts` — `askUserQuestion` (lazy-imported to avoid a static import cycle)
**Data:** none directly (pending-question state lives in `engine-manager.ts`)
**Watch for:** `contextSchema`'s `projectId` (AI SDK v7 runtime-context) is what attributes the question to the agent's actual project rather than whichever project's engine was touched most recently — a regression here would misroute question dialogs across projects.

### Skill-invocation tools (read_skill, read_skill_file, find_skills, validate_skill)
`read_skill` loads a named skill's resolved `SKILL.md` content plus a synthesized "mandatory compliance" checklist (extracts `MANDATORY`-flagged file links from the content); `read_skill_file` reads a supporting file (path must be inside a known skills directory, binary/size-guarded); `find_skills` keyword-searches only *installed* skills (bundled + user); `validate_skill` re-parses a skill directory and reports frontmatter/naming/line-count/bloat-file issues (used after an agent authors/edits a skill).
**Key files:**
- `src/bun/agents/tools/skills.ts` — all four tool definitions, `extractMandatoryFiles`
**Data:** none directly (delegates to `skillRegistry`)
**Watch for:** `read_skill_file`'s path check only verifies the string starts with the bundled/user dir prefix — a change to path normalization (e.g. adding symlink support) must keep this a real containment check, not just a prefix string match.

### Skills system — registry, loading, resolution
`SkillRegistry` singleton loads bundled skills first (from `skills/` at project root in dev, `Resources/app/bun/../skills` in production) then user skills (`<userData>/skills`, which override bundled by name). Each `SKILL.md` is YAML-frontmatter + markdown, validated for name pattern/length, dir-name match, description length. Content resolution runs bash-injection (`` !`command` ``, 10s timeout) then argument substitution (`$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `${AGENTDESK_SKILL_DIR}`, `${AGENTDESK_SKILLS_USER_DIR}`). Skills can be `hidden` (available to agents, not shown in UI) or gated by a `feature` flag (e.g. "freelance").
**Key files:**
- `src/bun/skills/registry.ts` — `SkillRegistry` class (`loadAll`, `reload`, `getByName`, `search`, `resolveContent`, `deleteSkill`), `dir`/`bundledDir` getters
- `src/bun/skills/loader.ts` — `parseSkillFile`, `validateSkill`, `scanSkillsDirectory`, `loadAllSkills`, `executeBashInjections`, `substituteArguments`, `resolveSkillContent`, `NAME_PATTERN`
- `src/mainview/pages/skills.tsx`, `src/mainview/components/skills/skills-search-chat-modal.tsx` — Skills settings UI
**Data:** none (filesystem-only; no DB table for skill metadata)
**Watch for:** deleting a skill refuses if `isBundled`; a user skill silently overriding a bundled skill of the same name is intended behavior but easy to forget when debugging "why isn't my skill update showing up" (check both dirs); `executeBashInjections` runs arbitrary shell commands embedded in `SKILL.md` content with only a 10s timeout — any skill source outside the app's own bundled/user dirs must never be trusted blindly.

### MCP client integration
`initMcpClients()` reads `mcpServers` config from `settings` (category `mcp`), spawns each server (stdio `StdioClientTransport` for local commands, `StreamableHTTPClientTransport` falling back to `SSEClientTransport` for `http(s)://` URLs), lists its tools, and wraps each as an AI SDK `dynamicTool()` keyed `{serverName}_{toolName}`. Auto-retries failed/disconnected servers with exponential backoff (5s→80s, max 5 attempts). `getMcpTools()` returns the flattened tool map from all currently-connected servers, merged into every agent's per-run tool set in `agent-loop.ts`.
**Key files:**
- `src/bun/mcp/client.ts` — `initMcpClients`, `reloadMcpClients`, `shutdownMcpClients`, `disconnectMcpServer`, `reconnectMcpServer`, `getMcpTools`, `getMcpStatus`, `connectServer`, `scheduleRetry`
- `src/mainview/pages/settings/mcp.tsx` — MCP server config UI (add/edit JSON config, connection status)
**Data:** `settings` (category `mcp`, key `mcp_config` — JSON `{ mcpServers: {...} }`, double-encoded via `saveSetting`)
**Watch for:** a hardcoded special-case forces safe screenshot parameters (`fullPage: false, format: jpeg, quality: 80`) for any MCP tool literally named `take_screenshot` regardless of what the agent passes — a naming collision with a differently-behaved third-party MCP tool of the same name would silently mangle its args; tool keys are sanitized (non-alphanumeric → `_`) so two servers with colliding sanitized names would clobber each other's tools in the merged map.

### Plugin architecture
Plugins (built-in in-code like `lsp-manager`, or filesystem-scanned from bundled `plugins/` or `<userData>/plugins`) export `activate(api)` plus optional `onInstall`/`onEnable`/`onDisable`/`onUninstall` lifecycle hooks and an optional `deactivate()`. `PluginAPI` lets a plugin register tools (namespaced `plugin__{pluginName}__{toolName}`, added to the shared static registry via `registerTools`), hooks, file-change callbacks (LSP diagnostics), and UI extension points (sidebar items, project tabs, settings sections, chat commands, themes). Enable/disable state and per-plugin JSON settings persist in the `plugins` table; `getPluginTools()` filters the full static registry down to whichever tool names any *currently activated* plugin actually registered.
**Key files:**
- `src/bun/plugins/index.ts` — `initPlugins()` (scans built-in-in-code + filesystem plugins, activates each with an event-loop yield between)
- `src/bun/plugins/registry.ts` — `activatePlugin`, `deactivatePlugin`, `uninstallPlugin`, `enablePlugin`, `disablePlugin`, `getPluginInstances`, `getLoadedPluginManifest`, `notifyFileChange` (fans out to every enabled plugin's file-change callbacks — powers LSP diagnostics on file write/edit)
- `src/bun/plugins/api.ts` — `createPluginAPI` (the `PluginAPI` implementation each plugin's `activate()` receives)
- `src/bun/plugins/loader.ts` — `scanPluginDirectory` (validates `manifest.json`, dynamic-imports `index.ts`)
- `src/bun/plugins/manifest.ts` — `validateManifest`
- `src/bun/plugins/types.ts` — `PluginManifest`, `PluginModule`, `PluginAPI`, `PluginInstance` type contracts
- `src/bun/plugins/extensions.ts` — sidebar/project-tab/settings-section/chat-command/theme registration
- `src/mainview/pages/plugins.tsx`, `src/mainview/pages/plugin-db-viewer.tsx` — Plugins settings UI / DB browser plugin page
**Data:** `plugins` table (name, version, enabled, JSON settings, optional `prompt` snippet injected into agent system prompts when enabled)
**Watch for:** `loadedPlugins` (all scanned plugins) vs. `instances` (only activated/enabled ones) are two separate in-memory maps — `getLoadedPluginManifest` deliberately reads the former so a disabled plugin still shows real metadata in Settings; a plugin's `registerTool` calls go into the SAME shared static `toolRegistry` as built-in tools, so a plugin tool name colliding with a built-in or another plugin's tool name silently overwrites the earlier one.

---

## Channels, Notifications & Inbox

### Channel adapter abstraction & registry
Common interface (`ChannelAdapter`) that Discord/WhatsApp/Email all implement (`connect`, `disconnect`, `sendMessage`, `onMessage`, `getStatus`, optional `getDefaultRecipient`/`logout`), plus a module-level manager that owns live adapter instances, config cache, and the incoming-message pipeline.
**Key files:**
- `src/bun/channels/types.ts` — `ChannelAdapter`, `ChannelConfig`, `IncomingMessage`, `SendOptions`, `ChannelPlatform` (`"discord" | "whatsapp" | "email" | "chat"`)
- `src/bun/channels/manager.ts` — `registerAdapter`, `initChannelManager`, `connectSingleChannel`, `disconnectChannel`, `shutdownChannelManager`, `getChannelStatuses`, `getAdapterStatus`, `getChannelPlatform`
- `src/bun/channels/index.ts` — barrel export of the public manager API
**Data:** `channels` table (`platform`, `projectId`, `config` JSON blob, `enabled`)
**Watch for:** `adapterFactories` must be registered (via `registerAdapter`) before `initChannelManager` runs at boot, or enabled channels silently skip connecting; `connectingChannels` guard prevents concurrent `connectSingleChannel` races — don't bypass it.

### Discord bot connection & message relay
`discord.js` `Client` wrapper with gateway intents for guild messages; connects with a bot token, listens for `messageCreate`, relays to the adapter's message handler, and exponentially backs off reconnects on `shardDisconnect`.
**Key files:**
- `src/bun/discord/bot.ts` — `DiscordBot` class (`connect`, `sendToChannel`, `shutdown`, `scheduleReconnect`)
- `src/bun/channels/discord-adapter.ts` — `DiscordAdapter` (wraps `DiscordBot` into the common `ChannelAdapter` shape)
- `src/bun/rpc/discord.ts` — `getDiscordConfigs`, `saveDiscordConfig`, `deleteDiscordConfig`, `testDiscordConnection`, `getDiscordStatus`, `setDiscordStatusGetter`
- `src/mainview/pages/settings/discord-settings.tsx` — bot token / server / channel ID setup UI
**Data:** `channels` (platform=`discord`, config = `{token, serverId, channelId}`)
**Watch for:** reconnect logic destroys the old `Client` before creating a new one to avoid `InvalidStateError`; outbound replies always target the Discord channel snowflake (`msgChannelId`), never the username — breaking that mapping misroutes replies.

### WhatsApp QR pairing & message relay (Baileys)
`@whiskeysockets/baileys` multi-device socket with a SQLite-backed auth-state store (creds/keys persisted per channel), QR-code pairing broadcast to the renderer, self-message echo prevention, and exponential-backoff reconnects.
**Key files:**
- `src/bun/channels/whatsapp-adapter.ts` — `WhatsAppAdapter` (`connect`, `onQR`, `sendMessage`, `logout` vs `disconnect`, `getDefaultRecipient`, echo-prevention via `sentMessageIds`)
- `src/bun/channels/whatsapp-auth-store.ts` — `useSQLiteAuthState` (Baileys `AuthenticationState` backed by `whatsapp_sessions` table, `BufferJSON` (de)serialization)
- `src/bun/channels/manager.ts` — `broadcastQR` (converts raw QR string → PNG data URL via `qrcode` package, emits `whatsappQR` webview event)
- `src/bun/rpc/whatsapp.ts` — `getWhatsAppConfigs`, `saveWhatsAppConfig`, `deleteWhatsAppConfig` (calls `disconnectChannel(id, {logout:true})`), `getWhatsAppStatus`, `connectWhatsApp`, `getDefaultChannelProject`/`setDefaultChannelProject`
- `src/mainview/pages/settings/whatsapp-settings.tsx` — QR display (`agentdesk:whatsapp-qr` window event), connect/disconnect UI
**Data:** `channels` (platform=`whatsapp`), `whatsapp_sessions` (`channelId`, `creds`, `keys`)
**Watch for:** `logout()` (permanent device unlink, used on delete) vs `disconnect()` (transient teardown that must preserve the session for reuse) — conflating them forces users to re-scan a QR unnecessarily; AI replies are prefixed with `🤖 *AgentDesk PM:*` since both user and bot messages render as the same green "sent by you" bubble on WhatsApp.

### Email polling (IMAP IDLE) & sending (SMTP)
`imapflow` IDLE loop (with a 60s poll fallback) watches for new mail by UID (immune to other clients marking messages seen), extracts plain-text bodies (handles base64/quoted-printable), and sends replies via `nodemailer` SMTP with `inReplyTo`/`references` threading headers.
**Key files:**
- `src/bun/channels/email-adapter.ts` — `EmailAdapter` (`connect` verifies IMAP+SMTP, `startIdleLoop`, `processEmail`, `sendMessage`)
- `src/bun/rpc/email.ts` — `getEmailConfigs`, `saveEmailConfig`, `deleteEmailConfig`, `testEmailConnection`
- `src/mainview/pages/settings/email-settings.tsx` — IMAP/SMTP host/port/user/pass/TLS form
**Data:** `channels` (platform=`email`, config = full IMAP+SMTP credential JSON, stored in plaintext in the DB)
**Watch for:** `lastProcessedUid` is initialized to the current INBOX ceiling on first connect (so old mail isn't replayed) and only advances forward — a bug here either floods the agent with historical mail or silently drops new mail; IMAP socket `error` events are caught explicitly to avoid crashing the process.

### Message chunking for outbound delivery
Splits long agent replies (PM responses, plan text, scheduler results) into ≤1800-char chunks at paragraph/newline/space boundaries before sending to any channel, since Discord/WhatsApp/SMTP all have practical or hard message-length limits.
**Key files:**
- `src/bun/channels/chunker.ts` — `chunkMessage(text, maxLength=1800)`
- Called from `src/bun/engine-manager.ts` (PM response relay), `src/bun/agents/tools/pm-tools.ts` (plan-approval relay to channel)
**Data:** none (pure function)
**Watch for:** every new "send agent output to a channel" call site must chunk first — an unchunked `sendMessage` call risks silent truncation/rejection by the underlying platform API.

### Project-channel binding (bound vs global mode)
A channel row's `projectId` determines routing: bound mode ties a channel 1:1 to a project; global mode (`projectId = null`) falls back to an explicit `default_channel_project_id` setting, then to an auto-created per-platform "`<Platform> Chat`" project, then (last resort) to the oldest project — so an inbound message is never dropped.
**Key files:**
- `src/bun/channels/manager.ts` — `handleIncomingMessage` (routing precedence), `getOrCreateGlobalChannelProject` (auto-creates/reuses `"WhatsApp Chat"` etc.), `getOrCreateProjectChannelConversation`
- `src/bun/rpc/whatsapp.ts` — `getDefaultChannelProject`/`setDefaultChannelProject` (the explicit global-mode override, stored under `settings.default_channel_project_id`)
**Data:** `channels.projectId`, `settings` (key `default_channel_project_id`, category `channels`), `projects` (auto-created `"<Platform> Chat"` rows)
**Watch for:** the per-platform global project is matched case-insensitively by name to avoid duplicates on concurrent inbound messages (race handled via re-read-after-create-failure); changing `PLATFORM_DISPLAY_NAME` renames the auto-created project going forward but does NOT rename existing ones.

### Two-way sync: channel → app → channel
Inbound channel messages are (1) persisted to the inbox, (2) native-OS-notified, (3) prefixed with platform/sender context and forwarded into the bound project's `AgentEngine` as a normal PM turn (or routed to resolve a pending question/shell-approval instead — see below), and outbound PM stream completions are relayed back to the originating channel/thread.
**Key files:**
- `src/bun/channels/manager.ts` — `handleIncomingMessage` (full pipeline), `sendChannelMessage` (outbound, attaches `replyToMessageId`/`subject` from `lastInboundContext`), `getOrCreateChannelConversation` (daily `channel:<channelId>:<projectId>:<date>` conversation, reused across the day)
- `src/bun/engine-manager.ts` — `onStreamComplete` callback (relays `usage.content` back via `sendChannelMessage` + `chunkMessage`, only when `meta.source !== "app"`), `linkAgentResponseToInbox` (patches the originating inbox row's `agentResponse`)
**Data:** `conversations` (channel-sourced rows use `channel:` id prefix), `inbox_messages` (`agentResponse` column)
**Watch for:** `lastInboundContext` is an in-memory `Map` (channelId → last sender/thread/subject) — lost on restart, so a reply sent immediately after an app restart (before any new inbound message) falls back to `channelId` itself as the recipient, which is wrong for WhatsApp/Email (right for Discord where channelId IS the recipient).

### Approval / question relay to channels (shell approval, ask-user-question)
Blocking shell-approval and `AskUserQuestion` requests are pushed simultaneously to the desktop UI, an OS toast, AND connected channels (as a scheduler-style broadcast); a channel reply of "allow/deny/always" (shell) or free text (question) resolves the same in-memory pending promise the UI would have resolved, short-circuiting the normal PM-turn routing.
**Key files:**
- `src/bun/engine-manager.ts` — `installShellApprovalHandler`, `askUserQuestion`, `resolveShellApproval`, `resolveUserQuestion`, `getPendingChannelInteraction`, `isQuestionChannelNotifyEnabled` (setting: `question_channel_notify`), `getPendingApprovals`/`reconcilePendingApprovalsOnStartup` (durability re-surfacing)
- `src/bun/channels/manager.ts` — `parseShellDecision` (interprets free-text as allow/deny/always), the `getPendingChannelInteraction` check inside `handleIncomingMessage` that intercepts a would-be new PM turn
- `src/bun/db/pending-approvals.ts` — `savePendingApproval`/`deletePendingApproval`/`loadPendingApprovalsByProject`/`loadStaleInteractiveApprovals` (write-through SQLite mirror of the in-memory `pendingShellApprovals`/`pendingUserQuestions` maps)
**Data:** `pending_approvals` (migration `v48_pending-approvals.ts`; kinds `shell`/`question`/`plan_tasks`)
**Watch for:** `getPendingChannelInteraction` assumes at most one open interactive request per project (true only because of the sequential single-agent model) — if that model ever changes, this needs a request-id-aware lookup instead of "first match"; on process restart every persisted shell/question row is orphaned and must be explicitly expired (`reconcilePendingApprovalsOnStartup`), not silently left dangling.

### Task-done / scheduler-result channel broadcast
When a kanban task reaches "done" or a cron/scheduled agent run finishes, a summary is broadcast to every *connected* channel — Discord always (to its configured channel snowflake), WhatsApp/Email only if there's a known recipient (self-JID or prior inbound sender).
**Key files:**
- `src/bun/channels/manager.ts` — `broadcastTaskDoneNotification` (setting: `task_done_channel_notify`), `broadcastSchedulerResult`
- `src/bun/rpc/kanban.ts` — calls `broadcastTaskDoneNotification` when a task's status flips to done
**Data:** `settings` (key `task_done_channel_notify`, category `notifications`)
**Watch for:** silently skips any adapter whose `getStatus() !== "connected"` — a channel stuck in `"connecting"`/`"error"` never gets these broadcasts and there's no retry/queue.

### Desktop OS notifications
Two independent notification code paths: a native Windows Toast implementation (via a hidden, no-window PowerShell subprocess borrowing a pre-registered AUMID, since dev-mode apps lack their own) for background-alert use cases (shell approval, user question), and a simpler `Utils.showNotification` path gated by per-platform/per-project preferences for regular inbound channel messages.
**Key files:**
- `src/bun/notifications/desktop.ts` — `sendDesktopNotification` (Windows Toast via hidden PowerShell; macOS/Linux via Electrobun `Utils.showNotification`)
- `src/bun/notifications/native.ts` — `sendNativeNotification` (checks `shouldNotify` prefs before calling `Utils.showNotification` directly — does NOT go through `desktop.ts`)
- `src/bun/rpc/notifications.ts` — `getNotificationPreferences`, `saveNotificationPreference`, `shouldNotify` (mute-until + per-platform/per-project sound/badge/banner flags, fail-open if no row)
- `src/mainview/pages/settings/notification-settings.tsx` — per-platform/per-project notification prefs UI
**Data:** `notification_preferences` (`platform`, `projectId`, `soundEnabled`, `badgeEnabled`, `bannerEnabled`, `muteUntil`)
**Watch for:** `native.ts`'s `sendNativeNotification` (used for every inbound channel message) and `desktop.ts`'s `sendDesktopNotification` (used only for shell-approval/user-question) are two separate, non-unified notification paths — a future consolidation must preserve both the mute/preference gating in one and the Windows AUMID workaround in the other; the AUMID toast intentionally sets `activationType="background"` to avoid stealing focus/foregrounding a stray PowerShell window on click.

### Unified inbox aggregation & message store
Single `inbox_messages` table aggregates messages from all channels (plus internal `"chat"`/`"scheduler"` pseudo-platforms) with read/archive/favorite state, priority, category, and FTS5 full-text search; a rules engine can auto-tag/route/mark-read on write.
**Key files:**
- `src/bun/rpc/inbox.ts` — `writeInboxMessage` (entry point every adapter/engine call goes through), `getInboxMessages`, `markAsRead`/`markAsUnread`/`markAllAsRead`, `archiveInboxMessage`/`unarchiveInboxMessage`, `favoriteInboxMessage`/`unfavoriteInboxMessage`, `bulkArchiveInboxMessages`/`bulkDeleteInboxMessages`/`bulkMarkAsReadInboxMessages`, `searchInboxMessages` (FTS5 with LIKE fallback), `replyToInboxMessage`, `updateAgentResponse`
- `src/bun/rpc/inbox-rules.ts` — `applyInboxRules` (built-in urgent/asap/critical → priority bump, plus user-defined condition/action rules), CRUD (`getInboxRulesList`, `createInboxRule`, `updateInboxRule`, `deleteInboxRule`)
- `src/bun/rpc-groups/channels-inbox-scheduler.ts` — RPC handler registration for all of the above plus Discord/WhatsApp/Email/notifications/cron/automation
- `src/mainview/pages/inbox.tsx` — `InboxPage` (master-detail list/preview, Inbox/Favorites/Archived view toggle, channel/category/read filters, bulk action bar, live-updates via `agentdesk:inbox-message-received`/`inbox-response-updated` window events)
- `src/mainview/components/inbox/inbox-rules-editor.tsx` — rules CRUD UI
- `src/shared/rpc/inbox.ts`, `src/shared/rpc/integrations.ts` — RPC contract types (`ChannelRow`, inbox message shape, etc.)
**Data:** `inbox_messages` (+ `inbox_fts` virtual FTS5 table, kept in sync via triggers), `inbox_rules`
**Watch for:** `isFavorite` is an *exclusive* cross-cutting view (like Gmail Starred) — every other query (`getInboxMessages`, `searchInboxMessages`, `getUnreadCount`) must explicitly exclude `isFavorite=1` rows unless the caller is the Favorites view itself, or a starred message will leak into bulk actions performed from Inbox/Archived; ID-list bulk ops are chunked at 500 to stay under SQLite's `SQLITE_MAX_VARIABLE_NUMBER`.

### Channel message threading
Each platform surfaces a native thread/reply id (WhatsApp `stanzaId`, Email `Message-ID`/`In-Reply-To`, Discord has none) that's captured as `IncomingMessage.threadId`, persisted on the inbox row, and used both to group messages in the Inbox detail pane and to attach `inReplyTo`/`references` when replying by email.
**Key files:**
- `src/bun/channels/types.ts` — `IncomingMessage.threadId`, `SendOptions.replyToMessageId`
- `src/bun/channels/whatsapp-adapter.ts` (quoted-message `stanzaId`), `src/bun/channels/email-adapter.ts` (`envelope.inReplyTo || envelope.messageId`)
- `src/mainview/pages/inbox.tsx` — `threadGroups` (client-side grouping by `threadId`), thread display in `MessageDetailPane`
**Data:** `inbox_messages.threadId`
**Watch for:** Discord has no concept of `threadId` here (channel-level relay only, not Discord's native thread feature) — don't assume all three platforms behave symmetrically.

### Channel-relay message metadata
Routed PM turns from channels get a `[<platform> thread:<id>] <sender>: ` prefix so the agent has channel context in its own conversation; `source`/`channelId`/`username` are threaded through `engine.sendMessage`'s metadata so replies can be relayed back correctly and so QuickChat/kanban tools can distinguish channel-original vs app-original turns.
**Key files:**
- `src/bun/channels/manager.ts` — `sourceMap`, `enrichedContent`/`platformPrefix` construction in `handleIncomingMessage`
- `src/bun/agents/engine.ts` — consumes `{source, channelId, username}` via `getActiveMetadata()`
**Data:** none (in-memory metadata only, not persisted beyond the enriched message text)
**Watch for:** `getActiveMetadata()` resets to `DEFAULT` when the PM restarts after an agent completes — any new channel-relay code must derive `channelId` from the conversation ID (`channel:<channelId>:...`) as a fallback, not rely solely on live metadata.

---

## Project Chat Page, Dashboard, Quick Chat & Composer Features

### Project Page tab bar
The Project page (`ProjectPage`) is a single component owning a tab bar plus lazy per-tab content; it force-selects the Chat tab on every project switch and shows a running-agent badge + kanban column counts pinned to the right of the tab bar. Plugin-contributed tabs are appended dynamically after the built-in ones.
**Key files:**
- `src/mainview/pages/project.tsx` — `ProjectPage`; tabs are `chat` (`ChatLayout`), `kanban` (`KanbanBoard`), `notes` labeled "Docs" (`NotesTab`), `git` (`GitTab`), `issues` labeled "Issue Tracker" (`IssueTrackerTab`), `remote` (`RemoteSyncTab`), `deploy` (`DeployTab`), `settings` (`ProjectSettingsTab`), plus `plugin:<name>:<id>` tabs from `rpc.getPluginExtensions()`
**Data:** `projects`, `agent_tasks` (kanban counts), unread-store (client-only)
**Watch for:** the effect that resets `conversationsLoadedForProject` synchronously and re-derives `activeTab="chat"` on every `projectId` change — a race here re-introduces "the stale project's conversations flash into the new project" bug.

### Unread-activity dots (per-tab/leaf)
Chat/Issue-Tracker tabs and the Dashboard project card show unread dots driven by a client-only Zustand store; opening a project marks its card seen, opening the Chat tab (or new activity while it's active) marks chat seen.
**Key files:**
- `src/mainview/stores/unread-store.ts` — `hasUnread`, `hasUnreadPrefix`, `hasAnyUnread`, `markSeen`, `markCardSeen`
- `src/mainview/pages/project.tsx` — wiring for the `chat` and `issue-fixer` prefixes
**Data:** none (client-only, not persisted server-side)
**Watch for:** unread state is purely in-memory per window — a second window or app restart loses "seen" state; don't assume it survives reload.

### Chat tab shell (ChatLayout)
Hosts the conversation sidebar, message list, composer, model-selector row, and the resizable Activity/Context panel; owns focus mode (hides both side panels), font zoom, drag-and-drop file attach, `/clear` `/fork` slash-command wiring, markdown export, and shell-approval-request rendering for the active project only (filtered from a global store list).
**Key files:**
- `src/mainview/components/chat/chat-layout.tsx` — `ChatLayout`; `fileToBase64` (chunked base64 encode — avoids a 600KB-1MB `String.fromCharCode` stack-overflow bug), `handleSend`, `handleExportMarkdown`, `handleResizeStart`
**Data:** `conversations`, `messages`, `settings` (`chat-focus-mode` in localStorage, not DB)
**Watch for:** `ConversationSidebar` is invoked here WITHOUT `onArchive`/`onRestore` props — archive/restore only exists in the sidebar component's own context-menu code path, unreachable from the main Chat tab today; don't assume archiving works end-to-end without wiring those props.

### Conversation sidebar (list/create/rename/pin/delete/bulk-delete)
Collapsible left panel listing conversations for the active project: create, inline rename, pin/unpin (context menu), single delete (confirm dialog), and a "Bulk Deletion" select-mode with multi-select + confirm. Archive/restore UI exists in this component but isn't wired from `ChatLayout` (see above).
**Key files:**
- `src/mainview/components/chat/conversation-sidebar.tsx` — `ConversationSidebar`
**Data:** `conversations` table (title, isPinned, updatedAt)
**Watch for:** archived-conversations rendering path (`archivedConversations` prop) is effectively dead code from the main Chat tab since no caller passes it a non-empty array or the archive/restore handlers.

### Chat header bar controls
Row above the message list: conversation-sidebar toggle, active conversation title, "Clear Chat" (double-click confirm), new-conversation button, Focus Mode toggle (collapses both side panels + the app's main sidebar via a `CustomEvent`), font-size zoom in/out (with a transient `%` hint pill), message search toggle (also bound to Ctrl/Cmd+F), export-as-Markdown, and the Activity Pane toggle.
**Key files:**
- `src/mainview/components/chat/chat-layout.tsx` — the header block
**Data:** none (all client state; conv font size persisted via `useConvFontSize`)
**Watch for:** Focus Mode dispatches `agentdesk:focus-mode-enter`/`-exit` `CustomEvent`s that the app shell listens for to collapse its own sidebar — renaming/removing these events breaks focus mode's main-sidebar half silently (no compile error).

### Message search (in-chat find)
Ctrl/Cmd+F opens an inline search bar over the message list; highlights all matches across visible messages, shows a match count, and steps forward/backward (Enter / Shift+Enter, or the chevrons) scrolling+ring-highlighting the matched message.
**Key files:**
- `src/mainview/components/chat/message-search.tsx` — `MessageSearch`
- `src/mainview/components/chat/message-bubble.tsx` — `SearchHighlight`/`highlightChildren` (renders the `<mark>` highlights)
**Data:** none (searches only the already-loaded `messages` array client-side)
**Watch for:** the regex is built from raw user input with only regex-metacharacter escaping — fine for search-highlighting, but don't reuse this pattern anywhere content-injection-sensitive.

### Message list rendering & auto-scroll
Renders the sorted/filtered message array (hides empty PM turns unless they have parts, hides `sub_agent_result`/`agent_report` metadata messages), shows quick-start prompt chips on an empty conversation, a typing-dots row before the first token, and a floating "Responding…"/"Compacting…" pill plus scroll-to-bottom button. Auto-scroll uses a `MutationObserver` (childList/characterData) plus a captured `load` listener so syntax-highlighted code blocks, Mermaid diagrams, and images don't leave the view mid-page.
**Key files:**
- `src/mainview/components/chat/message-list.tsx` — `MessageList`, `MessageErrorBoundary` (catches a single bad message's render crash), `TypingRow`, `WaitingRow` (currently unreachable — `showWaitingRow` is hardcoded `false` since "PM no longer waits for agents")
**Data:** `messages`, `message_parts`
**Watch for:** `WaitingRow`/`showWaitingRow` is dead code today — don't assume it renders; if agent-waiting UX is reintroduced, this is the pre-built (but currently bypassed) component for it.

### Message bubble (text/markdown rendering)
Renders one message: react-markdown + remark-gfm + rehype-sanitize with custom component overrides (code blocks, Mermaid fenced blocks, tables, links opened via `rpc.openExternalUrl`), a shell-JSON auto-detected terminal card, user-attachment chips/previews, and a hover action row (Copy, Save to Collection, Retry [last assistant msg only], Delete, Fork-from-here [user msgs], timestamp, and — for the PM/sub-agent's last response — the model-id label when `showModelName` is set).
**Key files:**
- `src/mainview/components/chat/message-bubble.tsx` — `MessageBubble`, `AttachmentPreviews`, `extractAttachmentChips` (recovers attachment chip labels from the persisted `<attached-file>` context tags rehype-sanitize would otherwise strip on reload)
**Data:** `messages.metadata` (JSON: `type`, `modelId`, `attachments`, `reasoning`)
**Watch for:** `extractAttachmentChips`'s regexes must stay in sync with exactly how `chat-layout.tsx`'s `handleSend` wraps attachment context (`<attached-file>`, `[Attached image: ...]`, etc.) — drifting either side silently reintroduces an "empty bubble after reload" bug.

### Plan message card (approval UI)
A `metadata.type === "plan"` message renders as a distinct amber card (title, markdown body) with an Approve/Reject footer; Reject opens an optional feedback textarea. If an earlier plan exists in the same conversation, a "Show changes" toggle renders a line-level diff against it.
**Key files:**
- `src/mainview/components/chat/message-bubble.tsx` — `PlanApprovalFooter` (sends the literal strings `"approve"` / `"reject <feedback>"` as a chat message)
- `src/mainview/components/chat/plan-diff.tsx` — `PlanDiff` (LCS-based line diff with context-collapsing)
**Data:** `messages.metadata` (`type: "plan"`, `title`)
**Watch for:** approval is just a magic string sent as a normal chat message (`"approve"`/`"reject ..."`) — the PM's system prompt/tool-loop must keep recognizing these exact strings; changing the wording here without updating the PM side silently breaks the approval gate.

### Todo-list message card
A `metadata.type === "todo_list"` message renders as a live checklist card (pending/in-progress/done icons, `done/total` header count) instead of markdown — used for PM-visible task tracking mid-turn.
**Key files:**
- `src/mainview/components/chat/message-bubble.tsx` — inline `isTodoList` branch
**Data:** `messages.metadata` (`type: "todo_list"`, `items: [{id,title,status}]`)
**Watch for:** purely a rendering branch — there's no interactivity (can't check items from the UI); it only reflects whatever the agent last wrote.

### Inline agent execution rendering (message parts / "Activity")
The actual live "agent dispatch + tool call" activity feed lives inline in the message list (not a separate pane): `MessageParts` groups a message's parts into `agent_start…agent_end` blocks (collapsible, colored by agent, live Stop button + elapsed timer while running, retry-on-error) and renders `tool_call`/`reasoning`/`text` children inside each block via `ToolCallCard`/`ThinkingBlock`/`TextBlock`. Persisted parts are fetched via `rpc.getMessageParts`; live parts stream in via `agentdesk:part-created`/`agentdesk:part-updated` window events.
**Key files:**
- `src/mainview/components/chat/message-parts.tsx` — `MessageParts`, `AgentStartBlock`, `AgentEndBlock`, `ThinkingBlock`, `TextBlock`, `AGENT_COLORS`/`AGENT_BADGE_COLORS`
- `src/mainview/components/chat/message-bubble.tsx` — the `parts`-loading effect and live-event listeners
**Data:** `message_parts` table (type, toolName/Input/Output/toolState, sortOrder, timeStart/End, agentName)
**Watch for:** collapse/expand state per agent block is persisted in `chat-store`'s `collapsedAgentBlocks` (keyed by the `agent_start` part id) — a schema/id-shape change to parts breaks that persistence silently (defaults back to expanded, not an error).

### Tool call card (per-tool rendering)
Collapsible card per tool call with a per-tool icon/summary registry (`TOOL_META`) and specialized input/output renderers: syntax-highlighted file reads/writes, unified diffs for `edit_file`/`multi_edit_file`/`patch_file`, a terminal-styled ANSI-to-HTML view for `run_shell`, inline images for screenshot/`read_image`/`generate_image` (two JSON envelope shapes), and JSON pretty-printing fallback. Auto-expands image tools on success.
**Key files:**
- `src/mainview/components/chat/tool-call-card.tsx` — `ToolCallCard`, `TOOL_META`, `ToolInputDisplay`, `ToolOutputDisplay`, `ansiToHtml`, `InlineImage` (also reused by the Dashboard chat widgets)
**Data:** `message_parts` (toolName/toolInput/toolOutput/toolState)
**Watch for:** `TOOL_META` is a hand-maintained registry keyed by exact tool name — a renamed/new built-in tool falls back to a generic Wrench icon + raw name (not broken, just unstyled) until added here.

### Shell approval card
Renders a pending `run_shell` approval request inline in the chat with Deny/Allow/Allow-for-session buttons; auto-dismisses 2s after a decision, and shows a non-interactive "Approval expired" state for requests that timed out or were orphaned by a restart.
**Key files:**
- `src/mainview/components/chat/shell-approval-card.tsx` — `ShellApprovalCard`
- `src/mainview/stores/chat-event-handlers.ts` — `persistShellApprovalDecision`
**Data:** in-memory `shellApprovalRequests` (chat-store), filtered per-project in `ChatLayout`
**Watch for:** requests are filtered client-side by `projectId` from a store that receives ALL projects' broadcasts — don't assume the store itself is project-scoped.

### Chat composer (text input, send/stop, drafts)
Auto-resizing textarea with per-conversation draft persistence (survives navigation/restart), Enter-to-send/Shift+Enter-newline, Up-arrow recall of last sent message, and a character counter past 10k chars. Handles three parallel "modes": normal, shell (`!` prefix, red-tinted, executes via `rpc.executeShellCommand` and posts an ephemeral, non-AI-visible terminal bubble), and message-queueing while the PM is busy (queue capped at `MESSAGE_QUEUE_MAX`, expandable list with per-item remove).
**Key files:**
- `src/mainview/components/chat/chat-input.tsx` — `ChatInput`, `handleSend`, `executeShell`, draft-persistence effect
- `src/mainview/stores/message-queue.ts` — queue store (`enqueue`/`remove`/`clear`/`loadQueue`), drained server-side by `engine-manager.ts`'s idle check, not the frontend
**Data:** drafts in `chat-store` (client-only, not persisted server-side)
**Watch for:** the queue is drained by the BACKEND's idle-check, not a frontend effect — the frontend queue view is just a staleness-guarded mirror; don't add frontend-side auto-send logic that would race the backend drain.

### Slash commands & `@` file mentions
Typing `/` at the start of an empty-context input opens a slash-command popover (`/clear /compact /fork /info /init /mcp /new /preview`, with `/compact` hidden below 50% context utilization); typing `@` opens a debounced file-search popover, and selecting a file inserts/toggles an `@path` mention chip whose content gets read server-side and injected as implicit context on send.
**Key files:**
- `src/mainview/components/chat/chat-input-popover.tsx` — `useInputPopover`, `SLASH_COMMANDS`, `buildFileItem`
- `src/mainview/components/chat/chat-input.tsx` — `handleSlashSelect`, `handleFileSelect_mention`, `searchFiles`
**Data:** none for slash commands (client dispatch); mentioned files are read live via `rpc.readWorkspaceFile`
**Watch for:** slash-command IDs (`clear`/`compact`/`fork`/...) are matched by string in `handleSlashSelect` — renaming an id there without updating `SLASH_COMMANDS` (or vice versa) silently no-ops that command.

### File/image/audio/binary attachment upload
Paperclip button (or drag-and-drop onto the chat area) accepts text, image, audio (wav/mp3 only), and common binary-doc types; each is base64-encoded (chunked to avoid a stack-overflow above ~1MB) and saved via `rpc.saveAttachment`, then referenced as implicit AI context (`<attached-file>`, `[Attached image: ...]`, etc.) baked directly into the persisted message content.
**Key files:**
- `src/mainview/components/chat/chat-input.tsx` — `processFiles`, `categorizeFile`, `TEXT_EXTENSIONS`/`IMAGE_EXTENSIONS`/`AUDIO_EXTENSIONS`/`BINARY_DOC_EXTENSIONS`
- `src/mainview/components/chat/chat-layout.tsx` — `fileToBase64`, the attachment-saving loop in `handleSend`
**Data:** attachments are saved to the workspace filesystem (`rpc.saveAttachment`); the reference/metadata lives in `messages.metadata.attachments` and inline in `messages.content`
**Watch for:** only WAV/MP3 audio is accepted (no transcoding dependency) — anything else is rejected client-side with a toast rather than silently mis-delivered; don't widen `AUDIO_EXTENSIONS` without also handling it in the backend `read_audio` tool.

### Attach a note (Collections)
Separate "Library" toolbar button (both in the main composer and the Dashboard widgets' `QuickAttachBar`) that opens a picker over saved Collections notes and attaches the picked note's markdown as a text attachment/insert, reusing the same chip/removal plumbing as file attachments in the main composer.
**Key files:**
- `src/mainview/components/collections/attach-note-modal.tsx` — `AttachNoteModal`
- `src/mainview/components/chat/chat-input.tsx` — `handleAttachNote`
- `src/mainview/components/dashboard/quick-attach-bar.tsx` — `QuickAttachBar` (dashboard-widget equivalent, inserts as plain text instead of a chip)
**Data:** `collections`/notes tables (read-only from this surface)
**Watch for:** the main chat gets a real removable attachment chip; the Dashboard widgets only get a plain-text insert — don't assume parity between the two call sites.

### Save message to Collection
Assistant message hover-action (bookmark-plus icon) that opens a modal to save that message's raw markdown content into a Collection, tagged `sourceType: "pm_chat"`.
**Key files:**
- `src/mainview/components/collections/save-to-collection-modal.tsx` — `SaveToCollectionModal`
- `src/mainview/components/chat/message-bubble.tsx` — wiring in the hover-action row
**Data:** `collections`/notes tables

### Prompts library dropdown
Searchable popover of saved prompt templates (`rpc.searchPrompts`); selecting one appends its content into the current input. Present in both the main composer and the Dashboard widgets' `QuickAttachBar`.
**Key files:**
- `src/mainview/components/chat/prompts-dropdown.tsx` — `PromptsDropdown`
**Data:** `prompts` table

### Voice input (Web Speech API)
Shared hook wrapping `webkitSpeechRecognition`/`SpeechRecognition` (Chromium/Blink only — absent on macOS WKWebView, feature-detected via `supported`). Appends live transcript after whatever text was already in the box; stopped automatically right before a send so the mic doesn't keep listening in the background.
**Key files:**
- `src/mainview/lib/use-voice-input.ts` — `useVoiceInput`
- `src/mainview/components/chat/voice-input-button.tsx` — `VoiceInputButton` (shared mic toggle UI)
- Mounted in: `src/mainview/components/chat/chat-input.tsx` (main chat), `src/mainview/components/dashboard/pm-chat-widget.tsx`, `src/mainview/components/dashboard/custom-agent-chat-widget.tsx`
**Data:** none (browser API only, nothing persisted)
**Watch for:** silently absent (no mic button at all) on any webview without `SpeechRecognitionCtor` — don't assume it's present cross-platform; every mount site must keep checking `voice.supported` before rendering the button.

### Model selector row (model / thinking / plan-mode / shell-approval / context)
The row directly under the composer: Build/Plan mode toggle (plan mode = read-only planning), a searchable model picker (Latest/Favorites/per-provider sections, per-model enable/favorite toggles synced live via `agentdesk:model-preferences-changed`), a thinking-effort selector (Default/Low/Medium/High), a shell-approval Ask/Auto toggle, and the inline context-usage indicator pinned to the far right.
**Key files:**
- `src/mainview/components/chat/model-selector.tsx` — `ModelSelector`
**Data:** `settings` (`chatProviderId`, `chatModelId`, `chatThinkingLevel`, `shellApprovalMode`, `planMode` — all per-project), `model_preferences`
**Watch for:** if the selected model becomes disabled elsewhere (Settings → Models), this component silently falls back to that provider's default model AND persists the correction — a provider with no `defaultModel` configured breaks that fallback.

### Context usage bar + streaming tok/s indicator
Estimates conversation token usage against the project's configurable "Context Window Limit" setting (color-coded amber/red past 60%/80%), with three render variants (`inline` in the model-selector row, `bar` full-width, `compact`). The `bar` variant also shows live tokens/sec during an active stream. `ChatInput`'s `/compact` slash command only appears once utilization crosses 50%.
**Key files:**
- `src/mainview/components/chat/context-indicator.tsx` — `ContextIndicator`
- `src/mainview/stores/chat-store.ts` — `liveContextTokens`, `liveTokensPerSecond` (populated from real backend step usage, not just the char-estimate)
**Data:** `settings` key `project:<id>:contextWindowLimit`
**Watch for:** token count is a `content.length/4` estimate until a real backend figure (`liveContextTokens`) arrives — the two numbers can visibly diverge right after switching conversations before the first live figure lands.

### Conversation cost estimate (unwired)
A cost-estimator component (`$` tooltip showing input/output token totals and estimated $ cost from `pricing.ts`) exists and is fully implemented but is **not currently rendered anywhere** in the app — no import references it outside its own file. See "Known dead/orphaned code" at the top of this document.
**Key files:**
- `src/mainview/components/chat/conversation-cost.tsx` — `ConversationCost`
- `src/mainview/lib/pricing.ts` — `estimateCost`/`formatCost`
**Data:** `messages.metadata` (`promptTokens`/`completionTokens`)
**Watch for:** don't assume this ships anywhere today; if resurrecting it, note it duplicates data already summarized on the AI Usage tab.

### Compaction (`/compact`)
Slash command (and the auto-compaction the PM triggers itself at high context %) that calls `rpc.compactConversation`; shows an amber "Compacting conversation…" banner in the composer and a matching floating pill over the message list while in flight, with its own dismissible error banner on failure.
**Key files:**
- `src/mainview/components/chat/chat-input.tsx` — `compacting`/`compactError` state, `handleSlashSelect`'s `"compact"` case
- `src/mainview/components/chat/message-list.tsx` — the `isCompacting` floating pill
- `src/mainview/stores/chat-store.ts` — `isCompacting`
**Data:** conversation messages get summarized/pruned server-side
**Watch for:** a project/conversation switch mid-compaction must not apply the result/error to whatever's now showing — guarded via a frozen `startConversationId` ref comparison; don't remove that guard.

### MCP server status (composer)
A row above the input shows `connected/total` MCP servers when any are configured; clicking opens a dialog listing each server's live status (connected/connecting/failed/disabled) with per-server Connect/Disconnect actions, polled every 5s while open.
**Key files:**
- `src/mainview/components/chat/chat-input.tsx` — `mcpServers`/`mcpLiveStatus` state, the MCP dialog JSX
**Data:** MCP config (`rpc.getMcpConfig`/`getMcpStatus`)

### Message actions (copy/retry/fork/delete)
Hover-only action row per message: Copy (clipboard), Retry (last assistant message only, or any error bubble), Fork-from-here (branches a new conversation at that message, user messages only), Delete (confirm dialog), plus Save-to-Collection for assistant messages. A shared React Context (`MessageActionsProvider`) hands stable store-action references to every `MessageBubble` instance to avoid N Zustand subscriptions.
**Key files:**
- `src/mainview/components/chat/message-actions-context.tsx` — `MessageActionsProvider`/`useMessageActions`
- `src/mainview/components/chat/message-bubble.tsx` — the hover action row
**Data:** `messages` table (delete/branch mutate it via `chat-store`)
**Watch for:** `useMessageActions()` throws if called outside the provider — any new message-rendering surface reusing `MessageBubble` must wrap in `MessageActionsProvider` (as `MessageList` already does).

### Activity/Context Panel (Files + Docs side pane)
The resizable right-hand pane in `ChatLayout` (toggle button in the header, 300-400px, draggable resize handle, overlays as a sheet on mobile) — despite the name "Activity Pane" in the toggle's tooltip, its actual content is a **Files** tab (live workspace file tree with lazy directory loading, syntax-highlighted file preview, image lightbox) and a **Docs** tab (project notes + saved plan documents, markdown viewer modal, download-as-.md, "View all docs" deep-link to the Notes/Docs project tab). Both refresh automatically on agent-complete/stream-complete/kanban-move events, plus a manual refresh button.
**Key files:**
- `src/mainview/components/activity/context-panel.tsx` — `ContextPanel` (tab switcher + shared refresh button)
- `src/mainview/components/activity/files-tab.tsx` — `FilesTab` (tree, binary/image detection, `CodeBlock` preview)
- `src/mainview/components/activity/docs-tab.tsx` — `DocsTab` (notes+plans list, markdown modal)
**Data:** live workspace filesystem (`rpc.listWorkspaceFiles`/`readWorkspaceFile`/`readWorkspaceImageFile`), `notes` table, plan files on disk (`rpc.getWorkspacePlans`)
**Watch for:** the actual live tool-call/agent-dispatch activity feed is NOT here — it's rendered inline in the message list (see "Inline agent execution rendering" above). Don't confuse the two when an "activity pane" request comes in — clarify which one is meant.

### Dashboard: project grid (filter/sort/collapse)
Project-card grid with status filter chips (Total/Active/Paused/Completed/Archived/Deleted, each a count+toggle), a sort dropdown (last updated/created/name/status, persisted to settings), and a "collapse all cards" toggle (persisted to localStorage). Live-refreshes active-agent counts (event-driven + 10s poll) and task-completion stats per project.
**Key files:**
- `src/mainview/pages/dashboard.tsx` — `DashboardPage`
- `src/mainview/components/dashboard/project-card.tsx` — `ProjectCard` (status dropdown, delete/restore/permanent-delete, unread dot, offline-workspace indicator)
**Data:** `projects` table, `agent_tasks` (task stats), `settings` key `project_sort`
**Watch for:** `IS_REMOTE` gates out project creation on the web/remote build (projects are desktop-only since the workspace lives on that machine) — any new Dashboard action must consider whether it needs the same remote gate.

### Dashboard PM chat widget (project-less)
Floating chat panel (opened via the sidebar's "Chats" launcher) for talking to the PM without a project open; has its own expand-to-modal view, font zoom, Markdown export, `/info` quick-status button, and persists its session id + message log + generated-image payloads to `localStorage` (survives refresh; ephemeral otherwise). Streams via `agentdesk:dashboard-pm-*` window events.
**Key files:**
- `src/mainview/components/dashboard/pm-chat-widget.tsx` — `PmChatWidget`
**Data:** none server-side — session/messages/images are `localStorage`-only (`dashboard-pm-*-v1` keys); the actual PM turn is driven by `rpc.sendDashboardMessage`/`abortDashboardMessage`/`clearDashboardSession`
**Watch for:** this is a materially different chat implementation from the main `ChatLayout`/`MessageBubble` stack (own markdown components, own tool-call-indicator list instead of `MessagePartData`) — a fix made in one does NOT automatically apply to the other; the two intentionally share only `VoiceInputButton`, `useVoiceInput`, `InlineImage`, and `QuickAttachBar`.

### Dashboard custom-agent chat widgets
One additional floating chat widget per agent with "Enable Chat" turned on in Settings → Agents (fetched via `rpc.getChatEnabledAgents`, re-fetched on `agentdesk:chat-agents-changed`); near-identical implementation to the PM widget (own localStorage keys per agent name) plus an inline agent-settings editor (rename/color/chat-toggle) reachable from the widget itself.
**Key files:**
- `src/mainview/components/dashboard/custom-agent-chat-launcher.tsx` — `CustomAgentChatLauncher` (fetches + mounts one widget per agent)
- `src/mainview/components/dashboard/custom-agent-chat-widget.tsx` — `CustomAgentChatWidget`
**Data:** `agents` table (`enableChat`, `displayName`, `color`)
**Watch for:** kept in sync with `pm-chat-widget.tsx` "by hand" (duplicated markdown components, duplicated persistence helpers) — a bug fixed in one is not automatically fixed in the other; check both when touching either.

### Chat launcher footer bar
Persistent 44px bottom bar (excludes the app sidebar's width) listing every registered chat launcher (PM + each chat-enabled agent) as pills; clicking toggles that launcher's own floating panel. Overflow collapses into a "+N more" pill with its own popover list, computed via a hidden measuring clone + `ResizeObserver` rather than CSS wrapping.
**Key files:**
- `src/mainview/components/dashboard/chat-launcher-footer.tsx` — `ChatLauncherFooter`
- `src/mainview/stores/dashboard-launcher-store.ts` — registry (`register`/`unregister`/`setUnread`/`setStreaming`/`requestOpen`)
**Data:** none (client-only registry populated by each widget's own mount effect)
**Watch for:** z-index is deliberately `z-40` (below the expanded-chat Dialog's `z-50` scrim) — bumping this above 50 would let the footer poke through an open expanded-chat modal.

### Quick Chat window (OS Explorer "Open in AgentDesk")
A reduced-chrome `BrowserWindow` (no main-app Sidebar/TopNav) opened from the OS Explorer/Finder folder context menu against an arbitrary, project-less folder; reuses the normal `ChatLayout`/PM engine with only Chat + Docs tabs, a running-agent badge, and a "Create Project" button that promotes the folder into a real tracked project (`rpc.promoteQuickChatProject`) without copying/moving anything on disk. One window per folder — reopening the same folder focuses the existing window instead of duplicating it. The Dashboard's own "Open Quick Chat" button (no folder to inherit from an OS Explorer caller) always targets a fixed `AgentDesk Quick Chat` subfolder under the resolved OS Documents directory, created on first use (`openQuickChatDefault` in `src/bun/rpc/projects.ts`).
**Key files:**
- `src/mainview/pages/quick-chat.tsx` — `QuickChatPage`
- `src/bun/quick-chat/window.ts` — `openQuickChatWindow`, `hasQuickChatWindow`/`hasAnyQuickChatWindows`, per-window RPC instance via `createRpc()` (never the shared singleton)
- `src/bun/quick-chat/os-integration.ts` — `registerQuickChatMenu`/`unregisterQuickChatMenu` (Windows HKCU registry via a PowerShell launcher script + handoff file; macOS Automator Quick Action/Service — its lowest-confidence, never-live-tested piece)
- `src/bun/quick-chat/launch-args.ts` — handoff-file protocol between the OS menu launch and app startup
- `src/bun/rpc/projects.ts` — `openQuickChatDefault`, `resolveDocumentsDir`
**Data:** `projects.isQuickChat` flag; promoted projects clear that flag
**Watch for:** the initial route (`#/quick-chat/<id>?c=<conversationId>`) is delivered via the BrowserWindow's `preload` script text, not a URL hash or a post-dom-ready RPC push — both alternatives were tried and proven unreliable; don't "simplify" this back to a hash/query URL or an `rpc.send`-based push.

### Ambient Mode (screensaver-style voice/status overlay + cross-project voice assistant)
A full-screen, in-window overlay (not a route change) showing live cross-project agent/task activity as a radar-style "Beacon" scope, opened via the Dashboard's "Ambient Mode" button or auto-activated after N idle minutes (app-focus-scoped, not true OS-wide idle — paused on window blur). "Project to display" opens Ambient Mode full-screen on a second monitor/TV via a dedicated `BrowserWindow` (own `createRpc()` instance, mirrors Quick Chat's pattern), polling a snapshot RPC every few seconds instead of the live push-broadcast path (that window belongs to no single project).

Voice ("Talk to PM") is a real cross-project assistant, not tied to whatever project chat happens to be open — see `docs/ambient-pm-voice-plan.md`. Mic is off by default; one tap starts a hands-free session. Pause-based turn detection (a debounce timer, no button tap needed) ends each turn automatically once the user stops talking, and the session then auto-restarts listening for the next turn — no "Ask again" tap needed — until the user explicitly taps "Stop". The mic is also kept alive (with a short arm delay) through the "thinking" (backend answering) and "speaking" (TTS playing) phases so the user can interrupt by talking, mirroring ChatGPT/Gemini-style voice mode; interrupting cancels any playing TTS immediately and the new speech starts the next turn, while the previous turn's still-in-flight backend call is actually cancelled server-side (`cancelAmbientAssistantTurn`, reusing `runAmbientAssistantTurn`'s existing `abortSignal` plumbing — the same mechanism the regular agent "Stop" button uses) rather than just having its eventual answer discarded — see `docs/ambient-voice-barge-in-research.md` for the research behind this and why full automatic barge-in (safe even without headphones) isn't attempted, since the Web Speech API has no raw-audio/echo-cancellation access. The real one-shot cross-project tool-calling turn (`runAmbientAssistantTurn`) runs per turn and its answer is spoken once ready. Tools: `list_projects`/`get_project_status`/`list_active_agents`/`get_recent_activity`/`get_pending_approvals`/`get_review_queue`/`get_inbox_summary`/`get_scheduled_jobs`/`get_freelance_summary`/`get_git_status` (all read-only) plus `dispatch_to_project` (creates a new, persisted conversation in the named project and routes through that project's normal PM/plan-approval pipeline — never a bypass). Tool calls stream live into a slide-in side pane. Replies are spoken via `speechSynthesis` by default, via a real speech-model's generated audio, or via a downloadable offline voice ("Ryan", Piper/VITS via sherpa-onnx — fetched at download time into user-data, never bundled) if configured in Settings.

**Key files:**
- `src/mainview/components/ambient/ambient-screen.tsx` — `AmbientScreen`, mounted once in `app-shell.tsx`; `src/mainview/stores/ambient-store.ts` — `useAmbientStore` (open/activate/dismiss)
- `src/mainview/components/ambient/ambient-radar-view.tsx` — `AmbientChrome`/`AmbientRadarContent`, the shared Beacon-styled presentational pieces used by both the live overlay and the projected display page
- `src/mainview/components/ambient/ambient-tool-call-pane.tsx` — `AmbientToolCallPane`, the live tool-call side pane, re-themes message-parts.tsx's running/complete/error visual language rather than importing it directly
- `src/bun/ambient/assistant.ts` — `runAmbientAssistantTurn` (the one-shot cross-project tool-calling turn, dual-path model invocation mirroring `rpc/dashboard-agent.ts`, up to 100 messages of conversation history); `src/bun/ambient/tts.ts` — `generateAmbientSpeech`; `src/bun/ambient/local-voice-manager.ts` — the offline "Ryan" voice's download/status/preload/synthesize lifecycle (fetched at download time into user-data, never bundled — see the "Offline Ambient voice" feature entry)
- `src/mainview/lib/use-global-agent-activity.ts` — `useGlobalAgentActivity`; `use-idle-timer.ts` — `useIdleTimer`; `use-ambient-settings.ts` — `useAmbientSettings`; `use-ambient-voice-turn.ts` — `useAmbientVoiceTurn` (pause-based auto-stop plus a `finalizing` flag covering the gap between calling `stop()` and the recognizer's async `onend`, wraps `use-voice-input.ts` without changing it for other callers); `use-text-to-speech.ts` — `useTextToSpeech` (browser voice; `speak()` returns a Promise so a second utterance can be sequenced after the first, and resolves on `cancel()` too); `use-ambient-voice-playback.ts` — `useAmbientVoicePlayback` (same shape as `useTextToSpeech`, swaps in generated/offline audio when configured; its `cancel()` also resolves any in-flight `speak()` promise, needed for barge-in to not hang)
- `src/mainview/pages/ambient-display.tsx` — `AmbientDisplayPage` (projected/TV route, polls `getAmbientActivitySnapshot`); `src/bun/ambient/window.ts` — `openAmbientDisplayWindow`/`closeAmbientDisplayWindow`/`hasAmbientDisplayWindow`
- `src/bun/rpc/ambient.ts` + `src/shared/rpc/ambient.ts` — `getAmbientDisplays`/`openAmbientDisplayWindow`/`closeAmbientDisplayWindow`/`getAmbientActivitySnapshot`/`getAmbientProjectionState`/`runAmbientAssistantQuery`/`cancelAmbientAssistantTurn`/`generateAmbientSpeech`/`getAmbientLocalVoiceStatus`/`downloadAmbientLocalVoice`/`preloadAmbientLocalVoice` (`ambientAssistantPart` push event streams tool-call/text parts live; `ambientLocalVoiceStatus` push event streams the offline voice's download progress)
- `src/bun/engine-manager.ts` — `getActiveProjectAgentsList`/`getGlobalPendingApprovalCount`/`getOrCreateEngine` (also used by `dispatch_to_project`); `recordGlobalActivity`/`getRecentGlobalActivity` — an in-memory, 50-entry ring buffer mirroring the main window's rolling activity log, so the projected/TV view and `get_recent_activity` both work without a live push
- `src/bun/rpc/kanban.ts` — `getReviewQueue` (new cross-project review-column query); `src/bun/providers/openai.ts` — `generateSpeech` (real, non-custom OpenAI only, same gating as `getFilesApi`)
- Settings: `ambientModeEnabled`/`ambientModeIdleMinutes`/`ambientModeVoiceEnabled`/`ambientModeTtsEnabled`/`ambientTtsProviderId`/`ambientTtsModelId` in `src/mainview/pages/settings/general.tsx` (the TTS voice picker reuses the existing `getConnectedProviderModels`/`getModelTypes` RPCs the Models settings page already uses for type badges)
**Data:** none (pure frontend/in-memory state + the existing generic `settings` KV table) — `dispatch_to_project` creates a normal, persisted conversation via the existing conversations/messages tables, exactly like typing into a project's chat
**Watch for:** `agentInlineStart`/`agentInlineComplete` broadcasts carry a `projectId` field (added for the activity log's per-project attribution) that a future refactor of those events must keep. The idle timer's "is anything blocking?" check is a generic `[role="dialog"][data-state="open"]` DOM query plus `chat-store`'s global `shellApprovalRequests` and two marker attributes (`data-plan-approval-pending`, `data-voice-listening`) — removing either marker silently reopens the "pops up over an unresolved plan/mid-dictation" risk. `requestFullscreen()` is refused without a real user gesture on the idle-triggered path — expected, not a bug. `recordGlobalActivity`'s three call sites hand-duplicate the same text-formatting `useGlobalAgentActivity.ts` uses for its own push-driven log. The TTS voice picker filters to `providerType === "openai"`, not just the model-classification "speech" tag — a real custom/OpenAI-compatible provider can have models named like a TTS model (matches the naming heuristic) without the adapter actually being able to call one, since `@ai-sdk/openai-compatible` has no `.speech()` accessor. Voice/TTS timing and real generated-audio playback could not be fully live-tested end-to-end (no microphone or real OpenAI key in the dev sandbox this was built in) — verified as deeply as possible via direct RPC calls, real timing captures, and code review; see TASK-570/TASK-573's recorded evidence. Barge-in (interrupting by talking during "thinking"/"speaking") has no acoustic echo cancellation available — the Web Speech API gives no raw-audio/AEC access — so without headphones the mic can occasionally pick up the assistant's own voice through speakers and false-trigger a barge-in; this is a known, accepted limitation of the zero-dependency approach, not a bug to chase (see `docs/ambient-voice-barge-in-research.md`).

### Offline Ambient voice ("Ryan", downloaded on demand)
An additional voice option in Ambient Mode's Settings → General "Voice" picker — a fully offline Piper/VITS voice (`en_US-ryan-high`) run locally via `sherpa-onnx-node`. Deliberately **not** an npm dependency of the app: both the ~10MB native inference engine and the ~116MB voice model are fetched at download time (triggered from a Settings panel, mirroring Collections' embedding-model download UI — status pill, live progress bar, Re-download) directly from their public npm/GitHub sources into `Utils.paths.userData`, then loaded via an absolute-path `createRequire()` — never through `node_modules`, `package.json`, or Bun's bundler — so the app's own installer/bundle size never grows because of it. A `.ready.json` marker file (no DB row) tracks whether it's downloaded; re-downloading wipes and refetches everything. Once Ambient Mode is opened with this voice selected, the engine is warmed up in the background (`preloadAmbientLocalVoice`) so the first reply doesn't pay the onnxruntime cold-load cost.
**Key files:**
- `src/bun/ambient/local-voice-manager.ts` — `LOCAL_VOICE_PROVIDER_ID` (the `"local"` sentinel reused in the existing `ttsProviderId`/`ttsModelId` settings fields instead of a new column), `downloadLocalVoice`/`getLocalVoiceStatus`/`preloadLocalVoice`/`synthesizeLocalVoice`
- `src/bun/rpc/ambient.ts` — `generateAmbientSpeech` branches on the `"local"` sentinel before treating `providerId` as a real `aiProviders` DB row
- `src/mainview/pages/settings/general.tsx` — `LocalVoiceDownloadPanel`, `LOCAL_VOICE_VALUE` sentinel Select option
**Data:** none (marker file only, no DB row) — reuses the existing `ambient_tts_provider_id`/`ambient_tts_model_id` settings keys
**Watch for:** re-downloading while the engine is already loaded in the same process could hit a Windows file-lock on the native binary (can't overwrite a `.node`/`.dll` currently mapped into the process) — a first-time download is unaffected; an app restart between download attempts sidesteps it. `sherpa-onnx-node`'s own native-binary resolution requires the platform package nested at `node_modules/sherpa-onnx-node/node_modules/sherpa-onnx-<platform>-<arch>/` exactly — an upstream layout change would need a deliberate `SHERPA_VERSION` bump, not a silent break.

### Production context menu (Cut/Copy/Paste only, no Inspect)
WebView2's built-in right-click context menu is production's only way to Cut/Copy/Paste text, but it also exposes "Inspect" — Electrobun has no setting to remove just that one item, and fully disabling the native menu (tried previously) took clipboard access away from every production user too. Production/canary builds now suppress the native menu (`event.preventDefault()` on `contextmenu`) and render a minimal frontend Cut/Copy/Paste/Select-All menu instead, backed by Bun's native clipboard (not the web Clipboard API, to sidestep WebView2 permission-prompt uncertainty on paste). The dev channel and web/remote-pairing mode are both untouched — dev keeps the native menu (incl. Inspect) for debugging; a paired browser tab is the user's own real browser, where suppressing its menu would be pointless.
**Key files:**
- `src/mainview/components/production-context-menu.tsx` — `ProductionContextMenu`, mounted once in `App.tsx`; gated by `!import.meta.env.DEV && !IS_REMOTE`
- `src/bun/rpc-groups/projects-system.ts` — `readClipboardText`/`writeClipboardText` handlers (wrap Electrobun's `Utils.clipboardReadText`/`clipboardWriteText`)
- `src/shared/rpc/system.ts` — `readClipboardText`/`writeClipboardText` contract
**Data:** none
**Watch for:** only `<input>`/`<textarea>` are treated as editable (no `contentEditable` elements exist in this codebase today) — if one is ever added, this menu's Cut/Paste/Select-All logic needs a contentEditable branch (Range/Selection API) or it'll silently no-op there.

### Quick Chat → main-app fallback bridge
Helper that lets the pull-based route-recovery path (`App.tsx`) hand a conversation id directly to a freshly (re)mounted `QuickChatPage` if the window's hash-based route delivery came up empty (e.g. after a cold-start webview recreation).
**Key files:**
- `src/mainview/lib/quick-chat-fallback.ts` — `takePendingQuickChatConversationId`
**Data:** none (in-memory bridge)
**Watch for:** this is a narrow patch for the native-webview-recreation edge case documented in the "Electrobun Windows cold-start webview crash" memory — don't remove without understanding that failure mode.

---

## Global & Project Settings

### Settings page tab structure
The global Settings page (`src/mainview/pages/settings.tsx`) renders a top-level `Tabs` (General, AI, Channels, Integrations, Notifications, System, Plugins), each holding a `SubTabs` of individual setting pages. A separate `aiOnly` mode renders just the AI sub-tabs directly (no outer tab chrome) for Quick Chat windows, since a Quick Chat "project" has no kanban/plan-approval/channels/plugins to configure.
**Key files:**
- `src/mainview/pages/settings.tsx` — `SettingsPage({ aiOnly })`, `SubTabs` helper
**Data:** N/A (pure routing/composition)
**Watch for:** adding a new settings sub-page requires wiring it into the `TabsContent` block here — easy to build a page and forget to mount it, or to mount it under the wrong tab.

### General Settings — profile & application preferences
Global user profile (name/email used in agent communications) and application-level preferences: global workspace root path (with native directory picker, hidden in remote/web mode), default timezone (used by cron/scheduling), "Prevent System Sleep", "Launch at Startup", and "Allow Quick Chat" (toggles the OS Explorer "Open in AgentDesk" right-click entry). Includes a "Reset Application" danger-zone action that wipes all data/projects/keys/settings (backups preserved) and restarts the app.
**Key files:**
- `src/mainview/pages/settings/general.tsx` — `GeneralSettings`, `ResetApplicationCard`
- `src/bun/rpc/settings.ts` — generic `getSettings`/`getSetting`/`saveSetting` backing every settings page
**Data:** `settings` table, category `"user"` (`user_name`, `user_email`) and category `"general"` (`timezone`, `global_workspace_path`, `prevent_system_sleep`, `launch_at_startup`, `allow_quick_chat`)
**Watch for:** email is validated client-side only (`isValidEmail` regex) before save; `allow_quick_chat` gates a native OS shell-integration entry point — flipping it off doesn't retroactively remove an already-installed shell menu entry unless the backend handles that explicitly.

### Appearance Settings
Theme (light/dark, applies instantly via `setTheme`), background color/pattern presets (applies instantly via `setBackground`), sidebar default expanded/collapsed state, "Dashboard Motivational Quotes" toggle, and "Show Chat Widgets Only on Dashboard" toggle (controls whether PM/custom-agent chat launchers appear app-wide or Dashboard-only).
**Key files:**
- `src/mainview/pages/settings/appearance.tsx` — `AppearanceSettings`
- `src/mainview/lib/theme.ts`, `src/mainview/lib/app-background.ts` — `getStoredTheme`/`setTheme`, `APP_BACKGROUNDS`/`getStoredBackground`/`setBackground`
**Data:** `settings` table, category `"appearance"` (`sidebar_default`, `dashboard_quotes`, `chat_widgets_dashboard_only`)
**Watch for:** theme/background changes are immediate (no dirty/save gate) while sidebar/quotes/chat-widget-scope changes require clicking Save and dispatch custom window events (`agentdesk:sidebar-default-changed`, `agentdesk:chat-widgets-scope-changed`) that other components must listen for — a component reading these settings only on mount (not listening to the event) will show stale state until reload.

### Constitution editor (default agent constitution)
A free-text editor for the "agent constitution" — standing rules injected as a system-level constraint into every agent session regardless of project or task. Ships with a large default constitution text baked into the frontend; "Reset to Default" restores it.
**Key files:**
- `src/mainview/pages/settings/constitution.tsx` — `ConstitutionSettings`, `DEFAULT_CONSTITUTION`
**Data:** `settings` table, category `"system"`, key `"constitution"` (plain text)
**Watch for:** the default constitution text is duplicated as a literal string in this frontend file (not fetched from a shared/backend constant) — if the canonical constitution content changes elsewhere, this hardcoded copy can silently drift out of sync. There is also a project-level `constitutionMode` setting key that appears to be **dead** — defined but not read anywhere — see "Known dead/orphaned code" at the top of this document.

### Environment variables management
Lets the user define custom OS environment variables that get injected into the app process on startup and exposed to agents via the `get_env` tool. Variable names are auto-uppercased; names matching a secret-like pattern (`key|token|secret|password|credential|auth|private|apikey|api_key`) are masked in the UI and blocked from agent read access.
**Key files:**
- `src/mainview/pages/settings/env-vars.tsx` — `EnvVarsSettings`, `SECRET_PATTERN`
- `src/shared/rpc/env-vars.ts` — `CustomEnvVar` type
**Data:** `custom_env_vars` table via `rpc.listCustomEnvVars`/`createCustomEnvVar`/`updateCustomEnvVar`/`deleteCustomEnvVar`
**Watch for:** the frontend `SECRET_PATTERN` regex must stay in sync with whatever blocklist the actual `get_env` tool enforces server-side (`agents/tools/system.ts`'s `SECRET_PATTERNS`) — if they diverge, the UI's "blocked" badge misrepresents what agents can actually read.

### MCP server configuration UI
Raw JSON editor (Claude Desktop-compatible `mcpServers` format or flat object) for configuring Model Context Protocol servers that give agents extra tools. Shows live per-server connection status (connected/connecting/failed/disabled), polls every 5s, and offers manual "Reconnect" for failed servers (auto-retries with backoff server-side).
**Key files:**
- `src/mainview/pages/settings/mcp.tsx` — `McpSettings`, `ServerList`, `prettify`
- backend: `src/bun/mcp/` (connection/status management), reached via `rpc.getMcpConfig`/`saveMcpConfig`/`getMcpStatus`/`reconnectMcpServer`
**Data:** MCP config persisted under `settings` category `"mcp"`
**Watch for:** the editor accepts either `{mcpServers: {...}}` or a flat `{serverName: {...}}` object — any change to the parsing logic (`handleChange`) must keep both accepted, and the "Load template"/"Clear" affordances only appear when the textarea is empty, so test both paths after changes.

### Debug / prompt-logging settings
A single toggle ("Debug Prompts") that enables raw-prompt logging to a rotating file (5 MB rotation) for inspecting exactly what's sent to AI providers. Shows the resolved log file path (OS-dependent separator) and provides "View Log"/"Clear Log" actions. Explicitly distinct from the AI Usage analytics tab (token/cost/latency), which lives elsewhere.
**Key files:**
- `src/mainview/pages/settings/ai-debug.tsx` — `AiDebugSettings`
- backend: `rpc.clearPromptLog`/`openPromptLog`
**Data:** `settings` table, category `"ai"`, key `"debug_prompts"` (boolean); log file itself lives on disk at `<dataDir>/logs/prompts.log`, not in the DB
**Watch for:** off by default because raw prompts can contain sensitive workspace content; any change to the agent-loop system-prompt assembly should verify this logging path still captures the full prompt text (not a truncated/redacted view) since it's the intended debugging surface.

### AI Providers / Models / Streaming (see "Providers, Models & AI Analytics" section above)
Sub-tabs under the AI section for provider credentials, per-project model selection, and streaming behavior.
**Key files:** `src/mainview/pages/settings/providers.tsx`, `src/mainview/pages/settings/models.tsx`, `src/mainview/pages/settings/streaming.tsx`.

### Integrations — GitHub PAT (global)
Stores a global GitHub Personal Access Token (`repo` + `read:user` scopes), with a "Validate" action that calls the GitHub API and reports the authenticated username, plus a persisted connection status.
**Key files:**
- `src/mainview/pages/settings/github.tsx` — `GithubSettings`
- backend: `rpc.validateGithubToken`, token consumed via `githubAuthPrefix`/`gitAuthArgs` (see CLAUDE.md's git-auth rule) in `src/bun/rpc/github-api.ts`
**Data:** `settings` table, category `"github"` (`github_pat`, `github_status`, `github_username`)
**Watch for:** this is the **global default** token; a project can override it with its own encrypted token via Project Settings → General (see below, `githubTokenSource`/`githubToken` project-setting keys) — changes here silently stop applying to any project that has opted into a custom per-project token.

### Integrations — Search provider keys
Optional Exa and Tavily API keys that upgrade the `web_search` agent tool from its DuckDuckGo-only fallback to higher-quality neural/structured search. Fixed fallback order: Exa → Tavily → DuckDuckGo; the tool needs no key to function at all.
**Key files:**
- `src/mainview/pages/settings/search-settings.tsx` — `SearchSettings`, `useProviderKey` hook, `ProviderCard`
**Data:** `settings` table, category `"integrations"` (`exa_api_key`, `tavily_api_key`)
**Watch for:** the fallback order and behavior described in the UI copy must stay in sync with the actual `web_search` tool implementation — if the tool's fallback order or key names change, this page's setting keys and copy go stale silently.

### Channels settings (see "Channels, Notifications & Inbox" section above)
Discord, WhatsApp, Email, and Remote Access (desktop-to-browser pairing/QR) sub-tabs.
**Key files:** `src/mainview/pages/settings/discord-settings.tsx`, `whatsapp-settings.tsx`, `email-settings.tsx`, `remote-access.tsx`.
**Data note:** Remote Access uses its own raw-SQL (non-Drizzle) tables `remote_identity` and `remote_devices`, plus `settings` category `"remote"` for the desktop's own pairing identity — separate from the messaging-channel tables.

### Notification Preferences (global)
Single flat page (no sub-tabs) controlling: two desktop-notification toggles (session complete, error — plus a conditional "new freelance listings" toggle when the Auto-Earn feature is enabled), four "send to all connected channels" toggles (task-done, error, agent questions/shell-approval forwarding, plan-ready-for-approval), and per-platform cards (Discord/WhatsApp/Email/Chat) with banner-on/off and a mute-duration dropdown (1h/8h/24h/forever).
**Key files:**
- `src/mainview/pages/settings/notification-settings.tsx` — `NotificationSettings`, `PlatformCard`, `ToggleRow`, mute-timestamp helpers (`getMuteValue`, `muteValueToTimestamp`, `formatMuteRemaining`)
**Data:** `notification_preferences` table for the per-platform rows (`soundEnabled`/`badgeEnabled`/`bannerEnabled`/`muteUntil`); the flat toggles live in `settings` category `"notifications"` (`session_complete_notification`, `error_notification`, `task_done_channel_notify`, `error_channel_notify`, `question_channel_notify`, `plan_approval_channel_notify`, `freelance_new_listings_notification`)
**Watch for:** "forever" mute is implemented as a sentinel far-future timestamp (`2099-01-01`), not a separate boolean — any code reading `muteUntil` directly (not through `formatMuteRemaining`) must handle that sentinel correctly; desktop notifications ("session complete"/"error") only fire when the app window is not focused, which is easy to forget when debugging "notifications don't show" reports.

### System — Data Management (backups, export/import, maintenance)
Four groups on one page: (1) full app-settings export/import (providers incl. API keys, channels, notification prefs, scheduled jobs, prompts, custom agents) as a downloadable JSON bundle for machine migration; (2) per-project data export/import (conversations, tasks, docs, etc.) with merge-vs-replace mode; (3) DB maintenance (`optimizeDatabase` = PRAGMA optimize + WAL checkpoint, `vacuumDatabase`, `pruneDatabase(days)` for old cron/webhook history); (4) DB file backups (create/list/restore/delete, with restore requiring an app restart).
**Key files:**
- `src/mainview/pages/settings/data.tsx` — `DatabaseMaintenanceCard`, `BackupsCard`, `SettingsExportImportCard`, `DataSettings`
- `src/bun/rpc/settings-export.ts` — backend export/import implementation
**Data:** spans nearly every table (this is the bulk export/import surface); backups operate on the raw SQLite file
**Watch for:** "Replace" import mode deletes existing project data first — any new table added to the project data model must be added to both the export and the replace-mode wipe logic in `settings-export.ts`, or new-feature data will either leak across imports or get orphaned on replace.

### System — Audit Log
Paginated, filterable (by entity type) view of the `audit_log` table with expandable JSON detail rows, "Clear old entries" (>30 days), and "Clear All".
**Key files:**
- `src/mainview/pages/settings/audit-log.tsx` — `AuditLogSettings`
- `src/bun/db/audit.ts` — `logAudit` (the write side)
**Data:** `audit_log` table
**Watch for:** entity-type filter list (`ENTITY_TYPES` in the frontend) is a hardcoded array that must be kept in sync with whatever `entityType` strings `logAudit` callers actually use elsewhere in the backend — a new entity type won't be filterable here until added to both places.

### System Health page
Live dashboard of core subsystem status: Database (with "Check Database" action), AI Provider (has-default + count), Workspace Paths (missing-path detection), Cron Scheduler (with "Restart Scheduler" action), Integrations/channels, Agent Engines (active/idle/max capacity, with "Clean Up" for idle engines), and Backend Process uptime. Manual refresh button; no auto-polling.
**Key files:**
- `src/mainview/pages/settings/health.tsx` — `HealthSettings`, per-subsystem card components
- backend: `rpc.getHealthStatus`, `checkDatabase`, `restartScheduler`, `cleanupEngines`, tied into `EngineManager`
**Data:** aggregates live in-memory/process state (engine pool, scheduler) plus quick DB/workspace-path checks — not a dedicated table
**Watch for:** distinct from the "AI Usage"/Analytics tab (cost/token telemetry) — don't conflate the two; `EnginesCard`'s "Clean Up" action directly affects live `AgentEngine` instances, so it can interrupt in-flight work if not scoped to truly idle engines.

### System — Recommendations (dependency installer)
Checks for and offers one-click, AI-agent-driven installation of four system dependencies AgentDesk itself relies on for various workflows: Git, Node.js, Bun, Python 3. Clicking "Install" spawns an agent that detects the OS and runs the appropriate install command, then verifies the result via a broadcast event.
**Key files:**
- `src/mainview/pages/settings/recommendations.tsx` — `RecommendationsSettings`, `DependencyCard`, `DEP_META`/`DEP_ORDER`
- `src/shared/rpc/recommendations.ts` — `DependencyId`, `DependencyStatus` types
**Data:** no dedicated table; status is checked live, installs are fire-and-forget with completion reported via a `agentdesk:recommendation-status-changed` window event
**Watch for:** the installer runs as an autonomous AI agent with shell access on the user's machine — any change to how agent-driven shell commands are approved/sandboxed applies here too, since this is a live agent-executes-shell-commands surface, not a canned script.

### Plugins page
Lists installed plugins (name, version, description, author, permissions, tool count, load state) with enable/disable toggle, a per-plugin settings dialog (auto-grouped fields inferred from manifest key suffixes like `_enabled`/`_binary`/`_url`), and a per-plugin "Agent Prompt" editor (text injected into agent system prompts when the plugin is enabled, with reset-to-manifest-default). Also renders an LSP Manager sub-card (install/uninstall/enable per-language language servers) when the built-in `lsp-manager` plugin is present.
**Key files:**
- `src/mainview/pages/plugins.tsx` — `PluginsPage`, `PluginSettingsDialog`, `PluginPromptDialog`, `LspManagerCard`
- `src/bun/plugins/`, `src/bun/lsp/` — backend
**Data:** `plugins` table for enabled state/settings/prompt overrides; plugin manifests are files on disk, not DB rows
**Watch for:** `groupSettings()`'s field-grouping is inferred purely from a naming convention regex (`^(.+?)_(enabled|binary|path|host|port|url|key|secret|token)$`) — a plugin manifest using a different suffix convention will render as an ungrouped flat field instead of nesting under its logical group.

### Keyboard shortcuts (dead feature — see "Known dead/orphaned code")
A `keyboard_shortcuts` table was created in the v1 migration but has no RPC handler, no settings page, and no other backend code anywhere that reads or writes it.
**Key files:** `src/bun/db/migrations/v1_initial-schema.ts` (table definition only)
**Data:** `keyboard_shortcuts` raw-SQL table, currently unused

### Project Settings — General tab
Per-project overrides reached from a project's own settings surface (not the global Settings page). Covers: project name/description/status (active/idle/paused/completed)/workspace path (with directory picker); GitHub repo URL + working branch + a "Clone" action (shown only when a URL is set and the workspace isn't already a git repo) + per-project GitHub token source (`global` = use Settings → GitHub's PAT, or `custom` = encrypted per-project token used for all GitHub ops — issue sync, PRs, Auto Issues Fixer); and a danger zone with "Reset project data" (wipes conversations/tasks/docs/deploy history/inbox/cron history but keeps the project + its settings) and "Delete project" (full cascade delete, requires typing the project name to confirm).
**Key files:**
- `src/mainview/components/project-settings/project-settings-tab.tsx` — `GeneralTab`, `DeleteConfirmDialog`, `ResetConfirmDialog`
- `src/bun/rpc/projects.ts` — `saveProjectSetting`/`getProjectSettings` (the `project:<projectId>:<key>` convention), `deleteProjectCascade`, `resetProjectData`, `cloneProjectRepo`, `getProjectRepoState`, `getProjectGitHubTokenInfo`
**Data:** `projects` table for core fields (name/description/status/workspacePath/githubUrl/workingBranch); `settings` table for everything else, keyed `project:<projectId>:<key>` with category `"project"` — e.g. `githubTokenSource`, `githubToken` (encrypted, in `PROJECT_SECRET_KEYS`)
**Watch for:** Reset and Delete both have a subtle race-condition guard in the frontend — the confirm dialog can be closed mid-`await` while the user switches to a different project, and the code deliberately re-checks `useChatStore.getState().activeProjectId === project.id` after each await before touching global Zustand stores or navigating, to avoid corrupting whichever project the user is now looking at. Any refactor of this flow must preserve that re-check.

### Project Settings — AI tab
Per-project AI/behavior overrides, single flat tab (no further sub-tabs), all saved via `rpc.saveProjectSetting`: Provider override (dropdown of configured providers, or "inherit global default"), Model override (free-text model id), Thinking Budget (low/medium/high), Shell Approval Mode (always-ask vs auto-approve), Context Window Limit (numeric, floor-clamped to 50,000 on blur — the one governing value for the context meter/auto-compaction, since the agent's own system prompt (~20k tokens) is irreducible), "Auto-update project knowledge" toggle (agents auto-refresh project-knowledge docs when their changes invalidate them), "Auto-execute next task" toggle (PM auto-dispatches the next kanban task after review passes — **saved immediately on toggle, not gated behind the Save button**, because the engine/review-cycle reads it live on every task completion), and Dev Server URL (used by the `take_screenshot` tool for visual verification).
**Key files:**
- `src/mainview/components/project-settings/project-settings-tab.tsx` — `AiTab`, `AI_FORM_DEFAULTS`
- `src/bun/rpc/projects.ts` — `DEFAULT_PROJECT_SETTINGS` (backend-side defaults; must stay in sync with `AI_FORM_DEFAULTS`)
- `src/bun/agents/review-cycle.ts` — `getMaxReviewRounds` (reads `project:<id>:maxReviewRounds`, default 2)
**Data:** `settings` table, `project:<projectId>:<key>` (category `"project"`): `providerId`, `modelOverride`, `thinkingBudget`, `shellApprovalMode`, `sessionSummarizationThreshold` (**deprecated** — no longer surfaced in UI or read by the engine, but the key still exists for backward compatibility), `contextWindowLimit`, `agentKnowledge`, `autoExecuteNextTask`, `devServerUrl`
**Watch for:** **`maxReviewRounds` and `constitutionMode` are real, actively-referenced backend project-setting keys with no corresponding UI field** in this tab — `maxReviewRounds` genuinely gates the code-review retry loop in `review-cycle.ts` (default 2 if unset) but a user can only change it by calling `saveProjectSetting` directly, not from Settings. Any redesign of this tab should either surface these two keys or explicitly document why they stay hidden. Also note `AI_FORM_DEFAULTS.contextWindowLimit` (frontend, `"1000000"`) and the backend's per-model default (`getContextLimit`, in `src/bun/providers/models.ts`) are two separate sources of truth for "what happens with no override" — verify both when changing context-limit behavior.

---

## Freelance, Issue Fixer, Playground, Council, Collections & Scheduler

### Auto-Earn — RSS listing fetch & shortlist wizard
Polls RSS feeds from freelance platforms (Freelancer.com/Upwork), normalizes and dedupes them into `freelance_listings`, then runs an AI-driven auto-shortlist/skill-gate wizard to flag workable jobs.
**Key files:**
- `src/bun/freelance/fetcher.ts` — `fetchAllPlatforms`, `startFreelancePoller`; trims oldest listings to `maxListings`, purges blocked-country listings and 30-day-old soft-deletes
- `src/bun/freelance/rss-fetcher.ts` — `fetchRssFeed` (rss-parser, retry-with-backoff, keyword filter)
- `src/bun/freelance/normalizer.ts` — `normalizeRssItem`, budget/currency parsing from free text
- `src/bun/freelance/currency-exchange.ts` — currency conversion for budget display
- `src/bun/freelance/settings.ts` — RSS sources, keywords, `maxListings`/`maxFeeds`, `analysisProviderId`, additionalNotes
- `src/bun/rpc/freelance-wizard.ts` — `runAutoShortlist`, keyword pre-filter for non-software work, skill-gate against profile skills
- `src/bun/rpc/freelance.ts` — CRUD/list RPC for listings
- `src/mainview/pages/freelance.tsx`, `src/mainview/components/freelance/listings-tab.tsx`, `listing-card.tsx`, `find-workable-modal.tsx`, `keyword-input.tsx`
**Data:** `freelance_listings`, `freelance_chat_messages` (per-listing AI chat), `settings` (category `freelance`)
**Watch for:** listing trim/purge logic never touches shortlisted/approved/bid-placed rows — a broken guard would silently delete in-flight work; RSS parsing failures must not crash the whole poll (per-source try/catch).

### Auto-Earn — bid (proposal) drafting pipeline
Drafts a proposal for a shortlisted listing (full-description fetch → AI draft → QA pass → similarity-guard regenerate) and enqueues it to the outbox as a `bid` draft; actual form-fill happens in the frontend webview.
**Key files:**
- `src/bun/freelance/bid-pipeline.ts` — `draftBidForListing`, `analyzeListingRequirements` (detects client-requested application questions, splits AI-answerable vs human-only)
- `src/bun/freelance/description.ts` — `ensureFullDescription`/`extractDescription`, caches `freelance_listings.fullDescription` (null=never fetched, ""=failed, else cached)
- `src/bun/freelance/qa.ts` — `qaRevise`, strips over-promises/unverifiable boasts/AI giveaways before send
- `src/bun/freelance/similarity.ts` — trigram Dice `textSimilarity`, anti-template-spam guard used at draft AND send time
- `src/bun/freelance/humanizer-prompt.ts` — `getHumanizerRules` shared system-prompt block for reply/bid pipelines
- `src/bun/rpc/freelance-outbox.ts` — `computeBidAmount` (avg/min/max/percentile pricing modes + clamps), approval queue RPCs
**Data:** `freelance_outbox` (kind='bid'), `freelance_listings.fullDescription`
**Watch for:** description cache semantics (null/""/text) must be preserved exactly — description.ts is the single source of truth shared by chat AND bid pipeline; breaking it double-fetches or wrongly falls back to the RSS snippet.

### Auto-Earn — inbox sync & reply drafting pipeline
Intercepts the platform's own JSON API traffic inside a persistent native webview session, normalizes+ingests it into inbox tables, then drafts client replies via the same QA/similarity-guard pattern as bids.
**Key files:**
- `src/bun/freelance/session/ingest.ts` — `ingestCaptures`, phased transactions (self→users→threads→messages→correlation) so a large batch never holds one giant write lock
- `src/bun/freelance/session/normalizer.ts` — parses raw platform capture JSON into typed records
- `src/bun/freelance/session/humanize.ts` — human-like typing/pacing simulation for the write-step
- `src/bun/freelance/reply-pipeline.ts` — `draftReplyForThread`
- `src/mainview/components/freelance/session-webview-host.ts` — singleton native `<electrobun-webview>`, never destroyed (Windows orphan-webview workaround), only hidden/repositioned
- `src/mainview/components/freelance/always-mounted-inbox.tsx` — `AlwaysMountedInbox`, portals `<InboxTab/>` into a stable DOM node so the sync/full-auto loop survives page navigation
- `src/mainview/components/freelance/inbox-tab.tsx`
**Data:** `freelance_accounts`, `freelance_inbox_threads`, `freelance_inbox_messages`, `freelance_inbox_users`
**Watch for:** ingest phases must stay ordered (self before threads/messages, for `self_user_id` resolution); the webview must never be destroyed/recreated (native overlay orphan bug on Windows).

### Auto-Earn — Behavior Governor (anti-ban core)
Single gate every outbound send (reply/bid) passes through: min-gap, hourly cap, active-hours window, daily bid budget, jitter, and a global pause switch. Bids get stricter caps than replies.
**Key files:**
- `src/bun/freelance/session/governor.ts` — `evaluateSend`/`gateSend`, `getGovernorState`, `setPause`/`getPauseUntilMs`, `jitter`
- `src/bun/freelance/auto-earn-settings.ts` — master `enabled` switch, `autonomyMode` (assisted/full_auto), all governor knobs (key names MUST match governor.ts)
- `src/bun/freelance/watchdog.ts` — `startAutoEarnWatchdog`, bun-side timer that recovers stranded 'sending' outbox rows and escalates if the full-auto engine's heartbeat goes stale (>30min)
**Data:** `freelance_action_log`, `settings` (category `freelance`)
**Watch for:** replies and bids are separate rate-limit streams (never conflate them); active-hours check is skipped for user-initiated (assisted) sends but not for autonomous ones — don't accidentally apply it to both or neither.

### Auto-Earn — freelance-expert autonomous agent
Runs the hidden `freelance-expert` inline agent per job (full-auto only) with complete context (job description, thread transcript, persona, stored facts/credentials); triages sensitive messages (payment/contract/off-platform/dispute) to fail-closed escalation instead of auto-replying.
**Key files:**
- `src/bun/freelance/expert/orchestrator.ts` — `runFreelanceExpert`, keyword+LLM triage classifier (fails closed on classifier outage)
- `src/bun/freelance/expert/tools.ts` — `buildFreelanceExpertTools` (notify_human, freelance_request_delivery_approval — gates delivery behind human approval, freelance_mark_state, freelance_store_credential, git_clone, freelance_self_review, freelance_create_project)
- `src/bun/freelance/expert/jobs.ts` — job state machine (`lead→negotiating→awarded→in_progress→delivered→revisions→complete`, or `parked`), `freelance_job_facts` non-secret memory
- `src/bun/freelance/expert/vault.ts` — AES-256-GCM encrypted credential storage (`encryptSecret`/`decryptSecret` from `lib/secret-crypto`), secrets never echoed back
- `src/bun/freelance/expert/notify.ts` — `escalateToHuman`, three-way notify (inbox + desktop + channels), parks the job
- `src/bun/freelance/project-bootstrap.ts` — `createProjectFromListing`, idempotent AgentDesk project creation on a won job, kicks off PM planning
**Data:** `freelance_jobs`, `freelance_job_log`, `freelance_job_facts`, `freelance_credentials`, `freelance_escalations`
**Watch for:** `EXCLUDE_TOOLS` in orchestrator.ts must keep excluding kanban/approval/destructive-git tools (this agent runs with nobody to answer human-input prompts); delivery is gated by `isDeliveryApproved` — never let `freelance_mark_state('delivered')` bypass it.

### Issue Fixer — poll → trigger → fix → PR cycle
Per-project autonomous GitHub issue fixer: outbound-only polling (NAT-safe), keyword/label trigger matching gated by author authorization, runs the hidden `issue-fixer` inline agent on a dedicated branch, then deterministically commits/pushes/opens a PR — never merges.
**Key files:**
- `src/bun/issue-fixer/poller.ts` — `startIssueFixerPolling`, `pollProject`, per-project interval + max-per-hour budget
- `src/bun/issue-fixer/triggers.ts` — `matchIssue`/`matchComment`, `isAuthorizedActor` (OWNER/MEMBER/COLLABORATOR only), dedup via `alreadyProcessed`
- `src/bun/issue-fixer/orchestrator.ts` — `enqueueIssueFix`/`runIssueFix`, sequential per-project queue, branch resolution (PR-feedback / re-trigger / fresh), test-command gate, restores user's original branch on exit (stashes any dirty leftover from a failed run)
- `src/bun/issue-fixer/shell-guard.ts` — `createGuardedShellTool`, denylist blocking merge/rebase/reset/push/`gh` inside the agent's own shell (orchestrator owns push/PR)
- `src/bun/issue-fixer/config.ts` — `getIssueFixerConfig`/`saveIssueFixerConfig`, run history (`createRun`/`updateRun`), `failInterruptedRuns` on startup
- `src/bun/issue-fixer/github.ts` — GitHub API client (list issues/comments since cursor, create PR, post comment)
- `src/bun/issue-fixer/prompts.ts` — `buildIssueFixerTask`, intent classification (fix/feature/etc. from keyword)
- `src/bun/issue-fixer/notify.ts` — `notifyIssueFixResult`
- `src/mainview/components/issue-fixer/issue-fixer-tab.tsx`, `issue-fixer-settings.tsx`
**Data:** `issue_fixer_config` (one row/project), `issue_fix_runs`
**Watch for:** the agent's `excludeTools` list must keep excluding `git_push`/`git_pr`/`request_human_input`/kanban tools; a clean working tree is required at start (never silently stash the user's own uncommitted work); no new commits on a fresh branch must abort before pushing/opening an empty PR.

### Issue Sources — unified multi-tracker issue import
Source-agnostic adapter registry (GitHub/Jira/Linear/GitLab/Trello/Kanboard) that normalizes external issues into one local store, feeding the "Issues" tab and (indirectly) the kanban board via task linking.
**Key files:**
- `src/bun/issue-sources/registry.ts` — `getAdapter`, `allSources`, `validateRequiredFields`
- `src/bun/issue-sources/types.ts` — `IssueSourceAdapter` contract (`fetchIssues`, `testConnection`, optional `closeIssue`/`createIssue`/`fetchBuckets`), `normalisePriority`
- `src/bun/issue-sources/config-store.ts` — per-project per-source config in `settings` (category `issue_sources`, encrypted at rest, key `issueSource:<projectId>:<source>`)
- `src/bun/issue-sources/github.ts`, `jira.ts`, `linear.ts`, `gitlab.ts`, `trello.ts`, `kanboard.ts` — one adapter each
- `src/bun/rpc/issues.ts` — sync/import/link-to-task RPC handlers
- `src/mainview/components/issues/issues.tsx`, `issue-tracker-tab.tsx` — hosts both "Issues" (this) and "Auto Issues Fixer" (GitHub-only) as sub-tabs
**Data:** `external_issues` (unified store; `source`/`sourceId`/`taskId` link back to kanban); deprecated `github_issues` table is read-only, superseded by this
**Watch for:** Issue Fixer (GitHub-specific autonomous fixing) is a separate system from this (generic multi-source read/import/link) — don't conflate the two; adding a new source means implementing the full `IssueSourceAdapter` contract.

### Playground — isolated live-preview agent builder
Artifacts-style build loop, fully decoupled from PM/kanban/review: a dedicated `playground-agent` inline agent builds/edits files in a scratch workspace, streamed live to an in-app preview iframe with its own static file server.
**Key files:**
- `src/bun/playground/orchestrator.ts` — `runPlayground`/`stopPlayground`/`newPlayground`, JSON-file conversation history (not DB), `getPlaygroundState`
- `src/bun/playground/server.ts` — `startPlaygroundServer` (port 4760+ with fallback candidates), console-capture injection into served HTML, PDF.js viewer route (WebView2 blocks native PDF nav), file watcher auto-reloads preview on agent edits
- `src/bun/playground/paths.ts` — `PLAYGROUND_FILES_DIR`, `wipePlayground`, `hasPlaygroundFiles`
- `src/bun/agents/tools/playground.ts` — playground-only tools (`playground_render_preview`, etc.)
- `src/mainview/pages/playground.tsx`
**Data:** none in SQLite — conversation/preview state lives in JSON files under the OS temp/playground dir
**Watch for:** `excludeTools` must keep excluding `chrome-devtools_*` MCP tools (they attach to an external browser, not the in-app preview) and `request_human_input`; `newPlayground` must kill any dev servers the agent started under the workspace path before wiping files.

### Council — multi-agent Delphi/Borda decision sessions
Structured multi-agent debate: PM selects 3–5 relevant specialist personas, runs blind Round 1 responses in parallel, checks convergence, runs an informed Round 2 if needed, has agents peer-rank each other (Borda count), then the PM synthesizes a final weighted answer.
**Key files:**
- `src/bun/rpc/council.ts` — `startCouncilSession`/`stopCouncilSession`/`answerCouncilQuestion`, `runSession` (7-phase flow), `councilComplete` (routes Claude-Subscription non-Haiku models through the CLI/SDK path), `runParallelRound`, `runBordaRanking`
- `src/mainview/pages/council.tsx` — listens on `agentdesk:council-event`
**Data:** none persisted — sessions are purely in-memory (`activeSessions` map), events broadcast live
**Watch for:** `COUNCIL_AGENTS` are fixed personas (not the DB `agents` table) — a model call per agent per round is expensive; per-agent 120s timeout skips (not fails) a slow agent; `councilComplete`'s Claude Subscription branch must stay in sync with the two-path provider gate (`isHaikuModel` check).

### Collections — personal cross-project knowledge base
A workspace-independent notes/knowledge system (folders → notes with markdown, tags, `[[wiki-links]]`, attachments) plus a dedicated read-only AI chat over it, semantic search, and export.
**Key files:**
- `src/bun/rpc/collections.ts` — CRUD for collections/notes, `searchCollectionNotes`, `listCollections`
- `src/bun/collections/chat.ts` — `sendCollectionsChatMessage`, read-only tool set (`search_notes`, `semantic_search_notes`, `read_note`, `list_collections`, skills, web) — deliberately no note-creation tool
- `src/bun/collections/links.ts` — `syncNoteLinks`/`parseWikiLinkTitles` (global `[[Title]]` resolution, first-match-wins on dupes), `getLinkedNotes`/`getBacklinks`
- `src/bun/collections/storage.ts` — attachment file storage under `userData/collections/<noteId>/`, `safeAttachmentFileName` path-traversal guard
- `src/bun/collections/export.ts` — markdown/PDF/JSON export (`fonts/inter-regular-latin.ts` embeds its own TTF for pdfkit)
- `src/bun/collections/trash-purge.ts` — 30-day trash auto-purge (`updatedAt` doubles as the delete clock)
- `src/bun/collections/embeddings/embedder.ts`, `indexer.ts`, `model-manager.ts`, `similarity.ts` — local on-device embedding model (`@huggingface/transformers`, dynamically imported), cosine-similarity ranking
- `src/mainview/pages/collections.tsx`, `src/mainview/components/collections/*` (rail, note-editor, chat-panel, save-to-collection-modal, tag-editor)
**Data:** `collections`, `collection_notes` (soft-delete via `isDeleted`), `collection_note_attachments`, `collection_note_links`
**Watch for:** `@huggingface/transformers`/`sharp` must stay behind a dynamic `import()` (this exact eager-import chain broke startup for all users in a past release — see the Critical Rules native-dependency note in CLAUDE.md); attachment paths must always resolve through `storage.ts` (never construct filesystem paths elsewhere) to keep the traversal guard centralized.

### Prompts Library — saved prompt templates
Simple CRUD library of reusable prompt templates (name/description/content/category) insertable into chat.
**Key files:**
- `src/bun/rpc/prompts.ts` — `getPrompts`/`getPrompt`/`savePrompt`
- `src/mainview/pages/prompts.tsx` — `PromptForm`, list/search/edit/delete UI
**Data:** `prompts`
**Watch for:** this is unrelated to agent system prompts (`db/seed.ts`) — purely a user-facing snippet library.

### Scheduler — cron task engine + event-driven automation rules
Two related systems: (1) `cron_jobs` fire on a schedule (croner) running one of several task types; (2) `automation_rules` react to an internal event bus (e.g. cron fired, task completed) with condition matching and chained actions.
**Key files:**
- `src/bun/scheduler/cron-scheduler.ts` — `initCronScheduler`, `triggerJobNow`/`stopJobNow`, `getNextRuns`; missed schedules while the app was closed are NOT caught up (skipped, not queued)
- `src/bun/scheduler/task-executor.ts` — `executeTask`, task types: `pm_prompt` (legacy)/`reminder`/`shell`/`webhook`/`agent_task`/`agent_task_simple`/`send_channel_message`; `setTaskExecutorEngine` injects the PM engine resolver (avoids a circular import)
- `src/bun/scheduler/automation-engine.ts` — `initAutomationEngine`, `evaluateRules`, condition operators (equals/contains/not_equals), rule chaining capped at `MAX_CHAIN_DEPTH=5`
- `src/bun/scheduler/event-bus.ts` — `eventBus`, `AgentDeskEvent` types
- `src/bun/rpc/cron.ts`, `src/bun/rpc/automation.ts` — RPC handlers
- `src/mainview/pages/scheduler.tsx`, `src/mainview/components/scheduler/cron-job-form.tsx`, `automation-rule-form.tsx`, `automation-rule-card.tsx`, `schedule-builder.tsx`, `automation-templates.tsx`
**Data:** `cron_jobs`, `cron_job_history`, `automation_rules`
**Watch for:** `NOTIFY_ON_COMPLETE` task types (shell/webhook/send_channel_message) get a desktop notification because they have no other UI feedback surface — don't remove without replacing that signal; one-shot jobs (`oneShot`) auto-delete themselves + their history row after a successful run.

---

## Remote/Mobile Sync, Git UI, LSP, Annotations & App Infra

### Remote Access pairing (relay-based desktop↔browser control)
QR/paste-code pairing lets a phone or another browser become a live remote control for one desktop's AgentDesk instance, tunnelled through a free Cloudflare Worker relay (no port-forwarding). This is the **Web App** route from `docs/web-app-prd.md` — the *actually shipped* one; the competing `docs/mobile-app-prd.md` native-app route was never built (no React Native/Expo/native-mobile code anywhere in the repo).
**Key files:**
- `src/bun/remote/manager.ts` — `ensureIdentity`, `createDevicePairing`, `listPairedDevices`, `revokeDevice`, `deleteDevice`, `setRemoteAccessEnabled`; owns `remote_identity`/`remote_devices` persistence + pairing-claim-window/inactivity-expiry logic
- `src/bun/remote/relay-session.ts` — `startRelaySession`, multi-device E2E frame router (`hello`/`ack`/`rpc`/`res`/`bc` wire protocol) over one relay room
- `src/bun/remote/relay-client.ts`, `src/bun/remote/config.ts` — outbound WS client to the relay; `RELAY_HTTP`/`RELAY_WSS`/`WEB_URL` (Cloudflare Workers/Pages endpoints, env-overridable)
- `src/bun/remote/rpc-handlers.ts` — the single `requestHandlers` map shared by the Electrobun bridge AND remote transports (guarantees identical behavior)
- `src/bun/remote/rpc-ws-server.ts`, `src/bun/remote/index.ts` — opt-in direct/LAN WebSocket RPC server, gated by `AGENTDESK_REMOTE_RPC_PORT`
- `src/bun/remote/broadcast-bus.ts`, `src/bun/remote/broadcast-hook.ts` — fan out webview broadcasts (`engine-manager`'s `registerRemoteBroadcastSink`) to every connected remote transport
- `src/shared/remote/e2e.ts` — ECDH P-256 → HKDF-SHA256 → AES-256-GCM session crypto (`generateKeyPair`, `deriveSessionKey`, `encryptFrame`/`decryptFrame`)
- `src/shared/remote/pairing.ts` — `PairingPayload`/`encodePairingPayload`, the QR contents (relay URL, roomId, pairingId, clientToken, desktop public key, out-of-band pairing secret)
- `src/shared/remote/web-pairing.ts` — browser-side `completeAndStorePairing`/`loadStoredPairing`/`isPaired`/`clearStoredPairing`
- `src/shared/remote/relay-rpc-client.ts`, `src/shared/remote/ws-rpc-client.ts` — browser-side transports (relay-tunnelled vs. dev-direct plaintext WS)
- `src/mainview/lib/remote-transport.ts` — `IS_REMOTE`/`IS_DEV_DIRECT` detection, `createRemoteRpcTransport`/`createDevRpcTransport`, the full broadcast-method → `agentdesk:*` DOM-event map (must stay in sync with `rpc.ts`'s `messages` handlers)
- `src/mainview/components/remote/pairing-screen.tsx` — web-mode "enter pairing code" screen shown when unpaired
- `src/mainview/components/remote/remote-status-banner.tsx` — "connecting/offline" banner + Re-pair escape hatch for a stranded device
- `src/mainview/pages/settings/remote-access.tsx` — desktop-side enable toggle, QR generation, paired-device list/revoke
- `vite.web.config.ts` — separate build target (`bun run build:web` → `dist-web/`, `bun run deploy:web` → Cloudflare Pages `agentdeskweb`); **same React source**, not a separate app
**Data:** `remote_identity`, `remote_devices` (raw-SQL migration, **not in `schema.ts`**) — per-device pairing secret encrypted via `lib/secret-crypto`
**Watch for:** the pairing claim window (30 min) and device inactivity expiry (90 days) in `manager.ts`'s `resolvePairingSecret` are security-load-bearing — loosening them silently re-opens a stale/leaked QR; `rpc-handlers.ts`'s combined `requestHandlers` map is the ONLY place a new RPC group needs registering for both the Electrobun bridge and remote transports to see it — adding a group elsewhere and forgetting this file makes the feature silently unavailable over remote/web only (easy to miss since desktop testing won't catch it).

### Remote Sync (SFTP/FTP deployment-target file sync)
Unrelated to device pairing above despite the similar name — this is a per-project SFTP/FTP(S) connection that pulls/pushes files between the local workspace and a remote server (e.g. a shared host or VPS), with a content-hash manifest for diffing and conflict detection. Used for deploying to traditional hosting, not for mobile/remote control.
**Key files:**
- `src/bun/remote-sync/client.ts` — protocol-agnostic `RemoteClient` (`createRemoteClient`) wrapping `ssh2-sftp-client` (SFTP) and `basic-ftp` (FTP/FTPS); SFTP host-key fingerprint capture + trust-on-first-use/pinned verification
- `src/bun/remote-sync/engine.ts` — `pull`/`push`/`computePushDiff`/`computePullConflicts`/`getPushFileDiff`/`browseRemoteDir`/`testConnection`; per-project single-flight lock (`active` map + `AbortController`), glob-based `excludePatterns`, path-traversal guards (`toLocalAbs`/`isSafeRel`), a short-lived cached "browse" connection with stale-socket retry
- `src/bun/remote-sync/config.ts` — `remote_sync_config`/`remote_sync_items`/`remote_sync_runs` CRUD, credential encrypt/decrypt, `failInterruptedRuns` (marks crash-interrupted runs failed on startup)
- `src/bun/remote-sync/crypto.ts` — re-exports `lib/secret-crypto` (same AES-256-GCM scheme as Remote Access)
- `src/mainview/components/remote-sync/remote-sync-tab.tsx` — pull/push tabs, live progress, pull-conflict warning dialog
- `src/mainview/components/remote-sync/connection-form.tsx` — host/protocol/auth/base-path/exclude-patterns form
- `src/mainview/components/remote-sync/remote-tree.tsx` — lazy remote directory tree for selecting files/folders to sync
- `src/mainview/components/remote-sync/push-diff-dialog.tsx` — per-file local-vs-remote diff preview before upload
- Rendered from `src/mainview/pages/project.tsx` (a project tab)
**Data:** `remote_sync_config`, `remote_sync_items` (manifest: sha256/size/mtime per synced file), `remote_sync_runs`
**Watch for:** `toLocalAbs`/`isSafeRel` are the only guard against a malicious/misconfigured server path (`../../etc`) writing outside the workspace during pull — never bypass them when adding a new write path; the FTP client's "transfer reported N items but parsed 0" retry logic works around real firewall/ALG behavior seen in production, don't remove it as "dead code."

### Git integration — agent-facing tools
The tool surface agents use to inspect/mutate a repo (`git status`/diff/commit etc.), separate from the human-facing Git tab. Auto-commit-on-task-completion and feature-branch creation are driven from the review cycle, not this tool file directly.
**Key files:**
- `src/bun/agents/tools/git.ts` — `git_status`, and sibling tools (diff/commit/etc.) built on `runGit` (`src/bun/lib/git-runner.ts`); reads `settings` category `git` for auto-commit template
- `src/bun/agents/review-cycle.ts` — `autoCommitTask(projectId, taskId, taskTitle)`: switches/creates the feature branch and commits when a task completes, gated by the `autoCommitEnabled` setting; also owns the automatic code-review spawn on column→review
- `src/bun/rpc/github-api.ts` — `gitAuthArgs(token)`/`githubAuthPrefix(...)`: the **mandatory** auth-injection helper for any git network op (clone/fetch/pull/push) — see CLAUDE.md's git-auth rule; never embed the token in the URL or persist via `git config`
**Watch for:** any new agent tool or engine code path that shells out to `git` for a network operation (clone/fetch/pull/push) MUST go through `gitAuthArgs`/`githubAuthPrefix`, never the system credential helper — this is a recurring correctness+security trap called out explicitly in CLAUDE.md.

### Git integration — human-facing Git tab
A per-project Git panel: branches, staged-file commit/push, unified diff viewer, commit log with per-commit file lists, pull-request tracking (local, GitHub-independent), and a merge-conflict resolver that can hand off to the agent team.
**Key files:**
- `src/mainview/components/git/git-tab.tsx` — tab shell (`GitTab`), Overview/Pull Requests/Conflicts Resolver sub-tabs, auto-commit settings editor, pull-with-no-upstream branch prompt
- `src/mainview/components/git/branch-list.tsx` — create/switch/delete local branches
- `src/mainview/components/git/staged-files.tsx` — file checklist, commit message box, commit + push (push does a silent pull first)
- `src/mainview/components/git/diff-viewer.tsx` — hand-rolled unified-diff parser/renderer (`parseGitDiff`), collapsible per-file hunks with line numbers
- `src/mainview/components/git/commit-log.tsx` — expandable commit rows showing changed files (`getCommitFiles`)
- `src/mainview/components/git/conflict-resolver.tsx` — lists conflicted files, colorized conflict-marker diff, "Resolve with AI" (opens a new chat conversation seeded with a resolve-conflicts prompt), abort-merge
- `src/mainview/components/git/pull-requests.tsx` — local PR CRUD, merge (merge/squash/rebase strategies), PR comments, AI-generated PR description, "Feature branch workflow" toggle (persisted per-project setting `featureBranchWorkflow`)
- `src/bun/rpc/git.ts`, `src/bun/rpc/pulls.ts` — backend for the above
- `src/bun/rpc-groups/git-analytics.ts` — RPC group wiring (also bundles PRs, GitHub/multi-source issues, analytics, audit log, backup/restore)
**Data:** `pull_requests`, `pr_comments`
**Watch for:** `DiffViewer`'s diff parser is hand-written regex/string-scanning (not a library) — a change to git's diff output format (rare) or an edge case (renames, no-newline-at-EOF) can silently mis-render rather than error.

### Git integration — Branch Strategy (built but orphaned — see "Known dead/orphaned code")
A full branching-model config UI (GitHub Flow/Git Flow/Trunk-based, prefixes, naming template, protected branches, auto-cleanup of merged branches) with a working RPC backend and DB table — but **the React component is never imported or rendered anywhere** in the app. This is distinct from (and NOT the same mechanism as) the PM's actually-used `set_feature_branch` tool + `currentFeatureBranch:<projectId>` setting.
**Key files:**
- `src/mainview/components/git/branch-strategy.tsx` — orphaned component (`BranchStrategy`)
- `src/bun/rpc/branch-strategy.ts` — `getBranchStrategy`/`saveBranchStrategy`/`createFeatureBranch`/`getMergedBranches`/`cleanupMergedBranches` (the latter two ARE only called from this same orphaned component)
- `src/bun/db/schema.ts` — `branchStrategies` table
**Data:** `branchStrategies`
**Watch for:** if a future refactor "cleans up" seemingly-dead code, don't delete this without checking whether it was *meant* to be wired into `git-tab.tsx` and simply never finished — it's a real, working feature minus one `<BranchStrategy .../>` render call and its Overview-sub-tab wiring.

### LSP diagnostics infra (agent tool only, no editor UI)
Spawns real language servers (typescript-language-server, pyright, gopls, rust-analyzer, intelephense, vscode-langservers-extracted for html/css/json) on demand to give agents diagnostics/hover/definition/references/document-symbols — there is no in-app code editor, so this never renders inline squiggles; it's purely an agent tool plus a Settings→Plugins install/enable panel.
**Key files:**
- `src/bun/lsp/types.ts` — LSP 3.17 subset types (`Diagnostic`, `DiagnosticSeverity`, `Hover`, `DocumentSymbol`, etc.)
- `src/bun/lsp/servers.ts` — `SERVER_DEFS` registry (binary, args, extensions→languageId, install method), `getServerForExtension`
- `src/bun/lsp/client.ts` — `LSPClient`: spawns the server process, JSON-RPC initialize handshake, document open/change sync, debounced diagnostics collection
- `src/bun/lsp/jsonrpc.ts` — `JsonRpcTransport` framing over the child process's stdio
- `src/bun/lsp/installer.ts` — `getInstallStatus`/`installServer`/`uninstallServer`/`checkPrerequisite` (bun/go/github install methods)
- `src/bun/plugins/lsp-manager/index.ts` — `getOrSpawnServer`, `openDocs`, `pluginSettings`: per-extension server pool + per-`{id}_enabled`/`{id}_binary` settings, treated as a "plugin" (has a `manifest.json`)
- `src/bun/agents/tools/lsp.ts` — the 5 agent tools: `lspDiagnosticsTool`, `lspHoverTool`, `lspDefinitionTool`, `lspReferencesTool`, `lspDocumentSymbolsTool`
- `src/bun/rpc/lsp.ts` — `getLspStatus`/`installLspServerHandler`/`uninstallLspServerHandler`
- `src/mainview/pages/plugins.tsx` — "LSP Manager Card"
**Data:** `plugins` table, row `name = "lsp-manager"`, `settings` JSON blob holding per-server enabled/binary overrides
**Watch for:** `getOrSpawnServer` pools one `LSPClient` per (extension, workspace) — a long-running orphaned server process (e.g. if `shutdown()` isn't called on app quit) leaks a real subprocess; the TypeScript server def disables Automatic Type Acquisition specifically to avoid the initialize handshake hanging on an implicit `npm install`.

### Annotations (visual UI feedback → agent chat)
A local HTTP proxy + injected in-page toolbar that lets a human click elements in a live preview (of the user's own app, proxied through AgentDesk) and leave comments; batched annotations plus buffered console errors/unhandled-rejections are formatted into a single chat message and sent straight into the project's agent engine. This is the mechanism behind `/preview` — a dedicated Electrobun window, not chrome-devtools MCP.
**Key files:**
- `src/bun/annotations/server.ts` — `startAnnotationServer` (Bun.serve on port 4748, falls back through `PORT_CANDIDATES` 4748-4752): `/toolbar.js`, `/preview` (HTML/file:// proxy that injects the toolbar + a `<base>` tag), `/file-serve/<path>` (serves local assets over http to dodge file:// mixed-content blocks), `/preview-events` (buffers console errors per conversation), `/annotations` (POST → `formatBatchMessage` → `getOrCreateEngine(projectId).sendMessage(...)`, auto-creating a conversation if needed)
- `src/bun/annotations/preview-window.ts` — `openPreviewWindow`/`closePreviewWindow`: singleton `BrowserWindow` reused across `/preview` calls, persisted size/position, title-sync polling, `fs.watch`-driven reload for static (non-HMR) projects, dev-mode DevTools global shortcut
- `src/bun/annotations/toolbar-script.ts` — `getToolbarScript`: the injected in-page JS (element picker, comment UI, batch submit)
**Data:** none persisted — annotations flow straight into a conversation's `messages` via the normal engine path; console events are in-memory only (drained on next submission)
**Watch for:** the annotation server's port is a shared, guessable local resource — if a previous AgentDesk instance's subprocess is orphaned and still holds 4748-4752, annotation/preview silently stops working with only a console warning; `injectToolbar`'s `<body>`/`<head>` string-splicing is fragile against malformed/streamed HTML.

### Command Palette (Cmd+K style — currently unreachable, see "Known dead/orphaned code")
A `cmdk`-based palette with debounced global search (recent-searches history, project/conversation/task/doc results), quick navigation, and a "New Project" action. Fully implemented and RPC-wired, but no code anywhere calls `setPaletteOpen(true)` — no keyboard shortcut listener, no menu item, no button.
**Key files:**
- `src/mainview/components/command-palette.tsx` — `CommandPalette`, recent-searches (`localStorage` key `agentdesk:recent-searches`), 300ms-debounced `rpc.globalSearch`
- `src/mainview/components/layout/app-shell.tsx` — mounts `<CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />`; `paletteOpen` state exists but is never set to `true` anywhere
**Data:** none of its own — reads via `globalSearch`
**Watch for:** if a future change appears to "fix" the palette by wiring a keyboard shortcut, that's expected/desired; conversely, don't assume the palette is reachable when reasoning about UX flows today.

### Global Search (backend feature powering the Command Palette)
FTS5-backed search across projects, conversation titles, kanban tasks, and notes (with a LIKE fallback if FTS5 is unavailable), capped at 20 results. Only consumer today is the (unreachable) Command Palette above.
**Key files:**
- `src/bun/rpc/search.ts` — `globalSearch(query)`: projects/conversations/kanban_tasks via `LIKE`, `notes` via `notes_fts` MATCH with a `LIKE` catch-block fallback
**Data:** `projects`, `conversations`, `kanban_tasks`, `notes` + `notes_fts` (FTS5 virtual table)
**Watch for:** do not confuse this with `docs/search-provider-fallback-plan.md` — that document is about the **agent's `web_search` tool** (Tavily→Brave→DuckDuckGo, or Exa→Tavily→DuckDuckGo; see `src/bun/agents/tools/web.ts`), a completely unrelated "search the internet" feature, not this in-app data search.

### Keyboard Shortcuts (schema-only, fully vestigial — see "Known dead/orphaned code")
A `keyboard_shortcuts` table was created in the very first migration but has zero readers or writers anywhere in the current codebase.
**Key files:** `src/bun/db/migrations/v1_initial-schema.ts`
**Data:** `keyboard_shortcuts` (raw-SQL migration table, not in `schema.ts`)

### App-level infra (single instance, Windows registry, message queue)
Three small cross-cutting subsystems worth knowing about when touching startup/window/message-delivery code, even though none are "features" with UI of their own.
**Key files:**
- `src/bun/single-instance.ts` — Windows-only loopback-TCP handoff (`acquireSingleInstanceLock`/`sendHandoffToPrimary`): a second launch either hands off a Quick Chat open-request or an "activate main window" request to the already-running instance, then exits; channel-qualified ports (`stable`/`canary`/`dev`) so side-by-side installs never collide. No-ops (always returns true) on macOS, which gets equivalent behavior for free via Launch Services `open-url`.
- `src/bun/windows-registry.ts` — **not a window-tracking registry** despite the name: `registerWindowsUninstaller()` writes the app to Windows "Add or Remove Programs" via a fire-and-forget PowerShell script, with a local cache file to skip the subprocess entirely on unchanged-version launches. Stable-channel + win32 only.
- `src/bun/message-queue-manager.ts` — in-memory (not persisted) per-project-per-conversation queue (`MESSAGE_QUEUE_MAX` 3) for messages typed while the PM/agents are busy; drained by engine-manager's idle-check, not by any mounted component, so a queued message reaches the right conversation even if the user navigated away.
**Watch for:** `single-instance.ts`'s TCP-loopback approach specifically replaced an earlier named-pipe implementation that crashed under Electrobun's bundled Bun — don't "simplify" it back to `net.Server.listen(path)`; `windows-registry.ts`'s uninstaller registration is silently skipped for dev/canary channels by design (only `stable` registers), not a bug.

---

## Appendix: Database Schema & RPC Contract Reference

> Cross-cutting grounding index for every section above. When in doubt about
> which table or RPC contract a feature touches, check here.

### Database Schema Reference

**Source of truth:** `src/bun/db/schema.ts` (~1275 lines, 60 Drizzle-managed tables). Migrations live in `src/bun/db/migrations/` — 59 files, `v1_initial-schema.ts` through `v59_ai-telemetry-events.ts`. Convention: **indexes and dedup-uniques are frequently added in later raw-SQL migrations, not inline in the Drizzle schema.**

#### Core App / Settings
- **`settings`** — generic key/value app-config store, JSON-serialized values. (v1)
- **`ai_providers`** — configured AI provider credentials, base URL, default model, isDefault/isValid flags. (v1)
- **`model_preferences`** — sparse per-(provider,model) enabled/favorite/last-used state backing the chat model picker. (v52)
- **`model_capabilities_cache`** — cached model-type classification (language/embedding/image/etc.) badges, invalidated on provider CRUD. (v58)
- **`custom_env_vars`** — user-defined environment variables managed from Settings. (v32)
- **`audit_log`** — generic action/entity/details event log.

#### Projects
- **`projects`** — workspace directory + optional GitHub repo; `isQuickChat` flags Quick-Chat-origin projects (hidden until promoted). (v1; `isQuickChat` added v57)

#### Conversations & Messages
- **`conversations`** — per-project chat threads (pinned/archived). (v1)
- **`messages`** — role/agent/content/metadata/tokenCount; `hasParts` flags decomposed rendering. (v1)
- **`conversation_summaries`** — compaction summaries with a `messagesUpToId` cutoff marker. (v1)
- **`message_parts`** — decomposed per-message parts (text/tool_call/tool_result/reasoning/agent_start/agent_end) for inline sub-agent rendering. (v4 — replaced the v3 session model, see below)
- ~~`agent_sessions` / `agent_session_messages`~~ — **created in v3, dropped in v4** when the inline-agent model replaced persistent per-agent sessions. No longer exist in schema.ts.

#### Agents & Tools
- **`agents`** — built-in + custom agent roster: system prompt, provider/model override, temperature, thinking budget, `isBuiltin`, custom-agent flags (`useSystemPromptOnly`, `chatEnabled`, `availableToPm`). (v1; custom flags v23, `availableToPm` v24)
- **`agent_tools`** — per-agent tool enable/disable + JSON config. (v1; reviewer-tool changes v7)
- **`agent_memories`** — durable per-(agent,project) memory with LRU recall bookkeeping, distinct from `notes`. (v49)

#### Kanban & Tasks
- **`kanban_tasks`** — board tasks: column (backlog/working/review/done), priority, acceptance criteria, reviewRounds, verificationStatus. (v1; verification-status v6)
- **`kanban_task_activity`** — activity/audit log of task moves/edits/comments. (v1)

#### Notes & Collections (personal knowledge base)
- **`notes`** — project-scoped docs authored by agents/users. (v1)
- **`collections`** — cross-project personal note categories (Default collection seeded, delete-blocked). (v56)
- **`collection_notes`** — GFM markdown notes with tags, favorite/trash flags, provenance (`sourceType`/`sourceRef`), packed-Float32 `embedding` blob. (v56)
- **`collection_note_attachments`** — file metadata for on-disk attachments (never inlined in DB). (v56)
- **`collection_note_links`** — resolved `[[wiki-link]]` graph between collection notes. (v56)

#### Prompts
- **`prompts`** — builtin + custom reusable prompt templates. (v1)

#### Plugins & Skills
- **`plugins`** — plugin registry: enabled flag, JSON settings, optional system-prompt snippet. (v2)

#### Channels & Inbox (Discord/WhatsApp/Email/chat)
- **`channels`** — per-project channel platform config (Discord etc.), enabled flag. (v1)
- **`whatsapp_sessions`** — WhatsApp Baileys creds/keys persistence. (v1)
- **`inbox_messages`** — unified inbox across platforms; read/archived/favorite, thread/category/priority. (v1; favorites v55)
- **`inbox_rules`** — condition/action routing rules for inbox categorization. (v1)
- **`notification_preferences`** — per-platform/project sound/badge/banner + mute-until. (v1)

#### Scheduler & Automation
- **`cron_jobs`** — scheduled tasks (cron expression, timezone, one-shot, task type/config). (v1)
- **`cron_job_history`** — execution log per cron job. (v1)
- **`automation_rules`** — event-triggered automation (trigger + actions JSON). (v1)

#### Git / PRs / Issues / Deploy
- **`deploy_environments`** — per-project deploy target (branch, command, URL). (v1)
- **`deploy_history`** — deploy run log (status, output, duration, triggeredBy). (v1)
- **`pull_requests`** — local PR tracking, optionally GitHub-synced (state, merge strategy). (v1)
- **`pr_comments`** — PR review comment threads (human or agent authored). (v1)
- **`webhook_configs`** — GitHub webhook polling config (event types). (v1)
- **`webhook_events`** — polled GitHub event log with dedup via `githubEventId`. (v1)
- ~~`github_issues`~~ — **deprecated, read-only**; GitHub-only issue↔task sync table, superseded by `external_issues`. (v1)
- **`external_issues`** — unified multi-source issue store (github/jira/linear/gitlab/trello/kanboard), **supersedes `github_issues`**. (v33; due-date v34)
- **`branch_strategies`** — per-project branching model (gitflow/github-flow/trunk), naming template, protected branches. See "Known dead/orphaned code" — the UI for this is unwired. (v1, expanded later)

#### Issue Fixer
- **`issue_fixer_config`** — per-project config: keywords/labels, auth mode, autonomy (branch_pr/draft), rate limits. (v27; notify-enabled v31)
- **`issue_fix_runs`** — run history/log (trigger type, status, PR outcome, test result). (v27)

#### Cost / Telemetry / Analytics
- **`cost_budgets`** — daily/weekly/monthly spend alert thresholds, per-project or global. (v1)
- **`ai_telemetry_events`** — AI SDK v7 global telemetry sink; one row per lifecycle event (start/language_model_call_end/tool_execution_end/end/error/abort), correlated by `callId`; feeds AI Usage/Cost Analytics. (v59)

#### Remote Sync (SFTP/FTP)
- **`remote_sync_config`** — per-project connection (protocol/host/encrypted creds), selections, exclude patterns. (v29; security excludes v30)
- **`remote_sync_items`** — local↔remote file manifest driving push-diff detection (size/mtime/sha256). (v29)
- **`remote_sync_runs`** — pull/push/test run history (file counts, bytes, status). (v29)

#### Remote Access (mobile/web pairing)
- Tables introduced at v47 (`remote-access-devices`) — device pairing records for the Remote Access feature.

#### Freelance / Auto-Earn
- **`freelance_listings`** — scraped job listings (skills, budget, AI "workability wizard" verdict/reason/blockers, client quality signals). (v12; full description v16, wizard verdict v17, client-quality v43, block-kind v44, country v45, indexes v50)
- **`freelance_chat_messages`** — per-listing strategist chat history. (v14)
- **`freelance_accounts`** — one row per connected platform account (self user id, profile skills, autonomy mode). (v35, profile skills v41)
- **`freelance_inbox_threads`** — intercepted platform messaging threads, correlated to listings via `contextId`/`linkConfidence`. (v35)
- **`freelance_inbox_messages`** — intercepted platform messages per thread. (v35)
- **`freelance_inbox_users`** — lightweight identity cache (username/displayName/role/country) for inbox rendering. (v35)
- **`freelance_outbox`** — drafted/queued replies & bids, assisted vs full-auto autonomy, governor-paced `scheduledFor`. (v36)
- **`freelance_action_log`** — Behavior Governor audit trail (login/inbox_sync/send_reply/submit_bid/blocked). (v36)
- **`freelance_jobs`** — state-machine job/opportunity record (lead→negotiating→awarded→...→complete/parked). (v38)
- **`freelance_credentials`** — AES-256-GCM encrypted client-provided access vault (FTP/SFTP/git/CMS). (v38)
- **`freelance_job_log`** — per-job autonomous-action audit timeline. (v38)
- **`freelance_job_facts`** — non-secret client/project facts learned from conversation, injected into agent context. (v39)
- **`freelance_escalations`** — needs-attention queue escalated to the human (severity/status). (v40, delivery-approval)

#### Misc / Cross-cutting
- **`project_activity`** — per-(project,location) unread-agent-activity tracking (lastActivityAt vs lastSeenAt) driving dashboard/tab unread dots. (v28)

#### Not in `schema.ts` (raw-SQL-migration-only tables)
- **`keyboard_shortcuts`** — created directly in `v1_initial-schema.ts` via raw SQL; not modeled in Drizzle's `schema.ts`.
- **`remote_identity`, `remote_devices`** — Remote Access pairing tables (`v47_remote-access-devices.ts`).

### RPC Contract Layer Reference

#### `src/shared/rpc/*.ts` (31 files — the frontend↔backend interface boundary)

- `src/shared/rpc/index.ts` — assembly point: intersects (`&`) all domain `*Requests` types into one `BunRequests`, wraps with `BunMessages` as `RPCSchema<{requests, messages}>` under `bun`, attaches the reverse-direction `WebviewSchema` under `webview`.
- `src/shared/rpc/settings.ts` — generic key/category settings get/save + export/import.
- `src/shared/rpc/providers.ts` — AI provider CRUD/test, model listing, tool-support checks, Claude Subscription status, per-model preferences.
- `src/shared/rpc/projects.ts` — project CRUD, settings, workspace file browsing, repo clone, Quick Chat open/promote/route.
- `src/shared/rpc/system.ts` — app-level grab-bag: health, DB maintenance/backup/restore, export/import, audit log, MCP config, prompt log/enhancer, shell/user-question approvals, terminal, DB viewer; also defines `BunMessages`.
- `src/shared/rpc/webview.ts` — Bun→frontend push schema: one `getViewState` request + ~70 messages (streaming, agent status, plan approval, kanban/conversation/inbox/playground/issue-fixer/remote-sync/freelance/skills-chat/council events).
- `src/shared/rpc/conversations.ts` — conversation CRUD, message send/retrieve/delete/parts, generation stop/retry, message queueing.
- `src/shared/rpc/agents.ts` — agent roster CRUD, per-project runtime control, PM status, per-agent tool config.
- `src/shared/rpc/kanban.ts` — kanban task CRUD, column moves, completion stats.
- `src/shared/rpc/notes.ts` — project notes CRUD/search, prompt library CRUD/search, workspace plans, global search.
- `src/shared/rpc/collections.ts` — collections/notes CRUD, trash lifecycle, search/chat, export, attachments, backlinks.
- `src/shared/rpc/dashboard.ts` — dashboard floating-chat (PM + custom-agent variants): send/abort/clear.
- `src/shared/rpc/git.ts` — git ops, conflict resolution, PR CRUD/merge, branch-strategy config, legacy GitHub-issue sync, token validation.
- `src/shared/rpc/issues.ts` — multi-source issue tracker (GitHub/Jira/Linear/GitLab/Trello/Kanboard): config, sync, list, link/create.
- `src/shared/rpc/issue-fixer.ts` — Issue Fixer config CRUD, run history/detail, manual poll/trigger/cancel.
- `src/shared/rpc/deploy.ts` — deploy environment CRUD, history, execute.
- `src/shared/rpc/integrations.ts` — Discord/WhatsApp/Email channel CRUD/test/status.
- `src/shared/rpc/inbox.ts` — unified inbox CRUD, inbox rules, notification prefs, cron jobs, automation rules.
- `src/shared/rpc/freelance.ts` — Auto-Earn pipeline: listings, wizard, inbox/outbox/bids, escalations, jobs/earnings, governor, chat.
- `src/shared/rpc/skills.ts` — skill registry list/refresh/open/delete, tool listing, skills-search chat.
- `src/shared/rpc/plugins.ts` — plugin list/toggle/settings/prompt, UI extension points.
- `src/shared/rpc/playground.ts` — Playground send/stop/reset, snapshot, promote-to-project, export, source view/edit, dev-server, deploy.
- `src/shared/rpc/council.ts` — start/stop multi-agent Council session, answer follow-ups.
- `src/shared/rpc/remote-sync.ts` — SFTP/FTP config, connection test/browse, pull/push diffing, run history, cancel.
- `src/shared/rpc/remote-access.ts` — Remote Access status, enable/disable, device pairing CRUD.
- `src/shared/rpc/activity.ts` — unread agent-activity get/mark-seen.
- `src/shared/rpc/analytics.ts` — task-completion stats/heatmaps, AI usage/cost telemetry, provider health trends.
- `src/shared/rpc/env-vars.ts` — custom global env var CRUD.
- `src/shared/rpc/recommendations.ts` — external CLI dependency check + install queue.
- `src/shared/rpc/lsp.ts` — LSP server status/install/uninstall.
- `src/shared/rpc/updater.ts` — app update check/download/apply.
- `src/shared/rpc/whats-new.ts` — release-notes should-show/entries/mark-seen.

#### `src/bun/rpc/*.ts` (58 files — handler implementations) grouped by domain

**Settings / Providers / System**: `settings.ts`, `providers.ts` (provider CRUD/test, model discovery/classification, per-model prefs), `settings-export.ts`, `reset.ts` (full app wipe + reseed), `updater.ts`, `updater-portable.ts` (Windows portable zip-swap updater), `env-vars.ts`, `recommendations.ts`, `health.ts`, `backup.ts` (VACUUM INTO snapshots), `maintenance.ts`, `audit.ts`, `export-import.ts`, `db-viewer.ts` (allowlisted table browser).

**Projects / Deploy**: `projects.ts` (project CRUD, Quick Chat, clone, workspace browse, auto-execute detection), `deploy.ts`.

**Conversations / Agents / Kanban / Notes**: `conversations.ts` (CRUD, cursor pagination, parts), `agents.ts`, `kanban.ts`, `notes.ts`.

**Dashboard / Council**: `dashboard.ts` (in-memory PM widget chat, no persistence/dispatch), `dashboard-agent.ts`, `council.ts` (Delphi+Borda multi-agent discussion engine).

**Collections**: `collections.ts` (notes/attachments/links CRUD, embeddings/reindex, export, chat assistant).

**Git / PRs / Issues / Branch strategy**: `git.ts`, `pulls.ts`, `github-issues.ts` (legacy shim → `issues.ts`), `issues.ts` (multi-source sync engine), `github-api.ts` (GitHub REST client, credential-manager-safe auth), `branch-strategy.ts`.

**Issue Fixer / Remote Sync / Remote Access**: `issue-fixer.ts`, `remote-sync.ts`, `remote-access.ts`.

**Plugins / Skills / Dev tooling**: `plugins.ts`, `plugin-extensions.ts`, `skills.ts`, `skills-search-chat.ts`, `lsp.ts`, `mcp.ts`, `search.ts` (global FTS5+LIKE search), `prompts.ts`.

**Channels / Inbox / Scheduler / Automation**: `discord.ts`, `whatsapp.ts`, `email.ts`, `notifications.ts`, `inbox.ts`, `inbox-rules.ts`, `cron.ts`, `automation.ts`.

**Freelance / Auto-Earn**: `freelance.ts` (listing feed/approve→project bootstrap), `freelance-chat.ts` (per-listing strategist chat), `freelance-wizard.ts` (AI workability verdicts, batch shortlist runner — largest single file in the RPC layer), `freelance-inbox.ts`, `freelance-outbox.ts` (governor-gated bid/reply send), `freelance-expert.ts` (escalations, delivery approval, earnings).

**Playground**: `playground.ts` (send/stop, source edit, dev-server, export/deploy).

**Analytics**: `analytics.ts` (kanban/task stats, AI telemetry queries, provider health).

#### `src/bun/rpc-groups/*.ts` (10 files — bundling layer)

- `agents-kanban-notes.ts` — bundles `agents.ts` + `kanban.ts` (with webview broadcast fan-out) + `notes.ts`.
- `conversations-control.ts` — bundles `conversations.ts` + `dashboard.ts` + `dashboard-agent.ts`, plus inline engine-manager/message-queue calls: the whole "live chat/agent control" surface.
- `features.ts` — bundles `playground.ts`, `whats-new.ts`, `issue-fixer.ts`, `remote-sync.ts`, `activity.ts`, all `freelance*.ts` files, `remote-access.ts`, and a dynamically-imported `council.ts` — the opt-in feature grab-bag.
- `plugins-tools.ts` — bundles `plugins.ts`, `plugin-extensions.ts`, `skills.ts`, `skills-search-chat.ts`, `lsp.ts`, `db-viewer.ts`, `mcp.ts`, `maintenance.ts`, `search.ts`, `prompts.ts` — developer-tooling/extensibility domain.
- `channels-inbox-scheduler.ts` — bundles `discord.ts`, `whatsapp.ts`, `email.ts`, `notifications.ts`, `inbox.ts`, `inbox-rules.ts`, `cron.ts`, `automation.ts`.
- `collections.ts` — bundles nearly all of `rpc/collections.ts` plus inline file-picker/reveal-in-folder handlers.
- `projects-system.ts` — bundles `projects.ts` + `deploy.ts` plus inline OS-integration handlers.
- `git-analytics.ts` — bundles `git.ts`, `pulls.ts`, `github-issues.ts`, `issues.ts`, `github-api.ts`, `branch-strategy.ts`, `analytics.ts`, `audit.ts`, `backup.ts`, `export-import.ts`, `health.ts`.
- `settings-providers.ts` — bundles `settings.ts`, `providers.ts`, `settings-export.ts`, `reset.ts`, `updater.ts`, `env-vars.ts`, `recommendations.ts`, plus `agents/prompt-logger.ts` and the setting-callbacks registry.
- `setting-callbacks.ts` — **not a handler bundle**: a small `Map`-based `onSettingChange()` registry that `settings-providers.ts`'s `saveSetting` calls into; re-exported directly by `rpc-registration.ts`.

### Merge chain (contract → handler → group → registration → client)

`src/bun/remote/rpc-handlers.ts` object-spreads the `handlers` export of the 9 real rpc-groups files (everything except `setting-callbacks.ts`) into one flat `requestHandlers` map. This single map is the transport-agnostic source of truth, consumed identically by two bridges: **`src/bun/rpc-registration.ts`** (Electrobun bridge) wraps every handler with `withErrorToast()` and passes the result to `BrowserView.defineRPC<AgentDeskRPC>({ maxRequestTime: Infinity, handlers })` — called once for the singleton main-window `rpc` and again per Quick Chat window via `createRpc()`; and **`src/bun/remote/rpc-ws-server.ts`** (WebSocket bridge for paired/web clients), which re-dispatches incoming frames straight into `requestHandlers[method](params)`. Because both transports share the exact same handler map, a call behaves identically regardless of path.

### `src/mainview/lib/rpc.ts` (frontend client, ~1965 lines)

Defines the webview-side `Electroview.defineRPC<AgentDeskRPC>` instance (registering incoming `messages.*` handlers that re-dispatch every Bun→frontend push as a `window.dispatchEvent(new CustomEvent("agentdesk:*"))`), then exports one thin, fully-typed `rpc` object with a hand-written convenience wrapper per RPC method. Transport is swapped transparently for remote/web builds (`IS_REMOTE`/`IS_DEV_DIRECT` select a WS-RPC client instead of the native Electrobun bridge) behind the identical `rpc.request`/`rpc.send` surface.

**How this fits together**: AgentDesk's RPC boundary is a strict four-file (plus client) wiring pattern. (1) A **contract** in `src/shared/rpc/<domain>.ts` declares the input/output TypeScript shapes for a domain's requests (and any push messages), intersected into the single `AgentDeskRPC` type by `src/shared/rpc/index.ts`. (2) A **handler** in `src/bun/rpc/<domain>.ts` implements the actual logic against Drizzle/`schema.ts`. (3) A **grouping** file in `src/bun/rpc-groups/<group>.ts` bundles several related handler modules' exports into one `handlers` object (no 1:1 file mapping between `rpc/` and `rpc-groups/` — groups are domain clusters). (4) **Registration**: `src/bun/remote/rpc-handlers.ts` merges all groups into one `requestHandlers` map, which `src/bun/rpc-registration.ts` and `src/bun/remote/rpc-ws-server.ts` both consume identically. (5) The **client** call happens through `src/mainview/lib/rpc.ts`'s typed `rpc.*` wrapper, which every React component uses.

This chain is the interface boundary described in CLAUDE.md — it should **never** be bypassed with direct DB calls from the frontend; every frontend-to-backend interaction must go through a declared contract in `src/shared/rpc/`.

