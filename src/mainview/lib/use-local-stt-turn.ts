import { useState, useCallback, useEffect, useRef } from "react";
import { rpc } from "@/lib/rpc";
import { logAmbient } from "./log-ambient";
import type { AmbientSttSegmentDto } from "../../shared/rpc/ambient";

// Two thresholds, doing two different jobs (see docs/ambient-voice-barge-in-research.md's
// 2026-07-20 log-review note for the bug this replaced): the first version of
// this fix compared frontend ARRIVAL times of consecutive segments, but
// Whisper decode (1-10s in practice, local-stt-manager.ts) delays arrival
// unpredictably, so that gap didn't actually measure the user's pause — it
// measured decode latency, and routinely exceeded the window even for a
// normal thinking pause, fragmenting one utterance into several turns that
// kept barge-in-cancelling each other.
//
// SILENCE_MERGE_THRESHOLD_MS decides "does this new segment continue the
// previous one" using `silenceBeforeMs` — the true audio-domain gap the
// backend computes from VAD sample counts (local-stt-manager.ts), immune to
// decode latency. ~1.1s mirrors VAD's own 0.4s segmentation debounce plus
// room for a natural composing pause.
const SILENCE_MERGE_THRESHOLD_MS = 1100;

// FLUSH_BACKSTOP_MS is a different question: once nothing is being decoded
// right now, how long do we wait before assuming no continuation is coming
// and dispatching the turn? This can't use silenceBeforeMs (there's no next
// segment yet to measure a gap against) — instead, `ambientSttSegmentStart`
// (backend: local-stt-manager.ts's vad.isDetected() flipping true, an edge
// trigger fired within ~250ms of the user resuming speech — NOT "a full
// segment finished decoding") keeps this timer from firing while a
// continuation IS being spoken/transcribed, however long that takes. This
// value is a safety margin on top of that signal, not the primary defense —
// it only matters in the narrow case where a segment decodes faster than the
// user's pause length, which isn't the common case for Whisper small.en
// (1-10s decode in practice) but is kept a bit above SILENCE_MERGE_THRESHOLD_MS
// so it can't win that race even then.
const FLUSH_BACKSTOP_MS = 1400;

export interface UseLocalSttTurnResult {
	listening: boolean;
	/** Always false — VAD gives a hard segment boundary, so there's no
	 * recognizer-teardown gap to bridge the way the Web Speech API path needs
	 * (see useAmbientVoiceTurn's own `finalizing`). Kept for interface parity
	 * so ambient-screen.tsx can treat both turn sources identically. */
	finalizing: boolean;
	error: string | null;
	supported: boolean;
	toggle: () => void;
	stop: () => void;
}

/**
 * Local/offline alternative to useAmbientVoiceTurn — same external shape
 * (listening/finalizing/error/supported/toggle/stop) so ambient-screen.tsx
 * can swap between the two without touching its own orchestration logic, but
 * backed by continuous native mic capture + VAD + Whisper (local-stt-manager.ts)
 * instead of the Web Speech API. Each `ambientSttSegment` push IS a complete,
 * VAD-bounded utterance — no transcript-accumulation or silence-timer guessing
 * needed, so this calls `onSegment` directly instead of managing transcript
 * state the way the Web Speech path does.
 */
