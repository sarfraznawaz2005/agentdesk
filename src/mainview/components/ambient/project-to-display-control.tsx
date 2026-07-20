import { useState, useCallback, useRef, useEffect } from "react";
import { Monitor } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { ACCENT } from "./ambient-radar-view";
import type { AmbientDisplayDto } from "../../../shared/rpc/ambient";

/**
 * "Project to display" — lists connected displays via Screen.getAllDisplays()
 * (rpc.getAmbientDisplays()) and opens a second, dedicated BrowserWindow on
 * whichever one is picked (docs/ambient-screen-plan.md Subsystem 7). Most
 * Ambient Mode opens (button press, idle timeout) never touch this — it's an
 * additive, explicit action layered on top of the default in-window overlay.
 */
export function ProjectToDisplayControl() {
  const [open, setOpen] = useState(false);
  const [displays, setDisplays] = useState<AmbientDisplayDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [projecting, setProjecting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Ground truth, not just this component's own optimistic state — the
  // projected window can also be closed via its own Exit button (or the OS),
  // a path this component never observes directly since that's a separate
  // window/JS context. Polling corrects drift within a few seconds; the
  // handlePick/handleStop below still update state instantly for the path
  // the user directly clicks here.
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      rpc.getAmbientProjectionState().then((r) => {
        if (!cancelled) setProjecting(r.projecting);
      }).catch(() => {});
    };
    sync();
    const interval = setInterval(sync, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        setLoading(true);
        rpc.getAmbientDisplays().then(setDisplays).catch(() => setDisplays([])).finally(() => setLoading(false));
      }
      return next;
    });
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const handlePick = useCallback((displayId: number) => {
    rpc.openAmbientDisplayWindow(displayId).then((result) => {
      if (result.success) setProjecting(true);
    }).catch(() => {});
    setOpen(false);
  }, []);

  const handleStop = useCallback(() => {
    rpc.closeAmbientDisplayWindow().catch(() => {});
    setProjecting(false);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={projecting ? handleStop : toggleOpen}
        className="flex h-11 items-center justify-center gap-2 border px-4 text-sm font-semibold uppercase tracking-wide"
        style={{ borderColor: "rgba(0,204,255,.4)", color: ACCENT, touchAction: "manipulation" }}
      >
        <Monitor className="h-4 w-4" aria-hidden="true" />
        {projecting ? "Stop projecting" : "Start projecting"}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-20 mt-2 w-64 border"
          style={{ borderColor: "rgba(0,204,255,.4)", background: "#08101a" }}
        >
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider" style={{ color: "rgba(220,240,250,.75)" }}>
            Project to display
          </div>
          {loading ? (
            <div className="px-3 pb-3 text-xs" style={{ color: "rgba(220,240,250,.8)" }}>Loading displays…</div>
          ) : displays.length === 0 ? (
            <div className="px-3 pb-3 text-xs" style={{ color: "rgba(220,240,250,.8)" }}>No other displays connected.</div>
          ) : (
            <ul>
              {displays.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => handlePick(d.id)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-white/5"
                    style={{ color: "#F2FBFF", touchAction: "manipulation" }}
                  >
                    <span>{d.isPrimary ? "Primary display" : `Display ${d.id}`}</span>
                    <span className="font-mono" style={{ color: "rgba(220,240,250,.8)" }}>
                      {d.bounds.width}×{d.bounds.height}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
