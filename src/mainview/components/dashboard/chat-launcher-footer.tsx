import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronUp, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { UnreadDot } from "@/components/ui/unread-dot";
import { useDashboardLauncherStore, type LauncherEntry } from "@/stores/dashboard-launcher-store";

const GAP_PX = 8; // matches the row's gap-2

function PillBody({ entry }: { entry: LauncherEntry }) {
  return (
    <>
      <span
        // ring-inset gives the dot a fixed contrasting edge so it stays legible
        // even if the user picks a colour close to the pill's own bg-muted fill.
        className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/15 dark:ring-white/25"
        style={{ backgroundColor: entry.color }}
        aria-hidden="true"
      />
      <span className="max-w-[140px] truncate">{entry.displayName}</span>
      {/* Streaming takes priority over the static unread dot — it's the more
          specific, actionable signal ("working on it right now" vs. "there's
          a reply you haven't seen"), and keeps showing even off the Dashboard
          or with the panel closed since the widget stays mounted app-wide.
          Badged at the top-right corner, matching the UnreadDot convention
          used elsewhere (nav items, the original per-widget trigger pills). */}
      {entry.streaming ? (
        <Loader2
          className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-background text-red-500 animate-spin"
          aria-label="Working…"
        />
      ) : (
        entry.unread && <UnreadDot className="absolute -top-1 -right-1" />
      )}
    </>
  );
}

function Pill({ entry, active, onClick }: { entry: LauncherEntry; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative inline-flex shrink-0 items-center gap-2 rounded-full border bg-muted px-3 py-1 text-xs font-medium text-foreground transition-colors",
        // "Open" state is signalled by the border only (never a fill colour) —
        // an agent's own colour (user-chosen, arbitrary) could otherwise match
        // a fixed accent fill and swallow its identity dot below.
        active ? "border-primary" : "border-border hover:bg-muted/70",
      )}
    >
      <PillBody entry={entry} />
    </button>
  );
}

/**
 * Persistent footer bar, scoped to the main content area (i.e. excluding the
 * sidebar), listing every registered chat launcher (PM + every chat-enabled
 * agent) directly — no FAB, no popover. Available on every page, above the
 * page content. Clicking an entry toggles its own chat panel open/closed in
 * its usual spot (bottom-right); the panels themselves still live inside each
 * widget — this bar only relays which one to toggle via `requestOpen`.
 *
 * When there are more launchers than fit in one row, the overflow collapses
 * into a "+N more" pill that opens a small popover list for the rest — rather
 * than silently scrolling off-screen with no indication more exist.
 */
