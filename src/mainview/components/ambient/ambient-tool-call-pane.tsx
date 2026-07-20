import { useEffect, useMemo, useRef, useState } from "react";
import { Wrench, Loader2, Check, X, ChevronDown, ChevronRight } from "lucide-react";
import { ACCENT } from "./ambient-radar-view";
import type { AmbientAssistantPartDto } from "../../../shared/rpc/ambient";

/**
 * Live tool-call visibility for the Ambient Assistant's real turn
 * (docs/ambient-pm-voice-plan.md Subsystem 5) — slides in from the right
 * whenever there's at least one turn to show, mirroring the running/
 * complete/error visual language the normal per-project chat UI already
 * uses for tool calls (message-parts.tsx's icon + label + expandable-content
 * pattern), re-themed for Beacon's dark/ACCENT palette rather than imported
 * wholesale — that component is tightly coupled to persisted conversation
 * data this one-shot turn doesn't have.
 */
// Distinct from ACCENT (cyan, used for tool rows/answers) so the user's own
// spoken words read as a different "speaker" at a glance rather than
// blending into the system's own tool/answer styling.
const USER_COLOR = "#FFC65C";

// The pane's own content width (48rem) plus its right margin (mr-8 = 2rem) —
// the total horizontal space it reserves in the row when visible. Exported
// so ambient-screen.tsx can keep the "Talk to PM"/"Ask again" footer button
// centered over the same remaining area the pane pushes the center content
// into, instead of the button staying centered over the full screen width.
export const TOOL_CALL_PANE_RESERVED_WIDTH = "50rem";

/**
 * One voice exchange in the pane's running log — ambient-screen.tsx owns the
 * array (capped, FIFO-evicted) so the log survives across turns instead of
 * being wiped when the next question starts.
 */
export interface AmbientTurn {
  id: string;
  userText: string;
  parts: AmbientAssistantPartDto[];
  /** True from the moment the turn starts until the real answer lands —
   *  drives the immediate "Thinking…" row below so there's visible feedback
   *  before the first tool call (or the answer itself) actually arrives. */
  thinking: boolean;
  /** A barge-in superseded this turn before its backend call resolved (or it
   *  was cancelled) — its answer was discarded rather than shown/spoken. Set
   *  so the block can say so instead of just silently going quiet. */
  interrupted?: boolean;
}

export interface AmbientToolCallPaneProps {
  turns: AmbientTurn[];
}

// Collapsed by default — the pane's whole point is a quick glance at what's
// happening, not a full tool-output log; a voice turn can rack up several
// tool calls (list_projects, get_project_status, ...) whose raw JSON would
// otherwise push everything else out of view.
function ToolCallRow({ part }: { part: AmbientAssistantPartDto }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = part.toolState === "running";
  const isError = part.toolState === "error";
  const output = part.toolOutput ?? "";

  return (
    <div
      className="border p-3 text-xs"
      style={{ borderColor: isError ? "rgba(255,107,107,.4)" : "rgba(0,204,255,.25)", background: "rgba(8,14,20,.6)" }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        disabled={!output}
        className="flex w-full items-center gap-2 text-left disabled:cursor-default"
      >
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: ACCENT }} aria-hidden="true" />
        ) : isError ? (
          <X className="h-3.5 w-3.5 shrink-0" style={{ color: "#FF6B6B" }} aria-hidden="true" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0" style={{ color: ACCENT }} aria-hidden="true" />
        )}
        <span className="flex-1 font-mono font-semibold" style={{ color: "rgba(220,240,250,.9)" }}>
          {part.toolName ?? "tool"}
        </span>
        {output && (expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: "rgba(220,240,250,.5)" }} aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" style={{ color: "rgba(220,240,250,.5)" }} aria-hidden="true" />
        ))}
      </button>
      {expanded && output && (
        <div
          className="mt-2 break-words font-mono text-[11px] leading-relaxed"
          style={{ color: "rgba(220,240,250,.65)" }}
        >
          {output}
        </div>
      )}
    </div>
  );
}

