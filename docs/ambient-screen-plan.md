# Ambient Mode — Implementation Plan

> **Status: implemented** (all 7 subsystems). See `docs/feature-list.md`'s
> "Ambient Mode" entry for the shipped file map. Deviations discovered during
> implementation, kept here for historical accuracy against the plan below:
> - **Font substitution**: Beacon's mockup uses Google-Fonts Rajdhani/JetBrains
>   Mono; the shipped version uses the platform's own sans/mono stacks instead,
>   since this app self-hosts its one custom font rather than loading from a
>   CDN (desktop app, should render correctly offline). The radar sweep, amber
>   accent, and sharp panels — not the exact typeface — are Beacon's signature.
> - **Idle-blocking mechanism**: rather than a single shared "modalOpen" flag,
>   the idle timer's blocking check combines a generic `[data-state="open"]`
>   Radix Dialog/AlertDialog query (covers every dialog with zero per-dialog
>   wiring), `chat-store`'s existing global `shellApprovalRequests`, and two
>   new one-line DOM marker attributes (`data-plan-approval-pending` on the
>   plan card, `data-voice-listening` on the voice button) — there was no
>   existing global plan-approval-pending boolean to reuse.
> - **`requestFullscreen()` confirmed refused without a user gesture** (tested
>   live) — the idle-triggered path only ever achieves the in-window overlay,
>   never true OS fullscreen. Expected, not a bug (see Risks below).
> - **"Project to display" is single-window-at-a-time** (v1) — opening a new
>   projection replaces whatever was already projected, rather than supporting
>   multiple simultaneous projected displays.
> - **TV-mode testing caveat**: verified live on a single-monitor development
>   machine (display picker, window open/close round-trip, real second
>   `BrowserWindow` creation all confirmed) — the specific "stays on a
>   genuinely separate second monitor while the main window keeps working on
>   the primary" scenario needs a real multi-monitor machine to fully confirm.

## Context

AgentDesk's Dashboard already tracks live, cross-project agent activity in real time —
`dashboard.tsx`'s `activeProjectAgents` (per-project running-agent counts) and `taskStats` are
driven by `agentInlineStart`/`agentInlineComplete` broadcasts that `engine-manager.ts` fans out to
the main window for every project (not just the one currently open — the frontend filters by
`projectId`). **Ambient Mode** surfaces that same live state as a full-screen, voice-interactive
"command screen": a button on the Dashboard opens it on demand, and it can also auto-activate after
N idle minutes (screensaver-style), scoped to **AgentDesk having focus** — confirmed decision, not
true OS-wide idle. Dismissed with Esc, same as a real screensaver.

Voice input already exists app-wide (`useVoiceInput`, Web Speech API `SpeechRecognition`). The one
genuinely new capability this plan adds is **TTS** (spoken replies) — everything else is new
*presentation* over data AgentDesk already has, or a thin reuse of the existing PM chat pipeline.
Deliberately out of scope: no external PM-tool integration, no CRM/leads, no new PM tools — voice
Q&A in Ambient Mode only ever asks the PM things it can already answer today (kanban/project status),
per the user's explicit "nothing from what they do except TTS."

**Visual direction confirmed:** `mockups/ambient-screen/14-beacon.html` ("Beacon") — a radar/sonar ops
scope with a sweeping beam, project blips pinging on contact, and a single amber accent. Future visual
work should iterate on that file directly rather than the generic description in Subsystem 6.

**Three additional confirmed requirements:**
1. Ambient Mode must be projectable onto a second display / TV, not just the machine's own screen.
2. The "Talk to PM" control must work on touch (a touchscreen TV/monitor), not just mouse/keyboard.
3. The mic is **off by default** — tapping "Talk to PM" is what switches into listening mode, it never
   listens continuously in the background.

## Key architecture decision: overlay in the main window, not a second `BrowserWindow`

Quick Chat's `window.ts` shows the real cost of a second native window: its own `BrowserWindow`,
its own `createRpc()` instance (sharing one `rpc` object across windows silently repoints the first
window's in-flight transport — confirmed live, see `quick-chat/window.ts`'s header comment), its own
window-state persistence, and — critically for this feature — `broadcastToProject` only reaches
`projectWindows.get(projectId) ?? mainWindowRef`. A brand-new dedicated window registered for no
project would receive **none** of the per-project events Ambient Mode needs, unless it's added to a
new global fan-out list — a real change to a hot path in `engine-manager.ts`.

