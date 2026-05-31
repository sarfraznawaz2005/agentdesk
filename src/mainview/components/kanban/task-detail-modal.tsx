import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Plus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { cn } from "@/lib/utils";
import { useKanbanStore, type KanbanTask } from "../../stores/kanban-store";
import type { KanbanColumn } from "../../stores/kanban-store";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AcceptanceCriterionItem {
  text: string;
  checked: boolean;
}

interface TaskDetailModalProps {
  task: KanbanTask | null;
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLUMN_OPTIONS: { value: KanbanColumn; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "working", label: "Working" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
];

const COLUMN_BADGE_CLASSES: Record<KanbanColumn, string> = {
  backlog: "bg-muted text-muted-foreground border-border",
  working: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  review: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  done: "bg-green-500/15 text-green-400 border-green-500/30",
};

const PRIORITY_OPTIONS = [
  {
    value: "critical",
    label: "Critical",
    activeClass: "bg-red-500/20 text-red-400 border-red-500/50 ring-1 ring-red-500/40",
    idleClass: "bg-transparent text-muted-foreground border-border hover:border-red-500/40 hover:text-red-400",
  },
  {
    value: "high",
    label: "High",
    activeClass: "bg-orange-500/20 text-orange-400 border-orange-500/50 ring-1 ring-orange-500/40",
    idleClass: "bg-transparent text-muted-foreground border-border hover:border-orange-500/40 hover:text-orange-400",
  },
  {
    value: "medium",
    label: "Medium",
    activeClass: "bg-blue-500/20 text-blue-400 border-blue-500/50 ring-1 ring-blue-500/40",
    idleClass: "bg-transparent text-muted-foreground border-border hover:border-blue-500/40 hover:text-blue-400",
  },
  {
    value: "low",
    label: "Low",
    activeClass: "bg-zinc-500/20 text-muted-foreground border-zinc-500/50 ring-1 ring-zinc-500/40",
    idleClass: "bg-transparent text-muted-foreground border-border hover:border-zinc-500/40 hover:text-foreground",
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCriteria(raw: string | null): AcceptanceCriterionItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      if (typeof item === "string") return { text: item, checked: false };
      if (typeof item === "object" && item !== null && "text" in item) {
        return {
          text: String((item as Record<string, unknown>).text ?? ""),
          checked: Boolean((item as Record<string, unknown>).checked),
        };
      }
      return null;
    }).filter((item): item is AcceptanceCriterionItem => item !== null);
  } catch {
    // Plain-text fallback: newline-separated criteria (legacy agent format)
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((text) => ({ text, checked: false }));
  }
}

// ---------------------------------------------------------------------------
// Section wrapper for consistent spacing + labelling
// ---------------------------------------------------------------------------

