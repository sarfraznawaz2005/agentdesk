# Cross-Project / Cross-Conversation Issues — Reference Log

> **Purpose**: AgentDesk lets a user run multiple projects concurrently (agents
> working in the background) while switching between projects/conversations in
> the UI. This single-window, single-process architecture means almost every
> piece of live state (Zustand stores, module-level backend caches, broadcast
> events) is a shared surface that MUST be explicitly scoped by project and/or
> conversation id — otherwise state from one project leaks into another, or a
> setting configured for one project silently governs a different one.
>
> This doc is a durable reference for every bug of this shape found and fixed
> across two related work sessions (2026-07-04 → 2026-07-05), so future
> agents recognize the pattern instead of rediscovering it from scratch.
> See also [[frontend-stores]], [[backend-core]], [[message-streaming-broadcasts]],
> and the `broadcast-method-name-mismatch` gotcha in the project wiki.

---

## The core architectural facts that explain almost every bug below

1. **One `ChatLayout` instance total.** Only the currently-viewed project has
   a mounted `ChatLayout`/`ChatInput`. Broadcasts and RPC responses are
   *global* (one Electrobun window, all projects) — anything that updates
   Zustand state in response to them must check whether the affected
   project/conversation is still the one being displayed, or a stale/
   background event will overwrite what the user is currently looking at.

