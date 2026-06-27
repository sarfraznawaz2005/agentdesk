---
title: Frontend Components Map
type: subsystem
status: verified
verified_at: 2026-06-27
sources:
  - src/mainview/components/layout/app-shell.tsx
  - src/mainview/components/layout/sidebar.tsx
  - src/mainview/pages/project.tsx
  - src/mainview/components/chat/chat-layout.tsx
  - src/mainview/components/activity/context-panel.tsx
  - src/mainview/components/git/git-tab.tsx
  - src/mainview/components/issues/issue-tracker-tab.tsx
  - src/mainview/components/ui/button.tsx
  - src/mainview/components/chat/message-bubble.tsx
tags: [frontend, components]
---

# Frontend Components Map

A navigational map of `src/mainview/components/*`. The renderer's UI is organised
as **two persistent chromes wrapping swappable content**: the app-level chrome
(`layout/`) hosts the sidebar + top-nav + global dialogs around a router
`<Outlet />`, and the project-level chrome (`pages/project.tsx`) is a flat
tab-switcher that mounts exactly one feature subtree at a time. Almost every
folder under `components/` maps 1:1 to one of those project tabs (`chat`,
`kanban`, `git`, `issues`, `deploy`, `remote-sync`, `notes`), or to a
sidebar-route page (`freelance`, `scheduler`, `analytics`, `inbox`). The thing
grep can't tell you: these folders are **not** independent islands — they all
sit on shared primitives in `ui/`, shared Zustand stores, and a `window`
CustomEvent bus, so the "tree" is really a thin presentational layer over the
state layer described in [[frontend-architecture]].

## How the tree is wired

The mount chain is `AppShell → <Outlet /> → page → feature-tab → components`:

1. **App chrome.** `app-shell.tsx:320-391` renders `Sidebar` + `TopNav` +
   `ErrorBoundary` around the router `<Outlet />`, plus app-lifetime singletons
   that live *outside* the page tree: `CommandPalette`, `StartupHealthDialog`,
   `UserQuestionDialog`, `WhatsNewDialog`, the `Toaster`, and two
   dashboard-only floating widgets (`PmChatWidget`, `CustomAgentChatLauncher`,
   `app-shell.tsx:383-384`). `AlwaysMountedInbox` (`app-shell.tsx:375`) is the
   freelance Auto-Earn background engine — mounted here so it survives every
   navigation (see [[freelance-autoearn]]).
2. **Sidebar nav** (`layout/sidebar.tsx:57-67`) is a static `BASE_NAV_ITEMS`
   list; `Freelance` is conditionally appended only when the feature flag is on
   (`sidebar.tsx:345`), and plugin-contributed items are spliced in before
   Settings (`sidebar.tsx:342-346`). Active state is derived from the router
   pathname, not stored (`sidebar.tsx:349-351`).
3. **Project chrome.** `pages/project.tsx` is the hub for all per-project
   feature folders. `activeTab` is plain local state (`project.tsx:33`), the tab
   bar is a hand-rolled row of buttons (`project.tsx:182-297`), and the content
   region is a switch that mounts one feature root at a time
   (`project.tsx:351-382`): `ChatLayout`, `KanbanBoard`, `GitTab`,
   `IssueTrackerTab`, `DeployTab`, `RemoteSyncTab`, `NotesTab`,
   `ProjectSettingsTab`. Plugin tabs use a `plugin:<name>:<id>` tab id
   (`project.tsx:283-297`).

## Folder-by-folder map

