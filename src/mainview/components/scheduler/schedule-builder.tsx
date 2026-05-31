import { useState, useEffect, useRef, useCallback } from "react";
import { Clock } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduleFrequency =
  | "every_minute"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly";

interface VisualScheduleState {
  frequency: ScheduleFrequency;
  minute: string; // 0-59
  hour: string; // 0-23
  days: number[]; // days of week: 0=Sun,1=Mon,...,6=Sat
  dayOfMonth: string; // 1-31
}

export interface ScheduleBuilderProps {
  value: string;
  onChange: (expression: string) => void;
  timezone: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: String(i).padStart(2, "0"),
}));

const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => ({
  value: String(i),
  label: String(i).padStart(2, "0"),
}));

const DAY_OF_MONTH_OPTIONS = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCronExpression(state: VisualScheduleState): string {
  const { frequency, minute, hour, days, dayOfMonth } = state;

  switch (frequency) {
    case "every_minute":
      return "* * * * *";
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly": {
      const dayStr = days.length === 0 ? "*" : days.sort((a, b) => a - b).join(",");
      return `${minute} ${hour} * * ${dayStr}`;
    }
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    default:
      return "* * * * *";
  }
}

function parseCronToVisual(expr: string): VisualScheduleState | null {
  if (!expr || expr.trim() === "") return null;

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [min, hr, dom, , dow] = parts;

  // every_minute: * * * * *
  if (min === "*" && hr === "*" && dom === "*" && dow === "*") {
    return { frequency: "every_minute", minute: "0", hour: "0", days: [], dayOfMonth: "1" };
  }

  // monthly: <min> <hr> <dom> * *
  if (min !== "*" && hr !== "*" && dom !== "*" && dow === "*" && !dom.includes(",") && !dom.includes("/")) {
    return {
      frequency: "monthly",
      minute: min,
      hour: hr,
      days: [],
      dayOfMonth: dom,
    };
  }

  // weekly: <min> <hr> * * <dow>
  if (min !== "*" && hr !== "*" && dom === "*" && dow !== "*") {
    const parsedDays = dow.split(",").map(Number).filter((d) => !isNaN(d) && d >= 0 && d <= 6);
    return {
      frequency: "weekly",
      minute: min,
      hour: hr,
      days: parsedDays,
      dayOfMonth: "1",
    };
  }

  // daily: <min> <hr> * * *
  if (min !== "*" && hr !== "*" && dom === "*" && dow === "*") {
    return { frequency: "daily", minute: min, hour: hr, days: [], dayOfMonth: "1" };
  }

  // hourly: <min> * * * *
  if (min !== "*" && hr === "*" && dom === "*" && dow === "*") {
    return { frequency: "hourly", minute: min, hour: "0", days: [], dayOfMonth: "1" };
  }

  return null;
}

function friendlyFrequency(frequency: ScheduleFrequency): string {
  switch (frequency) {
    case "every_minute": return "Every minute";
    case "hourly": return "Every hour";
    case "daily": return "Every day";
    case "weekly": return "Every week";
    case "monthly": return "Every month";
  }
}

// ---------------------------------------------------------------------------
// Visual schedule editor
// ---------------------------------------------------------------------------

interface VisualEditorProps {
  state: VisualScheduleState;
  onChange: (state: VisualScheduleState) => void;
}

