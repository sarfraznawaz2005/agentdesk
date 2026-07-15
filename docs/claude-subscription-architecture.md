# Claude Subscription Provider — Architecture & Alternatives Investigated

> Status: **current architecture kept as-is.** This document exists so that if
> a future session wants to revisit "can we eliminate the Claude-Subscription-
> specific branching," the prior research doesn't have to be redone from
> scratch. Nothing here is a pending TODO — it's a record of what was tried,
> what worked, and why we didn't switch.

## Context

AgentDesk's "Claude Subscription" AI provider (`providerType: "claude-subscription"`)
lets a user drive Claude models with their existing Claude Code OAuth login
(`~/.claude/.credentials.json`), no separate API key. It has **two
fundamentally different execution paths**:

- **Haiku** — works over a normal direct-HTTP OAuth adapter
  (`ClaudeSubscriptionAdapter` in `src/bun/providers/claude-subscription.ts`),
  behaving like any other AI-SDK provider: full `ModelMessage[]`, native
  streaming, native tool/image content.
- **Everything else (Sonnet/Opus)** — 429s on that same direct-HTTP path.
  Confirmed empirically (replicating the real `claude` CLI's exact headers,
  billing attribution, and bootstrap handshake still 429s — a server-side
  gate upstream of quota, not a missing header). These models instead route
  through the official `@anthropic-ai/claude-agent-sdk`, which spawns the
  user's installed `claude` CLI binary as a subprocess and drives it
  programmatically (`runClaudeCliTask` in
  `src/bun/providers/claude-subscription-cli-runner.ts`).

Because path two takes a single flattened text prompt (not a native message
array) and has its own tool-wrapping layer, every AgentDesk surface that talks
to an AI provider directly has to branch: `isClaudeSubscriptionViaCli` (full
CLI/SDK routing, for conversational/tool-using surfaces) or
`internalCallModelId`/`isHaikuModel` (Haiku-swap, for bounded one-shot
completions). This is documented as a permanent, checkable rule in the
project's `CLAUDE.md` Critical Rules section — not something this doc
supersedes.

**The question this doc answers:** can we eliminate that branching entirely by
making Claude Subscription "just another provider" from every caller's
perspective? Several mechanisms were researched and empirically prototyped.

## Mechanisms investigated

### 1. Community tools (rejected without needing a prototype)

