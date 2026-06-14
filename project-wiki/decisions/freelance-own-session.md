---
title: Freelance Uses the Real Session (no anti-detect)
type: decision
status: verified
verified_at: 2026-06-14
sources:
  - src/mainview/components/freelance/session-webview-host.ts
  - src/shared/freelance/platforms.ts
  - src/shared/freelance/write-steps.ts
  - src/bun/freelance/session/governor.ts
  - src/bun/rpc/freelance-outbox.ts
  - src/mainview/components/freelance/inbox-tab.tsx
tags: [freelance, security]
---

# Freelance Uses the Real Session (no anti-detect)

**The Auto-Earn engine drives the freelancer's *own*, real, logged-in browser
session and never spoofs its fingerprint.** For an account you own, anti-detect
tooling (rotating user-agents, canvas/WebGL noise, proxy IPs) is
counterproductive: a genuine session that suddenly looks like a *different*
device is itself a strong fraud signal. The platform already knows who you are;
the only thing that gets accounts banned is **behavior** — velocity, off-hours
machine-gun sending, sub-second submits, identical templates, and direct
(non-browser) API calls. So the entire defensive budget is spent on *behaving
like a human*, not on *hiding the machine*.

## Key idea

Two opposite strategies exist for automating a web account:

| Strategy | When it fits | Why it's wrong here |
|---|---|---|
| **Anti-detect** (spoof fingerprint, proxies, fresh profiles) | Accounts you don't own / multi-accounting / scraping at scale | A *real* account whose fingerprint keeps changing reads as account takeover → flagged. See memory note "anti-detect-wrong-for-own-account". |
| **Real session + behavioral pacing** (this app) | One account, owned by the user | Matches the truth: same device, same login, same session the user already uses. Risk is purely behavioral, so that's all we defend. |

This decision flows through three layers of the code, top to bottom.

## How it works

### 1. One persistent, real session (the substrate)

The freelance inbox is an `<electrobun-webview>` bound to a persistent partition
`persist:freelance-freelancer` (`session-webview-host.ts:18-20`,
`:44`). "Persistent" means cookies/localStorage survive restarts — it is the
*same* logged-in session every time, exactly like reusing a browser profile.
The element is created **once for the app's lifetime and never destroyed** (only
hidden/repositioned) — see `session-webview-host.ts:1-14`; that exists to avoid
a native-overlay leak, but it also means there is a single stable session rather
than a churn of fresh contexts.

Crucially, **nothing sets a fake `user-agent`, no proxy, no canvas/WebGL
masking, no fingerprint shim.** `getSessionWebview` (`session-webview-host.ts:40-45`)
only sets `partition` + `src`. The platform descriptor in
`platforms.ts:49-78` carries URLs, capture-endpoint rules, and composer
selectors — and conspicuously **no** anti-detect config, because there is none.
The reads are passive too: a fetch/XHR interceptor *tees* the platform's own
messaging JSON (`platforms.ts:57-63`) — it doesn't forge requests. See
[[freelance-autoearn]] for the full read/write pipeline.

### 2. Writes are genuine user input, never API calls

A send is built as an in-page script that focuses the real composer and types
the body **character-by-character with jitter and reading pauses**, dispatching
real input events, then clicks the real Send button
(`write-steps.ts:1-11`, `:25-37`). The header states the rationale outright:
"a non-browser API call is a documented ban signal, and bypassing the UI looks
automated" (`write-steps.ts:4-8`). Inter-keystroke delays use `Math.random` on
purpose — a `Date.now()`-derived sequence forms a deterministic recurrence that
keystroke-dynamics detection can spot (`write-steps.ts:22-30`). The send is
also **verified**, not assumed: it polls until the composer clears before
reporting success (`write-steps.ts:39-45`).

### 3. The Behavior Governor is the actual anti-ban core

