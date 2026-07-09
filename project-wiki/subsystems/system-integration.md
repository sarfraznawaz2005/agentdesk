---
title: System Integration (Sleep Prevention + Launch at Startup)
type: subsystem
status: verified
verified_at: 2026-07-09
sources:
  - src/bun/system/power-save-blocker.ts
  - src/bun/system/login-item.ts
  - src/bun/index.ts
  - src/mainview/pages/settings/general.tsx
  - src/bun/rpc-groups/setting-callbacks.ts
tags: [settings, os-integration, windows, macos, linux]
---

# System Integration (Sleep Prevention + Launch at Startup)

Two General-settings toggles — **"Prevent System Sleep While Running"** and
**"Launch at Startup"** — control OS-level behaviour that Electrobun does not
expose natively. Electrobun (checked against `node_modules/electrobun` v1.18.1
source, not just its docs) has no `powerSaveBlocker` or
`setLoginItemSettings` equivalent, so both features are custom per-platform
native calls living in `src/bun/system/`. Both default to **off**.

## Storage: same generic `settings` table, no schema change

Both toggles are plain boolean rows in the existing key/value `settings` table
(`src/bun/db/schema.ts`), category `"general"`, keys `prevent_system_sleep` and
`launch_at_startup` — no migration was needed. The frontend
(`general.tsx`) loads/coerces them exactly like `appearance.tsx`'s
`dashboard_quotes` pattern and saves them via the normal
`rpc.saveSetting(key, value, "general")` call in the page's single
"Save Changes" button flow (not applied instantly on toggle).

## How a toggle takes effect: `onSettingChange`

Saving either setting goes through the ordinary `saveSetting` RPC handler
(`src/bun/rpc-groups/settings-providers.ts`), which — for *every* key —
invokes `settingChangeCallbacks.get(key)?.(value)`
(`src/bun/rpc-groups/setting-callbacks.ts`). `src/bun/index.ts` registers one
callback per key (same pattern as the pre-existing `global_workspace_path`
callback) that applies the native OS effect live, the instant Save is clicked
— no restart required.

On **every app boot**, `index.ts` also reads both settings directly via
`getSetting(key, "general")` and re-applies them unconditionally. This is a
deliberate self-heal: it re-arms the sleep blocker if the app was left running
across a restart, and rewrites the login-item entry with the *current*
executable path in case the install moved (matches the existing
`registerWindowsUninstaller()` precedent). `getSetting`'s declared return type
is `string | null`, but it JSON-parses the stored value, so a stored boolean
comes back as an actual `boolean` — the `as unknown` comparison in `index.ts`
mirrors the same documented workaround in `prompt-logger.ts`.

## `src/bun/system/power-save-blocker.ts` — "Prevent System Sleep"

`startSleepBlock()` / `stopSleepBlock()`, called with **both system and
display** kept awake (not just system — a deliberate scope decision, since
"while running" implies active use, not just background agent work). All
three platforms use the **same shape**: spawn a dedicated helper process that
holds the block for as long as it's alive, track it, `kill()` it to release:

- **win32**: a hidden `powershell.exe` process that `Add-Type`s a P/Invoke of
  `SetThreadExecutionState` (`kernel32.dll`) and re-asserts
  `ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED` every 30s in a
  loop until killed. **Not** a direct one-shot `bun:ffi` call — see "Two
  Windows bugs" below for why.
- **darwin**: spawns `caffeinate -d -i -w <own pid>` and tracks the child
  process. `-w <pid>` is a safety net — caffeinate self-terminates if
  AgentDesk crashes without calling `stopSleepBlock()`. Disabling kills the
  tracked child.
- **linux**: spawns `systemd-inhibit --what=sleep:idle --mode=block sleep
  infinity` and tracks the child the same way. If `systemd-inhibit` isn't on
  `PATH` (minimal distros without systemd), the spawn throws and is caught —
  logged, not fatal; the toggle silently becomes a no-op on those systems.

