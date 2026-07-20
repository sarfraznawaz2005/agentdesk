/* eslint-disable react-refresh/only-export-components */
import { useMemo, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActivityLogEntry } from "@/lib/use-global-agent-activity";

// Beacon design tokens — see mockups/ambient-screen/14-beacon.html for the
// original radar/sonar ops scope layout (sharp edges, no glassmorphism);
// the accent was later moved from the mockup's amber to a blue sampled
// directly from the app's own logo (assets/icon.png: #008ECC/#00CCFF) at the
// user's request. Font choice substitutes the mockup's Google-Fonts
// Rajdhani/JetBrains Mono for the platform's own sans/mono stacks — this app
// self-hosts its one custom font (Scheherazade) rather than loading from a
// CDN, so pulling two more webfonts just for this screen would be the odd
// one out; the radar sweep and sharp panels are what make Beacon
// recognizable, not the exact typeface or accent hue.
export const ACCENT = "#00CCFF";
export const BG = "#05090F";
export const FG = "#DCEFFA";

// Per-agent-type accent, mirroring the color families the Chat page's running-
// agent badge uses (AGENT_BADGE_COLORS in components/chat/message-parts.tsx) —
// re-picked as bright/400-range hexes since Beacon's dark background can't use
// that badge's light-mode Tailwind classes directly. Falls back to ACCENT for
// any agent type not listed here, same as the chat badge's own fallback.
const AGENT_DOT_COLORS: Record<string, string> = {
  "backend-engineer": "#60a5fa",
  "frontend_engineer": "#c084fc",
  "software-architect": "#818cf8",
  "code-reviewer": "#f472b6",
  "qa-engineer": "#2dd4bf",
  "task-planner": "#fbbf24",
  "debugging-specialist": "#f87171",
  "performance-expert": "#fb923c",
  "security-expert": "#fb7185",
  "documentation-expert": "#4ade80",
  "devops-engineer": "#22d3ee",
  "ui-ux-designer": "#a78bfa",
  "data-engineer": "#a3e635",
  "refactoring-specialist": "#facc15",
  "code-explorer": "#38bdf8",
  "playground-agent": "#fb923c",
  "issue-fixer": "#f87171",
};

export function agentDotColor(agentKey?: string): string {
  return (agentKey && AGENT_DOT_COLORS[agentKey]) || ACCENT;
}

