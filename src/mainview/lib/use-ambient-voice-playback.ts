import { useCallback, useRef, useState } from "react";
import { rpc } from "@/lib/rpc";
import { useTextToSpeech, type UseTextToSpeechResult, ACK_PHRASES } from "./use-text-to-speech";
import { logAmbient } from "./log-ambient";

/**
 * Ambient Mode's spoken-reply playback, upgraded over the zero-config browser
 * speechSynthesis default (docs/ambient-pm-voice-plan.md Subsystem 6) — when
 * the user has picked a real speech-model voice in Settings, generate and
 * play that audio instead; otherwise fall back to the same browser TTS
 * ambient-screen.tsx always used. Exposes the identical
 * UseTextToSpeechResult shape so callers don't need to branch themselves.
 */
export function useAmbientVoicePlayback(providerId: string | null, modelId: string | null, speed?: number): UseTextToSpeechResult {
	const browserTts = useTextToSpeech();
	const [speaking, setSpeaking] = useState(false);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	// Resolves the in-flight generated-audio speak() promise on cancel() — without
	// this, pause() alone never fires onended/onerror, so a caller awaiting speak()
	// (e.g. Ambient Mode's barge-in handling) would hang forever past a cancel().
	const resolveRef = useRef<(() => void) | null>(null);
	// ACK_PHRASES is the same fixed handful of strings every turn — unlike a
	// real answer's text, which is different every time and not worth caching,
	// generating THESE once per (provider, model, speed, phrase) combo and
	// replaying the cached clip means the offline/generated voice's 1-13s
	// synthesis cost (measured live) is paid at most once per phrase per
	// voice config, not on every single turn.
	const ackAudioCache = useRef<Map<string, { base64: string; mimeType: string }>>(new Map());
	// Bumped by every speak()/speakAck()/cancel() call — a generateAmbientSpeech
	// request captures the value at its own start and checks it again once the
	// (uncancellable) network/local-model call resolves, so a request that's
	// been superseded in the meantime (barge-in, a newer speak() call) has its
	// late-arriving audio silently discarded instead of playing anyway.
	const generationTokenRef = useRef(0);

	// Shared by speak() and speakAck() — plays a generated-audio data URL and
	// resolves once it finishes/errors/gets cancelled, wiring the same
	// speaking-state and resolveRef plumbing either caller needs.
	const playGeneratedAudio = useCallback((base64: string, mimeType: string): Promise<void> => {
		audioRef.current?.pause();
		return new Promise<void>((resolve) => {
			const settle = () => { resolveRef.current = null; resolve(); };
			resolveRef.current = settle;
			const audio = new Audio(`data:${mimeType};base64,${base64}`);
			audioRef.current = audio;
			audio.onplay = () => setSpeaking(true);
			audio.onended = () => { setSpeaking(false); settle(); };
			audio.onerror = () => { setSpeaking(false); settle(); };
			audio.play().catch(() => { setSpeaking(false); settle(); });
		});
	}, []);

	const speak = useCallback((text: string): Promise<void> => {
		if (!providerId || !modelId || !text.trim()) {
			logAmbient(`speak() via browser voice (providerId=${providerId ?? "none"}, rate=${speed ?? 1}) — "${text}"`);
			return browserTts.speak(text, speed);
		}

		const myToken = ++generationTokenRef.current;
		const t0 = performance.now();
		logAmbient(`speak() via generated audio (${providerId}/${modelId}, speed=${speed ?? 1}) — "${text}"`);
		return rpc.generateAmbientSpeech(providerId, modelId, text, speed).then(
			({ base64, mimeType }) => {
				logAmbient(`generateAmbientSpeech resolved in ${Math.round(performance.now() - t0)}ms (${mimeType})`);
				// generateAmbientSpeech has no abort mechanism, so a cancel() that
				// happened while this was in flight couldn't actually stop it —
				// only discard the result once it does arrive, rather than
				// playing now-stale audio over whatever's current.
				if (generationTokenRef.current !== myToken) {
					logAmbient("speak() generation resolved after being superseded — discarding stale audio");
					return undefined;
				}
				return playGeneratedAudio(base64, mimeType);
			},
			// Generation failed (provider/model no longer valid, network error,
			// etc.) — fall back to the browser voice rather than staying silent.
			(err: unknown) => {
				logAmbient(`generateAmbientSpeech failed after ${Math.round(performance.now() - t0)}ms, falling back to browser voice: ${err instanceof Error ? err.message : String(err)}`);
				if (generationTokenRef.current !== myToken) return undefined;
				return browserTts.speak(text, speed);
			},
		);
	}, [providerId, modelId, speed, browserTts, playGeneratedAudio]);

	const speakAck = useCallback((): Promise<void> => {
		const phrase = ACK_PHRASES[Math.floor(Math.random() * ACK_PHRASES.length)];
		if (!providerId || !modelId) {
			logAmbient(`speakAck() via browser voice — "${phrase}"`);
			return browserTts.speak(phrase, speed);
		}

		const cacheKey = `${providerId}|${modelId}|${speed ?? 1}|${phrase}`;
		const cached = ackAudioCache.current.get(cacheKey);
		if (cached) {
			logAmbient(`speakAck() using cached audio — "${phrase}"`);
			return playGeneratedAudio(cached.base64, cached.mimeType);
		}

		const myToken = ++generationTokenRef.current;
		const t0 = performance.now();
		logAmbient(`speakAck() generating (${providerId}/${modelId}, speed=${speed ?? 1}) — "${phrase}"`);
		return rpc.generateAmbientSpeech(providerId, modelId, phrase, speed).then(
			({ base64, mimeType }) => {
				logAmbient(`speakAck() generateAmbientSpeech resolved in ${Math.round(performance.now() - t0)}ms — caching for reuse`);
				ackAudioCache.current.set(cacheKey, { base64, mimeType });
				if (generationTokenRef.current !== myToken) {
					logAmbient("speakAck() generation resolved after being superseded — discarding stale audio");
					return;
				}
				return playGeneratedAudio(base64, mimeType);
			},
			(err: unknown) => {
				logAmbient(`speakAck() generation failed after ${Math.round(performance.now() - t0)}ms, falling back to browser voice: ${err instanceof Error ? err.message : String(err)}`);
				if (generationTokenRef.current !== myToken) return;
				return browserTts.speak(phrase, speed);
			},
		);
	}, [providerId, modelId, speed, browserTts, playGeneratedAudio]);

	const cancel = useCallback(() => {
		logAmbient("tts.cancel() called");
		generationTokenRef.current++;
		audioRef.current?.pause();
		setSpeaking(false);
		resolveRef.current?.();
		browserTts.cancel();
	}, [browserTts]);

	const usingGeneratedAudio = !!(providerId && modelId);
	return {
		supported: usingGeneratedAudio ? true : browserTts.supported,
		speaking: usingGeneratedAudio ? speaking : browserTts.speaking,
		speak,
		speakAck,
		cancel,
	};
}
