# Ambient Mode — PM Voice Assistant Redesign (Plan)

> **Status: implemented** (all 7 subsystems, TASK-567 through TASK-574). Real
> deviations found during the build, kept here for historical accuracy:
> - **Simple reads use tools too, not context-injection.** Subsystem 2's open
>   question resolved in favor of uniformity — every status question goes
>   through a real tool call (list_projects/get_project_status/etc.), same as
>   dispatch, so the tool-call pane always has something to show and the
>   turn's behavior doesn't fork depending on question type.
> - **Anticipated tool set grew beyond the original 6.** Per explicit
>   confirmation to broaden scope, added `get_review_queue`, `get_inbox_summary`,
>   `get_scheduled_jobs`, `get_freelance_summary`, `get_git_status` — see
>   Section 2's "anticipated extra tools" table for what each reuses vs. what
>   was newly built.
> - **TTS model picker needed an extra filter the plan didn't anticipate.**
>   Filtering by the model-classification "speech" tag alone wasn't enough —
>   a real custom/OpenAI-compatible provider in testing had models literally
>   named `voxtral-mini-tts-*`, correctly tagged "speech" by the naming
>   heuristic, but `@ai-sdk/openai-compatible` has no `.speech()` accessor at
>   all. The picker now also requires `providerType === "openai"` (real,
>   non-custom OpenAI) — the only provider whose adapter actually implements
>   `generateSpeech` today.
> - **TTS model generation, and the pause-based auto-stop's real audio
>   timing, could not be fully live-tested end-to-end** — this sandbox has no
>   microphone and no real OpenAI API key configured. Each was verified as
>   deeply as the environment allows (real RPC calls, real error paths, real
>   timing on the parts that don't need a microphone or a paid API key) —
>   see TASK-570/TASK-573's recorded evidence for exactly what was and
>   wasn't exercised live.
>
> Supersedes Ambient Mode's original voice design (`ambient-screen-plan.md`
> Subsystem 5), which tied "Talk to PM" to whatever project conversation
> happened to be active. This redesign makes it a real cross-project voice
> assistant: status queries across all projects, and dispatching new work
> into any project by name — with live tool-call visibility and natural,
> pause-based turn-taking instead of a manual stop button.

## Confirmed decisions (from user Q&A before writing this plan)

- **Dispatch persistence**: a voice command that dispatches work into a
  project creates/uses a **normal, persisted conversation** in that project —
  identical to typing the request there. No separate "voice-only" storage.
- **Quick-ack generation**: reuse the **existing configured PM model/agent
  infrastructure** for generating the instant warm-up phrase — not a new,
  hardcoded, or separately-provisioned model.
- **STT unchanged**: keep the existing free/local Web Speech API
  (`useVoiceInput`/`webkitSpeechRecognition`) — no cloud/online STT option.
- **TTS becomes configurable**: add a setting (Ambient Mode section) letting
  the user pick a TTS **model**, not just stick with the browser's built-in
  `speechSynthesis`. Browser TTS remains the zero-config default.
- **Process**: write this plan, get it reviewed/approved, then break into
  AITasks and implement — same process the original Ambient Mode used.

---

## 1. The core problem: per-project engine, cross-project questions

`AgentEngine` (`src/bun/engine-manager.ts`) is instantiated **one per
project** — every existing `sendMessage`/dispatch path assumes a specific
`projectId` + `conversationId`. Ambient Mode's current voice code
(`ambient-screen.tsx`'s `handleVoiceEnd`) just reuses whatever
`activeProjectId`/`activeConversationId` happen to be set in the global chat
store — which is `null` unless the user already had some project's chat open,
and even then it can only ever answer about *that one* project.

The user's examples span three different needs:
- *"Which agents are working?"* — cross-project read, no single project scope.
- *"How many tasks are done in project X?"* — single-project read, but named
  by the user, not by whatever happens to be "active."
- *"Start working on X feature for project Y"* — a genuine dispatch, into a
  project that may not be open at all right now.

None of these fit "reuse the active conversation." They need a small
orchestrator with its own cross-project tools.

## 2. New subsystem: the Ambient Assistant

A new, minimal agent role — **not** a per-project `AgentEngine` instance, a
lightweight one-shot tool-calling turn run directly from the ambient RPC layer
(`src/bun/rpc/ambient.ts` or a new `src/bun/ambient/assistant.ts`), reusing
the user's already-configured default provider/model (same one PM chat uses
today — no new provider selection just for this).

**Tool set** (all backed by data this app already computes elsewhere — no new
data model, just new tool wrappers around existing functions):

