import { useState, useEffect } from "react";
import { Zap } from "lucide-react";

import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutomationTemplate {
  name: string;
  trigger: string;   // JSON: { eventType: string; conditions?: object[] }
  actions: string;   // JSON array of action objects
}

export interface AutomationTemplatesProps {
  onUseTemplate: (template: {
    name: string;
    trigger: string;
    actions: string;
  }) => void;
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

function extractEventType(triggerJson: string): string {
  const parsed = parseJson<{ eventType?: string }>(triggerJson, {});
  return parsed.eventType ?? "unknown";
}

function buildDescription(template: AutomationTemplate): string {
  const eventType = extractEventType(template.trigger);
  const actions = parseJson<Array<{ type: string }>>(template.actions, []);

  const actionTypes = actions.map((a) => a.type).join(", ");
  const actionSummary =
    actions.length === 0
      ? "no actions"
      : `${actions.length} action${actions.length !== 1 ? "s" : ""}: ${actionTypes}`;

  return `Fires on ${eventType} — ${actionSummary}.`;
}

const EVENT_BADGE_COLORS: Record<string, string> = {
  "task:moved":       "bg-blue-500/15 text-blue-700 border-blue-200",
  "task:created":     "bg-green-500/15 text-green-700 border-green-200",
  "deploy:completed": "bg-purple-500/15 text-purple-700 border-purple-200",
  "agent:completed":  "bg-teal-500/15 text-teal-700 border-teal-200",
  "agent:error":      "bg-red-500/15 text-red-700 border-red-200",
  "message:received": "bg-amber-500/15 text-amber-700 border-amber-200",
  "cron:fired":       "bg-orange-500/15 text-orange-700 border-orange-200",
};

function eventBadgeClass(eventType: string): string {
  return (
    EVENT_BADGE_COLORS[eventType] ??
    "bg-muted text-muted-foreground border-border"
  );
}

// ---------------------------------------------------------------------------
// TemplateCard
// ---------------------------------------------------------------------------

interface TemplateCardProps {
  template: AutomationTemplate;
  onUse: () => void;
}

function TemplateCard({ template, onUse }: TemplateCardProps) {
  const eventType = extractEventType(template.trigger);
  const description = buildDescription(template);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-semibold leading-snug">
            {template.name}
          </CardTitle>
          <Badge
            variant="outline"
            className={cn(
              "flex-shrink-0 px-1.5 py-0.5 text-xs font-medium leading-none border",
              eventBadgeClass(eventType)
            )}
          >
            {eventType}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0 flex-1">
        <p className="text-xs text-muted-foreground leading-relaxed flex-1">
          {description}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full text-xs h-8"
          onClick={onUse}
        >
          Use template
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function TemplateSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2 animate-pulse">
      <div className="h-4 w-3/4 rounded bg-muted" />
      <div className="h-3 w-full rounded bg-muted" />
      <div className="h-3 w-5/6 rounded bg-muted" />
      <div className="h-8 w-full rounded bg-muted mt-2" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AutomationTemplates
// ---------------------------------------------------------------------------

export function AutomationTemplates({ onUseTemplate }: AutomationTemplatesProps) {
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await rpc.getAutomationTemplates();
        if (cancelled) return;
        const raw = result as unknown as AutomationTemplate[];
        setTemplates(Array.isArray(raw) ? raw : []);
      } catch {
        if (!cancelled) {
          toast("error", "Failed to load automation templates.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Pre-built Templates</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Start quickly with a ready-made automation rule. Click "Use template"
          to open the form pre-filled with the template's settings.
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <TemplateSkeleton key={i} />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={<Zap className="h-5 w-5" aria-hidden="true" />}
          title="No templates available"
          description="Templates will appear here once they are configured."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {templates.map((template, i) => (
            <TemplateCard
              key={`${template.name}-${i}`}
              template={template}
              onUse={() => onUseTemplate(template)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
