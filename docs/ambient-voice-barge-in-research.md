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