function TurnBlock({ turn }: { turn: AmbientTurn }) {
  const { toolRows, answerText } = useMemo(() => {
    const rows = turn.parts.filter((p) => p.type === "tool_call").sort((a, b) => a.sortOrder - b.sortOrder);
    // .at(-1) not .find() — normally there's only ever one "text" part per
    // turn, but a rare CLI verification retry (assistant.ts's onRetract) can
    // abandon one id mid-stream and start a fresh one; picking the latest
    // one means the pane shows the retry's real progress, not a stale/empty
    // discarded part it happens to find first.
    const answer = turn.parts.filter((p) => p.type === "text").at(-1)?.content ?? null;
    return { toolRows: rows, answerText: answer };
  }, [turn.parts]);

  return (
    <div className="flex flex-col gap-2">
      <div
        className="break-words border p-3 text-sm italic leading-relaxed"
        style={{ borderColor: "rgba(255,198,92,.35)", background: "rgba(255,198,92,.06)", color: USER_COLOR }}
      >
        <div className="mb-1 font-mono text-[10px] font-bold not-italic uppercase tracking-wider" style={{ color: USER_COLOR }}>
          You said
        </div>
        "{turn.userText}"
      </div>
      {toolRows.map((part) => (
        <ToolCallRow key={part.id} part={part} />
      ))}
      {answerText && (
        <div className="break-words border p-3 text-sm leading-relaxed" style={{ borderColor: "rgba(0,204,255,.3)", color: "rgba(220,240,250,.95)" }}>
          {answerText}
        </div>
      )}
      {turn.thinking && toolRows.length === 0 && !answerText && (
        <div
          className="flex items-center gap-2 border p-3 text-xs"
          style={{ borderColor: "rgba(0,204,255,.25)", background: "rgba(8,14,20,.6)", color: "rgba(220,240,250,.7)" }}
        >
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: ACCENT }} aria-hidden="true" />
          Thinking…
        </div>
      )}
      {turn.interrupted && !answerText && (
        <div className="border p-3 text-xs italic" style={{ borderColor: "rgba(220,240,250,.15)", color: "rgba(220,240,250,.45)" }}>
          — interrupted —
        </div>
      )}
    </div>
  );
}

/**
 * A genuine flex-row sibling (NOT an absolutely-positioned overlay) — its
 * outer wrapper's width animates between 0 and 48rem, so appearing/
 * disappearing actually reflows the row and pushes the center content over,
 * rather than floating on top of it. `overflow-hidden` on that same wrapper
 * guarantees zero visual footprint at width 0 (no stray border/background
 * sliver), while the inner content stays pinned at its full 48rem width so
 * it doesn't itself squish/reflow during the transition.
 */
export function AmbientToolCallPane({ turns }: AmbientToolCallPaneProps) {
  const visible = turns.length > 0;
  const bottomRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view as it streams in (tool calls, then the
  // answer) and as new turns are appended. A sentinel + scrollIntoView (rather
  // than scrollTop = scrollHeight on the scroll container) tracks the actual
  // post-layout content height, so it still lands at the true bottom even
  // when a row's height is still settling (e.g. an expand/collapse toggle).
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: "end" });
    });
    return () => cancelAnimationFrame(id);
  }, [turns]);

  return (
    <div
      className="my-8 mr-8 shrink-0 overflow-hidden transition-[width] duration-300 ease-out"
      style={{ width: visible ? "48rem" : "0px" }}
    >
      <div
        className="ambient-scroll flex h-full w-[48rem] flex-col gap-4 overflow-auto border-l p-4"
        style={{ borderColor: "rgba(0,204,255,.3)", background: "rgba(8,14,20,.85)" }}
      >
        <div className="flex shrink-0 items-center gap-2 text-xs font-bold uppercase tracking-wider" style={{ color: ACCENT }}>
          <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
          Working
        </div>
        {turns.map((turn) => (
          <TurnBlock key={turn.id} turn={turn} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
