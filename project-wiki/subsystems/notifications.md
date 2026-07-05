---
title: Notifications
type: subsystem
status: verified
verified_at: 2026-07-05
sources:
  - src/bun/notifications/desktop.ts
  - src/bun/notifications/native.ts
  - src/bun/rpc/notifications.ts
  - src/bun/db/schema.ts
  - src/bun/engine-manager.ts
  - src/bun/agents/tools/pm-tools.ts
  - src/bun/channels/manager.ts
  - src/shared/rpc/inbox.ts
  - src/mainview/pages/settings/notification-settings.tsx
tags: [notifications, channels]
---

# Notifications

AgentDesk fires **OS-level desktop notifications** to alert the user when the app
is in the background — a task finishes, an agent needs input, a shell approval is
pending, a new channel message or freelance listing arrives. There is no
in-app toast bus here; "notifications" in this subsystem means *real native OS
toasts*. The single most important thing to understand: there are **two separate
delivery paths with different gating rules**, and only one of them consults the
`notification_preferences` table.

## The two delivery paths (why two?)

### 1. `sendDesktopNotification(title, body)` — the ungated workhorse
`src/bun/notifications/desktop.ts:16`. This is what almost every caller uses. It
takes a bare title/body and **does not check any preference table** — gating is
left to each caller (see "Per-feature gating" below). It exists because
Electrobun's built-in `Utils.showNotification` silently drops notifications on
Windows: dev-mode (and unregistered) apps lack a registered Application User
Model ID (AUMID), which WinRT toasts require (`desktop.ts:5-14`).

The fix is platform-branched (`desktop.ts:16-26`):
- **Windows**: `sendWindowsToast` spawns a hidden `powershell.exe` that builds a
  `ToastGeneric` XML and fires it through `ToastNotificationManager`, borrowing
  PowerShell's *own* registered AUMID (`{1AC14E77-…}\…\powershell.exe`) so no
  registration is needed (`desktop.ts:28-71`). The bundled tray icon is used as
  the toast logo via `appLogoOverride` (`desktop.ts:34-35`). XML special chars and
  single-quotes are escaped before embedding (`desktop.ts:30-31,50`), and the
  spawn is fire-and-forget with a 5 s safety timeout (`desktop.ts:62-67`).
- **macOS/Linux**: plain `Utils.showNotification` works natively (`desktop.ts:21`).

All failure modes (PowerShell missing, API unavailable) are swallowed — a
notification never throws into a caller (`desktop.ts:24,68`).

### 2. `sendNativeNotification({ platform, projectId, title, body })` — preference-gated
`src/bun/notifications/native.ts:8`. This is the **only** path that honours the
`notification_preferences` table, and it is used in exactly one place: inbound
channel messages from [[channels]] (`src/bun/channels/manager.ts:504`). It calls
`shouldNotify(platform, projectId)` and only shows a banner when `prefs.banner`
is true (`native.ts:14-27`). Confusingly, it calls Electrobun's
`Utils.showNotification` directly (`native.ts:20`) — i.e. it does **not** route
through the Windows-toast workaround in `desktop.ts`, so on Windows dev builds a
channel banner may be silently dropped while every `sendDesktopNotification`
caller still works. (See Gotchas.)

### 3. Channel push — proactive messages to Discord/WhatsApp/Email
A third path, separate from both toast mechanisms above: pushing a text message
to every connected channel adapter via `broadcastSchedulerResult` (or
`sendChannelMessage` for a targeted reply — see [[channels]]). Unlike the two
OS-toast paths, these pushes are **not** gated by `isAppFocused()` — channel
notify exists precisely for "away from the computer entirely", so it fires
regardless of window focus (mirrors the pre-existing `task_done_channel_notify`
precedent, `channels/manager.ts:210`). Each is gated by its own `settings`-table
toggle (fail-open — no row ⇒ enabled), exposed in the Notifications page's
"Channel Messages" card:

