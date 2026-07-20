import { useState, useCallback, useEffect } from "react";
import { logAmbient } from "./log-ambient";

// ---------------------------------------------------------------------------
// Web Speech API (speech synthesis) — sibling to use-voice-input.ts's STT
// hook. window.speechSynthesis/SpeechSynthesisUtterance are standard DOM
// types (unlike webkitSpeechRecognition), so no custom typings are needed
// here — only the feature-detect-and-degrade pattern is shared.
// ---------------------------------------------------------------------------

export interface UseTextToSpeechResult {
  /** False if this webview has no speech synthesis engine — callers should fall back to captions-only. */
  supported: boolean;
  speaking: boolean;
  /**
   * Speak the full text once (v1 — no token-stream sync). Cancels any speech
   * already in progress first. Returns a promise that resolves once this
   * utterance finishes (or errors/gets cancelled) — callers that need to
   * sequence a second utterance after this one (e.g. Ambient Mode's
   * quick-ack-then-real-answer flow) can await it instead of racing speak()
   * calls, which would otherwise cancel each other. `rate` is
   * SpeechSynthesisUtterance's native 0.1–10 scale (1 = normal).
   */
  speak: (text: string, rate?: number) => Promise<void>;
  /**
   * Speaks one randomly-picked short acknowledgment phrase (see ACK_PHRASES)
   * — Ambient Mode's "let the user know we're on it" filler while a turn's
   * tool calls/model response are still in flight (often 7s+ even for a
   * plain reply, per the Claude Subscription CLI path's own overhead).
   * Browser synthesis has no generation cost, so there's nothing to cache
   * here — see useAmbientVoicePlayback's version for the generated/offline
   * voice path, which does cache.
   */
  speakAck: () => Promise<void>;
  cancel: () => void;
}

// Rotated randomly so this doesn't feel like the same canned line every
// single turn — all three are short and generic on purpose (no per-tool
// wording like "let me call web_fetch"): naming an internal tool to the user
// would be confusing/robotic, and a fixed, short phrase is also what makes
// caching the generated/offline voice's audio (useAmbientVoicePlayback)
// worthwhile in the first place.
export const ACK_PHRASES = ["Let me check on that.", "One moment please.", "Sure, one sec."];

function pickAckPhrase(): string {
  return ACK_PHRASES[Math.floor(Math.random() * ACK_PHRASES.length)];
}

const supported = typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";

/** Speak Ambient Mode's PM replies aloud. Mirrors use-voice-input.ts's shape and conventions. */
export function useTextToSpeech(): UseTextToSpeechResult {
  const [speaking, setSpeaking] = useState(false);

  const speak = useCallback((text: string, rate?: number): Promise<void> => {
    if (!supported || !text.trim()) return Promise.resolve();
    window.speechSynthesis.cancel();
    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      if (rate) utterance.rate = rate;
      utterance.onstart = () => {
        logAmbient("speechSynthesis onstart");
        setSpeaking(true);
      };
      utterance.onend = () => {
        logAmbient("speechSynthesis onend");
        setSpeaking(false);
        resolve();
      };
      utterance.onerror = (e) => {
        logAmbient(`speechSynthesis onerror: ${e.error}`);
        setSpeaking(false);
        resolve();
      };
      window.speechSynthesis.speak(utterance);
    });
  }, []);

  const speakAck = useCallback((): Promise<void> => speak(pickAckPhrase()), [speak]);

  const cancel = useCallback(() => {
    if (!supported) return;
    logAmbient("speechSynthesis.cancel() called");
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  // Stop any in-progress speech if the caller unmounts mid-utterance.
  useEffect(() => () => { if (supported) window.speechSynthesis.cancel(); }, []);

  return { supported, speaking, speak, speakAck, cancel };
}
