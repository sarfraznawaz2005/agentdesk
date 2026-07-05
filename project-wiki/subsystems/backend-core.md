---
title: Backend Core & Entry
type: subsystem
status: verified
verified_at: 2026-07-06
sources:
  - src/bun/index.ts
  - src/bun/engine-manager.ts
  - src/bun/message-queue-manager.ts
  - src/bun/agents/tools/shell.ts
  - src/bun/agents/tools/communication.ts
  - src/bun/agents/agent-loop.ts
  - src/bun/db/maintenance.ts
  - src/bun/db/maintenance-state.ts
  - src/bun/lib/git-runner.ts
  - src/bun/lib/install-mode.ts
  - src/bun/lib/secret-crypto.ts
  - tests/lib/secret-crypto.test.ts
  - src/bun/lib/encrypt-existing-secrets.ts
  - src/bun/lib/path-utils.ts
  - src/bun/annotations/server.ts
  - src/bun/annotations/preview-window.ts
  - src/bun/annotations/toolbar-script.ts
tags: [core, bootstrap]
---

# Backend Core & Entry

This is the Bun **main process**: the single `index.ts` that boots the whole app,
the `EngineManager` that caches one [[agent-engine]] per project and owns the
global abort + human-in-the-loop plumbing, the small shared `lib/*` utilities
every feature depends on, and the in-app **annotation/preview** server. The most
important thing to understand is the **startup ordering contract**: the only work
that runs *synchronously before the window is created* is what's required for
correctness (DB migrate → seed → secret encryption → cron/automation); everything
that does network or heavy disk I/O (plugins, skills, channels, MCP, freelance,
the local servers) is deferred to the webview's `dom-ready` so the window appears
fast and nothing slow can block it.

## Startup sequence (`index.ts`)

`index.ts` is a top-level-`await` module, so its statements *are* the boot script
— order on the page is order at runtime.

```mermaid
flowchart TD
  EH[initGlobalErrorHandlers] --> AISDK[installAiSdkWarningHandler]
  AISDK --> MIG[runMigrations]
  MIG --> SEED[seedDatabase]
  SEED --> ENV[loadCustomEnvVarsIntoProcess]
  ENV --> ENC[encryptExistingSecrets]
  ENC --> EARLY[WAL timer, truncation dir, cron, automation, issue-fixer poll]
  EARLY --> WIN[loadWindowState + create BrowserWindow]
  WIN --> REF[setMainWindowRef]
  REF --> DEFER[setTimeout 0: workspace sync, deploy reconcile, orphan cleanup]
  DEFER --> MAINT[setTimeout 20s: DB maintenance / VACUUM]
  WIN --> DR[dom-ready -> background services]
  DR --> PLUG[plugins, skills, channels]
  DR --> SRV[annotation + playground servers]
  DR --> MCP[setTimeout 10s: MCP clients]
```

### 1. Synchronous critical path (`index.ts:140`–`index.ts:189`)
Global error handlers install first (`index.ts:140`) so nothing later throws
unlogged. Immediately after, `installAiSdkWarningHandler()` (`db/error-logger.ts`)
claims the Vercel AI SDK's `globalThis.AI_SDK_LOG_WARNINGS` seam — routing every
SDK warning to the console in the `dev` channel and to `error.log` with a
`[WARNING]` prefix in production/canary — before any inference can fire with the
SDK's default logger. Then the DB pipeline runs in strict order: `runMigrations()` →
`await seedDatabase()` → `loadCustomEnvVarsIntoProcess()` → `encryptExistingSecrets()`
(`index.ts:150`–`index.ts:153`). The secret-encryption pass must run *after* seed
but *before* anything reads credentials. After that the cheap, fire-on-time
services start early so health checks pass and scheduled jobs aren't late: WAL
checkpoint timer (`index.ts:174`), truncation dir (`index.ts:177`), cron scheduler
+ automation engine (`index.ts:183`–`index.ts:186`), and Issue Fixer polling
(`index.ts:189`). `setTaskExecutorEngine(getOrCreateEngine)` (`index.ts:183`) is
the wiring point that lets the scheduler dispatch into the engine layer.

