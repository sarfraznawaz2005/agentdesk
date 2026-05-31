import * as React from "react"

import { cn } from "@/lib/utils"

interface KbdProps {
  keys: string[]
  className?: string
}

function Kbd({ keys, className }: KbdProps) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((key, index) => (
        <React.Fragment key={index}>
          {index > 0 && (
            <span className="select-none px-0.5 text-xs text-muted-foreground">
              +
            </span>
          )}
          <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[11px] font-medium text-muted-foreground shadow-sm">
            {key}
          </kbd>
        </React.Fragment>
      ))}
    </span>
  )
}

export { Kbd }
export type { KbdProps }
