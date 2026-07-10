# AgentDesk Mobile App — Product Requirements Document

> **Status:** Draft / Proposal · **Date:** 2026-06-20 · **Owner:** Sarfraz Ahmed
> **Decision pairing:** Evaluate against [`web-app-prd.md`](./web-app-prd.md) — we ship **one** of these two routes, not both.
> **Grounding:** This PRD is anchored to the current code (source of truth). Key anchors are cited as `file:line`.

---

## 1. Purpose

Give AgentDesk users a **native mobile companion** that lets them perform the **human-in-the-loop 1%** of the workflow — *approve, monitor, stop, and chat* — from anywhere, while the agents, files, and execution stay on their desktop machine.

AgentDesk's motto is **"99% agent-driven. Humans approve, deploy, and communicate."** Every one of those human verbs happens *away from the keyboard* — which is exactly when a phone matters. The mobile app is the **human-approval surface**, not a second IDE.

> **One sentence:** *The desktop runs the agents; the phone is the remote control for the moments a human is required.*

---

## 2. Background & the Governing Constraint

AgentDesk is an **Electrobun desktop app** (Bun backend + React 19 webview). The backend (`src/bun/`) reads files, spawns `git`/agents/LSP, and owns the SQLite DB — all **local OS operations on the user's machine**. The React frontend talks to it through a **single transport seam**: `Electroview.defineRPC` in `src/mainview/lib/rpc.ts:29`, which rides Electrobun's native webview↔Bun bridge (not HTTP).

**The governing constraint:** the workspace and the agents are **physically bound to the user's machine**. No cloud server can read their local files. Therefore the mobile app is a **thin remote** that reaches the backend *still running on the user's desktop* — it never holds files or runs agents itself.

This is not a new pattern for AgentDesk — it already routes external messages (Discord/WhatsApp/Email) into the engine and relays replies (the `channels/` subsystem). **The mobile app is, architecturally, another channel** — a first-party, richer one.

---

## 3. Goals & Non-Goals

### Goals
- A native iOS/Android app that surfaces approvals, project chat, agent monitoring, an emergency stop, the agent-chatbot widgets, and Auto-Earn approvals.
- **Zero end-user setup friction:** no signups, no URLs, no networking knowledge. Open app → scan one QR → done.
- **$0 to the end user** and **near-$0 to us** (one free developer account; see §5).
- First-class mobile-native features: **push notifications, biometric approval, lock-screen widget, share-sheet capture.**
- Strict **per-user data isolation** by construction (§7).

