import { useMemo, useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { cn } from "../../lib/utils";
import type { Message } from "../../stores/chat-store";
import { useChatStore } from "../../stores/chat-store";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { rpc } from "../../lib/rpc";

interface ContextIndicatorProps {
  messages: Message[];
  projectId: string;
  /** "compact" for header; "bar" for a full-width bar near chat input; "inline" for model selector row */
  variant?: "compact" | "bar" | "inline";
}

const DEFAULT_CONTEXT_LIMIT = 1_000_000;

/** Estimate tokens from content length (~4 chars/token).
 * We don't use tokenCount because agent messages store API usage tokens
 * (prompt+completion) which wildly overestimates actual content size. */
function estimateTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function ContextIndicator({ messages, projectId, variant = "compact" }: ContextIndicatorProps) {
  // The single context window the meter measures against — the project's
  // "Context Window Limit" setting. Same denominator for the PM and every
  // sub-agent, so the bar reflects true utilization no matter who ran last
  // (auto-compaction fires at 100% of this on the next turn).
  const [contextLimit, setContextLimit] = useState(DEFAULT_CONTEXT_LIMIT);
  const liveContextTokens = useChatStore((s) => s.liveContextTokens);

  // Load the project's context window limit; refresh when settings change.
  useEffect(() => {
    const load = () =>
      rpc
        .getSetting(`project:${projectId}:contextWindowLimit`)
        .then((val: string | null) => {
          const parsed = parseInt(val ?? "", 10);
          if (!Number.isNaN(parsed) && parsed >= 1000) setContextLimit(parsed);
        })
        .catch(() => {});
    load();
    window.addEventListener("agentdesk:settings-changed", load);
    return () => window.removeEventListener("agentdesk:settings-changed", load);
  }, [projectId]);

  const estimated = useMemo(() => estimateTokens(messages), [messages]);

  // Prefer the backend's real last-step token usage (the actual current context
  // size, updated by whichever agent ran); fall back to a char estimate before
  // any live figure exists.
  const displayTokens = liveContextTokens > 0 ? liveContextTokens : estimated;
  const utilization = Math.min((displayTokens / contextLimit) * 100, 100);

  if (messages.length === 0) return null;

  const barColor =
    utilization > 80
      ? "bg-red-500"
      : utilization > 60
        ? "bg-amber-500"
        : "bg-indigo-500";

  const textColor =
    utilization > 80
      ? "text-red-500"
      : utilization > 60
        ? "text-amber-500"
        : "text-muted-foreground";

  const tooltipContent = "Conversation auto-compacts on the next turn when context reaches the Context Window Limit";

  // Inline variant — fits inside the model selector row
  if (variant === "inline") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="inline-flex items-center gap-1.5 px-2 py-1 cursor-default">
            <span className={cn("text-[11px] tabular-nums whitespace-nowrap", textColor)}>
              ~{formatTokens(displayTokens)}
            </span>
            <div className="w-44 h-1 bg-muted rounded-full overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all duration-500", barColor)}
                style={{ width: `${utilization}%` }}
              />
            </div>
            <span className={cn("text-[11px] tabular-nums whitespace-nowrap", textColor)}>
              {utilization.toFixed(0)}%
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltipContent}</TooltipContent>
      </Tooltip>
    );
  }

  // Full-width bar variant — shown near chat input
  if (variant === "bar") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 px-4 py-1 cursor-default">
            <MessageSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-[11px] font-semibold text-muted-foreground tabular-nums whitespace-nowrap shrink-0">
              ~{formatTokens(displayTokens)} tokens
            </span>
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all duration-500", barColor)}
                style={{ width: `${utilization}%` }}
              />
            </div>
            <span className={cn("text-[11px] font-semibold tabular-nums whitespace-nowrap shrink-0", textColor)}>
              {utilization.toFixed(0)}%
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltipContent}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 cursor-default">
          <MessageSquare className="w-3 h-3" />
          <span>~{formatTokens(displayTokens)} tokens</span>
          <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", barColor)}
              style={{ width: `${utilization}%` }}
            />
          </div>
          <span className="tabular-nums">{utilization.toFixed(0)}%</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltipContent}</TooltipContent>
    </Tooltip>
  );
}
