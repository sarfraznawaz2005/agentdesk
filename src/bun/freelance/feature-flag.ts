import { existsSync } from "node:fs";
import { dirname } from "node:path";

export function isFreelanceEnabled(): boolean {
  const candidates = [
    dirname(process.execPath),
    process.cwd(),
  ];
  return candidates.some((dir) => existsSync(`${dir}/freelance`));
}

// Auto-Earn (inbox + freelance-expert agent) is gated by a separate `autoearn`
// flag file next to the exe (or cwd) — same mechanism as `freelance`, so it is
// preserved across app updates (the updater patches the binary in place and does
// not remove sibling flag files). Without this file the Auto-Earn settings, tabs,
// and background agent are completely unavailable.
export function isAutoEarnFeatureAvailable(): boolean {
  const candidates = [
    dirname(process.execPath),
    process.cwd(),
  ];
  return candidates.some((dir) => existsSync(`${dir}/autoearn`));
}