### Non-Goals
- ❌ Not a full IDE / not feature-parity with the desktop. (That is the web-app route's value proposition.)
- ❌ No project creation on mobile (workspaces are machine-bound).
- ❌ No file editing, no agent execution in the cloud.
- ❌ ~~Voice input~~ — dropped per product decision.
- ❌ ~~Offline compose queue~~ — dropped; desktop-offline is shown as a status, messages are not queued.

---

## 4. Benefits

| Benefit | Why it matters |
|---|---|
| **Approve from anywhere** | Plans, deploys, reviews, and Auto-Earn bids are time-sensitive human gates. Approving on a phone removes the "I was away from my desk" bottleneck. |
| **Emergency stop in your pocket** | A runaway or mis-behaving agent run can be paused/stopped remotely — the single highest-value safety feature when away. |
| **Glanceable peace of mind** | "What are my agents doing right now, and is anything stuck?" answered at a glance, via widget and push. |
| **First-class mobile UX** | Native push, biometric, widgets, and share-sheet are things a phone does that a desktop cannot — the app is genuinely additive, not a worse desktop. |
| **Auto-Earn on the go** | Approving a freelance bid while commuting can win a project before a competitor at their laptop — mobile is *better* than desktop here. |
| **No setup, no cost** | End users pair once by QR and pay nothing; we run one free relay. |

---

## 5. The $0-Cost Model (one developer account, works out-of-box)

**Constraint:** one developer account, set up once by us, that works automatically for all end users with no per-user signup or external setup.

| Component | Choice | Cost |
|---|---|---|
| **Relay** (always-on message broker) | **Cloudflare Workers + Durable Objects** (free tier, WebSocket Hibernation) | **$0** within the free tier; fixed `*.workers.dev` URL. $5/mo is only an optional scale ceiling, never a baseline |
| **Fixed URL** | Free `*.workers.dev` subdomain (no domain purchase needed) | **$0** (optional branded domain ≈ $0.87/mo via Cloudflare Registrar) |
| **Push delivery** | APNs (iOS) + FCM (Android) | **$0** |
| **End-user cost** | — | **$0**, zero setup |

**Why it stays cheap:** the relay is a **blind, stateless forwarder** — it holds no files and no DB, just routes encrypted WebSocket frames. Cloudflare bills incoming WS messages at 20:1 and never bills idle (hibernating) connections, so a low-traffic human-in-the-loop app stays **inside the free tier**; the $5/mo Workers Paid plan is only a ceiling reached if we ever exceed ~100k requests/day at scale. Our real "infrastructure" — agents, files, SQLite — lives on each user's own machine at $0 to us.

**End users never create a Cloudflare account.** The relay URL is baked into the app; the only account is ours.

---

## 6. Architecture

### 6.1 The relay topology

```
  User A's phone ─┐                                   ┌─► User A's desktop (their files/agents)
                  ├──►  one fixed relay URL  ─────────┤
  User B's phone ─┘     (Cloudflare Worker + DO,      └─► User B's desktop (their files/agents)
                         routes by paired identity)
        every desktop dials OUT to the relay → works behind home NAT, no port-forwarding
```

- **Desktop dials out** to the relay on launch (after a normal app update). Outbound connection ⇒ works behind home Wi-Fi/CGNAT/firewalls with **no port forwarding**.
- **Mobile connects** to the same relay, authenticates with its paired device token, and the relay routes its traffic **only** to that user's own desktop.
- **End-to-end encrypted** between phone and desktop so the relay forwards opaque frames it cannot read.

### 6.2 The four build layers

1. **Backend WS transport (the reusable foundation).** Add `Bun.serve` (native to the Bun runtime Electrobun already runs) with a WebSocket endpoint inside the existing backend. Register the **same** RPC handlers on a WS message router *in addition to* the Electrobun bridge. The handlers in `src/bun/rpc/` are **plain transport-agnostic functions** — they don't depend on the Electrobun bridge — so they re-dispatch over WS unchanged. Registration today: `src/bun/rpc-registration.ts:36` (`BrowserView.defineRPC`) spreads 8 handler groups from `src/bun/rpc-groups/`; the WS router spreads the same groups.
2. **Broadcast forwarding.** Streaming/approvals happen via `broadcastToWebview(name, payload)` (`src/bun/engine-manager.ts:252`). Tap this so every broadcast is *also* forwarded over the desktop's outbound relay connection, filtered per subscribed client by `conversationId` / `sessionId` / `projectId` (these IDs are already present in payloads — see `src/shared/rpc/webview.ts`).
3. **Relay + pairing.** Cloudflare Worker + Durable Object that routes by authenticated identity; a QR/code pairing handshake that mints a per-device token bound to the account.
4. **Native mobile client.** React Native / Expo app implementing the curated feature set (§8).

### 6.3 Why "mobile = another channel" is exact

The existing dashboard chatbots already expose the precise RPC trio the widgets page needs, fully decoupled from the kanban/orchestration engine:
- `getChatEnabledAgents()` → list of chat-enabled custom agents (`src/bun/rpc/dashboard-agent.ts:51`)
- `sendDashboardAgentMessage({ sessionId, agentName, content })` → stream a reply (`dashboard-agent.ts:68`)
- `sendDashboardMessage({ sessionId, content })` → the PM concierge (`src/bun/rpc/dashboard.ts:563`)
- streaming via `dashboardAgentChunk/Complete/ToolCall/Error` broadcasts

The mobile widgets page is a remote surface over this existing, already-shipped backend.

---

## 7. Data Isolation (each user sees only their own projects)

**Isolation is structural, not a permission filter:**
- There is **one `AgentEngine` per project**, cached per app session in `EngineManager` (`src/bun/engine-manager.ts`), and **one SQLite DB per machine** (`<userData>/agentdesk.db`). Projects are **machine-local workspaces** with absolute `workspacePath`s (`src/bun/rpc/projects.ts`). There is **no shared/central database and no `userId` column** — by design.
- The relay routes a phone's traffic **only** to the desktop it paired with. User A's app cannot even *address* User B's machine.
- Result: a user can only ever see **their own machine's** projects, because that machine is the only backend their app is wired to. No cross-tenant data path exists to leak through.

---

## 8. Feature Set (curated for mobile)

### 8.1 The spine — Approval Inbox 🛎️
A unified **"Needs You"** queue. Every human-approval moment in the app, in one place, swipe-to-act. Grounded in the real approval mechanisms:

| Approval | Source / mechanism | Anchor |
|---|---|---|
| **Plan approval** | `request_plan_approval` → `planPresented` broadcast; approval is implicit on next user message | `src/bun/agents/tools/pm-tools.ts:1604` |
| **Shell command** | `shellApprovalRequest` broadcast → `resolveShellApproval(requestId, allow\|deny\|always)` | `src/bun/engine-manager.ts:333` |
| **Agent question** | `userQuestionRequest` broadcast → `resolveUserQuestion(requestId, answer)` | `src/bun/engine-manager.ts:416` |
| **Deploy** | human deploy gate (`executeDeploy`) | `src/shared/rpc/deploy.ts` |
| **Code review outcome** | review-cycle auto-spawns reviewer; surface verdict | `src/bun/agents/review-cycle.ts` |
| **Auto-Earn bid / reply** | `freelance_outbox` rows in `draft`/`awaiting_review` | `src/bun/rpc/freelance-outbox.ts` |

> ⚠️ **Durability note (design input):** shell/question approvals live in an **in-memory map with a 5-minute auto-timeout** (`engine-manager.ts`), and plan task-definitions live in an **in-memory buffer** until `create_tasks_from_plan`. The mobile flow must handle "approval expired / desktop restarted — re-request" gracefully. Making these durable (DB-backed) is a recommended foundation task (§11, Phase 0).

### 8.2 Project chat 💬
- Send a message to a project's PM; **the work runs on the desktop** (PM reads the real workspace, dispatches agents) and streams back.
- Live streaming of PM tokens, `pmThinking`, inline-agent lifecycle, and plan cards via the forwarded broadcasts (`streamToken`, `pmThinking`, `agentInlineStart/Complete`, `partCreated/Updated`, `planPresented`).
- Plan cards render inline with inline Approve/Reject.

### 8.3 Widgets page 🤖 (PM chat + custom-agent chatbots)
- Lists all `chatEnabled` custom agents (`getChatEnabledAgents`) **plus** the PM concierge widget.
- Each chatbot uses its **own** system prompt, tools, model, and `last-msg-store` memory — all already server-side.
- Direct chat for read-safe agents; write-oriented requests route through the PM. Scoped within a chosen project (PM is per-project).

### 8.4 Monitoring 👀
- Live agent dashboard (which agent, which task, which step), kanban board (read + drag-to-reprioritize backlog), per-project activity feed, and **stuck/blocked alerts** (driven by `userQuestionRequest`, idle detection).

### 8.5 The kill switch 🎛️
- **Pause / resume / stop** an agent run remotely (backed by the per-project abort registry in `engine-manager.ts`). Highest-value safety control.

### 8.6 Auto-Earn on the go 💸
- Opportunity feed, **bid/reply approval queue** (edit price/pitch, approve or kill), client-message inbox, earnings/action log.
- **Note:** the live Freelancer.com *session* (the `<electrobun-webview>` host, `session-webview-host.ts`) is desktop-only; mobile exposes the **approval queue and inbox**, not the live session.

### 8.7 Mobile-native features 📱
| Feature | Behavior |
|---|---|
| **Push notifications** | Plan needs approval, task done, review pass/fail, agent blocked, new Auto-Earn opportunity/message. Native APNs/FCM. The heartbeat of the app. |
| **Biometric approval** | Face ID / fingerprint to confirm an approval. **Toggle in settings, ON by default.** Doubles as a security control for the remote channel. |
| **Lock-screen widget** | Glanceable "N agents running, M awaiting you." Native WidgetKit / App Widgets. |
| **Share-sheet capture** | Share a link/screenshot/note from any app → drops a backlog task into a chosen project. Native share extension / intent filter. |

### 8.8 Mobile Settings ⚙️
Connection & pairing (paired desktops, online/offline status, re-pair), notification toggles + quiet hours, **biometric toggle (on by default)**, appearance (theme/text size), default project, sign-out/revoke device, about.

---

## 9. Feature Parity & Explicit Limitations

The mobile app is **intentionally curated**, not full-parity. The following desktop capabilities are **out of scope** on mobile (they are native-desktop-bound or workspace-bound):

| Desktop feature | Mobile status | Reason |
|---|---|---|
| Project creation / workspace folder picker | ❌ | Native `Utils.openFileDialog`; workspace is machine-bound (`projects-system.ts:165`) |
| Auto-Earn live session | ❌ (queue only) | `<electrobun-webview>` native overlay (`session-webview-host.ts`) |
| Terminal / shell `!` REPL / open-in-explorer | ❌ | OS process spawning (`projects-system.ts:137,223`) |
| LSP, Plugins load/unload, App updater | ❌ | Local toolchain / FS / desktop binary |
| File editing, full diffs line-by-line | ⚠️ Read-only summaries | Files never leave the desktop |
| Desktop online dependency | 🔴 Required | The desktop is the backend; if asleep/offline, mobile shows "desktop offline" |

---

## 10. Security & Privacy

- **Pairing:** QR/code exchange mints a per-device token bound to the account. The token is required before any WS-RPC channel opens.
- **End-to-end encryption** phone↔desktop through the relay; the relay is **blind** (forwards opaque frames, stores no project data → low cost *and* low liability).
- **Identity routing only:** the relay can never wire User A's client to User B's desktop.
- **Biometric gate** (default on) for approvals — especially deploys (irreversible).
- **Threat model to document:** a paired phone can *drive agents and read files* on the user's machine. Treat the device token like an SSH key; support remote revocation.

---

## 11. Development Plan

### Phase 0 — Backend foundation (shared, reusable) 🧱
*The hard, one-time work. Also unlocks the web route later.*
- **0.1** Add `Bun.serve` WebSocket endpoint in the backend; spread the 8 `rpc-groups` handlers onto a WS message router (mirror `rpc-registration.ts:36`). Validate a round-trip RPC over WS equals the Electrobun-bridge result.
- **0.2** Tap `broadcastToWebview` (`engine-manager.ts:252`) to forward broadcasts over the relay connection, filtered by `conversationId`/`sessionId`/`projectId`.
- **0.3** Desktop **outbound relay client**: dial the relay on launch; expose online/offline status; auto-reconnect.
- **0.4** Deploy the **Cloudflare Worker + Durable Object relay**; identity-based routing; free `workers.dev` URL baked into builds.
- **0.5** **Pairing + auth:** QR/code handshake → device token; E2E key exchange; device list + revoke RPC.
- **0.6 (recommended)** Durability hardening: persist plan task-definitions and shell/question approval requests to the DB so a reconnect/restart doesn't drop an in-flight approval (addresses the in-memory gotchas in §8.1).

### Phase 1 — Mobile shell 📱
- React Native / Expo project; auth/pairing flow; connection-status UI; navigation skeleton (bottom tabs: Inbox · Projects · Agents · Activity · More).

### Phase 2 — The spine: Approval Inbox + Push 🛎️
- Unified approval queue wired to plan/shell/question/deploy/review/Auto-Earn events.
- APNs/FCM push for every approval + key lifecycle event. Server-side: emit push when the desktop forwards an approval broadcast and the client is backgrounded.

### Phase 3 — Project chat + Widgets page 💬🤖
- Streaming project chat (forwarded broadcasts); inline plan cards.
- Widgets page over `getChatEnabledAgents` + `sendDashboardAgentMessage` + PM concierge.

### Phase 4 — Monitoring + Kill switch 👀🎛️
- Live agent status, kanban read/reprioritize, activity feed, stuck alerts.
- Pause/resume/stop wired to the abort registry.

### Phase 5 — Native niceties 📱
- Biometric approval (toggle, default on), lock-screen widget, share-sheet capture.

### Phase 6 — Auto-Earn on the go 💸
- Opportunity feed, bid/reply approval queue, client inbox, earnings log.

### Phase 7 — Hardening & release 🚀
- Reconnection/timeout UX, push reliability, device revocation, store submission (App Store + Play).

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| In-memory approval/plan state lost on desktop restart/reconnect | Phase 0.6 durability hardening; graceful "re-request" UX |
| Desktop offline ⇒ app is inert | Clear "desktop offline" state; push when it reconnects; (optional, later) Wake-on-LAN |
| iOS/Android push reliability | Native APNs/FCM (first-class on native — a key reason to choose mobile over web) |
| Relay cost growth at scale | **$0** within the Cloudflare free tier; ≈$5/mo only if free limits are exceeded at scale — monitor concurrency |
| Security of a remotely-drivable backend | Device token + E2E + biometric + revocation; treat token like an SSH key |
| Second codebase to maintain (RN) | Accept as the cost of native features; share types from `src/shared/rpc/` |
| Existing users must update + pair | One-time, in-app, no data migration (their DB/projects stay in place) |

---

## 13. Open Questions

1. **Widgets page scope:** global launcher (pick agent → ask which project) vs inside-a-project (recommended, since PM is per-project)?
2. **Push fan-out:** push from the desktop (via relay) or from the relay itself? (Relay-side needs minimal metadata; keep payloads E2E-opaque.)
3. **Shared vs independent chat threads:** mobile gets its own `sessionId` (independent threads, zero backend change) vs DB-persisted shared threads with desktop (small change). Recommend independent first.
4. **Tablet layout:** treat as large phone, or a denser layout closer to web?

---

## 14. Appendix — Code Anchors

| Concern | Anchor |
|---|---|
| Transport seam (renderer→backend) | `src/mainview/lib/rpc.ts:29` |
| RPC registration (8 groups) | `src/bun/rpc-registration.ts:36` |
| Handler groups | `src/bun/rpc-groups/*.ts` |
| Broadcast mechanism | `src/bun/engine-manager.ts:252` |
| Broadcast catalog | `src/shared/rpc/webview.ts` |
| Plan approval | `src/bun/agents/tools/pm-tools.ts:1604` |
| Shell approval | `src/bun/engine-manager.ts:333` |
| User question | `src/bun/engine-manager.ts:416` |
| Dashboard PM concierge | `src/bun/rpc/dashboard.ts:563` |
| Custom-agent chatbots | `src/bun/rpc/dashboard-agent.ts:51` |
| Per-project engine cache | `src/bun/engine-manager.ts` |
| Projects (machine-local) | `src/bun/rpc/projects.ts` |
| Auto-Earn outbox | `src/bun/rpc/freelance-outbox.ts` |
| Native session host (desktop-only) | `src/mainview/components/freelance/session-webview-host.ts` |
| Notifications | `src/bun/notifications/desktop.ts` |

---

*Related: [`web-app-prd.md`](./web-app-prd.md) (the alternative route) · `docs/prd.md` · `docs/workflow.md`.*
