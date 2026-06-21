import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { rpc } from "@/lib/rpc";

/**
 * Global "maintenance underway" overlay.
 *
 * Some DB maintenance ops (PRAGMA optimize, full/background VACUUM) hold a
 * database lock and stall queries app-wide — long enough that every page just
 * shows skeleton loaders. The backend broadcasts `agentdesk:maintenance` around
 * those ops; this overlay sits above all pages (mounted in the AppShell) and
 * shows a clear "please wait" message instead, no matter which page the user is
 * on. It also fetches the current state on mount so a reload mid-maintenance
 * still shows it.
 */
export function MaintenanceOverlay() {
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    // Sync initial state (covers a reload that lands mid-maintenance).
    rpc
      .getMaintenanceStatus()
      .then((s) => {
        if (!cancelled && s.active) {
          setActive(true);
          setMessage(s.message);
        }
      })
      .catch(() => {
        /* not available / not ready — ignore */
      });

    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ active: boolean; message: string }>).detail;
      setActive(detail.active);
      setMessage(detail.active ? detail.message : "");
    };
    window.addEventListener("agentdesk:maintenance", onEvent);
    return () => {
      cancelled = true;
      window.removeEventListener("agentdesk:maintenance", onEvent);
    };
  }, []);

  // While active, make this a hard block: the full-screen layer already eats mouse
  // clicks, so additionally swallow keyboard input (capture phase, before any app
  // shortcut / Tab navigation can fire) and lock page scroll. The user cannot reach
  // any other page until maintenance clears the flag on its own.
  useEffect(() => {
    if (!active) return;
    const blockKeys = (e: KeyboardEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("keydown", blockKeys, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", blockKeys, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [active]);

  if (!active) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background/85 backdrop-blur-sm"
      role="alertdialog"
      aria-busy="true"
      aria-live="assertive"
    >
      <div className="mx-4 flex max-w-sm flex-col items-center gap-4 rounded-xl border border-border bg-card p-8 text-center shadow-2xl">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold">Maintenance in progress</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {message || "AgentDesk is tidying up its database. This will finish momentarily — please wait."}
          </p>
        </div>
      </div>
    </div>
  );
}
