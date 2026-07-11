import { useEffect, useState } from "react";
import { IS_REMOTE, IS_DEV_DIRECT, forgetRemotePairing } from "@/lib/remote-transport";

type Status = "connecting" | "online" | "offline";

/** Show the "stuck — offer re-pair" affordance after this long off-line. */
const STUCK_AFTER_MS = 10_000;

/**
 * Connection-status banner for web mode (TASK-493).
 *
 * Shows a clear "connecting" / "desktop offline" bar when the relay connection
 * to the desktop is not live, so the web app never silently fails when the
 * desktop drops. Renders nothing in Electrobun (IS_REMOTE === false) or when the
 * connection is online.
 *
 * After a while stuck off-line it also surfaces a **Re-pair** escape hatch: a
 * paired-but-unreachable device (revoked, removed, or pointing at a desktop that
 * never comes back) would otherwise strand the user on "Connecting…" forever
 * with no way to enter a new code.
 */
export function RemoteStatusBanner() {
  const [status, setStatus] = useState<Status>(
    () => ((window as { __agentdeskRemoteStatus?: Status }).__agentdeskRemoteStatus ?? "connecting"),
  );
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (!IS_REMOTE || IS_DEV_DIRECT) return;
    const handler = (e: Event) => {
      const s = (e as CustomEvent<{ status?: Status }>).detail?.status;
      if (s) setStatus(s);
    };
    window.addEventListener("agentdesk:remote-status", handler);
    return () => window.removeEventListener("agentdesk:remote-status", handler);
  }, []);

  // Mark the connection "stuck" after it has been non-online for a while, so the
  // re-pair affordance doesn't flash during normal brief reconnects.
  useEffect(() => {
    if (status === "online") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStuck(false);
      return;
    }
    const t = setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => clearTimeout(t);
  }, [status]);

  if (!IS_REMOTE || IS_DEV_DIRECT || status === "online") return null;

  const message =
    status === "connecting"
      ? "Connecting to your desktop…"
      : "Your desktop is offline — will reconnect when it comes back online.";

  return (
    <div
      className="fixed inset-x-0 top-0 z-[200] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-1.5 text-center text-xs font-medium text-black shadow-md"
      role="status"
    >
      <span className="inline-flex items-center gap-2">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-black/60" />
        {message}
      </span>
      {stuck && (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-black/70">Still stuck? The device may have been removed.</span>
          <button
            type="button"
            onClick={() => forgetRemotePairing()}
            className="rounded bg-black/85 px-2 py-0.5 font-semibold text-white hover:bg-black"
          >
            Re-pair
          </button>
        </span>
      )}
    </div>
  );
}
