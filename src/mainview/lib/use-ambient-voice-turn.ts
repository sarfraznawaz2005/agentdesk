import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceInput, type UseVoiceInputResult } from "./use-voice-input";
import { logAmbient } from "./log-ambient";

// How long to wait after the last transcript change before treating the
// user's turn as over — long enough to survive a mid-sentence pause, short
// enough to feel responsive. See docs/ambient-pm-voice-plan.md Subsystem 3.
const SILENCE_MS = 1600;
// Grace period before the user has said anything yet — SILENCE_MS is too
// short here: it used to arm the moment recognition started (listening
// flipped true), before a single word was captured, so the ordinary pause
// between tapping "Talk to PM" and actually starting to speak (finding your
// words, reaction time) would auto-stop the mic first, silently ending the
// turn with an empty transcript (handleVoiceEnd's `if (!text) return` — no
// error, no answer, straight back to idle). Only switch to the short
// post-speech cutoff once the transcript actually has content.
const INITIAL_GRACE_MS = 8000;

/**
 * Wraps the shared useVoiceInput hook (also used by the normal chat
 * dictation button) with automatic end-of-turn detection, scoped to Ambient
 * Mode only — the shared hook itself is untouched, so dictating a message in
 * a project's chat still requires the existing manual tap-to-stop.
 *
 * Detection is debounce-based: `value` only changes via the underlying
 * recognizer's onresult callback, so a fixed silence window since the last
 * change is a reliable proxy for "the user stopped talking," without needing
 * to reach into use-voice-input.ts's internals. The manual tap-to-toggle
 * button (already wired by callers) still works as an override at any time —
 * this only adds an automatic path, it replaces nothing.
 */
export function useAmbientVoiceTurn(
	value: string,
	setValue: (value: string) => void,
	onEnd?: () => void,
): UseVoiceInputResult & { finalizing: boolean } {
	const voice = useVoiceInput(value, setValue, onEnd);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// `voice` is a fresh object literal every render (useVoiceInput's own
	// return value), and `value` changes on every recognized word — if `stop`
	// closed over either directly, ITS identity would change on every render,
	// including unrelated ones (e.g. ambient-screen.tsx's once-a-second clock
	// tick), which would re-trigger the pause-timer effect below (`stop` is
	// one of its deps) and spuriously re-arm the debounce on every render
	// instead of only on real speech/listening changes — confirmed live via
	// ambient.log: the same transcript was re-logged as "(re)armed" roughly
	// once a second with no new speech. Refs keep `stop`'s identity stable so
	// the effect only reruns when `value`/`voice.listening` truly change.
	const voiceRef = useRef(voice);
	useEffect(() => {
		voiceRef.current = voice;
	});
	const valueRef = useRef(value);
	useEffect(() => {
		valueRef.current = value;
	});

	// Bridges the gap between "we've decided this turn is over" (silence
	// timeout elapsed, or the user tapped stop) and the recognizer actually
	// firing `onend` — which the underlying Web Speech engine can delay by up
	// to a second or so while it finalizes the last result. Without this,
	// voicePhase stays "listening" for that whole window even though nothing
	// is being captured anymore. Wraps `stop` (not `toggle`) since ending a
	// turn always goes through an explicit stop() call here, never toggle().
	const [finalizing, setFinalizing] = useState(false);
	// Timing/visibility logging only — persisted to {userData}/logs/ambient.log
	// via logAmbient (see log-ambient.ts), no UI, safe to leave in. Everything
	// tagged `[ambient]` so it's filterable together with the RPC-layer and
	// backend logs (rpc/ambient.ts, ambient/assistant.ts, ambient/local-voice-manager.ts).
	const stopCalledAtRef = useRef<number | null>(null);
	const stop = useCallback(() => {
		// Only start the stopwatch if a recognizer session is actually running —
		// calling stop() when nothing is listening (a stray mount/cleanup call,
		// or a double-stop) leaves no real onend to ever measure; a stale
		// timestamp left behind here previously got misattributed to a much
		// later, unrelated onend (logged as a bogus ~19s "gap" in one session).
		if (voiceRef.current.listening) stopCalledAtRef.current = performance.now();
		logAmbient(`stop() called — transcript so far: "${valueRef.current}"`);
		setFinalizing(true);
		voiceRef.current.stop();
	}, []);

	useEffect(() => {
		if (timerRef.current) clearTimeout(timerRef.current);
		if (!voice.listening) return;
		const delay = value.trim().length > 0 ? SILENCE_MS : INITIAL_GRACE_MS;
		logAmbient(`pause timer (re)armed: ${delay}ms — transcript: "${value}"`);
		timerRef.current = setTimeout(stop, delay);
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [value, voice.listening, stop]);

	// Cleared the moment a fresh listening session actually starts (not when
	// it ends — by then isThinking/voicePhase has already taken over).
	useEffect(() => {
		if (voice.listening) {
			setFinalizing(false); // eslint-disable-line react-hooks/set-state-in-effect
		} else if (stopCalledAtRef.current !== null) {
			logAmbient(`stop() -> recognizer onend: ${Math.round(performance.now() - stopCalledAtRef.current)}ms`);
			stopCalledAtRef.current = null;
		}
	}, [voice.listening]);

	// Recognizer errors (mic permission denied, network hiccup for cloud-backed
	// engines, etc.) — the shared use-voice-input.ts already surfaces `error`
	// for its own UI text; this just also gets it into the same timeline.
	useEffect(() => {
		if (voice.error) logAmbient(`recognizer error: ${voice.error}`);
	}, [voice.error]);

	return { ...voice, stop, finalizing };
}