export function useLocalSttTurn(ready: boolean, onSegment: (text: string) => void): UseLocalSttTurnResult {
	const [listening, setListening] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const onSegmentRef = useRef(onSegment);
	useEffect(() => {
		onSegmentRef.current = onSegment;
	});

	// Buffers segments that continue the same utterance (per silenceBeforeMs)
	// into one combined turn before calling onSegment — see the constants'
	// comments above. Refs, not state: this must never trigger a re-render
	// (every keystroke-equivalent here is a whole VAD segment, and re-rendering
	// wouldn't help anything read this value synchronously anyway).
	const pendingTextRef = useRef<string | null>(null);
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// How many segments VAD has started but whose decode hasn't come back yet
	// — the flush-backstop timer only ever runs while this is 0, so a slow
	// decode holds the turn open instead of the timer guessing it's done.
	const decodeInFlightRef = useRef(0);

	const clearFlushTimer = useCallback(() => {
		if (flushTimerRef.current) {
			clearTimeout(flushTimerRef.current);
			flushTimerRef.current = null;
		}
	}, []);

	const dispatch = useCallback((text: string) => {
		logAmbient(`local-stt dispatching turn: "${text}"`);
		onSegmentRef.current(text);
	}, []);

	const flushPending = useCallback(() => {
		clearFlushTimer();
		const text = pendingTextRef.current;
		pendingTextRef.current = null;
		if (text) dispatch(text);
	}, [clearFlushTimer, dispatch]);

	// (Re)arms the backstop only when nothing is currently being decoded —
	// called after every segment-start/segment event so it always reflects
	// the latest decodeInFlightRef value.
	const rearmFlushTimer = useCallback(() => {
		clearFlushTimer();
		if (decodeInFlightRef.current === 0 && pendingTextRef.current) {
			flushTimerRef.current = setTimeout(flushPending, FLUSH_BACKSTOP_MS);
		}
	}, [clearFlushTimer, flushPending]);

	useEffect(() => {
		const onSegStart = () => {
			decodeInFlightRef.current += 1;
			clearFlushTimer();
		};
		const onSeg = (e: Event) => {
			const detail = (e as CustomEvent<AmbientSttSegmentDto>).detail;
			if (!detail?.text) return;
			decodeInFlightRef.current = Math.max(0, decodeInFlightRef.current - 1);
			logAmbient(`local-stt segment received: "${detail.text}" (silenceBeforeMs=${detail.silenceBeforeMs})`);

			const continuesPrevious = detail.silenceBeforeMs !== null && detail.silenceBeforeMs <= SILENCE_MERGE_THRESHOLD_MS;
			if (pendingTextRef.current && continuesPrevious) {
				pendingTextRef.current = `${pendingTextRef.current} ${detail.text}`;
			} else {
				// Either nothing was pending, or the real audio gap proves this
				// segment is a new utterance — flush whatever was pending as its
				// own complete turn (no need to wait; the gap already settles it)
				// before starting a fresh buffer with this segment.
				if (pendingTextRef.current) dispatch(pendingTextRef.current);
				pendingTextRef.current = detail.text;
			}
			rearmFlushTimer();
		};
		window.addEventListener("agentdesk:ambient-stt-segment-start", onSegStart);
		window.addEventListener("agentdesk:ambient-stt-segment", onSeg);
		return () => {
			window.removeEventListener("agentdesk:ambient-stt-segment-start", onSegStart);
			window.removeEventListener("agentdesk:ambient-stt-segment", onSeg);
			clearFlushTimer();
		};
	}, [clearFlushTimer, dispatch, rearmFlushTimer]);

	const stop = useCallback(() => {
		// Don't silently drop whatever was said right before Stop (or before TTS
		// forces the mic off) just because the merge window hadn't elapsed yet.
		flushPending();
		setListening(false);
		void rpc.stopAmbientLocalListening();
	}, [flushPending]);

	const start = useCallback(async () => {
		setError(null);
		const result = await rpc.startAmbientLocalListening();
		if (result.success) {
			setListening(true);
		} else {
			logAmbient(`local-stt: start failed — ${result.error}`);
			setError(result.error ?? "Failed to start local listening");
		}
	}, []);

	const toggle = useCallback(() => {
		if (listening) stop();
		else void start();
	}, [listening, start, stop]);

	// Belt-and-suspenders: stop the native capture if the pipeline stops being
	// selected/ready mid-session (e.g. settings changed) rather than leaving
	// the mic open with nothing consuming its output.
	useEffect(() => {
		if (!ready && listening) stop();
	}, [ready, listening, stop]);

	// Stop on unmount (overlay closed) if a session was left running.
	useEffect(() => {
		return () => {
			if (listening) void rpc.stopAmbientLocalListening();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return { listening, finalizing: false, error, supported: ready, toggle, stop };
}
