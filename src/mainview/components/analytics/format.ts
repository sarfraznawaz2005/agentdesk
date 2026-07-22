/** Compact number for axis/summary labels: 950 → "950", 239400 → "239.4k", 10562300 → "10.6M", 3.2e9 → "3.2B". */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return `${n}`;
  const [value, suffix] =
    abs < 1_000_000
      ? [n / 1000, "k"]
      : abs < 1_000_000_000
        ? [n / 1_000_000, "M"]
        : [n / 1_000_000_000, "B"];
  const rounded = value.toFixed(1);
  return `${rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded}${suffix}`;
}