Every spawn pipes stderr and calls `logIfProcessDiesEarly()`, which logs if the
helper process exits on its own (vs. being intentionally killed by
`stopSleepBlock()`) — added *because* the win32 bug below was invisible for a
long time precisely because stderr was being discarded.

Released on quit via the `Electrobun.events.on("before-quit", ...)` handler in
`index.ts`, alongside the other `shutdown*()` calls, so no orphaned helper
process outlives the app.

### Two Windows bugs found during manual verification (both fixed)

`powercfg /requests` (elevated) is the ground-truth way to check this on
Windows — it correctly shows other apps' requests (e.g. Chrome's video wake
lock), so it's a reliable oracle. Two independent bugs surfaced before it
showed AgentDesk's own request:

1. **`bun:ffi` `SetThreadExecutionState` doesn't persist across calls.** The
   original design called `dlopen("kernel32.dll")` → `SetThreadExecutionState`
   directly from the main thread once, relying on the flag staying set for the
   process's lifetime (per Win32 semantics, it should). Reproduced with a
   standalone script calling it twice in a row: the *second* call's return
   value (the *previous* state) came back as the original idle state, not what
   the first call had just set — proving the effect evaporates almost
   immediately, most likely because Bun's FFI dispatch doesn't guarantee two
   calls land on the same OS thread (the state is thread-scoped). Fixed by
   moving to the helper-process design above, matching darwin/linux instead of
   being the odd one out.
