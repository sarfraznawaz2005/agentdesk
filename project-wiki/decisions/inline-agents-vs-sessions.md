---
title: Inline Agents vs Persistent Sessions
type: decision
status: verified
verified_at: 2026-07-04
sources:
  - docs/agent-sessions-proposal.md
  - src/bun/db/migrations/v3_agent-sessions.ts
  - src/bun/db/migrations/v4_inline-agents.ts
  - src/bun/agents/agent-loop.ts
  - src/bun/agents/handoff.ts
tags: [architecture, agents]
---

# Inline Agents vs Persistent Sessions

**The decision:** AgentDesk briefly shipped *persistent agent sessions* (v3) —
per-agent-type conversation history stored in SQLite so a re-dispatched agent
"remembered" its prior work — then **reversed it in v4** in favor of *inline
sub-agent execution*, where every agent invocation is stateless, gets a fresh
context (system prompt + one task message), and its tool calls stream directly
into the main conversation as `message_parts`. The single most important thing
to understand: **continuity is now carried by the filesystem and an explicit
handoff summary, not by replaying an agent's own past transcript.**

## The problem sessions were trying to solve

Every sub-agent dispatch was, and still is, stateless: the agent receives exactly
one user message (the task) and has no memory across invocations. The
[`docs/agent-sessions-proposal.md`](../../docs/agent-sessions-proposal.md) ADR
(see its "Problem Statement", `agent-sessions-proposal.md:48`) argued this wastes
tokens on re-discovery during review-fix cycles and loses design rationale between
invocations of the same agent type. Its fix was to key a session on
`(conversation_id, agent_name)` and prepend the agent's prior messages on
re-dispatch.

## What v3 built, what v4 dropped

v3 created two tables plus a column via raw SQL:

- `agent_sessions` (`v3_agent-sessions.ts:13-23`) — one row per
  `(conversation_id, agent_name)`, with a `total_tokens` counter feeding a ~40k
  summarization trigger.
- `agent_session_messages` (`v3_agent-sessions.ts:26-36`) — the replayable
  transcript (role/content/metadata/token_count).
- `agent_task_results.files_modified` column (`v3_agent-sessions.ts:7-10`).

v4 reverses all of it. `v4_inline-agents.ts:39-42` drops
`agent_session_messages`, `agent_sessions`, **and** `agent_task_results`
(children-first for FK safety). In the same migration it introduces the
replacement substrate: the `message_parts` table (`v4_inline-agents.ts:7-22`) and
a `messages.agent_name` column (`v4_inline-agents.ts:35-37`) so a sub-agent's
output is rendered inline under its own identity. The proposal doc itself is now
stamped **SUPERSEDED** at its top (`agent-sessions-proposal.md:3-19`).

## Why the reversal — the rationale grep can't show

The header note records the verdict bluntly: *"The inline model proved simpler
and more reliable than session-based continuity"* (`agent-sessions-proposal.md:8`).
Concretely:

1. **The filesystem is already the source of truth.** The proposal admits this is
   not a correctness bug (`agent-sessions-proposal.md:73-82`) — re-reading files
   on re-dispatch always produces *correct* results. Sessions optimized only
   token cost and "coherence," at the price of a whole stateful subsystem
   (load/save/summarize/lock, concurrent-session branching like
   `frontend_engineer#2`, cascade-delete on conversation removal).
2. **Replaying a stale transcript is a liability.** A persisted transcript can
   describe files that were since edited by the reviewer, another agent, or the
   human — so the agent reasons from outdated context. Reading the file fresh
   cannot drift.
3. **Visibility.** Inline parts make the sub-agent's every tool call and text
   chunk visible in the chat (see the executor docstring,
   `agent-loop.ts:1-10`), instead of being buried in an opaque side-table the UI
   never rendered.
4. **A refactor footgun was hit.** The session refactor accidentally dropped the
   `run_agent` hallucination safeguard and it had to be re-added
   (`agent-sessions-proposal.md:633-648`) — evidence the session machinery added
   surface area without proportional benefit.

## How the inline model works instead

The executor is [[agent-engine#run_agent|`runInlineAgent`]] in
`agent-loop.ts:801`. The context it builds is deliberately minimal
(`agent-loop.ts:1065-1068`):

```ts
const agentMessages: ModelMessage[] = [
  ...(opts.priorMessages ?? []),
  { role: "user" as const, content: task },
];
```

`priorMessages` is **not** a revived session — it is an opt-in escape hatch used
only by the Playground, which keeps its own history in a JSON file
(`agent-loop.ts:160-165`); the PM/kanban/review paths never pass it, so a normal
sub-agent run is exactly `[ { role: "user", content: task } ]`. There is no
iteration cap; the agent runs a `generateText` loop with progressive compaction
until done or context-full.

Cross-invocation continuity, where it matters, is reconstructed *explicitly*
rather than replayed:

- **Handoff summaries** ([[agent-engine|handoff]], `handoff.ts:14`) read the files an agent
  actually modified and emit a `## Prior Work` block prepended to the next
  sequential task — deterministic for small diffs (≤3 files, <200 lines each,
  `handoff.ts:39-40`), AI-summarized for large ones. This passes forward *what
  changed on disk*, which can't go stale, instead of an agent's recollection.
- **Fresh reads.** Because each agent starts blank, a review-fix re-dispatch
  simply reads the current files — guaranteeing it sees the post-review state.

## Key files

| File | Role |
|---|---|
| `docs/agent-sessions-proposal.md` | The original v3 ADR, now stamped SUPERSEDED — the full rationale for both directions |
| `src/bun/db/migrations/v3_agent-sessions.ts` | Created `agent_sessions` / `agent_session_messages` + `files_modified` column |
| `src/bun/db/migrations/v4_inline-agents.ts` | Dropped all session/task-result tables; added `message_parts` + `messages.agent_name` |
| `src/bun/agents/agent-loop.ts` | `runInlineAgent` — fresh-context executor; builds `[task]` message array, streams parts |
| `src/bun/agents/handoff.ts` | Replacement for session continuity — file-derived `## Prior Work` summaries |

## Gotchas / Constraints

- **`agent_sessions`, `agent_session_messages`, and `agent_task_results` no longer
  exist.** Don't write code (or wiki pages) referencing them — they were dropped
  in v4. `CLAUDE.md` notes the same. Existing users upgrade through v4, so the
  drop must stay idempotent (`DROP TABLE IF EXISTS`).
- **`priorMessages` is Playground-only.** Reusing it to fake "session memory" for
  PM-orchestrated agents reintroduces the exact stale-transcript problem v4
  removed. The default sub-agent context is one task message — keep it that way.
- **Continuity = handoff + disk, never replay.** If an agent seems to "forget,"
  the fix is a better handoff summary or letting it re-read files, not resurrecting
  sessions.
- **The `run_agent` hallucination safeguard is independent of all this** and must
  survive any PM-loop refactor (`agent-sessions-proposal.md:633-648`).

## Related
- [[agent-engine]]
- [[kanban-review-cycle]]
- [[database]]

## Open questions
- The v3 proposal's token-economics table (`agent-sessions-proposal.md:510-536`)
  claimed sessions saved ~17k tokens per 2-round fix cycle. No post-v4 measurement
  exists confirming the inline model's actual re-read cost in practice.
