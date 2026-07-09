---
title: Plan -> Approve -> Execute Flow
type: flow
status: verified
verified_at: 2026-07-09
sources:
  - src/bun/agents/tools/pm-tools.ts
  - src/bun/agents/engine.ts
  - src/bun/agents/tools/planning.ts
  - src/bun/engine-manager.ts
  - src/shared/rpc/webview.ts
  - docs/workflow.md
tags: [agents, workflow]
---

# Plan -> Approve -> Execute Flow

**The single human-in-the-loop lifecycle.** AgentDesk's motto is "99% agent-driven —
humans approve, deploy, and communicate." This flow is *where* that one human approval
happens. The PM plans (via the `task-planner`), shows a plan card, **stops** and waits
for the user, then on approval deterministically materialises kanban tasks and dispatches
write-agents one at a time. The key idea: **task definitions are produced once during
planning and replayed verbatim at execution** — the LLM is never trusted to re-emit the
task list, because it truncates. See [[agent-engine]] for the PM streaming loop and
[[agent-tools]] for the tool registry.

## Why it is shaped this way

Three design forces drive the whole flow:

1. **The plan card must be the real plan doc, not a PM paraphrase.** `request_plan_approval`
   ignores its own `summary` arg when a plan note exists and uses the most-recent Docs note
   instead (`pm-tools.ts:1633-1635`). The PM tends to summarise lossily; the task-planner's
   `create_doc` output is the source of truth the user expects to see.
2. **The LLM cannot be trusted to re-list tasks.** `create_tasks_from_plan` never re-runs
   the planner — it drains the structured definitions the planner already stored via
   `define_tasks` (`pm-tools.ts:1752`, `planning.ts`). A second inline planning run reliably
   truncates the list.
3. **The PM turn must end while waiting for a human.** Approval is not a tool that blocks; it
   is the boundary of a PM turn. Every approval-presenting path calls
   `deps.stopPMStream?.()` (`pm-tools.ts:1658,1713`) which flips `planApprovalRequested` in
   the engine (`engine.ts:398`), breaking the PM stream loop (`engine.ts:729`). The PM only
   resumes when the *user* sends the next message.

## How it works

```mermaid
sequenceDiagram
    actor User
    participant PM as PM (engine.ts loop)
    participant TP as task-planner (inline)
    participant Tools as pm-tools.ts
    participant DB as SQLite
    participant Web as Webview

    User->>PM: "build feature X"
    PM->>Tools: run_agent("task-planner", ...)
    Tools->>TP: runInlineAgent (fresh context)
    TP->>DB: create_doc (plan) + define_tasks (stored in-memory)
    TP-->>Tools: completed
    Note over Tools: .then() handler (pm-tools.ts:700)
    Tools->>DB: persist plan message (role=assistant, agentId=task-planner)
    Tools->>Web: broadcast planPresented -> amber plan card
    Tools-->>PM: return (NO onAgentDone) — PM stays idle (pm-tools.ts:781)
    User->>PM: "approve"
    PM->>Tools: set_feature_branch()  (AI-names feature/<slug>)
    Tools->>DB: saveSetting currentFeatureBranch:<projectId>
    PM->>Tools: create_tasks_from_plan()
    Tools->>DB: drainTaskDefinitions -> createKanbanTask x N (column=backlog)
    PM->>Tools: run_agent(agent, kanban_task_id) — sequential
    Tools->>DB: task -> working ; runInlineAgent
```

