import { useState } from "react";
import { Search, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

type SortOption = "priority" | "due_date" | "created_at";
type PriorityFilter = "critical" | "high" | "medium" | "low";

interface KanbanFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  sortBy: SortOption;
  onSortChange: (sort: SortOption) => void;
  filterPriority: string | null;
  onFilterPriorityChange: (priority: string | null) => void;
  filterAgent: string | null;
  onFilterAgentChange: (agent: string | null) => void;
  onDeleteAll?: () => void;
  newConvPerTask: boolean;
  onNewConvPerTaskChange: (value: boolean) => void;
}

const PRIORITY_FILTERS: Array<{ value: PriorityFilter | null; label: string }> = [
  { value: null, label: "All" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: "priority", label: "Priority" },
  { value: "due_date", label: "Due Date" },
  { value: "created_at", label: "Created" },
];

export function KanbanFilters({
  searchQuery,
  onSearchChange,
  sortBy,
  onSortChange,
  filterPriority,
  onFilterPriorityChange,
  onDeleteAll,
  newConvPerTask,
  onNewConvPerTaskChange,
}: KanbanFiltersProps) {
  const [inputFocused, setInputFocused] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b bg-card flex-wrap">
      {/* Search input */}
      <div className="relative flex-shrink-0">
        <Search
          className={cn(
            "absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none transition-colors",
            inputFocused ? "text-foreground" : "text-muted-foreground",
          )}
          aria-hidden="true"
        />
        <input
          type="text"
          placeholder="Search tasks..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          className={cn(
            "text-sm pl-7 pr-2 py-1 rounded-md border bg-background",
            "text-foreground placeholder:text-muted-foreground",
            "focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring",
            "transition-colors w-44",
          )}
        />
      </div>

      {/* Sort dropdown */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <label
          htmlFor="kanban-sort"
          className="text-xs text-muted-foreground select-none whitespace-nowrap"
        >
          Sort by
        </label>
        <select
          id="kanban-sort"
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value as SortOption)}
          className={cn(
            "text-sm py-1 pl-2 pr-6 rounded-md border bg-background",
            "text-foreground appearance-none cursor-pointer",
            "focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring",
            "transition-colors",
          )}
          style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2371717a' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 6px center" }}
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Priority filter buttons */}
      <div
        className="flex items-center gap-1 flex-shrink-0"
        role="group"
        aria-label="Filter by priority"
      >
        {PRIORITY_FILTERS.map(({ value, label }) => {
          const isActive = filterPriority === value;
          return (
            <button
              key={label}
              type="button"
              onClick={() => onFilterPriorityChange(value)}
              className={cn(
                "text-xs px-2 py-1 rounded-md border transition-colors",
                "focus:outline-none focus:ring-1 focus:ring-ring",
                isActive
                  ? "bg-primary/15 border-primary/40 text-primary font-medium"
                  : "bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:border-border",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* New Conversation per Task toggle — far right */}
      <div className="ml-auto flex items-center gap-2 flex-shrink-0">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={newConvPerTask}
            onChange={(e) => onNewConvPerTaskChange(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-primary cursor-pointer"
          />
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            New Conv. per Task
          </span>
        </label>
      </div>

      {/* Delete All */}
      {onDeleteAll && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {confirmDelete ? (
            <>
              <span className="text-xs text-destructive font-medium select-none">
                Delete all tasks?
              </span>
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  onDeleteAll();
                }}
                className="text-xs px-2 py-1 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors focus:outline-none focus:ring-1 focus:ring-destructive"
              >
                Yes, delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="text-xs px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className={cn(
                "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition-colors",
                "border-destructive/40 text-destructive hover:bg-destructive/10",
                "focus:outline-none focus:ring-1 focus:ring-destructive",
              )}
            >
              <Trash2 className="w-3 h-3" aria-hidden="true" />
              Delete All
            </button>
          )}
        </div>
      )}
    </div>
  );
}
