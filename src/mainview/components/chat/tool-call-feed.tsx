import { Sparkles, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Live "what is the PM/agent doing right now" indicator — shown while a chat
 * turn is streaming, before/alongside the reply. Deliberately minimal: only
 * the MOST RECENT tool call is shown, replacing the previous line rather
 * than accumulating a growing history — reads like a live status
 * ("Reading file…" → "Searching…"). Keyed by call id so the fade-in
 * animation replays on every swap, including a rapid burst of calls the
 * model fired together in one batched turn (each still gets its own brief
 * flash-in as it becomes the current one). Shared by every ephemeral
 * tool-call indicator in the app (PM chat, dashboard PM widget, custom agent
 * widget, collections chat).
 */
export function ToolCallFeed({
  toolCalls,
  skillIconClassName = "text-indigo-400",
}: {
  toolCalls: Array<{ id: string; toolName: string; isSkill: boolean }>;
  /** Accent color for the skill (Sparkles) icon — surfaces with a non-indigo theme (e.g. Collections' `text-primary/70`) can override to match. */
  skillIconClassName?: string;
}) {
  const current = toolCalls[toolCalls.length - 1];
  if (!current) return null;

  return (
    <div
      key={current.id}
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground animate-in fade-in slide-in-from-left-1 duration-300"
    >
      {current.isSkill ? (
        <Sparkles className={cn("h-3 w-3 shrink-0", skillIconClassName)} />
      ) : (
        <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
      )}
      <span className="font-mono truncate">{current.toolName}</span>
    </div>
  );
}
