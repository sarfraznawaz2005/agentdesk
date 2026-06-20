# AgentDesk Web App (Remote Access) — Product Requirements Document

> **Status:** Draft / Proposal · **Date:** 2026-06-20 · **Owner:** Sarfraz Ahmed
> **Decision pairing:** Evaluate against [`mobile-app-prd.md`](./mobile-app-prd.md) — we ship **one** of these two routes, not both.
> **Grounding:** This PRD is anchored to the current code (source of truth). Key anchors are cited as `file:line`.

---

## 1. Purpose

Make the **full AgentDesk experience reachable from any device with a browser** — phone, tablet, or someone else's laptop — by serving the *existing* React UI remotely and connecting it back to the user's own desktop over a free relay.

Where the mobile route is a curated companion, the web route is a **full-parity remote control**: the same pages, the same features, no install, no app store, instant updates — accessible at one URL from anywhere, *as long as the user's own machine is running.*

> **One sentence:** *The desktop runs the agents; the browser is a remote window into the desktop, from any device.*

---

## 2. Background & the Governing Constraint

AgentDesk is an **Electrobun desktop app** (Bun backend + React 19 webview). The backend (`src/bun/`) reads files, spawns `git`/agents/LSP, and owns the SQLite DB — all **local OS operations on the user's machine**. The frontend is **standard web tech** rendered in the system webview; its only connection to the backend is the single seam `Electroview.defineRPC` in `src/mainview/lib/rpc.ts:29`, riding Electrobun's native bridge (not HTTP).

**The governing constraint (identical to the mobile route):** the workspace and agents are **bound to the user's machine**. The web app is a **remote display + input device**; the backend stays on the desktop. The browser ships pixels and clicks — never files or agent execution.

**What makes web uniquely attractive:** the frontend is already a web app. Only **three things** are Electrobun-specific — the RPC bridge, the `<electrobun-webview>` tag, and the draggable-region CSS. Swap the first and gate the other two, and the *same* React UI runs in any browser.

---

## 3. Goals & Non-Goals

### Goals
- Serve the existing React SPA at **one fixed URL**, reachable from any device's browser, connecting to the user's own desktop via the relay.
- **Full feature parity for the core** — all data/agent features (projects, chat, kanban, agents, settings, dashboard chatbots) work as-is.
- **Zero end-user setup:** open the URL → pair/log in → connected. No install, no signup.
- **$0 to the end user** and **near-$0 to us** (one free developer account; see §5).
- Installable as a **PWA** (home-screen icon, Android push).
- Strict **per-user data isolation** by construction (§7).

### Non-Goals
- ❌ No cloud execution of agents; no cloud-hosted workspaces.
- ❌ No attempt to replicate native-desktop-only features in the browser (see §9) — they are gated, not reimplemented.
- ❌ No lock-screen widgets / no reliable iOS push / no iOS share-sheet (browser platform limits — see §9). *If those are must-haves, choose the mobile route.*

---

## 4. Benefits

| Benefit | Why it matters |
|---|---|
| **Any device, no install** | Phone, tablet, a borrowed laptop — anything with a browser opens the one URL. No app store, no download. |
| **Full feature parity** | All 15 routes / 14 pages render; it's literally the same UI hitting the same RPC handlers. Nothing to re-spec. |
| **One codebase** | Reuse the existing React app — dramatically less build/maintenance than a separate native client. |
| **Instant updates** | Ship a new build to the CDN; no app-review cycle. |
| **Power-user remote** | Do *everything* the desktop does — full chat, kanban, settings, git, analytics — from the road. |
| **No setup, no cost** | Users open the URL and pair once; we run one free relay + free static hosting. |

---

## 5. The $0-Cost Model — Model A (free tier, fixed URL)

**Constraint:** one developer account, set up once by us, that works automatically for all end users with no per-user signup or external setup.

> **Decision (2026-06-20): Model A — Cloudflare free tier with a fixed URL. The cost is $0, not "$0→$5". The $5/mo Workers Paid plan is only an *optional ceiling* reached if we ever outgrow the free tier at scale — never a starting cost.** Model A also gives a **fixed URL for free**, so we get stability without paying and without needing a randomized URL.

