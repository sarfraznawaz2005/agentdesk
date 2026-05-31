import { cn } from "@/lib/utils";

type Status = "active" | "idle" | "paused" | "completed" | "archived" | "deleted";
type Size = "sm" | "md";

interface StatusBadgeProps {
  status: Status;
  label?: string;
  size?: Size;
}

const STATUS_STYLES: Record<Status, { dot: string; text: string }> = {
  active: {
    dot: "bg-green-500",
    text: "text-green-700",
  },
  idle: {
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
  },
  paused: {
    dot: "bg-amber-400",
    text: "text-amber-700 dark:text-amber-400",
  },
  archived: {
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
  },
  completed: {
    dot: "bg-blue-500",
    text: "text-blue-700",
  },
  deleted: {
    dot: "bg-red-400/60",
    text: "text-muted-foreground/70",
  },
};

const DOT_SIZE: Record<Size, string> = {
  sm: "h-1.5 w-1.5",
  md: "h-2 w-2",
};

const TEXT_SIZE: Record<Size, string> = {
  sm: "text-xs",
  md: "text-sm",
};

export function StatusBadge({
  status,
  label,
  size = "md",
}: StatusBadgeProps) {
  const styles = STATUS_STYLES[status];
  const displayLabel = label ?? status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <span
      className="inline-flex items-center gap-1.5"
      role="status"
      aria-label={`Status: ${displayLabel}`}
    >
      <span
        className={cn(
          "rounded-full shrink-0",
          styles.dot,
          DOT_SIZE[size]
        )}
        aria-hidden="true"
      />
      <span className={cn("font-medium", styles.text, TEXT_SIZE[size])}>
        {displayLabel}
      </span>
    </span>
  );
}