| Tool | Backed by (already exists) |
|---|---|
| `list_projects` | `getProjectsList()` |
| `get_project_status(projectId)` | `getProjectTaskStats()` + `getActiveProjectAgentsList()` filtered to one project |
| `list_active_agents` | `getActiveProjectAgentsList()` (all projects) |
| `get_recent_activity` | `getRecentGlobalActivity()` — the ring buffer added for the projected/TV Activity Log |
| `get_pending_approvals` | `getGlobalPendingApprovalCount()` (count) + per-project detail if needed |
| `dispatch_to_project(projectId, instruction)` | **New**: resolves/creates a conversation in that project, then calls the exact same `sendMessage` path the normal chat UI uses — the target project's own PM takes it from there (plan/approve/execute, kanban, review — nothing about that pipeline changes) |

`dispatch_to_project` is intentionally a *handoff*, not a reimplementation —
the ambient assistant never runs coding agents itself; it only ever answers
questions directly or hands real work to the project that owns it.

**Anticipated extra tools** (confirmed in scope — user approved covering
channels/scheduler/freelance/git too, "users may ask things I can't
imagine"). Feasibility checked against the real codebase before adding these,
not assumed:

| Tool | Backed by | Notes |
|---|---|---|
| `get_review_queue` | **New query** on `kanban_tasks` (`column='review'`, no project filter, joined to `projects` for names) | No existing cross-project "review column" query — `getProjectTaskStats()` only groups done-vs-total, not by column. Small, straightforward addition to `src/bun/rpc/kanban.ts`. |
| `get_inbox_summary` | `getUnreadCount()` (`src/bun/rpc/inbox.ts:81`) | Already cross-channel (Discord/WhatsApp/Email all funnel into one `inbox_messages` table). Per-platform breakdown would need a new grouped query — v1 can just report the total unless per-channel detail turns out to matter. |
| `get_scheduled_jobs` | `getCronJobs()` (`src/bun/rpc/cron.ts:50`) | Already returns every job with `nextRunAt`/`isRunning` — direct reuse, no new backend work. |
| `get_freelance_summary` | `getListingCounts()` (`src/bun/rpc/freelance.ts:235`) | Already a ready-made aggregate (`new`/`approved`/`shortlisted`/`closed`/`bids`/`all`) — direct reuse. |
| `get_git_status(projectId)` | `getCurrentBranch()` + `getGitStatus()` (dirty file count) + `getPullRequests(projectId, "open")` (`src/bun/rpc/git.ts`, `pulls.ts`) | No single existing aggregator — this tool combines 3 existing calls, mirrors what `git-tab.tsx`/`pull-requests.tsx` already do client-side. |

All of the above are **read-only**. No new destructive/mutating tools beyond
`dispatch_to_project` — which itself only ever routes through the same
plan-approval-gated pipeline every other dispatch already goes through, so it
carries no new risk.

**Project name resolution**: the assistant resolves a spoken project name to
a `projectId` itself (it has `list_projects` as a tool, so it can look up the
closest match before calling `dispatch_to_project` — no separate fuzzy-match
layer needed, this is just normal tool-calling reasoning).

**Open question for implementation**: does answering "which agents are
working" need the assistant to have tools at all, or can the read-side stats
just be included directly in its system-prompt context (like the existing
`AmbientActivitySnapshot`) so simple status questions never need a tool round
trip at all — only `dispatch_to_project` is a "real" tool call? This would
make simple status questions *feel* instant (no visible tool-call step) while
still showing the tool pane for actual dispatches. Recommend prototyping
this shape first since it directly affects how "instant" simple queries feel.

## 3. Turn-taking: pause-based, not manual stop

Replace the manual tap-to-stop with silence detection built on the existing
`useVoiceInput` hook's `onresult` stream:

- Track time since the last `onresult` event (a debounce timer, reset on
  every new result — interim or final).
- After **N ms of no new results** (proposed default: 1.6s — long enough to
  survive a mid-sentence pause, short enough to feel responsive; make this a
  named constant so it's trivially tunable), treat the utterance as complete
  and call `stop()` automatically — same effect as today's manual button tap,
  just automatic.
- The existing tap-to-toggle button stays as a manual override (barge-in,
  or forcing an early end) — this is additive, not a replacement of the
  control itself.

This is pure client-side logic in `use-voice-input.ts` (or a new
`use-voice-turn-detection.ts` wrapping it) — no new dependency.

## 4. Quick-ack, then real turn

Two-phase response, both spoken via TTS:

1. **Instant ack** (fires the moment silence-detected end-of-turn happens):
   one small `generateText` call (no tools, short system prompt: *"the user
   just said X — respond with a single short natural acknowledgment/filler,
   like a human would while about to go check something; do not answer the
   question yet"*) using the same already-configured model. Spoken
   immediately.
2. **Real turn** (fires in parallel with #1, or right after): the Ambient
   Assistant's actual tool-calling turn — tool calls stream live into the new
   side pane (Subsystem 5), and the final answer is spoken once ready.

Both phases target the *same* underlying question — the ack is generated
from the raw transcript before the real turn's tool calls have run.

## 5. Live tool-call side pane

New UI: a panel that slides in from the right (animated) whenever the
Ambient Assistant's real turn starts, replacing the current plain
orb-and-caption "engaged" view content (that view stays for phases without
tool activity — the panel is additive when there's something to show).
Shows:
- Each tool call as it happens (name + key args, à la the normal chat UI's
  tool message parts — reuse that visual language, not a new one).
- The evolving/final answer text once available.

Reuses the existing `partCreated`/`partUpdated` broadcast pattern — the
ambient assistant's one-shot turn should emit the same kind of part events
the normal per-project engine does, so this pane can subscribe the same way
`chat-store.ts` already does, rather than inventing a second event shape.

## 6. TTS model setting

- Default stays the current `speechSynthesis` (`use-text-to-speech.ts`) — no
  config required, works offline, zero cost.
- New Ambient Mode setting: pick an alternate TTS **model** from the user's
  configured AI providers. AI SDK v7 already exports a ready-made
  `generateSpeech({ model, text, voice, ... })` function and `SpeechModel`
  type — this app's model-classification system
  (`src/bun/providers/model-classification.ts`) already tags models as
  `"speech"` type today (used for model-type badges elsewhere), so the
  picker can filter to models already classified that way instead of a new
  taxonomy.
- **New, small provider wiring needed**: none of `src/bun/providers/*.ts`
  currently expose a `.speech(modelId)` accessor (grepped — zero hits) even
  though the underlying `@ai-sdk/*` provider packages support it natively.
  This needs a new bun-side `generateAmbientSpeech(text, modelId)` helper
  wired the same way `generateText` calls are already built per-provider, an
  RPC to call it, and the audio response played in the renderer (replacing
  the `speechSynthesis.speak()` call when a model is configured).

## 7. What does NOT change

- Kanban, plan-approval, review-cycle — completely untouched; dispatched
  work flows through the exact same per-project pipeline as typed chat.
- The existing Activity Log / radar / stat-strip ambient screen — the
  "ambient" sub-state is unaffected; only the "engaged" (voice) sub-state
  changes.
- STT — unchanged, still the free local Web Speech API.

---

## Open technical questions to resolve during implementation

1. Does `list_active_agents`/status data belong in the ambient assistant's
   system-prompt context (always-available, no tool call, feels instant) vs.
   as callable tools (visible in the tool pane, consistent with dispatches)?
   Recommend: context for pure reads, tools only for anything that mutates
   state (`dispatch_to_project`) — but worth a quick prototype to see how it
   feels before committing.
2. Exact silence-detection threshold (proposed 1.6s) — tune after first
   real test.
3. Whether `dispatch_to_project` always creates a **new** conversation per
   voice command, or has a "continue the most recent conversation in that
   project" heuristic. Recommend always-new (simplest, no ambiguity about
   which conversation "recent" means) unless real usage shows this is
   annoying.
4. Provider-specific TTS wiring (`.speech()`) needs checking per provider
   the user actually has configured (OpenAI's `tts-1`/`tts-1-hd` are the
   most likely first target; other providers may not support speech models
   at all — the settings picker should only list providers/models that are
   actually classified `"speech"`).

## Verification (end-to-end, once built)

1. Say "which agents are working right now" with no project chat open —
   answered directly, no dispatch, no conversation created.
2. Say "how many tasks are done in [project name]" — answered from that
   project's real kanban data.
3. Say "start working on [feature] for [project name]" — a new, persisted
   conversation appears in that project's chat history with the PM already
   responding/planning, exactly as if typed there.
4. Speak, pause mid-sentence for <1.6s, keep talking — turn does not end
   early.
5. Stop talking for >1.6s — turn ends automatically, no button tap needed.
6. Quick-ack phrase is spoken within roughly a second of turn-end, and its
   wording actually varies based on what was asked (not a fixed string).
7. Tool-call pane slides in during any dispatch/status-lookup turn, showing
   each tool call as it happens, then the final spoken answer.
8. Toggle an alternate TTS model in Settings → replies are spoken with that
   voice instead of the browser default; toggle back → browser default
   resumes with no restart needed.