Because risk is behavioral, the defense is a single gate every outbound action
passes through — the governor (`governor.ts:1-13` spells out the thesis: "Bans
are behavioral, not fingerprint-based"). Every send calls `gateSend`
(`governor.ts:297-312`), which enforces:

- **Minimum gap** between sends, **per action type** — replies and bids are
  separate streams so a paying client's reply isn't throttled by cold-bid
  volume (`governor.ts:175-184`, `:272-279`).
- **Hourly cap**, with bids getting half the reply cap (a flurry of proposals
  is the loudest spam signal) and **3× the gap** (`governor.ts:253-254`,
  `:281-284`).
- **Daily bid budget** on top of the hourly cap (`governor.ts:286-288`).
- **Active-hours window** so autonomous sends never fire at 4am
  (`governor.ts:225-232`, `:264-266`) — skipped only for a human-clicked
  assisted send, which is genuinely human at that hour.
- **In-flight-send guard** so a long, still-typing send can't let a second one
  slip through before its log row lands (`governor.ts:208-223`, `:268-270`).
- **Jittered scheduling** — `jitter()` is genuinely random, again to avoid a
  deterministic recurrence (`governor.ts:346-352`).

Every decision is logged to `freelance_action_log` for forensics and for the
rate-limit queries themselves (`governor.ts:153-170`).

### 4. Reacting to platform pushback (defend, don't evade)

The telling design choice: when the platform *does* push back, the app **pauses
and asks the human**, rather than rotating identity to dodge it. An in-page
watcher reports 429s anywhere, 403s on the messaging API, or a captcha/challenge
page as an anomaly (`inbox-tab.tsx:60-83`, `:542-547`). The bun side trips a
circuit breaker: it pauses all autonomy for a cool-off window and **escalates to
the human** to log in / clear verification, then resume manually
(`freelance-outbox.ts:520-539`). Sync keeps running while paused, but no
autonomous sends do. There is no "spin up a clean profile and keep going" path —
that would be the anti-detect move, and it's deliberately absent.

## Key files

| File | Role |
|---|---|
| `src/mainview/components/freelance/session-webview-host.ts` | Single persistent real session (`persist:freelance-freelancer`); no fingerprint shim |
| `src/shared/freelance/platforms.ts` | Platform descriptor — URLs, capture endpoints, composer selectors; no anti-detect config |
| `src/shared/freelance/write-steps.ts` | Human-paced character typing + real Send click (never a direct API call) |
| `src/bun/freelance/session/governor.ts` | Behavior Governor — gaps, caps, active hours, jitter, in-flight guard (the anti-ban core) |
| `src/bun/rpc/freelance-outbox.ts` | Anomaly circuit breaker: pause + escalate on 429/403/captcha |
| `src/mainview/components/freelance/inbox-tab.tsx` | In-page anomaly watcher (429/403/captcha → host) |

## Gotchas / Constraints

- **Do not "harden" this with anti-detect tooling.** Adding a spoofed
  user-agent, proxy, or fingerprint noise to the webview would make a real,
  owned session look like account takeover — the opposite of the intent. The
  threat model is behavioral only.
- **The governor is mandatory, not advisory.** Any new send path must route
  through `gateSend` (`governor.ts:297-312`); bypassing it re-introduces the
  velocity/timing signals the whole design exists to suppress.
- **Writes must stay in-DOM.** Never "optimize" a send into a direct call to the
  platform's `/messages` API — that is a documented ban signal
  (`write-steps.ts:4-8`).
- **Timing randomness uses `Math.random`, intentionally.** Don't switch
  jitter/keystroke delays to a `Date.now()` seed; the deterministic recurrence
  is detectable (`write-steps.ts:22-30`, `governor.ts:346-351`).
- Single-account by design. The persistent partition is one session per
  platform; this is not a multi-accounting tool.

## Related
- [[freelance-autoearn]]
- [[electrobun-webview-overlay]]

## Open questions
- Composer/send selectors in `platforms.ts:64-77` are best-effort and tuned from
  live DOM; they will drift when Freelancer.com changes its UI and have no
  automated verification yet.