2. **`ProjectPage` force-switches to the Chat tab on every project change**
   (`project.tsx`'s mount effect calls `setActiveTab("chat")` unconditionally).
   Since every *non*-chat tab is conditionally rendered with no `key`, this
   fully **unmounts** whatever non-chat tab was showing. React discards that
   component's local `useState`, and a stale async result calling a setter on
   an unmounted component is a silent no-op in React 18+. Net effect: races in
   non-chat-tab components (Git tab, Issues tab, Remote Sync tab, etc.) are
   latent, not reachable — **unless** the component writes to a *global*
   Zustand store (which outlives unmount), or the component lives inside the
   Chat tab itself (which never unmounts on a project switch if the user was
   already on Chat). This fact was used repeatedly to correctly separate real
   bugs from theoretical ones during the audit below.

3. **Backend "which project is this for?" must be threaded explicitly.**
   Several backend code paths (shell approval, `askUserQuestion`) used to
   infer "the current project" from a module-level cache of whichever
   project's `AgentEngine` was most recently touched by *any* activity across
   *all* projects — not the project the calling agent actually belongs to.
   This is now fixed everywhere by threading `projectId`/`conversationId`
   through explicitly (see §5).

---

## 1. Original cross-project state leak (sidebar/chat showing the wrong project)

**Symptom**: with multiple projects' agents running, switching projects could
show a different project's conversation list and messages.

**Fix**: `chat-store.ts` gained an explicit `activeProjectId` field + setter,
set by `ProjectPage` before `loadConversations` runs. `loadConversations` and
other cross-project-reachable handlers now check `activeProjectId` before
applying their result, instead of inferring "am I on this project?" from data
that a stale fetch could itself have already replaced.

## 2. Same-project conversation-switch streaming leak

**Symptom**: switching conversations *within* the same project could show a
mix of streaming state from the conversation just left.

**Fix**: `setActiveConversation` now resets `isStreaming`/`streamingMessageId`/
`streamingContent`/`pmThinkingText`/live-context fields on a genuine switch
(same id → only resets the context meter, not streaming state). Defensive
`activeConversationId` checks were added at 3 more points: `flushTokenBuffer`,
`onStreamComplete`, `onStreamError` (`chat-event-handlers.ts`) — previously
`onStreamComplete` used a weak proxy check (`convMessages.length === 0`)
instead of directly comparing the conversation id.

## 3. Kanban cross-project staleness

`kanban-store.ts`'s `loadTasks` and `createTask` gained the same
`activeProjectId !== projectId` staleness guard as `loadConversations`.

## 4. "Recent conversation + last prompt vanish" (real user bug report)

**Symptom** (from an actual production user, days after the original fix
shipped): recent messages/last prompt would vanish from a project's
conversation once its dashboard "activity complete" dot appeared — regardless
of whether an agent was currently working. Correlated with enabling
"New Conv. per Task."

**Root cause**: `loadMessages` had no staleness guard at all — a slower
`getMessages` fetch for a conversation switched away from could resolve
*after* the user had switched to a different conversation, and unconditionally
overwrote `messages` with the stale conversation's data.

**Fix**: `loadMessages` (`chat-store.ts`) now checks
`activeConversationId !== conversationId` after the await, before applying the
result, and the `finally` block only clears `messagesLoading` if this
conversation is still the active one (a stale call's `finally` must not hide
a *newer*, still-in-flight fetch's loading spinner for the conversation now
being viewed).

Shell-approval requests also gained an explicit `projectId` on
`ShellApprovalRequest`, filtered in `ChatLayout` — before this, a background
project's pending shell-approval card could render inline in whichever
project's chat happened to be open.

## 5. Four Chat-tab-embedded components with real (not latent) cross-project races

Because these live *inside* `ChatLayout` (fact #2 above — never unmounted on a
project switch if already on the Chat tab), their async fetch-then-`setState`
patterns were genuinely reachable, not latent:

- **`files-tab.tsx`**, **`docs-tab.tsx`** — `loadRoot`/`loadDocs` applied a
  `rpc.listWorkspaceFiles`/notes fetch unconditionally.
- **`model-selector.tsx`** — the settings-load effect applied provider/model/
  thinking/shell-approval/plan-mode/prefs unconditionally.
- **`context-indicator.tsx`** — the context-limit-loading effect applied its
  result unconditionally.

**Fix pattern** (used consistently): a `useRef` tracking the latest
`projectId`, updated via `useEffect` (not direct assignment during render —
that trips the `react-hooks/refs` lint rule), checked after the `await`
before calling the setter.

## 6. The 13-point exhaustive audit (chat header, MCP, below-input controls, sidebar, task modal, message search/queue, settings, plugin tabs, kanban badges)

A full audit of every UI surface on the project page. Confirmed safe: chat
header buttons (Clear/New/Export — all direct actions using live state),
conversation sidebar (pure props), message-search (synchronous, no async
gap), MCP indicator (genuinely global/app-wide, confirmed via its RPC params
being `Record<string, never>` — no per-project scoping needed), Git/Issues/
Remote-Sync sub-files (confirmed unreachable per fact #2, no global-store
writes), plugin tabs (currently inert placeholders, nothing to scope yet).

**Real bugs found and fixed:**

- **`task-detail-modal.tsx`** — mounted unconditionally at page level (never
  unmounts), so its GitHub-issue-lookup effect and "Create GitHub Issue"
  handler were reachable *without even a project switch* — just clicking
  between two tasks quickly. Fixed with a `taskIdRef` staleness guard.
- **`message-queue.ts` / `chat-layout.tsx` effect-ordering race** — the
  drain-on-idle effect and the clear-on-conversation-switch effect could both
  fire in the same React commit (since `setActiveConversation` resets
  `isStreaming` in the same `set()` call as `activeConversationId`), and hook
  declaration order meant drain ran first, pulling a message queued for the
  OLD conversation and sending it into the NEW one. **Superseded** by the full
  backend-driven queue redesign (§8) — no longer applicable as originally
  described.
- **`project-settings-tab.tsx`'s `handleReset`/`handleDelete`** — their
  confirmation dialogs can be closed mid-`await` (no `onEscapeKeyDown`/
  `onInteractOutside` override), letting the user switch projects before the
  destructive action resolves. `handleReset` in particular could then
  unconditionally clear/repopulate the *now-different* active project's
  global chat/kanban store state and force-navigate back to the reset
  project. Fixed with `activeProjectId` checks before each store mutation.
- **`chat-layout.tsx`'s `handleSend`** (shell-result branch and the regular
  attachment-send path) — the optimistic message append used
  `useChatStore.setState((prev) => ({messages: [...]}))` unconditionally; if
  the user switched conversations during the attachment-saving `await` loop
  (or during the shell command's real execution), the append could land in
  whatever conversation is now displayed. Fixed by comparing
  `prev.activeConversationId` against the message's own `conversationId`
  *inside* the `setState` updater (which always sees fresh state).
- **`chat-input.tsx`** — five separate fixes: `filesCacheRef` (the `@`-mention
  "no query" cache) wasn't invalidated on project switch; `handleEnhance`'s
  result application had no staleness guard; the `/compact` slash command's
  result/error application had no staleness guard; `searchFiles`'s debounced
  fetch could resolve after a project switch and populate the mention popover
  with the wrong project's files; `attachedFiles`/`mentionedFiles` weren't
  cleared on a conversation switch (could get attached to the wrong
  conversation's message). All fixed with the same ref-based staleness-guard
  pattern, reusing the existing `draftConv` render-time-adjustment check where
  applicable.

## 6b. Kanban badges / running-agent name (checked, safe — one noted design nuance)

Both read directly from already-fixed store state, so no bug. Noted (not
fixed, by design): the header's running-agent badge is scoped to
`activeConversationId`, so an agent working in a *different* conversation of
the *same* project (e.g. under "New Conv. per Task") won't show in that
badge. Existing behavior, not corruption.

---

## 7. Shell approval + `askUserQuestion` — a real cross-project **security** bug

**The bug**: `engine-manager.ts` had a module-level
`let activeProjectId: string | null = null;` cache, overwritten every time
*any* project's engine was touched via `getOrCreateEngine()` (called from many
unrelated code paths — message sends, review-cycle dispatch, freelance
bootstrap — across *all* projects). Two consumers fell back to this cache:

- **Shell approval mode resolution** (`installShellApprovalHandler`) — could
  resolve a *different* project's `shellApprovalMode` setting if that other
  project's engine happened to be touched more recently.
- **`sessionAutoApproved`** in `shell.ts` was a **single global boolean** —
  clicking "Always allow" for one project's shell command silently disabled
  the approval prompt for **every other project's agents too**, bypassing
  their own configured `shellApprovalMode`.
- **`askUserQuestion`**'s payload also fell back to the same cache — both real
  callers (`request_human_input` for sub-agents, and indirectly the PM's own
  tool) risked mis-tagging a question's `projectId`. (The PM's own path,
  wired through `engine.ts`, was actually already correct — only
  `communication.ts`'s sub-agent path was broken.)

**Fix**:

- `shell.ts`: `ShellApprovalHandler` type now requires
  `(command, agentId, agentName, projectId, conversationId)`.
  `sessionAutoApproved` → `sessionAutoApprovedProjects: Set<string>`.
  `resetShellAutoApprove(projectId)` now takes and uses the id (previously
  cleared globally).
- `agent-loop.ts`: the `run_shell` tool wrapper now runs **unconditionally**
  (previously gated on `if (workspacePath)`) and stamps hidden
  `args.__projectId` / `args.__conversationId` fields (not part of the tool's
  public schema — invisible to the model) before calling the real `execute`.
  A new, analogous wrapper does the same for `request_human_input`.
- `communication.ts`'s `request_human_input` now reads `__projectId` from its
  args and passes it through to `askUserQuestion` (previously passed nothing).
- `engine-manager.ts`: `installShellApprovalHandler` and `askUserQuestion` now
  use the passed-in `projectId`/`conversationId` directly. The buggy
  `activeProjectId` module cache and its setter were **removed entirely**.
  `askUserQuestion`'s `projectId` field is now **required** (was optional) —
  this makes the bug class impossible to reintroduce silently, since any new
  caller omitting it fails `bun run typecheck`.
- `webview.ts`'s `shellApprovalRequest` broadcast, `chat-types.ts`'s
  `ShellApprovalRequest`, and `chat-event-handlers.ts`'s handler all gained
  `conversationId` (previously shell approval had no conversation reference
  at all, so it could only ever deep-link to "the project," not a specific
  conversation — see §9).

**Tests**: `tests/tools/shell-approval.test.ts` exercises the real
`execute()` path with a mock approval handler and asserts "Always allow" in
project A does not suppress the prompt for project B.

## 8. Message queue redesign — frontend-only → backend-driven

**The bug**: queued messages (typed while the PM is busy) lived *only* in a
frontend Zustand store (`message-queue.ts`), untagged by project/conversation,
and were **silently discarded** — not delivered later — the instant the user
switched conversations (`syncActiveConversation` unconditionally cleared the
whole queue on any id change, no toast, no warning).

**Fix**: new `src/bun/message-queue-manager.ts` — an in-memory
`Map<projectId, Map<conversationId, QueuedMessage[]>>` (`MESSAGE_QUEUE_MAX =
3`). Wired into `engine-manager.ts`'s existing idle-check inside
`onStreamComplete` **and** (newly, mirrored) `onStreamError`: once a
project's engine goes truly idle, it now checks for a queued message on that
exact conversation *before* firing the "session complete" toast/notification
(since sending a queued message continues the session, it isn't complete) —
this fires from the engine's own callback, independent of what the frontend
is currently displaying. New RPC methods (`enqueueMessage`,
`removeQueuedMessage`, `getQueuedMessages`, `clearQueuedMessages`) and a
`messageQueueUpdated` broadcast. The frontend `message-queue.ts` store was
fully rewritten as a thin, staleness-guarded *mirror* of server state.
`chat-layout.tsx`'s old local "drain on isBusy transition" effect (§6, now
superseded) was removed entirely.

**Tests**: `tests/message-queue-manager.test.ts` (backend, pure, exhaustive
cross-project/cross-conversation isolation checks) and
`tests/frontend/message-queue.test.ts` (frontend mirror's staleness guards).

**Follow-up gap found and fixed (2026-07-05, same day)**: `clearQueueForProject`
was wired into `removeEngine()` (LRU eviction) but not into
`deleteProjectCascade`/`resetProjectData` (`src/bun/rpc/projects.ts`) — a
message queued for a project that's then deleted/reset would leak in memory
forever (harmless — it references a conversation id that no longer exists and
can never be drained — but still a leak). Both RPC functions now call
`clearQueueForProject(id)` explicitly.

## 9. Plan approval — new desktop notification + a real dormant bug

- Added a desktop notification for `request_plan_approval` (mirrors shell
  approval's pattern; new `plan_approval_notification` setting, new
  `isAppFocused()` export from `engine-manager.ts`) — previously plan
  approval had **no** desktop notification at all.
- **Found while wiring it**: `pm-tools.ts` called
  `broadcastToWebview("planPresented", ...)` (twice) while the actual schema
  entry (`src/shared/rpc/webview.ts`) is named `presentPlan`.
  `broadcastToWebview(method, payload)` does a **literal string lookup**
  (`mainWindowRef.webview.rpc.send[method]?.(payload)`) against Electrobun's
  generated RPC object — a mismatched name doesn't throw, the optional-chained
  call on `undefined` just silently no-ops. This broadcast had **never
  actually reached the frontend** since it was written. Fixed both call
  sites.
- **A second, independent instance of the same bug class was found by the new
  test itself** (see §10): `engine-manager.ts` called
  `broadcastToWebview("agentStatus", ...)` for per-agent status updates, but
  `agentStatus` was **never declared in the schema at all** — the frontend's
  `onAgentStatus` listener existed and was wired up, but the broadcast never
  fired. Fixed by adding the schema entry + `rpc.ts`/`remote-transport.ts`
  dispatchers.

## 10. New cross-project "needs your attention" toast

Shell-approval and plan-approval requests block an agent until the user acts,
but (unlike `agentSessionComplete`, which is purely informational) neither
approval card renders outside its own project's chat — so without this, the
user had zero in-app signal something needed them elsewhere.

New `src/mainview/components/layout/cross-project-approval-toast.tsx`
(mounted once in `app-shell.tsx`): listens for `shellApprovalRequest` and
`presentPlan` broadcasts; if the project doesn't match
`activeProjectId`, shows a sticky toast with an "Open" button.

**"Open" jumps to the exact waiting conversation**, not just the project —
this needed a new `pendingConversationTarget` mechanism:
`chat-store.ts` gained a `{projectId, conversationId} | null` field +
`setPendingConversationTarget` action. Critically, `reset()` (called on
*every* project-switch mount) explicitly **preserves** this field (same as it
already preserves `activeProjectId`/`drafts`) — otherwise it would be wiped
before `ProjectPage`'s conversation auto-select effect ever got a chance to
consume it. That effect now checks the pending target *first*, before its
normal "pick the most recent conversation" fallback, and consumes (clears) it
either way.

This is also *why* shell approval needed `conversationId` added to its
payload (§7) — previously it had none, so this deep-link could only land on
"the project," not the specific conversation; it now matches plan approval,
which already carried `conversationId`.

---

## What's covered by automated tests vs. what isn't

**Covered** (`tests/` — run via `bun run test` / `bun test`):

| File | Covers |
|---|---|
| `tests/message-queue-manager.test.ts` | Backend queue: enqueue/dequeue/remove/clear, MAX cap, cross-project + cross-conversation isolation |
| `tests/tools/shell-approval.test.ts` | Per-project `sessionAutoApprovedProjects` isolation ("Always allow" in A doesn't suppress B); real `execute()` path |
| `tests/rpc/broadcast-method-names.test.ts` | Every string-literal `broadcastToWebview(...)` call site uses a name actually declared in `WebviewSchema` — catches the §9 bug class for *any* broadcast, not just this one |
| `tests/frontend/chat-store.test.ts` | `loadMessages` staleness guard, `setActiveConversation` streaming-state reset, `reset()` preserving `activeProjectId`/`drafts`/`pendingConversationTarget` |
| `tests/frontend/kanban-store.test.ts` | `loadTasks` staleness guard |
| `tests/frontend/message-queue.test.ts` | Frontend mirror store's staleness guards (`loadQueue`, `enqueue`, `remove`, `clear`, `applyBroadcast`) |

**Not covered by automated tests** (reasoning, not an oversight):

- **`agent-loop.ts`'s `run_shell`/`request_human_input` wrapper stamping**
  (the code that actually sets `args.__projectId`/`__conversationId`) —
  exercising it end-to-end requires driving `runInlineAgent` through the full
  AI SDK call chain. The shell-approval test instead verifies the *consumer*
  side directly (the approval gate correctly isolates per-project state given
  correct ids) — the mechanical "stamp the right value" step is a small,
  low-risk piece of code guarded by `bun run typecheck` (the `ShellApprovalHandler`
  signature requiring these params) rather than a dedicated unit test.
- **`pendingConversationTarget` consumption in `project.tsx`'s auto-select
  effect, and the `CrossProjectApprovalToast` component itself** — these are
  React components; the project has no React Testing Library / DOM-rendering
  test infrastructure set up yet. `chat-store.test.ts` covers the *store*
  half of this mechanism (the field surviving `reset()`) directly.
- **`engine-manager.ts`'s idle-check wiring** (the code in `onStreamComplete`/
  `onStreamError` that calls `dequeueMessage`/`sendMessage`) — `engine-manager.ts`
  is a heavy "God module" with many side-effecting imports (DB, channels,
  notifications, pending-approvals); a full unit test would need to mock
  nearly all of them. The queue-draining *logic* it depends on
  (`message-queue-manager.ts`) is fully covered instead.

If extending this coverage, prefer testing the underlying pure/mockable unit
over trying to drive the full engine/agent-loop stack — that's the pattern
used throughout this file's test suite.
