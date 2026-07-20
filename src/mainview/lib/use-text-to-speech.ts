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
   * calls, which would otherwise cancel each other.
   */
  speak: (text: string) => Promise<void>;
  cancel: () => void;
}

const supported = typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";

/** Speak Ambient Mode's PM replies aloud. Mirrors use-voice-input.ts's shape and conventions. */
export function useTextToSpeech(): UseTextToSpeechResult {
  const [speaking, setSpeaking] = useState(false);

  const speak = useCallback((text: string): Promise<void> => {
    if (!supported || !text.trim()) return Promise.resolve();
    window.speechSynthesis.cancel();
    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
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

  const cancel = useCallback(() => {
    if (!supported) return;
    logAmbient("speechSynthesis.cancel() called");
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  // Stop any in-progress speech if the caller unmounts mid-utterance.
  useEffect(() => () => { if (supported) window.speechSynthesis.cancel(); }, []);

  return { supported, speaking, speak, cancel };
}
