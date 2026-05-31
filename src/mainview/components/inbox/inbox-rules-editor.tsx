import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Pencil, X } from "lucide-react";

import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InboxRule {
  id: string;
  projectId: string | null;
  name: string;
  conditions: string; // JSON array of RuleCondition[]
  actions: string;    // JSON array of RuleAction[]
  enabled: number;    // 0 | 1
  priority: number;
  createdAt: string;
}

interface RuleCondition {
  field: "sender" | "content" | "platform" | "projectId";
  operator: "contains" | "equals" | "matches";
  value: string;
}

interface RuleAction {
  type: "setCategory" | "setPriority" | "setProject" | "markAsRead";
  value: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RULES = 5;

const CONDITION_FIELDS: { value: RuleCondition["field"]; label: string }[] = [
  { value: "sender", label: "Sender" },
  { value: "content", label: "Content" },
  { value: "platform", label: "Platform" },
  { value: "projectId", label: "Project ID" },
];

const CONDITION_OPERATORS: {
  value: RuleCondition["operator"];
  label: string;
}[] = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "equals" },
  { value: "matches", label: "matches (regex)" },
];

const ACTION_TYPES: { value: RuleAction["type"]; label: string }[] = [
  { value: "setCategory", label: "Set category" },
  { value: "setPriority", label: "Set priority" },
  { value: "setProject", label: "Set project" },
  { value: "markAsRead", label: "Mark as read" },
];

