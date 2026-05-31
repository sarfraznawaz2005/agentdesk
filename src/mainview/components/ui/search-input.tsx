import * as React from "react"
import { Search, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

function SearchInput({
  value,
  onChange,
  placeholder = "Search...",
  className,
}: SearchInputProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)

  function handleClear() {
    onChange("")
    inputRef.current?.focus()
  }

  return (
    <div className={cn("relative flex items-center", className)}>
      <Search
        className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8 pr-8"
      />
      {value.length > 0 && (
        <button
          type="button"
          onClick={handleClear}
          aria-label="Clear search"
          className="absolute right-2 flex items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export { SearchInput }
export type { SearchInputProps }