| Component | Choice | Cost |
|---|---|---|
| **Static hosting** (the React build) | **Cloudflare Pages** | **$0** — fixed URL `*.pages.dev` (or a branded domain ≈ $0.87/mo, optional) |
| **Relay** (always-on data broker) | **Cloudflare Workers + Durable Objects** (free tier, WebSocket Hibernation) | **$0** within the free tier (≈100k requests/day ≈ 2M incoming WS msgs/day); fixed `*.workers.dev` URL |
| **Scale ceiling (optional)** | Workers Paid — only if free limits are exceeded | **$5/mo** — a ceiling, not a baseline; low-traffic deployments may never reach it |
| **End-user cost** | — | **$0**, zero setup (pair once, no re-pair) |

**Why it's $0 (not $0→$5):** static assets are free on a CDN; the relay is a **blind, stateless forwarder** that holds no files and no DB. Cloudflare bills incoming WS messages at 20:1 and never bills idle (hibernating) connections, so a low-traffic human-in-the-loop relay stays **inside the free tier**. The $5/mo plan only matters if we cross ~100k requests/day — a scale ceiling, not a starting cost. The free tier also hands us a **fixed URL for $0**.

**Why Model A over the alternative:** Model A gives **$0 + a fixed URL + no re-pairing**. The alternative (embedded per-user quick tunnels) is $0 at any scale but uses a **random URL that changes on every desktop restart** — forcing re-pairing — and is not production-grade. Rejected for now; see §13 if scale ever forces a revisit.

**End users never create a Cloudflare account.** The relay + Pages URL is baked into the build; the only account is ours.

**Where the web app loads from vs. where its data comes from:**
- **Static assets** (HTML/JS/CSS) → Cloudflare Pages. These load instantly *even if the desktop is offline*.
- **Data connection** → from the loaded page, the WS-RPC goes **through the relay to the user's own desktop**, which must be online.

---

## 6. Architecture

### 6.1 The relay topology

```
  User A's browser ─┐                                  ┌─► User A's desktop (their files/agents)
                    ├──►  one fixed URL + relay  ──────┤
  User B's browser ─┘     (Pages serves the app;       └─► User B's desktop (their files/agents)
                           Worker+DO relay routes       
                           WS-RPC by paired identity)
        every desktop dials OUT to the relay → works behind home NAT, no port-forwarding
```

- The browser loads the SPA from Pages, then opens a **WS-RPC connection through the relay** to the user's own desktop (which dialed out to the relay on launch).
- **End-to-end encrypted** browser↔desktop; the relay forwards opaque frames.

### 6.2 The five build layers