### 2. Window creation (`index.ts:202`–`index.ts:222`)
`loadWindowState()` (`index.ts:59`) restores the persisted frame from
`<userData>/window-state.json` (`index.ts:56`), falling back to a centered default
on the primary display. `getMainViewUrl()` (`index.ts:118`) decides between the
Vite dev server (`http://localhost:5173`, retried up to 15s in the `dev` channel)
and the bundled `views://mainview/index.html`. **`isDevMode` is derived purely
from whether that URL is localhost** (`index.ts:206`) — it gates DevTools and the
right-click context menu. Immediately after construction,
`setMainWindowRef(mainWindow)` (`index.ts:222`) hands the window to the
EngineManager so engine callbacks can broadcast RPC.

### 3. DB maintenance split (the "never block the window, never flash a modal" rule)
Maintenance is deliberately split by cost profile:
- **Incremental optimize** (`runIncrementalMaintenance` — `PRAGMA optimize` +
  passive WAL checkpoint) runs **synchronously BEFORE** `new BrowserWindow`,
  every startup. It is cheap (near-instant when nothing changed, the SQLite-
  recommended cadence), so running it pre-window keeps it **invisible** — no
  overlay, no skeletons — at the cost of a sub-second-ish delay before the window
  appears.
- **Full VACUUM** (7-day gated, `maybeVacuumInBackground` → worker thread) is
  deferred to `setTimeout(20_000)` post-window via `maybeRunStartupMaintenance()`
  so it never competes with the initial UI/agent load. It rewrites the whole DB
  file (duration scales with size) and holds a lock that stalls queries app-wide,
  so it is the one startup op that shows the overlay — but only when actually due.

A `setTimeout(0)` (`index.ts:229`) also pushes workspace folder sync, stuck-deploy
reconcile, an orphaned-`workflow:%`-settings cleanup, and
`reconcilePendingApprovalsOnStartup()` (`index.ts:236`–`index.ts:238`, see
"Durability" below) off the boot path.

**Maintenance overlay.** Because VACUUM (and the manual Settings ops) hold a DB
lock and stall queries app-wide, they drive a **global overlay** instead of bare
skeletons: `db/maintenance-state.ts` tracks an `{active,message}` flag and
broadcasts `maintenance` via `broadcastToWebview`; `MaintenanceOverlay` (mounted
in the AppShell) shows a non-closeable "please wait" panel over every page
(blocking mouse + keyboard + scroll) and syncs initial state via the
`getMaintenanceStatus` RPC (so a reload mid-maintenance still shows it). It is
shown ONLY by the rare 7-day VACUUM and by the **manual** optimize/vacuum/prune
RPCs (user-clicked in Settings); the pre-window incremental optimize and the
periodic WAL checkpoint never show it.

