# Ambient Mode voice: continuous listening + barge-in — research & design

Background for the "should always be listening, interrupt the PM mid-reply like
ChatGPT/Gemini voice mode" request. Covers how the reference implementations
work, why AgentDesk's stack can't copy them directly, and the design that was
actually implemented.

## How ChatGPT / Gemini / the open-source frameworks do it

**OpenAI Realtime API (ChatGPT Advanced Voice Mode)** and **Gemini Live API**
both stream raw PCM audio continuously from the client. Server-side VAD (or,
for OpenAI, a "semantic VAD" that scores whether the utterance sounds
grammatically complete) detects speech start/end. When speech is detected
*while the model is talking*, the server cancels the in-flight generation and
emits an explicit interruption event (`response.cancel` /
`serverContent.interrupted`). The client separately has to stop playing
whatever audio it already buffered, and OpenAI's protocol adds an
`audio_end_ms` marker so the model's own record of the conversation matches
what the user actually heard before cutting it off.

**LiveKit Agents** and **Pipecat** (the two major open-source voice-agent
frameworks) implement the same shape at the orchestrator level: the STT
component emits a "user started speaking" event, and the pipeline cancels
pending LLM/TTS tasks immediately. LiveKit's "adaptive interruption" goes
further — a model trained to distinguish a real interruption from
backchanneling ("mm-hmm", a cough, background noise), with a ~1s cooldown at
the start of the agent's turn so genuine early interruptions still pass
through but false positives from ordinary listener noises don't cut the agent
off.

**Open-source projects** (Vocalis, openlive, huggingface/speech-to-speech,
vui) all follow the identical shape: VAD → STT → LLM → TTS as one cancelable
pipeline, built on raw microphone streams with real echo cancellation (AEC).

## The gap: all of the above run on raw audio + AEC — AgentDesk doesn't

This is the load-bearing constraint for the whole design. Every system above
streams raw PCM through a pipeline with acoustic echo cancellation, which is
what lets the mic stay "hot" while the speaker plays the agent's own voice
without the mic hearing it back.

AgentDesk's `use-voice-input.ts` uses the browser's `SpeechRecognition` /
`speechSynthesis` (Web Speech API) — a black-box, high-level API with **no
access to raw audio and no AEC control**. If the mic is left listening while
`speechSynthesis` plays through actual speakers (not headphones), it can pick
up the assistant's own voice and transcribe it — a feedback loop, not a
feature. There is no way to fix this from inside the Web Speech API; doing it
properly would mean replacing the STT layer with a raw `getUserMedia` +
real-AEC + VAD pipeline, a materially different (and non-trivial, new
dependency) architecture.

## What was decided

Given that constraint, three things were implemented, using **only** the
existing zero-dependency Web Speech API:

1. **Continuous hands-free loop.** Once a "Talk to PM" session starts, the mic
   automatically restarts after every turn — thinking, speaking, or plain
   idle — instead of requiring the user to tap "Ask again". The user's
   original pause-based turn segmentation (`SILENCE_MS` in
   `use-ambient-voice-turn.ts`) is unchanged; it's the same idea as OpenAI's
   `silence_duration_ms` / Gemini's `end_of_speech_sensitivity`, just a
   client-side transcript-change proxy instead of raw-audio VAD. A real "Stop"
   action was added (tapping while listening now ends the whole loop, not
   just the current utterance) to satisfy "listening until the user
   explicitly stops."

