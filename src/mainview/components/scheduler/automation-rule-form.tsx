import { useState, useEffect } from "react";
import { Plus, X } from "lucide-react";

import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AutomationRule } from "./automation-rule-card";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TriggerCondition {
  field: string;
  operator: "equals" | "contains" | "not_equals";
  value: string;
}

interface TriggerConfig {
  eventType: string;
  conditions: TriggerCondition[];
}

type ActionType =
  | "pm_prompt"
  | "reminder"
  | "shell"
  | "webhook"
  | "agent_task"
  | "send_channel_message";

interface ReminderConfig {
  message: string;
  priority: "normal" | "high" | "urgent";
}

interface ShellConfig {
  command: string;
  timeout: number;
}

interface WebhookConfig {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers: string;
  body: string;
}

interface PmPromptConfig {
  projectId: string;
  prompt: string;
}

interface AgentTaskConfig {
  projectId: string;
  instructions: string;
}

interface SendChannelMessageConfig {
  channelId: string;
  content: string;
}

type ActionConfig =
  | ({ type: "reminder" } & ReminderConfig)
  | ({ type: "shell" } & ShellConfig)
  | ({ type: "webhook" } & WebhookConfig)
  | ({ type: "pm_prompt" } & PmPromptConfig)
  | ({ type: "agent_task" } & AgentTaskConfig)
  | ({ type: "send_channel_message" } & SendChannelMessageConfig);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_TYPES = [
  { value: "task:moved",        label: "task:moved" },
  { value: "task:created",      label: "task:created" },
  { value: "deploy:completed",  label: "deploy:completed" },
  { value: "agent:completed",   label: "agent:completed" },
  { value: "agent:error",       label: "agent:error" },
  { value: "message:received",  label: "message:received" },
  { value: "cron:fired",        label: "cron:fired" },
] as const;

const OPERATORS: { value: TriggerCondition["operator"]; label: string }[] = [
  { value: "equals",     label: "equals" },
  { value: "contains",   label: "contains" },
  { value: "not_equals", label: "not equals" },
];

const ACTION_TYPES: { value: ActionType; label: string }[] = [
  { value: "pm_prompt",            label: "PM Prompt" },
  { value: "reminder",             label: "Reminder" },
  { value: "shell",                label: "Shell command" },
  { value: "webhook",              label: "Webhook" },
  { value: "agent_task",           label: "Agent task" },
  { value: "send_channel_message", label: "Send channel message" },
];

const REMINDER_PRIORITIES: { value: ReminderConfig["priority"]; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "high",   label: "High" },
  { value: "urgent", label: "Urgent" },
];

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

function makeTrigger(): TriggerConfig {
  return { eventType: "task:moved", conditions: [] };
}

function makeCondition(): TriggerCondition {
  return { field: "", operator: "equals", value: "" };
}

function makeAction(type: ActionType = "reminder"): ActionConfig {
  switch (type) {
    case "reminder":
      return { type: "reminder", message: "", priority: "normal" };
    case "shell":
      return { type: "shell", command: "", timeout: 30 };
    case "webhook":
      return { type: "webhook", url: "", method: "POST", headers: "", body: "" };
    case "pm_prompt":
      return { type: "pm_prompt", projectId: "", prompt: "" };
    case "agent_task":
      return { type: "agent_task", projectId: "", instructions: "" };
    case "send_channel_message":
      return { type: "send_channel_message", channelId: "", content: "" };
  }
}

function triggerFromRule(rule: AutomationRule): TriggerConfig {
  return parseJson<TriggerConfig>(rule.trigger, makeTrigger());
}

function actionsFromRule(rule: AutomationRule): ActionConfig[] {
  const raw = parseJson<Record<string, unknown>[]>(rule.actions, []);
  return raw.length > 0 ? (raw as unknown as ActionConfig[]) : [makeAction()];
}

function triggerFromPrefill(triggerJson: string): TriggerConfig {
  return parseJson<TriggerConfig>(triggerJson, makeTrigger());
}

function actionsFromPrefill(actionsJson: string): ActionConfig[] {
  const raw = parseJson<Record<string, unknown>[]>(actionsJson, []);
  return raw.length > 0 ? (raw as unknown as ActionConfig[]) : [makeAction()];
}

// ---------------------------------------------------------------------------
// NativeSelect
// ---------------------------------------------------------------------------

interface NativeSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  children: React.ReactNode;
}

