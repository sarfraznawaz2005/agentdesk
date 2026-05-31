import { useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ModelInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function ModelInput({
  id,
  value,
  onChange,
  suggestions,
  placeholder = "Type or select a model...",
  disabled,
  className,
}: ModelInputProps) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = value.trim()
    ? suggestions.filter((s) => s.toLowerCase().includes(value.toLowerCase()))
    : suggestions;

  const showDropdown = open && filtered.length > 0;

  return (
    <div className={cn("relative", className)}>
      <input
        ref={inputRef}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          value ? "pr-8" : "",
        )}
      />
      {value && !disabled && (
        <button
          type="button"
          aria-label="Clear"
          tabIndex={-1}
          onMouseDown={(e) => {
            e.preventDefault();
            onChange("");
            inputRef.current?.focus();
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {showDropdown && (
        <ul className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md">
          {filtered.map((m) => (
            <li key={m}>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(m);
                  setOpen(false);
                }}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-sm",
                  "hover:bg-accent hover:text-accent-foreground",
                  m === value && "bg-accent/50 font-medium",
                )}
              >
                {m}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
