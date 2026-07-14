# Quick Chat — Implementation Plan

## Context

Today, to use AgentDesk's agents against an existing folder, a user must first create a full
AgentDesk project (Dashboard → New Project). That's fine for long-lived work but heavyweight for
"I just want to point the PM + sub-agents at this folder right now." **Quick Chat** adds a
project-less, OS-native entry: right-click a **folder** (or empty space inside a folder window) in
the file explorer → **"Open in AgentDesk"** → a new, lightweight chat window opens scoped to that
folder, reusing the full PM/sub-agent engine but **without** Kanban, review cycle, Git/Issues/
Remote/Deploy tabs, or project creation. Conversations and tool calls persist as normal; the folder
becomes the agent workspace. A later **"Create Project"** click promotes the quick-chat project into
a normal one in place (no file copy).

**Confirmed product decisions (from the user):**
1. **Single-instance activation.** If AgentDesk is running, the launch signals the running instance to open a new Quick Chat window *in-process*; if not, a trimmed fresh process opens straight to it. No single-instance lock exists today — build it.
2. **OS scope v1: Windows + macOS** (Linux deferred). Windows = HKCU registry entries. macOS = Finder Services/Quick Action bridged into the app via Electrobun `urlSchemes` + `open-url`. Menu entry shows the AgentDesk icon.
3. **Folders + folder-background only.** No per-file entry, no Desktop-background entry.
4. **Repeat right-click on an already-quick-chatted folder** → reuse that project row (match by `workspacePath`), open a **new conversation**; prior conversations stay in the sidebar.
5. **No persistent tray/helper.** Perceived speed comes from a trimmed cold-start path.
6. **Quick-chat projects hidden everywhere** until promoted — not on Dashboard, and **not** returned by PM `list_projects`/`search_projects`.
7. **"Allow Quick Chat" setting, ON by default.** Toggling off unregisters OS entries; on re-registers. Auto-registers for existing users on upgrade.

