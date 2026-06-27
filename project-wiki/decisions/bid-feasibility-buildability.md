---
title: Bid Feasibility = Pure Buildability
type: decision
status: verified
verified_at: 2026-06-27
sources:
  - src/bun/rpc/freelance-wizard.ts
  - src/bun/freelance/bid-pipeline.ts
tags: [freelance]
---

# Bid Feasibility = Pure Buildability

**The Auto-Earn workability verdict answers exactly one question: can the AI agent
system code 100% of what the job asks, on this machine, right now?** Everything a
human freelancer normally absorbs — a low or unstated budget, a vague spec, missing
credentials/API keys, deployment access, "5+ years experience" demands, talking to
the client — is deliberately excluded from the verdict. Those are negotiation and
human-handled concerns, not technical blockers, and treating them as blockers would
filter out perfectly buildable work.

## Key idea: two conditions, nothing else

A listing is `workable` only when **both** of these hold (the feasibility-analyst
system prompt at `src/bun/rpc/freelance-wizard.ts:574`):

- **Condition A — System check:** every runtime/tool/dependency the project needs is
  *confirmed installed* on the local dev box (`freelance-wizard.ts:580`). This is
  proven, not assumed — the analyst must call `environment_info` + `run_shell`
  version commands; anything not actively verified is treated as NOT installed
  ("fail safe", `freelance-wizard.ts:595`).
- **Condition B — AI capability:** the agent roster can fully deliver the technical
  requirements (`freelance-wizard.ts:581`). The prompt enumerates what the AI *can*
  do (software dev, automation, data, APIs, scraping, UI/UX, DB, testing, DevOps)
  and the narrow set it *cannot* (physical manufacturing, in-person services,
  regulated professional practice, niche physical-world tasks) at
  `freelance-wizard.ts:602-604`.

If either fails, the verdict is NOT WORKABLE (`freelance-wizard.ts:583`).

## Why the human-handled list is explicitly NOT a blocker

The prompt carries a dedicated "WHAT DOES NOT COUNT AS A BLOCKER" section
(`freelance-wizard.ts:606-611`) so the model does not reject buildable jobs for
non-technical reasons:

- **Client-supplied assets** — source code, design files, credentials, API keys, DB
  dumps, media: treated as *available* because the client provides them
  (`freelance-wizard.ts:608`).
- **Experience / portfolio** asks ("5+ years", "show past work") are proposal
  concerns, not technical blockers (`freelance-wizard.ts:609`).
- **Budget** — low or unspecified is a negotiation concern, never a technical one
  (`freelance-wizard.ts:610`).
- **Client communication** — asking for clarification or assets is normal
  freelancing, not a technical gap (`freelance-wizard.ts:611`).

The "writing" variant of the prompt (used when verification already ran the tool
calls) repeats the same exclusion list in one line at `freelance-wizard.ts:704`, so
the rule survives both code paths. Note that *deployment* and *seniority* fall under
the same logic: deployment is a DevOps task the AI can do given access, and seniority
is a portfolio/proposal matter — neither appears as a technical condition.

## How the verdict is produced (two-phase)

`analyzeListingWorkability` (`freelance-wizard.ts:819`) runs the analysis in two
phases so the buildability judgement is grounded in real system facts:

1. **Phase 1 — verify + analyse:** `generateText` with the wizard tool subset
   (`freelance-wizard.ts:180`) and `toolChoice: "auto"`. A `TOOL_DIRECTIVE`
   (`freelance-wizard.ts:677`) forces `environment_info` + per-runtime `run_shell`
   version checks before any prose. If the model skips the checks, they are forced
   (`freelance-wizard.ts:860`).