- **`error_channel_notify`**: fires from `onStreamError`
  (`engine-manager.ts:762-779`), alongside (but independent of) the
  focus-gated `error_notification` desktop toast.
- **`question_channel_notify`**: fires from both `askUserQuestion`
  (`engine-manager.ts:567-577`, `request_human_input`'s question) and
  `installShellApprovalHandler` (`engine-manager.ts:404-413`, shell-command
  approval) — the same toggle covers both because they share the same
  "blocking, needs a human decision" shape. **This is the only channel-push
  path with a return trip**: `pendingUserQuestions` and `pendingShellApprovals`
  now carry `projectId`, and `getPendingChannelInteraction(projectId)`
  (`engine-manager.ts:485-501`) lets `channels/manager.ts`'s
  `handleIncomingMessage` recognise an inbound reply as the answer to a pending
  request for that project and resolve it directly via `resolveUserQuestion` /
  `resolveShellApproval` — instead of routing it into a fresh PM turn (the
  original tool call is still blocked awaiting exactly that response). A shell
  reply is parsed by `parseShellDecision` (`channels/manager.ts`, keywords
  `allow`/`approve`/`yes`/`deny`/`reject`/`no`/`always`; unrecognized text
  re-prompts instead of guessing). This interception is checked before the
  normal engine-forwarding step, so while a question/approval is pending, that
  channel's replies are consumed as answers, not new chat turns.
- **`plan_approval_channel_notify`**: fires from `request_plan_approval`'s
  **in-app** branch only (`pm-tools.ts`, right after the existing
  `plan_approval_notification` desktop-toast block) — a one-way heads-up with
  no reply resolution, because an in-app plan approval isn't a blocking
  `Promise` like a question; the PM is waiting for the *next message in that
  same in-app conversationId*, not a reply on a channel's own daily
  conversation. Replying from the channel does not approve the plan. (A
  **channel-sourced** plan conversation already had full round-trip approval
  before this — see [[plan-approve-execute]] and the Gotchas below.)

## Preferences: `notification_preferences` table + `shouldNotify`

The table (`src/bun/db/schema.ts:396-405`) stores one row per `platform`
(optionally scoped to a `projectId`) with three boolean-as-integer flags
(`soundEnabled`, `badgeEnabled`, `bannerEnabled`, default 1) and an optional
`muteUntil` ISO timestamp.

`shouldNotify` (`src/bun/rpc/notifications.ts:41-54`) resolves which row applies:
a project-scoped row wins over the global (`projectId IS NULL`) row
(`notifications.ts:46-48`); with no row at all it **fails open** — all three true
(`notifications.ts:49`). If `muteUntil` is in the future it forces
`sound:false, banner:false` but **leaves badge as configured**
(`notifications.ts:50-52`). Note the comment in `native.ts:29`: sound and badge
are *not* acted on by the bun side at all — they are meant for the frontend to
honour via RPC events, so today the only flag that changes native behaviour is
`banner`.

CRUD lives in `src/bun/rpc/notifications.ts`: `getNotificationPreferences`
(`:5`) and `saveNotificationPreference` (`:12`, upsert by optional `id`). These
are exposed over RPC via the `inbox` contract group
(`src/shared/rpc/inbox.ts:103-110`) and registered in
`src/bun/rpc-groups/channels-inbox-scheduler.ts:35-36`. The Settings →
Notifications page reads/writes them (`notification-settings.tsx:301,396,420`).

## Per-feature gating (the second, ad-hoc preference layer)

Because `sendDesktopNotification` is ungated, several features add their own
`settings`-table toggles and check them *before* calling it:

- **Session complete** (PM + all agents idle): gated by the
  `session_complete_notification` setting and only fired when the app window is
  **not** focused (`engine-manager.ts:630-660`). The idle check is wrapped in a
  `setTimeout(0)` so the engine's `finally` clears `pmProcessing` first. The
  same idle check now also drives an **in-app** toast (`agentSessionComplete`,
  `engine-manager.ts:647`) that fires regardless of window focus — see the
  cross-reference below.
- **Agent error**: gated by the `error_notification` setting (default on) and,
  like session-complete, only fired when the app is **not** focused. Fires from
  the `onStreamError` callback (`engine-manager.ts:663-682`, the same callback
  that broadcasts `streamError`) so the red in-chat error and the toast share a
  trigger point. The same callback now also does a focus-independent channel
  push gated by `error_channel_notify` — see "Channel push" above.
- **Shell approval required**: always fired so the user can approve while away
  (`engine-manager.ts:393-398`). Also pushed to connected channels (gated by
  `question_channel_notify`), with a channel reply of allow/deny/always
  resolving it — see "Channel push" above.
- **Plan approval required**: `request_plan_approval` (`pm-tools.ts:1709-1735`)
  fires a desktop notification at both its call sites (PM-driven and the
  code-enforced task-planner-completion path) — gated by `isAppFocused()`
  (exported from `engine-manager.ts:140`, the app-focus flag `notifications`
  and `agent-engine` both read) and the `plan_approval_notification` setting
  (default enabled, mirrors `session_complete_notification`'s boolean-string
  parsing). Previously plan approval had **no** desktop notification at all —
  a plan waiting for approval in a background/minimised project gave zero
  signal that anything needed the user. For an **in-app** conversation this
  same call site now also pushes a one-way heads-up to connected channels
  (gated by `plan_approval_channel_notify`, not focus-gated) — see "Channel
  push" above; a **channel-sourced** conversation instead sends the plan text
  itself and waits for approve/reject in that same channel (unchanged, see
  [[plan-approve-execute]]).
- **Agent needs input**: `request_human_input` (`engine-manager.ts:499`). Also
  pushed to connected channels (gated by `question_channel_notify`), with a
  channel reply resolving the pending question — see "Channel push" above.
- **Task done**: kanban move to done (`src/bun/rpc/kanban.ts:213`). This is
  OS-notification-only now — there is no in-app toast keyed on a single kanban
  task reaching done (that used to exist via a `taskCompleted` broadcast, since
  retired). The in-app equivalent is `agentSessionComplete`, which fires once a
  project's *entire* agent-dispatch session goes idle
  (`engine-manager.ts:630-660`, gated on `sessionHadAgentActivity` so a plain
  PM chat reply with zero agent dispatches doesn't toast), not once per task.
  Its sole consumer is the `AgentSessionToast` singleton in the app shell
  (`layout/agent-session-toast.tsx`), gated on the chat store's
  `activeProjectId` — see [[frontend-components]] and [[agent-engine]].
- **Scheduler/cron**: reminders + job results (`scheduler/cron-scheduler.ts:69`,
  `scheduler/task-executor.ts:64,366`).
- **Freelance**: new listings (`freelance/fetcher.ts:218`), bid ready
  (`rpc/freelance-outbox.ts:226`), auto-shortlist (`rpc/freelance-wizard.ts:1489`),
  inbox (`rpc/freelance-inbox.ts:132`), expert notify
  (`freelance/expert/notify.ts:77,167`).
- **Council** completion (`rpc/council.ts:551`).
- **Test button**: Settings fires a sample toast to verify the OS path works
  (`rpc-groups/projects-system.ts:274`).

So a notification can be suppressed by **either** the `notification_preferences`
table (channels only) **or** a feature-specific `settings` flag — there is no
single gate. Channel-push toggles (`error_channel_notify`,
`question_channel_notify`, `plan_approval_channel_notify`) are a third
independent gate layer — see "Channel push" above.

## Key files

| File | Role |
|---|---|
| `src/bun/notifications/desktop.ts` | Ungated OS toast; Windows PowerShell/WinRT workaround for missing AUMID |
| `src/bun/notifications/native.ts` | Preference-gated banner for inbound channel messages |
| `src/bun/rpc/notifications.ts` | `getNotificationPreferences` / `saveNotificationPreference` / `shouldNotify` (project-over-global resolution, mute logic) |
| `src/bun/db/schema.ts:396` | `notification_preferences` table |
| `src/shared/rpc/inbox.ts:103` | RPC contract for the preference CRUD |
| `src/bun/engine-manager.ts` | `getPendingChannelInteraction`, `resolveUserQuestion`, `resolveShellApproval` — the channel-reply resolution path for questions/shell-approvals |
| `src/bun/channels/manager.ts` | `broadcastSchedulerResult`/`sendChannelMessage` (the channel-push transport) + `handleIncomingMessage`'s pending-interaction interception |
| `src/mainview/pages/settings/notification-settings.tsx` | Settings UI (per-platform prefs + per-feature settings toggles + the "Channel Messages" card) |

## Gotchas / Constraints

- **Two paths, one table.** Only `sendNativeNotification` (channels) reads
  `notification_preferences`. Everything else (`sendDesktopNotification`) ignores
  it and relies on per-feature `settings` flags. Don't assume the Notifications
  settings panel controls task-done / session-complete toasts.
- **Windows AUMID quirk.** `sendDesktopNotification` works around it via a hidden
  PowerShell toast, but `sendNativeNotification` calls `Utils.showNotification`
  directly (`native.ts:20`), so channel banners can silently no-op on Windows dev
  builds. This is an inconsistency, not by design.
- **`sound`/`badge` flags are inert on the bun side** — `shouldNotify` returns
  them but native code only acts on `banner` (`native.ts:29`). They are intended
  for the frontend.
- **Channel push is fan-out-to-all, not project-scoped.** `error_channel_notify`
  / `question_channel_notify` / `plan_approval_channel_notify` pushes go to
  *every* connected channel adapter regardless of whether that channel is bound
  to the project that errored/asked (mirrors `task_done_channel_notify`'s
  existing behaviour). A user with multiple projects and one connected Discord
  channel gets pinged there for any project's error/question, not just a bound
  one.
- **Only questions/shell-approvals have a reply round-trip.** Channel push for
  errors and in-app plan-approval is one-way (informational). Only
  `question_channel_notify`'s two request types are resolvable from a channel
  reply, because they're backed by an in-memory blocking `Promise`
  (`pendingUserQuestions`/`pendingShellApprovals`) that a `projectId`-keyed
  lookup can resolve directly; errors and in-app plan approval have no
  equivalent pending-state primitive to resolve into.
- **Fail-open / fail-silent.** No preference row ⇒ everything allowed
  (`notifications.ts:49`); every native send swallows its own errors, so a missing
  PowerShell or API never surfaces to the caller.
- **`muteUntil` keeps badges.** Muting suppresses sound + banner but not badge
  (`notifications.ts:50-52`).

## Related
- [[channels]] — consumer of the preference-gated path AND now the reply-resolution
  side of the channel-push path (`handleIncomingMessage`'s pending-interaction check)
- [[agent-engine]] — fires session-complete / approval / human-input toasts, and
  now the channel-push + `getPendingChannelInteraction` source of truth
- [[plan-approve-execute]] — the plan-approval desktop notification and its
  `plan_approval_notification` setting, plus the channel-sourced vs in-app
  plan-approval channel-push split
- [[database]] — `notification_preferences` schema
- [[rpc-layer]] — preference CRUD registered via the inbox group

## Open questions
- Should `sendNativeNotification` route through `sendDesktopNotification` so
  channel banners survive the Windows AUMID quirk? Today it does not.
- The `sound`/`badge` frontend-driven path referenced in `native.ts:29` — is any
  frontend code actually consuming those flags, or are they dead?
- Should in-app plan approval gain a real pending-state primitive (like
  `pendingUserQuestions`) so a channel reply could actually approve/reject it,
  instead of the current one-way heads-up? Would require routing that channel
  reply into the specific in-app conversationId rather than the channel's own
  daily conversation — deferred as out of scope for TASK-500.
