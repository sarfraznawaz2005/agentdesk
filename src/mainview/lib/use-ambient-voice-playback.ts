import { useCallback, useRef, useState } from "react";
import { rpc } from "@/lib/rpc";
import { useTextToSpeech, type UseTextToSpeechResult } from "./use-text-to-speech";
import { logAmbient } from "./log-ambient";

/**
 * Ambient Mode's spoken-reply playback, upgraded over the zero-config browser
 * speechSynthesis default (docs/ambient-pm-voice-plan.md Subsystem 6) — when
 * the user has picked a real speech-model voice in Settings, generate and
 * play that audio instead; otherwise fall back to the same browser TTS
 * ambient-screen.tsx always used. Exposes the identical
 * UseTextToSpeechResult shape so callers don't need to branch themselves.
 */
export function useAmbientVoicePlayback(providerId: string | null, modelId: string | null): UseTextToSpeechResult {
	const browserTts = useTextToSpeech();
	const [speaking, setSpeaking] = useState(false);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	// Resolves the in-flight generated-audio speak() promise on cancel() — without
	// this, pause() alone never fires onended/onerror, so a caller awaiting speak()
	// (e.g. Ambient Mode's barge-in handling) would hang forever past a cancel().
	const resolveRef = useRef<(() => void) | null>(null);

	const speak = useCallback((text: string): Promise<void> => {
		if (!providerId || !modelId || !text.trim()) {
			logAmbient(`speak() via browser voice (providerId=${providerId ?? "none"}) — "${text}"`);
			return browserTts.speak(text);
		}

		audioRef.current?.pause();
		const t0 = performance.now();
		logAmbient(`speak() via generated audio (${providerId}/${modelId}) — "${text}"`);
		return rpc.generateAmbientSpeech(providerId, modelId, text).then(
			({ base64, mimeType }) => {
				logAmbient(`generateAmbientSpeech resolved in ${Math.round(performance.now() - t0)}ms (${mimeType})`);
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
			},
			// Generation failed (provider/model no longer valid, network error,
			// etc.) — fall back to the browser voice rather than staying silent.
			(err: unknown) => {
				logAmbient(`generateAmbientSpeech failed after ${Math.round(performance.now() - t0)}ms, falling back to browser voice: ${err instanceof Error ? err.message : String(err)}`);
				return browserTts.speak(text);
			},
		);
	}, [providerId, modelId, browserTts]);

	const cancel = useCallback(() => {
		logAmbient("tts.cancel() called");
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
		cancel,
	};
}