export function ChatLauncherFooter({ sidebarCollapsed, isMobile }: { sidebarCollapsed: boolean; isMobile: boolean }) {
  const entriesMap   = useDashboardLauncherStore((s) => s.entries);
  const activeOpenId = useDashboardLauncherStore((s) => s.activeOpenId);
  const requestOpen  = useDashboardLauncherStore((s) => s.requestOpen);

  const entries = Object.values(entriesMap).sort(
    (a, b) =>
      a.order - b.order ||
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );

  const containerRef      = useRef<HTMLDivElement>(null);
  const measureRef        = useRef<HTMLDivElement>(null);
  const moreMeasureRef    = useRef<HTMLDivElement>(null); // hidden stand-in, always mounted — see note below
  const moreContainerRef  = useRef<HTMLDivElement>(null); // the real, visible "+N more" wrapper (for outside-click only)
  const menuRef           = useRef<HTMLDivElement>(null); // the portaled dropdown itself (also needed for outside-click)
  const [visibleCount, setVisibleCount] = useState(entries.length);
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ bottom: number; right: number } | null>(null);

  // The dropdown is portaled to document.body (see render below) so it isn't
  // clipped by this bar's own `overflow-hidden` — it needs its position
  // computed from the trigger's live viewport rect instead of relying on
  // normal-flow `position: absolute` placement.
  const recomputeMenuPos = () => {
    const rect = moreContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPos({ bottom: window.innerHeight - rect.top + GAP_PX, right: window.innerWidth - rect.right });
  };

  // Measure each pill's natural (unconstrained) width via a hidden clone row,
  // then figure out how many fit the real row's current width — reserving
  // room for the "+N more" pill whenever it isn't everything that fits. The
  // "+N more" stand-in is measured from a hidden clone (moreMeasureRef) that's
  // always mounted, rather than the real button — the real one only mounts
  // *after* we already know there's overflow, which would make its width
  // unavailable on the very pass that decides whether to show it at all.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    const moreEl = moreMeasureRef.current;
    if (!container || !measure) return;

    const recompute = () => {
      const available = container.clientWidth;
      const pillEls = Array.from(measure.children) as HTMLElement[];
      const widths = pillEls.map((el) => el.getBoundingClientRect().width);
      const moreWidth = moreEl ? moreEl.getBoundingClientRect().width : 0;

      let used = 0;
      let count = 0;
      for (let i = 0; i < widths.length; i++) {
        const withThis = used + (count > 0 ? GAP_PX : 0) + widths[i];
        const isLast = i === widths.length - 1;
        const reserve = isLast ? 0 : GAP_PX + moreWidth;
        if (withThis + reserve > available && count > 0) break;
        used = withThis;
        count++;
      }
      setVisibleCount(count);
    };

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(container);
    return () => ro.disconnect();
    // Re-measure whenever the set of launchers or the sidebar's width changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.map((e) => `${e.id}:${e.displayName}`).join(","), sidebarCollapsed, isMobile]);

  // Close the overflow popover on an outside click. The menu itself is
  // portaled to document.body (see render below), so a click inside it is
  // NOT a descendant of moreContainerRef — check menuRef too, or selecting
  // an entry would close the menu (via this mousedown handler) before its
  // own click handler ever runs.
  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (moreContainerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMoreOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [moreOpen]);

  // Keep the portaled menu anchored to the trigger if the viewport resizes
  // while it's open (the trigger's own horizontal position can shift when
  // the footer's visibleCount recomputes).
  useEffect(() => {
    if (!moreOpen) return;
    window.addEventListener("resize", recomputeMenuPos);
    return () => window.removeEventListener("resize", recomputeMenuPos);
  }, [moreOpen]);

  if (entries.length === 0) return null;

  const visible = entries.slice(0, visibleCount);
  const overflow = entries.slice(visibleCount);

  return (
    <div
      ref={containerRef}
      // z-40 (not higher): the expanded-chat Dialog's scrim (DialogOverlay) is
      // z-50 and covers the whole app — this bar must sit below that so it
      // dims along with everything else instead of poking through on top of it.
      // h-11 (44px) is a fixed height, not padding-driven — app-shell.tsx
      // reserves the same 44px (`pb-11` on #main-scroll-container) so every
      // page's own bottom-anchored content (chat inputs, etc.) has room above
      // this bar instead of being covered by it.
      className="fixed bottom-0 z-40 flex h-11 items-center justify-center gap-2 overflow-hidden border-t border-border bg-muted/80 backdrop-blur-sm px-3"
      style={{ left: isMobile ? 0 : sidebarCollapsed ? 60 : 200, right: 0 }}
    >
      {/* Hidden measuring clone — same markup/classes as the real pills (plus a
          "+N more" stand-in, using the full entry count as a safe upper-bound
          label width), laid out off-screen so we can read each one's natural
          width before deciding what's actually shown. */}
      <div ref={measureRef} className="invisible absolute -z-10 flex gap-2 whitespace-nowrap" aria-hidden="true">
        {entries.map((e) => (
          <Pill key={e.id} entry={e} active={false} onClick={() => {}} />
        ))}
        <div ref={moreMeasureRef} className="inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium">
          +{entries.length} more <ChevronUp className="h-3 w-3" aria-hidden="true" />
        </div>
      </div>

      {visible.map((e) => (
        <Pill key={e.id} entry={e} active={activeOpenId === e.id} onClick={() => requestOpen(e.id)} />
      ))}

      {overflow.length > 0 && (
        <div ref={moreContainerRef} className="relative">
          <button
            type="button"
            onClick={() => {
              setMoreOpen((v) => {
                const next = !v;
                if (next) recomputeMenuPos();
                return next;
              });
            }}
            className="relative inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/70"
          >
            +{overflow.length} more
            <ChevronUp className={cn("h-3 w-3 transition-transform", !moreOpen && "rotate-180")} aria-hidden="true" />
            {overflow.some((e) => e.streaming) ? (
              <Loader2 className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-background text-red-500 animate-spin" aria-label="Working…" />
            ) : (
              overflow.some((e) => e.unread) && <UnreadDot className="absolute -top-1 -right-1" />
            )}
          </button>

          {moreOpen && menuPos && createPortal(
            <div
              ref={menuRef}
              // Portaled to document.body and positioned via `fixed` from the
              // trigger's live rect — the footer bar's own `overflow-hidden`
              // (needed to keep the hidden pill-measuring clone from affecting
              // layout) would otherwise clip this dropdown, since it renders
              // above the bar's own 44px-tall box.
              style={{ bottom: menuPos.bottom, right: menuPos.right }}
              className="fixed z-50 w-max max-w-[80vw] max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-background py-1 shadow-2xl"
            >
              {overflow.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => { requestOpen(e.id); setMoreOpen(false); }}
                  className={cn(
                    "relative flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors hover:bg-muted",
                    activeOpenId === e.id && "text-primary font-medium",
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/15 dark:ring-white/25"
                    style={{ backgroundColor: e.color }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{e.displayName}</span>
                  {e.streaming ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-red-500" aria-label="Working…" />
                  ) : (
                    e.unread && <UnreadDot className="shrink-0" />
                  )}
                </button>
              ))}
            </div>,
            document.body,
          )}
        </div>
      )}
    </div>
  );
}
