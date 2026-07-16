# AI Testing — Post AI-SDK-v7-Migration Validation (My Checklist)

> Companion to [`ai-sdk-7-migration-tasks.md`](./ai-sdk-7-migration-tasks.md) (the
> full migration record) and [`human-testing-after-skd-migration.md`](./human-testing-after-skd-migration.md)
> (the items I genuinely cannot test). This document is **my** actionable test
> plan for everything migration-related that I can verify myself — general
> testing methodology lives in [`ai-testing-areas.md`](./ai-testing-areas.md).
>
> **Method preference**: DB queries, RPC/script-level calls, and DOM/console/
> network-based browser checks over screenshots. Screenshot only where a row
> is explicitly marked so — i.e. the assertion is inherently visual (an
> actual generated image's content, a layout regression) and no text signal
> can substitute.
>
> Each item: **Status**, **Method**, **Steps**, **Pass criteria**. Status
> starts `🔲 Pending` for everything not already closed out during migration;
> I'll flip to `✅ Pass` / `❌ Fail (fixed)` / `❌ Fail (flagged)` as I execute
> and update this file in place — this is a living document, not a one-shot
> report.

---

## A. Already verified during migration (no action needed — listed for completeness)

Full evidence for each lives in `ai-sdk-7-migration-tasks.md` (§5.1-§5.7); not
re-litigated here:

- Automated gates: typecheck/lint/test all clean, zero leftover deprecated-alias usage.
- Provider connectivity: OpenCode, Z.AI, Claude Subscription (both Haiku direct-HTTP and Sonnet/Opus CLI/SDK paths).
- Core orchestration flow: plan→approve→execute→done, sequential dispatch, review rejection loop, parallel read-only agents, kanban drag-drop (manual relocation), plan-rejection re-planning loop, agent failure handling.
- Multimodal: `take_screenshot` round trip on an Anthropic-native model, CLI-path MCP image content-block bridge.
- Quick Chat: streaming, no-crash on a missing workspace folder.
- Cross-cutting: Stop-button abort on the normal `streamText` path (incl. mid-tool-call), prompt caching (found broken on Claude Subscription's Haiku path, root-caused, **fixed**), token usage/cost persistence, MCP client tool wrapping (chrome-devtools).
- Two real bugs found and fixed this migration: `applyAnthropicCaching()` missing `"claude-subscription"`; the CLI-bridge branch rejecting instead of resolving on error (root cause of both the blank "Agent failed: " message and the stale busy-state UI bug).

---

## B. Outstanding — to execute

### B.1 Provider connectivity (credential-gated — see human doc for the credential-entry step)

- **Status**: 🔲 Pending (blocked until human adds credentials)
- **Method**: DB query (`sqlite3` against `ai_providers`) to confirm a row exists + `isDefault`/`apiKey` populated, then a direct RPC call to `testProviderWithCredentials`/`testConnection` (no UI needed) or, if faster, the same live-script pattern as `scripts/verify-ai-sdk-v7-live.ts` talking to the provider adapter directly.
- **Steps** (once a human has added a given provider's key, per the human doc):
  1. `SELECT id, name, providerType, defaultModel, isDefault FROM ai_providers WHERE providerType = '<type>';` — confirm the row exists.
  2. Call the provider's `testConnection()` via a throwaway script importing the relevant adapter (`src/bun/providers/<type>.ts`), OR call the `testProviderWithCredentials` RPC directly.
  3. For one plain-OpenAI and one OpenRouter model specifically: also run a 3-step tool-call turn (mirroring `verify-ai-sdk-v7-live.ts`) and confirm `result.usage.outputTokens` equals the sum of each step's own `outputTokens` (closes the last untested leg of §5.2's usage-semantics check).
- **Pass criteria**: connection test returns `success: true`; the 3-step usage-sum check matches exactly (no drift from v6 final-step-only semantics).
- **Providers**: Anthropic (direct key), OpenAI, Google Gemini, DeepSeek, Groq, xAI Grok, OpenRouter, Ollama.

### B.2 Reasoning/thinking extraction on Anthropic (direct key), OpenRouter, plain OpenAI

- **Status**: 🔲 Pending (blocked on B.1's credentials)
- **Method**: DB query — no browser needed.
- **Steps**:
  1. Set the provider as default (or dispatch a sub-agent scoped to it), set the reasoning-effort selector to "High" via one RPC call or one UI interaction (whichever is cheaper — a script-level provider call bypassing the UI is preferable here).
  2. Ask a reasoning-shaped question (e.g. a multi-step word problem).
  3. `SELECT metadata FROM messages WHERE id = '<messageId>';` and check for a populated `reasoning` key in the JSON.
- **Pass criteria**: `messages.metadata.reasoning` is non-empty for at least one turn per provider, OR — if empty — confirm via `ai_telemetry_events.reasoning_tokens` whether the provider/model genuinely produced zero reasoning tokens (a capability limit, not a bug) vs. tokens were produced but extraction silently dropped them (a real bug, would need a fix).

### B.3 Multimodal round trips — testable now, no new credentials needed

All of these can run today against OpenCode/Z.AI/zenmux/Claude Subscription — no blocker.

- **B.3.1 `take_screenshot` on an OpenAI-compatible model**
  - **Method**: dispatch a sub-agent via RPC/script (or a minimal browser interaction) with a task requiring `take_screenshot` of a known local page; verify via the agent's returned text description (does it accurately describe the page) — no screenshot of AgentDesk's own UI required.
  - **Pass criteria**: description matches the actual page content; `messageParts` row for the tool call has `toolState: "success"`.

- **B.3.2 `read_image` round trip**
  - **Method**: same pattern, using a known test image (e.g. the tiny PNG already embedded in `verify-ai-sdk-v7-live.ts`) — confirm the model's response demonstrates it actually received the image content (not a generic non-answer).
  - **Pass criteria**: response content is specific to the actual image (color/shape/content), not a generic deflection.

- **B.3.3 `read_audio` round trip (WAV/MP3)**
  - **Method**: same pattern with a short known audio clip; confirm the model's transcription/description matches.
  - **Pass criteria**: response reflects the actual audio content.

- **B.3.4 `generate_image` round trips** (main chat, PM direct tool call, Dashboard PM/agent widgets, failure path)
  - **Method**: dispatch via RPC/script; confirm via DB (`messageParts` row of type matching the image content, `toolState`) and, for "does it actually render," `evaluate_script`/`javascript_tool` checking the resulting `<img>` element's `naturalWidth > 0 && complete === true` in the DOM — **no screenshot needed** even for this visual-adjacent check.
  - **Failure path**: force a failure (invalid/unentitled provider+model combo) and confirm the tool result surfaces as a readable error in the transcript, not a crash or unhandled rejection (check console for uncaught errors).
  - **Pass criteria**: success case — image element loads (`naturalWidth > 0`); failure case — readable error text persists, no crash, no uncaught console exception.

- **B.3.5 Chat file-upload attachment (image)** — previously blocked by the browser-automation tool layer, not the app
  - **Method — revised**: bypass the UI file-picker entirely. Call the backend RPC/handler that the composer's attach button ultimately invokes, directly, with a base64 payload — same technique as B.1-B.3, avoids the automation tool limitation that blocked this last time entirely.
  - **Pass criteria**: message persists with the attachment, and the model's subsequent response demonstrates it received the image content.

### B.4 Independent chat/agent surfaces — testable now, no real user data involved

- **Status**: 🔲 Pending
- **Method**: claude-in-chrome browser automation against `localhost:5173` (`.\run.ps1` first, per project convention) — `read_page`/`get_page_text`/console/network only, no screenshots needed for a functional smoke check (send a message, confirm a response streams in, confirm no console errors).
- **Surfaces**: Dashboard chat (project-less), Dashboard-agent chat, Collections chat widget, Skills-search chat, Playground, Scheduler cron-triggered agent task.
- **Steps per surface**:
  1. Navigate to the surface.
  2. Send a simple, side-effect-free message/task.
  3. `read_console_messages` — confirm no uncaught errors.
  4. `read_network_requests` — confirm the expected RPC fired and returned 200/success.
  5. `get_page_text`/`read_page` — confirm a real response rendered (not stuck loading, not an error state).
- **Pass criteria**: response streams and completes; no console errors; no stuck busy-state after completion (double-check via the same `getRunningAgents`/`getPmStatus`-style RPC checks used in `syncRunningAgents`, to catch a repeat of the stale-busy-state bug class on these surfaces too).

### B.5 Stop-button abort — Claude Subscription CLI path specifically (non-Haiku)

- **Status**: 🔲 Pending (the only Stop-button test not yet run on the actual CLI/SDK bridge — the earlier pass accidentally ran on zenmux)
- **Method**: browser automation, DOM/console-based, no screenshot needed.
- **Steps**:
  1. Confirm default provider/model is Claude Subscription + a non-Haiku model (`claude-sonnet-5`/`claude-opus-*`) — via DB query on `ai_providers`/`settings`, not visually.
  2. Ask the PM to write a long essay (something that streams for a while).
  3. Click Stop mid-stream.
  4. `find`/`read_page` — confirm the Stop icon reverts to the send arrow and "Responding..." clears (text/attribute state, not a screenshot).
  5. Confirm via RPC (`getRunningAgents`/`getPmStatus`) that the backend agrees nothing is running.
  6. Send a new message immediately — confirm the composer accepts it without needing a page reload.
- **Pass criteria**: same as the already-verified zenmux case — immediate halt, partial text preserved uncorrupted, no stuck busy state, composer accepts new input right away.

### B.6 Transient-error retry loop classification (abort vs. transient vs. permanent)

- **Status**: 🔲 Pending
- **Method**: standalone script, no browser/UI at all — same style as `isTransientError()`'s existing 8/8 synthetic-case unit coverage (already passing per Phase 2.4), extended to also assert the **classification boundary** end-to-end: feed `runInlineAgent`'s catch block (or an extracted equivalent) a synthetic abort signal, a synthetic transient error (429/503/ECONNRESET), and a synthetic permanent error (e.g. 401), and confirm each resolves to the correct `status` (`"cancelled"` / retried-then-`"failed"` / immediate `"failed"`) without an actual live model call.
- **Pass criteria**: all three classes route to the correct status and retry behavior; no misclassification (e.g. a permanent error must never silently retry `MAX_RETRIES` times before failing — that would look like a hang to the user).

### B.7 Context compaction/summarization triggered past threshold

- **Status**: 🔲 Pending
- **Method**: script-driven — construct or reuse a conversation whose accumulated token count is already near/over the compaction threshold (60/70/85/90% tiers per `CLAUDE.md`), send one more turn, and check for the `conversationCompacted`/`compactionStarted` broadcast plus a reduced `liveContextTokens` afterward, via DB/telemetry, not a live long back-and-forth in the UI.
- **Pass criteria**: compaction fires at the documented threshold; conversation remains usable afterward (next turn succeeds); no data loss beyond the intended summarization.

### B.8 Zod schema validation spot check — `verify_implementation` in `kanban.ts`

- **Status**: 🔲 Pending
- **Method**: direct script/RPC call to the tool's `execute()` (or the exported validator) with a deliberately malformed nested payload (wrong type on a nested field, missing required array element, extra unexpected key) — no browser needed.
- **Pass criteria**: malformed input is rejected with a clear validation error (not a silent pass-through or an unrelated crash); valid complex nested input is accepted correctly.

---

## Execution log

Update this section as items are run — one line per completed item, newest on top.

- *(none yet — this document was just created)*