## UI (Quick Chat window — otherwise identical to main project chat)
- **Omit:** main app Sidebar, TopNav project switcher, dashboard chat widgets, Focus Mode toggle, and the Kanban / Git / Issue Tracker / Remote / Deploy tabs.
- **Show tabs:** Chat, Docs, Settings — where **Settings shows only the AI sub-tabs** (Providers/Models/Streaming/MCP/Constitution/EnvVars/Debug), not General.
- **Keep:** conversation sidebar, right-side Files/Docs pane, current-working-agent name indicator (top-right row), model/mode selector, shell input mode, token graph/context indicator.
- **"Create Project" button** sits top-right where the project switcher normally is (mirrors Playground's header button) → flips the hidden flag, no file copy.

---

## Subsystem 1 — DB / migration (do first)

- **New `src/bun/db/migrations/v57_quick-chat-projects.ts`** — mirror `v55_inbox-favorites.ts`: guarded `PRAGMA table_info(projects)` then `ALTER TABLE projects ADD COLUMN is_quick_chat INTEGER NOT NULL DEFAULT 0`. Export `name` + `run()`.
- **Register in `src/bun/db/migrate.ts`**: add `import * as v57`, append `{ version: 57, name: v57.name, run: v57.run }` to the `migrations` array, and add a defensive `v57.run()` call in `ensureRuntimeSchema()` (the same idempotent pattern used for v55 at migrate.ts:330).
- **`src/bun/db/schema.ts`** (projects, ~62): add `isQuickChat: integer("is_quick_chat").notNull().default(0)`.
- Name uniqueness: the v51 `COLLATE NOCASE` unique index on `projects.name` still applies. Derive a name from `basename(workspacePath)` and de-dupe with a numeric suffix on unique-violation — `createProjectHandler` already does this.

## Subsystem 2 — RPC handlers + project-row strategy (`src/bun/rpc/projects.ts` + contracts)

- **`getProjectsList` (:40)** — filter `WHERE is_quick_chat = 0`. This single choke point feeds the Dashboard **and** PM `list_projects`/`search_projects` (pm-tools.ts:1078/1097), satisfying decision 6 in all three at once. Grep all `getProjectsList` callers; if any internal caller needs hidden rows, add an `includeQuickChat=false` param.
- **`createProjectHandler` (:91)** — add optional `isQuickChat?: boolean` to `CreateProjectParams`, pass into the insert. Reuse its existing **external-path adoption** (junction/symlink for out-of-workspace paths, mkdir-only-if-missing) as-is; skip `githubUrl`.
- **New `openQuickChatForPath({ workspacePath })`** — normalize path → `SELECT id FROM projects WHERE workspace_path = ? AND is_quick_chat = 1`; reuse if found (decision 4), else `createProjectHandler({ isQuickChat: true, … })`. Then create a **new conversation** (reuse existing `createConversation`). Return `{ projectId, conversationId }`. Shared by both the in-process open path and cold-start.
- **New `promoteQuickChatProject({ projectId })`** — set `is_quick_chat = 0`, broadcast `projectsUpdated`. No file copy.
- Wire all new handlers into a projects rpc-group + `src/shared/rpc/*` contract + `src/bun/remote/rpc-handlers.ts`, and add typed callers in `src/mainview/lib/rpc.ts`.

## Subsystem 3 — Engine / tools / prompts gating (thread one `quickChat` boolean, derived per-turn)

Derive `quickChat` **per turn from the projects row the engine already selects** (engine.ts:255) — do **not** bake it into the engine-map key. This keeps the map keyed purely by `projectId` and makes promotion re-enable Kanban cleanly on the next turn.

- **`src/bun/agents/engine.ts`**
  - `_runPMProcessing` select (:255): add `isQuickChat`; `const quickChat = projectRow?.isQuickChat === 1`.
  - Pass `quickChat` to `getPMSystemPrompt(...)` (:274) and into `createPMTools({...})` (:398).
  - **Guard the `onAgentDone` empty-board bug (:441–516):** wrap the `kanbanTasks` `[Next Action]` computation in `if (!quickChat && !agentFailed)`. On `[]`, `allTasks.every(t => t.column === "done")` (:509) is `true` → would wrongly emit "ALL DONE"; the guard prevents it. The `[Agent Report]` restart (:555) still runs.
  - Conditionally drop the hardcoded `list_tasks`/`get_task` PM tools (:563–564) when `quickChat`.
- **`src/bun/agents/prompts.ts`**
  - `getPMSystemPrompt` (:922): add `quickChat?: boolean`. Add a `QUICK_CHAT_SECTION` const (mirror `PLAN_MODE_SECTION` :887) that replaces the pervasive Kanban role guidance (:281–282 and the plan→approve→execute flow); force-skip `FEATURE_BRANCH_SECTION` when quick-chat. Don't combine plan-mode + quick-chat sections.
  - Leave `buildProjectContextSection` (:579) untouched — it already emits the required `## Project Context` / **Workspace path** block because the quick-chat row has a real `workspacePath`.
  - Sub-agent prompt: `AGENT_COMMUNICATION_PROTOCOL`'s Kanban lifecycle is already gated on "if your task context includes a kanban task ID", and quick-chat dispatches pass no `kanbanTaskId`, so it self-neutralizes. Optionally route quick-chat sub-agents through the existing kanban-less branch (:1184) for cleanliness — verify it truly no-ops first.
- **`src/bun/agents/tools/pm-tools.ts`**
  - `PMToolsDeps` (:39): add `quickChat?: boolean`.
  - When `quickChat`, delete these keys from the returned tool object (mirror `delete tools.verify_implementation` in agent-loop.ts:1037): `create_tasks_from_plan`, `get_next_task`, `get_kanban_stats`, `request_plan_approval`, `set_feature_branch`, `clear_feature_branch`, `verify_project`. Keep `run_agent`/`run_agents_parallel`, scheduler, file/doc/skill tools.
  - **Sub-agent dispatch** (`run_agent` agentOpts ~:587 and parallel path ~:915): pass `excludeTools: deps.quickChat ? ["create_task","update_task","move_task","delete_task","verify_implementation"] : undefined` — reuses the existing glob-capable exclusion (agent-loop.ts:1024). Review cycle auto-bypasses because it only triggers on `move_task`→review, now excluded — no guard needed in `review-cycle.ts`.

## Subsystem 4 — Second window + broadcast routing (highest risk — prototype before UI)

**Decision:** a new **rpc-bridged `BrowserWindow` per quick-chat**, loading `views://mainview/index.html#/quick-chat/<projectId>?c=<conversationId>`, reusing the same `rpc` object from `rpc-registration.ts` (handlers are stateless).

- **New `src/bun/quick-chat/window.ts`** — `openQuickChatWindow(projectId, conversationId)`: if a window for `projectId` exists in a registry, `focus()` + send a `navigateTo` message; else `new BrowserWindow({ title, url, frame, rpc })`, attach load/save window-state listeners (reuse the pattern from index.ts:236/`loadWindowState` and `annotations/preview-window.ts`), register in the broadcast registry, and on `close` unregister + evict idle engine. Build the URL from `getMainViewUrl()` + the quick-chat hash (Vite URL in dev).
- **Broadcast routing — `src/bun/engine-manager.ts` (the core fix).** `broadcastToWebview` (:287) currently sends only to `mainWindowRef`. Add a **project→window registry**: `registerProjectWindow(projectId, win)` / `unregisterProjectWindow`, plus `broadcastToProject(projectId, method, payload)` resolving `projectWindows.get(projectId) ?? mainWindowRef` (and keep the `remoteBroadcastSinks` fan-out). **Switch the per-project engine callbacks in `getOrCreateEngine` (:654+) from `broadcastToWebview` to `broadcastToProject(projectId, …)`** (`projectId` is already in that closure), including the shell-approval / user-question broadcasts so approval cards render in the owning window. Leave truly-global broadcasts (`showToast`, `settingsChanged`, `providersChanged`, `projectsUpdated`) fanning out to `[mainWindowRef, ...projectWindows.values()]` (deduped) — harmless because the frontend already filters by `projectId`/`conversationId`.
- **Risk:** whether one `rpc` object can attach to multiple `BrowserWindow`s (each getting its own `webview.rpc.send`, inbound requests dispatching to shared handlers). **Prototype this first.** Fallback: a second `defineRPC` with the same handler map.

## Subsystem 5 — Frontend route + reduced-chrome UI (`src/mainview`)

- **`router.tsx`** — add `quickChatRoute` at `/quick-chat/$projectId` → new `QuickChatPage`.
- **`components/layout/app-shell.tsx`** — add an early return for `location.pathname.startsWith("/quick-chat")` rendering a bare `<Outlet/>` + `<Toaster/>` + the dialogs chat needs (`UserQuestionDialog`, `CrossProjectApprovalToast`) but **no Sidebar, no TopNav, no dashboard widgets**. Exact precedent: the `/onboarding` early return (:307–314).
- **New `src/mainview/pages/quick-chat.tsx`** — a trimmed clone of `pages/project.tsx`:
  - Local tab bar: **Chat / Docs / Settings** only (drop Kanban/Git/Issues/Remote/Deploy + count pills).
  - Keep the current-working-agent indicator (project.tsx:322–340, `activeInlineAgent`).
  - **Chat** → reuse `<ChatLayout projectId={projectId} />` unchanged (conversation sidebar, ContextPanel Files/Docs, ModelSelector, ChatInput shell mode, ContextIndicator all come free). Add a `hideFocusToggle` prop to `ChatLayout` to suppress the Focus Mode icon (chat-layout.tsx:663–680).
  - **Docs** → reuse `<NotesTab projectId={projectId} />`.
  - **Settings** → AI-only. Add an optional `only?: ("ai"|"general"|…)[]` prop to `SettingsPage` (settings.tsx:50) and render just the AI `TabsContent` (:71–81). Don't show General.
  - **"Create Project" button** top-right → confirm dialog → `rpc.promoteQuickChatProject({ projectId })` → on success close the quick-chat window (or navigate main window to `/project/<projectId>`) + toast. Mirror Playground's confirm flow (playground.tsx:571/636) but call the flag-flip RPC, **not** `createProjectFromPlayground` (no copy).

## Subsystem 6 — OS integration + single-instance + trimmed startup (`src/bun/index.ts` + new modules)

- **Single-instance lock — new `src/bun/single-instance.ts`**, acquired at the very top of index.ts (before heavy init). On Windows: exclusive lockfile in `Utils.paths.userData` + a small IPC channel (named pipe / loopback control socket). Acquire-fail ⇒ already running: connect, send `{ action:"open-quick-chat", path }`, then `Utils.quit()` immediately without finishing boot. The **running instance** listens and on receipt calls `openQuickChatForPath` → `openQuickChatWindow` + focus (satisfies decision 1).
- **Carrying the folder into a cold start (RISK — no `process.argv[]` precedent).** Windows registry `command` = `"<launcher.exe>" "%V"`. Early in index.ts, read `process.argv` for the path. **If the launcher swallows args, fall back to a handoff file** (`%LOCALAPPDATA%\…\quick-chat-request.json`) written by a tiny wrapper, read+cleared on boot. **Prototype arg propagation early.** Resolve `launcher.exe` via the existing `getLauncherPath()` in `system/login-item.ts:27` (export/reuse).
- **Trimmed cold start (decision 5).** When launched for quick-chat, create the window before background services and **defer `initCronScheduler`/`initAutomationEngine`/`startIssueFixerPolling` (index.ts:218–223)** into a post-window `setTimeout` gated on a `launchedForQuickChat` flag. Keep `runMigrations`/`seedDatabase` synchronous (correctness). The existing dom-ready deferral of plugins/skills/channels/MCP (index.ts:293+) already helps.
- **Windows context menu — new `src/bun/quick-chat/os-integration.ts`** (model on `windows-registry.ts`: hidden-PowerShell spawn + version-cached fast path):
  - `HKCU\Software\Classes\Directory\shell\AgentDeskQuickChat` → `(Default)="Open in AgentDesk"`, `Icon=<app.ico>`; `command\(Default)="<launcher.exe>" "%V"`.
  - `HKCU\Software\Classes\Directory\Background\shell\AgentDeskQuickChat\command` → `"<launcher.exe>" "%V"`.
  - **Do not** register under `*` (files) or `DesktopBackground` (decision 3). Provide `unregister…()` (`reg delete`, best-effort) + cache clear.
- **macOS** — add `urlSchemes` (e.g. `agentdesk://`) to `electrobun.config.ts`; handle Electrobun's `open-url` event → parse `agentdesk://quick-chat?path=…` → same in-process flow (macOS auto-delivers to the running app, giving single-instance activation for free). Finder mechanism: a **Services / Quick Action** (Automator "Service" receiving folders) that runs `open "agentdesk://quick-chat?path=$folder"`; install into `~/Library/Services` on first run when enabled, remove when disabled. Confirm the exact `open-url` API via the electrobun skill before wiring.

## Subsystem 7 — Settings + enablement (`allow_quick_chat`, ON by default)

- KV setting `allow_quick_chat` (category `general`, default true, fail-open). Toggle in `pages/settings/general.tsx`.
- Reuse the `onSettingChange` pattern (index.ts:193–202): on `true` register OS menu (Win + mac), on `false` unregister both.
- **Auto-register on upgrade:** at startup near `registerWindowsUninstaller()` (index.ts:176), read `allow_quick_chat` (default true) and register if enabled, using the same version-cached fast path so normal launches don't spawn PowerShell. Because default is true and existing installs have no row, first upgraded launch registers automatically. Gate behind stable-channel/platform checks (skip dev builds), like `registerWindowsUninstaller`.

---

## Ordering & dependencies
1. DB migration v57 + schema column.
2. RPC: `getProjectsList` filter, `createProjectHandler` flag, `openQuickChatForPath`, `promoteQuickChatProject` (+ contracts + registration + rpc.ts callers).
3. Engine/tools/prompts `quickChat` gating — testable in the main window by temporarily flagging a project.
4. **Prototype:** rpc-per-window + `broadcastToProject` routing + second BrowserWindow (before UI).
5. Frontend route + `QuickChatPage` + app-shell bypass + AI-only settings + Create Project button.
6. Single-instance + trimmed cold start + arg/deep-link handoff (**prototype arg propagation early, parallel with 4**).
7. OS context-menu registration + `allow_quick_chat` setting + upgrade auto-register.

## Risks
- **Shared `rpc` across windows** — unverified; prototype. Fallback: second `defineRPC`.
- **Arg/deep-link propagation to the bun process** — no precedent; `%V` may not reach `process.argv`. Fallback: handoff file.
- **Broadcast leakage** — route shell-approval/user-question project-scoped so cards don't render in the wrong window (global events are harmless via frontend filtering).
- **Name uniqueness** (v51 index) — handle unique-violation with a numeric suffix.
- **Promotion mid-session** — deriving `quickChat` per-turn re-enables Kanban cleanly next turn; confirm no cached engine state pins the old flag.
- **macOS Finder** has no true folder-background context menu; Services/Quick Action is the pragmatic v1 — set expectations.

## Verification (end-to-end)
1. Cold start via folder context menu → trimmed startup; Quick Chat window appears before cron/channels/MCP; PM answers using the folder as workspace (confirm the `## Project Context` / Workspace-path block in the system prompt via a temporary log or DB inspection).
2. App already running → context menu activates the running instance and opens a new in-process window.
3. Right-click same folder again → same project row, **new** conversation; prior conversations still listed.
4. Dispatch a sub-agent from quick chat → no Kanban tools on PM or sub-agent, no review cycle, no spurious "[Next Action] ALL DONE", streaming reaches only the owning window.
5. Quick-chat project absent from Dashboard and from PM `list_projects`/`search_projects`.
6. "Create Project" → flag flips, project shows in Dashboard/switcher, files untouched, Kanban re-enabled next turn.
7. Toggle `allow_quick_chat` off → OS entries removed; on → re-added. Simulate upgrade (no setting row) → auto-registered.
8. Main + quick-chat windows streaming different projects simultaneously → no cross-talk.

Run via `.\run.ps1` (Vite + Electrobun) per the visual-testing note; the user restarts the app themselves to test. Run `bun run typecheck` / `bun run lint` once after all tasks are complete (not mid-build).

## Docs to update as it lands
`docs/quick-chat-plan.md` (this file), `docs/workflow.md` (new window/mode + broadcast routing), and `CLAUDE.md` (Quick Chat mode, `is_quick_chat` column, migration v57).