2. **Phase 2 — structured extraction:** a strict data-extractor pass turns the prose
   into JSON `{workable, confidence, coveragePercent, reason, blockers}`
   (`freelance-wizard.ts:910`), parsed by `extractJsonFromText`
   (`freelance-wizard.ts:784`) and normalised by `coerceVerdict`
   (`freelance-wizard.ts:743`). Tellingly, when the model omits the boolean,
   `coerceVerdict` derives `workable` from `coveragePercent >= 95`
   (`freelance-wizard.ts:749`) — the bar is essentially "100% buildable", matching
   the "code 100% of the ask" framing. The extractor is also told to list only
   *concrete missing tools or AI limitations* as blockers, never "incomplete
   analysis" (`freelance-wizard.ts:919`).

The verdict is persisted to `freelance_listings.wizard_verdict / wizard_reason /
wizard_blockers / wizard_analysis_text` (`freelance-wizard.ts:1225`).

## Gates that run *before* the buildability verdict (and why they are separate)

Two cheap deterministic gates short-circuit ahead of the AI feasibility analysis.
They are **not** part of the buildability judgement — they encode platform mechanics
and user policy, and they are recomputed live every run (so cached copies are treated
as stale via `isStaleGateVerdict`, `freelance-wizard.ts:132`):

- **Skill gate** (`skillGateBlocks`, `freelance-wizard.ts:149`): Freelancer.com only
  lets you bid when your profile shares ≥1 skill with the project. Zero overlap →
  blocked; unknown profile or no listed skills → **fail open** (`:153`, `:158`,
  `:162`). This is a platform mechanic, not buildability. See the
  [[freelance-discovery|skill gate]].
- **Client-quality gate** (`freelance-wizard.ts:415`+): filters on the user's own
  Client Quality settings. Policy, not technical feasibility.

Keeping these separate from the buildability verdict is the whole point: the verdict
stays a pure "can we build it" signal, and orthogonal concerns (platform rules, user
filters) are layered as their own gates.

## Where the bid actually gets drafted

`bid-pipeline.ts` is downstream of the verdict — it drafts the proposal for a listing
already deemed workable. `draftBidForListing` (`bid-pipeline.ts:123`) fetches the full
listing description (`ensureFullDescription`, `bid-pipeline.ts:139`), writes the
proposal with a winning-bid system prompt (`buildProposalSystem`,
`bid-pipeline.ts:24`), runs a QA revise pass and a draft-time near-duplicate guard
(`bid-pipeline.ts:151-167`), then enqueues a `bid` draft to `freelance_outbox`
(`bid-pipeline.ts:178`). Note: the pipeline itself does **no** budget/credential/
seniority checking — consistent with this decision, those never gate a bid. The
send-time [[freelance-autoearn|behavior governor]] (caps, dedup, pacing) is the backstop.

## Key files

| File | Role |
|---|---|
| `src/bun/rpc/freelance-wizard.ts` | Feasibility-analyst prompts + two-phase verdict + skill/client gates — the decision lives here |
| `src/bun/freelance/bid-pipeline.ts` | Drafts the proposal for an already-workable listing; no feasibility re-check |

## Gotchas / Constraints

- **Condition A is verified, not guessed.** A buildable job can still come back NOT
  WORKABLE purely because a required runtime is missing locally — the verdict is
  machine-specific, not absolute. Installing the toolchain flips it.
- **`workable` collapses to a near-100% coverage threshold** when the model omits the
  boolean (`coverage >= 95`, `freelance-wizard.ts:749`). Partial-coverage jobs are
  rejected by design.
- **Don't add budget/seniority/deployment as blockers.** It directly contradicts the
  prompt's exclusion list and would silently shrink the workable pool.
- The skill gate **fails open** on unknown profile skills — a returned `null` means
  "not blocked", not "blocked".

## Related
- [[freelance-discovery]]
- [[freelance-autoearn]]

## Open questions
- The "writing" prompt (`buildAnalysisWritePrompt`, `freelance-wizard.ts:693`) and
  the heuristic fallback when verdict JSON fails to parse (`freelance-wizard.ts:930`)
  use a more conservative explicit-`workable=true` check — worth confirming these
  edge paths can't disagree with the structured verdict on the same listing.
