import type { FreelanceBlockKind } from "../../../shared/rpc/freelance";

// One-word reason for a failed (non-green) verdict, keyed by the verdict's
// canonical origin (wizard_block_kind). Shared by the listing card pill and the
// Find Workable modal so the wording stays identical across both surfaces.
export const BLOCK_KIND_LABEL: Record<FreelanceBlockKind, string> = {
  skill_gate: "Missing Skills",
  client_quality: "Client Filter",
  non_software: "In-Person Work",
  analysis: "Not Workable",
};

// The text shown on the pill — a workable verdict reads "Workable"; a fail reads
// its origin word.
export function pillLabel(
  verdict: "workable" | "not_workable",
  blockKind: FreelanceBlockKind | null,
): string {
  if (verdict === "workable") return "Workable";
  return blockKind ? BLOCK_KIND_LABEL[blockKind] : "Not Workable";
}

// The first three kinds are deterministic pre-filters (your rules / a keyword)
// rather than the AI's judgment — used to pick the pill icon.
export function isFilterBlockKind(kind: FreelanceBlockKind | null): boolean {
  return kind === "skill_gate" || kind === "client_quality" || kind === "non_software";
}

// Color family for a verdict. Each surface maps the tone to its own class
// strings; only the tone *decision* lives here. `client_quality` gets its own
// tone (a client-preference filter, not a capability issue), distinct from the
// amber skill/keyword filters.
export type PillTone = "green" | "amber" | "sky" | "red";

export function pillTone(
  verdict: "workable" | "not_workable",
  blockKind: FreelanceBlockKind | null,
  filtered: boolean,
): PillTone {
  if (verdict === "workable") return "green";
  if (blockKind === "client_quality") return "sky";
  if (blockKind === "skill_gate") return "amber";
  // non_software is a hard "agents can't do this work at all" exclusion → red,
  // same as an AI feasibility fail; skill_gate stays amber (account-state, fixable).
  if (blockKind === "non_software" || blockKind === "analysis") return "red";
  // Legacy rows (blockKind null): fall back to the old amber-vs-red filtered split.
  return filtered ? "amber" : "red";
}
