import { useState, useEffect, useCallback, useRef } from "react";
import { File, Trash2, GitFork, Sparkles, Plus, Zap, Check, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PopoverItem {
  id: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  type?: string;
}

// ---------------------------------------------------------------------------
// Slash command definitions (alphabetical)
// ---------------------------------------------------------------------------

export const SLASH_COMMANDS: PopoverItem[] = [
  { id: "clear", label: "/clear", description: "Clear conversation", icon: <Trash2 className="w-3.5 h-3.5" /> },
  { id: "compact", label: "/compact", description: "Compact conversation via AI", icon: <Zap className="w-3.5 h-3.5" /> },
  { id: "fork", label: "/fork", description: "Fork conversation from here", icon: <GitFork className="w-3.5 h-3.5" /> },
  { id: "info", label: "/info", description: "Show running agents & project status", icon: <Check className="w-3.5 h-3.5" /> },
  { id: "init", label: "/init", description: "Analyze project & create AGENTS.md", icon: <Sparkles className="w-3.5 h-3.5" /> },
  { id: "new", label: "/new", description: "New conversation", icon: <Plus className="w-3.5 h-3.5" /> },
  { id: "preview", label: "/preview", description: "Launch a live preview of this project", icon: <Monitor className="w-3.5 h-3.5" /> },
];

// ---------------------------------------------------------------------------
// File item builder
// ---------------------------------------------------------------------------

export function buildFileItem(filePath: string): PopoverItem {
  const name = filePath.split(/[/\\]/).pop() || filePath;
  return {
    id: filePath,
    label: name,
    description: filePath !== name ? filePath : undefined,
    icon: <File className="w-3.5 h-3.5 text-blue-400" />,
    type: "file",
  };
}

// ---------------------------------------------------------------------------
// Hook: useInputPopover
// ---------------------------------------------------------------------------

interface UseInputPopoverOptions {
  items: PopoverItem[];
  visible: boolean;
  query: string;
  onSelect: (item: PopoverItem) => void;
  onClose: () => void;
  /** IDs of already-selected items (shown with checkmark) */
  selectedIds?: string[];
}

export function useInputPopover({ items, visible, query, onSelect, onClose, selectedIds = [] }: UseInputPopoverOptions) {
  const selectedSet = new Set(selectedIds);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter items by query — match command id/label only (not description)
  // so that e.g. typing "new" doesn't surface commands whose description
  // happens to contain the word "new".
  const filtered = query
    ? items.filter((item) => {
        const q = query.toLowerCase();
        return item.id.toLowerCase().startsWith(q)
          || item.label.toLowerCase().startsWith("/" + q);
      })
    : items;

  // Reset selection when query or item count changes
  useEffect(() => {
    setSelectedIndex(0); // eslint-disable-line react-hooks/set-state-in-effect
  }, [query, items.length]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[selectedIndex] as HTMLElement;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Keyboard handler — call from textarea onKeyDown BEFORE default handling.
  // Returns true if event was consumed.
  const handleKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (!visible || filtered.length === 0) return false;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filtered.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      onSelect(filtered[selectedIndex]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return true;
    }
    return false;
  }, [visible, filtered, selectedIndex, onSelect, onClose]);

  // Rendered popover element (null when hidden)
  const popoverElement = (visible && filtered.length > 0) ? (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 z-50 max-h-[240px] overflow-y-auto rounded-lg border border-border bg-background shadow-lg"
    >
      {filtered.slice(0, 15).map((item, i) => (
        <button
          key={item.id}
          type="button"
          className={cn(
            "w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors",
            i === selectedIndex ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300" : "text-foreground/80 hover:bg-muted/50",
          )}
          onMouseEnter={() => setSelectedIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // prevent textarea blur
            onSelect(item);
          }}
        >
          <span className="shrink-0 text-muted-foreground/60">{item.icon}</span>
          <span className={cn("truncate", item.type === "file" ? "font-mono text-xs" : "font-medium")}>
            {item.label}
          </span>
          {item.description && (
            <span className="text-xs text-muted-foreground/60 truncate ml-auto max-w-[60%]">{item.description}</span>
          )}
          {selectedSet.has(item.id) && (
            <Check className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          )}
        </button>
      ))}
    </div>
  ) : null;

  return { popoverElement, handleKeyDown, filtered };
}