2. **Voice-triggered barge-in.** The mic is also kept alive during the
   "thinking" (backend answering) and "speaking" (TTS playing) phases. If the
   user starts talking during either phase, that's treated as an
   interruption: TTS is cancelled immediately if it's playing, and the new
   speech becomes the start of a fresh turn. A short arm delay (~700ms) after
   each phase begins avoids reacting to the very first instant of TTS/thinking
   start (mirroring LiveKit's cooldown-at-turn-start idea), which is the
   highest-risk moment for the mic to catch the tail of the user's own
   just-finished utterance or the assistant's opening syllable.

   Accepted limitation: without headphones, the mic can still occasionally
   pick up the assistant's own voice through the speakers and false-trigger a
   "barge-in" — there's no AEC available to prevent this on this stack. This
   is a known, documented tradeoff, not a bug to chase further without a
   bigger architecture change (see above).

3. **Stale in-flight turn is actually cancelled, not just discarded.**
   `runAmbientAssistantTurn` already accepted an `abortSignal` option, already
   threaded through both model-invocation paths (`streamText`'s `abortSignal`
   and the Claude Subscription CLI runner's `abortController` — the same
   plumbing the regular agent "Stop" button uses, which already distinguishes
   a user-cancelled turn from a timed-out one). It just wasn't being supplied
   with a real, user-triggered controller. The frontend now generates a
   `turnId` per turn and passes it to `runAmbientAssistantQuery`; the backend
   keeps a `Map<turnId, AbortController>` and exposes `cancelAmbientAssistantTurn(turnId)`.
   When a barge-in starts a new turn, the client calls that RPC for the
   *previous* turn's id before starting the new one.

   This is safe for the same reason the earlier "just discard the result"
   design was floated as the cautious option: JS's abort model is cooperative,
   not preemptive. Aborting the outer signal stops the model from generating
   further text or making further tool calls, but it does **not** reach inside
   an already-running tool `execute()` (e.g. `dispatch_to_project`, which
   itself doesn't check the signal) and force it to stop mid-flight — that
   call finishes and its side effect (a real dispatch into another project)
   commits regardless, exactly as if no cancellation had happened. So
   cancelling only ever prevents *further*, not-yet-started work from
   happening — never an already-in-progress side effect from completing
   halfway. The client-side `activeTurnIdRef` staleness check from the
   original design is kept as a belt-and-suspenders guard (e.g. against the
   cancel RPC itself failing, or a race between the abort firing and an
   answer already being in flight back to the client).

## Follow-up fixes found during self-review

Wiring up real cancellation (point 3 above) surfaced two bugs, both fixed in
the same pass:

- **A cancelled Claude Subscription CLI-path turn was treated as a real
  answer.** `runClaudeCliTask` already returned a distinct `status: "cancelled"`
  on abort, but `assistant.ts`'s handling only branched on `"failed"` and
  `"timeout"` — a cancelled turn fell through to the empty-text fallback,
  which set `fullText` to the cancellation summary ("Cancelled by user") and
  then pushed *that* into `conversationHistory` and emitted it as a genuine
  answer. Fixed by adding an explicit `cancelled` branch that throws instead
  (the `streamText` path was unaffected — it already throws on abort before
  reaching that code).
- **The tool-call pane could attribute a stale turn's parts to the wrong,
  newer turn.** Before this session's barge-in work, only one turn was ever
  in flight, so routing every incoming `ambient-assistant-part` broadcast to
  "whichever turn is currently active" was safe. Once a barge-in can leave an
  older turn still running server-side while a new one is live, that routing
  could misattribute the old turn's late-arriving events (including the
  "Cancelled by user" leak above) to the new turn's pane entry. Fixed by
  threading the frontend's own `turnId` through as `runAmbientAssistantTurn`'s
  `messageId` (reusing the id already added for cancellation), so the pane
  now matches each broadcast against the turn that actually produced it.

Also added: a superseded turn's pane entry now shows "— interrupted —" instead
of silently going quiet once discarded, so it reads as "you interrupted this"
rather than "the assistant never answered."

## What was explicitly not built

True automatic barge-in with real AEC (safe with or without headphones) would
require a raw-audio pipeline (`getUserMedia` + a VAD library, e.g. Silero VAD
or WebRTC VAD) replacing the current Web Speech API STT layer entirely — a new
dependency and a genuinely different architecture, not a tweak of the existing
hooks. Not attempted here; flagged as a future option if the current
speaker-echo limitation turns out to matter in practice.

## Follow-up research: is real AEC-based barge-in actually buildable here?

Revisited the "explicitly not built" gap above to find out what a raw-PCM
pipeline would concretely require, favoring **local/offline by default, cloud
API as an opt-in alternative** (mirrors the existing TTS provider pattern),
and prioritizing fast turnaround over maximum accuracy.

**Web Speech API is a dead end for this, confirmed** — it's a black-box
STT/TTS API with no raw-audio hook of any kind; there's no configuration or
flag that exposes PCM out of `SpeechRecognition`. Getting raw audio means
capturing it ourselves, full stop.

**The good news: sherpa-onnx (already integrated for the "Ryan" TTS voice)
already ships everything needed for local VAD + local ASR**, as one native
addon we've already wired up (`sherpa-onnx-node`, downloaded on demand exactly
like the TTS model — see `local-voice-manager.ts`):
- **Silero VAD** ships as a first-class model type (`sherpa_onnx.Vad`) — tiny
  (~0.2–2 MB depending on quantization/version), 16 kHz mono, processes
  fixed 512-sample (~32ms) windows, with `threshold` /
  `minSpeechDuration` / `minSilenceDuration` knobs — exactly the
  "is the user talking right now" signal a real barge-in needs, computed
  locally with no cloud round-trip.
