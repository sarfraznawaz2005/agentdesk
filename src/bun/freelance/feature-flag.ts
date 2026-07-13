import { existsSync } from "node:fs";
import { dirname } from "node:path";

export function isFreelanceEnabled(): boolean {
  const candidates = [
    dirname(process.execPath),
    process.cwd(),
  ];
  return candidates.some((dir) => existsSync(`${dir}/freelance`));
}

// Auto-Earn (inbox + freelance-expert agent) used to be gated by a separate
// `autoearn` flag file; it now rides on the same `freelance` flag so there is
// only one flag to manage across Setup/portable updates and dev rebuilds.
export function isAutoEarnFeatureAvailable(): boolean {
  return isFreelanceEnabled();
}
