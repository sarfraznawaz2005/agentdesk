import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";

type AvatarSize = "sm" | "md" | "lg";

export interface AgentAvatarProps {
  name: string;
  color?: string; // hex color, e.g. "#6366f1" — auto-derived from name when omitted
  size?: AvatarSize;
  label?: string; // override the displayed initials (e.g. "PM")
}

const PALETTE = [
  "#6366f1", "#8b5cf6", "#a855f7", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#22c55e", "#14b8a6", "#06b6d4",
  "#3b82f6", "#0ea5e9",
];

function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** Strip 8-char hex instance-ID suffix added by the engine (e.g. "frontend_engineer-a1b2c3d4"). */
function stripInstanceId(name: string): string {
  return name.replace(/-[0-9a-f]{8}$/i, "");
}

/** "frontend_engineer" → "Frontend Engineer", "ui-ux-designer" → "Ui Ux Designer" */
function humanizeName(name: string): string {
  return stripInstanceId(name)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Derive up to 2-letter initials from a name or slug. */
function deriveInitials(name: string): string {
  const parts = stripInstanceId(name).split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
}

const SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
};

export function AgentAvatar({ name, color, size = "md", label }: AgentAvatarProps) {
  const bg = color ?? hashColor(stripInstanceId(name));
  const initial = label ?? deriveInitials(name);
  const tooltip = humanizeName(name);

  return (
    <Tip content={tooltip}>
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full shrink-0",
          "font-semibold text-white select-none",
          SIZE_CLASSES[size]
        )}
        style={{ backgroundColor: bg }}
        aria-label={name}
        role="img"
      >
        {initial}
      </span>
    </Tip>
  );
}