- **Local ASR** — sherpa-onnx also bundles small, fast offline recognizer
  architectures (Moonshine, Whisper-tiny, Zipformer, Paraformer, SenseVoice).
  Moonshine in particular is built for short-utterance, low-latency
  transcription — a good fit for turn-based dictation rather than long-form
  streaming.
- k2-fsa's own example suite even ships the **exact pipeline shape we'd
  want**, already wired end-to-end:
  `test_vad_asr_non_streaming_moonshine_microphone.js` — mic → VAD-gated
  segments → Moonshine → text. We wouldn't be inventing this architecture,
  just porting a reference implementation that already exists.

**The mic-capture piece doesn't need the webview at all.** Those official
examples capture audio via `node-cpal` (Node bindings for Rust's CPAL —
WASAPI/CoreAudio/ALSA under the hood), a **native addon running in the Bun
backend process**, not the browser/webview. That sidesteps the open question
from the earlier whisper.cpp spike ([[voice-input-whisper]] memory) about
whether Electrobun's WebView2 even exposes `getUserMedia` to page JS — a
Bun-side native mic capture doesn't touch that question at all. `node-cpal`
publishes prebuilt per-platform binaries (no build tools needed), same
distribution shape as `sherpa-onnx-node` itself.

**So a fully local, offline, no-new-native-dependency-authoring pipeline is
realistic**: `node-cpal` for mic capture + sherpa-onnx's Silero VAD + a small
sherpa-onnx ASR model (Moonshine or Whisper-tiny, int8), all running in the
Bun backend, downloaded on first use exactly like the "Ryan" voice is today.
This alone would let the mic stay meaningfully "hot" during the **thinking**
phase without the Web Speech API's current limitations, and — same swap
point the TTS provider picker already uses — a cloud STT API (OpenAI
transcription, Deepgram, etc.) could sit behind the same VAD-gated-segment
interface as an opt-in alternative recognizer.

**What this does NOT solve by itself: barge-in safely during *speaking*.**
VAD + local ASR tells us *that* and *what* someone said — it does nothing
about the mic still physically hearing the assistant's own voice through the
speakers. That needs real acoustic echo cancellation (an adaptive filter fed
both the mic signal and the *exact* reference signal being sent to the
speakers, in the same clock domain), and here the picture is worse:
- There's no polished, prebuilt-binary AEC npm package the way there is for
  VAD/ASR/TTS. The two real algorithms (Speex's echo canceller, WebRTC's APM
  AEC3) exist as C/C++ libraries with no maintained Node binding we found —
  using either would mean authoring our own native addon, a materially bigger
  and riskier lift than anything above.
- Real AEC also needs the reference (speaker-out) signal available in the
  same process/clock domain as the mic capture. Today TTS audio plays through
  the **webview** (`speechSynthesis` / an `<audio>` element), while the mic
  capture above would run in the **Bun backend** — two different processes.
  Making AEC possible would mean *also* moving TTS playback itself to a
  native output stream (`node-cpal` supports output, not just input) so
  capture and playback share one clock — a second architecture change beyond
  swapping the STT layer.

