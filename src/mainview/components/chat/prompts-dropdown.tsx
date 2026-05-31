import { useState, useEffect } from "react";
import { BookOpen } from "lucide-react";
import { rpc } from "@/lib/rpc";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { SearchInput } from "@/components/ui/search-input";

interface Prompt {
  id: string;
  name: string;
  description: string;
  content: string;
  category: string;
}

interface PromptsDropdownProps {
  onSelect: (content: string) => void;
  disabled?: boolean;
}

export function PromptsDropdown({ onSelect, disabled }: PromptsDropdownProps) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    rpc
      .searchPrompts(query)
      .then((results) => setPrompts(results as Prompt[]))
      .catch(() => {});
  }, [open, query]);

  // Reset search when popover closes
  useEffect(() => {
    if (!open) {
      setQuery(""); // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip content="Prompts Library" side="top">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open prompts library"
            disabled={disabled}
            className="flex-shrink-0 h-8 w-8 text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted"
          >
            <BookOpen className="size-4" />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="w-80 p-0" align="start" side="top">
        <div className="border-b p-2">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search prompts..."
          />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {prompts.length === 0 ? (
            <p className="p-3 text-center text-sm text-muted-foreground">
              No prompts found
            </p>
          ) : (
            prompts.map((p) => (
              <button
                key={p.id}
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:bg-muted/50 transition-colors"
                onClick={() => {
                  onSelect(p.content);
                  setOpen(false);
                }}
              >
                <p className="text-sm font-medium leading-snug">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {p.description}
                </p>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
