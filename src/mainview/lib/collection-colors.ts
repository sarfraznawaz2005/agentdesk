// Fixed named color palette for collection color-coding (matches the approved
// Collections mockup's swatch set). The `name` is what's persisted in
// collections.color — Tailwind classes are derived here, not stored.
export const COLLECTION_COLORS = [
  { name: "slate", dot: "bg-slate-400" },
  { name: "indigo", dot: "bg-indigo-500" },
  { name: "sky", dot: "bg-sky-500" },
  { name: "emerald", dot: "bg-emerald-500" },
  { name: "amber", dot: "bg-amber-500" },
  { name: "rose", dot: "bg-rose-500" },
] as const;

export function collectionDotClass(color: string): string {
  return COLLECTION_COLORS.find((c) => c.name === color)?.dot ?? "bg-slate-400";
}