**Recommendation:** the VAD+local-ASR piece (mic capture via `node-cpal`,
recognition via sherpa-onnx, both already-proven download-on-demand
dependencies) is a well-scoped, buildable improvement on its own — it fully
replaces Web Speech API's black box with something local, inspectable, and
tunable, and unblocks real barge-in during the *thinking* phase specifically
(no TTS audio playing yet, so no echo risk there at all). Real AEC for
barge-in *during speaking* is a separate, materially bigger effort (new
native addon with no existing maintained binding, plus moving TTS playback
to a native output stream) and should be scoped as its own follow-on
decision rather than bundled in.

## Implemented: local VAD + ASR speech input

Built as `src/bun/ambient/local-stt-manager.ts` — an opt-in alternative to
the Web Speech API path, selected via Settings → General → "Speech input" →
"Local (offline, continuous listening)". Ships as a new feature entry (see
`docs/feature-list.md`'s "Offline Ambient speech input"), not a replacement —
the Web Speech API path remains the default so no existing user's behavior
changes unless they opt in.

**Model selection — validated live, not assumed.** Before committing to a
model, a throwaway spike (`demo/stt-vad-spike/`, not shipped) exercised the
whole pipeline against real speech, not just synthesized audio:

1. `node-cpal` mic capture confirmed working under Bun on Windows (device
   enumeration + live stream, no crash) — the concrete unknown flagged above.
2. A synthetic TTS→VAD→ASR round-trip (using the existing "Ryan" voice's
   output as input) confirmed the pipeline end-to-end. But real human speech
   through a real mic exposed real accuracy problems synthetic audio didn't:
   **Moonshine-tiny** consistently mis-heard common words ("weather" → "the
   other"/"the better", repeatably, not a fluke). Compared four models
   side-by-side on the same live recordings (Moonshine-tiny/-base,
   Whisper-tiny.en/-base.en) via an offline re-decode tool — Moonshine-base
   won that first round (most accurate *and* fastest of the four). A second,
   longer live session with Moonshine-base still showed real misses (garbled
   segments, some empty transcripts on genuine speech). Adding **Whisper
   small.en** to the live comparison resolved it — noticeably more reliable
   on real speech than any of the four smaller models tried. Whisper small.en
   was the one actually built into the production pipeline.
3. Net effect of using *live* speech rather than only synthetic test audio
   for evaluation: the model choice changed twice as real problems surfaced
   that clean TTS-generated audio never would have exposed.

**Architecture actually shipped:**
- `node-cpal` (mic capture) + Silero VAD + Whisper small.en (int8), all via
  `sherpa-onnx-node` — downloaded on demand into
  `{userData}/ambient/local-stt/`, same pattern as the "Ryan" TTS voice.
  Reuses the TTS voice's engine copy read-only if already downloaded.
- Whisper's release archive bundles both fp32 and int8 weights; only the
  int8 files are used, and the fp32 copies are deleted right after
  extraction (~970MB of avoidable disk use otherwise).
- `useLocalSttTurn` (frontend) exposes the identical
  `{listening, finalizing, error, supported, toggle, stop}` shape as the
  existing `useAmbientVoiceTurn`, so `ambient-screen.tsx` swaps between the
  two turn sources (`const voice = localSttActive ? localStt : rawVoice`)
  without touching any of the barge-in/auto-restart/voicePhase logic already
  built for the Web Speech path. Each VAD-bounded segment is already a
  complete utterance, so this path skips the silence-timer/transcript-
  accumulation dance entirely — a real simplification, not just a swap.

**Still true, unchanged by this:** no acoustic echo cancellation was added.
This only replaces *how audio becomes text* — it does nothing for the
"speaking"-phase echo limitation described above. Barge-in during "thinking"
works cleanly on this path (VAD gives a hard, immediate start-of-speech
signal); barge-in during "speaking" is still tap-only, same as the Web
Speech path, for the same reason.

## Follow-up fix: merge window for mid-thought pauses

Confirmed live once the local pipeline was actually usable: VAD's own
`minSilenceDuration` (0.4s) is tuned for *segmentation* latency, not for
telling "the user is done talking" apart from "the user is still forming a
sentence." A natural pause while thinking — especially right after a
barge-in, saying a few words then pausing to compose the rest — reliably
exceeds 0.4s, so each pause produced a **second, independent VAD segment**,
which `processTurn` treated as a brand new turn: it cancelled the first
segment's still-in-flight backend call as if it were a fresh interruption,
rather than extending the same utterance. Real interruptions and mid-thought
pauses were indistinguishable at the point this bug lived (the frontend
turn-dispatch layer), even though VAD itself was working exactly as designed.

**What the reference systems do about this** (the actual answer to "how do
other systems figure this out," continuing the research above): they don't
rely on silence duration alone either.
- **OpenAI's semantic VAD** scores whether the transcribed utterance *sounds*
  grammatically/semantically complete, not just whether audio went quiet —
  "the weather in…" holds the turn open longer than silence alone would.
- **LiveKit's turn-detector** is a small model trained specifically on
  multi-turn conversational data to predict end-of-turn probability from the
  transcript (and audio features), with a short cooldown at the start of a
  turn so early genuine interruptions still land.
Both are trained-model solutions — a materially bigger lift than anything
else in this doc (training data, a model to host/run, ongoing tuning).

**What was actually built instead — a fixed merge window, not a model.**
`useLocalSttTurn` now buffers consecutive segments arriving within 700ms of
each other into one combined utterance (space-joined) before calling
`onSegment`/`processTurn`, resetting the window on each new segment; only
once 700ms passes with nothing new does it actually dispatch. `stop()`
(explicit "Stop" tap, or the effect that force-stops the mic the instant TTS
starts speaking) flushes whatever's buffered immediately rather than
dropping it. Net latency added: ~700ms after VAD's own ~0.4s close, so
~1.1s total silence before a turn is considered final — still faster than
the Web Speech path's old 1.6s `SILENCE_MS` debounce, and it fixes the
reported bug without training or hosting a new model.

**Honest limitation, not silently glossed over:** this is genuinely blunter
than a semantic detector — it can't tell "and then" (obviously continuing)
from "thanks, bye" (obviously finished) the way a real turn-completion model
could, so a very deliberate 700ms+ pause right after a truly complete
sentence still gets merged with whatever (if anything) follows within that
window. Flagged here as future work if the fixed window ever proves too
blunt in practice, not represented as equivalent to what OpenAI/LiveKit do.

## Log review (2026-07-20): merge window still misses multi-segment utterances when decode is slow

Reviewed a full `ambient.log` session end to end (identity, memory, new tools,
merge window, barge-in all exercised live). Everything worked — including a
weather question answered correctly via `read_skill` + `http_request`/
`web_search` — but the merge window from the fix above did **not** actually
combine a genuinely continuous utterance in one observed case: "Okay, can you
tell me how is the weather today?" / "I" / "want to know about the weather
today." / "Yes." — one continuous thought with normal thinking pauses — landed
as **four separate turns**, each barge-in-cancelling the previous one. Only
the last ("Yes.") reached the model, and it only produced a sensible answer
because `runAmbientAssistantTurn` keeps prior turns (even cancelled ones) in
conversation history, so the model reconstructed intent from the fragments.
That's three wasted ~8–11s Claude CLI calls (cancelled) before a useful reply.

Root cause: the 700ms merge window (`use-local-stt-turn.ts`) starts counting
from when the **decoded segment reaches the frontend**, not from when VAD
detected the pause. Whisper decode on this pipeline routinely took 1.3–10s per
segment (log timestamps confirm this — decode is synchronous on the Bun main
thread, so it also delays the segment-push event itself). By the time one
segment's text arrives, decode of the *next* segment may already be well
underway, and the real gap between "segment A's text is usable" and "segment
B's text is usable" regularly exceeds 700ms even for a normal thinking pause —
the merge window is comparing the wrong two timestamps. The fix that shipped
handles VAD's own quick segmentation gap correctly (confirmed working for
single-pause cases in the same log); it doesn't cover pauses that straddle a
slow decode.

**Fixed — options considered:** (a) key the merge decision off VAD's own
segment-boundary timestamps instead of frontend arrival time, so decode
latency stops eating into the window; (b) offload Whisper decode to a worker
thread so it stops blocking the main loop; (c) simply widen the window, which
helps but doesn't fix the root cause and adds latency to every turn (a 10s
decode would need an unworkable window size to reliably cover). (a) alone
doesn't fully solve it either: even with an accurate gap measurement, the
frontend still can't tell "no continuation is coming" from "a continuation is
still being decoded" without *some* signal, and a fixed backstop timeout runs
into the same conflation problem one level down. Implemented **(a) + (b)
together**, since they solve complementary halves of the same bug:

- **(b) Decode moved to a worker thread**
  (`local-stt-manager.ts`'s `getDecodeWorker`/`decodeInWorker`, worker source
  written to disk at runtime and loaded via `new Worker(pathToFileURL(...))`
  — same pattern as `db/maintenance.ts`'s `runVacuumInWorker`, long-lived
  instead of one-shot). VAD segmentation stays on the main thread (cheap);
  only the expensive Whisper inference moves off it. This isn't just a speed
  win — while decode blocked the main thread, incoming audio for a
  segment the user was speaking *during* another segment's decode wasn't
  even reaching VAD in real time, so onset detection itself was silently
  delayed by however long the prior decode took.
- **(a) True audio-domain silence gap, plus a segment-start signal.** Each
  VAD segment carries a sample-accurate `start` index already; the backend
  now tracks the previous segment's end sample and computes
  `silenceBeforeMs` — the real gap, measured in the 16kHz audio clock, unaffected
  by how long decode takes — and forwards it on `AmbientSttSegmentDto`.
  `use-local-stt-turn.ts` uses it to decide "does this continue the pending
  utterance" (≤1100ms → merge, else flush the old pending immediately and
  start fresh) the instant a segment's text arrives, no guessing. Answering
  "is a continuation still being decoded, or is the user really done" (needed
  for the tail-end backstop, where there's no next segment yet to measure a
  gap against) uses a new `ambientSttSegmentStart` push event, fired the
  moment VAD detects a segment — *before* decode even begins — so the
  backstop-flush timer only ever arms while nothing is in flight, regardless
  of how long that in-flight decode takes.