Six external projects were reviewed (`claude-code-api`, `ClaudeRunner`,
`claude-code-router`, `ccproxy`, `claude-code-proxy`, plus a Reddit post that
couldn't be fetched). None offered anything better than what AgentDesk already
has:

- **`claude-code-api`** — bare `claude -p` subprocess wrapper. No tool
  calling, no streaming, custom `{answer: string}` response shape.
- **`ClaudeRunner`** — hand-rolled `stream-json` parser with tools/streaming,
  but its own docs explicitly warn about the *same* large-tool-count
  context-bloat failure AgentDesk already hit and fixed by switching to the
  official Agent SDK's `alwaysLoad` mechanism.
- **`claude-code-router`**, **`claude-code-proxy`** — wrong direction: they
  let Claude Code use *other* providers as its backend, not the reverse.
- **`ccproxy`** — a network traffic interceptor/debugger, unrelated to this
  problem.

None were prototyped further; the docs alone were disqualifying.

### 2. Local HTTP proxy, OpenAI-compatible — **prototyped, works**

A local `Bun.serve()` proxy internally drives the same Agent SDK
(`query()`), exposed via `@ai-sdk/openai-compatible`'s
`createOpenAICompatible({baseURL})` — the same mechanism AgentDesk already
uses for Ollama/OpenRouter/custom providers.

- **Plain multi-turn streaming text** — works cleanly.
- **Full tool-calling round trip** — works, via this design: the proxy
  registers SDK tools whose `execute()` returns a Promise that does **not**
  resolve immediately. When Claude Code requests a tool call, the proxy
  detects the `tool_use` content block, replies to the HTTP caller with an
  OpenAI-shaped `tool_calls` response, and the *calling* side's own
  `generateText`/`streamText` tool-execution loop runs the tool for real and
  POSTs a follow-up request with the result. The proxy correlates that
  follow-up back to the **same still-running** `query()` call via an
  in-memory `Map<conversationId, {resolveTool}>` — critically, the
  underlying subprocess is **never killed**.
  - An earlier attempt that killed the subprocess and used `resume:
    sessionId` to reconnect **did not work** — the resumed session treated
    the tool result as a stray, unrelated "empty message." Aborting mid-tool-
    call leaves the on-disk session transcript in a broken state that
    `resume` can't cleanly recover.
  - A real gotcha hit along the way: the SDK reports tool names back
    prefixed as `mcp__<servername>__<toolname>` — this must be stripped
    before relaying to the HTTP caller, or the caller's tool-execution loop
    can't match it against its own registered tool name.

### 3. Local HTTP proxy, Anthropic-compatible — **prototyped, works, better fit**

Same design, but speaking Anthropic's real `/v1/messages` wire protocol
(`createAnthropic({baseURL})`) instead of OpenAI's shape.

- Plain streaming, non-streaming tool calls, and **streaming tool calls**
  (the hardest combination) all passed on first attempt.
- **Better architectural fit than the OpenAI-compatible variant**:
  `ClaudeSubscriptionAdapter`'s Haiku path already builds its model via
  `createAnthropic(...)`. Routing the non-Haiku path through an
  Anthropic-shaped local proxy would mean **one adapter class** for the whole
  provider (just swapping `baseURL`/`authToken`), instead of mixing two
  different AI-SDK provider packages.
- Anthropic's SSE protocol is more complex than OpenAI's (named events —
  `message_start`/`content_block_start`/`content_block_delta`/
  `content_block_stop`/`message_delta`/`message_stop` — vs. flat delta
  chunks), but it maps cleanly onto the SDK's own `SDKAssistantMessage`
  content blocks. More code, no fundamental mismatch.
- Real per-token streaming (not fake-chunked buffered text) requires
  `query()`'s `includePartialMessages: true` option, which emits the SDK's
  raw `SDKPartialAssistantMessage`/`BetaRawMessageStreamEvent` events —
  confirmed working in the streaming+tools prototype (see below).

### 4. Persistent/warm session across separate turns — **prototyped, works**

Tests whether the underlying `claude` subprocess can stay resident across
multiple, separately-arriving conversation turns (not just within one
tool-call round trip) — the mechanism that would let e.g. the PM's own chat
loop avoid respawning a subprocess on every message.

- Built by holding `query()`'s returned `Query` object alive and pushing new
  messages into a controllable `AsyncIterable` fed to `prompt`, rather than
  calling `query()` again.
- **Context genuinely retained** across an 8-second gap between turns with no
  resend of history and no `resume` option — confirmed by two independent
  runs.
- **Real latency win**: turn 2 was consistently ~2.5–3x faster than turn 1
  (`ttft_ms` dropped from ~2.7–2.9s to ~2.0–2.1s; `time_to_request_ms` from
  ~240–350ms to ~140ms), confirming the subprocess stayed warm instead of
  respawning.
- `.close()` cleanly terminated the underlying subprocess with no orphans,
  verified via the OS process list across two trials.
- **Gotcha:** `Query extends AsyncGenerator`, and a `for await...of` loop
  calls `.return()` on early exit (e.g. `break` after seeing a result) —
  which tears down the generator and kills the "stay warm" property. Must
  drive it manually via `await q.next()` in a `while(true)` loop instead.

### 5. Streaming + tool-calling combined — **prototyped, works, with one real gap found**

Extends mechanism #2/#3 to real SSE streaming (`stream: true`) combined with
the tool-calling bridge, since production AgentDesk needs live token-by-token
UI updates during tool-using conversations, not just non-streaming JSON.

- **Works end to end**: incremental streamed text before a tool call, the
  tool executing for real client-side, and the follow-up turn *also*
  streaming its final text token-by-token.
- Required SSE chunk shape for `@ai-sdk/openai-compatible`'s tool-call parser
  (from `chunkBaseSchema` in `node_modules/@ai-sdk/openai-compatible`): first
  chunk needs `index` + `id` + `function.name`; subsequent chunks need only
  `index` + partial `function.arguments` (the parser auto-detects completion
  via `isParsableJson`); a closing chunk with `finish_reason: "tool_calls"`.
- **Real gap found, not solved:** aborting the client's HTTP request does
  **not** cancel the underlying `query()`. The prototype's tool `execute()`
  kept blocking forever, and the Claude Code subprocess kept running
  indefinitely — the test server never wired the incoming request's
  `AbortSignal` into the SDK's own `Options.abortController` /
  `Query.interrupt()`. This is architecturally fixable (the SDK does support
  real cancellation), but it was **not built**, and it reproduces — in a
  harder, more stateful setting — the exact bug class (Stop button
  correctness) that took three compounding fixes to get right in the current
  architecture earlier this same investigation.

## Decision: keep the current architecture

We are **not** switching to the proxy design. Reasoning (reliability-first,
not code-size):

1. **Track record gap.** The current architecture has been built *and*
   validated against nearly every real AgentDesk feature: PM chat, every
   sub-agent type, Playground, Issue Fixer, code review, dashboard chat,
   dashboard-agent chat, collections chat, freelance chat, skills-search
   chat, the scheduler, Council — including real bugs found and fixed along
   the way (the Stop button's three-layer cancellation bug, image/MCP
   content-block loss, tool-count reliability at ~74 tools). The proxy design
   has only been validated on toy scenarios (one Q&A, one tool call, one
   persistent-session pair) — none of AgentDesk's actual features have been
   ported to or tested against it.
2. **The proxy introduces a genuinely new, larger reliability surface**:
   stateful session management (a live subprocess correlated across
   stateless HTTP calls via an in-memory `Map`), instead of the current
   model's self-contained, stateless "one async function call per LLM
   request." This isn't hypothetical — the streaming+tools prototype already
   reintroduced a variant of the exact Stop-button bug class we'd already
   spent real effort fixing once, in a harder setting (leaked subprocess, not
   just a mis-reported status).
3. **Concurrency is where AgentDesk actually lives, and it's the least-tested
   part of the proxy.** `run_agents_parallel` dispatches up to 5 concurrent
   sub-agents; dashboard chat, PM chat, collections chat, and scheduled tasks
   can all be active simultaneously. The current architecture has one known,
   accepted, rare risk here (concurrent OAuth refresh races — see below). The
   proxy's `Map`-based session correlation under real concurrent load was
   never stress-tested.
4. The "no special-casing" benefit is real but is a maintainability property,
   not a reliability one — and it's now a documented, checkable pattern
   (`CLAUDE.md` Critical Rules), not a live risk.

## If a future session wants to revisit this

The proxy mechanism (specifically: **#3, Anthropic-compatible**, combined
with **#4's persistent-session technique** and **#5's streaming+tools
bridge**) is the one worth resuming, not #2. Before it could replace the
current architecture, it would need real engineering (not prototype-level)
on:

- **Abort/cancellation wiring** — forward the HTTP request's `AbortSignal`
  into `query()`'s `Options.abortController`; on abort, reject any pending
  tool Promise and remove the conversation from the session map. Confirmed
  gap, not yet built.
- **Image/multimodal content bridging** — not tested at all through the
  proxy path. Would need logic mirroring the fix already built into
  `claude-subscription-cli-runner.ts`'s tool wrapper (real `image` content
  blocks instead of base64-as-text).
