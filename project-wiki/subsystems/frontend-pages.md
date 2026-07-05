---
title: Frontend Pages & Routing
type: subsystem
status: verified
verified_at: 2026-07-05
sources:
  - src/mainview/router.tsx
  - src/mainview/components/layout/app-shell.tsx
  - src/mainview/components/layout/sidebar.tsx
  - src/mainview/pages/project.tsx
  - src/mainview/pages/settings.tsx
  - src/mainview/pages/dashboard.tsx
  - src/mainview/pages/onboarding.tsx
  - src/mainview/pages/inbox.tsx
  - src/mainview/stores/chat-store.ts
tags: [frontend, routing]
---

# Frontend Pages & Routing

**The React frontend is a single-page app rendered inside Electrobun's webview, navigated with TanStack Router over a *hash* history.** A flat route tree mounts one page component per top-level path under a shared `AppShell` chrome (sidebar + top-nav + global dialogs). Hash routing is the load-bearing decision: it lets the webview navigate with URLs like `app://index.html#/settings` without needing an HTTP server for client-side routes (`router.tsx:23`). Most "navigation" inside a feature is *not* routing at all — it is local tab state (Settings, Project) — so the route map is small and the real complexity lives inside a handful of pages.

## Route map

All routes are children of one root route whose component is the `AppShell` layout wrapper (`router.tsx:28-30`). The tree is assembled in `router.tsx:116-132`:

| Path | Component | Page file | Notes |
|---|---|---|---|
| `/` | `DashboardPage` | `pages/dashboard.tsx` | project list + "new project" |
| `/onboarding` | `OnboardingPage` | `pages/onboarding.tsx` | first-run provider wizard; rendered chrome-less |
| `/project/$projectId` | `ProjectPage` | `pages/project.tsx` | the workhorse — chat/kanban/git/etc. tabs |
| `/inbox` | `InboxPage` | `pages/inbox.tsx` | cross-channel message inbox; master-detail split — checkbox-selectable message list (left) + `MessageDetailPane` preview (right, `inbox.tsx:131`), mirroring the Docs tab's layout; the pane selection is *derived* from the filtered list by id, so deletes/archives/filter changes fall back to auto-selecting the first message (auto-select never marks read; only a row click does, and a ref suppresses re-select after the mobile back button). Agent responses render as sanitized markdown (per-file `MD_COMPONENTS` map, the same idiom as notes-tab) |
| `/agents` | `AgentsPage` | `pages/agents.tsx` | agent roster + custom-agent editor |
| `/skills` | `SkillsPage` | `pages/skills.tsx` | skills browser |
| `/prompts` | `PromptsPage` | `pages/prompts.tsx` | reusable prompt library |
| `/scheduler` | `SchedulerPage` | `pages/scheduler.tsx` | cron jobs + automation rules |
| `/council` | `CouncilPage` | `pages/council.tsx` | multi-model deliberation page |
| `/analytics` | `AnalyticsPage` | `pages/analytics.tsx` | usage/cost stats |
| `/freelance` | `FreelancePage` | `pages/freelance.tsx` | Auto-Earn (feature-flagged) |
| `/playground` | `PlaygroundPage` | `pages/playground.tsx` | artifact builder |
| `/settings` | `SettingsPage` | `pages/settings.tsx` | tabbed settings hub |
| `/plugin/db-viewer` | `DbViewerPage` | `pages/plugin-db-viewer.tsx` | built-in DB viewer plugin |

There is **no** `/plugins` route in the tree — `PluginsPage` is imported *into* the Settings page as its "Plugins" tab (`settings.tsx:20,106-108`), even though `app-shell.tsx:93` still maps `/plugins` to a title string. The route param `$projectId` is the only dynamic segment; every other page is parameterless and reads its own data via RPC.

## How navigation actually works

### Three layers of "where am I"

1. **The router** decides which page component fills the `<Outlet />` (`app-shell.tsx:328`).
2. **The sidebar** (`sidebar.tsx`) is the primary nav surface. Its items are a static `BASE_NAV_ITEMS` array (`sidebar.tsx:49-60`) merged at render time with plugin-contributed items and the conditional Freelance item (`sidebar.tsx:328-333`). Active highlighting is derived from `useRouterState`'s pathname via a `startsWith` match, with `/` special-cased so it doesn't match everything (`sidebar.tsx:335-337`).
3. **In-page tab state** carries the user *within* a page. Neither the Project page nor the Settings page encodes its active tab in the URL — both use `useState`. So a deep-link to a specific project tab or settings sub-tab is not possible; refreshing always returns to the default tab.

### The AppShell orchestrates everything around the page

`AppShellContent` (`app-shell.tsx:105`) is where the cross-cutting frontend behavior lives, independent of which page is showing:

- **First-launch redirect.** On every navigation it calls `rpc.isFirstLaunch()` and, if no providers exist, redirects to `/onboarding` (`app-shell.tsx:217-231`). The onboarding route is the one page rendered *without* shell chrome — `app-shell.tsx:283-290` returns just the `<Outlet />` + `<Toaster />` early.
- **Dynamic page title.** A pathname→title map (`app-shell.tsx:81-95`) feeds the top-nav, but when on a `/project/$projectId` route it instead fetches the project and shows its *name* (`app-shell.tsx:206-211`). The title effect also drives per-page header extras: a random motivational phrase on the Dashboard (gated by an appearance setting), and a folder icon that opens the workspace (Dashboard) or playground temp dir (`app-shell.tsx:155-214`).
- **Sidebar collapse** is persisted to the `appearance` settings category and additionally toggled transiently by `focus-mode-enter/exit` window events without overwriting the saved default (`app-shell.tsx:128-152`).
- **Global singletons** mounted once here regardless of page: `CommandPalette`, `StartupHealthDialog`, `UserQuestionDialog`, `WhatsNewDialog`, the always-mounted Auto-Earn engine (`AlwaysMountedInbox`), and the Dashboard-only floating PM chat widgets (`app-shell.tsx:333-358`). Two side-effect store imports (`issue-fixer-store`, `unread-store`) attach live broadcast listeners at app start so unread dots update on any page (`app-shell.tsx:21-26`).

```mermaid
flowchart TD
  Root["rootRoute → AppShell"] --> Shell
  Shell["AppShellContent\n(title, redirect, dialogs)"] -->|first launch| OB["/onboarding (no chrome)"]
  Shell --> Sidebar["Sidebar nav\n(BASE_NAV + plugins + freelance)"]
  Shell --> Outlet["&lt;Outlet/&gt; → page component"]
  Outlet --> Proj["/project/$id → ProjectPage\n(local tab state)"]
  Outlet --> Set["/settings → SettingsPage\n(Tabs + SubTabs)"]
  Outlet --> Other["dashboard | inbox | agents | …"]
```

## The two genuinely complex pages

**`ProjectPage`** (`project.tsx:31`) is the heart of the app. It is a tab host (chat, kanban, docs, git, issue-tracker, remote, deploy, settings, plus plugin tabs) where `activeTab` is local state (`project.tsx:33`), and each tab lazily renders a heavy component (`project.tsx:360-375`). Its hard part is *data lifecycle on project switch*: a project-scoped `conversationsLoadedForProject` marker (not a boolean) guards a chained pair of effects so a late-resolving `loadConversations` from the previous project can't auto-select the wrong conversation (`project.tsx:99-170`). The same load effect also declares the chat store's `activeProjectId` via `setActiveProject` on mount/project change and nulls it on unmount — the gate that keeps background-project broadcasts from replacing the sidebar (see [[frontend-stores]], project-scoping guard). It coordinates the chat store and kanban store, resets both on unmount, and defers kanban load to idle time so chat is the critical path (`project.tsx:120-124`). It also bridges `agentdesk:switch-tab` window events from child components into tab changes (`project.tsx:77-84`) and manages per-tab unread dots via the unread store (`project.tsx:37-97`).

The conversation auto-select effect (`project.tsx:148-170`) now checks the
chat store's `pendingConversationTarget` **first**, before its normal
fallback logic (most-recent conversation, or create a new one): if a target
is set and matches the current `projectId`, it's consumed (cleared, whether
or not its conversation is actually found in the loaded list, so a
stale/mismatched target can't leak into a later switch) and, if found,
`setActiveConversation`/`loadMessages` jump straight to it. This is how the
`CrossProjectApprovalToast` (see [[frontend-components]]) deep-links: it sets
`pendingConversationTarget` then navigates to `/project/$projectId`, and by
the time this effect runs (after that project's conversations finish
loading) it lands on the exact conversation waiting for shell/plan approval
instead of whatever conversation would otherwise have been auto-selected.

**`SettingsPage`** (`settings.tsx:47`) is a two-level tab hub: top-level Radix `Tabs` (General / AI / Channels / Integrations / Notifications / System / Plugins) each containing a hand-rolled `SubTabs` component (`settings.tsx:22-45`) that fans out to the leaf editors under `pages/settings/*`. The Plugins top-level tab simply embeds the `PluginsPage` component (`settings.tsx:106-108`). All of this is local state — no settings sub-page has its own route. The **AI** tab's sub-tabs are `Providers` (credentials/connection) and `Models` (`pages/settings/models.tsx`) — the latter manages global per-model enable/disable + favourite via the `model_preferences` table; favourites and disabled state are mirrored by the chat model picker (`components/chat/model-selector.tsx`, which adds top-pinned `Latest` + `Favorites` sections). See [[database-tables]].

**`OnboardingPage`** (`onboarding.tsx`) is a six-step provider wizard (`onboarding.tsx:30,52`) that the shell force-routes to on first launch; on completion the user navigates back to `/`.

## Key files