### Follow-up correction (same day, next log review): the segment-start signal fired too late

Restarted the app, re-tested, and reviewed the resulting log. The
`silenceBeforeMs`-based merge genuinely worked this time — "Can you take... "
+ "I always gather today." merged into one turn (`silenceBeforeMs=950`,
under the 1100ms threshold) instead of splitting. But a different pair in the
same session didn't merge when it should have: "Can you take?" /
"what projects do we have?" (`silenceBeforeMs=950`, same threshold, should
have merged) landed as two separate turns instead.

Root cause: `ambientSttSegmentStart` was wired to fire when popping a
**completed** segment off VAD's queue — which only happens once the user has
*finished* speaking the entire continuation and VAD's own 0.4s trailing
silence has closed it. That's not "the instant VAD detects a new segment,
before decode begins" as designed and documented above — it's "the instant
the *next* segment is already over." In the observed case, the user started
speaking segment 2 (per its `silenceBeforeMs`, sourced from the same sample
clock) *before* segment 1's decode had even finished — meaning the true
"start" signal, if it had fired at actual speech onset, would have arrived
in time to hold the flush-backstop open; instead it only arrived (rounding to
"segment complete") right as/after segment 1 was already flushed.

Fixed by switching to `vad.isDetected()` — a method already exposed by
`sherpa-onnx-node`'s VAD wrapper (`vad.js`) that reports whether VAD
currently considers itself *inside* an active speech segment, true within
`minSpeechDuration` (0.25s) of real speech resuming, long before that segment
closes. `local-stt-manager.ts`'s capture loop now edge-triggers
`onSegmentStart` off this flipping false→true, instead of off the
segment-pop loop. This is the actual "instant" signal the design called for.

