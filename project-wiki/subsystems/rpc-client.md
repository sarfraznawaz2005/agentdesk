---
title: RPC Client (Frontend)
type: subsystem
status: verified
verified_at: 2026-07-04
sources:
  - src/mainview/lib/rpc.ts
  - src/shared/rpc/index.ts
  - src/shared/rpc/webview.ts
  - src/mainview/stores/chat-event-handlers.ts
tags: [frontend, rpc]
---

# RPC Client (Frontend)

**The renderer's single entry point into the Bun main process.**
`src/mainview/lib/rpc.ts` is the one module that constructs the webview-side
Electrobun RPC instance, declares the webview's own handlers, and exports a
hand-written typed `rpc` object that the rest of the React app uses for *every*
backend call. No component imports `electroviewRpc` directly — they all go
through `rpc.*`. This page covers the **frontend half** of the boundary; the
end-to-end contract, registration, and Bun side live in [[rpc-layer]].

> **Transport branch (web app).** `rpc.ts` now selects its transport at one seam
> via `IS_REMOTE` (`src/mainview/lib/remote-transport.ts`): the Electrobun bridge
> when running in the native webview (byte-identical to before), or a **WS-RPC
> client over the blind relay** when running in a plain browser. The `rpc.*`
> wrappers and the broadcast → `agentdesk:*` DOM-event re-emit are unchanged in
> both modes. See [[remote-access]].

## The three things this module does

`src/mainview/lib/rpc.ts` has exactly three jobs, in this order:

1. **Define the webview RPC schema** (`Electroview.defineRPC<AgentDeskRPC>`,
   `rpc.ts:30`). Because both sides share the `AgentDeskRPC` type
   (`src/shared/rpc/index.ts:72-78`), `defineRPC` here registers what the
   *webview* answers — the Bun→UI direction — while exposing `rpc.request.*` /
   `rpc.send.*` for calling Bun. The webview's `handlers` have two sub-maps:
   - `requests` — incoming *requests* from Bun. There is exactly one:
     `getViewState` (`rpc.ts:40-45`), which reports the current SPA route from
     `window.location.hash` so Bun can query where the UI is.
   - `messages` — incoming fire-and-forget *broadcasts* from Bun
     (`rpc.ts:47-343`). Every entry matches a key in `WebviewSchema.messages`
     (`src/shared/rpc/webview.ts:10`).

2. **Construct the live transport** — `new Electroview({ rpc: electrobunRpc })`
   (`rpc.ts:359`, native only — `null` in web mode). This is what wires the
   renderer to the Bun process; the exported `electroview` is rarely used
   elsewhere, the `rpc` wrapper is.

3. **Export the typed `rpc` wrapper** (`rpc.ts:372-1687`) — ~250 thin
   one-liners grouped by domain (Settings, Providers, Projects, Conversations,
   Kanban, Git, Freelance, Playground, …). Each maps positional/ergonomic args
   to the contract's params object and forwards to `electroviewRpc.request.*`
   (or `electroviewRpc.send.*` for fire-and-forget like `log`, `rpc.ts:1223`).

## Why every broadcast becomes a DOM CustomEvent

The single most important pattern in this file: **each `messages` handler does
nothing but re-emit the payload as a `window` `CustomEvent`** under an
`agentdesk:*` name. Example: `kanbanTaskUpdated` → `agentdesk:kanban-task-updated`
(`rpc.ts:112-114`); `streamToken` → `agentdesk:stream-token` (`rpc.ts:82-84`).

