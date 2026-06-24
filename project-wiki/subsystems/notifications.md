---
title: Notifications
type: subsystem
status: verified
verified_at: 2026-06-25
sources:
  - src/bun/notifications/desktop.ts
  - src/bun/notifications/native.ts
  - src/bun/rpc/notifications.ts
  - src/bun/db/schema.ts
  - src/bun/engine-manager.ts
  - src/bun/channels/manager.ts
  - src/shared/rpc/inbox.ts
  - src/mainview/pages/settings/notification-settings.tsx
tags: [notifications]
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
channel messages from [[channels]] (`src/bun/channels/manager.ts:497`). It calls
`shouldNotify(platform, projectId)` and only shows a banner when `prefs.banner`
is true (`native.ts:14-27`). Confusingly, it calls Electrobun's
`Utils.showNotification` directly (`native.ts:20`) — i.e. it does **not** route
through the Windows-toast workaround in `desktop.ts`, so on Windows dev builds a
channel banner may be silently dropped while every `sendDesktopNotification`
caller still works. (See Gotchas.)

## Preferences: `notification_preferences` table + `shouldNotify`

The table (`src/bun/db/schema.ts:355-364`) stores one row per `platform`
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
Notifications page reads/writes them (`notification-settings.tsx:299,391,412`).

## Per-feature gating (the second, ad-hoc preference layer)

Because `sendDesktopNotification` is ungated, several features add their own
`settings`-table toggles and check them *before* calling it:

- **Session complete** (PM + all agents idle): gated by the
  `session_complete_notification` setting and only fired when the app window is
  **not** focused (`engine-manager.ts:507-525`). The idle check is wrapped in a
  `setTimeout(0)` so the engine's `finally` clears `pmProcessing` first
  (`engine-manager.ts:508-511`).
- **Agent error**: gated by the `error_notification` setting (default on) and,
  like session-complete, only fired when the app is **not** focused. Fires from
  the `onStreamError` callback (`engine-manager.ts`, the same callback that
  broadcasts `streamError`) so the red in-chat error and the toast share a
  trigger point.
- **Shell approval required**: always fired so the user can approve while away
  (`engine-manager.ts:354-357`).
- **Agent needs input**: `request_human_input` (`engine-manager.ts:440`).
- **Task done**: kanban move to done (`src/bun/rpc/kanban.ts:213`).
- **Scheduler/cron**: reminders + job results (`scheduler/cron-scheduler.ts:69`,
  `scheduler/task-executor.ts:64,366`).
- **Freelance**: new listings (`freelance/fetcher.ts:143`), bid ready
  (`rpc/freelance-outbox.ts:220`), auto-shortlist (`rpc/freelance-wizard.ts:1277`),
  inbox (`rpc/freelance-inbox.ts:132`), expert notify
  (`freelance/expert/notify.ts:77,167`).
- **Council** completion (`rpc/council.ts:551`).
- **Test button**: Settings fires a sample toast to verify the OS path works
  (`rpc-groups/projects-system.ts:269`).

So a notification can be suppressed by **either** the `notification_preferences`
table (channels only) **or** a feature-specific `settings` flag — there is no
single gate.

## Key files

| File | Role |
|---|---|
| `src/bun/notifications/desktop.ts` | Ungated OS toast; Windows PowerShell/WinRT workaround for missing AUMID |
| `src/bun/notifications/native.ts` | Preference-gated banner for inbound channel messages |
| `src/bun/rpc/notifications.ts` | `getNotificationPreferences` / `saveNotificationPreference` / `shouldNotify` (project-over-global resolution, mute logic) |
| `src/bun/db/schema.ts:355` | `notification_preferences` table |
| `src/shared/rpc/inbox.ts:103` | RPC contract for the preference CRUD |
| `src/mainview/pages/settings/notification-settings.tsx` | Settings UI (per-platform prefs + per-feature settings toggles) |

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
- **Fail-open / fail-silent.** No preference row ⇒ everything allowed
  (`notifications.ts:49`); every native send swallows its own errors, so a missing
  PowerShell or API never surfaces to the caller.
- **`muteUntil` keeps badges.** Muting suppresses sound + banner but not badge
  (`notifications.ts:50-52`).

## Related
- [[channels]] — only consumer of the preference-gated path
- [[agent-engine]] — fires session-complete / approval / human-input toasts
- [[database]] — `notification_preferences` schema
- [[rpc-layer]] — preference CRUD registered via the inbox group

## Open questions
- Should `sendNativeNotification` route through `sendDesktopNotification` so
  channel banners survive the Windows AUMID quirk? Today it does not.
- The `sound`/`badge` frontend-driven path referenced in `native.ts:29` — is any
  frontend code actually consuming those flags, or are they dead?
