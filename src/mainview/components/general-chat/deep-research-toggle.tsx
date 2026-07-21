import { Telescope } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";
import { rpc } from "@/lib/rpc";

interface DeepResearchToggleProps {
  conversationId: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

/**
 * General Chat's replacement for ModelSelector's Build/Plan Mode toggle (see
 * its hideBuildPlanToggle prop) — General Chat has no kanban/sub-agents, so
 * Plan Mode's meaning doesn't apply. Persists per-conversation via
 * setGeneralChatDeepResearchMode; the Assistant's system prompt picks this up
 * on the next turn (getAssistantSystemPrompt's conditional section).
 */
export function DeepResearchToggle({ conversationId, enabled, onChange }: DeepResearchToggleProps) {
  const toggle = async () => {
    const next = !enabled;
    onChange(next);
    await rpc.setGeneralChatDeepResearchMode(conversationId, next).catch(() => {
      onChange(!next); // revert on failure
    });
  };

  return (
    <Tip
      content={enabled ? "Deep Research: Assistant asks clarifying questions, then researches in depth." : "Deep Research is off — replies are direct."}
      side="top"
    >
      <button
        type="button"
        onClick={toggle}
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors",
          "border border-transparent",
          enabled
            ? "text-violet-700 bg-violet-50 border-violet-200 hover:bg-violet-100"
            : "text-muted-foreground hover:text-foreground hover:bg-muted",
        )}
      >
        <Telescope className={cn("w-3.5 h-3.5", enabled ? "text-violet-500" : "text-muted-foreground/60")} />
        <span>Deep Research</span>
      </button>
    </Tip>
  );
}
