import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Convert an internal agent name like "frontend_engineer#2" to "Frontend Engineer 2".
 */
export function displayAgentName(name: string): string {
  let suffix = "";
  const hashIdx = name.indexOf("#");
  if (hashIdx !== -1) {
    suffix = ` ${name.slice(hashIdx + 1)}`;
    name = name.slice(0, hashIdx);
  }
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") + suffix;
}