function VisualEditor({ state, onChange }: VisualEditorProps) {
  const { frequency, minute, hour, days, dayOfMonth } = state;

  function set(patch: Partial<VisualScheduleState>) {
    onChange({ ...state, ...patch });
  }

  function toggleDay(day: number) {
    const next = days.includes(day)
      ? days.filter((d) => d !== day)
      : [...days, day];
    set({ days: next });
  }

  return (
    <div className="space-y-4">
      {/* Frequency */}
      <div className="space-y-1.5">
        <Label htmlFor="sched-freq">Frequency</Label>
        <Select
          value={frequency}
          onValueChange={(v) => set({ frequency: v as ScheduleFrequency })}
        >
          <SelectTrigger id="sched-freq" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="every_minute">Every minute</SelectItem>
            <SelectItem value="hourly">Hourly</SelectItem>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Hourly: minute picker */}
      {frequency === "hourly" && (
        <div className="space-y-1.5">
          <Label htmlFor="sched-min">At minute</Label>
          <Select value={minute} onValueChange={(v) => set({ minute: v })}>
            <SelectTrigger id="sched-min" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MINUTE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  :{o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Daily / weekly / monthly: time picker */}
      {(frequency === "daily" || frequency === "weekly" || frequency === "monthly") && (
        <div className="space-y-1.5">
          <Label>At time</Label>
          <div className="flex items-center gap-2">
            <Select value={hour} onValueChange={(v) => set({ hour: v })}>
              <SelectTrigger className="w-24" aria-label="Hour">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOUR_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm font-medium text-muted-foreground">:</span>
            <Select value={minute} onValueChange={(v) => set({ minute: v })}>
              <SelectTrigger className="w-24" aria-label="Minute">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MINUTE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Weekly: day checkboxes */}
      {frequency === "weekly" && (
        <div className="space-y-1.5">
          <Label>On days</Label>
          <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Days of week">
            {DAY_LABELS.map((label, idx) => {
              const checked = days.includes(idx);
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleDay(idx)}
                  aria-pressed={checked}
                  className={cn(
                    "flex h-9 w-10 items-center justify-center rounded-md border text-xs font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background hover:bg-muted"
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Monthly: day of month picker */}
      {frequency === "monthly" && (
        <div className="space-y-1.5">
          <Label htmlFor="sched-dom">On day</Label>
          <Select value={dayOfMonth} onValueChange={(v) => set({ dayOfMonth: v })}>
            <SelectTrigger id="sched-dom" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAY_OF_MONTH_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Summary */}
      <p className="text-xs text-muted-foreground" aria-live="polite">
        <span className="font-medium">Summary:</span>{" "}
        {friendlyFrequency(frequency)}
        {frequency === "hourly" && ` at :${minute.padStart(2, "0")}`}
        {(frequency === "daily") && ` at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`}
        {frequency === "weekly" && days.length > 0 && ` on ${days.sort((a,b)=>a-b).map(d => DAY_LABELS[d]).join(", ")} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`}
        {frequency === "weekly" && days.length === 0 && ` (no days selected)`}
        {frequency === "monthly" && ` on day ${dayOfMonth} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cron expression editor with live preview
// ---------------------------------------------------------------------------

interface CronEditorProps {
  value: string;
  onChange: (expr: string) => void;
  timezone: string;
}

function CronEditor({ value, onChange, timezone }: CronEditorProps) {
  const [previews, setPreviews] = useState<string[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPreview = useCallback(
    async (expr: string, tz: string) => {
      if (!expr || expr.trim() === "") {
        setPreviews([]);
        setPreviewError(null);
        return;
      }
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const result = await rpc.previewCronSchedule(expr.trim(), tz || "UTC", 3);
        const raw = result as unknown as { nextRuns?: string[]; error?: string };
        if (raw.error) {
          setPreviewError(raw.error);
          setPreviews([]);
        } else {
          setPreviews(Array.isArray(raw.nextRuns) ? raw.nextRuns : []);
        }
      } catch {
        setPreviewError("Invalid cron expression.");
        setPreviews([]);
      } finally {
        setPreviewLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchPreview(value, timezone);
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, timezone, fetchPreview]);

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="cron-expr">Cron expression</Label>
        <Input
          id="cron-expr"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="* * * * *"
          className="font-mono text-sm"
          aria-describedby="cron-expr-hint"
        />
        <p id="cron-expr-hint" className="text-xs text-muted-foreground">
          Format: minute hour day-of-month month day-of-week
        </p>
      </div>

      {/* Next runs preview */}
      <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          Next 3 runs
        </div>

        {previewLoading ? (
          <div className="space-y-1.5" aria-busy="true" aria-label="Loading preview">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3.5 w-44" />
            <Skeleton className="h-3.5 w-52" />
          </div>
        ) : previewError ? (
          <p className="text-xs text-destructive" role="alert">{previewError}</p>
        ) : previews.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            Enter a valid expression to preview next runs.
          </p>
        ) : (
          <ol className="space-y-0.5" aria-label="Upcoming scheduled runs">
            {previews.map((run, i) => (
              <li key={i} className="text-xs text-foreground font-mono">
                {new Date(run).toLocaleString()}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleBuilder — main export
// ---------------------------------------------------------------------------

export function ScheduleBuilder({ value, onChange, timezone }: ScheduleBuilderProps) {
  const [mode, setMode] = useState<"visual" | "cron">(() => {
    // Start in visual mode if the expression is parseable; otherwise cron mode
    return parseCronToVisual(value) !== null ? "visual" : "cron";
  });

  const [visualState, setVisualState] = useState<VisualScheduleState>(() => {
    const parsed = parseCronToVisual(value);
    return parsed ?? {
      frequency: "daily",
      minute: "0",
      hour: "9",
      days: [],
      dayOfMonth: "1",
    };
  });

  // When visual state changes, emit new cron expression
  function handleVisualChange(next: VisualScheduleState) {
    setVisualState(next);
    onChange(buildCronExpression(next));
  }

  // When switching to visual, try to sync current expression
  function handleModeChange(newMode: string) {
    const m = newMode as "visual" | "cron";
    if (m === "visual") {
      const parsed = parseCronToVisual(value);
      if (parsed) {
        setVisualState(parsed);
      }
    }
    setMode(m);
  }

  return (
    <Tabs value={mode} onValueChange={handleModeChange}>
      <TabsList className="h-8 p-0.5">
        <TabsTrigger value="visual" className="h-7 px-3 text-xs">
          Visual
        </TabsTrigger>
        <TabsTrigger value="cron" className="h-7 px-3 text-xs">
          Cron expression
        </TabsTrigger>
      </TabsList>

      <TabsContent value="visual" className="mt-3">
        <VisualEditor state={visualState} onChange={handleVisualChange} />
      </TabsContent>

      <TabsContent value="cron" className="mt-3">
        <CronEditor value={value} onChange={onChange} timezone={timezone} />
      </TabsContent>
    </Tabs>
  );
}