### 4. Background services on `dom-ready` (`index.ts:258`–`index.ts:337`)
A `backgroundServicesInitialised` boolean guards this block so it runs once. On
DOM ready the window maximizes, the Win32 titlebar icon is set via FFI
(`setWindowTitlebarIcon`, `index.ts:419` — a `user32.dll` `WM_SETICON` call), and
in production a `contextmenu` preventDefault is injected to remove Inspect Element.
Then, in order: `initPlugins()` → `skillRegistry.loadAll()` → register channel
adapters + `initChannelManager` (fire-and-forget so a slow WhatsApp reconnect
can't stall the rest) → **MCP clients delayed another 10s** (`index.ts:306`, so
spawning external servers like chrome-devtools doesn't fight the UI load) →
annotation + playground static servers → optional freelance poller + Auto-Earn
watchdog (both self-gated on the freelance flag).

### 5. Navigation lockdown (`index.ts:342`)
`setNavigationRules` blocks all navigation by default and allow-lists only
`views://*`, `http://localhost:*`, and `http://127.0.0.1:*`. This is a security
boundary: AI-generated content (preview/playground) can never redirect the main
window to an arbitrary external origin.

### 6. Shutdown (`index.ts:380`)
`before-quit` saves the final window frame, then tears down every long-lived
service (channels, cron, automation, issue-fixer, MCP, preview window, annotation
+ playground servers) and finally `closeDatabase()` so WAL is checkpointed
cleanly. Window `close` calls `Utils.quit()` (`index.ts:373`), which routes
through this handler.

## EngineManager — engine cache + control plane (`engine-manager.ts`)

`getOrCreateEngine(projectId)` (`engine-manager.ts:572`) is the single factory for
`AgentEngine` instances; they live in the module-level `engines` Map
(`engine-manager.ts:26`). On a cache miss it first calls `evictOldestIdleEngine()`
(`engine-manager.ts:222`) — when the map exceeds `ENGINE_MAP_MAX_SIZE` (50,
`engine-manager.ts:201`) it evicts the first **idle** engine (not processing, zero
running agents); if all 50 are busy the map is allowed to grow temporarily. The
factory wires the engine's huge `AgentEngineCallbacks` object (`engine-manager.ts:577`)
— every callback funnels through `broadcastToWebview` (`engine-manager.ts:272`),
and the abort hooks (`registerAgentAbort`/`unregisterAgentAbort`/`setAbortAgentsFn`,
`engine-manager.ts:756`–`engine-manager.ts:759`) connect the engine to the global
abort registry below.

### Global abort registry (`engine-manager.ts:33`–`engine-manager.ts:98`)
`runningAgentControllers` is a `Map<projectId, Map<AbortController, entry>>`.
`registerAgentController`/`unregisterAgentController` keep it current as agents
start/stop; `abortAllAgents` (used by stopGeneration) and `abortAgentByName` (stop
one agent) are the two cancellation entry points. `getRunningAgentCount` /
`getRunningAgentNames` / `getAllRunningAgents` / `getSystemActivity`
(`engine-manager.ts:104`) read this registry — `getSystemActivity` also asks each
live engine `isProcessing()` and `getQueuedAgentsSnapshot()` to report
PM-streaming + queued state, and `getStatusReport` (`engine-manager.ts:134`) turns
all of that into the markdown for the `/info` slash command and the dashboard
widget.

### Human-in-the-loop: shell approval + user questions
Two near-identical "broadcast a request, return a Promise, resolve from an RPC"
patterns live here:
- **Shell approval** (`engine-manager.ts:333` `resolveShellApproval`):
  `installShellApprovalHandler` (`engine-manager.ts:380`, called at module load
  `engine-manager.ts:428`) wires the shell tool's `ShellApprovalHandler`
  callback, which now receives `(command, agentId, agentName, projectId,
  conversationId)` as explicit parameters and uses them directly — see the
  "was a real cross-project bug" note below. It reads the project's
  `shellApprovalMode` setting via `getShellApprovalMode` (`engine-manager.ts:362`);
  `"auto"` returns `"allow"` immediately, `"ask"` broadcasts `shellApprovalRequest`
  + an OS toast and returns a Promise that the RPC `resolveShellApproval`
  (`engine-manager.ts:333`) settles. **Auto-denies after 5 minutes**
  (`SHELL_APPROVAL_TIMEOUT_MS`, `engine-manager.ts:339`, timeout fires inside
  `installShellApprovalHandler`) so a missed prompt never deadlocks an agent.
- **User questions** (`askUserQuestion`, `engine-manager.ts:473`): same shape for
  the PM/agent `request_human_input` modal — `projectId` is now a **required**
  field on the payload (previously optional with a buggy fallback, see below).
  `timeoutMs` is tunable — autonomous background agents (freelance, issue-fixer)
  pass a short window so an absent user doesn't stall the run; on timeout it
  broadcasts `userQuestionCancel` to close the stale dialog and resolves with a
  "timed out" string.

#### Fixed: shell approval / user questions could resolve against the WRONG project

Both paths used to fall back to a module-level `activeProjectId` cache —
overwritten on **every** `getOrCreateEngine()` call, which fires from many
unrelated code paths across *all* projects — to figure out whose
`shellApprovalMode`/identity to use. That made it possible for a project's
shell-approval prompt (or `askUserQuestion` payload) to resolve using a
*different* project's settings if that other project's engine had simply been
touched more recently by unrelated backend activity. Worse, `src/bun/agents/tools/shell.ts`
had a single global `let sessionAutoApproved = false;` — clicking "Always
allow" for one project's shell command silently disabled the approval prompt
for **every other project's agents too**, bypassing their own configured
`shellApprovalMode` entirely.

Fixed by threading real identity through explicitly instead of guessing from a
cache:
- `ShellApprovalHandler`'s type now requires `projectId`/`conversationId` as
  explicit trailing parameters (`shell.ts`). `sessionAutoApproved` (boolean) is
  now `sessionAutoApprovedProjects` (a `Set<string>` of project IDs), and
  `resetShellAutoApprove(projectId)` takes and uses the id (previously took
  nothing and cleared globally).
- `makeShellTool`'s `execute` reads `projectId`/`conversationId` off **hidden**
  fields (`__projectId`, `__conversationId`) stamped onto the tool-call args —
  not part of `SHELL_INPUT_SCHEMA`, so the LLM never sees them. The stamping
  happens in `agents/agent-loop.ts`'s `run_shell` tool wrapper (now
  unconditional, previously gated behind `if (workspacePath)`), which sets
  `args.__projectId = projectId; args.__conversationId = conversationId;`
  before delegating to the underlying `execute` — this is how the real
  project/conversation identity actually reaches the approval gate. A parallel
  wrapper does the same for `request_human_input` (stamps `args.__projectId`
  only), consumed by `communication.ts`'s tool to call `askUserQuestion` with
  the correct `projectId` — previously it called `askUserQuestion` with **no**
  `projectId` at all, always hitting the (now-removed) buggy fallback. (The
  PM's own `ask_user_question` tool in `pm-tools.ts` was already correctly
  scoped via `engine.ts`'s wrapper, which explicitly injects
  `projectId: this.projectId` — that path never needed fixing.)
