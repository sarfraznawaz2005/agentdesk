import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ArrowLeft, Mic, MicOff, Loader2 } from "lucide-react";
import { useAmbientStore } from "@/stores/ambient-store";
import { useGlobalAgentActivity } from "@/lib/use-global-agent-activity";
import { useIdleTimer } from "@/lib/use-idle-timer";
import { useAmbientSettings } from "@/lib/use-ambient-settings";
import { useAmbientVoiceTurn } from "@/lib/use-ambient-voice-turn";
import { useAmbientVoicePlayback } from "@/lib/use-ambient-voice-playback";
import { useChatStore } from "@/stores/chat-store";
import { rpc } from "@/lib/rpc";
import { logAmbient } from "@/lib/log-ambient";
import { AmbientChrome, AmbientRadarContent, ACCENT, BG, FG } from "./ambient-radar-view";
import { ProjectToDisplayControl } from "./project-to-display-control";
import { AmbientToolCallPane, TOOL_CALL_PANE_RESERVED_WIDTH, type AmbientTurn } from "./ambient-tool-call-pane";
import type { AmbientAssistantPartDto } from "../../../shared/rpc/ambient";

interface ProjectNameLookup {
  [projectId: string]: string;
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

type VoicePhase = "idle" | "listening" | "thinking" | "speaking";

// The center exchange view no longer echoes the user's own transcript (that
// now lives in AmbientToolCallPane instead, via each turn's `userText`) —
// kept as a flag rather than deleted so the old inline placement can be
// restored for comparison.
const SHOW_TRANSCRIPT_IN_CENTER = false;

// The pane's running log — capped FIFO (oldest turn dropped first), same
// tradeoff as the backend's own conversationHistory cap (assistant.ts). Each
// turn is 1 user + 1 assistant message once it completes, so 50 turns caps
// the visible log at the same 100-message combined limit.
const MAX_TURNS = 50;

/**
 * Full-screen "Ambient Mode" overlay — mounted once at the app-shell level and
 * shown/hidden via useAmbientStore, never a route change (so closing it
 * returns to whatever page/conversation was underneath). See
 * docs/ambient-screen-plan.md Subsystems 3, 5 (voice) and 6 (Beacon visuals).
 */
export function AmbientScreen() {
  const open = useAmbientStore((s) => s.open);
  const dismiss = useAmbientStore((s) => s.dismiss);
  const { activeProjectAgents, taskStats, activityLog } = useGlobalAgentActivity();
  const awaitingYou = useChatStore((s) => s.shellApprovalRequests.length);
  const { voiceEnabled, ttsEnabled, ttsProviderId, ttsModelId } = useAmbientSettings();
  const [projectNames, setProjectNames] = useState<ProjectNameLookup>({});
  const [subState, setSubState] = useState<"ambient" | "engaged">("ambient");
  const [transcript, setTranscript] = useState("");
  const [lastExchange, setLastExchange] = useState<{ you: string; pm: string } | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  // True from right before tts.speak() is called until audio actually starts
  // playing (or speak() settles without ever starting, e.g. empty text) —
  // covers the real, measured 2.5-3.8s gap for the generated/offline voice
  // paths between "answer received" and "audio actually audible," during
  // which there was previously no loading indication at all (isThinking had
  // already flipped false, tts.speaking hadn't flipped true yet).
  const [preparingSpeech, setPreparingSpeech] = useState(false);
  // True from the first "Talk to PM" tap until the user explicitly taps
  // "Stop" (or leaves the engaged view) — drives the hands-free auto-restart
  // loop below, replacing the old manual "Ask again" tap-per-turn model.
  const [sessionActive, setSessionActive] = useState(false);
  // The pane's running turn log — persists across turns (and across
  // ambient/engaged sub-state switches) rather than resetting per-question,
  // since the whole point is a visible multi-turn history, not just the
  // latest exchange. See MAX_TURNS above for the cap.
  const [turns, setTurns] = useState<AmbientTurn[]>([]);
  // The turn a new turnId belongs to — passed to the backend as its
  // messageId (see rpc/ambient.ts's runAmbientAssistantQuery), so incoming
  // ambient-assistant-part broadcasts route by which turn actually produced
  // them (below) rather than by "whichever turn is currently active." That
  // distinction matters once a barge-in can leave an older turn still
  // running server-side while a newer one is live — without it, a stale
  // part arriving late would get visually merged into the wrong (new) turn.
  // Also used for the staleness check in handleVoiceEnd (discarding/cancelling
  // an older turn's result once a newer one has started) and for cancelling
  // the previous turn's backend call on barge-in.
  const activeTurnIdRef = useRef<string | null>(null);
  const clock = useClock();
  const tts = useAmbientVoicePlayback(ttsProviderId, ttsModelId);

  // Live tool-call progress for the side pane (docs/ambient-pm-voice-plan.md
  // Subsystem 5) — each tool call arrives as two pushes sharing the same id
  // (a "running" one from onToolCallStart, then a "complete"/"error" one from
  // onToolCallEnd/tool-result), so merge by id rather than appending; a
  // field that's null on the second push (e.g. toolName on the completion
  // push) must not blank out what the first push already set. Routed by
  // `detail.messageId` (== the turn's own id, per the comment above) rather
  // than "whichever turn is active," so a stale/superseded turn's late
  // arrivals land in its own (no longer active) entry, not the new one's.
  useEffect(() => {
    const onPart = (e: Event) => {
      const detail = (e as CustomEvent<AmbientAssistantPartDto | null>).detail;
      if (!detail) return;
      logAmbient(
        `part received — turn ${detail.messageId} type=${detail.type}` +
          (detail.type === "tool_call" ? ` tool=${detail.toolName ?? "?"} state=${detail.toolState}` : ` content="${detail.content}"`),
      );
      setTurns((prev) => prev.map((t) => {
        if (t.id !== detail.messageId) return t;
        const idx = t.parts.findIndex((p) => p.id === detail.id);
        if (idx === -1) return { ...t, parts: [...t.parts, detail] };
        const existing = t.parts[idx];
        const merged: AmbientAssistantPartDto = {
          ...existing,
          toolName: detail.toolName ?? existing.toolName,
          toolInput: detail.toolInput ?? existing.toolInput,
          toolOutput: detail.toolOutput ?? existing.toolOutput,
          toolState: detail.toolState ?? existing.toolState,
          content: detail.content || existing.content,
          timeEnd: detail.timeEnd ?? existing.timeEnd,
        };
        const parts = [...t.parts];
        parts[idx] = merged;
        return { ...t, parts };
      }));
    };
    window.addEventListener("agentdesk:ambient-assistant-part", onPart);
    return () => window.removeEventListener("agentdesk:ambient-assistant-part", onPart);
  }, []);

  // Mounted here (rather than app-shell.tsx directly) so it's scoped to the
  // same main-app-only branch this component is — Quick Chat's separate
  // window/branch never mounts AmbientScreen, so it never runs this timer.
  useIdleTimer();

  // Warm up the offline voice's onnxruntime session as soon as the overlay
  // opens, rather than paying that cold-load cost on the first reply. Only
  // meaningful once the voice is actually downloaded (`status === "ready"`) —
  // if it's still downloading or was never downloaded, there's nothing to
  // warm up yet, and `synthesizeLocalVoice` already falls back to the
  // browser voice gracefully in that case (see use-ambient-voice-playback.ts),
  // so this deliberately does NOT block entry into voice mode for that case —
  // only for the short, bounded in-memory warm-up itself.
  const [localVoiceWarmingUp, setLocalVoiceWarmingUp] = useState(false);
  useEffect(() => {
    if (!(open && ttsProviderId === "local")) {
      setLocalVoiceWarmingUp(false);
      return;
    }
    let cancelled = false;
    rpc.getAmbientLocalVoiceStatus().then((status) => {
      logAmbient(`local voice status on open: ${status.status}`);
      if (cancelled || status.status !== "ready") return;
      setLocalVoiceWarmingUp(true);
      const t0 = performance.now();
      rpc.preloadAmbientLocalVoice().finally(() => {
        logAmbient(`local voice preload finished: ${Math.round(performance.now() - t0)}ms`);
        if (!cancelled) setLocalVoiceWarmingUp(false);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, ttsProviderId]);

  // Once recognition stops (tap-to-stop, or the pause-detection timer in
  // useAmbientVoiceTurn), route the transcript to the Ambient Assistant —
  // NOT the old per-conversation sendMessage path, which could only ever
  // answer within whatever project chat happened to already be open. Speaks
  // the real cross-project turn's answer directly once it's ready — an
  // earlier version spoke an instant filler "let me check"-style phrase
  // first, but that was dropped as unnecessary now that the pane's own
  // immediate "Thinking…" row already gives instant feedback (see
  // handleVoiceEnd below) without needing a spoken placeholder too. See
  // docs/ambient-pm-voice-plan.md Subsystem 2.
  const handleVoiceEnd = useCallback(() => {
    const text = transcript.trim();
    setTranscript("");
    if (!text) {
      logAmbient("handleVoiceEnd fired with empty transcript — ignored (no turn started)");
      return;
    }
    const turnId = crypto.randomUUID();
    // Coarse timing breakdown to actually diagnose slow-answer reports
    // instead of guessing — logs how long each stage takes: turn-end (this
    // point) -> RPC resolved -> TTS finished. Cheap, dev-facing only (no UI),
    // safe to leave in.
    const t0 = performance.now();
    logAmbient(`turn ${turnId} started — "${text}"`);
    // A barge-in started this turn before an older one's backend call
    // resolved — actually cancel that older call rather than just discarding
    // its result once it arrives (see docs/ambient-voice-barge-in-research.md).
    // Reuses the same abortSignal plumbing already wired through
    // runAmbientAssistantTurn (both the streamText and Claude Subscription CLI
    // paths), same mechanism the regular agent "Stop" button uses.
    const previousTurnId = activeTurnIdRef.current;
    if (previousTurnId) {
      logAmbient(`barge-in — cancelling previous turn ${previousTurnId}`);
      void rpc.cancelAmbientAssistantTurn(previousTurnId).then((res) => logAmbient(`cancel(${previousTurnId}) result: ${JSON.stringify(res)}`));
    }
    activeTurnIdRef.current = turnId;
    setLastExchange({ you: text, pm: "" });
    setIsThinking(true);
    // Pushed synchronously (before the request resolves) so the pane shows
    // the "You said" box + a "Thinking…" row the instant the turn starts,
    // rather than staying blank until the first tool call or answer streams in.
    setTurns((prev) => {
      const next = [...prev, { id: turnId, userText: text, parts: [], thinking: true }];
      return next.length > MAX_TURNS ? next.slice(-MAX_TURNS) : next;
    });

    void (async () => {
      const { answer } = await rpc.runAmbientAssistantQuery(text, turnId).catch((err: unknown) => {
        logAmbient(`turn ${turnId} RPC threw: ${err instanceof Error ? err.message : String(err)}`);
        return { answer: err instanceof Error ? err.message : "Something went wrong answering that." };
      });
      const t1 = performance.now();
      logAmbient(`turn ${turnId} answer in ${Math.round(t1 - t0)}ms — "${answer}"`);
      // Belt-and-suspenders: even with the cancel above, still guard against
      // discarding a stale result rather than acting on it — e.g. the cancel
      // RPC itself failing, or the answer having already been in flight back
      // to the client at the moment cancel() fired server-side.
      if (activeTurnIdRef.current !== turnId) {
        logAmbient(`turn ${turnId} superseded by ${activeTurnIdRef.current} — discarding its answer`);
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, thinking: false, interrupted: true } : t)));
        return;
      }
      setIsThinking(false);
      setLastExchange((prev) => (prev ? { ...prev, pm: answer } : { you: text, pm: answer }));
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, thinking: false } : t)));
      if (ttsEnabled && tts.supported) {
        logAmbient(`turn ${turnId} speaking via ${ttsProviderId ?? "browser default"}`);
        setPreparingSpeech(true);
        await tts.speak(answer);
        setPreparingSpeech(false);
        logAmbient(`turn ${turnId} TTS finished in ${Math.round(performance.now() - t1)}ms`);
      }
    })();
  }, [transcript, ttsEnabled, tts, ttsProviderId]);

  const voice = useAmbientVoiceTurn(transcript, setTranscript, handleVoiceEnd);

  // Clears the instant real audio playback actually starts — speak()'s own
  // promise doesn't resolve until the WHOLE utterance finishes, so waiting
  // for that would keep showing "thinking" for the entire reply, not just
  // the generation gap this is meant to cover.
  useEffect(() => {
    if (tts.speaking) setPreparingSpeech(false);
  }, [tts.speaking]);

  // "thinking" takes priority over the raw mic state for display purposes —
  // the mic is also kept alive during "thinking" (safe: no audio is playing
  // yet, so there's nothing for it to echo), so `voice.listening` alone can't
  // distinguish "PM is still answering" from "user is dictating a new
  // question." `preparingSpeech` covers the real, measured 2.5-3.8s gap for
  // generated/offline voices between "answer received" and "audio actually
  // audible" — without it there was a dead stretch with no loading indication
  // at all. The mic is deliberately NOT kept alive during "speaking" or while
  // preparing it — see the effects below and
  // docs/ambient-voice-barge-in-research.md's Follow-up fixes: without real
  // echo cancellation, a mic left open while speechSynthesis plays through
  // actual speakers reliably hears the assistant's own voice and transcribes
  // it as a new "question," creating a self-sustaining feedback loop
  // (confirmed live, not just a theoretical risk). Interrupting the PM while
  // it's actually talking is manual-tap ("Interrupt") only.
  const voicePhase: VoicePhase = isThinking || preparingSpeech
    ? "thinking"
    : tts.speaking
    ? "speaking"
    : voice.listening
    ? voice.finalizing
      ? "thinking" // stop() was called but the recognizer hasn't fired onend yet
      : "listening"
    : "idle";

  const voiceUsable = voiceEnabled && voice.supported;

  // Hands-free auto-restart (point 1) AND keeping the mic alive through
  // "thinking" so the user can start a new/corrected question before the
  // answer even comes back — both are the same rule: whenever a session is
  // active, TTS isn't playing or being prepared, and nothing is currently
  // capturing audio, start capturing again. Guarded on `voice.listening` so
  // this only fires once recognition has actually stopped (not during the
  // `finalizing` gap covered elsewhere); guarded on `!tts.speaking &&
  // !preparingSpeech` so it never starts the mic only to force it off again
  // moments later once real audio begins (see the echo note above).
  useEffect(() => {
    if (!sessionActive || !voiceUsable || voice.listening || tts.speaking || preparingSpeech) return;
    logAmbient("auto-restart — starting to listen");
    voice.toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionActive, voiceUsable, voice.listening, tts.speaking, preparingSpeech]);

  // Forces the mic off the instant TTS starts speaking. Thinking-phase
  // keep-alive listening can still be running right at that boundary (it
  // isn't torn down just because the answer arrived), and letting it continue
  // into "speaking" would reopen the exact echo path the guard above exists
  // to avoid.
  useEffect(() => {
    if (tts.speaking && voice.listening) {
      logAmbient("TTS starting to speak — forcing mic off to avoid echo self-trigger");
      voice.stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tts.speaking, voice.listening]);

  // Fetch project names once when the overlay opens — this component is mounted
  // at app-shell level regardless of which page is open, so it can't assume the
  // Dashboard's own `projects` list is available.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    rpc.getProjects().then((result) => {
      if (cancelled) return;
      const list = Array.isArray(result) ? (result as Array<{ id: string; name: string }>) : [];
      const map: ProjectNameLookup = {};
      for (const p of list) map[p.id] = p.name;
      setProjectNames(map);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  // Reset to the ambient sub-state every time the overlay opens fresh.
  useEffect(() => {
    if (open) {
      setSubState("ambient");
      setLastExchange(null);
      setSessionActive(false);
    }
  }, [open]);

  // Stop any in-progress mic/speech if the overlay is dismissed mid-exchange.
  useEffect(() => {
    if (open) return;
    voice.stop();
    tts.cancel();
    setSessionActive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Fullscreen on activation, best-effort — engines may refuse requestFullscreen()
  // without a direct user gesture (expected for the idle-triggered path; see
  // docs/ambient-screen-plan.md's Risks section). Not treated as an error
  // either way — the in-window overlay below already covers the full
  // viewport regardless of native fullscreen succeeding.
  useEffect(() => {
    if (!open) return;
    document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    };
  }, [open]);

  const handleDismiss = useCallback(() => {
    dismiss();
  }, [dismiss]);

  // Escape dismisses from any sub-state.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleDismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, handleDismiss]);

  const projectRows = useMemo(() => {
    const ids = new Set([...Object.keys(activeProjectAgents), ...Object.keys(taskStats)]);
    return Array.from(ids).map((id) => ({
      id,
      name: projectNames[id] ?? id,
      activeAgents: activeProjectAgents[id] ?? 0,
      done: taskStats[id]?.done ?? 0,
      total: taskStats[id]?.total ?? 0,
    }));
  }, [activeProjectAgents, taskStats, projectNames]);

  const agentsActiveNow = useMemo(
    () => Object.values(activeProjectAgents).reduce((sum, n) => sum + n, 0),
    [activeProjectAgents],
  );
  const tasksDone = useMemo(
    () => Object.values(taskStats).reduce((sum, s) => sum + s.done, 0),
    [taskStats],
  );

  // Mic off by default — one tap starts a hands-free session that keeps
  // listening across turns (see the auto-restart effect above) until the
  // user explicitly taps "Stop". Barge-in: talking while the PM is still
  // "thinking" is detected automatically (the mic stays on for that phase —
  // safe, no audio playing yet). While it's actually "speaking" the mic is
  // deliberately off (echo risk — see the voicePhase comment above), so
  // interrupting it is tap-only here. Starting listening itself is left
  // entirely to the auto-restart effect (keyed on `sessionActive`) rather
  // than also calling `voice.toggle()` here — `voice.listening` only flips
  // true once the recognizer's async `onstart` fires, so calling toggle()
  // from both this handler and that effect in close succession could race:
  // the second call would see the recognizer already set up and immediately
  // stop it again.
  const handleTalkButtonClick = useCallback(() => {
    logAmbient(`talk button tapped — subState=${subState} voicePhase=${voicePhase}`);
    if (subState === "ambient") {
      setSubState("engaged");
      setLastExchange(null);
      setSessionActive(true);
      return;
    }
    if (voicePhase === "listening") {
      // Explicit Stop — ends the hands-free loop rather than just this turn.
      voice.stop();
      setSessionActive(false);
      return;
    }
    if (voicePhase === "thinking") return; // ignore taps while PM is answering
    if (voicePhase === "speaking") {
      // Manual barge-in — the mic is off during "speaking" (see above), so
      // the auto-restart effect picks up listening again right after this
      // cancel flips tts.speaking back to false.
      tts.cancel();
      return;
    }
    // Idle within the engaged view — only reachable right after an explicit
    // Stop, or before the session's first tap.
    setSessionActive(true);
  }, [subState, voicePhase, voice, tts]);

  // Return to the ambient (radar/activity log) screen without exiting Ambient
  // Mode entirely — Esc only ever exits the whole overlay, so this was the
  // one dead end the engaged view had no way back out of otherwise.
  const handleBackToAmbient = useCallback(() => {
    logAmbient("Back tapped — ending session, returning to radar view");
    voice.stop();
    tts.cancel();
    setSessionActive(false);
    setSubState("ambient");
    setLastExchange(null);
    // `turns` is intentionally left alone — it's a running log, not a
    // per-visit scratchpad, so leaving the engaged view shouldn't wipe it.
  }, [voice, tts]);

  if (!open) return null;

  const talkLabel = localVoiceWarmingUp
    ? "Loading voice…"
    : subState === "ambient"
    ? "Talk to PM"
    : voicePhase === "listening"
    ? "Stop"
    : voicePhase === "thinking"
    ? "Thinking…"
    : voicePhase === "speaking"
    ? "Interrupt"
    : "Talk";

  const paneVisible = subState === "engaged" && turns.length > 0;

  return (
    <AmbientChrome
      brand="AgentDesk — Beacon"
      clock={clock}
      onExit={handleDismiss}
      exitLabel="Exit"
      headerExtra={<ProjectToDisplayControl />}
      footerRightInset={paneVisible ? TOOL_CALL_PANE_RESERVED_WIDTH : "0px"}
      footer={
        <button
          type="button"
          onClick={handleTalkButtonClick}
          disabled={localVoiceWarmingUp || (subState === "engaged" && voicePhase === "thinking")}
          className="flex h-12 items-center gap-2 px-7 text-sm font-bold uppercase tracking-wide disabled:opacity-50"
          style={{ background: ACCENT, color: BG, touchAction: "manipulation" }}
        >
          {localVoiceWarmingUp ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          ) : subState === "engaged" && voicePhase === "listening" ? (
            <MicOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Mic className="h-4 w-4" aria-hidden="true" />
          )}
          {talkLabel}
        </button>
      }
    >
      {subState === "ambient" ? (
        <AmbientRadarContent
          projectRows={projectRows}
          agentsActiveNow={agentsActiveNow}
          tasksDone={tasksDone}
          awaitingYou={awaitingYou}
          projectNames={projectNames}
          activityLog={activityLog}
        />
      ) : (
        <div className="relative flex flex-1 overflow-hidden">
          <button
            type="button"
            onClick={handleBackToAmbient}
            className="absolute left-8 top-8 z-20 flex h-11 items-center gap-2 border px-4 text-sm font-semibold uppercase tracking-wide"
            style={{ borderColor: "rgba(0,204,255,.4)", color: ACCENT, touchAction: "manipulation" }}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </button>

          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8">
            <div className="relative h-40 w-40 shrink-0">
              {(voicePhase === "listening" || voicePhase === "speaking") &&
                [0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="ambient-ping-ring absolute inset-0 rounded-full border-2"
                    style={{ borderColor: ACCENT, animationDelay: `${i * 0.6}s` }}
                  />
                ))}
              <div
                className="absolute inset-0 m-auto h-10 w-10 rounded-full"
                style={{
                  background: `radial-gradient(circle, #fff, ${ACCENT})`,
                  boxShadow: "0 0 40px rgba(0,204,255,.6)",
                  opacity: voicePhase === "thinking" ? 0.5 : 1,
                }}
              />
            </div>

            {!voiceEnabled ? (
              <p className="text-sm" style={{ color: "rgba(220,240,250,.8)" }}>
                Voice input is turned off in Settings.
              </p>
            ) : !voice.supported ? (
              <p className="text-sm" style={{ color: "rgba(220,240,250,.8)" }}>
                Voice input isn't available on this device.
              </p>
            ) : voice.error && !voice.error.includes("no-speech") ? (
              // "no-speech" is the recognizer's expected way of saying "I waited
              // and heard nothing" — routine in continuous hands-free listening
              // (the auto-restart effect above already handles it gracefully),
              // not a real problem worth alarming the user with red error text.
              <p className="text-sm" style={{ color: "#FF6B6B" }}>{voice.error}</p>
            ) : null}

            {lastExchange && (
              <div className="max-w-xl text-center">
                {SHOW_TRANSCRIPT_IN_CENTER && lastExchange.you && (
                  <div className="mb-3 text-sm" style={{ color: "rgba(220,240,250,.85)" }}>
                    "{lastExchange.you}"
                  </div>
                )}
                <div className="text-lg font-semibold leading-relaxed" style={{ color: FG }}>
                  {lastExchange.pm || (voicePhase === "thinking" ? "…" : "")}
                </div>
              </div>
            )}

            <div className="font-mono text-xs uppercase tracking-[0.2em]" style={{ color: ACCENT }}>
              {voicePhase === "listening" && "◉ listening"}
              {voicePhase === "thinking" && "◉ thinking"}
              {voicePhase === "speaking" && "◉ speaking"}
              {voicePhase === "idle" && !lastExchange && "tap talk to pm to ask something"}
            </div>
          </div>

          <AmbientToolCallPane turns={turns} />
        </div>
      )}
    </AmbientChrome>
  );
}