| File | Role |
|---|---|
| `src/mainview/router.tsx` | Flat route tree + hash history + router instance |
| `src/mainview/components/layout/app-shell.tsx` | Root layout: title, first-launch redirect, sidebar state, global dialogs/singletons |
| `src/mainview/components/layout/sidebar.tsx` | Primary nav; static items + plugin/freelance items; active-route highlighting; update panel |
| `src/mainview/pages/project.tsx` | `/project/$projectId` tab host; chat/kanban store lifecycle |
| `src/mainview/pages/settings.tsx` | Tabbed settings hub embedding `pages/settings/*` leaves + Plugins |
| `src/mainview/pages/dashboard.tsx` | Project list, filters, live agent/task badges |
| `src/mainview/pages/onboarding.tsx` | First-run provider setup wizard |

## Gotchas / Constraints

- **Hash routing, not browser routing.** Routes are `#/...` paths so the webview needs no server (`router.tsx:23-25`). Don't assume real URLs or server-side routing.
- **In-page tabs are not routable.** Project tabs and Settings sub-tabs live in `useState`, so they can't be deep-linked and reset to default on reload (`project.tsx:33`, `settings.tsx:50`).
- **`/plugins` is a phantom route.** It has a title entry (`app-shell.tsx:100`) but no route; the actual Plugins UI is a Settings tab (`settings.tsx:106`). The only `/plugin/*` route is the DB viewer.
- **Onboarding bypasses shell chrome.** `AppShell` returns early for `/onboarding` (`app-shell.tsx:303`), so anything added to the shell (top-nav, sidebar) is invisible there.
- **First-launch redirect runs on every navigation.** The `isFirstLaunch` check fires in an effect keyed on pathname (`app-shell.tsx:234-249`); a slow RPC briefly shows a "Loading…" gate (`app-shell.tsx:312-318`).
- **Sidebar items are partly dynamic.** Plugin sidebar items and the Freelance entry are injected at runtime (`sidebar.tsx:328-333`); the Freelance entry only appears when the feature flag RPC returns enabled (`sidebar.tsx:212-224`).
- **Project-switch race is deliberately guarded.** The `conversationsLoadedForProject` string marker (not a boolean) exists specifically to stop stale async loads from clobbering the new project's chat state (`project.tsx:44-46,146-170`) — don't "simplify" it to a boolean.
- **`setActiveTab("chat")` fires unconditionally on every project switch** (inside the project-load effect, `project.tsx:107`, before `loadConversations`). This is *the* load-bearing fact for staleness bugs across every non-chat tab: since each tab is conditionally rendered (`{activeTab === "git" && <GitTab .../>}`, no `key={projectId}` anywhere), forcing `activeTab` back to `"chat"` on any project change **unmounts** whatever non-chat tab was showing. React discards that component's local `useState` on unmount, and a late-resolving stale fetch calling a setter on a dead component instance is a silent no-op (no warning as of React 18) — so a missing staleness guard in Git/Issues/Deploy/Notes/Remote-sync/Kanban-adjacent **tab-local `useState`** is a latent code smell, not a currently-reachable bug. This was verified by three independent audits (Git, Issue-tracker/issue-fixer, Remote-sync subtrees) that each found real-looking async races in tab-local state — all neutralized by this exact mechanism.
  The escape hatch: components that live **inside the Chat tab itself** (`ChatLayout` → `ContextPanel` → `FilesTab`/`DocsTab`, and `ModelSelector`/`ContextIndicator`) do *not* get this protection, because Chat is the tab that's always force-selected — if the user was already on Chat (the common case), switching projects gives these components a **live `projectId` prop change with no unmount**. This is exactly the class of bug fixed in `files-tab.tsx`'s `loadRoot`, `docs-tab.tsx`'s `loadDocs`, `model-selector.tsx`'s settings load, and `context-indicator.tsx`'s context-limit load — each now tracks the latest `projectId` in a `useRef` and re-checks it after every `await` before applying the result. See [[frontend-components]].
  The other exception is **global Zustand store state** (`chat-store.ts`, `kanban-store.ts`), which was never protected by unmount to begin with — it outlives every component and persists for the app's lifetime, hence the separate `activeProjectId`/staleness-guard fixes documented in [[frontend-stores]].

## Related
- [[frontend-architecture]]
- [[rpc-layer]]
- [[agent-engine]]
- [[playground]]
- [[freelance-autoearn]]
- [[plugins]]
- [[issue-sources]]
- [[notifications]]
- [[frontend-components]] — `CrossProjectApprovalToast`, the consumer that sets `pendingConversationTarget`
- [[frontend-stores]] — `pendingConversationTarget` field on the chat store

## Open questions
- The dashboard floating PM chat widgets and `CustomAgentChatLauncher` are visibility-gated to `/` (`app-shell.tsx:356-357`) but always mounted — their internal state behavior across navigation is not documented here.
- `pages/agents.tsx`, `analytics.tsx`, `scheduler.tsx`, `skills.tsx`, `council.tsx` were only inspected at a header level; their internal sub-structure may warrant their own pages. (`inbox.tsx` is now documented in the route map: master-detail list + preview pane with server/client filter split.)
