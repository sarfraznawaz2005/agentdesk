import { useMemo } from "react";
import { DollarSign } from "lucide-react";
import type { Message } from "../../stores/chat-store";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { estimateCost, formatCost } from "../../lib/pricing";

interface ConversationCostProps {
  messages: Message[];
  modelId?: string;
}

interface TokenTotals {
  promptTokens: number;
  completionTokens: number;
}

function sumTokens(messages: Message[]): TokenTotals {
  let promptTokens = 0;
  let completionTokens = 0;

  for (const msg of messages) {
    if (!msg.metadata) continue;
    try {
      const meta = JSON.parse(msg.metadata);
      if (typeof meta.promptTokens === "number")     promptTokens     += meta.promptTokens;
      if (typeof meta.completionTokens === "number") completionTokens += meta.completionTokens;
    } catch {
      // Ignore malformed metadata
    }
  }

  return { promptTokens, completionTokens };
}

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

export function ConversationCost({ messages, modelId }: ConversationCostProps) {
  const { cost, promptTokens, completionTokens } = useMemo(() => {
    const totals = sumTokens(messages);
    return {
      ...totals,
      cost: estimateCost(totals.promptTokens, totals.completionTokens, modelId),
    };
  }, [messages, modelId]);

  // Only render once we have token data from at least one message
  if (promptTokens === 0 && completionTokens === 0) return null;

  const tooltipContent = (
    <div className="space-y-1 text-xs">
      <div className="font-medium text-white">Estimated cost</div>
      <div className="space-y-0.5 text-muted-foreground/80">
        <div>Input:  {formatTokens(promptTokens)} tokens</div>
        <div>Output: {formatTokens(completionTokens)} tokens</div>
        <div className="pt-1 border-t border-border text-foreground font-medium">
          Total: {formatCost(cost)}
        </div>
      </div>
      <div className="text-muted-foreground/60 text-[10px] pt-0.5">
        Approximate — based on {modelId ?? "default"} pricing
      </div>
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="inline-flex items-center gap-1 text-xs text-muted-foreground/60 cursor-default select-none">
          <DollarSign className="w-3 h-3" />
          <span className="tabular-nums">{formatCost(cost)}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltipContent}</TooltipContent>
    </Tooltip>
  );
}