| Folder | Root component (entry) | What it is |
|---|---|---|
| `layout/` | `app-shell.tsx` | App chrome: `sidebar.tsx`, `topnav.tsx`, `project-switcher.tsx`, `project-branch-badge.tsx` (live branch indicator next to the project title, `app-shell.tsx:343`) |
| `chat/` | `chat-layout.tsx` | The Chat tab: 3-pane layout (conv sidebar + message area + activity pane). See "Chat subtree" below. |
| `activity/` | `context-panel.tsx` | The right-hand activity pane inside Chat. Two inner tabs `files`/`docs` (`context-panel.tsx:8,21-24`) → `files-tab.tsx`, `docs-tab.tsx`. |
| `kanban/` | `kanban-board.tsx` | Kanban tab: `kanban-column.tsx`, `kanban-card.tsx`, `kanban-filters.tsx`, `kanban-stats-bar.tsx`. `task-detail-modal.tsx` is mounted at the page level (`project.tsx:385`), not inside the board. |
| `git/` | `git-tab.tsx` | Git tab with 3 sub-tabs `overview`/`pull-requests`/`conflicts` (`git-tab.tsx:12-20`) → `branch-list`, `commit-log`, `diff-viewer`, `staged-files`, `pull-requests`, `conflict-resolver`, `branch-strategy`. |
| `issues/` | `issue-tracker-tab.tsx` | Issue Tracker tab: 2 sub-views `issues`/`auto-fixer` (`issue-tracker-tab.tsx:7-12`). `issues.tsx` is the multi-source list; the auto-fixer view embeds the `issue-fixer/` subtree. |
| `issue-fixer/` | `issue-fixer-tab.tsx` | Auto Issues Fixer — rendered *inside* the Issue Tracker tab (`issue-tracker-tab.tsx:3,52`), not a top-level tab. Plus `issue-fixer-settings.tsx`. |
| `deploy/` | `deploy-tab.tsx` | Deploy tab (single component). |
| `remote-sync/` | `remote-sync-tab.tsx` | Remote tab: `connection-form.tsx`, `remote-tree.tsx` (lazy SFTP/FTP tree), `push-diff-dialog.tsx`. |
| `notes/` | `notes-tab.tsx` | Docs tab — full notes list + markdown preview; `note-editor.tsx` for editing. |
| `project-settings/` | `project-settings-tab.tsx` | Per-project Settings tab. |
| `dashboard/` | `project-card.tsx` | Dashboard route bits: `project-card.tsx` + the floating `pm-chat-widget.tsx` / `custom-agent-chat-widget.tsx` / `custom-agent-chat-launcher.tsx` (mounted from `app-shell.tsx`). |
| `freelance/` | (route `pages/freelance.tsx`) | Auto-Earn UI: `listings-tab`, `inbox-tab`, `settings-tab`, `expert-dashboard`, `auto-earn-settings`, plus `always-mounted-inbox.tsx` (the persistent engine host). See [[freelance-autoearn]]. |
| `scheduler/` | (route `pages/scheduler.tsx`) | Cron + automation forms: `cron-job-form`, `schedule-builder`, `automation-rule-form/-card`, `automation-templates`. See [[scheduler-automation]]. |
| `analytics/` | `charts.tsx` | Charts for the Analytics route. |
| `inbox/` | `inbox-rules-editor.tsx` | Inbox-rules editor for the Inbox route. |
| `modals/` | — | App-level dialogs mounted by `app-shell.tsx`: `startup-health-dialog`, `user-question-dialog`, `whats-new-dialog`, `new-project-modal`. |
| `ui/` | — | ~40 design-system primitives. See "The `ui/` primitive layer". |
| `command-palette.tsx` | (root file) | The Ctrl/Cmd-K palette, mounted once in `app-shell.tsx:356`. |

## Chat subtree (the densest folder)

`chat/chat-layout.tsx` owns the 3-pane Chat experience and is the most stateful
view in the app. Left = `ConversationSidebar` (`chat-layout.tsx:488`), centre =
`MessageList` + `ChatInput` + `ModelSelector` (`chat-layout.tsx:686-743`), right
= `ContextPanel` from `activity/` (`chat-layout.tsx:780`). It pulls live data
from `useChatStore` and a separate `useMessageQueueStore` (`chat-layout.tsx:100-130`),
and coordinates focus-mode with the app sidebar via `window` CustomEvents
(`agentdesk:focus-mode-enter/-exit`, `chat-layout.tsx:57-61`) rather than props —
the same event-bus pattern documented in [[frontend-architecture]].

