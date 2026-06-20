import { useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { UnreadDot } from "@/components/ui/unread-dot";
import { useDashboardLauncherStore } from "@/stores/dashboard-launcher-store";

/**
 * Floating action button that consolidates the dashboard chat launchers (PM +
 * every chat-enabled agent) into a single button + popover sheet, on all screen
 * sizes. Without it the launchers render as a row of labelled pills that stack
 * into many rows and bury the dashboard once a few agents are enabled.
 *
 * Each launcher widget hides its own pill and registers itself (id, name,
 * colour, unread) in the shared launcher store; this FAB lists every registered
 * launcher by name + colour dot and re-opens the chosen one through the store.
 * The chat panels themselves still live inside each widget.
 *
 * Self-hides when nothing is registered (i.e. off the dashboard) or while a
 * launcher's chat panel is already open (so it never overlaps the panel).
 */
export function ChatFab() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const entriesMap   = useDashboardLauncherStore((s) => s.entries);
  const activeOpenId = useDashboardLauncherStore((s) => s.activeOpenId);
  const requestOpen  = useDashboardLauncherStore((s) => s.requestOpen);

  const entries = Object.values(entriesMap).sort(
    (a, b) =>
      a.order - b.order ||
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );

  // Nothing to launch, or a chat panel already owns the screen → stand down.
  if (entries.length === 0 || activeOpenId) return null;

  const anyUnread = entries.some((e) => e.unread);

  return (
    <div>
      {sheetOpen && (
        <>
          {/* Scrim — tap to dismiss */}
          <div
            className="fixed inset-0 z-[55] bg-black/30"
            onClick={() => setSheetOpen(false)}
            aria-hidden="true"
          />
          {/* Launcher list — PM (order 0) pinned on top, a divider, then the
              custom agents (order 1) alphabetically. Width hugs the content
              (capped to 80vw, names truncate beyond that). */}
          <div className="fixed bottom-24 right-4 z-[57] w-max max-w-[80vw] max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-background py-1 shadow-2xl">
            {entries.map((e, i) => {
              const prev = entries[i - 1];
              const needsDivider = prev && prev.order !== e.order;
              return (
                <div key={e.id}>
                  {needsDivider && <div className="my-1 h-px bg-border" role="separator" />}
                  <button
                    type="button"
                    onClick={() => {
                      requestOpen(e.id);
                      setSheetOpen(false);
                    }}
                    className="flex w-full items-center gap-3 px-6 py-2.5 text-left text-sm hover:bg-muted transition-colors"
                  >
                    <span
                      className="h-4 w-4 shrink-0 rounded-full"
                      style={{ backgroundColor: e.color }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{e.displayName}</span>
                    {e.unread && <UnreadDot className="shrink-0" />}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* FAB */}
      <button
        type="button"
        onClick={() => setSheetOpen((v) => !v)}
        className={cn(
          "fixed bottom-6 right-6 z-[57] flex h-14 w-14 items-center justify-center rounded-full",
          "bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors",
        )}
        aria-label={sheetOpen ? "Close chats" : "Open chats"}
      >
        {sheetOpen
          ? <X className="h-6 w-6" strokeWidth={2.5} aria-hidden="true" />
          : <MessageSquare className="h-6 w-6" strokeWidth={2.5} aria-hidden="true" />}
        {!sheetOpen && anyUnread && <UnreadDot className="absolute -top-0.5 -right-0.5" />}
      </button>
    </div>
  );
}