None of that is needed here for the **default** case. The user's own framing — idle scoped to
"AgentDesk itself has focus," full screen, Esc to dismiss — matches an **in-window overlay**, not a
separate OS-level window:
- Render it as a fixed, full-viewport component mounted at the app-shell level (same tier as
  `UserQuestionDialog`/`Toaster` in `app-shell.tsx`), not a route change — so closing it returns to
  exactly whatever page/conversation was underneath, no navigation round-trip.
- It's already living inside the main window, so it gets every `broadcastToProject` event the
  Dashboard gets today, for free — zero backend changes.
- True full-screen visual via the browser Fullscreen API (`documentElement.requestFullscreen()`) on
  activation, `exitFullscreen()` (or the browser's own Escape handling) on dismiss.

**Exception — "Project to display" mode (Subsystem 7).** Projecting onto a physical second screen/TV
while the main window keeps working normally on the primary monitor genuinely needs a second, real
`BrowserWindow` positioned on that display — content confined to the main window can never appear on
a display the main window isn't on. This reintroduces the exact cost flagged above, but it's a
**known, already-solved** cost: Quick Chat's `window.ts` already proves the pattern (own
`createRpc()` per window, own navigation lockdown, own lifecycle) works safely. "Project to display"
is treated as an **additional, optional** mode layered on top of the default overlay, not a
replacement for it — most opens (button press, idle timeout) still use the cheap in-window overlay;
only an explicit "Project to display" action opens the second window.

## Subsystem 1 — Settings (`src/mainview/pages/settings/general.tsx` + generic KV store)

No schema/migration needed — reuse the existing generic `settings` table via `rpc.getSettings("general")`
/ `rpc.saveSetting(key, value, "general")`, the exact mechanism `allow_quick_chat` already uses.
- Extend `ApplicationSettings` (general.tsx:36) with: `ambientModeEnabled: boolean` (default `true`),
  `ambientModeIdleMinutes: number` (default `15`), `ambientModeVoiceEnabled: boolean` (default
  `true`), `ambientModeTtsEnabled: boolean` (default `true`).
- Add the matching `rpc.saveSetting("ambient_mode_enabled"/"ambient_idle_minutes"/..., value, "general")`
  calls next to the existing `allow_quick_chat` save (general.tsx:320) and a small settings-card UI
  (`Switch` + numeric `Input`, same components already imported in this file).

## Subsystem 2 — Idle detection (frontend-only, app-focus-scoped)

New hook, e.g. `src/mainview/lib/use-idle-timer.ts`:
- Listens for `mousemove`/`keydown`/`mousedown`/`wheel` on `document` to reset a countdown timer set
  to `ambientModeIdleMinutes * 60_000`.
- Listens for `window` `blur`/`focus` (or `document.visibilitychange`) to **pause** the countdown
  while AgentDesk isn't the focused window and resume on refocus — this is what makes it "AgentDesk
  itself has focus" rather than true OS-wide idle; no native binding required.
- Must be suppressible: don't fire while a modal is already open (`UserQuestionDialog`, plan-approval
  card, shell-approval prompt), while Ambient Mode is already active, or while the user is mid
  voice-dictation in a chat input. Wire this as a simple "is anything blocking?" check the hook
  consults before firing — the exact source of truth (a ref set by whichever dialog is open, or a
  small shared "modalOpen" flag) is an implementation-time call once the current dialog-state wiring
  is inspected.
- The Dashboard's "Ambient Mode" button triggers the same activation function directly, bypassing
  the idle timer.

## Subsystem 3 — Ambient Mode overlay component

New `src/mainview/components/ambient/ambient-screen.tsx`, mounted once in `app-shell.tsx` (guarded
by an `open` boolean in a small store/context, e.g. `ambient-store.ts`, so both the Dashboard button
and the idle-timer hook can trigger it without prop-drilling):
- On mount: `document.documentElement.requestFullscreen().catch(() => {})` — best-effort; some
  engines refuse `requestFullscreen()` without a direct user gesture, so an idle-triggered activation
  may only ever get the in-window overlay (still full-viewport, just not real OS fullscreen). Treat
  that as expected degraded behavior, not a bug — verify actual behavior for both the button (real
  user gesture) and idle-timer (no gesture) paths during implementation.