### 1. Plan
The PM dispatches the read-only `task-planner` via `run_agent` (`pm-tools.ts:254`). The
planner runs **inline** in the main conversation with a fresh context (system prompt + task
only — it does not see the PM's history). It writes a plan document (`create_doc`) and emits
structured task definitions via `define_tasks`, which are buffered in-memory keyed by project
in `planning.ts` (`drainTaskDefinitions` / `peekTaskDefinitions`).

### 2. Present the plan card (the critical hand-off)
There are **two** ways the approval card appears, and the code-level path is the reliable one:

- **PM-driven:** the PM calls `request_plan_approval` (`pm-tools.ts:1615`). In-app it persists
  a `type:"plan"` message and broadcasts `planPresented` (`pm-tools.ts:1706`); for
  `channel:` conversations it instead chunks the plan into a WhatsApp/Discord/Email message
  (`pm-tools.ts:1652`). Either way it calls `stopPMStream`.
- **Code-enforced:** because the Vercel AI SDK runs parallel tool calls via `Promise.all`,
  the PM may fire `request_plan_approval` *while* the task-planner is still running — that early
  call is rejected (`pm-tools.ts:1676-1682`). The card is instead shown deterministically inside the
  `run_agent` completion handler when `agent === "task-planner"` and there are pending defs
  (`pm-tools.ts:700-781`). This guarantees the card appears even if the PM forgets to ask, and
  prevents the PM from rendering "approval" as plain chat text.

A guard at `pm-tools.ts:712-717` suppresses the card if any non-`done` kanban task already exists
(plan was already approved) so a stray re-plan can't interrupt in-progress work.

Both paths also fire a desktop notification when the app window isn't focused
(`isAppFocused()`, exported from `engine-manager.ts`), gated by the
`plan_approval_notification` setting (default enabled) — mirroring the
existing shell-approval notification pattern. This is a new addition: plan
approval previously had no desktop notification at all, so a plan waiting for
approval in a background/minimised project gave zero out-of-app signal. See
[[notifications]].

**A real pre-existing bug was found and fixed while adding that notification**:
both `broadcastToWebview("planPresented", …)` call sites in `pm-tools.ts` used
a name that does **not** match the actual schema entry — `presentPlan`
(`src/shared/rpc/webview.ts`). Because `broadcastToWebview` resolves `method`
as a bare string against Electrobun's generated RPC object
(`mainWindowRef.webview.rpc.send[method]?.(…)`), the mismatched name silently
no-op'd — this broadcast had never actually reached the frontend. Both call
sites are now fixed to `"presentPlan"` (`pm-tools.ts:753,1709`). See
[[broadcast-method-name-mismatch]] for the general footgun this is an instance
of.

Crucially, the task-planner completion handler **returns without calling `onAgentDone`**
(`pm-tools.ts:781`) — it only inserts an assistant "context" message recording the plan
note_id. Calling `onAgentDone` would immediately restart the PM and (in production) trigger a
*second* task-planner dispatch before the user even sees the card.

### 3. Approve
Approval is **not** a special API — it is the user's next chat message restarting the PM. The
engine has a "soft approval gate" comment (`engine.ts:176`) and `docs/workflow.md:276`
describes an instant keyword check (`approve`/`yes`/`lgtm` ...), but in the current code the
message simply re-enters `_runPMProcessing` and the PM — which now has the plan context message
in its history — recognises the approval and proceeds. (See Gotchas: the keyword fast-path and
`skip_approval` in the docs are stale relative to this code.)

### 4. Set feature branch
Before dispatching write-agents, the PM calls `set_feature_branch` (`pm-tools.ts:2706`). It
reads the last 5 user messages, asks the LLM for a `feature/<slug>` name, collects existing
branch + PR source-branch names to avoid collisions (`pm-tools.ts:2734-2742`), validates the format,
and persists it to `settings` under `currentFeatureBranch:<projectId>` (category `git`,
`pm-tools.ts:2777`). `autoCommitTask` in [[agent-engine]]'s review cycle later checks out / creates
this branch before committing. `clear_feature_branch` wipes it after the PR (`pm-tools.ts:2785`).

### 5. Create tasks (deterministic)
`create_tasks_from_plan` (`pm-tools.ts:1726`) drains the stored definitions and creates one
kanban task per def in the `backlog` column, resolving each def's `blocked_by` *indices* into
real task IDs by position (`pm-tools.ts:1765-1767`). No LLM runs here — it is a pure replay.
It also calls `recordPlanBatch(projectId, createdIds)` (`tools/planning.ts`) — an in-memory
record of exactly which task IDs this plan produced, consumed later by the review cycle to
generate a Final Recap doc once every task in the batch reaches `done`. See
[[kanban-review-cycle]]'s *Plan completion recap* section.

### 6. Execute (sequential)
The PM dispatches agents via `run_agent` with `kanban_task_id`. A re-entrancy guard enforces
**one write-agent at a time** (`writeAgentRunning`, `pm-tools.ts:385`) plus a `dispatchingAgents`
set to defeat duplicate parallel dispatches from a single LLM step (`pm-tools.ts:346-364`).
Read-only agents bypass this. The task auto-moves `working -> review` on completion only if
`verify_implementation` passed (`pm-tools.ts:653`); otherwise it stays in `working` with a
warning appended to the result. `get_next_task` (`pm-tools.ts:1795`) picks the next unblocked
backlog task in plan order so execution respects dependencies.

Auto-continuation to the *next* backlog task is gated by the per-project **auto-execute**
toggle: when a task completes and the engine's next-action hint would be `DISPATCH`, it first
checks `isAutoExecuteEnabled` (`engine.ts:481-484`) and, when the toggle is off, swaps the hint
for `PAUSED` — the PM reports the finished task but waits for the user to say "continue"
instead of dispatching the next one. Only the DISPATCH decision is gated; review/wait/done
hints are untouched.

## Key files
| File | Role |
|---|---|
| `src/bun/agents/tools/pm-tools.ts` | All four flow tools: `request_plan_approval`, `create_tasks_from_plan`, `set_feature_branch`, `run_agent` + the task-planner completion handler that force-shows the card |
| `src/bun/agents/tools/planning.ts` | `define_tasks` buffer — `drainTaskDefinitions` / `peekTaskDefinitions` (planning-time defs replayed at create time) |
| `src/bun/agents/engine.ts` | PM streaming loop; `stopPMStream` -> `planApprovalRequested` breaks the loop and ends the turn (`engine.ts:398,729`) |
| `docs/workflow.md` | Canonical narrative (partly stale — see Gotchas) |

## Gotchas / Constraints
- **Don't `onAgentDone` after task-planner.** The completion handler deliberately returns early
  (`pm-tools.ts:781`) so the PM does not restart and re-plan before the user sees the card.
- **`request_plan_approval`'s `summary` arg is usually discarded.** The card content is the most
  recent Docs note, not the PM's summary (`pm-tools.ts:1633-1635`); summary is only a fallback.
- **Task definitions are in-memory, not in the DB.** They live in `planning.ts`'s buffer. An app
  restart between planning and approval loses them — `create_tasks_from_plan` then errors with
  "No task definitions found" (`pm-tools.ts:1754`).
- **Docs drift:** `docs/workflow.md` references a `skip_approval` arg and a WorkflowEngine state
  machine (`awaiting_approval`/`executing`) and an instant keyword gate. The current code has
  **no WorkflowEngine** and no `skip_approval` on `request_plan_approval` — the PM is the sole
  orchestrator and approval is just the next user message. Treat the workflow.md state-machine
  language as historical.
- **Channel vs in-app branch everywhere.** `conversationId.startsWith("channel:")` toggles
  card-as-chunked-message vs `planPresented`, and forces an explicit `project_id` on
  `run_agent` / `create_tasks_from_plan` (`pm-tools.ts:311,1738`).

## Related
- [[agent-engine]]
- [[agent-tools]]
- [[kanban-review-cycle]]
- [[notifications]] — the plan-approval desktop notification
- [[broadcast-method-name-mismatch]] — the `presentPlan`/`planPresented` naming bug fixed alongside the notification

## Open questions
- Is the engine's "soft approval gate" keyword fast-path (the comment at `engine.ts:176`) still
  wired anywhere, or fully superseded by the PM reading the plan context message? The code under
  that comment only kicks off `_runPMProcessing`; no keyword branch was found.
- ~~Where exactly does `autoCommitTask` consume `currentFeatureBranch:<projectId>`?~~ Resolved:
  `review-cycle.ts:396` — documented in [[feature-branch-workflow]].