- The module-level `activeProjectId` cache and its setter (inside
  `getOrCreateEngine`) were **removed entirely** — nothing reads it anymore.
  A new exported `isAppFocused(): boolean` getter (`engine-manager.ts:140`,
  paired with the existing `setAppFocused`) was added for callers (like the
  new plan-approval notification, see [[notifications]]) that need to check
  app focus without their own state.
- **Durability (TASK-478, `engine-manager.ts:519`–`engine-manager.ts:565`).** Both
  paths now write the pending request through to the DB via `savePendingApproval`
  before waiting (shell: `engine-manager.ts:385`; question: `engine-manager.ts:489`),
  so a reconnecting web client can re-render the still-live card via
  `getPendingApprovals` (`engine-manager.ts:530`), and a desktop restart calls
  `reconcilePendingApprovalsOnStartup()` (`engine-manager.ts:557`, wired from
  `index.ts:237`) to broadcast a clean expiry for every request orphaned by the
  previous process instead of leaving a stuck spinner.

### Channel relay + activity (in the `onStreamComplete` callback)
When a PM turn completes, the callback (`engine-manager.ts:609`) records chat
activity, and if the originating message came from a channel (`meta.source !==
"app"`) it chunks the reply and relays it back via `sendChannelMessage`, then
`linkAgentResponseToInbox` (`engine-manager.ts:299`) attaches the reply to the
latest unanswered inbox row using raw SQL. A `setTimeout(0)` block then runs the
project's idle-check: only once `!e.isProcessing() && getRunningAgentCount(projectId)===0
&& e.getQueuedAgentsSnapshot().length===0` does it proceed. It checks the
**message queue** first (`dequeueMessage(projectId, cid)` from
`src/bun/message-queue-manager.ts`, see [[message-streaming-broadcasts]]) — if
the user queued a message for this conversation while it was busy, that
message is sent now (`e.sendMessage`) and a `messageQueueUpdated` broadcast
fires, and the rest of the idle-check (session-complete toast/notification) is
skipped, since the session is continuing, not ending. Only when nothing is
queued does it fall through to the in-app `agentSessionComplete` toast and the
desktop notification — the latter fires only when the app is **not focused**
(`isAppFocused()`, `engine-manager.ts:140`, toggled by the `setAppFocused` RPC)
and `session_complete_notification` is on. `onStreamError`
(`engine-manager.ts:682`) mirrors the same queue-drain step for the error path,
since an error also ends the PM's turn.

## Shared lib utilities (`lib/*`)

| Module | What it does (and the non-obvious bit) |
|---|---|
| `git-runner.ts` | `runGit(args, cwd, signal)` — the canonical `Bun.spawn(["git", …])` wrapper used by both RPC handlers and agent git tools. Reads stdout/stderr/exit in parallel and kills the process on abort (`git-runner.ts:11`). Does **not** add token auth — callers prefix `gitAuthArgs`/`githubAuthPrefix` themselves (see [[github-token-auth|github-auth]]). |
| `secret-crypto.ts` | App-wide AES-256-GCM encryption at rest. The 32-byte master key lives in `<userData>/remote-sync.key` (mode `0o600`) — **separate from the DB** so leaking `agentdesk.db` alone exposes nothing. Blob layout `[12-IV][16-tag][ciphertext]` with `enc:v1:` prefix (`secret-crypto.ts:72`). `decryptSecret` passes plaintext through unchanged so legacy/manual values still read (`secret-crypto.ts:82`). The key file is named for Remote Sync only for historical continuity (`secret-crypto.ts:11`). |
| `encrypt-existing-secrets.ts` | One-time, idempotent startup migration that encrypts any plaintext per-project GitHub tokens (`project:%:githubToken`) and issue-source configs (`issueSource:%`) still in the `settings` table (`encrypt-existing-secrets.ts:18`). Skips already-`enc:v1:` rows; best-effort, never blocks startup. |
| `install-mode.ts` | Classifies the Windows build. Setup.exe and the portable zip are byte-identical app bundles, so the **only** distinguishing signal is location: an installed build runs from `<userData>\app\` (`install-mode.ts:24`). Non-Windows always counts as "installed" (single distribution form) so the Electrobun update path is used. |
| `path-utils.ts` | `isPathAccessible(path, retries=2)` — `statSync` with retry/backoff for cloud-synced/NAS paths (OneDrive/Dropbox) that may be momentarily unavailable at startup (`path-utils.ts:15`). Uses `statSync` (readability) not `existsSync` (placeholder may exist). |

## Annotation & preview subsystem (`annotations/*`)

This is AgentDesk's in-app "comment on the running UI" loop — a self-hosted
replacement for chrome-devtools MCP previews.

- **`server.ts`** — a `Bun.serve` on port **4748** (falls back through 4749–4752
  if taken, `annotations/server.ts:23`). It serves `/toolbar.js` (IDs baked in),
  proxies the user's dev server or `file://` page through `/preview` and injects
  the toolbar so it survives refresh/navigation (`injectToolbar`,
  `server.ts:86`), serves local assets via `/file-serve/` to dodge mixed-content
  blocking, buffers runtime console errors per-conversation via `/preview-events`
  (`server.ts:209`), and on `POST /annotations` formats the batch (plus any
  buffered console events) and feeds it straight into the engine via
  `getOrCreateEngine(projectId).sendMessage(...)` (`server.ts:411`) — creating a
  conversation if needed. Idle timeout is bumped to 120s because real dev servers
  (Laravel/Django) can be slow on a cold first request (`server.ts:283`).
- **`preview-window.ts`** — a **singleton** Electrobun `BrowserWindow`
  (`previewWin`, `preview-window.ts:42`) that loads the proxy URL. Re-running
  `/preview` reuses + navigates it (`openPreviewWindow`, `preview-window.ts:316`).
  It persists its own frame, polls `document.title` every 2s to mirror it into the
  native title (`preview-window.ts:147`), and for `projectType === "static"` runs a
  debounced `fs.watch` reload for cheap HMR (`startWatcher`, `preview-window.ts:173`).
  After every `dom-ready` it re-injects **both** the console hook (so errors flow
  back to `/preview-events`, `buildConsoleHookScript` at `preview-window.ts:99`)
  **and the toolbar itself** (`getToolbarScript`, in the `dom-ready` handler at
  `preview-window.ts:307`). This
  toolbar re-injection is the **navigation safety net**: `dom-ready` fires on every
  full page load, so the toolbar reappears no matter how the page changed —
  including direct (non-proxied) navigations such as an externally-hosted preview
  whose internal links aren't `localhost`/`file` and so are never routed back
  through the proxy. Both injected scripts are idempotent, so this is harmless on
  proxied pages that already baked the toolbar in.
- **`toolbar-script.ts`** — the self-contained shadow-DOM toolbar string. It
  intercepts local link clicks and routes them back through the proxy
  (`toolbar-script.ts:17`); the proxy path covers `localhost`/`file` navigation
  while the window-side `dom-ready` re-injection (above) covers everything else.
  The header is a **drag handle** — pointer-drag repositions the shadow host
  (switching its default bottom/right anchoring to clamped `top/left` via
  `!important`), and the position is persisted to `localStorage` (`__ad_toolbar_pos`)
  and restored on each re-injection so a dragged toolbar keeps its place across
  navigation. The host carries `-webkit-app-region:no-drag` so a drag can never be
  mistaken for a window-move.

## Gotchas / Constraints

- **Startup order is a contract, not a coincidence.** Reordering `index.ts:150`–
  `index.ts:153` (migrate → seed → env → encrypt) breaks invariants: secrets
  must encrypt after seed but before any reader, and cron must start after the DB
  exists. Anything network/disk-heavy belongs in the `dom-ready` block, not the
  synchronous path.
- **(Fixed) There is no more `activeProjectId` cache to mis-route approvals.**
  It used to be a single global set on every `getOrCreateEngine` call, and both
  the shell-approval handler and `askUserQuestion` could fall back to it —
  meaning a background project's engine activity could make an approval
  resolve against the wrong project's settings/identity. It's been removed;
  every caller now threads its own `projectId`/`conversationId` through
  explicitly (see the fix write-up above). If a future refactor reintroduces a
  "last touched project" cache as a convenience shortcut for a human-in-the-loop
  path, treat that as a regression of this exact bug class.
- **Approvals + user questions auto-resolve.** Shell approval auto-*denies* after
  5 min (`engine-manager.ts:402`); user questions auto-resolve with a timeout
  message. Nothing waits forever — but a "denied" shell or "no answer" string can
  surface as a confusing agent failure if a human just didn't notice the prompt.
  On restart, any still-pending request left over from the previous process is
  reconciled away (not just left to time out) — see the Durability bullet above.
- **The abort registry is in-memory and per-project.** App restart clears all
  running-agent state; `engines`, the controller map, and `appFocused` are module
  globals with no persistence. (Pending shell/question approvals are the one
  exception — they're durably persisted and reconciled on restart, see above.)
- **`broadcastToWebview` is fire-and-forget through an `any` ref.** Electrobun's
  exported types don't expose `webview.rpc.send.<method>` statically, so it's
  routed through `mainWindowRef: any` (`engine-manager.ts:237`,`engine-manager.ts:274`)
  and silently swallows errors when the window is gone. A typo in a method name
  fails silently.
- **The annotation server feeds the engine directly.** A `POST /annotations`
  bypasses the chat UI entirely and calls `sendMessage` (`server.ts:411`); it is
  CORS-open to `*` including `null` origins (`server.ts:30`) because it must accept
  `file://` pages — keep it bound to localhost only.
- **Win32 titlebar icon uses raw FFI.** `setWindowTitlebarIcon` (`index.ts:419`)
  `dlopen`s `user32.dll`; it's wrapped in try/catch and purely cosmetic, but it
  depends on `FindWindowW` matching the window title exactly ("AgentDesk").
- **The `workflow:%` settings cleanup is permanent.** `index.ts:244` deletes
  orphaned settings from the removed WorkflowEngine on every boot — don't reuse
  that key prefix.

## Related
- [[agent-engine]]
- [[database]]
- [[channels]]
- [[rpc-layer]]
- [[providers]]
- [[github-token-auth]]
- [[message-streaming-broadcasts]] — the queued-message drain inside `onStreamComplete`/`onStreamError`
- [[notifications]] — `isAppFocused()` consumer for the plan-approval notification

## Global error & AI-SDK-warning logging (`db/error-logger.ts`)
`logError()` appends structured entries to `<userData>/logs/error.log`
(auto-rotated at 5 MB, 2 old files kept) and mirrors non-fatal errors into the
audit log for in-app visibility. `initGlobalErrorHandlers()` binds
`uncaughtException` (logs + `process.exit(1)`) and `unhandledRejection` (logs,
does not exit; suppresses the benign "Controller is already closed" abort race).
`installAiSdkWarningHandler(isDevMode)` sets `globalThis.AI_SDK_LOG_WARNINGS` to a
custom logger so AI SDK warnings are formatted identically to the SDK default
(`AI SDK Warning (provider / model): …`) but routed by channel: **dev → console**,
**prod/canary → `error.log` as `[WARNING] …`**. Installing our own function also
suppresses the SDK's one-time "To turn off warning logging…" banner.

## Open questions
- `db/maintenance.ts` (`maybeRunStartupMaintenance`) is invoked here but its
  internals weren't opened — document what maintenance actually runs.
- `windows-registry.ts` (`registerWindowsUninstaller`) is called at startup but
  not studied; pairs with `install-mode.ts` and deserves a short note on the
  uninstaller entry it writes.
- The Playground static server (`playground/server.ts`) and orchestrator are
  referenced from `index.ts` but documented elsewhere; confirm a [[playground]]
  page exists and cross-link it.
