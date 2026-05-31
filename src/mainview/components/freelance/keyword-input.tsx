import { useState, KeyboardEvent, useRef } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

interface KeywordInputProps {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  className?: string;
}

export function KeywordInput({
  value,
  onChange,
  placeholder = "Add keyword...",
  className,
}: KeywordInputProps) {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addKeyword = (raw: string) => {
    const keyword = raw.trim().replace(/,$/, "").trim();
    if (!keyword) return;
    if (value.some((k) => k.toLowerCase() === keyword.toLowerCase())) return;
    onChange([...value, keyword]);
    setInputValue("");
  };

  const removeKeyword = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword(inputValue);
    } else if (e.key === "Backspace" && inputValue === "" && value.length > 0) {
      removeKeyword(value.length - 1);
    }
  };

  const handleBlur = () => {
    if (inputValue.trim()) {
      addKeyword(inputValue);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-wrap gap-1.5 items-center min-h-[38px] px-3 py-1.5 rounded-md border border-input bg-transparent shadow-sm transition-colors cursor-text",
        "focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
        className
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((keyword, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-md bg-primary/10 text-primary border border-primary/20 shrink-0"
        >
          {keyword}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              removeKeyword(i);
            }}
            aria-label={`Remove keyword ${keyword}`}
            className="flex items-center justify-center text-primary/70 hover:text-destructive transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={value.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[120px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