- **Concurrency stress-testing** — multiple simultaneous live conversations
  (matching `run_agents_parallel` and multiple concurrent chat surfaces)
  under real load; the in-memory `Map` design was never tested under
  concurrent access.
- **Session lifecycle across app restarts/crashes** — cleanup on
  `before-quit` (`src/bun/index.ts:421`), and recovery if the proxy server
  itself needs to restart mid-conversation.
- **Error/timeout/rate-limit mapping** — the prototype only covers the happy
  path; production needs SDK-side errors mapped back into proper HTTP error
  semantics.
- **The known, accepted OAuth-refresh race** (documented separately): under
  either architecture, concurrent non-Haiku dispatches each spawn their own
  `claude` subprocess, which manages its own OAuth refresh internally,
  outside AgentDesk's control. This is unrelated to the proxy vs. current
  choice — it exists either way — but is worth re-confirming if the proxy's
  concurrency model changes how often refreshes actually collide.

None of the above were show-stoppers in the prototypes — they were simply not
in scope for a feasibility investigation. If revisited, budget for a real
implementation-and-hardening pass, not a quick swap.

## 2026-07-15 addendum: `HarnessAgent` (AI SDK v7) evaluated — not yet available

AI SDK v7 (§6.8 of `ai-sdk-7-migration.md`, Phase 3.7) documents a `HarnessAgent`
abstraction specifically for wrapping "established agent harnesses" — Claude
Code, Codex, Deep Agents, OpenCode, Pi — behind a normal AI SDK `Agent`
interface, which reads on paper like exactly the unification mechanism this
doc's original investigation was looking for. Evaluated for real rather than
taken at face value, following the same "docs alone can be disqualifying"
precedent as mechanism #1 above:

- **`HarnessAgent` itself is not exported by any published version of the
  `ai` package** — confirmed by grepping the installed stable release
  (`ai@7.0.28`, current for this migration) and separately installing and
  grepping the `canary` dist-tag (`ai@7.0.0-canary.176`) in an isolated
  scratch project: zero matches in either. The class the docs describe using
  (`node_modules/ai/docs/03-ai-sdk-harnesses/*.mdx`, bundled with the package)
  does not exist in installable code yet, in stable or canary. Not a
  version-pinning issue on AgentDesk's side — there is currently no version to
  pin to.
- **The dependency packages are real and do exist** — `@ai-sdk/harness`
  (types/schemas only, no `HarnessAgent` class) and
  `@ai-sdk/harness-claude-code@1.0.34` (a genuine, actively-published adapter,
  confirmed via `npm view`) are both installable. Its own capability table
  lists the Claude Code adapter's "Runtime location" as **"Sandbox bridge"**
  — every adapter is, except Pi ("Host process"). Confirmed by reading its
  `.d.ts`: the adapter opens a WebSocket bridge to a port inside a
  `HarnessV1SandboxProvider`-supplied sandbox (a real, versioned
  `harness-sandbox-v1` protocol — port exposure, `getPortUrl`, bootstrap
  recipes, network policy, snapshot-based sandbox identity — modeled directly
  on cloud sandbox products; the adapter's own default working-directory doc
  comment names Vercel Sandbox's `/vercel/sandbox` explicitly).
- **This is a fundamentally worse fit than the mechanisms already
  investigated above, even setting the missing `HarnessAgent` class aside.**
  AgentDesk's requirement is the opposite of what this adapter is built for —
  direct, unsandboxed access to the user's real local project directory (the
  entire reason `claude-subscription-cli-runner.ts` spawns the CLI directly
  today). Making the Claude Code harness adapter work against a bare local
  host would mean building a custom `HarnessV1SandboxProvider` that
  "wraps" the local machine as a pseudo-sandbox — implementing a full
  WebSocket bridge server matching a bespoke, versioned protocol. That is the
  same *class* of engineering as mechanism #2/#3's local HTTP proxy (a custom
  bridge server standing between AgentDesk and the real `claude` subprocess),
  not less — but for a narrower, more complex, still explicitly
  `<Note type="warning">experimental, expect breaking changes between
  releases</Note>` upstream contract, orchestrated by a class that doesn't
  exist yet.

**Conclusion: not yet, revisit later.** No code changes made — this was a
docs-and-package-evidence evaluation, not a prototype build, since the
disqualifying facts (missing top-level class; sandbox-bridge requirement
fundamentally mismatched with AgentDesk's local-workspace model) were
concrete and checkable without needing to stand up a full bridge server
first. Revisit if/when `HarnessAgent` actually ships in a stable release —
at that point, re-check whether the harness framework has grown a
lower-friction "host process" sandbox mode (the Pi adapter already proves the
framework *can* support running outside a network sandbox; whether that mode
becomes available to the Claude Code adapter specifically is the open
question worth re-checking first, before investing in a custom sandbox
provider).