This indirection exists to **decouple the RPC transport from React state**.
`rpc.ts` has no knowledge of Zustand or any component; it just throws a DOM
event. Consumers subscribe with `window.addEventListener("agentdesk:…")` — e.g.
`chat-event-handlers.ts:735-757` wires the streaming/plan/conversation events
into the chat store. New broadcast consumers can be added anywhere in the UI
without touching this file, and a broadcast with no listener is simply ignored.
A recent example: `agentSessionComplete` → `agentdesk:agent-session-complete`
(`rpc.ts:115-117`) fires once a project's PM and all its agents go idle
(mirrors the existing "Session Complete" desktop notification's trigger, see
[[notifications]]); its only consumer is the `AgentSessionToast` singleton in
the app shell (`src/mainview/components/layout/agent-session-toast.tsx:41`),
which gates on the chat store's `activeProjectId` so only *other* projects'
completions toast. An earlier version of this toast fired per kanban task
reaching "done" (`taskCompleted`) — retired in favor of the session-level
signal, since a task can pass through several review rounds before it's truly
done.
The flip side is the gotcha below: a broadcast needs **both** a `webview.ts`
schema entry and a re-emit handler here, or it silently does nothing.

## Why `maxRequestTime: Infinity`

Electrobun's default request timeout is ~1 second. Agent operations (PM
streaming, sub-agent runs, deploys) take minutes, so the webview RPC disables
the timeout entirely (`rpc.ts:31-32`). The Bun side does the same. Do not
reintroduce a finite timeout here — long-running requests would spuriously
reject.

## Why a hand-written wrapper instead of calling `electroviewRpc.request.*`

The typed contract already gives a callable `electroviewRpc.request.<name>`
surface, so the `rpc` wrapper is **pure ergonomics**: it lets callers pass
positional args (`rpc.getMessages(convId, limit, before)`) instead of params
objects, gives each method a JSDoc one-liner, and is the single import surface
the whole renderer agreed on. The cost: it is **hand-maintained and can drift** —
a new contract method has no wrapper until someone adds one (see Open questions).
Newer freelance/auto-earn methods use bracket-key access for dotted contract
names (e.g. `electroviewRpc.request["freelance.inbox.ingest"]`, `rpc.ts:1594`).

## Key files

| File | Role |
|---|---|
| `src/mainview/lib/rpc.ts` | `Electroview.defineRPC` + the `Electroview` instance + the typed `rpc` wrapper; webview `getViewState` handler; all broadcast→DOM-event re-emitters |
| `src/shared/rpc/index.ts` | Shared `AgentDeskRPC` type — the contract both sides instantiate |
| `src/shared/rpc/webview.ts` | `WebviewSchema` — the catalog of Bun→UI broadcasts this client must re-emit |
| `src/mainview/stores/chat-event-handlers.ts` | Representative consumer: listens for `agentdesk:*` DOM events and updates the chat store (`:735-757`) |

## Gotchas / Constraints

- **Broadcast needs two edits, not one.** To deliver a Bun→UI event you must add
  it to `WebviewSchema.messages` (`webview.ts`) AND add a re-emit handler in the
  `messages` map here (`rpc.ts:47-343`). Missing the handler = the payload
  arrives and is dropped silently.
- **Broadcasts are lossy.** They are fire-and-forget; the Bun side no-ops when
  the window is gone. Treat `agentdesk:*` events as cache-invalidation hints, not
  state-of-record — components should refetch via `rpc.*` on mount, not rely on
  having received every event (see the completed-stream guard in
  `chat-event-handlers.ts:16-26` that defensively drops late `stream-token`s).
- **The wrapper can lag the contract.** It is not generated; a contract method
  with no `rpc.*` wrapper is invisible to most of the app until added.
- **Never bypass it with direct DB access** — `CLAUDE.md` makes RPC the hard
  frontend↔backend boundary; there is no other IPC channel.
- **`getViewState` is the only inbound request.** Everything else Bun pushes is a
  one-way `message`; don't expect a webview handler to return a value except for
  `getViewState`.

## Related

- [[rpc-layer]]
- [[message-streaming-broadcasts]]
- [[agent-engine]]

## Open questions

- Is the `rpc` wrapper fully in sync with `BunRequests`? A lint comparing the
  contract's request keys against the wrapper's methods would surface any
  contract method missing an ergonomic wrapper (noted on [[rpc-layer]] too).
