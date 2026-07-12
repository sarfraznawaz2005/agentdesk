import { useState, useRef, useCallback, useEffect } from "react";

// ---------------------------------------------------------------------------
// Web Speech API (voice input) — minimal typings, not in TS's DOM lib yet.
// `webkitSpeechRecognition` is a Chromium/Blink API (works under WebView2 on
// Windows and CEF on Linux); WKWebView on macOS has never implemented it, so
// `SpeechRecognitionCtor` is undefined there and callers should feature-detect
// via the returned `supported` flag.
// ---------------------------------------------------------------------------
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: { transcript: string };
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

export interface UseVoiceInputResult {
  /** False if this webview has no speech engine — callers should hide the mic button entirely. */
  supported: boolean;
  listening: boolean;
  error: string | null;
  toggle: () => void;
  /** Stop any in-progress session — call this before sending, so the mic doesn't keep listening in the background. */
  stop: () => void;
}

/**
 * Shared voice-input session for a single-string text input. Live transcript is
 * appended after whatever text was already in the box when recording started, so
 * voice input composes with typed text rather than replacing it.
 *
 * `setValue` only ever gets called with a plain string (never the functional-
 * updater form), so a plain `useState` setter, a `(v: string) => void` onChange
 * prop, or a richer handler like chat-input.tsx's `handleInputChange` (which
 * also does popover detection and forwards to an external `onInputChange` prop)
 * all work as-is — pass whichever one the caller already has.
 */
export function useVoiceInput(value: string, setValue: (value: string) => void, onEnd?: () => void): UseVoiceInputResult {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Text already in the box when recording started — captured once at start(),
  // read again inside onresult (which can fire many times per session).
  const baseValueRef = useRef("");
  const onEndRef = useRef(onEnd);
  useEffect(() => { onEndRef.current = onEnd; });

  const start = useCallback(() => {
    if (!SpeechRecognitionCtor || recognitionRef.current) return;
    setError(null);
    baseValueRef.current = value;
    let finalText = "";
    const rec = new SpeechRecognitionCtor();
    recognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onstart = () => setListening(true);
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      const base = baseValueRef.current;
      const separator = base && !base.endsWith(" ") && !base.endsWith("\n") ? " " : "";
      setValue(`${base}${separator}${(finalText + interim).trim()}`);
    };
    rec.onerror = (e) => {
      // "aborted" fires on our own stop() call — not a real error.
      if (e.error === "aborted") return;
      setError(e.error === "not-allowed" ? "Microphone access denied" : `Voice input error: ${e.error}`);
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      onEndRef.current?.();
    };
    rec.start();
  }, [value, setValue]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  // Stop any in-progress recognition (and release the mic) if the caller unmounts mid-session.
  useEffect(() => () => recognitionRef.current?.stop(), []);

  return { supported: !!SpeechRecognitionCtor, listening, error, toggle, stop };
}
