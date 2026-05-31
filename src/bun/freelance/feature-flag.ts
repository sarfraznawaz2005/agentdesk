import { existsSync } from "node:fs";
import { dirname } from "node:path";

export function isFreelanceEnabled(): boolean {
  const candidates = [
    dirname(process.execPath),
    process.cwd(),
  ];
  return candidates.some((dir) => existsSync(`${dir}/freelance`));
}
