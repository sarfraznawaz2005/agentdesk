# Auto-Earn — Autonomous Freelance Engine (Plan)

> **Update (2026-06-08, later session): AUTONOMOUS PHASE + BID AUTOMATION +
> BACKGROUND ENGINE shipped and runtime-verified on the user's real account.**
> Built since the status note below: the `freelance-expert` agent + tools (vault,
> jobs state machine, escalations, job facts); real Freelancer **bid-form
> automation** (amount/days/proposal fill — bids are NEVER auto-placed, the user
> always clicks Place Bid); the **always-on background engine** (`AlwaysMountedInbox`
> + `freelance-engine-store`) so sync / notifications / full-auto sending run on
> ANY page like auto-shortlist (deferred ~4s after launch); the `autoearn`
> flag-file gate (preserved across Setup + portable updates + dev rebuilds);
> per-currency earnings on the dashboard; `awaiting_review` outbox state + failed
> Retry/Dismiss; configurable default delivery days; `maxSendsPerHour` default
> lowered 4→1. **See §12–13 for what's implemented beyond this plan and the known
> limitations / future revisions.**

> **Status (2026-06-08): FULL FEATURE CODE-COMPLETE.** All 18 follow-up tasks
> (TASK-416…433) done; `bun run typecheck` clean. Built: migrations v35+v36
> (accounts/threads/messages/users/outbox/action_log + correlation cols); the
> PlatformAdapter seam (`shared/freelance/platforms.ts`); the Behavior Governor +
> humanize/write-steps; account status/connect/disconnect/autonomy; correlation
> cascade; Auto-Earn settings (master switch, off by default); the assisted reply
> pipeline + outbox approval UI; jittered auto-sync; full-auto path; CAPTCHA/re-auth
> handling; bidding pipeline + own-bid correlation; template-variation guard; realtime
> WebSocket tap; feature gating + docs. **Pending: live runtime verification**
> (restart + real send/bid on the user's account — only the user can do this).
> **Scope of slice 1:** Freelancer.com only. **PeoplePerHour was REMOVED** (RSS
> source, descriptor, and existing-user setting via migration v37) — may return later.
> **Next phase:** the autonomous `freelance-expert` agent + tools (tasks TASK-434…451).
> **Builds on:** the existing `freelance/` feature (RSS discovery, wizard
> shortlist, per-listing chat strategist). This plan adds the *act* layer:
> logged-in session, inbox sync, and a human-gated / full-auto reply+bid pipeline.

---

## 1. Goal

Turn the freelance feature from a **discovery + analysis** tool into an
**autonomous earning loop**:

```
discover (have) → shortlist (have) → READ INBOX (new) → DRAFT reply/bid (new)
  → APPROVE or AUTO-SEND (new) → track outcome (new)
```

The headline user-facing feature: **read the platform inbox inside AgentDesk,
see client messages, and approve AI-drafted replies** — without the freelance
account being flagged or banned as a bot.

---

## 2. The anti-ban philosophy (load-bearing — read first)

This single principle drives every technical decision below.

1. **Reuse the real, trusted session. Never spoof it.** Anti-detect / fingerprint
   browsers (obscura, Camoufox, CloakBrowser) are built to make *fresh fake
   identities* look real. We have the opposite problem: **one real account the
   platform already trusts.** Wrapping it in a randomized fingerprint reads as
   *account takeover* and is an instant risk-team trigger. So we use the user's
   real cookies, one stable device/fingerprint (the app's own webview), and a
   one-time in-app login. Anti-detect tooling is reserved **only** for anonymous,
   sessionless public-listing scraping (no login) — which RSS already covers.

2. **Bans are behavioral, not fingerprint-based.** Upwork's 2025 disclosures:
   ban signals are submission intervals < 4 s, identical proposal templates,
   abnormal proposal velocity, feed-scraping cadence, and non-human Submit
   timing. Therefore the **Behavior Governor** (jitter, rate caps, active-hours,
   template variation) is the real anti-ban system — not stealth.

3. **The "Submit / Send" click is the bright line.** Reading your own inbox is
   low-risk (pages you're entitled to see). *Sending* is what platforms police.
   So autonomy is a per-platform dial:
   - **Assisted (default):** AI drafts → user edits inline → user clicks Send.
     The user's click *is* the human action the platform requires. Near-zero risk.
   - **Full-auto (opt-in, loud warning):** governor-paced auto-send. Real
     (reduced) risk; user's account, user's explicit choice.

---

## 3. Architecture — three layers over the existing ground floor

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 0 — Discovery (EXISTING)                                    │
│  RSS fetch + wizard auto-shortlist. No login, no risk.             │
├──────────────────────────────────────────────────────────────────┤
│  Layer 1 — Session Engine (NEW)                                    │
│  Electrobun BrowserWindow w/ persistent cookies (model:            │
│  annotations/preview-window.ts). One-time in-app login. Drives     │
│  pages via executeJavascript (click/type) +                        │
│  evaluateJavascriptWithResponse (scrape). Behavior Governor on top.│
├──────────────────────────────────────────────────────────────────┤
│  Layer 2 — Inbox Sync (NEW)  ← headline feature, low-risk          │
│  Jittered poll of the messages page → DOM parse → store →          │
│  broadcast → native thread UI in AgentDesk.                        │
├──────────────────────────────────────────────────────────────────┤
│  Layer 3 — Reply & Bid Pipeline (NEW)                              │
│  Reuse freelance-chat strategist to draft. Assisted (edit+click)   │
│  or Full-auto (governor-paced). Template-variation enforced.       │
└──────────────────────────────────────────────────────────────────┘
```

### Substrate decision (corrected after Electrobun 1.18.1 source review)
The session lives in an **`<electrobun-webview>` tag embedded in the main React
view**, NOT a separate `BrowserWindow`. Reason: in the installed Electrobun
(1.18.1), `BrowserWindow.init()` does **not** forward the `partition` option to
its `BrowserView` — so a `BrowserWindow` cannot hold a *named persistent*
session. The webview tag **does** accept `partition`, `preload`, and emits
`host-message`/`did-navigate`, and its custom element is auto-registered by
Electrobun's injected preload (`preload/index.ts` → `customElements.define`).

Confirmed-available primitives (1.18.1):
- `<electrobun-webview partition="persist:freelance-<platform>" preload="…">` —
  persistent, process-isolated (OOPIF) session that survives restart *(pending
  spike confirmation)*.
- `Session.fromPartition("persist:freelance-<platform>").cookies.get({domain})` —
  Bun-side cookie inspection → drives logged-in/logged-out status detection.
- `wv.callAsyncJavaScript({script})` — read DOM / run actions in the page.
- `wv.on("host-message")` ← `window.__electrobunSendToHost(...)` from preload —
  the channel that carries intercepted network JSON out of the page (§3a).
- `wv.on("did-navigate")`, `loadURL`, `reload`, navigation rules.

Stagehand (TypeScript) remains an *optional* later add for AI element-finding
when a selector drifts — not a Phase-1 dependency.

---

## 3a. Robust extraction — "ride the platform's own API" (READ path)

DOM-scraping rendered HTML is brittle and breaks on every redesign. Instead we
**intercept the structured JSON the platform's own SPA already fetches over its
own authenticated session.** Freelancer.com is a SPA backed by versioned
endpoints (e.g. `/api/messages/0.1/threads/`, `/api/messages/0.1/messages/`) and
a realtime socket; the rendered inbox is just a view over that JSON.

```
preload script (runs before page JS, injected via the webview tag's preload=)
  → monkeypatches window.fetch + XMLHttpRequest + WebSocket
  → tees responses whose URL matches messaging endpoints
  → window.__electrobunSendToHost({ type:'fl:threads'|'fl:messages', payload })
host (React) → wv.on('host-message') → RPC to Bun → normalize → DB → broadcast
```

Why this is the robust **and** ban-safe choice:
1. **Resilient** — we consume versioned JSON, not HTML. UI redesigns don't break
   it; only backend API changes do (rare, and `/0.1/`-versioned).
2. **Ban-safe** — every request is issued by the *genuine page* with genuine
   cookies/headers/TLS fingerprint. We only *observe* the page's own traffic.
   We NEVER replay these calls from Bun — non-browser-UA API calls are a
   documented Upwork/Freelancer ban signal.
3. **Solves correlation for free** — the JSON already carries `threadId`, member
   user-ids (client identity), **project id**, timestamps, and message bodies →
   directly powers the listing↔thread matching cascade (§4a) with zero scraping.
4. **Realtime** — wrapping `WebSocket` taps the platform's own push socket → new
   messages appear without polling, perfectly human (it's the page's own socket).

**Fallback ladder** when an endpoint isn't interceptable: (a) DOM read via
`callAsyncJavaScript` with selectors isolated in the per-platform adapter; (b)
AI-assisted locate (Stagehand-style) only when selectors drift. Primary path
makes these rare.

### WRITE path (send reply / submit bid)
Done through the **UI**, human-paced — focus composer, dispatch realistic
per-character `input` events with jitter, then click Send. We deliberately do
NOT call the send API directly from injected JS: genuine input events keep it
behaviorally human and respect the bright line (and in Assisted mode the human
clicks Send themselves).

---

## 4a. Listing ↔ thread correlation cascade (best-effort, never blocking)

An unmatched message is still a first-class inbox item; a matched one gets richer
drafting context. Match order, most reliable → fallback:
1. **Own-bid trail (gold):** when we submit a bid via `freelance_outbox`, capture
   the platform's returned project/bid id → write the `listingId↔thread` link
   directly. The client's later reply carries the same project id → certain match.
2. **ID match:** thread JSON's project id == a stored `freelance_listings.externalId`.
3. **Title fuzzy-match:** flagged `probable`, never authoritative.
4. **Client grouping:** cluster all threads by `clientExternalId` independently.
5. **Unmatched bucket:** invites / cold DMs with no known listing — expected, fine.

---

## 4. Database schema (migration **v35**)

New Drizzle tables in `src/bun/db/schema.ts` + raw SQL in
`src/bun/db/migrations/v35_freelance-auto-earn.ts`.

### `freelance_accounts` — one connected login per platform
| column | type | notes |
|---|---|---|
| `id` | text PK | uuid |
| `platform` | text | `freelancer` \| `peopleperhour` |
| `displayName` | text | scraped username, for UI |
| `status` | text | `connected` \| `logged_out` \| `error` |
| `autonomyMode` | text | `assisted` \| `full_auto` (per-account) |
| `lastSyncAt` | text | ISO |
| `lastErrorAt` / `lastError` | text | last sync failure |
| `createdAt` / `updatedAt` | text | |

> Credentials are **never** stored. Only the platform's own cookies live in the
> webview partition on disk (like a normal browser profile).

### `freelance_inbox_threads`
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `accountId` | text FK | |
| `platform` | text | |
| `externalThreadId` | text | platform's thread/conversation id (dedup key) |
| `clientName` | text | |
| `subject` / `listingTitle` | text | linked job if known |
| `listingId` | text FK nullable | resolved internal listing id (see §4a) |
| `listingExternalId` | text | platform project/job id from thread JSON |
| `clientExternalId` | text | platform user-id of the client (cross-thread grouping) |
| `linkConfidence` | text | `certain` \| `probable` \| `none` |
| `lastMessageAt` | text | |
| `unread` | integer | 0/1 |
| `url` | text | deep link to the thread |
| `createdAt` / `updatedAt` | text | |
| unique index | | `(platform, externalThreadId)` |

### `freelance_inbox_messages`
(mirrors the existing `inbox_messages` shape for consistency)
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `threadId` | text FK | |
| `externalMessageId` | text | dedup key |
| `direction` | text | `inbound` (client) \| `outbound` (us) |
| `author` | text | |
| `body` | text | |
| `sentAt` | text | |
| `createdAt` | text | |
| unique index | | `(threadId, externalMessageId)` |

### `freelance_outbox` — drafted/queued replies & bids (the approval queue)
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `accountId` | text FK | |
| `kind` | text | `reply` \| `bid` |
| `threadId` | text FK nullable | for replies |
| `listingId` | text FK nullable | for bids |
| `draftBody` | text | AI draft (user-editable) |
| `finalBody` | text | what was actually sent (post-edit) |
| `status` | text | `draft` \| `approved` \| `sending` \| `sent` \| `failed` \| `rejected` |
| `autonomyMode` | text | how it was produced |
| `scheduledFor` | text | governor's earliest-send time |
| `sentAt` | text | |
| `error` | text | |
| `createdAt` / `updatedAt` | text | |

### `freelance_action_log` — audit trail for rate-limiting & forensics
| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `accountId` | text FK | |
| `platform` | text | |
| `action` | text | `login` \| `inbox_sync` \| `send_reply` \| `submit_bid` |
| `outcome` | text | `ok` \| `blocked` \| `error` |
| `detail` | text | |
| `createdAt` | text | indexed — governor queries recent actions per account |

---

## 5. New backend modules (`src/bun/freelance/`)

```
freelance/
├── session/
│   ├── session-window.ts     # Electrobun BrowserWindow per platform (singleton
│   │                         #   per account); login detection; executeJavascript /
│   │                         #   evaluateJavascriptWithResponse wrappers. Modeled on
│   │                         #   annotations/preview-window.ts.
│   ├── governor.ts           # Behavior Governor: jittered delays, per-account rate
│   │                         #   caps, active-hours window, "min gap between sends",
│   │                         #   queries freelance_action_log. THE anti-ban core.
│   └── humanize.ts           # human-paced typing (per-char delay + jitter), random
│                             #   reading pauses, scroll-before-act helpers.
├── platforms/
│   ├── types.ts              # PlatformAdapter interface (login-check, scrapeInbox,
│   │                         #   scrapeThread, sendReply, submitBid selectors/JS).
│   ├── freelancer.ts         # Freelancer.com DOM scrapers + action scripts.
│   └── peopleperhour.ts      # PeoplePerHour DOM scrapers + action scripts.
├── inbox-sync.ts             # jittered poller → adapter.scrapeInbox → upsert threads/
│                             #   messages → broadcast freelance.inbox.updated.
├── reply-pipeline.ts         # draft (reuse strategist prompt) → enqueue outbox →
│                             #   assisted: surface for edit; full-auto: governor send.
└── auto-earn-settings.ts     # new settings keys (section 8).
```

### `PlatformAdapter` interface (the extension seam)
Each platform implements pure functions that return **JS strings** to run in the
session webview (scrape) or **action steps** (type/click). Adding Upwork later =
one new file, no engine changes.

```ts
interface PlatformAdapter {
  platform: "freelancer" | "peopleperhour";
  isLoggedInScript(): string;                 // → boolean
  scrapeInboxScript(): string;                // → ThreadStub[]
  scrapeThreadScript(threadUrl: string): string; // → Message[]
  sendReplySteps(threadUrl: string, body: string): ActionStep[];
  submitBidSteps(listingUrl: string, proposal: BidFields): ActionStep[];
}
```

---

## 6. RPC contracts (`src/shared/rpc/freelance-auto-earn.ts`)

| RPC | Purpose |
|---|---|
| `freelance.account.connect(platform)` | open session window for in-app login |
| `freelance.account.status(platform)` | connected / logged-out / error |
| `freelance.account.disconnect(platform)` | close window, clear partition |
| `freelance.account.setAutonomy(platform, mode)` | assisted \| full_auto |
| `freelance.inbox.getThreads(accountId, page)` | list threads |
| `freelance.inbox.getMessages(threadId)` | thread detail |
| `freelance.inbox.syncNow(accountId)` | manual sync trigger |
| `freelance.outbox.list(status?)` | the approval queue |
| `freelance.outbox.draftReply(threadId)` | AI-draft a reply |
| `freelance.outbox.draftBid(listingId)` | AI-draft a proposal |
| `freelance.outbox.updateDraft(id, body)` | **user inline edit** |
| `freelance.outbox.approveSend(id)` | assisted: send the edited body now |
| `freelance.outbox.reject(id)` | discard draft |

Broadcasts (extend `freelance/events.ts`):
`freelance.inbox.updated`, `freelance.inbox.newMessage`,
`freelance.outbox.updated`, `freelance.account.statusChanged`,
`freelance.governor.blocked` (when a send is rate-deferred).

---

## 7. Frontend (`src/mainview/components/freelance/`)

- **`auto-earn-tab.tsx`** — new tab on the freelance page. Sub-views:
  - **Accounts:** connect/disconnect per platform, autonomy toggle, status dot.
  - **Inbox:** thread list + thread view (native, in-app). Reuses message-bubble
    styling from `components/chat/`.
  - **Approval queue (Outbox):** drafts with an **inline editor**; per item:
    *Edit → Approve & Send* (assisted) or auto-send badge (full-auto). Kill-switch.
- **`auto-earn-settings.tsx`** — autonomy mode, rate caps, active-hours, the
  Full-auto risk acknowledgment checkbox.

---

## 8. New settings keys (category `freelance`, via `auto-earn-settings.ts`)

| key | default | meaning |
|---|---|---|
| `freelance_autoearn_enabled` | `false` | master switch |
| `freelance_autonomy_mode` | `assisted` | global default (per-account overrides) |
| `freelance_inbox_poll_min` / `_max` | 180 / 480 (s) | jitter window |
| `freelance_active_hours` | `{start:9,end:22}` | active-hours window (uses the **global** timezone from Settings → General) |
| `freelance_max_sends_per_hour` | **1** | governor cap (bids stricter: half, min 1) |
| `freelance_min_gap_seconds` | 90 | min gap between any two sends (bids wait 3×) |
| `freelance_fullauto_ack` | `false` | user accepted full-auto risk |
| `freelance_notify_desktop` | `true` | desktop notification on a new client reply |
| `freelance_notify_channels` | `false` | also forward new client reply to connected channels |
| `freelance_bid_delivery_days` | 7 | default "delivered in" days prefilled on a bid |

> **Feature gate:** the entire Auto-Earn surface (settings card, Inbox/Auto-Earn
> tabs, background engine) only appears when an `autoearn` flag file (no extension)
> sits next to the exe — same mechanism as the `freelance` flag, and preserved
> across Setup-installer updates (`updater.ts`), portable updates
> (`updater-portable.ts`), and dev rebuilds (`run.ps1`).

---

## 9. Phase breakdown & deliverables

| Phase | Deliverable | Acceptance |
|---|---|---|
| **P1 — Session Engine** | `session-window.ts` + governor skeleton; `account.connect` opens a window, user logs into Freelancer.com, `isLoggedInScript` returns true, session survives app restart. | Manual: connect, restart app, still connected. |
| **P2 — Inbox Sync** | `freelancer.ts` + `peopleperhour.ts` scrapers, `inbox-sync.ts`, tables, broadcasts, read-only inbox UI. | Real client threads appear in-app; jittered poll logged in `action_log`. |
| **P3 — Reply Pipeline (Assisted)** | `reply-pipeline.ts` draft via strategist prompt; outbox queue; inline edit; **Approve & Send** types into the real session (human-paced) — user still confirms. | A drafted reply, edited, sends and appears in the platform thread. |
| **P4 — Governor + Full-auto + Settings** | rate caps, active-hours, template-variation, Auto-Earn settings tab, full-auto opt-in path. | Full-auto sends respect caps/jitter; logs prove no two sends < min gap. |
| **P5 — Bids** | `submitBidSteps`, `draftBid`, bid governor caps (stricter than replies). | A proposal drafts + (assisted) submits on a shortlisted listing. |

Check in at every phase boundary.

---

## 10. Risks & open questions

1. **Electrobun webview cookie persistence across restarts** — preview-window
   persists *window state* but not verified for *cookies/storage partition*.
   **P1 spike must confirm** the webview keeps the platform session on disk; if
   not, fall back to the CDP-attach-to-real-Chrome option discussed.
2. **DOM scraper fragility** — platforms redesign. Mitigation: keep selectors in
   the per-platform adapter; add Stagehand AI-fallback later; alert the user on
   scrape-shape mismatch rather than silently failing.
3. **PeoplePerHour / Freelancer ToS** — automated messaging still risks the
   account in full-auto. The Behavior Governor + assisted-default minimize this;
   full-auto stays opt-in with an explicit warning. User has accepted this trade.
4. **CAPTCHA / re-auth challenges** — on challenge, governor pauses the account
   and broadcasts `account.statusChanged` so the user logs in manually in the
   same window. Never auto-solve CAPTCHAs.
5. **Existing users** — all new tables/keys are additive; feature gated behind
   `freelance_autoearn_enabled=false` by default, so existing installs are
   unaffected until opt-in.

---

## 11. Out of scope (deferred, intentionally)

- Upwork adapter (strictest detector — add after the pattern is proven).
- Agent-native platforms (DealWork/ClawGig/BotBounty/Circle APIs) — revisit for
  genuine unattended earning once big-platform slice ships.
- Anti-detect scraping engine (obscura/Camoufox) for anonymous discovery —
  optional enhancement, not needed while RSS covers discovery.

---

## 12. Implemented beyond this plan (2026-06-08)

What actually shipped on top of the original P1–P5 plan, for accuracy:

- **`freelance-expert` autonomous agent** (`src/bun/freelance/expert/`): runs the
  full-auto worker via `runInlineAgent` with its own tools — credential `vault.ts`,
  `jobs.ts` state machine, `notify.ts` escalations + desktop/channel alerts, and
  `tools.ts` (notify_human, mark_state, save/list important client detail, store/
  list credentials, git_clone, remote list/download/upload, download_attachment,
  send_reply, submit_bid, self_review, create_project). Hidden agent; runs ONLY in
  full-auto + risk-ack; triggered on a **new inbound message** (not on new listings).
- **Real Freelancer bid-form automation** (`shared/freelance/write-steps.ts`
  `buildSubmitBidScript`): waits for the SPA bid form, fills **Bid Amount**,
  **delivery days**, and the **proposal textarea** (human-paced), via label-proximity
  / placeholder heuristics. **Bids are NEVER auto-placed** — even in full-auto it
  prefills + desktop-notifies and parks the item as `awaiting_review`; the user
  always clicks **Place Bid**. Bid amount = avg(budget range) / single value / blank
  (→ user fills). Real URL resolved from `freelance_listings.url` (fixes the old
  `/projects/<dbId>` 404).
- **Always-on background engine** — `<InboxTab/>` is mounted once at the app shell
  via `components/freelance/always-mounted-inbox.tsx`, portaled into a STABLE DOM
  node and **re-parented** between the freelance Inbox-tab slot and a hidden holder
  (`stores/freelance-engine-store.ts`). So the webview sync, interceptor, and
  full-auto send loop run on **any page** (like auto-shortlist); the native webview
  is only shown while the Inbox tab is on screen. Startup is **deferred ~4s** so it
  never competes with app launch. **This runs in BOTH modes** (gated on the master
  switch): assisted gets background sync + notifications everywhere but still
  requires the user to draft/approve/send; full-auto also auto-drafts + auto-sends
  replies in the background.
- **Outbox lifecycle hardening** — `awaiting_review` state for prefilled bids
  (Mark-as-placed / Dismiss); `failed` items show the error + **Retry**/**Dismiss**;
  send safety-timeout scaled to body length (long proposals).
- **UX** — Create Proposal button (renamed from Draft Proposal; shortlisted-only;
  loading state; auto-switches to Inbox on success); auto-growing draft textarea;
  full-width + tall (90vh) inbox preview; per-currency earnings on the dashboard.
- **The autonomy descriptor narrowed** — Freelancer.com only; PeoplePerHour removed
  (migration v37). Migrations went to **v35–v39** (inbox, outbox/action_log, PPH
  removal, expert pipeline jobs/credentials/log/escalations, job_facts).

---

## 13. Known limitations & future revisions (2026-06-08)

Captured after the autonomous + bid + background work shipped. None block current
use — these are the next improvements when we revisit.

### 13.1 The big one — reactive, not proactive (top backlog item)

**Neither mode auto-bids on *new* listings.** Full-auto only handles **existing
conversations** (inbound messages). To generate leads you must click **Create
Proposal** on shortlisted listings yourself. There is **no "bid while I sleep"
trigger wired.** For someone trying to *earn*, this is the most important gap.

> **Future:** wire auto-shortlist → optionally auto-**draft/prefill** proposals for
> shortlisted listings, governor-capped, **still human-placed** (stays within the
> "bids are human-placed" rule). The `freelance-expert` already exposes a
> `bid_request` trigger that nothing calls yet — this is where to hook it.

### 13.2 Known limitations

- **Bid form selectors are heuristic** — validated on a couple of real forms, but
  Freelancer DOM changes (or unusual project types: hourly, sealed/NDA bids,
  extra-field forms) could make fills silently fail. Mitigated by
  assisted-stops-for-review + the failed/retry UI, but not hardened for every variant.
- **Bid pricing is naive** — avg-of-budget / single / blank. No undercutting, no
  floor/ceiling, no hourly handling.
- **Delivery days is a flat default** — not derived from the project's stated timeframe.
- **Session fragility** — everything depends on the live Freelancer session. If it
  logs out or hits a CAPTCHA, the engine pauses and waits for you to re-login in the
  live session (it detects + prompts, but can't auto-solve).
- **Full-auto worker is genuinely high-risk** — autonomously cloning repos, building,
  and delivering to real paying clients is the riskiest surface. It has guardrails
  (self-review before delivery, escalate-on-uncertainty, never sign/pay/go
  off-platform), but mistakes reach real clients and your reputation.

### 13.3 Future enhancements (backlog)

- **Cold-bid trigger** — see §13.1 (highest leverage).
- **Message triage before auto-reply** — classify inbound messages; route
  payment/contract/off-platform/scope-dispute ones to escalation instead of
  auto-replying (extra safety on top of the agent's guardrails).
- **Proposal QA pass** — a quick self-check before queueing to catch over-promising
  or hallucinated claims (reputation protection at scale).
- **Governor visibility** — surface "next send allowed in X / sends used this hour"
  so the throttling isn't a black box.
- **Global quiet/pause** — a "pause all autonomy for X hours" beyond the kill-switch.
- **Stale-bid expiry** — auto-dismiss or re-alert `awaiting_review` bids older than
  N hours (the project is probably already awarded).
- **Bid strategy settings** — undercut-average %, min/max clamps, hourly vs. fixed.
- **Dashboard analytics** — win-rate, response time, bids→won conversion.
