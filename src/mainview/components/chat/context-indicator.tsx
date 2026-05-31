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

const DEFAULT_THRESHOLD = 200_000;

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
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const liveContextTokens = useChatStore((s) => s.liveContextTokens);
  const liveContextLimit = useChatStore((s) => s.liveContextLimit);

  // Load the project's summarization threshold setting
  useEffect(() => {
    rpc
      .getSetting(`project:${projectId}:sessionSummarizationThreshold`)
      .then((val: string | null) => {
        const parsed = parseInt(val ?? "", 10);
        if (!Number.isNaN(parsed) && parsed >= 5000) setThreshold(parsed);
      })
      .catch(() => {});
  }, [projectId]);

  const estimated = useMemo(() => estimateTokens(messages), [messages]);

  // Prefer live context tokens from backend (reflects actual usage after compaction)
  // Fall back to client-side estimate when no live data available
  const displayTokens = liveContextTokens > 0 ? liveContextTokens : estimated;
  const displayThreshold = liveContextLimit > 0 ? liveContextLimit : threshold;
  const utilization = Math.min((displayTokens / displayThreshold) * 100, 100);

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

  const tooltipContent = "Conversation will auto-compact when context reaches the threshold";

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