Also bumped `FLUSH_BACKSTOP_MS` from 700ms to 1400ms as a secondary safety
margin: the `isDetected()` signal is now the primary defense (correct
regardless of decode speed), but a wall-clock backstop that's *shorter* than
`SILENCE_MERGE_THRESHOLD_MS` (1100ms) could in principle still race ahead of
it if a segment ever decoded in well under a second — not observed with
Whisper small.en in practice (1.3–10s per segment here), but cheap to close
off outright rather than leave as a latent edge case.

Net effect: the four-turn "weather" cascade from the first log review, and
the two-turn "Can you take? / what projects do we have?" split from the
second, should no longer happen — the same utterance now merges into one
turn regardless of how fast or slow any individual segment's decode is.
Latency for the common single-segment case grows slightly (~1.4s backstop
after that segment's own decode, up from ~700ms) — a real, deliberate
tradeoff for correctness, not an accident.

**Toast added, then explicitly reverted.** An "Interrupted before answering:
..." toast (`ambient-screen.tsx`) briefly fired whenever a turn was superseded
by barge-in, alongside the tool-call pane's existing inline "— interrupted —"
marker. Reverted per explicit direction: a barge-in is routine, expected
ambient behavior — it happens on purpose, often several times per session —
not something worth a notification each time. The pane's inline marker is the
only surfacing left for a superseded turn.

**A second, separate toast was found and fixed while investigating that
request** — a UI inspector screenshot of the live overlay showed not just the
(now-reverted) blue info toast but also a red "Cancelled by user" error
toast neither of these changes had added on purpose. Traced to
`rpc-registration.ts`'s `withErrorToast`: every RPC request handler is
wrapped globally so any thrown error broadcasts a `showToast` (`type:
"error"`) with the raw message, and `runAmbientAssistantQuery`
(`rpc/ambient.ts`) was re-throwing the cancellation error from
`runAmbientAssistantTurn` (`assistant.ts` line ~509, `throw new
Error(cliResult.summary)` where `summary` is literally `"Cancelled by
user"`) straight through that wrapper — a barge-in cancel is not an
application error, so it shouldn't get the same generic error-toast
treatment as a real provider failure. Fixed by checking `controller.signal
.aborted` in `runAmbientAssistantQuery`'s catch block: if the cancellation
was self-inflicted (our own `cancelAmbientAssistantTurn` called
`controller.abort()`), return `{ answer: message }` normally instead of
re-throwing, so the error never reaches the generic wrapper. Checking the
original controller rather than the merged signal (`AbortSignal.any([...,
AbortSignal.timeout(...)])` in `assistant.ts`) matters — a genuine timeout
still throws and still gets toasted, since that IS worth surfacing; only the
user-triggered case is silenced. The cancel/abort mechanism itself is
unchanged — this only changes whether the resulting "failure" propagates as
a throw or a normal return.

## Sources

- [Voice activity detection (VAD) | OpenAI API](https://developers.openai.com/api/docs/guides/realtime-vad)
- [Making OpenAI Realtime Voice Agent Interruptible | Medium](https://medium.com/@abdullahirfan99_80517/making-openai-realtime-voice-agent-interruptible-cdb08e23e87b)
- [Voice AI Barge-In and Turn-Taking: A 2026 Implementation Guide](https://futureagi.com/blog/voice-ai-barge-in-turn-taking-2026/)
- [Live API capabilities guide | Gemini API](https://ai.google.dev/gemini-api/docs/live-guide)
- [How to interrupt Gemini Live API response mid-stream · Issue #2593](https://github.com/googleapis/python-genai/issues/2593)
- [Adaptive interruption handling | LiveKit Documentation](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/)
- [Solving unwanted interruptions with Adaptive Interruption Handling | LiveKit](https://livekit.com/blog/adaptive-interruption-handling)
- [GitHub - Lex-au/Vocalis](https://github.com/Lex-au/Vocalis)
- [GitHub - katipally/openlive](https://github.com/katipally/openlive)
- [GitHub - huggingface/speech-to-speech](https://github.com/huggingface/speech-to-speech)
- [VAD (Silero VAD) — sherpa-onnx docs](https://k2-fsa.github.io/sherpa/onnx/vad/silero-vad.html)
- [Javascript API (Node-Addon) — sherpa-onnx docs](https://k2-fsa.github.io/sherpa/onnx/javascript-api/index.html)
- [sherpa-onnx nodejs-addon-examples (VAD + ASR + microphone pipelines)](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md)
- [node-cpal — npm](https://www.npmjs.com/package/node-cpal)
- [webrtc-audio-processing (AEC3) source](https://github.com/jhgorse/webrtc-audio-processing/blob/master/webrtc/modules/audio_processing/aec/echo_cancellation.c)
- [Programming with Speex (libspeex AEC API)](https://www.speex.org/docs/manual/speex-manual/node7.html)