function NativeSelect({ className, children, ...props }: NativeSelectProps) {
  return (
    <select
      className={cn(
        "flex h-9 rounded-md border border-input bg-transparent px-3 py-1",
        "text-sm shadow-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
// ActionConfigFields — renders type-specific fields for a single action
// ---------------------------------------------------------------------------

interface ActionConfigFieldsProps {
  action: ActionConfig;
  index: number;
  onChange: (patch: Partial<ActionConfig>) => void;
}

function ActionConfigFields({ action, index, onChange }: ActionConfigFieldsProps) {
  switch (action.type) {
    case "reminder":
      return (
        <>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-message`} className="text-xs">
              Message
            </Label>
            <Textarea
              id={`action-${index}-message`}
              value={action.message}
              onChange={(e) => onChange({ message: e.target.value } as Partial<ActionConfig>)}
              placeholder="Reminder message text"
              className="min-h-[60px] resize-none text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-priority`} className="text-xs">
              Priority
            </Label>
            <NativeSelect
              id={`action-${index}-priority`}
              value={action.priority}
              onChange={(e) =>
                onChange({ priority: e.target.value as ReminderConfig["priority"] } as Partial<ActionConfig>)
              }
              className="w-full"
            >
              {REMINDER_PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </NativeSelect>
          </div>
        </>
      );

    case "shell":
      return (
        <>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-command`} className="text-xs">
              Command
            </Label>
            <Input
              id={`action-${index}-command`}
              value={action.command}
              onChange={(e) => onChange({ command: e.target.value } as Partial<ActionConfig>)}
              placeholder="e.g. ./deploy.sh"
              className="h-9 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-timeout`} className="text-xs">
              Timeout (seconds)
            </Label>
            <Input
              id={`action-${index}-timeout`}
              type="number"
              min={1}
              max={3600}
              value={action.timeout}
              onChange={(e) =>
                onChange({ timeout: Number(e.target.value) } as Partial<ActionConfig>)
              }
              className="h-9 w-28"
            />
          </div>
        </>
      );

    case "webhook":
      return (
        <>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-url`} className="text-xs">
              URL
            </Label>
            <Input
              id={`action-${index}-url`}
              value={action.url}
              onChange={(e) => onChange({ url: e.target.value } as Partial<ActionConfig>)}
              placeholder="https://example.com/webhook"
              className="h-9 text-xs"
              type="url"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-method`} className="text-xs">
              Method
            </Label>
            <NativeSelect
              id={`action-${index}-method`}
              value={action.method}
              onChange={(e) =>
                onChange({ method: e.target.value as WebhookConfig["method"] } as Partial<ActionConfig>)
              }
              className="w-full"
            >
              {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-headers`} className="text-xs">
              Headers (JSON)
            </Label>
            <Textarea
              id={`action-${index}-headers`}
              value={action.headers}
              onChange={(e) => onChange({ headers: e.target.value } as Partial<ActionConfig>)}
              placeholder='{"Authorization": "Bearer token"}'
              className="min-h-[56px] resize-none font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-body`} className="text-xs">
              Body (JSON)
            </Label>
            <Textarea
              id={`action-${index}-body`}
              value={action.body}
              onChange={(e) => onChange({ body: e.target.value } as Partial<ActionConfig>)}
              placeholder='{"key": "value"}'
              className="min-h-[56px] resize-none font-mono text-xs"
            />
          </div>
        </>
      );

    case "pm_prompt":
      return (
        <>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-projectId`} className="text-xs">
              Project ID
            </Label>
            <Input
              id={`action-${index}-projectId`}
              value={action.projectId}
              onChange={(e) => onChange({ projectId: e.target.value } as Partial<ActionConfig>)}
              placeholder="Project ID"
              className="h-9 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-prompt`} className="text-xs">
              Prompt
            </Label>
            <Textarea
              id={`action-${index}-prompt`}
              value={action.prompt}
              onChange={(e) => onChange({ prompt: e.target.value } as Partial<ActionConfig>)}
              placeholder="Prompt text for the PM agent"
              className="min-h-[60px] resize-none text-sm"
            />
          </div>
        </>
      );

    case "agent_task":
      return (
        <>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-projectId`} className="text-xs">
              Project ID
            </Label>
            <Input
              id={`action-${index}-projectId`}
              value={action.projectId}
              onChange={(e) => onChange({ projectId: e.target.value } as Partial<ActionConfig>)}
              placeholder="Project ID"
              className="h-9 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-instructions`} className="text-xs">
              Instructions
            </Label>
            <Textarea
              id={`action-${index}-instructions`}
              value={action.instructions}
              onChange={(e) => onChange({ instructions: e.target.value } as Partial<ActionConfig>)}
              placeholder="Task instructions for the agent"
              className="min-h-[60px] resize-none text-sm"
            />
          </div>
        </>
      );

    case "send_channel_message":
      return (
        <>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-channelId`} className="text-xs">
              Channel ID
            </Label>
            <Input
              id={`action-${index}-channelId`}
              value={action.channelId}
              onChange={(e) => onChange({ channelId: e.target.value } as Partial<ActionConfig>)}
              placeholder="Discord channel ID or channel name"
              className="h-9 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`action-${index}-content`} className="text-xs">
              Message content
            </Label>
            <Textarea
              id={`action-${index}-content`}
              value={action.content}
              onChange={(e) => onChange({ content: e.target.value } as Partial<ActionConfig>)}
              placeholder="Message to send to the channel"
              className="min-h-[60px] resize-none text-sm"
            />
          </div>
        </>
      );
  }
}

// ---------------------------------------------------------------------------
// AutomationRuleForm props
// ---------------------------------------------------------------------------

export interface AutomationRuleFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  rule?: AutomationRule;
  prefill?: { name: string; trigger: string; actions: string };
}

// ---------------------------------------------------------------------------
// AutomationRuleForm
// ---------------------------------------------------------------------------

export function AutomationRuleForm({
  open,
  onOpenChange,
  onSaved,
  rule,
  prefill,
}: AutomationRuleFormProps) {
  const isEditing = Boolean(rule);

  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<TriggerConfig>(makeTrigger());
  const [actions, setActions] = useState<ActionConfig[]>([makeAction()]);
  const [priority, setPriority] = useState(0);
  const [saving, setSaving] = useState(false);

  // Reset form state whenever the dialog opens with fresh data
  useEffect(() => {
    if (!open) return;

    if (rule) {
      setName(rule.name);
      setTrigger(triggerFromRule(rule));
      setActions(actionsFromRule(rule));
      setPriority(rule.priority);
    } else if (prefill) {
      setName(prefill.name);
      setTrigger(triggerFromPrefill(prefill.trigger));
      setActions(actionsFromPrefill(prefill.actions));
      setPriority(0);
    } else {
      setName("");
      setTrigger(makeTrigger());
      setActions([makeAction()]);
      setPriority(0);
    }
  }, [open, rule, prefill]);

  // ---------------------------------------------------------------------------
  // Trigger helpers
  // ---------------------------------------------------------------------------

  function setEventType(eventType: string) {
    setTrigger((prev) => ({ ...prev, eventType }));
  }

  function addCondition() {
    setTrigger((prev) => ({
      ...prev,
      conditions: [...prev.conditions, makeCondition()],
    }));
  }

  function updateCondition(index: number, patch: Partial<TriggerCondition>) {
    setTrigger((prev) => ({
      ...prev,
      conditions: prev.conditions.map((c, i) =>
        i === index ? { ...c, ...patch } : c
      ),
    }));
  }

  function removeCondition(index: number) {
    setTrigger((prev) => ({
      ...prev,
      conditions: prev.conditions.filter((_, i) => i !== index),
    }));
  }

  // ---------------------------------------------------------------------------
  // Action helpers
  // ---------------------------------------------------------------------------

  function addAction() {
    setActions((prev) => [...prev, makeAction("reminder")]);
  }

  function changeActionType(index: number, type: ActionType) {
    setActions((prev) =>
      prev.map((a, i) => (i === index ? makeAction(type) : a))
    );
  }

  function updateAction(index: number, patch: Partial<ActionConfig>) {
    setActions((prev) =>
      prev.map((a, i) => (i === index ? { ...a, ...patch } as ActionConfig : a))
    );
  }

  function removeAction(index: number) {
    setActions((prev) => prev.filter((_, i) => i !== index));
  }

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!name.trim()) {
      toast("error", "Rule name is required.");
      return;
    }
    if (actions.length === 0) {
      toast("error", "At least one action is required.");
      return;
    }

    setSaving(true);
    try {
      const triggerJson = JSON.stringify(trigger);
      const actionsJson = JSON.stringify(actions);

      if (isEditing && rule) {
        await rpc.updateAutomationRule({
          id: rule.id,
          name: name.trim(),
          trigger: triggerJson,
          actions: actionsJson,
          priority,
        });
        toast("success", "Automation rule updated.");
      } else {
        await rpc.createAutomationRule({
          name: name.trim(),
          trigger: triggerJson,
          actions: actionsJson,
          priority,
        });
        toast("success", "Automation rule created.");
      }

      onSaved();
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to save automation rule.";
      toast("error", msg);
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Automation Rule" : "New Automation Rule"}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 pt-1">
          {/* ---- Name ---- */}
          <div className="space-y-1.5">
            <Label htmlFor="ar-name">Rule name</Label>
            <Input
              id="ar-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Notify on deploy"
              className="h-9"
              required
            />
          </div>

          <Separator />

          {/* ---- Trigger ---- */}
          <div className="space-y-3">
            <p className="text-sm font-medium">Trigger</p>

            <div className="space-y-1.5">
              <Label htmlFor="ar-event-type" className="text-xs text-muted-foreground">
                Event type
              </Label>
              <NativeSelect
                id="ar-event-type"
                value={trigger.eventType}
                onChange={(e) => setEventType(e.target.value)}
                className="w-full"
                aria-label="Trigger event type"
              >
                {EVENT_TYPES.map((et) => (
                  <option key={et.value} value={et.value}>
                    {et.label}
                  </option>
                ))}
              </NativeSelect>
            </div>

            {/* Conditions */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">
                  Conditions
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={addCondition}
                >
                  <Plus className="h-3 w-3 mr-1" aria-hidden="true" />
                  Add condition
                </Button>
              </div>

              {trigger.conditions.length === 0 && (
                <p className="text-xs text-muted-foreground italic">
                  No conditions — rule fires on every matching event.
                </p>
              )}

              {trigger.conditions.map((cond, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={cond.field}
                    onChange={(e) => updateCondition(i, { field: e.target.value })}
                    placeholder="Field (e.g. status)"
                    className="h-9 flex-1 text-xs"
                    aria-label={`Condition ${i + 1} field`}
                  />
                  <NativeSelect
                    value={cond.operator}
                    onChange={(e) =>
                      updateCondition(i, {
                        operator: e.target.value as TriggerCondition["operator"],
                      })
                    }
                    aria-label={`Condition ${i + 1} operator`}
                  >
                    {OPERATORS.map((op) => (
                      <option key={op.value} value={op.value}>
                        {op.label}
                      </option>
                    ))}
                  </NativeSelect>
                  <Input
                    value={cond.value}
                    onChange={(e) => updateCondition(i, { value: e.target.value })}
                    placeholder="Value"
                    className="h-9 flex-1 text-xs"
                    aria-label={`Condition ${i + 1} value`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 w-9 p-0 flex-shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeCondition(i)}
                    aria-label={`Remove condition ${i + 1}`}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* ---- Actions ---- */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Actions</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={addAction}
              >
                <Plus className="h-3 w-3 mr-1" aria-hidden="true" />
                Add action
              </Button>
            </div>

            {actions.length === 0 && (
              <p className="text-xs text-muted-foreground italic">
                No actions — add at least one.
              </p>
            )}

            {actions.map((action, i) => (
              <div
                key={i}
                className="rounded-md border border-border bg-muted/30 p-3 space-y-3"
              >
                {/* Action type selector + remove button */}
                <div className="flex items-center gap-2">
                  <NativeSelect
                    value={action.type}
                    onChange={(e) =>
                      changeActionType(i, e.target.value as ActionType)
                    }
                    className="flex-1"
                    aria-label={`Action ${i + 1} type`}
                  >
                    {ACTION_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 w-9 p-0 flex-shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeAction(i)}
                    aria-label={`Remove action ${i + 1}`}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>

                {/* Type-specific config */}
                <ActionConfigFields
                  action={action}
                  index={i}
                  onChange={(patch) => updateAction(i, patch)}
                />
              </div>
            ))}
          </div>

          <Separator />

          {/* ---- Priority ---- */}
          <div className="space-y-1.5">
            <Label htmlFor="ar-priority">
              Priority{" "}
              <span className="text-xs font-normal text-muted-foreground">
                (lower number runs first)
              </span>
            </Label>
            <Input
              id="ar-priority"
              type="number"
              min={0}
              max={9999}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              className="h-9 w-28"
            />
          </div>

          {/* ---- Footer ---- */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving
                ? "Saving..."
                : isEditing
                  ? "Save changes"
                  : "Create rule"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
