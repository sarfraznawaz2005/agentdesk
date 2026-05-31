import { useState, useEffect, useRef, useCallback } from "react";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface MessageSearchProps {
  messages: Array<{ id: string; content: string; role: string }>;
  onHighlight: (messageId: string | null, matchIndex: number) => void;
  onQueryChange?: (query: string) => void;
  onClose: () => void;
}

export function MessageSearch({ messages, onHighlight, onQueryChange, onClose }: MessageSearchProps) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<string[]>([]);
  const [totalOccurrences, setTotalOccurrences] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    onQueryChange?.(query);
    if (!query.trim()) {
      setMatches([]); // eslint-disable-line react-hooks/set-state-in-effect
      setTotalOccurrences(0);
      setCurrentMatch(0);
      onHighlight(null, -1);
      return;
    }
    const tokens = query.trim().split(/\s+/).filter(Boolean);
    const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(escaped.join("|"), "gi");
    let occurrences = 0;
    const found: string[] = [];
    for (const m of messages) {
      const hits = m.content.match(re);
      if (hits) {
        found.push(m.id);
        occurrences += hits.length;
      }
    }
    setTotalOccurrences(occurrences);
    setMatches(found);
    setCurrentMatch(0);
    if (found.length > 0) {
      onHighlight(found[0], 0);
    } else {
      onHighlight(null, -1);
    }
  }, [query, messages, onHighlight, onQueryChange]);

  const goTo = useCallback(
    (index: number) => {
      if (matches.length === 0) return;
      const wrapped = ((index % matches.length) + matches.length) % matches.length;
      setCurrentMatch(wrapped);
      onHighlight(matches[wrapped], wrapped);
    },
    [matches, onHighlight],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      goTo(e.shiftKey ? currentMatch - 1 : currentMatch + 1);
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-background border-b border-border shadow-sm">
      <Search className="w-4 h-4 text-muted-foreground/60 shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search messages..."
        className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground/60"
      />
      {query && (
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {totalOccurrences > 0 ? `${totalOccurrences} found` : "0 results"}
        </span>
      )}
      <button
        onClick={() => goTo(currentMatch - 1)}
        disabled={matches.length === 0}
        className={cn(
          "p-0.5 rounded text-muted-foreground/60 hover:text-foreground transition-colors",
          matches.length === 0 && "opacity-30 cursor-not-allowed",
        )}
        aria-label="Previous match"
      >
        <ChevronUp className="w-4 h-4" />
      </button>
      <button
        onClick={() => goTo(currentMatch + 1)}
        disabled={matches.length === 0}
        className={cn(
          "p-0.5 rounded text-muted-foreground/60 hover:text-foreground transition-colors",
          matches.length === 0 && "opacity-30 cursor-not-allowed",
        )}
        aria-label="Next match"
      >
        <ChevronDown className="w-4 h-4" />
      </button>
      <button
        onClick={onClose}
        className="p-0.5 rounded text-muted-foreground/60 hover:text-foreground transition-colors"
        aria-label="Close search"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
