import { Pencil, Trash2, Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/date-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutomationRule {
  id: string;
  projectId: string | null;
  name: string;
  trigger: string;   // JSON: { eventType: string; conditions?: TriggerCondition[] }
  actions: string;   // JSON array of AutomationAction[]
  enabled: number;   // 0 | 1
  priority: number;
  lastTriggeredAt: string | null;
  createdAt: string;
}

interface AutomationAction {
  type: string;
  [key: string]: unknown;
}

export interface AutomationRuleCardProps {
  rule: AutomationRule;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(json: string, fallback: T): T {
  try {
    const parsed = JSON.parse(json);
    return parsed as T;
  } catch {
    return fallback;
  }
}

function extractEventType(trigger: string): string {
  const parsed = parseJson<{ eventType?: string }>(trigger, {});
  return parsed.eventType ?? "unknown";
}

function summarizeActions(actionsJson: string): string {
  const actions = parseJson<AutomationAction[]>(actionsJson, []);
  if (actions.length === 0) return "No actions";
  const types = actions.map((a) => a.type).join(", ");
  return `${actions.length} action${actions.length !== 1 ? "s" : ""}: ${types}`;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  "task:moved":       "bg-blue-500/15 text-blue-700 border-blue-200",
  "task:created":     "bg-green-500/15 text-green-700 border-green-200",
  "deploy:completed": "bg-purple-500/15 text-purple-700 border-purple-200",
  "agent:completed":  "bg-teal-500/15 text-teal-700 border-teal-200",
  "agent:error":      "bg-red-500/15 text-red-700 border-red-200",
  "message:received": "bg-amber-500/15 text-amber-700 border-amber-200",
  "cron:fired":       "bg-orange-500/15 text-orange-700 border-orange-200",
};

function eventTypeBadgeClass(eventType: string): string {
  return (
    EVENT_TYPE_COLORS[eventType] ??
    "bg-muted text-muted-foreground border-border"
  );
}


// ---------------------------------------------------------------------------
// AutomationRuleCard
// ---------------------------------------------------------------------------

export function AutomationRuleCard({
  rule,
  onEdit,
  onDelete,
  onToggle,
}: AutomationRuleCardProps) {
  const enabled = rule.enabled === 1;
  const eventType = extractEventType(rule.trigger);
  const actionSummary = summarizeActions(rule.actions);
  const lastTriggered = relativeTime(rule.lastTriggeredAt);

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3 transition-colors",
        enabled
          ? "border-border bg-card"
          : "border-dashed border-border/60 bg-muted/30"
      )}
    >
      {/* Enable/disable toggle */}
      <div className="mt-0.5 flex-shrink-0">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? "Disable" : "Enable"} rule "${rule.name}"`}
          onClick={onToggle}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full",
            "border-2 border-transparent transition-colors duration-200 ease-in-out",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            enabled ? "bg-primary" : "bg-input"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg",
              "transform transition duration-200 ease-in-out",
              enabled ? "translate-x-4" : "translate-x-0"
            )}
          />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-1.5">
        {/* Name + event type badge */}
        <div className="flex flex-wrap items-center gap-2">
          <p
            className={cn(
              "text-sm font-semibold truncate",
              !enabled && "text-muted-foreground"
            )}
          >
            {rule.name}
          </p>
          <Badge
            variant="outline"
            className={cn(
              "px-1.5 py-0.5 text-xs font-medium leading-none border",
              eventTypeBadgeClass(eventType)
            )}
          >
            {eventType}
          </Badge>
        </div>

        {/* Action summary */}
        <p className="text-xs text-muted-foreground truncate">{actionSummary}</p>

        {/* Last triggered */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          <span>Last triggered: {lastTriggered}</span>
        </div>
      </div>

      {/* Edit / Delete */}
      <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={onEdit}
          aria-label={`Edit rule "${rule.name}"`}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label={`Delete rule "${rule.name}"`}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