- `keydown === "Escape"` listener unmounts the overlay (and calls `exitFullscreen()` if still in
  fullscreen — browsers usually auto-exit on Escape already, but the overlay itself needs its own
  unmount regardless).
- Two visual sub-states: **ambient** (idle ticker/orbit view, no mic) and **engaged** (voice
  listening/thinking/speaking, live transcript) — engaged triggers on a button press or on detected
  speech.

## Subsystem 4 — Cross-project live data (reuse, don't rebuild)

- Factor Dashboard's existing per-project aggregation (`activeProjectAgents`, `taskStats`, the
  `agentInlineStart`/`agentInlineComplete`/`kanbanTaskUpdated` listeners) out of `dashboard.tsx` into
  a shared hook, e.g. `useGlobalAgentActivity()` in `src/mainview/lib/`, so Dashboard and Ambient
  Mode read the same live state instead of duplicating listener wiring — this is a refactor of
  existing logic, not new backend surface.
- Add a rolling in-memory activity log (last N events, e.g. 50) inside that same hook — each
  `agentInlineStart`/`agentInlineComplete`/`kanbanTaskUpdated` event appends a line ("Backend Engineer
  moved TASK-042 to review in acme-web") for the ticker. Pure frontend state, no persistence needed.
- Project names: reuse whatever the Dashboard already has cached (`rpc.getProjects()` / a projects
  store if one exists) rather than re-fetching — confirm the actual store during implementation.
- Pending-approval count ("N tasks waiting on you"): check whether plan-approval / review state is
  already tracked in `chat-store.ts` or similar before adding a new counter.

## Subsystem 5 — Voice interaction (STT reuse + new TTS)

- **STT**: reuse `useVoiceInput` (`use-voice-input.ts`) as-is for capturing speech to text inside
  Ambient Mode's engaged state.
- **Routing**: transcribed text is submitted as a normal message through the existing chat/PM
  pipeline (the same `sendMessage` path chat already uses), not a second conversational engine —
  keeps "PM is the sole orchestrator" intact and means Ambient Mode automatically answers anything PM
  can already answer (kanban status, task counts, review results) with zero new tools.
- **TTS (new)**: new hook `src/mainview/lib/use-text-to-speech.ts`, sibling to `use-voice-input.ts`,
  wrapping `window.speechSynthesis` / `SpeechSynthesisUtterance`. Feature-detect the same way voice
  input does (`use-voice-input.ts`'s header comment confirms `webkitSpeechRecognition` works under
  WebView2 on Windows but was never implemented by WKWebView on macOS — `speechSynthesis` likely has
  the same split; verify at implementation time and degrade to captions-only, no crash, where
  unsupported).
- Speak once the PM's full reply text has arrived for v1 (simplest, no token-stream sync); chunieing
  TTS per sentence as tokens stream in is a reasonable v1.1 follow-up, not required initially.
- **Barge-in**: if `useVoiceInput` detects speech while `speechSynthesis.speaking` is true, call
  `speechSynthesis.cancel()` immediately.
- **Mic off by default, tap-to-toggle** — matches the `14-beacon.html` mockup's "Talk to PM"
  button/`engage()` demo exactly: the mic never listens until the user explicitly taps the button,
  and stays off in between exchanges rather than continuously open. This is a tap-to-start/tap-to-stop
  toggle, not a hold-to-talk control — avoids the mic picking up ambient room conversation as chat
  input, and matches "no background listening" as a hard requirement, not just a nice-to-have.
- **Touch-friendly "Talk to PM" button** — a plain `<button>` with a standard `onClick`/`useVoiceInput`
  `toggle()` handler already works on touch for free: Chromium/WebView2 dispatches touch taps through
  the same Pointer Events path as mouse clicks, so no touch-specific event wiring is needed. Two real
  considerations remain: (1) size the tap target generously (44px+ per standard touch-target
  guidance — the mockup's button padding already lands in that range, verify at implementation time),
  and (2) add `touch-action: manipulation` in CSS to remove the ~300ms tap delay / accidental
  double-tap-zoom browsers apply by default on touchscreens.

## Subsystem 6 — Visual design (confirmed: Beacon)

Build directly from `mockups/ambient-screen/14-beacon.html` rather than re-deriving the visual design
from scratch — it's the approved direction, not one option among several:
- **Ambient (idle) state**: the radar/sonar scope — sweeping conic-gradient beam, one blip per active
  project (pinging while an agent is running on it, dimmed/static when idle), blip labels showing
  agent + current task, a contact log panel, an ambient stat strip (agents active now, tasks completed
  today, awaiting-you count), a clock.
- **Engaged (voice) state**: the ping-ring/core animation already in the mockup, live transcript of
  both sides of the conversation (useful with sound off, and to confirm STT heard correctly).
- Sharp-edged bordered panels, no backdrop blur/glassmorphism, single amber (`#FFB020`) accent against
  a near-black background — carry this restraint forward; it's *why* this direction survived multiple
  rounds against softer/glowier/multi-hue alternatives.
- Pure CSS/SVG (conic-gradient sweep, radial blips) — no new rendering dependency needed for v1.

## Subsystem 7 — Project to display / TV mode

Confirmed feasible: Electrobun's native Windows binding already exposes `Screen.getAllDisplays()`
(`node_modules/electrobun/dist-win-x64/api/bun/proc/native.ts`), not just `getPrimaryDisplay()` (the
one `quick-chat/window.ts` already uses) — full multi-display enumeration is available today, no new
native dependency needed.

- **New "Project to display" control**, surfaced from the Ambient Mode overlay itself (or Settings):
  lists connected displays via `Screen.getAllDisplays()` (label by resolution/position since Windows
  display names aren't always human-meaningful — verify what fields the API actually returns at
  implementation time) and lets the user pick one.
- **New `src/bun/ambient/window.ts`** (mirrors `quick-chat/window.ts`'s proven shape):
  `openAmbientDisplayWindow(displayId)` — opens a dedicated, `frame: false` `BrowserWindow` positioned
  at the chosen display's bounds, its own `createRpc()` instance (never the shared main-window `rpc`
  object — same reasoning as Quick Chat), fullscreen on that display. Loads the same Ambient Mode
  overlay component/route as the in-window version so there's exactly one implementation of the
  screen itself, not two.
- **Live data feed for the projected window**: since this window belongs to no single project,
  `broadcastToProject`'s per-project routing doesn't reach it by default (same gap noted in the
  architecture-decision section above). Rather than modifying the hot broadcast path in
  `engine-manager.ts` for what is fundamentally a passive display, **v1 polls** a snapshot RPC (e.g.
  `getAmbientActivitySnapshot()`, backed by the same aggregation `useGlobalAgentActivity()` — Subsystem
  4 — already computes) every few seconds. Wiring the projected window into the live push-broadcast
  path is a reasonable v1.1 follow-up if polling latency proves noticeable, not required initially.
- **No keyboard assumption**: a TV/kiosk setup likely has no attached keyboard, so Escape-to-dismiss
  can't be the only exit. Add a visible, touch-reachable "Exit" control in the overlay whenever it's
  running in a projected window (the in-window/main-monitor case can keep relying on Esc alone, since
  a keyboard is implicit there).
- **Independent lifecycle**: the projected window's close behavior mirrors Quick Chat's own window
  (`quick-chat/window.ts`'s `close` handler) — closing it must not affect the main window or vice
  versa; opening a second display window while the main window is mid-conversation must not disrupt
  either.

## Ordering & dependencies

1. Settings fields (Subsystem 1) — inert until wired, safe to land first.
2. `useGlobalAgentActivity()` extraction from `dashboard.tsx` (Subsystem 4) — pure refactor, verify
   Dashboard still behaves identically before building on top of it.
3. `use-text-to-speech.ts` (Subsystem 5) — the one genuinely new capability; prototype standalone
   (e.g. a temporary debug button) to confirm `speechSynthesis` behavior on Windows/WebView2 before
   wiring it into the overlay.
4. Ambient overlay shell + Esc/fullscreen handling (Subsystem 3) — build the ambient (idle) visual
   state first since it has no voice dependency.
5. Idle timer hook (Subsystem 2) wired to the settings from step 1.
6. Voice engaged-state wiring (STT → chat pipeline → TTS reply) — depends on 3 and 4, and is where
   touch-friendliness (generous tap target, `touch-action: manipulation`) and the mic-off-by-default
   tap-to-toggle behavior get built in from the start, not retrofitted.
7. "Project to display" mode (Subsystem 7) — additive, built last since it depends on the overlay
   component (step 4) already existing as a reusable piece; confirm `Screen.getAllDisplays()`'s actual
   return shape early in this step since the rest of the subsystem depends on it.

## Risks

- **Fullscreen without a user gesture.** Idle-triggered `requestFullscreen()` may be silently
  refused by the engine since there's no direct click/keypress initiating it — confirm actual
  behavior; the in-window overlay alone is an acceptable fallback if so.
- **TTS/STT platform gap.** `SpeechSynthesis` support under WebView2 (Windows) vs. WKWebView (macOS)
  needs the same feature-detect-and-degrade treatment `useVoiceInput` already applies — must not
  crash or silently do nothing with no indication on unsupported platforms.
- **Idle false-triggers.** Must not pop up Ambient Mode over an in-progress plan-approval dialog,
  shell-approval prompt, or mid-stream agent response — needs an explicit suppression check before
  firing, not just a bare timer.
- **Mic picking up ambient conversation.** Tap-to-toggle (not continuous listening) inside Ambient
  Mode avoids accidentally submitting unrelated room audio as a chat message.
- **Display metadata quality.** `Screen.getAllDisplays()`'s actual return shape (resolution, position,
  a usable label) hasn't been inspected yet — the "pick a display" control's UX depends on what's
  actually there; verify before designing that picker.
- **No keyboard on a projected/kiosk display.** Relying on Esc alone to exit would strand a TV setup
  with no attached keyboard — the projected window needs its own visible, touch-reachable exit control.
- **Projected-window data staleness.** Polling (v1's choice for the projected window's live feed,
  Subsystem 7) trades a few seconds of latency for not touching the hot broadcast path — acceptable
  for a passive display, but worth confirming the interval feels "live enough" during review.

## Verification (end-to-end)

1. Dashboard button opens Ambient Mode instantly, full-viewport, over whatever page was open;
   underlying page/conversation state is untouched after closing.
2. Set idle timeout to 1 minute in Settings, leave AgentDesk focused and idle → activates
   automatically at ~1 minute; alt-tab away and stay idle elsewhere → does NOT activate.
3. Esc closes Ambient Mode from both idle and engaged states, returning to the exact prior view.
4. With two projects running agents (e.g. via `run_agent` on each), Ambient Mode's ticker/nodes show
   both, live, without needing a manual refresh — same data Dashboard already shows.
5. Push-to-talk a status question ("what's happening in <project>") → PM answers through the normal
   chat pipeline, transcript shows both sides, and the reply is spoken aloud.
6. Start speaking while a reply is being spoken → playback stops immediately (barge-in).
7. Toggle `ambientModeEnabled` off in Settings → idle timer never fires; Dashboard button still
   opens Ambient Mode on demand regardless (confirmed decision: the setting only gates auto-idle
   activation, never the manual button).
8. On a touchscreen display, tap "Talk to PM" (no mouse/keyboard involved) → mic activates
   immediately, no tap-delay; confirm the mic was silent beforehand (off by default).
9. "Project to display" onto a connected second monitor/TV → opens full-screen there while the main
   window keeps working normally on the primary display; live data on the projected window updates
   without needing the main window's project to be open; the projected window's on-screen exit control
   closes only that window.

Run via `.\run.ps1` per the visual-testing note; the user restarts the app themselves to test.
Run `bun run typecheck` / `bun run lint` once after all tasks are complete (not mid-build).

## Docs to update as it lands

`docs/ambient-screen-plan.md` (this file), `docs/feature-list.md` and `docs/feature-list-short.md`
(new feature — required by CLAUDE.md's standing rule), `docs/workflow.md` if the overlay/store
pattern is worth documenting as a reusable UI pattern, and `CLAUDE.md` if any new settings keys or
architectural pattern should be called out there.
