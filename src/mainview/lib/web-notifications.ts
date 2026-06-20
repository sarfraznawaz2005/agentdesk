/**
 * Web notifications for approval events (TASK-490, v1).
 *
 * When the web app's tab is backgrounded, surface the "needs you" moments as OS
 * notifications via the Notification API — so a plan/approval/question doesn't
 * sit unseen. This covers the common case (the tab is open or backgrounded).
 *
 * NOTE: true CLOSED-browser push (Web Push + VAPID + desktop-sends-push) is a
 * follow-up; it requires a push subscription relayed to the desktop and the Web
 * Push protocol on the desktop side. This v1 needs no server/VAPID and works the
 * moment the user grants permission.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const APPROVAL_EVENTS: Record<string, (detail: any) => { title: string; body: string }> = {
  "agentdesk:plan-presented": () => ({
    title: "Plan needs approval",
    body: "Your agent prepared a plan — review and approve it.",
  }),
  "agentdesk:shell-approval-request": (d) => ({
    title: "Approval needed",
    body: `Run command: ${typeof d?.command === "string" ? d.command.slice(0, 120) : "…"}`,
  }),
  "agentdesk:user-question-request": (d) => ({
    title: "Your agent needs input",
    body: typeof d?.question === "string" ? d.question.slice(0, 160) : "Your agent asked a question.",
  }),
};
/* eslint-enable @typescript-eslint/no-explicit-any */

let initialised = false;

export function initWebNotifications(): void {
  if (initialised || typeof window === "undefined" || !("Notification" in window)) return;
  initialised = true;

  // Ask for permission on the first user gesture (browsers block auto-prompts).
  const ask = () => {
    window.removeEventListener("pointerdown", ask);
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  };
  window.addEventListener("pointerdown", ask, { once: true });

  for (const [event, build] of Object.entries(APPROVAL_EVENTS)) {
    window.addEventListener(event, (e: Event) => {
      if (Notification.permission !== "granted") return;
      // Only notify when the tab isn't focused — otherwise the in-app UI already shows it.
      if (!document.hidden) return;
      try {
        const { title, body } = build((e as CustomEvent).detail);
        const n = new Notification(title, { body, icon: "/icon.png", tag: event });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        /* ignore */
      }
    });
  }
}