Message rendering is a chain: `MessageList → message-bubble.tsx →
message-parts.tsx`. `message-bubble.tsx:15` delegates structured tool/thinking
parts to `MessageParts`, which dispatches to `tool-call-card.tsx`,
`code-block.tsx`, `plan-diff.tsx`, etc. `message-parts.tsx:132` exports the
shared `AGENT_BADGE_COLORS` map that `project.tsx:20,305` reuses for the running-
agent badge — a small but load-bearing cross-folder dependency. Shell approval
prompts surface as `ShellApprovalCard` stacked above the input
(`chat-layout.tsx:708-719`).

## The `ui/` primitive layer

Everything renders on `ui/` — Radix-wrapped, Tailwind-styled primitives
(`button`, `dialog`, `select`, `tabs`, `popover`, `tooltip`, `toast`, `card`,
`input`, `switch`, …). They follow the shadcn convention: a `cva` variant table
defining `variant`/`size` classes (e.g. `ui/button.tsx:8-30`) composed via
`cn()` from `@/lib/utils`. Notable non-trivial primitives: `mermaid-diagram.tsx`
(diagram rendering used by message bubbles), `unified-diff.tsx` (git/playground
diffs), `error-boundary.tsx` (wraps the `<Outlet />` in `app-shell.tsx:327`),
`connection-status.tsx` (RPC-bridge health banner), `unread-dot.tsx` (the red
attention dot used across tabs and the sidebar). Feature folders should reach
for a `ui/` primitive before hand-rolling chrome; the chat header buttons in
`chat-layout.tsx` are a deliberate exception (icon-only toolbar styling).

## Gotchas / Constraints

- **Tabs are local state, not routes.** `pages/project.tsx` keeps `activeTab` in
  `useState` (`project.tsx:33`); switching project tabs does **not** change the
  URL (only `/project/$projectId` is routed). Deep-linking to a specific tab
  isn't possible; cross-component tab switches go through the
  `agentdesk:switch-tab` CustomEvent (`project.tsx:76-83`).
- **`issue-fixer/` is nested, not top-level.** Despite being its own folder, the
  Auto Issues Fixer renders only *inside* the Issue Tracker tab
  (`issue-tracker-tab.tsx:52`). There is no standalone "Issue Fixer" project tab.
- **`task-detail-modal` lives at the page, not in `kanban/`'s tree.** It's
  mounted by `project.tsx:385` so it can be opened from anywhere via the kanban
  store's `selectedTaskId`, not just from a card click.
- **Some "always-on" components live outside the page tree.** `AlwaysMountedInbox`,
  `CommandPalette`, and the app-level modals are children of `app-shell.tsx`, so
  they persist across navigation and are unaffected by the page `<Outlet />`.
- **Sidebar nav order is partly dynamic.** Plugin items and the conditional
  Freelance entry are spliced in at render time (`sidebar.tsx:342-346`); the
  static `BASE_NAV_ITEMS` list is not the final order.
- **Folders ≠ a barrel.** There is no `ui/index.ts`; components are imported by
  explicit path (`@/components/ui/button`). Don't assume a re-export barrel.

## Related

- [[frontend-architecture]] — the shell/router/store/event-bus mental model this map sits on top of
- [[rpc-layer]] — how these components call the backend
- [[freelance-autoearn]] — the `freelance/` + `always-mounted-inbox` subtree
- [[scheduler-automation]] — the `scheduler/` forms
- [[issue-fixer]] — the backend behind the `issue-fixer/` tab
- [[issue-sources]] — the backend behind the `issues/` multi-source list
- [[remote-sync]] — the backend behind the `remote-sync/` tab
- [[playground]] — the Playground page (uses `ui/unified-diff` and its own route)

## Open questions

- The `analytics/`, `inbox/`, `dashboard/`, and `project-settings/` folders are
  mapped by their entry components but their internal structure was not deeply
  read; if those pages grow they may warrant their own sub-pages.
- `command-palette.tsx` sits at the `components/` root rather than in `layout/` or
  `ui/`; whether that placement is intentional vs. legacy is unverified.
