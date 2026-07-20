import { useEffect, useRef } from "react";
import { useAmbientStore } from "@/stores/ambient-store";
import { useChatStore } from "@/stores/chat-store";
import { useAmbientSettings } from "@/lib/use-ambient-settings";

const ACTIVITY_EVENTS = ["mousemove", "keydown", "mousedown", "wheel"] as const;

/**
 * True if something the user is actively dealing with should suppress an
 * idle-triggered Ambient Mode activation: an open dialog (UserQuestionDialog,
 * WhatsNewDialog, StartupHealthDialog, NewProjectModal, etc. — all built on
 * the same Radix Dialog/AlertDialog primitives, so a single generic query
 * covers all of them with no per-dialog wiring), an unresolved plan-approval
 * card in the conversation currently on screen (see message-bubble.tsx's
 * data-plan-approval-pending), a shell-approval prompt pending in ANY
 * project (chat-store's global shellApprovalRequests, not just the active
 * one), or active voice dictation (voice-input-button.tsx's
 * data-voice-listening).
 */
function isSomethingBlocking(): boolean {
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) {
    return true;
  }
  if (document.querySelector("[data-plan-approval-pending]")) return true;
  if (document.querySelector('[data-voice-listening="true"]')) return true;
  if (useChatStore.getState().shellApprovalRequests.length > 0) return true;
  return false;
}

/**
 * App-focus-scoped idle timer — auto-activates Ambient Mode after
 * ambientModeIdleMinutes of no mouse/keyboard activity, but only while
 * AgentDesk itself has focus (paused on window blur, resumed on focus).
 * This is NOT true OS-wide idle detection — see docs/ambient-screen-plan.md
 * Subsystem 2 for the confirmed scoping decision. Mount once at the
 * app-shell level; the Dashboard's "Ambient Mode" button bypasses this
 * entirely by calling useAmbientStore's activate() directly.
 */
export function useIdleTimer(): void {
  const activate = useAmbientStore((s) => s.activate);
  const { enabled, idleMinutes } = useAmbientSettings();
  const enabledRef = useRef(enabled);
  const idleMinutesRef = useRef(idleMinutes);
  const openRef = useRef(false);
  const pausedRef = useRef(document.visibilityState === "hidden" || !document.hasFocus());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep openRef in sync so the activity/blur listeners (mounted once, below)
  // can read the latest value without needing to re-subscribe.
  useEffect(() => useAmbientStore.subscribe((s) => { openRef.current = s.open; }), []);

  // Mirror the live settings into refs so the scheduling effect below (which
  // intentionally never re-subscribes its listeners) always reads current
  // values without needing enabled/idleMinutes in its dependency array.
  useEffect(() => {
    enabledRef.current = enabled;
    idleMinutesRef.current = idleMinutes;
  }, [enabled, idleMinutes]);

  useEffect(() => {
    function clearTimer() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function scheduleTimer() {
      clearTimer();
      if (!enabledRef.current || pausedRef.current || openRef.current) return;
      timerRef.current = setTimeout(() => {
        if (!enabledRef.current || pausedRef.current || openRef.current) return;
        if (isSomethingBlocking()) {
          // Don't drop the idle window entirely — check again shortly.
          timerRef.current = setTimeout(() => scheduleTimer(), 15_000);
          return;
        }
        activate({ idle: true });
      }, idleMinutesRef.current * 60_000);
    }

    function onActivity() {
      scheduleTimer();
    }

    function onBlur() {
      pausedRef.current = true;
      clearTimer();
    }
    function onFocus() {
      pausedRef.current = false;
      scheduleTimer();
    }

    for (const evt of ACTIVITY_EVENTS) {
      document.addEventListener(evt, onActivity);
    }
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);

    scheduleTimer();

    return () => {
      clearTimer();
      for (const evt of ACTIVITY_EVENTS) {
        document.removeEventListener(evt, onActivity);
      }
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [activate]);
}
