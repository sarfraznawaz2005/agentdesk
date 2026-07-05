---
title: broadcastToWebview Silently No-ops on a Method Name Mismatch
type: gotcha
status: verified
verified_at: 2026-07-05
sources:
  - src/bun/engine-manager.ts
  - src/bun/agents/tools/pm-tools.ts
  - src/shared/rpc/webview.ts
tags: [rpc, broadcasts]
---

# broadcastToWebview Silently No-ops on a Method Name Mismatch

**`broadcastToWebview(method, payload)` resolves `method` as a plain string
key** against Electrobun's generated `webview.rpc.send` object
(`mainWindowRef?.webview?.rpc?.send?.[method]?.(payload)`,
`src/bun/engine-manager.ts:272`). That object is keyed by exactly the names
declared in `WebviewSchema.messages` (`src/shared/rpc/webview.ts`). If the
string passed to `broadcastToWebview` doesn't match one of those keys — a
typo, a rename on one side but not the other, or simply remembering the wrong
name — the optional-chain lookup evaluates to `undefined?.(payload)`, which is
valid JavaScript that does **nothing** and throws **nothing**. There is no
error, no warning, no failed network call to notice. The broadcast just never
happened.

## Why this is sharper than the usual "wire it up" mistake

The [[rpc-layer]] gotcha "adding a broadcast requires a `webview.ts` entry AND
a re-emit handler" covers the case where a broadcast is **new** and one of the
two registration points was skipped. This is a different, easier-to-miss
failure: **both sides can already be fully and correctly wired**, and the bug
is still just a bare string literal at the call site not matching. Nothing
in the type system catches it, because `broadcastToWebview`'s `method`
parameter is not typed against `WebviewSchema.messages` keys — it's just
`string`. A refactor that renames a schema entry, or a second call site added
by copy-paste from a differently-named sibling, can reintroduce this at any
time.

## The real incident

`request_plan_approval` (`src/bun/agents/tools/pm-tools.ts`) calls
`broadcastToWebview("presentPlan", …)` to show the plan-approval card. The
schema entry is named `presentPlan` (`src/shared/rpc/webview.ts`) — but for an
unknown period, **both** call sites in `pm-tools.ts` (the PM-driven path and
the code-enforced task-planner-completion path) called
`broadcastToWebview("planPresented", …)` instead — a plausible-sounding but
wrong name. Every plan-approval card broadcast from those two sites silently
failed to reach the frontend; the in-app card never appeared for any session
that went through that path in production, without anything in the logs
pointing at it. Both sites are fixed to `"presentPlan"`
(`pm-tools.ts:753,1709`, with an inline comment at the second site pointing at
this exact failure mode so it isn't reintroduced). See
[[message-streaming-broadcasts]] and [[plan-approve-execute]] for how the
plan-approval flow uses this broadcast.

## How to avoid it

- **Grep the schema before typing the string.** Before adding or touching any
  `broadcastToWebview("SomeName", …)` call, confirm `SomeName` is a literal
  key in `WebviewSchema.messages` (`src/shared/rpc/webview.ts`) — don't rely on
  memory or on what "sounds right."
- **When renaming a broadcast**, grep every `broadcastToWebview("oldName"` call
  site across the codebase — there is no compiler error to catch a stale one.
- **A missing broadcast in the UI with no error anywhere** (card doesn't show,
  toast doesn't fire, store never updates) — check this failure mode first,
  before assuming the frontend listener or store logic is broken.

## Related
- [[rpc-layer]] — the two-registration-point broadcast wiring this complements
- [[message-streaming-broadcasts]] — the broadcast flow where this bug lived
- [[plan-approve-execute]] — the `presentPlan` broadcast this bug affected
- [[backend-core]] — `broadcastToWebview`'s implementation and its other silent-failure mode (window closed)

## Open questions
- None — the specific incident is fixed and documented at both call sites.