function Section({
  label,
  required,
  children,
  className,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </Label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TaskDetailModal({ task, open, onClose }: TaskDetailModalProps) {
  const updateTask = useKanbanStore((s) => s.updateTask);
  const moveTask = useKanbanStore((s) => s.moveTask);
  const deleteTask = useKanbanStore((s) => s.deleteTask);

  // Local editing state — synced from task prop whenever task changes
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [importantNotes, setImportantNotes] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [criteria, setCriteria] = useState<AcceptanceCriterionItem[]>([]);

  const [newCriterionText, setNewCriterionText] = useState("");
  const newCriterionRef = useRef<HTMLInputElement>(null);

  // Delete confirmation dialog state
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Sync local state whenever the task changes (different task opened)
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
    setImportantNotes(task.importantNotes ?? "");
    setDueDate(task.dueDate ?? "");
    setCriteria(parseCriteria(task.acceptanceCriteria));
  }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!task) return null;

  // After the null guard, `task` is guaranteed non-null for these helpers.
  const t = task;

  // ------------------------------------------------------------------
  // Save helpers
  // ------------------------------------------------------------------

  function saveTitle() {
    const trimmed = title.trim();
    if (!trimmed || trimmed === t.title) return;
    void updateTask({ id: t.id, title: trimmed });
  }

  function saveDescription() {
    if (description === (t.description ?? "")) return;
    void updateTask({ id: t.id, description });
  }

  function saveImportantNotes() {
    if (importantNotes === (t.importantNotes ?? "")) return;
    void updateTask({ id: t.id, importantNotes });
  }

  function saveDueDate() {
    const trimmed = dueDate.trim();
    if (trimmed === (t.dueDate ?? "")) return;
    void updateTask({ id: t.id, dueDate: trimmed || undefined });
  }

  function savePriority(value: string) {
    if (value === t.priority) return;
    void updateTask({ id: t.id, priority: value });
  }

  function saveColumn(value: KanbanColumn) {
    if (value === t.column) return;
    if (value === "done" && doneBlockMessage) return;
    void moveTask(t.id, value);
  }

  function toggleCriterion(index: number) {
    const next = criteria.map((item, i) =>
      i === index ? { ...item, checked: !item.checked } : item,
    );
    setCriteria(next);
    void updateTask({
      id: t.id,
      acceptanceCriteria: JSON.stringify(next),
    });
  }

  function addCriterion() {
    const text = newCriterionText.trim();
    if (!text) return;
    const next = [...criteria, { text, checked: false }];
    setCriteria(next);
    setNewCriterionText("");
    void updateTask({ id: t.id, acceptanceCriteria: JSON.stringify(next) });
    newCriterionRef.current?.focus();
  }

  function removeCriterion(index: number) {
    const next = criteria.filter((_, i) => i !== index);
    setCriteria(next);
    void updateTask({ id: t.id, acceptanceCriteria: JSON.stringify(next) });
  }

  function handleDelete() {
    setDeleteConfirmOpen(true);
  }

  function confirmDelete() {
    void deleteTask(t.id);
    onClose();
  }

  // ------------------------------------------------------------------
  // Derived values
  // ------------------------------------------------------------------

  const checkedCount = criteria.filter((c) => c.checked).length;
  const column = task.column as KanbanColumn;
  const unmetCount = criteria.filter((c) => !c.checked).length;
  const doneBlockMessage = criteria.length === 0
    ? "Add at least one acceptance criterion and complete it before marking this task Done."
    : unmetCount > 0
      ? `${unmetCount} acceptance ${unmetCount === 1 ? "criterion" : "criteria"} not yet met. Complete all before moving to Done.`
      : null;

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
        <DialogContent
          className={cn(
            "max-w-2xl w-full max-h-[90vh] overflow-y-auto",
            "bg-background border-border text-foreground",
            // Remove the default gap from DialogContent so we control spacing
            "gap-0 p-0",
          )}
        >
          {/* ----------------------------------------------------------------
              Header — editable title
          ---------------------------------------------------------------- */}
          <DialogHeader className="px-6 pr-12 pt-6 pb-4 border-b border-border">
            <DialogTitle asChild>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                className={cn(
                  "text-lg font-semibold border-transparent bg-transparent",
                  "hover:border-border focus-visible:border-border",
                  "px-2 py-1 h-auto",
                )}
                placeholder="Task title"
                aria-label="Task title"
              />
            </DialogTitle>
          </DialogHeader>

          {/* ----------------------------------------------------------------
              Body
          ---------------------------------------------------------------- */}
          <div className="px-6 py-5 flex flex-col gap-6">

            {/* ---- Status / Column ---- */}
            <Section label="Status">
              <div className="flex items-center gap-3">
                <Badge
                  className={cn(
                    "text-xs",
                    COLUMN_BADGE_CLASSES[column] ?? COLUMN_BADGE_CLASSES.backlog,
                  )}
                >
                  {column}
                </Badge>

                <select
                  value={column}
                  onChange={(e) => saveColumn(e.target.value as KanbanColumn)}
                  className={cn(
                    "text-xs rounded-md border border-border bg-card",
                    "px-2 py-1 text-foreground",
                    "focus:outline-none focus:ring-1 focus:ring-ring",
                    "cursor-pointer",
                  )}
                  aria-label="Move task to column"
                >
                  {COLUMN_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              {doneBlockMessage && (
                <p className="text-xs text-amber-600 flex items-center gap-1 mt-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                  {doneBlockMessage}
                </p>
              )}
            </Section>

            {/* ---- Priority ---- */}
            <Section label="Priority">
              <div className="flex gap-2" role="group" aria-label="Task priority">
                {PRIORITY_OPTIONS.map((opt) => {
                  const isActive = task.priority === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => savePriority(opt.value)}
                      aria-pressed={isActive}
                      className={cn(
                        "px-3 py-1 text-xs rounded-md border font-medium transition-all",
                        isActive ? opt.activeClass : opt.idleClass,
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </Section>

            {/* ---- Description ---- */}
            <Section label="Description">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={saveDescription}
                placeholder="Add a description..."
                rows={4}
                className="bg-card border-border resize-none text-sm"
                aria-label="Task description"
              />
            </Section>

            {/* ---- Acceptance Criteria ---- */}
            <Section label="Acceptance Criteria" required>
              {criteria.length > 0 ? (
                <>
                  <div className="flex flex-col gap-1">
                    {criteria.map((item, index) => (
                      <div
                        key={index}
                        className={cn(
                          "flex items-start gap-2.5 group",
                          "rounded-md px-2 py-1.5",
                          "hover:bg-muted/60 transition-colors",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={item.checked}
                          onChange={() => toggleCriterion(index)}
                          className={cn(
                            "mt-0.5 h-4 w-4 shrink-0 rounded",
                            "border-border bg-card",
                            "accent-primary",
                            "cursor-pointer",
                          )}
                          aria-label={item.text}
                        />
                        <span
                          className={cn(
                            "text-sm leading-snug flex-1",
                            item.checked
                              ? "text-muted-foreground line-through"
                              : "text-foreground",
                          )}
                        >
                          {item.text}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeCriterion(index)}
                          aria-label="Remove criterion"
                          className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded text-muted-foreground hover:text-destructive transition-all"
                        >
                          <X className="w-3 h-3" aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {checkedCount}/{criteria.length} completed
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No acceptance criteria defined.
                </p>
              )}

              {/* Add new criterion */}
              <div className="flex gap-2 mt-1">
                <input
                  ref={newCriterionRef}
                  type="text"
                  value={newCriterionText}
                  onChange={(e) => setNewCriterionText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCriterion(); } }}
                  placeholder="Add acceptance criterion..."
                  className={cn(
                    "flex-1 text-sm px-2 py-1 rounded-md border border-border bg-card",
                    "text-foreground placeholder:text-muted-foreground",
                    "focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring",
                  )}
                  aria-label="New acceptance criterion"
                />
                <button
                  type="button"
                  onClick={addCriterion}
                  disabled={!newCriterionText.trim()}
                  className={cn(
                    "flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                    "border border-border bg-card text-muted-foreground",
                    "hover:bg-muted hover:text-foreground",
                    "disabled:opacity-40 disabled:cursor-not-allowed",
                    "focus:outline-none focus:ring-1 focus:ring-ring",
                  )}
                  aria-label="Add criterion"
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  Add
                </button>
              </div>
            </Section>

            {/* ---- Important Notes ---- */}
            <Section label="Important Notes">
              <Textarea
                value={importantNotes}
                onChange={(e) => setImportantNotes(e.target.value)}
                onBlur={saveImportantNotes}
                placeholder="Agent decisions, blockers, context..."
                rows={3}
                className="bg-card border-border resize-none text-sm"
                aria-label="Important notes"
              />
            </Section>

            {/* ---- Meta row (agent + due date) ---- */}
            <div className="grid grid-cols-2 gap-4">
              {/* Assigned agent */}
              <Section label="Assigned Agent">
                {task.assignedAgentId ? (
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-primary/30 border border-primary/50 shrink-0" />
                    <span className="text-sm text-foreground font-mono truncate">
                      {task.assignedAgentId}
                    </span>
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground italic">Unassigned</span>
                )}
              </Section>

              {/* Due date */}
              <Section label="Due Date">
                <Input
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  onBlur={saveDueDate}
                  placeholder="e.g. 2026-03-15"
                  className="bg-card border-border text-sm h-8"
                  aria-label="Due date"
                />
              </Section>
            </div>

            {/* ---- Timestamps ---- */}
            <div className="flex gap-6 text-[11px] text-muted-foreground">
              <span>
                Created{" "}
                <span className="text-foreground">
                  {new Date(task.createdAt).toLocaleString()}
                </span>
              </span>
              <span>
                Updated{" "}
                <span className="text-foreground">
                  {new Date(task.updatedAt).toLocaleString()}
                </span>
              </span>
            </div>

            {/* ---- Task ID ---- */}
            <p className="text-[11px] text-muted-foreground font-mono -mt-2">
              ID: {task.id}
            </p>
          </div>

          {/* ----------------------------------------------------------------
              Footer — delete action
          ---------------------------------------------------------------- */}
          <div className="px-6 pb-6 pt-2 border-t border-border flex justify-end">
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              className="text-xs"
            >
              Delete Task
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete Task"
        description={`Delete task "${task.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </>
  );
}