2. **The PowerShell replacement then silently crashed on every single call.**
   `SetThreadExecutionState(0x80000003)` — PowerShell parses `0x80000003` as a
   signed `Int32` (`-2147483645`, since it exceeds `Int32.MaxValue` but
   PowerShell doesn't auto-promote hex literals to `UInt32`), and the P/Invoke
   signature takes `uint`, so .NET's method binder throws
   `MethodArgumentConversionInvalidCastArgument` rather than implicitly
   converting a negative number — on **every** iteration of the loop. This was
   invisible because the process was spawned with `stderr: "ignore"`. Fixed by
   passing the flag as an unambiguous positive decimal literal
   (`[uint32]2147483651`) instead of hex, and by piping stderr going forward
   (see `logIfProcessDiesEarly` above) so a script-level crash like this can't
   hide silently again.

Verified end-to-end after both fixes: `powercfg /requests` shows
`powershell.exe` under both `DISPLAY` and `SYSTEM` while the toggle is on.

## `src/bun/system/login-item.ts` — "Launch at Startup"

`enableLaunchAtStartup()` / `disableLaunchAtStartup()`, keyed off
`getLauncherPath()` — **not** `process.argv0` directly. `process.argv0` is the
currently-running `bun` binary (e.g. `<app>/bin/bun.exe`), but Electrobun's
actual "front door" executable is a separate, small native `launcher` binary
in the same `bin/` folder (confirmed via `node_modules/electrobun/src/cli/index.ts`:
this is literally how Electrobun itself launches a built app bundle,
`Bun.spawn([join(bundleExecPath, "launcher.exe")], ...)`, and how the Windows
release job verifies a bundle isn't damaged — `Get-ChildItem ... -Filter
launcher.exe`). Start Menu shortcuts, portable double-clicks, and macOS's
`Info.plist` `CFBundleExecutable` (`<string>launcher</string>`) all point at
this same binary — autostart must match, or it's not really replicating a
normal launch. `getLauncherPath()` resolves
`join(dirname(process.argv0), "launcher.exe" | "launcher")`, falling back to
`process.argv0` if no sibling launcher is found (defensive; not expected to
trigger in a real build — verified the sibling relationship holds even in the
dev build's `build/dev-win-x64/AgentDesk-dev/bin/` folder).

- **win32**: `reg add`/`reg delete` on
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\AgentDesk`, spawned the
  same way as `src/bun/rpc/env-vars.ts`'s OS-env persistence and
  `windows-registry.ts`'s uninstaller entry. The registry value is written
  with literal embedded quotes (`"<path>"`) since Windows parses the Run value
  as a raw command line and the install path may contain spaces. Verified via
  `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v AgentDesk`.
- **darwin**: `osascript` driving System Events' Login Items (`make login
  item` / `delete login item`) — the pre-`SMAppService` technique, chosen
  because a proper `SMAppService` registration needs a signed helper-app
  target in `Info.plist` that Electrobun's build doesn't produce. Truncates
  the launcher path at the first `.app` path segment, since Login Items
  expects the `.app` bundle path, not a specific binary inside it (macOS
  invokes whatever `Info.plist`'s `CFBundleExecutable` says regardless, so
  this part was actually correct even before the `launcher` vs `bun` fix).
- **linux**: writes/removes a freedesktop autostart entry at
  `~/.config/autostart/agentdesk.desktop`, `Exec="<launcher path>"` — matches
  Electrobun's own generated `.desktop` template, which also always uses
  `Exec=launcher` (`cli/index.ts:2348`), not `bun`.

## Gotchas / Constraints

- **Not manually verified on macOS/Linux.** Both native modules were written
  against the standard, well-documented technique for each platform, but this
  repo's dev/test environment is Windows-only — the macOS Login Items and
  Linux autostart-file paths have not been exercised end-to-end. Windows *was*
  fully verified end-to-end (registry entry + `powercfg /requests`), and that
  process caught two real bugs (see above) — a reminder that "should work per
  the docs" and "verified working" are not the same thing, especially for
  thread-scoped OS APIs and cross-language (JS → PowerShell/.NET) number
  marshaling.
- **PowerShell hex literals + P/Invoke `uint` params don't mix safely.** Any
  future native-call script that passes a flags/bitmask value exceeding
  `Int32.MaxValue` (i.e. has the top bit set, like `0x80000000`-and-up) to a
  P/Invoke `uint`/`UInt32` parameter must use a positive decimal literal cast
  to `[uint32]`, not a hex literal — PowerShell parses hex literals as signed
  `Int32` and won't implicitly convert a negative result to `UInt32`.
- **Discarding a spawned process's stderr hides exactly this kind of bug.**
  The PowerShell crash above produced zero visible symptoms other than the
  toggle silently not working — no exception surfaced anywhere in the app,
  because `stderr: "ignore"` swallowed the `MethodException` text. Prefer
  `stderr: "pipe"` + logging on unexpected exit for any spawned helper process
  whose whole job is to keep running silently in the background, precisely
  because "runs successfully and does nothing" and "crashed immediately" look
  identical from the calling code's perspective otherwise.
- **`settingChangeCallbacks` is a `Map`, one callback per key.** This was fine
  here since `prevent_system_sleep`/`launch_at_startup` are new, distinct keys
  — but a future feature reusing an existing key would silently overwrite an
  earlier callback rather than composing with it.
- **No gate on dev/unpackaged builds.** Unlike `registerWindowsUninstaller()`
  (which only registers on `channel === "stable"`), the login-item toggle
  applies in dev builds too if the user explicitly enables it — this is a
  user-initiated toggle rather than an automatic startup side-effect, so no
  channel gate was added.

## Related
- [[backend-core]] — app boot ordering; these two toggles are applied during
  the same early-boot block as `registerWindowsUninstaller()`
- [[database]] — the generic `settings` key/value table both toggles use
- [[directory-map]] — where `src/bun/system/` sits in the repo layout

## Open questions
- Should the sleep-blocker options be split into two toggles (system-only vs.
  system+display), or is the current "always both" behaviour sufficient? User
  explicitly chose system+display for this pass.
- Should macOS/Linux be manually verified on real hardware/VMs before shipping,
  given they were implemented but not tested in this environment?
