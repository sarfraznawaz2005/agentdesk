import { cn } from "@/lib/utils";

// Deterministic gradient palette for project avatars — full static class
// strings so Tailwind keeps them. The same project always gets the same colors.
const CARD_GRADIENTS = [
  "from-sky-500 to-blue-600",
  "from-violet-500 to-purple-600",
  "from-emerald-500 to-teal-600",
  "from-amber-500 to-orange-600",
  "from-rose-500 to-pink-600",
  "from-cyan-500 to-sky-600",
  "from-fuchsia-500 to-purple-600",
  "from-indigo-500 to-blue-600",
];

/** Pick a stable gradient for a project from a seed (prefer the immutable id). */
export function projectGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return CARD_GRADIENTS[Math.abs(hash) % CARD_GRADIENTS.length];
}

interface ProjectAvatarProps {
  /** Stable seed for the gradient — pass the project id when available. */
  id?: string;
  name: string;
  /** Size/spacing overrides; twMerge lets these win over the defaults. */
  className?: string;
}

/** Gradient initial-letter badge giving each project a visual identity. */
export function ProjectAvatar({ id, name, className }: ProjectAvatarProps) {
  const gradient = projectGradient(id || name);
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <div
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br text-[11px] font-bold text-white shadow-sm",
        gradient,
        className,
      )}
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}