1. **Backend WS transport (the reusable foundation).** Add `Bun.serve` WebSocket endpoint in the backend; register the **same** 8 `rpc-groups` handlers on a WS message router *in addition to* the Electrobun bridge (`src/bun/rpc-registration.ts:36`). Handlers in `src/bun/rpc/` are **plain transport-agnostic functions**, so they re-dispatch over WS unchanged.
2. **Frontend transport adapter (the web-specific crux).** The renderer's *entire* coupling to the backend is one import: `import { Electroview } from "electrobun/view"` at `src/mainview/lib/rpc.ts:15`. In a plain browser those native globals don't exist. Branch it: **if running under Electrobun → use Electroview (today's path); else → a WS client implementing the identical `rpc.request.*` / `rpc.send.*` surface.** One conditional, one file. The broadcast→`agentdesk:*` DOM-event re-emitters (`rpc.ts:46`) stay identical — they just receive frames from WS instead of the bridge.
3. **Broadcast forwarding.** Tap `broadcastToWebview` (`src/bun/engine-manager.ts:252`) to forward broadcasts over the relay, filtered per client by `conversationId`/`sessionId`/`projectId`.
4. **Native-feature gating + the remote folder picker (§9).** An `isElectrobun` check hides native-only UI in web mode; build a backend-driven directory browser for project creation.
5. **Relay + pairing + Pages hosting.** Cloudflare Worker + Durable Object (identity routing), QR/code pairing → device token, Pages deployment of the static build.

### 6.3 The relay is the same one the mobile route would use

The transport foundation (layers 1, 3, 5) is **identical** to the mobile PRD. Choosing web vs mobile is mainly a choice of **which frontend** sits on top of the same backend plumbing — which is why picking one now does not foreclose the other later.

---

## 7. Data Isolation (each user sees only their own projects)

**Isolation is structural, not a permission filter:**
- **One `AgentEngine` per project** (`src/bun/engine-manager.ts`) and **one SQLite DB per machine** (`<userData>/agentdesk.db`). Projects are **machine-local workspaces** with absolute `workspacePath`s (`src/bun/rpc/projects.ts`). There is **no shared/central DB and no `userId` column**.
- The relay routes a browser session **only** to the desktop it paired with. User A's session cannot address User B's machine.
- Result: each user sees only **their own machine's** projects — that machine is the only backend their browser is wired to. No cross-tenant data path exists.

> The web client is the *same UI* as the desktop, so a user logging in sees exactly the projects on their own machine — no more, no less.

---

## 8. Feature Set (full parity for the core)

All **15 routes / 14 pages** render in the browser (enumerated in §9.1). The complete RPC surface (~280–350 methods across 28 domains) is reachable over WS-RPC, **except** the native-bound subset (§9). Highlights:

### 8.1 Everything the desktop chat does
Full project chat with the PM, live streaming (`streamToken`, `pmThinking`, inline-agent lifecycle, plan cards), plan **approval inline**, the kanban board with full drag/drop, code-review cycle visibility, git operations, analytics, scheduler, channels/inbox, issue tracker, notes/docs.

### 8.2 The approval surface
Every human-approval moment is reachable (same mechanisms as the desktop, now remote):

| Approval | Mechanism | Anchor |
|---|---|---|
| Plan | `request_plan_approval` → `planPresented` | `src/bun/agents/tools/pm-tools.ts:1604` |
| Shell command | `shellApprovalRequest` → `resolveShellApproval` | `src/bun/engine-manager.ts:333` |
| Agent question | `userQuestionRequest` → `resolveUserQuestion` | `src/bun/engine-manager.ts:416` |
| Deploy | `executeDeploy` | `src/shared/rpc/deploy.ts` |
| Auto-Earn bid/reply | `freelance_outbox` queue | `src/bun/rpc/freelance-outbox.ts` |

### 8.3 Dashboard chatbots (PM + custom agents)
The widgets/chatbot system works as-is over WS-RPC: `getChatEnabledAgents`, `sendDashboardAgentMessage`, the PM concierge (`sendDashboardMessage`), streaming via `dashboardAgentChunk/Complete`. Each chatbot keeps its own prompt/tools/model/memory (`src/bun/rpc/dashboard-agent.ts:51`).

### 8.4 PWA niceties
Installable to the home screen (icon, standalone window), **Web Push on Android** (and installed iOS PWAs, with caveats), **biometric via WebAuthn/passkeys** for approvals.

### 8.5 Responsive layout
A responsive pass so the desktop-oriented UI is usable on a phone browser (the app is desktop-first today; this is real work, not free).

---

## 9. Feature Parity & Explicit Limitations

The **core works fully**; a bounded set of **native-desktop-bound features** must be **gated or given web fallbacks**. This list is exhaustive per code audit.

### 9.1 Route inventory (all render in a browser)
`/` Dashboard · `/onboarding` · `/project/$projectId` (chat·kanban·docs·git·issues·remote·deploy·settings tabs) · `/inbox` · `/agents` · `/skills` · `/prompts` · `/scheduler` · `/council` · `/analytics` · `/freelance` (Auto-Earn) · `/playground` · `/settings` · `/plugin/db-viewer`. *(Project/Settings sub-tabs are `useState`, not URL-routed — optional deep-linking enhancement.)*

### 9.2 Native-bound features (gate or fallback)

| Feature | Web status | Resolution | Anchor |
|---|---|---|---|
| **Project creation / folder picker** | ⚠️ Needs new piece | Build a **backend-driven directory browser** (native `Utils.openFileDialog` renders on the physical desktop, not the remote browser) | `src/bun/rpc-groups/projects-system.ts:165` |
| **Auto-Earn live session** | ❌ Desktop-only | Expose the **approval queue + inbox** only; the live `<electrobun-webview>` session host can't exist in a browser | `src/mainview/components/freelance/session-webview-host.ts` |
| **Terminal / shell `!` REPL / open-in-explorer** | ❌ / ⚠️ | Hide open-terminal & open-in-explorer; shell `!` can stay (runs on backend, returns output) | `projects-system.ts:137,223` |
| **Annotations preview (2nd OS window)** | ⚠️ Redesign | Reuse the in-app playground iframe instead of a native `BrowserWindow` | `src/bun/annotations/preview-window.ts` |
| **Playground live preview** | ⚠️ | Served by a local Bun static server; works only while desktop online, via relay-proxied iframe | `src/mainview/pages/playground.tsx` |
| **OS desktop notifications** | ⚠️ Degraded | Use Web Push / in-app alerts instead of native toasts | `src/bun/notifications/desktop.ts` |
| **Tray, native menus, draggable titlebar, window-state, app updater, LSP, plugin load/unload** | ❌ / hidden | Gate behind `isElectrobun`; irrelevant or unavailable in a browser | `src/bun/index.ts`, `src/shared/rpc/updater.ts`, `lsp.ts` |

### 9.3 Platform capability gaps (vs native mobile)

| Capability | Web app |
|---|---|
| Push notifications | ✅ Android (PWA); ⚠️ iOS only if installed, flaky |
| Biometric approval | ✅ WebAuthn/passkeys |
| **Lock-screen widget** | ❌ Impossible in a browser |
| **Share-sheet capture** | ⚠️ Android PWA only; ❌ iOS |

### 9.4 The hard limit

🔴 **The desktop must be running.** The web app's static shell loads from the CDN even when the desktop is off, but with the desktop asleep/offline it shows an **"your desktop is offline"** state — no projects, no chat, no agents, because the backend (and the files) are off. This is inherent to the local/private model and has no free workaround.

---

## 10. Security & Privacy

- **Pairing:** QR/code → per-device (per-browser) token bound to the account; required before the WS-RPC channel opens.
- **End-to-end encryption** browser↔desktop through the relay; the relay is **blind** (no project data, low cost + low liability).
- **Identity routing only:** the relay can never wire User A's browser to User B's desktop.
- **Larger surface than mobile:** a remote browser session can invoke ~all backend handlers — *reading files and running agents on the user's machine.* This **must** sit behind strong auth (device token + optional WebAuthn step-up + revocation). Recommend Cloudflare Access or equivalent as an additional gate for the URL; never a bare public endpoint.
- **Session hygiene:** short-lived tokens, re-auth on new browser, remote device revocation.

---

## 11. Development Plan

### Phase 0 — Backend foundation (shared, reusable) 🧱
- **0.1** `Bun.serve` WS endpoint; spread the 8 `rpc-groups` onto a WS router (mirror `rpc-registration.ts:36`); verify WS round-trip parity with the bridge.
- **0.2** Forward `broadcastToWebview` (`engine-manager.ts:252`) over the relay, filtered by `conversationId`/`sessionId`/`projectId`.
- **0.3** Desktop **outbound relay client** (dial on launch, online/offline, reconnect).
- **0.4** Deploy **Cloudflare Worker + Durable Object relay**; identity routing.
- **0.5** **Pairing + auth:** QR/code → device token, E2E key exchange, device list + revoke.
- **0.6 (recommended)** Durability hardening for in-memory plan/approval state (so reconnects don't drop in-flight approvals).

### Phase 1 — Frontend transport adapter (web crux) 🔌
- Branch `src/mainview/lib/rpc.ts:15,29`: Electrobun bridge vs WS client, behind a runtime `isElectrobun` check. Implement the WS client to satisfy the same `rpc.request.*` / `rpc.send.*` surface and re-emit broadcasts as the existing `agentdesk:*` DOM events.

### Phase 2 — Static hosting + load + pair 🌐
- Deploy the SPA build to **Cloudflare Pages** at a fixed URL.
- Open-URL → pairing/login → connect WS-RPC to the user's desktop. "Desktop offline" state.

### Phase 3 — Native-feature gating + remote folder picker 🚧
- `isElectrobun` gates for tray/terminal/explorer/updater/2nd-window/native notifications.
- **Backend-driven directory browser** RPC + UI for project creation (`listDir`/navigate/select) replacing the native picker (`projects-system.ts:165`).
- Auto-Earn: expose approval queue/inbox; hide live session.

### Phase 4 — Responsive pass 📐
- Make the desktop-first UI usable on phone/tablet browsers; (optional) deep-linkable project/settings tabs.

### Phase 5 — PWA + push + biometric 📲
- PWA manifest + service worker (installable, offline shell).
- **Web Push** (Android/installed-iOS) for approvals + key events.
- **WebAuthn** biometric step-up for approvals (deploys especially).

### Phase 6 — Hardening & launch 🚀
- Cloudflare Access (or equivalent) gate, token revocation, reconnection UX, cross-browser QA, performance.

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Desktop offline ⇒ app inert | Clear offline state; reconnect on wake; (optional, later) Wake-on-LAN |
| Native features absent in browser | Explicit gating + the few documented fallbacks (§9.2) — accepted scope, not bugs |
| iOS push/share/widget gaps | Documented non-goals; choose the **mobile route** if these are must-haves |
| Desktop-first UI clunky on phone | Phase 4 responsive pass (real effort, budgeted) |
| Large security surface (full backend over WS) | Device token + WebAuthn step-up + Cloudflare Access + E2E + revocation |
| In-memory plan/approval state | Phase 0.6 durability hardening |
| Relay cost | **$0** within the Cloudflare free tier; ≈$5/mo only if free limits are exceeded at scale (a ceiling, not a baseline) — monitor concurrency |
| Existing users must update + pair | One-time, in-app; no data migration (DB/projects stay in place) |

---

## 13. Open Questions

1. **Static hosting model:** serve the SPA from Cloudflare Pages (recommended, loads when desktop is off) vs from the user's own desktop through the relay (no CDN, but nothing loads when desktop is off)?
2. **Auth depth:** is the device-token pairing enough, or require Cloudflare Access / WebAuthn step-up by default given the full-backend surface?
3. **Deep-linkable tabs:** invest in URL-routed project/settings tabs for shareable/bookmarkable deep links?
4. **Responsive scope:** full mobile-browser polish, or "works but desktop-optimized"?
5. **Relay scale ceiling:** Model A (free tier) is the chosen cost model. If concurrency ever exceeds the Cloudflare free tier (~100k req/day), revisit: upgrade to Workers Paid ($5/mo) or move to per-user quick tunnels ($0 but random URL + re-pair). Not a near-term concern.

---

## 14. Appendix — Code Anchors

| Concern | Anchor |
|---|---|
| Transport seam (the adapter point) | `src/mainview/lib/rpc.ts:15,29` |
| Broadcast→DOM-event re-emitters | `src/mainview/lib/rpc.ts:46` |
| RPC registration (8 groups) | `src/bun/rpc-registration.ts:36` |
| Handler groups | `src/bun/rpc-groups/*.ts` |
| Broadcast mechanism | `src/bun/engine-manager.ts:252` |
| Broadcast catalog | `src/shared/rpc/webview.ts` |
| Router / routes | `src/mainview/router.tsx:23` |
| Project page (tab host) | `src/mainview/pages/project.tsx` |
| Folder picker (native → replace) | `src/bun/rpc-groups/projects-system.ts:165` |
| Native session host (desktop-only) | `src/mainview/components/freelance/session-webview-host.ts` |
| Annotations 2nd window (redesign) | `src/bun/annotations/preview-window.ts` |
| Per-project engine cache | `src/bun/engine-manager.ts` |
| Projects (machine-local) | `src/bun/rpc/projects.ts` |
| Dashboard chatbots | `src/bun/rpc/dashboard-agent.ts:51` |
| Notifications | `src/bun/notifications/desktop.ts` |

---

*Related: [`mobile-app-prd.md`](./mobile-app-prd.md) (the alternative route) · `docs/prd.md` · `docs/workflow.md` · `project-wiki/subsystems/frontend-pages.md` · `project-wiki/subsystems/rpc-layer.md` · `project-wiki/flows/message-streaming-broadcasts.md`.*