const CATEGORY_VALUES = ["work", "chat", "status", "reminder", "other"];
const PRIORITY_VALUES: { value: string; label: string }[] = [
  { value: "0", label: "Normal" },
  { value: "1", label: "High" },
  { value: "2", label: "Urgent" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseConditions(json: string): RuleCondition[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseActions(json: string): RuleAction[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function summarizeConditions(conditions: RuleCondition[]): string {
  if (conditions.length === 0) return "No conditions";
  return conditions
    .map((c) => `${c.field} ${c.operator} "${c.value}"`)
    .join(", ");
}

function summarizeActions(actions: RuleAction[]): string {
  if (actions.length === 0) return "No actions";
  return actions
    .map((a) => {
      switch (a.type) {
        case "setCategory":
          return `Set category to ${a.value}`;
        case "setPriority": {
          const label =
            a.value === "2" ? "Urgent" : a.value === "1" ? "High" : "Normal";
          return `Set priority to ${label}`;
        }
        case "setProject":
          return `Set project to ${a.value}`;
        default:
          return a.type;
      }
    })
    .join(", ");
}

function makeEmptyCondition(): RuleCondition {
  return { field: "content", operator: "contains", value: "" };
}

function makeEmptyAction(): RuleAction {
  return { type: "setCategory", value: "work" };
}

// ---------------------------------------------------------------------------
// Select helper (native select styled to match design system)
// ---------------------------------------------------------------------------

interface NativeSelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
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
// Action value input — renders dropdown or text based on action type
// ---------------------------------------------------------------------------

interface ActionValueInputProps {
  action: RuleAction;
  onChange: (value: string) => void;
}

function ActionValueInput({ action, onChange }: ActionValueInputProps) {
  if (action.type === "setCategory") {
    return (
      <NativeSelect
        value={action.value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1"
        aria-label="Category value"
      >
        {CATEGORY_VALUES.map((v) => (
          <option key={v} value={v}>
            {v.charAt(0).toUpperCase() + v.slice(1)}
          </option>
        ))}
      </NativeSelect>
    );
  }

  if (action.type === "setPriority") {
    return (
      <NativeSelect
        value={action.value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1"
        aria-label="Priority value"
      >
        {PRIORITY_VALUES.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </NativeSelect>
    );
  }

  if (action.type === "markAsRead") {
    return <span className="flex-1 text-xs text-muted-foreground italic">No value needed</span>;
  }

  // setProject — free text
  return (
    <Input
      value={action.value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Project name or ID"
      className="flex-1 h-9"
      aria-label="Project value"
    />
  );
}

// ---------------------------------------------------------------------------
// Rule form — add or edit a single rule
// ---------------------------------------------------------------------------

interface RuleFormProps {
  initial?: {
    name: string;
    conditions: RuleCondition[];
    actions: RuleAction[];
    priority: number;
  };
  onSave: (data: {
    name: string;
    conditions: RuleCondition[];
    actions: RuleAction[];
    priority: number;
  }) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
}

function RuleForm({ initial, onSave, onCancel, saving }: RuleFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [conditions, setConditions] = useState<RuleCondition[]>(
    initial?.conditions && initial.conditions.length > 0
      ? initial.conditions
      : [makeEmptyCondition()]
  );
  const [actions, setActions] = useState<RuleAction[]>(
    initial?.actions && initial.actions.length > 0
      ? initial.actions
      : [makeEmptyAction()]
  );
  const [priority, setPriority] = useState(initial?.priority ?? 0);

  function updateCondition(
    index: number,
    patch: Partial<RuleCondition>
  ) {
    setConditions((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c))
    );
  }

  function removeCondition(index: number) {
    setConditions((prev) => prev.filter((_, i) => i !== index));
  }

  function updateAction(index: number, patch: Partial<RuleAction>) {
    setActions((prev) => {
      const next = prev.map((a, i) => {
        if (i !== index) return a;
        const updated = { ...a, ...patch };
        // Reset value when type changes to avoid stale values
        if (patch.type && patch.type !== a.type) {
          updated.value =
            patch.type === "setCategory"
              ? "work"
              : patch.type === "setPriority"
                ? "0"
                : "";
        }
        return updated;
      });
      return next;
    });
  }

  function removeAction(index: number) {
    setActions((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!name.trim()) {
      toast("error", "Rule name is required.");
      return;
    }
    if (conditions.length === 0) {
      toast("error", "At least one condition is required.");
      return;
    }
    if (actions.length === 0) {
      toast("error", "At least one action is required.");
      return;
    }
    if (conditions.some((c) => !c.value.trim())) {
      toast("error", "All condition values must be filled in.");
      return;
    }

    await onSave({ name: name.trim(), conditions, actions, priority });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Name */}
      <div className="space-y-1.5">
        <Label htmlFor="rule-name">Rule name</Label>
        <Input
          id="rule-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Flag urgent messages"
          className="h-9"
          required
        />
      </div>

      <Separator />

      {/* Conditions */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Conditions</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() =>
              setConditions((prev) => [...prev, makeEmptyCondition()])
            }
          >
            <Plus className="h-3 w-3 mr-1" aria-hidden="true" />
            Add condition
          </Button>
        </div>

        {conditions.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            No conditions — rule will match all messages.
          </p>
        )}

        {conditions.map((cond, i) => (
          <div key={i} className="flex items-center gap-2">
            <NativeSelect
              value={cond.field}
              onChange={(e) =>
                updateCondition(i, {
                  field: e.target.value as RuleCondition["field"],
                })
              }
              aria-label={`Condition ${i + 1} field`}
            >
              {CONDITION_FIELDS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </NativeSelect>

            <NativeSelect
              value={cond.operator}
              onChange={(e) =>
                updateCondition(i, {
                  operator: e.target.value as RuleCondition["operator"],
                })
              }
              aria-label={`Condition ${i + 1} operator`}
            >
              {CONDITION_OPERATORS.map((op) => (
                <option key={op.value} value={op.value}>
                  {op.label}
                </option>
              ))}
            </NativeSelect>

            <Input
              value={cond.value}
              onChange={(e) => updateCondition(i, { value: e.target.value })}
              placeholder="Value"
              className="flex-1 h-9"
              aria-label={`Condition ${i + 1} value`}
            />

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive flex-shrink-0"
              onClick={() => removeCondition(i)}
              aria-label={`Remove condition ${i + 1}`}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>

      <Separator />

      {/* Actions */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Actions</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() =>
              setActions((prev) => [...prev, makeEmptyAction()])
            }
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
          <div key={i} className="flex items-center gap-2">
            <NativeSelect
              value={action.type}
              onChange={(e) =>
                updateAction(i, {
                  type: e.target.value as RuleAction["type"],
                })
              }
              aria-label={`Action ${i + 1} type`}
            >
              {ACTION_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>

            <ActionValueInput
              action={action}
              onChange={(value) => updateAction(i, { value })}
            />

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive flex-shrink-0"
              onClick={() => removeAction(i)}
              aria-label={`Remove action ${i + 1}`}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>

      <Separator />

      {/* Priority */}
      <div className="space-y-1.5">
        <Label htmlFor="rule-priority">
          Rule priority{" "}
          <span className="text-xs font-normal text-muted-foreground">
            (lower runs first)
          </span>
        </Label>
        <Input
          id="rule-priority"
          type="number"
          min={0}
          max={9999}
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
          className="h-9 w-28"
        />
      </div>

      {/* Save / Cancel */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving..." : "Save rule"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Rule row
// ---------------------------------------------------------------------------

interface RuleRowProps {
  rule: InboxRule;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onEdit: (rule: InboxRule) => void;
  onDelete: (id: string) => Promise<void>;
  confirmingDelete: boolean;
  onCancelDelete: () => void;
}

function RuleRow({ rule, onToggle, onEdit, onDelete, confirmingDelete, onCancelDelete }: RuleRowProps) {
  const enabled = rule.enabled === 1;
  const conditions = parseConditions(rule.conditions);
  const actions = parseActions(rule.actions);

  return (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-3 rounded-md border",
        enabled ? "border-border bg-background" : "border-dashed border-border/60 bg-muted/30"
      )}
    >
      {/* Enable/disable toggle */}
      <div className="mt-0.5 flex-shrink-0">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? "Disable" : "Enable"} rule "${rule.name}"`}
          onClick={() => onToggle(rule.id, !enabled)}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent",
            "transition-colors duration-200 ease-in-out",
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
      <div className="flex-1 min-w-0 space-y-0.5">
        <p
          className={cn(
            "text-sm font-medium truncate",
            !enabled && "text-muted-foreground"
          )}
        >
          {rule.name}
        </p>
        <p className="text-xs text-muted-foreground truncate">
          {summarizeConditions(conditions)}
        </p>
        <p className="text-xs text-muted-foreground truncate">
          {summarizeActions(actions)}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground"
          onClick={() => onEdit(rule)}
          aria-label={`Edit rule "${rule.name}"`}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        {confirmingDelete ? (
          <>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onDelete(rule.id)}
            >
              Confirm
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground"
              onClick={onCancelDelete}
              aria-label="Cancel delete"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(rule.id)}
            aria-label={`Delete rule "${rule.name}"`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InboxRulesEditor
// ---------------------------------------------------------------------------

export interface InboxRulesEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InboxRulesEditor({ open, onOpenChange }: InboxRulesEditorProps) {
  const [rules, setRules] = useState<InboxRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // "adding" = showing add form; "editing" = showing edit form for a rule id
  const [mode, setMode] = useState<"list" | "adding" | "editing">("list");
  const [editingRule, setEditingRule] = useState<InboxRule | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Load rules whenever dialog opens
  // ---------------------------------------------------------------------------

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const result = await rpc.getInboxRules();
      const raw = result as unknown as InboxRule[];
      setRules(Array.isArray(raw) ? raw : []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load rules.";
      toast("error", msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadRules();
      setMode("list");
      setEditingRule(null);
    }
  }, [open, loadRules]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function handleToggle(id: string, enabled: boolean) {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: enabled ? 1 : 0 } : r))
    );
    try {
      await rpc.updateInboxRule({ id, enabled });
    } catch {
      // Roll back
      setRules((prev) =>
        prev.map((r) => (r.id === id ? { ...r, enabled: enabled ? 0 : 1 } : r))
      );
      toast("error", "Failed to update rule.");
    }
  }

  async function handleDelete(id: string) {
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id);
      return;
    }
    setPendingDeleteId(null);
    const previous = rules.find((r) => r.id === id);
    setRules((prev) => prev.filter((r) => r.id !== id));
    try {
      await rpc.deleteInboxRule(id);
      toast("success", "Rule deleted.");
    } catch {
      if (previous) {
        setRules((prev) => [...prev, previous]);
      }
      toast("error", "Failed to delete rule.");
    }
  }

  async function handleSaveNew(data: {
    name: string;
    conditions: RuleCondition[];
    actions: RuleAction[];
    priority: number;
  }) {
    setSaving(true);
    try {
      const result = await rpc.createInboxRule({
        name: data.name,
        conditions: JSON.stringify(data.conditions),
        actions: JSON.stringify(data.actions),
        priority: data.priority,
      });
      const { id } = result as unknown as { id: string };

      const newRule: InboxRule = {
        id,
        projectId: null,
        name: data.name,
        conditions: JSON.stringify(data.conditions),
        actions: JSON.stringify(data.actions),
        enabled: 1,
        priority: data.priority,
        createdAt: new Date().toISOString(),
      };

      setRules((prev) => [...prev, newRule]);
      setMode("list");
      toast("success", "Rule created.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create rule.";
      toast("error", msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit(data: {
    name: string;
    conditions: RuleCondition[];
    actions: RuleAction[];
    priority: number;
  }) {
    if (!editingRule) return;
    setSaving(true);
    try {
      await rpc.updateInboxRule({
        id: editingRule.id,
        name: data.name,
        conditions: JSON.stringify(data.conditions),
        actions: JSON.stringify(data.actions),
        priority: data.priority,
      });

      setRules((prev) =>
        prev.map((r) =>
          r.id === editingRule.id
            ? {
                ...r,
                name: data.name,
                conditions: JSON.stringify(data.conditions),
                actions: JSON.stringify(data.actions),
                priority: data.priority,
              }
            : r
        )
      );
      setMode("list");
      setEditingRule(null);
      toast("success", "Rule updated.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update rule.";
      toast("error", msg);
    } finally {
      setSaving(false);
    }
  }

  function handleEditClick(rule: InboxRule) {
    setEditingRule(rule);
    setMode("editing");
  }

  function handleCancelForm() {
    setMode("list");
    setEditingRule(null);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const canAddMore = rules.length < MAX_RULES;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <div>
              <DialogTitle>Inbox Rules</DialogTitle>
              <p className="text-sm text-muted-foreground mt-0.5">
                Automatically categorize and prioritize incoming messages
              </p>
            </div>
            <Badge variant="outline" className="text-xs flex-shrink-0">
              {rules.length} of {MAX_RULES} rules
            </Badge>
          </div>
        </DialogHeader>

        <Separator />

        {/* Rules list */}
        {mode === "list" && (
          <div className="space-y-4">
            {loading ? (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-16 rounded-md border border-border bg-muted/30 animate-pulse"
                    aria-hidden="true"
                  />
                ))}
              </div>
            ) : rules.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No rules yet. Create one to automatically sort and prioritize
                  your messages.
                </p>
              </div>
            ) : (
              <div className="space-y-2" role="list" aria-label="Inbox rules">
                {rules
                  .slice()
                  .sort((a, b) => a.priority - b.priority)
                  .map((rule) => (
                    <div key={rule.id} role="listitem">
                      <RuleRow
                        rule={rule}
                        onToggle={handleToggle}
                        onEdit={handleEditClick}
                        onDelete={handleDelete}
                        confirmingDelete={pendingDeleteId === rule.id}
                        onCancelDelete={() => setPendingDeleteId(null)}
                      />
                    </div>
                  ))}
              </div>
            )}

            {/* Add rule button */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full flex items-center gap-1.5"
              disabled={!canAddMore || loading}
              onClick={() => setMode("adding")}
              aria-disabled={!canAddMore}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {canAddMore
                ? "Add rule"
                : `Maximum ${MAX_RULES} rules reached`}
            </Button>
          </div>
        )}

        {/* Add form */}
        {mode === "adding" && (
          <div className="space-y-4">
            <p className="text-sm font-semibold">New rule</p>
            <RuleForm
              onSave={handleSaveNew}
              onCancel={handleCancelForm}
              saving={saving}
            />
          </div>
        )}

        {/* Edit form */}
        {mode === "editing" && editingRule && (
          <div className="space-y-4">
            <p className="text-sm font-semibold">Edit rule</p>
            <RuleForm
              initial={{
                name: editingRule.name,
                conditions: parseConditions(editingRule.conditions),
                actions: parseActions(editingRule.actions),
                priority: editingRule.priority,
              }}
              onSave={handleSaveEdit}
              onCancel={handleCancelForm}
              saving={saving}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