export function formatClock(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface AmbientChromeProps {
  brand: string;
  clock: Date;
  onExit: () => void;
  exitLabel: string;
  /** Header slot rendered just before the Exit button — the live overlay's "Project to display" control. */
  headerExtra?: ReactNode;
  /** Bottom-of-screen slot — the live overlay's Talk to PM button; omitted on the projected/TV view. */
  footer?: ReactNode;
  /** How much width to reserve on the right (e.g. for the tool-call pane)
   *  when centering `footer` — without this the button stays centered over
   *  the FULL width even while the pane pushes the content beside it to the
   *  left, so the two drift out of alignment. Defaults to "0px" (center over
   *  the full width, the original behavior). */
  footerRightInset?: string;
  children: ReactNode;
}

/**
 * Shared root + header (brand, clock, exit) — used by both the live
 * in-window overlay (ambient-screen.tsx) and the projected TV/display window
 * (ambient-display-page.tsx) so there's exactly one implementation of this
 * chrome, not two (docs/ambient-screen-plan.md Subsystem 7). `children` is
 * whatever fills the middle (the ambient radar content, or the live
 * overlay's engaged/voice state).
 */
export function AmbientChrome({ brand, clock, onExit, exitLabel, headerExtra, footer, footerRightInset, children }: AmbientChromeProps) {
  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col overflow-hidden select-none"
      style={{ background: BG, color: FG }}
      role="dialog"
      aria-modal="true"
      aria-label="Ambient Mode"
    >
      <div
        className="relative z-20 flex items-center justify-between gap-4 border-b px-8 py-5"
        style={{ borderColor: "rgba(0,204,255,.2)" }}
      >
        <div className="text-sm font-bold uppercase tracking-[0.2em]" style={{ color: ACCENT }}>
          {brand}
        </div>
        <div className="font-mono text-lg tabular-nums" style={{ color: "rgba(220,240,250,.95)" }}>
          {formatClock(clock)}
        </div>
        <div className="flex items-center gap-2">
          {headerExtra}
          <button
            type="button"
            onClick={onExit}
            className="flex h-11 min-w-11 items-center justify-center gap-2 border px-4 text-sm font-semibold uppercase tracking-wide"
            style={{ borderColor: "rgba(0,204,255,.4)", color: ACCENT, touchAction: "manipulation" }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            {exitLabel}
          </button>
        </div>
      </div>

      <div className="relative flex flex-1 overflow-hidden">
        {children}
        {/* Floats over the content instead of taking its own flex row — that
            row-space allocation (h-12 button + its own padding) was pushing
            the content above it short of the true bottom edge, so its own
            bottom-8 inset landed noticeably higher than this button's. Now
            content fills the full remaining height (matching top-8 exactly
            at the bottom too), and the button overlays near the bottom. */}
        {footer && (
          <div
            className="absolute bottom-8 left-0 z-10 flex items-center justify-center transition-[right] duration-300 ease-out"
            style={{ right: footerRightInset ?? "0px" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export interface AmbientProjectRow {
  id: string;
  name: string;
  activeAgents: number;
  done: number;
  total: number;
}

export interface AmbientRadarContentProps {
  projectRows: AmbientProjectRow[];
  agentsActiveNow: number;
  tasksDone: number;
  awaitingYou: number;
  projectNames: Record<string, string>;
  /** Omit entirely to hide the activity log panel. Both consumers pass this today —
   * the live overlay from its own push-driven rolling log, the projected/TV view
   * from the same backend-side ring buffer the polled snapshot RPC now includes. */
  activityLog?: ActivityLogEntry[];
}

/**
 * The ambient (idle) radar scope's content: stat strip, radar with one blip
 * per project, and the activity log. Rendered inside AmbientChrome by both
 * consumers.
 */
export function AmbientRadarContent({
  projectRows,
  agentsActiveNow,
  tasksDone,
  awaitingYou,
  projectNames,
  activityLog,
}: AmbientRadarContentProps) {
  // Arrange one blip per project evenly around the radar's circumference.
  const blips = useMemo(() => {
    const n = projectRows.length;
    const radiusPct = 34;
    return projectRows.map((p, i) => {
      const angle = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
      const top = 50 + radiusPct * Math.sin(angle);
      const left = 50 + radiusPct * Math.cos(angle);
      return { ...p, top, left };
    });
  }, [projectRows]);

  return (
    <div className="relative flex flex-1 gap-8 overflow-hidden p-8">
      {/* Stat strip — matches the activity log's width and, like it, stretches
          to fill the full height available between the header and footer.
          A plain flex column (not absolute+inset) so height comes from
          flexbox stretch, guaranteed to match the row's real height instead
          of depending on top/bottom inset math against the nearest
          positioned ancestor. */}
      <div className="z-10 flex w-80 shrink-0 flex-col gap-4">
        {[
          { n: agentsActiveNow, l: "Agents active" },
          { n: tasksDone, l: "Tasks done" },
          { n: awaitingYou, l: "Awaiting you" },
        ].map((stat) => (
          <div
            key={stat.l}
            className="flex flex-1 flex-col items-center justify-center border px-6 text-center"
            style={{ borderColor: "rgba(0,204,255,.3)", background: "rgba(8,14,20,.7)" }}
          >
            <div className="font-mono text-5xl font-bold" style={{ color: ACCENT }}>{stat.n}</div>
            <div className="mt-1 text-sm uppercase tracking-wider" style={{ color: "rgba(220,240,250,.7)" }}>
              {stat.l}
            </div>
          </div>
        ))}
      </div>

      {/* Radar scope — pb-24 keeps the circle's centering clear of the
          floating "Talk to PM" button (AmbientChrome positions it at
          bottom-8 over this same content area), so its bottom arc doesn't
          render behind the button now that this row spans the full height. */}
      <div className="flex flex-1 items-center justify-center pb-24">
        <div
          className="relative aspect-square w-[min(70vh,70vw)] rounded-full border"
          style={{
            borderColor: "rgba(0,204,255,.3)",
            background:
              "repeating-radial-gradient(circle, transparent 0, transparent 12%, rgba(0,204,255,.08) 12.5%)",
          }}
        >
          <div
            className="ambient-sweep absolute inset-0 rounded-full"
            style={{
              background: `conic-gradient(from 0deg, rgba(0,204,255,.35), transparent 22%, transparent 100%)`,
            }}
          />
          <div
            className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ background: FG, boxShadow: `0 0 10px ${FG}` }}
          />
          {blips.map((b) => (
            <div
              key={b.id}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ top: `${b.top}%`, left: `${b.left}%` }}
            >
              <div
                className={cn("h-2.5 w-2.5 rounded-full", b.activeAgents > 0 && "ambient-blip")}
                style={
                  b.activeAgents > 0
                    ? { background: ACCENT, boxShadow: `0 0 14px 4px rgba(0,204,255,.6)` }
                    : { background: "#4a5560" }
                }
              />
              <div
                className="absolute left-3.5 top-[-4px] whitespace-nowrap text-xs font-semibold"
                style={{ color: b.activeAgents > 0 ? FG : "rgba(220,240,250,.65)" }}
              >
                {b.name}
                <span
                  className="block font-mono text-[10px] font-normal"
                  style={{ color: "rgba(220,240,250,.75)" }}
                >
                  {b.activeAgents > 0 ? `${b.activeAgents} agent(s) active` : "idle"} · {b.done}/{b.total}
                </span>
              </div>
            </div>
          ))}
          {blips.length === 0 && (
            <div
              className="absolute left-1/2 top-1/2 w-48 -translate-x-1/2 -translate-y-1/2 text-center text-xs"
              style={{ color: "rgba(220,240,250,.65)" }}
            >
              No project activity yet.
            </div>
          )}
        </div>
      </div>

      {/* Activity log — omitted entirely when no rolling log is available. */}
      {activityLog && (
        <div
          className={cn(
            "z-10 flex w-80 shrink-0 flex-col overflow-hidden border p-4",
            activityLog.length === 0 && "items-center justify-center text-center",
          )}
          style={{ borderColor: "rgba(0,204,255,.3)", background: "rgba(8,14,20,.7)" }}
        >
          {activityLog.length === 0 ? (
            <>
              <div className="mb-2 text-xs font-bold uppercase tracking-wider" style={{ color: ACCENT }}>
                Activity Log
              </div>
              <div className="text-xs" style={{ color: "rgba(220,240,250,.65)" }}>No activity yet.</div>
            </>
          ) : (
            <>
              <div className="mb-2 shrink-0 text-xs font-bold uppercase tracking-wider" style={{ color: ACCENT }}>
                Activity Log
              </div>
              <ul className="ambient-scroll min-h-0 flex-1 space-y-1.5 overflow-auto text-left font-mono text-[11px]" style={{ color: "rgba(220,240,250,.9)" }}>
                {activityLog.map((entry) => (
                  <li
                    key={entry.id}
                    className="break-words border-b border-dashed pb-1.5"
                    style={{ borderColor: "rgba(0,204,255,.15)" }}
                  >
                    <span style={{ color: ACCENT }}>
                      {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>{" "}
                    {projectNames[entry.projectId] ?? entry.projectId} →{" "}
                    {entry.agentKey && (
                      <span className="inline-flex items-center gap-1">
                        <span
                          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: agentDotColor(entry.agentKey) }}
                        />
                        <span style={{ color: agentDotColor(entry.agentKey) }}>{entry.agentLabel}</span>
                      </span>
                    )}{" "}
                    {entry.text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
