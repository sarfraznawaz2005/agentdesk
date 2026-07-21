# AgentDesk — Workflow Architecture

This document describes the end-to-end workflow that governs how AgentDesk
processes human requests, plans work, obtains approval, dispatches agents, and
delivers results. It is the single source of truth for both human contributors
and AI agents working on this codebase.

---

## Table of Contents

1. [Overview](#overview)
2. [Core Principles](#core-principles)
3. [Conversation & Project Scope](#conversation--project-scope)
4. [Message Flow](#message-flow)
5. [Scenarios](#scenarios)
6. [Planning Phase](#planning-phase)
7. [Approval Gate](#approval-gate)
8. [Kanban Creation (Post-Approval)](#kanban-creation-post-approval)
9. [Execution Phase](#execution-phase)
10. [Completion](#completion)
11. [Agent Failure Handling](#agent-failure-handling)
12. [Two-Way Channel Sync](#two-way-channel-sync)
13. [State Machine Reference](#state-machine-reference)
14. [Tool Reference](#tool-reference)
15. [Key Files](#key-files)

---

## Overview

AgentDesk is an AI-powered development platform where a **Project Manager (PM)**
agent orchestrates a team of specialised sub-agents. The human interacts with the
PM via the in-app chat or external channels (Discord, WhatsApp, Email). The PM
plans work, presents it for approval, then autonomously drives execution through
planning, approval, agent dispatch, code review, and completion phases.

The motto: **99% of work is done automatically once the human approves the plan.**

> **Note**: The PM is the sole orchestrator. There is no separate WorkflowEngine state machine. References to "WorkflowEngine" in this document should be understood as "the PM's workflow logic" — not a separate class. The PM is the sole
> orchestrator. Workflow state (plan pending, tasks in flight, etc.) is tracked
> directly in the PM's conversation context and the kanban board.

### High-Level Flow

```
Human request
  -> PM analyses and runs task-planner inline (run_agent)
  -> task-planner creates plan note (Docs tab) + structured task definitions
  -> PM presents plan for approval (chat message in-app / chunked message on channels)
  -> Human approves
  -> Deterministic kanban task creation from stored definitions
  -> PM runs worker agents inline via run_agent / run_agents_parallel
  -> Agent tool calls visible as message parts in the main chat
  -> Conversation auto-compacts between tasks (tool result pruning)
  -> PM verifies task completion, moves tasks to done
  -> PM delivers completion summary
```

---

## Core Principles

1. **Single approval touchpoint.** The human reviews and approves the plan once.
   Everything after approval is autonomous.

2. **Kanban tasks are created AFTER approval, never before.** The plan note is
   the pre-approval artifact (communication). Kanban tasks are the post-approval
   artifact (execution). A hard gate separates them.

3. **Source-aware approval.** In-app and channels both use chat-based approval.
   There is no deterministic pre-LLM keyword gate — `AgentEngine.sendMessage()`
   forwards the reply to the PM, and the PM LLM interprets approval intent from
   the message (with the pending plan in its context).

4. **Two-way visibility.** Every PM response goes to the app webview AND all
   connected channels. Every channel message is visible in-app as a conversation.
   Full audit trail regardless of where work was initiated.

5. **One active PM turn per conversation, not per project.** A conversation
   whose PM turn (or dispatched agents) is still running queues a same-conversation
   message rather than dropping or blocking it; a message sent to a *different*
   conversation — same project or another one — is never queued or blocked by
   that activity. See [Conversation & Project Scope](#conversation--project-scope).

6. **PM tracks execution via kanban.** After plan approval, the PM creates kanban
   tasks and dispatches agents. Task column state is the shared source of truth.
   Conversation auto-compacts between tasks; the kanban board always reflects
   actual progress.

7. **Agents move tasks to "review", never to "done".** Each worker agent calls
   `move_task(taskId, "working")` at start and `move_task(taskId, "review")`
   when finished. The **review-cycle** (via `submit_review`) is the only path
   to "done" — it runs automatically when any task enters the review column.

8. **Inline agent execution.** Sub-agents run inline in the main conversation
   via PM tools `run_agent` / `run_agents_parallel`. Each agent gets a fresh
   context (system prompt + task description only, no parent history) and its
   tool calls are visible as message parts in the chat. This replaces the old
   hidden background sub-agent model.

---

## Conversation & Project Scope

`EngineManager` still creates and caches exactly one `AgentEngine` per project
(`src/bun/engine-manager.ts`). What changed is what happens *inside* that one
engine: it used to treat "the PM" as one project-wide singleton turn — only
one conversation in a project could have an active PM stream at a time, and
"which agents are running" / "is the PM busy" were both answered project-wide.
That made a second conversation in the same project (or a stale conversation
elsewhere in the same project) able to block, confuse, or falsely report on a
conversation that had nothing to do with it. The engine now tracks PM turns
**per conversation**, so every conversation — in any project, opened at the
same time as any other — runs its own independent PM turn and sees only its
own state.

### What's conversation-scoped

- **Whether the PM is currently streaming.** `AgentEngine` keys its abort
  controllers by conversation (`pmAbortByConv: Map<conversationId, AbortController>`).
  `isProcessing(conversationId)` checks one conversation; called with no argument
  it reports whether *any* conversation in the project is busy (used only by the
  legitimate project-wide checks below).
- **Which sub-agents are running "here".** Every dispatched agent is registered
  with the conversation that dispatched it (`registerAgentController(projectId,
  controller, agentName, conversationId)`). `getRunningAgentNamesForConversation(projectId,
  conversationId)` filters to just that conversation; `getRunningAgentNames(projectId)` /
  `getAllRunningAgents()` are the project-wide/system-wide equivalents — see the
  PM tool table below for which one to call for a given question.
- **Duplicate-dispatch rejection.** `run_agent` and `request_plan_approval`'s
  task-planner guard both check `getRunningAgentNamesForConversation` — a
  code-explorer already running in conversation A no longer blocks dispatching
  one in conversation B, only a second one inside A itself.
- **The message queue.** Typing a new message while *that same conversation's*
  PM/agents are still busy queues it (`message-queue-manager.ts`, max 3 per
  conversation); it auto-drains the moment that conversation goes idle. A
  message sent to a different, idle conversation is never queued — it starts
  a new PM turn immediately, concurrently with whatever conversation A is
  still doing. There is no cross-conversation queue or fallback drain; a
  conversation's queue is only ever touched by that conversation going idle.
- **The Stop button.** `stopGeneration` calls `engine.stopAll(conversationId)`,
  which aborts only that conversation's PM stream and its dispatched agents
  (`abortAgentsForConversation(projectId, conversationId)`) — sibling
  conversations, review-cycle agents, scheduler runs, and issue-fixer runs in
  the same project are untouched.

### What's intentionally project-wide (not a bug)

- **Write-agent serialization.** Only one write agent may run at a time **per
  project**, regardless of which conversation dispatched it — enforced by a
  closure-scoped `writeAgentRunning` flag plus a `getRunningAgentCount(projectId)
  > 0` check in `run_agent`. This is deliberate, not a scoping gap: write agents
  share one git working tree per project, so two write agents editing/committing
  concurrently — even from two different conversations — would corrupt it. A
  rejected dispatch here now returns a real explanatory PM message instead of
  silently truncating the turn (see the `stopPMStream` note below).
- **review-cycle's auto-review gate**, **dashboard/health status**, and
  **idle-engine eviction** all read project-wide state on purpose
  (`isProcessing()` with no argument, `getRunningAgentCount`,
  `getSystemActivity`) — these are "is this project busy at all" checks, not
  "is this conversation busy" checks, and should stay project-wide.

### A note on `stopPMStream`

`stopPMStream()` ends the PM's current turn early by flagging
`planApprovalRequested` — correct only when something else will pick up the
conversation afterward (a successful dispatch, a plan-approval card just
shown). It must never be called on a *rejection* path (duplicate dispatch,
write-agent busy, etc.), because it also skips the PM's synthesis/retry logic,
leaving the user with a blank response and no explanation. If you add a new
rejection branch to a PM tool, don't call `stopPMStream()` from it — let the
PM finish its turn and explain why the dispatch didn't happen.

### PM tools for checking agent/conversation state

Because "what's running" can mean four different things, there are four
distinct tools rather than one overloaded one — use whichever matches the
actual question:

| Question | Tool |
|---|---|
| "Is anything running in *this* conversation?" | `list_conversation_agents` |
| "Is anything running in *this project* (any conversation)?" | `get_agent_status({ project_id })` |
| "Is anything running *anywhere*, across every project?" | `get_agent_status()` (no args) |
| "What conversation am I even in — title, project, pinned, queued messages?" | `get_conversation_context` |
| "Which agent roles have zero instances running anywhere right now?" | `get_standby_agents` (observability only — see below) |

`get_standby_agents` is explicitly **not** a dispatch gate: an agent role
(e.g. `backend-engineer`) isn't a shared singleton across projects, so seeing
it "busy" elsewhere is never a reason to withhold a dispatch in the current
project/conversation. Only the write-agent project-wide serialization above
is a real cross-conversation restriction.

`list_agents` (the static roster) now also returns a one-line `description`
and `type` (`read-only`/`write`) per agent, reusing the same description
table (`BUILTIN_AGENT_DESCRIPTIONS` in `prompts.ts`) that's already baked
into the PM's system prompt — so the PM can re-fetch "what does each agent
do" on demand instead of relying on remembering its own system prompt.

---

## Message Flow

Every message — whether from the in-app chat or an external channel — enters
through `AgentEngine.sendMessage()`.

```
Message arrives at engine.sendMessage(conversationId, content, metadata?)
  |
  |-- metadata.source = "app" | "discord" | "whatsapp" | "email"
  |
  |-- Soft Approval Gate (no deterministic keyword interception)
  |     There is no pre-LLM keyword gate. `sendMessage` forwards every message
  |     to the PM via `_runPMProcessing`. When a plan is pending, the PM's
  |     context tells it so, and the PM LLM interprets whether the reply is an
  |     approval, a rejection, or an unrelated question:
  |     |
  |     |-- Approval intent ("approve", "yes", "go ahead", "lgtm")
  |     |     -> PM calls create_tasks_from_plan and begins execution
  |     |
  |     |-- Rejection intent ("reject", "no", "change")
  |     |     -> PM re-invokes task-planner with the feedback
  |     |
  |     |-- Ambiguous / unrelated message
  |           -> PM answers the question and can remind about the pending plan
  |
  |-- PM Processing (streamText)
        PM decides based on message content:
        - Simple question/status  -> answer directly
        - New feature request     -> planning flow
        - "Start working"         -> execute existing backlog
```

### Source Metadata

`sendMessage` accepts optional metadata:

```ts
metadata?: {
  source: "app" | "discord" | "whatsapp" | "email";
  channelId?: string;
  username?: string;
}
```

- In-app chat passes `source: "app"` (default).
- Discord router passes `source: "discord"`, `channelId`, `username`.
- Other channel integrations follow the same pattern.

The source flows into the PM's context and determines HOW plan
approval is presented (in-app chat message vs channel message), not WHETHER it happens.

---

## Scenarios

### Scenario A: New Feature Request

Human describes something to build. Requires planning, approval, and execution.

```
Human: "Build an authentication system with JWT and OAuth"
  -> PM: planning flow (see Planning Phase)
```

### Scenario B: Execute Existing Backlog

Human says "start working" or project already has kanban tasks in backlog.

```
Human: "Start working on the backlog tasks"
  -> PM calls list_tasks(project_id)
  -> PM sees N tasks in backlog
  -> PM confirms briefly, then starts executing workflow (skips planning and approval)
     (skips planning and approval)
```

### Scenario C: Simple Question / Status Check

No workflow needed. PM answers directly from conversation history and kanban state.

```
Human: "What's the status of the project?"
  -> PM calls list_tasks(project_id)
  -> PM summarises: "3 tasks in working, 2 in done, 5 in backlog"
```

---

## Planning Phase

Triggered when the PM determines the request is a new feature or project-level work.

### Step 1: PM runs task-planner inline

PM calls `run_agent("task-planner", ...)` with the full user request,
project ID, and workspace path. The task-planner runs inline in the main
conversation — its tool calls are visible as message parts.

### Step 2: task-planner produces two artifacts

In a single invocation, the task-planner:

1. **Calls `create_note(project_id, title, content)`** — creates a human-readable
   markdown plan document. This immediately appears in the Docs tab of the
   Activity pane. The note contains: overview, task breakdown with descriptions,
   dependencies, effort estimates, assigned agent types, and acceptance criteria.

2. **Calls `define_tasks(tasks)`** — stores structured task definitions in the
   PM context (`context.taskDefinitions`). This does NOT create
   kanban tasks. The definitions include:
   - `title` — short task name
   - `description` — full task description
   - `assigned_agent` — which sub-agent type handles this (e.g. `backend-engineer`)
   - `priority` — `critical` | `high` | `medium` | `low`
   - `blocked_by` — array of indices referencing other tasks in this array
   - `acceptance_criteria` — array of checkable criteria strings

### Step 3: PM calls `request_plan_approval({ title, summary })`

This PM tool takes `title` (short plan title) and `summary` (markdown summary of
the plan). It uses the most recently created plan note as the approval card
content where available, falling back to `summary`. It then:
1. Presents the plan for approval:
   - **In-app (`source: "app"`):** persists the plan as an assistant message to the
     `messages` table (so it survives refresh), then broadcasts `planPresented` to the
     webview, which inserts the plan as a chat message (amber card) with approval instructions
   - **Channel (`source: "discord"` etc.):** sends the plan as chunked messages to
     the channel with explicit instructions: "Reply approve to start implementation, or reject to cancel."
2. Stops the PM stream — PM's turn ends, awaiting user reply

### PM's Final Message (Turn 1)

- In-app: Plan appears as a chat message with "Reply **approve** to proceed or
  **reject [feedback]** to request changes."
- Channel: plan summary is sent separately; PM says *"Plan sent for your review."*

### Outcome of the Planning Phase

- Plan note visible in Docs tab (rendered markdown)
- Structured task definitions stored in WorkflowContext
- Kanban board is still empty — no tasks created yet
- PM workflow in `awaiting_approval` state
- Soft approval gate is now active for this conversation

---

## Approval Gate

The approval gate is "soft" — there is no deterministic interception layer in
`sendMessage`. Every reply is forwarded to the PM via `_runPMProcessing`, and the
PM LLM interprets approval intent from the message while the pending plan is in
its context.

### Chat-Based Approval (Primary)

Both in-app and channel approval use the same mechanism: the plan is presented
as a chat message and the user replies in natural language.

When a message arrives for a conversation with a pending approval:

1. **LLM interpretation** (no pre-LLM keyword gate): the PM reads the reply with
   the pending plan in context and decides intent. Typical approval phrasings
   (`approve`, `approved`, `yes`, `go ahead`, `lgtm`, `looks good`, `go`, `start`,
   `proceed`) lead the PM to call `create_tasks_from_plan`; rejection phrasings
   (`reject`, `no`, `change`, `modify`, `update`, `instead`) lead it to re-invoke
   the task-planner with the feedback.
2. **Ambiguous / unrelated** — the PM answers the question and can remind the
   user about the pending approval.

### Rejection Flow

On rejection (chat reply with feedback):
1. PM rejection logic is triggered with feedback
2. Feedback is embedded into the workflow prompt context
3. task-planner is re-invoked with the feedback
4. task-planner updates the plan note (`update_note`) and regenerates `taskDefinitions`
5. Plan is re-presented (new chat message in-app / new chunked message to channel)
6. Workflow returns to `awaiting_approval` — loop repeats

---

## Kanban Creation (Post-Approval)

This is the first time the kanban board is touched. Kanban creation is
**deterministic** — no LLM involved.

When the user approves (says "approve" / "yes" / "go ahead"), the PM:

1. Interprets the reply as approval (the PM LLM reads the message; no deterministic gate)
2. Calls `create_tasks_from_plan` PM tool, which reads the stored `taskDefinitions`
3. For each task definition, creates a kanban task:
   - `project_id` — from workflow context
   - `title`, `description` — from task definition
   - `assigned_agent_id` — the sub-agent type assigned during planning
   - `priority` — from task definition
   - `acceptance_criteria` — JSON array of checklist items
   - `column: "backlog"` — all tasks start in backlog
4. PM then dispatches agents sequentially via `run_agent`

---

## Execution Phase

The PM's execution logic drives autonomous agent dispatch.

### Sequential Single-Agent Model

Write agents execute **one at a time**, sequentially. This ensures each agent
builds on what prior agents created with full coherence. Read-only agents can
run in parallel for research/exploration.

See [`docs/sequential-agent-model.md`](./sequential-agent-model.md) for the full design doc.

**Agent types:**
- **Write agents** (all implementation agents): Run sequentially via `run_agent`. Only one at a time.
- **Read-only agents** (`code-explorer`, `research-expert`, `task-planner`): Can run in parallel via `run_agents_parallel`.

**Enforcement:**
- `writeAgentRunning` closure-scoped boolean in `createPMTools` prevents concurrent write agents
- `run_agents_parallel` validates agents are in the `READ_ONLY_AGENTS` set
- PM dispatch logic hardcodes `maxConcurrent = 1` for write agents

### Handoff Summaries

When a workflow agent completes, a handoff summary is generated from its modified files
(`src/bun/agents/handoff.ts`):
- Small changes (≤3 files, <200 lines each): deterministic summary with file names, exports, CSS classes, DOM IDs
- Large changes: AI-generated summary
- Stored in `WorkflowContext.handoffSummaries` for crash recovery
- Prepended to the next agent's task description as `## Prior Work`

### Dispatch Logic

```
1. PM dispatches unblocked kanban tasks one at a time
2. Each agent receives:
   - Task description + acceptance criteria
   - Handoff summary from completed predecessor tasks
   - Kanban task ID
3. Agent completes → handoff summary generated → next task dispatched
4. Between tasks, conversation auto-compacts with tool result pruning
```

### Worker Agent Lifecycle

Each inline worker agent:

1. Calls `move_task(taskId, "working")` — kanban card moves to Working column
2. Performs the actual work (file ops, shell commands, git operations)
3. Checks off all acceptance criteria with `check_criteria(taskId, index, true)`
4. Calls `move_task(taskId, "review")` — kanban card moves to Review column
5. Returns summary text to the PM
6. **NOT allowed to move task to "done" — only PM can do this**

### Completion Tracking

- **Task marked done:** `review-cycle.ts` moves the task to "done" when `submit_review` returns `approved`
  - The review cycle is triggered from `tools/kanban.ts` — `move_task(..., "review")` and `submit_review` call `notifyTaskInReview()` (defined in `review-cycle.ts`) when a task enters the "review" column
  - On pass → done. On fail → back to working (up to `maxReviewRounds`, default 2). On max rounds → force-done with warning.
- **All tasks done:** PM detects completion via `list_tasks` and delivers completion summary
- **Task done notification:** `broadcastTaskDoneNotification` in `channels/manager.ts` fires for connected channels

---

---

## Completion

When the PM workflow transitions to `done`:

1. PM generates a completion summary covering:
   - What was built
   - Key files created/modified
   - Kanban task completion stats (N/N done)
   - Any notes or caveats
2. Summary is sent to:
   - App webview (conversation message)
   - All connected channels (chunked if needed)
3. Workflow is archived (persisted to DB for audit trail)
4. Kanban board shows all tasks in "done" column (tasks that had unresolved review
   issues after maxReviewRounds carry a red implementation note)

---

## Agent Failure Handling

Failure handling is **LLM-driven**, not a deterministic retry counter. There is no
`notifyTaskFailed` function and no `retries < 2` auto-retry/auto-pause logic.

When a worker agent finishes with `status: "failed"`, the engine appends a
`[Next Action]` hint to the agent's result before handing control back to the PM
(`src/bun/agents/engine.ts`):

```
[Next Action] INVESTIGATE — <agent> failed. Review the error above and decide
whether to retry, fix, or skip. Do NOT automatically re-dispatch without
understanding the failure.
```

The PM LLM reads the error plus this hint and decides what to do itself — retry,
adjust the task and re-dispatch, skip, or ask the human. The same `[Next Action]`
mechanism is used on success to steer the PM (e.g. `WAIT` while a reviewer runs,
`MOVE TO REVIEW` if an agent forgot to move its task, or dispatch the next
unblocked backlog task) so the PM rarely has to call `get_next_task` itself.

---

## Two-Way Channel Sync

### Outbound: App -> Channels

Every PM response (for all conversations, not just channel-originated ones) is
forwarded to all channels connected to that project:

- On `onStreamComplete`: send the final PM response text to each connected channel
- Long messages are chunked:
  1. Split on paragraph boundaries (`\n\n`) into chunks <= 2000 chars
  2. If a single paragraph exceeds the limit, split on sentence boundaries
  3. Send chunks sequentially with brief delays to preserve order

### Inbound: Channels -> App

- Channel messages are stored in the conversations table like any other message
- Conversation title includes channel prefix for visual differentiation:
  - `"Discord #general: Add auth system"`
  - `"WhatsApp: Fix deployment"`
  - `"Email: Feature request - auth"`
- The Docs tab, kanban board, and activity log are fully visible in-app
  for all conversations regardless of origin

### Project-Channel Binding

- Projects can be created in-app or via PM's `create_project` tool (from channels)
- A global workspace path setting determines the root folder for all project workspaces
- Each project gets an auto-derived subfolder: `{globalWorkspace}/{slugified-name}`
- Channels are connected to projects via Settings (channel config with `projectId`)
- Each channel maps to exactly one project
- A project can have multiple channels connected

---

## Execution Flow Reference

The PM orchestrates directly (no separate WorkflowEngine state machine):

```
Human request
  → PM streams response
  → PM runs task-planner inline (run_agent)
  → task-planner: create_note + define_tasks
  → PM: request_plan_approval → broadcasts planPresented → PM turn ends
  → Human: "approve"
  → PM: create_tasks_from_plan → kanban tasks created in "backlog"
  → PM: run_agent(backend-engineer, task1) → agent works → moves to "review"
  → review-cycle.ts auto-spawns code-reviewer
  → code-reviewer: submit_review(approved) → task moved to "done"
  → PM: run_agent(frontend_engineer, task2) → ...repeat...
  → PM: all tasks done → sends completion summary

Rejection flow:
  → Human: "reject: change X"
  → PM: run_agent(task-planner, update plan with feedback)
  → task-planner: update_note + define_tasks (revised)
  → PM: request_plan_approval → loop repeats
```

---

## Tool Reference

### PM Tools

| Tool | Description |
|---|---|
| `run_agent` | Run a sub-agent inline. Only one write agent at a time (`writeAgentRunning` guard). Agent gets fresh context (system prompt + task only). Tool calls visible as message parts. |
| `run_agents_parallel` | Run multiple **read-only** agents in parallel (`code-explorer`, `research-expert`, `task-planner` only). Write agents rejected with an error. |
| `request_plan_approval` | Present a plan for human approval. Signature: `{ title, summary }`. Uses the most recent plan note as the card content (falls back to `summary`), persists the plan as an assistant message in the DB, then broadcasts `planPresented` to the webview (amber plan card) or sends a chunked message to the channel. Stops the PM stream — awaits user reply. |
| `create_tasks_from_plan` | Create kanban tasks deterministically from the task-planner's `define_tasks` output. Called by PM after user approves. |
| `set_feature_branch` | AI-generates a feature branch name from recent conversation context and stores it in settings (`currentFeatureBranch:<projectId>`). Called by PM when feature branch workflow is enabled. |
| `clear_feature_branch` | Resets the stored feature branch name for the project. |
| `get_agent_status` | Running agents + reviews, scoped to one project (`project_id`) or system-wide (no args) — **never conversation-scoped**. |
| `list_conversation_agents` | Running agents scoped to one conversation (current conversation if `conversation_id` omitted). Use this, not `get_agent_status`, for "is anything running here?". |
| `get_conversation_context` | A conversation's id/title/project/pinned/archived/timestamps, whether it's a channel conversation, its running agents, and its queued-message count. |
| `get_standby_agents` | Agent roles with zero running instances anywhere, system-wide. Observability only — does not gate dispatch (see [Conversation & Project Scope](#conversation--project-scope)). |
| `list_agents` | Full agent roster with capabilities, model config, enabled status, a one-line `description`, and `type` (`read-only`/`write`). |
| `list_tasks` / `get_next_task` | Read the kanban board state. Used for status checks and task dispatch ordering. |
| `get_task` | Get full details of a specific kanban task. |
| `create_project` / `list_projects` / `search_projects` / `verify_project` | Project CRUD and lookup tools. |
| `ask_user_question` | Ask the human a clarifying question and block until answered. |
| `todo_write` / `todo_read` / `todo_update_item` | Manage a simple in-conversation todo list. |
| `list_docs` / `get_doc` / `search_docs` / `create_doc` / `update_doc` | Read and manage project notes/documents. |
| `get_kanban_stats` / `get_project_stats` | Aggregate stats for status reporting. |
| `list_conversations` / `get_conversation_messages` / `search_conversations` | Conversation history access. |
| `get_cron_jobs` / `get_channels` / `get_github_issues` / `get_pull_requests` / `get_deploy_status` | Read-only access to project resources for PM awareness. |

### Task-Planner Tools

| Tool | Description |
|---|---|
| `create_note` | Create a markdown document in the Docs tab. Used for the plan document. |
| `update_note` | Update an existing note (used during plan revision on rejection). |
| `define_tasks` | Store structured task definitions in the PM's context. Does NOT create kanban tasks. |

### Worker Agent Tools

Worker agents can move tasks to: **backlog**, **working**, **review** only.
Moving to "done" is blocked — tasks are moved to "done" only by `review-cycle.ts` when `submit_review(approved)` is called.

| Tool | Description |
|---|---|
| `move_task` | Move a kanban task between columns. Allowed destinations: `backlog`, `working`, `review`. "done" is rejected with an error. |
| `check_criteria` | Toggle an acceptance criterion checkbox on a task. Must check all criteria before calling `move_task(taskId, "review")`. |
| `add_task_notes` | Append notes to a task's important notes section. |
| `read_file` | Read a file from the workspace. |
| `write_file` | Write/create a file in the workspace. |
| `edit_file` | Edit an existing file with search-and-replace. |
| `multi_edit_file` | Apply multiple find-and-replace edits to a file in one operation. |
| `append_file` | Append text to a file without reading it first. |
| `copy_file` | Binary-safe file copy with auto-mkdir. |
| `patch_file` | Apply a unified diff patch to a file (with fuzz matching). |
| `file_info` | Get file metadata: exists, size, modifiedAt, lineCount. |
| `find_dead_code` | Scan for unused exports in TS/JS files. |
| `search_content` | Search file contents in the workspace (regex). |
| `search_files` | Search for files matching a glob pattern (recursive). |
| `list_directory` | List files and directories. |
| `run_shell` | Execute a shell command in the workspace. |
| `execute_code` | Run a short Python/JavaScript snippet in the workspace (approval-gated, same channel as `run_shell` — see below). |
| `run_background` | Run a long-running process in background. |
| `git_*` | Git operations: status, diff, commit, branch, push, pull, fetch, log, pr, stash, reset, cherry_pick. |
| `web_search` | Search the web for information (Exa → Tavily → DuckDuckGo, first configured/available engine wins). |
| `web_fetch` | Fetch and read URL content. |

### Code-Reviewer Agent Tools

The code-reviewer is read-only except for `submit_review`. It does NOT call
`move_task`. It calls `submit_review` with a structured verdict that the
`review-cycle.ts` processes via `handleReviewVerdict`.

| Tool | Description |
|---|---|
| `get_task` | Get full task details including acceptance criteria. |
| `list_tasks` | Read all kanban tasks to understand scope. |
| `read_file` | Read implementation files. |
| `search_content` | Search the codebase for relevant code. |
| `search_files` | Find files by glob pattern. |
| `list_directory` | Browse the workspace directory structure. |
| `git_diff` | Review all changes (primary tool for code review). |
| `git_log` | Check commit history for context. |
| `run_shell` | Run type checks, linters, or build commands. |
| `submit_review` | Submit a structured review verdict (`approved` or `changes_requested`) with summary. |

### QA Agent Tools

| Tool | Description |
|---|---|
| `list_tasks` | Read the kanban board to understand what was built. |
| `get_task` | Get full details of a specific task. |
| `read_file` | Read files for review. |
| `search_content` | Search the codebase. |
| `run_shell` | Run test commands. |
| `run_background` | Run long test suites in background. |
| `check_process` | Check status of background test runs. |
| `git_diff` | Review changes made by other agents. |

### `execute_code` — real-workspace Python/JavaScript execution

Granted (`seed.ts`'s `defaultAgentTools`) to every write-capable built-in agent that already
has `run_shell` (all 17 of them — architect through ml-engineer, including code-reviewer/qa-engineer)
plus `playground-agent`. Deliberately **not** granted to the 3 read-only agents (`code-explorer`,
`research-expert`, `task-planner` — `WRITE_TOOLS`/`filterReadOnlyTools` in `agent-loop.ts` strip it the
same way they strip `run_shell`/`write_file`) and structurally unreachable by the PM, whose entire tool
set (`pm-tools.ts`) never touches the shared `toolRegistry` this is registered in. General Chat's
Assistant has its own **separate**, always-ungated version (`general-chat-code-exec.ts`, ephemeral
scratch-folder framing) injected via `extraTools`, not this one.

- **Implementation split**: `agents/tools/code-exec-shared.ts` holds the logic shared with General
  Chat's version (interpreter resolution — `python3`/`python` via `Bun.which`, JS via `process.execPath`
  not `Bun.which("bun")`, dangerous-pattern blocklist, base64-image capture/strip). `code-exec.ts`'s
  `createCodeExecTool(workspacePath, identity, autoApprove)` is the real, workspace-bound
  implementation — cwd'd into the agent's **actual project workspace** (or Playground's own generated
  one), not a throwaway folder, so a script can read/write real project files, same capability tier as
  `run_shell`.
- **Approval gate — reuses `run_shell`'s own channel, doesn't duplicate it.** A code-exec call is
  submitted to `shell.ts`'s existing `requestShellLikeApproval` (new export, wraps the same
  `approvalHandler`/`sessionAutoApprovedProjects` module state `run_shell` already uses) — same
  `installShellApprovalHandler` (`engine-manager.ts`), same DB-persisted pending-approval row, same
  desktop/channel (Discord/WhatsApp/Email reply-to-approve) notifications, same `ShellApprovalCard` UI,
  same per-project `shellApprovalMode` (Ask/Auto) setting and "Always allow" cache. A user approving one
  implicitly trusts the other too — intentional, since both represent the same underlying risk
  ("this project's agents may run arbitrary code"), not two separate toggles. **Playground is the one
  exception**: `playground/orchestrator.ts` injects its own `createCodeExecTool(..., autoApprove: true)`
  via `extraTools`, mirroring its existing `run_shell: autoApprovedShellTool` override — Playground has
  no human watching per-action approvals by design.
- **Deliberately NOT an AI SDK `contextSchema`/`context` tool like `run_shell` is.** `agent-loop.ts`'s
  `isClaudeSubscriptionViaCli` branch (Sonnet/Opus via the Agent SDK/CLI runner — see this file's
  Critical Rules section) calls each tool's `execute()` directly with only `{ toolCallId, abortSignal }`
  — no `context` object at all. This is the same two-path-provider gap that made General Chat's own
  image-capture silently fail earlier (see the General Chat section below) — a `contextSchema`-based
  `execute_code` would have failed outright for every Claude Subscription (non-Haiku) user, and it also
  needs `workspacePath` to know where to write the script file, which `run_shell` doesn't need (it takes
  a `workingDirectory` tool argument instead). Fixed by making it a closure-based factory instead,
  overlaid onto the agent's tool set in `agent-loop.ts` **before** the CLI/`generateText` branch point —
  exactly the same "only replace a tool name already granted via `agent_tools`" overlay pattern
  `trackedFileTools`/`createDecisionsTool` already use a few lines above it — so both provider paths get
  the identical, already-bound tool. A lightweight registry stub (`code-exec.ts`'s `codeExecTools`) exists
  purely so `execute_code` is a normal, listable, per-agent-toggleable tool (Settings → Agents → Tools);
  it should never actually execute.
- **Existing installs pick this up automatically** — no migration needed. `seedAgentTools()`'s
  "add missing default tools" pass (runs on every boot) diffs each built-in agent's current `agent_tools`
  rows against `defaultAgentTools[name]` and inserts anything missing, which already covers a
  newly-added tool name for an existing agent row.

---

## Key Files

| File | Role |
|---|---|
| `src/bun/agents/engine.ts` | AgentEngine — one per project; PM streaming/inline sub-agent execution/soft approval gate, all tracked **per conversation** (`pmAbortByConv`, `activeMetadataByConv`) so concurrent conversations in the same project never see or block each other |
| `src/bun/agents/engine-types.ts` | Engine callback types, thinking options, PreviousFailureContext |
| `src/bun/agents/agent-loop.ts` | Inline sub-agent executor — runs agents with message parts; exports `READ_ONLY_AGENTS` |
| `src/bun/agents/review-cycle.ts` | Independent code review cycle — auto-spawns reviewer when task enters "review"; no WorkflowEngine dep |
| `src/bun/agents/handoff.ts` | Generates handoff summaries from modified files; prepended to next agent task |
| `src/bun/agents/summarizer.ts` | Conversation compaction with tool result pruning |
| `src/bun/agents/context-notes.ts` | Syncs README/plan files as project notes for agent context |
| `src/bun/agents/prompts.ts` | System prompt builders for PM and sub-agents; feature branch instructions |
| `src/bun/agents/tools/pm-tools.ts` | PM tools: `run_agent`, `run_agents_parallel`, `request_plan_approval`, `create_tasks_from_plan`, `set_feature_branch`, etc. |
| `src/bun/agents/tools/kanban.ts` | Kanban tools: `move_task`, `submit_review`, `check_criteria`, `create_task`, etc. Triggers the review cycle (`notifyTaskInReview`) when a task enters the "review" column. |
| `src/bun/agents/tools/notes.ts` | Notes tools: `create_note`, `update_note`, `delete_note` |
| `src/bun/agents/tools/planning.ts` | `define_tasks` — stores structured task definitions pre-approval |
| `src/bun/agents/tools/file-ops.ts` | File tools: read/write/edit/multi_edit/append/delete/move/copy/patch, search, file_info, find_dead_code, etc. |
| `src/bun/agents/tools/file-tracker.ts` | FileTracker — tracks read/written files per agent run |
| `src/bun/agents/tools/truncation.ts` | Tool output truncation — saves full output to disk, returns preview + hint |
| `src/bun/agents/tools/git.ts` | Git tools: status, diff, commit, branch, push, pull, fetch, log, pr, stash, reset, cherry_pick |
| `src/bun/agents/tools/lsp.ts` | LSP tools: diagnostics, hover, completion, references, rename |
| `src/bun/agents/tools/skills.ts` | Skills tools: `read_skill`, `find_skills` |
| `src/bun/agents/tools/shell.ts` | `run_shell` with safety guards + shell approval gate; exports `requestShellLikeApproval`, reused by `execute_code` |
| `src/bun/agents/tools/code-exec-shared.ts` | Interpreter resolution, blocklist, base64-image capture — shared by `code-exec.ts` and `general-chat-code-exec.ts` |
| `src/bun/agents/tools/code-exec.ts` | `execute_code` for write-capable sub-agents (project/Quick Chat) + Playground — real workspace, approval-gated (auto-approved only for Playground) |
| `src/bun/agents/tools/process.ts` | Background process tools: `run_background`, `check_process`, `kill_process` |
| `src/bun/agents/tools/web.ts` | Web tools: `web_search` (Exa→Tavily→DuckDuckGo auto-fallback), `web_fetch`, `http_request` |
| `src/bun/agents/tools/index.ts` | Tool registry — assembles and filters tools per agent role |
| `src/bun/agents/kanban-integration.ts` | Bridges kanban UI events to the agent engine |
| `src/bun/engine-manager.ts` | Creates/caches AgentEngine per project; per-project abort controller registry keyed with each agent's `conversationId` (`getRunningAgentNamesForConversation` vs. project-wide `getRunningAgentNames`/`getAllRunningAgents`/`getSystemActivity`); `broadcastTaskDoneNotification`; project→window registry (`registerProjectWindow`/`broadcastToProject`) for Quick Chat windows |
| `src/bun/message-queue-manager.ts` | Server-side, same-conversation-scoped message queue (max 3) for messages sent while that conversation's PM/agents are busy; drains only when that same conversation goes idle — no cross-conversation fallback |
| `src/bun/quick-chat/window.ts` | Opens/reuses a Quick Chat project's own `BrowserWindow` with its own `createRpc()` instance — never the shared main-window `rpc` singleton, which silently breaks the first window's in-flight responses (see the file's own header comment) |
| `src/bun/quick-chat/os-integration.ts` | Registers/unregisters the OS Explorer/Finder "Open in AgentDesk" entry |
| `src/bun/single-instance.ts` | Windows named-pipe single-instance handoff for Quick Chat launches |
| `src/mainview/pages/quick-chat.tsx` | Quick Chat's reduced-chrome page (Chat/Docs/Settings only) |
| `src/mainview/components/ambient/ambient-screen.tsx` | Ambient Mode's live in-window overlay — mounted once in `app-shell.tsx`, shown/hidden via `useAmbientStore`, never a route change |
| `src/mainview/components/ambient/ambient-radar-view.tsx` | `AmbientChrome`/`AmbientRadarContent` — the Beacon-styled radar/stat-strip/log, shared by the live overlay and the projected display page (one implementation, not two) |
| `src/bun/ambient/window.ts` | Opens the "Project to display" `BrowserWindow` with its own `createRpc()` instance (same reasoning as Quick Chat above), positioned at a chosen `Screen.getAllDisplays()` entry's bounds |
| `src/bun/general-chat/orchestrator.ts` | General Chat's `sendMessage` — calls `runInlineAgent` directly for the standalone `assistant` agent (Playground's pattern, not the PM engine); per-conversationId `AbortController` registry; broadcasts live tool-call/text-delta events, persists only the final 2 rows per turn |
| `src/bun/general-chat/paths.ts` | `getGeneralChatWorkspacePath(conversationId)` — fresh `{tmpdir}/agentdesk-general-chat/<conversationId>` folder per conversation |
| `src/bun/agents/tools/general-chat-memory.ts` | Assistant-exclusive `save_memory`/`recall_memory`/`delete_memory`, bound to `general_chat_memories`; injected via `extraTools`, never in the shared `toolRegistry` |
| `src/bun/agents/tools/general-chat-todos.ts` | Assistant-exclusive `todo_write`/`todo_read`/`todo_update_item`, in-memory per-conversationId (unlike the PM's settings-table-backed version) |
| `src/bun/agents/tools/general-chat-code-exec.ts` | Assistant-exclusive `execute_code` — Python/JavaScript runner cwd'd into the conversation's own temp workspace; injected via `extraTools`, never in the shared `toolRegistry` |
| `src/bun/rpc/general-chat.ts` | General Chat RPC handlers — conversation CRUD, `getGeneralChatMessages`, `deleteGeneralChatMessage`, fire-and-forget `sendGeneralChatMessage`, `setGeneralChatDeepResearchMode`, `compactGeneralChatConversation` (the `/compact` slash command), `getGeneralChatContextLimit` (real per-model context window for the context meter) |
| `src/mainview/pages/general-chat.tsx` | General Chat's page — own local state (not `useChatStore`), reuses `ConversationSidebar`/`ToolCallFeed`/`ModelSelector`/`useInputPopover`/`VoiceInputButton`, plus its own `AssistantTypingRow`/`GeneralChatContextIndicator`/MCP status dialog |
| `src/bun/channels/manager.ts` | Routes inbound channel messages; `broadcastTaskDoneNotification` for connected channels |
| `src/bun/db/seed.ts` | Agent definitions + system prompts + default tool sets per agent |
| `src/mainview/stores/chat-store.ts` | Core chat state |
| `src/mainview/stores/chat-types.ts` | Message, ActiveInlineAgent, ChatState types |
| `src/mainview/stores/chat-event-handlers.ts` | DOM event handlers for RPC broadcasts (planPresented, agentInlineStart, etc.) |
| `src/mainview/components/activity/docs-tab.tsx` | Right-pane Docs tab (sidebar modal with mermaid support) |
| `src/mainview/components/notes/notes-tab.tsx` | Full-page Docs view — list + markdown preview with mermaid support |
| `src/mainview/components/kanban/kanban-board.tsx` | Kanban board (columns: backlog / working / review / done) |
| `src/mainview/components/kanban/kanban-stats-bar.tsx` | Stats bar showing per-column task counts |
| `src/mainview/components/ui/mermaid-diagram.tsx` | Lazy-loaded mermaid renderer with graceful text fallback |

### Kanban Columns

| Column | Who moves tasks here | Description |
|---|---|---|
| `backlog` | PM (via `create_tasks_from_plan`) | Task created, not yet started |
| `working` | Worker agent (via `move_task`) | Agent has claimed and started the task |
| `review` | Worker agent (via `move_task`) | Agent finished; `review-cycle.ts` auto-spawns code-reviewer |
| `done` | `review-cycle.ts` (via `submit_review(approved)`) | Review passed (or max rounds exceeded — force-done with warning note) |

---

## Issue Fixer (autonomous GitHub-issue resolution)

A per-project feature, fully decoupled from the PM/kanban/approval flow (like the Playground). Code lives in `src/bun/issue-fixer/`.

**Trigger → fix flow:**

1. **Poll** (`poller.ts`, 60s tick started in `index.ts`) — for each *enabled* project whose interval has elapsed, fetch open issues + issue/PR comments since the stored cursor via the GitHub REST API (outbound only — no inbound webhooks, NAT-safe + private).
2. **Gate** (`triggers.ts`) — fire only when an `agentdesk-*` keyword matches the issue **title** or an authorized **comment** (never the body), or an `agentdesk-*` **label** is present, AND the actor is authorized (`OWNER`/`MEMBER`/`COLLABORATOR`, or label-gated). Dedup, cooldown, and max-per-hour are enforced; the cursor prevents retroactively processing old issues.
3. **Run** (`orchestrator.ts`, sequential per-project queue) — `createRun` + `registerAgentController` (so it counts on the dashboard card); checkout/pull base; create `issue-fix/<n>-<slug>` branch (or the PR head branch for the feedback loop); comment "🤖 working…"; run the hidden **`issue-fixer`** agent via `runInlineAgent` (full registry + chrome-devtools MCP + git tools + guarded auto-shell; `request_human_input`/`git_push`/`git_pr` excluded; `persistToDb:false`); test/build gate; commit; **token-authenticated push** (`pushBranchAuthenticated`); open a PR (`Fixes #N`, draft if tests fail or autonomy=draft); comment "✅ done — PR #M"; notify all connected channels (success+failure).
4. **PR-feedback loop** — a maintainer's `agentdesk-*` comment on the agent's PR re-runs the agent on that PR's branch.

**Strict rule: the agent NEVER merges** PRs or branches, and cannot run destructive git — enforced three ways: the agent's system prompt; excluding tools (`git_pr`/`git_push`/`git_reset`/`git_cherry_pick`/`git_branch` + kanban writes; no `git_merge` exists); and `shell-guard.ts`'s denylist (blocks `git merge`/`rebase`/`gh pr merge`, force-push, base-branch + remote-ref deletion, and all undo/destructive commands — `reset`/`clean`/`restore`/`checkout`/`switch`/`branch -D`/`filter-branch`/`reflog`/`stash drop|clear`/recursive `rm`). Other safety: runs require a clean working tree (fail, never stash), reuse an existing branch on re-trigger (never `-B` reset), detect the base branch from `origin/HEAD` when unset, skip empty PRs, and mark crash-interrupted runs failed on restart. Concurrency: serialized polling (reentrancy-guarded) + sequential runs per project, parallel across projects (each project = its own repo/workspace) with a per-poll `maxPerHour` budget.

**Config + visibility:** Project Settings → **Issue Fixer** tab (enable, poll interval, `agentdesk-*` keywords/labels, authorization mode, autonomy, test command, custom instructions, cooldown/max-per-hour, GitHub token source: global vs per-project). A project **Issue Fixer** tab shows live **Activity** (streamed via `agentdesk:issuefixer-*`) + **History** (`issue_fix_runs`). Two GitHub-auth fixes underpin this: token resolution unified on `github_pat` with a per-project override (`resolveGitHubToken`), and autonomous push auth (`pushBranchAuthenticated`).

---

## Quick Chat (project-less chat via OS Explorer)

Lets a user right-click a **folder** (or empty space inside a folder window) in Windows Explorer / macOS Finder → **"Open in AgentDesk"** → a lightweight, reduced-chrome window opens a normal PM/sub-agent chat scoped to that folder, without creating a project first. Full design/rationale in `docs/quick-chat-plan.md`.

**Data model:** the clicked folder becomes a real `projects` row (via `createProjectHandler`'s existing external-path adoption — junction/symlink, no copy) flagged `is_quick_chat = 1` (migration v57). `getProjectsList` filters this flag out, which — since the Dashboard and the PM's own `list_projects`/`search_projects` tools all read through it — hides Quick Chat projects everywhere until the window's **"Create Project"** button flips the flag off (`promoteQuickChatProject`).

**Engine behavior:** `AgentEngine` derives a `quickChat` boolean **per turn** (not cached) from `projects.isQuickChat`, threaded into `getPMSystemPrompt`/`createPMTools`. When true: a `QUICK_CHAT_SECTION` prompt block (mirrors `PLAN_MODE_SECTION`'s prepend pattern) tells the PM the kanban/plan-approval tools don't exist; `create_tasks_from_plan`/`get_next_task`/`get_kanban_stats`/`request_plan_approval`/`set_feature_branch`/`clear_feature_branch`/`verify_project`/`list_tasks`/`get_task` are omitted from the PM's tool map; dispatched sub-agents get `excludeTools` stripping every kanban tool name (same mechanism Playground/Issue Fixer use); `onAgentDone`'s kanban `[Next Action]` lookup is skipped entirely (guards an empty-board `allTasks.every(...)` vacuous-true bug). Review cycle is never triggered since it only fires from `move_task`→review, which is unreachable without kanban tools.

**Window/broadcast model:** a Quick Chat window is a second `BrowserWindow` (`quick-chat/window.ts`) with its **own** `createRpc()` instance — sharing one `rpc` object across windows was tried first and breaks the first window (Electrobun's RPC keeps a single mutable `transport` closed over by that one rpc object, so a second window silently repoints the first window's in-flight responses; see the file's header comment). Handler *implementations* are stateless and safe to reuse across the independent instances. `engine-manager.ts` maintains a `projectId → window` registry; `broadcastToProject` routes every per-project engine event (streaming, tool parts, shell-approval/user-question) to the owning window only, falling back to the main window for ordinary projects; `broadcastToWebview` (global events like `showToast`) fans out to the main window **and** every open Quick Chat window.

**Launch path:** Windows registers `Directory\shell` + `Directory\Background\shell` entries (`--quick-chat "%V"`) via `quick-chat/os-integration.ts`; a `node:net` named pipe (`single-instance.ts`) lets a second launch hand its request to an already-running instance and exit immediately instead of booting fully — a Quick-Chat-only cold start skips the main window entirely and defers cron/automation/issue-fixer/plugin/channel init behind the Quick Chat window's own `dom-ready`. macOS instead registers a Finder Quick Action (Automator `.workflow` in `~/Library/Services`) that shells out to `open agentdesk://quick-chat?path=...`, handled by an `Electrobun.events.on("open-url", ...)` receiver — macOS's own Launch Services gives single-instance activation for free, no pipe needed. Both platforms are gated by the **"Allow Quick Chat"** setting (Settings → General, default **on** — existing installs auto-register on first launch after upgrading).

---

## General Chat (standalone "Assistant" agent)

A ChatGPT-style, project-less chat surface — a new "General Chat" sidebar nav item (above Playground) opens `/general-chat` as a normal embedded route inside the main `AppShell` (unlike Quick Chat, no second `BrowserWindow`). Full design/rationale in `docs/general-chat-plan.md`.

**Standalone agent, not PM:** backed by a dedicated built-in agent, `general-chat-assistant` ("Assistant"), hidden the same way `playground-agent`/`issue-fixer`/`freelance-expert` are (`isBuiltin: 1`, `availableToPm: 0`, excluded from `rpc/agents.ts`'s Agents-page listing **and** from `prompts.ts`'s `buildAgentsSection()` — the PM's own "Sub-Agents Available" table and `run_agent`'s valid-target list — so it can never be offered as a dispatch target either). It has no `run_agent`/`run_agents_parallel` tools (those are PM-only, hardcoded in `pm-tools.ts`, never in the shared `toolRegistry`), so it cannot delegate — it handles every turn itself, single-agent, no sub-agents, no kanban, no Constitution.

**Data model:** three new, fully project-independent tables (`src/bun/db/migrations/v61_general-chat.ts`) — `general_chat_conversations` (id, title, isPinned, isArchived, `deepResearchMode`, timestamps), `general_chat_messages` (flat: id, conversationId, role, content, tokenCount, createdAt — **no parts table**, since tool-call activity is never persisted), and `general_chat_memories` (same shape as `global_memories` but exclusive to Assistant, never shared with PM). `general_chat_messages` gained a nullable `metadata` column in `v62_general-chat-message-metadata.ts` — JSON, `{modelId}`, mirroring project chat's `messages.metadata` convention, set on assistant/compaction-summary rows so the hover action row (below) can display which model produced a reply.

**Execution model — mirrors Playground, not the PM engine:** `src/bun/general-chat/orchestrator.ts`'s `sendMessage(conversationId, text)` calls `runInlineAgent` directly (`agentName: "general-chat-assistant"`, `persistToDb: false`, `priorMessages` loaded from `general_chat_messages`) — fully decoupled from `AgentEngine`/kanban/review-cycle, same reasoning as Playground's own use of `runInlineAgent`. Key differences from Playground: DB-backed **multi**-conversation history (not a single JSON-file session) and `projectId` is set to the **conversationId itself** (not a real project) — this gives `ModelSelector`'s persisted settings (`chatProviderId`/`chatModelId`, via the real `saveProjectSetting`/`getProjectSettings` convention) genuine per-conversation scoping, exactly like a normal project chat. The one place this needed a guard: `agent-loop.ts`'s per-project memory-tool overlay explicitly excludes `agentName === "general-chat-assistant"`, so it never clobbers the Assistant-exclusive memory tools (below) with the generic per-project `agent_memories` binding.

**Tools — workspace-less by design (see "Redesigned: workspace-less" below):** a fixed, curated list via normal `agent_tools` rows — `find_skills`, `generate_image`, `http_request`, `read_audio`, `read_file`, `read_image`, `read_skill`, `read_skill_file`, `sleep`, `validate_skill`, `web_fetch`, `web_search` (plus `request_human_input`, auto-added to every built-in agent) — no file write/edit/delete tools, no directory-browsing tools, no `run_shell`, and no `take_screenshot`/`environment_info` (both workspace/desktop-oriented, out of scope for a workspace-less chat agent). `read_file`/`read_image`/`read_audio` exist only so it can read something the user attaches; it has nowhere to write to and no way to go looking for files on its own. Four more tools are `extraTools`, injected directly at the orchestrator call site, never through the shared `toolRegistry` (so no other agent can ever get them): `save_memory`/`recall_memory`/`delete_memory` (`agents/tools/general-chat-memory.ts`, bound to `general_chat_memories`), `todo_write`/`todo_read`/`todo_update_item` (`agents/tools/general-chat-todos.ts`, a standalone in-memory-per-conversationId scratch list — unlike the PM's `settings`-table-backed version, since Assistant has no sub-agents to hand a list off to across turns), `execute_code` (`agents/tools/general-chat-code-exec.ts`, a scoped Python/JavaScript runner cwd'd into the conversation's own temp workspace — see below), and `deep_research` (the real tool, `createDeepResearchTool(...).deep_research.tool`, injected only when the conversation's `deepResearchMode` is on — reuses the existing factory as-is with zero changes to its `agentName === "research-expert"` special case in `agent-loop.ts`, since the real tool is supplied directly via `extraTools` rather than through that stub-overlay branch). MCP tools need no special wiring — `runInlineAgent` already merges them into any inline agent's tool map generically, so Assistant can call a connected MCP tool (e.g. `chrome-devtools_*`) directly, with no "delegate to a sub-agent" framing.

**System prompt:** `getAssistantSystemPrompt(deepResearchMode)` in `prompts.ts` — a dedicated dispatch branch inside `getAgentSystemPrompt()` (`agentName === "general-chat-assistant"`), mirroring the Playground/Issue Fixer branch's pattern but composing its own section set: base identity (`agents` table row, seed.ts — its own `##`-delimited subsections, `Memory`/`Style`/`Answering`, each `---`-separated like the rest of the prompt) → App Context (app name + version, current date/time, timezone) → `buildUserSection(profile, { includeEmail: false })` (name/city only — Assistant never sees or references the user's email, unlike PM which uses it for the email channel) → `buildSkillsDescriptionSection(false)` (no agent-routing rules) → `buildAssistantMcpSection()` (server-level MCP listing, e.g. `- **chrome-devtools**`, plus the same chrome-devtools-vs-`live-browser`-skill choice note `buildPMMcpSection` gives the PM, reworded for direct use instead of delegation — deliberately its own function, not a shared-format change to `buildAgentMcpSection`, which sub-agents/Playground/Issue Fixer still use unchanged) → a conditional Deep Research Mode section (ask a clarifying question before calling `deep_research`, same prepend pattern as `PLAN_MODE_SECTION`). Deliberately omits the Constitution, kanban/channel/feature-branch sections, and project/git context. Threaded from `runInlineAgent`'s call site via `InlineAgentOptions.deepResearchMode` — a small additive field (mirrors the existing per-caller `quickChat`/`readOnly` flags) since `getAgentSystemPrompt`'s original three-arg signature had no room for conversation-scoped mode state. Full conversation history is threaded the same way Playground follow-ups are: `orchestrator.ts`'s `loadPriorMessages` loads every prior turn from `general_chat_messages` (capped at the last `MAX_HISTORY_TURNS`) and passes it as `InlineAgentOptions.priorMessages`, which `runInlineAgent` prepends before the current turn on both the normal and Claude Subscription CLI paths — verified already correct, no gap here.

**Tuned: Assistant's prompt over-asked and under-identified itself.** The original base prompt spent two paragraphs telling the model what it *couldn't* do (no project access, no sub-agents) — dropped as unnecessary (the model has no tools to reach those things anyway, so nothing needed saying). `## Your workspace`/`## Memory` similarly dropped their trailing "not a project workspace"/"separate from per-project memory" clauses for the same reason. `## Style` trimmed to one line (the name-addressing and don't-mention-projects guidance moved out — the latter was redundant with the same "nothing said above" reasoning). App Context previously had no `- **App**: AgentDesk v...` line at all (PM's has always had one) — added. A new `## Answering` section (added in the previous fix for unprompted clarifying questions) got an explicit "offer tips/ideas/links proactively" closing line.

**Fixed: unprompted clarifying questions on plain messages.** The base prompt (`seed.ts`'s `"general-chat-assistant"` row) had no equivalent of the PM prompt's classification gate ("Casual/conversational? → Answer directly. No tools needed.") — Assistant gets `request_human_input` like every other built-in agent (the `NO_HUMAN_INPUT_AGENTS` exclusion set doesn't include it), and that tool's generic description ("need information you cannot derive from context") was loose enough for the model to call it on a plain "hi" (asking for name/email — already sitting unused in the same prompt's `## User Profile` section — then "what would you like to work on today?"). Not a harness bug — `verifyToolCall: false` means nothing forces a tool call either way; this was purely a model-choice gap the prompt itself never closed. Fixed with a new "## Answering" section in the seed prompt: casual/answerable-from-context messages get a direct reply, `request_human_input` is reserved for genuine ambiguity in an actual requested task, and it explicitly calls out never re-asking for info already present in `## User Profile`. Built-in agent prompts re-upsert automatically on next launch when their bundled text changes (seed.ts's content-hash check against `settings.builtinPromptsHash`) — no migration needed.

**RPC:** `src/shared/rpc/general-chat.ts` — every method is prefixed `generalChat`/`GeneralChat` (`listGeneralChatConversations`, `createGeneralChatConversation`, `sendGeneralChatMessage`, `setGeneralChatDeepResearchMode`, ...): Electrobun's RPC schema is one flat namespace, and the semantically-matching bare names (`createConversation`, `sendMessage`, ...) already exist in `ConversationsRequests` for project chat — reusing them would collide. `sendGeneralChatMessage` is fire-and-forget (mirrors `playgroundSend`): the RPC returns immediately, the actual reply streams via `generalChatPart`/`generalChatTextDelta`/`generalChatComplete` broadcasts (new `WebviewSchema` messages, wired into `mainview/lib/rpc.ts` and `remote-transport.ts` exactly like Playground's own broadcast set). `generalChatComplete` carries `userMessageId`/`assistantMessageId`/`modelId` alongside `assistantText`/`status`, so the frontend can reconcile its optimistic bubbles to the real persisted rows (see "Per-message hover actions" below). Handlers live in `src/bun/rpc/general-chat.ts`, registered via `src/bun/rpc-groups/general-chat.ts` into `src/bun/remote/rpc-handlers.ts`'s `requestHandlers` (the actual merge point both the Electrobun bridge and the remote WebSocket server dispatch through — `rpc-registration.ts` itself only re-exports it).

**Frontend:** `src/mainview/pages/general-chat.tsx` — its own local component state (not `useChatStore`, which is deeply project-chat-coupled), reusing: `ConversationSidebar` (generalized — `projectId` is now optional, skipping the "N agents will be stopped" delete-warning lookup when absent), `ToolCallFeed` (unmodified — accumulates from `generalChatPart` events where `type === "tool_call"`), `ModelSelector` (reused as-is with `projectId={conversationId}`, plus a new `hideBuildPlanToggle` prop so General Chat can render a `DeepResearchToggle` component in its place), `VoiceInputButton`/`useVoiceInput` (the same generic hook/button project chat's `ChatInput` uses, wired directly against local `inputValue` state), and `useInputPopover`/`SLASH_COMMANDS` filtered to just `/clear`/`/compact`/`/fork`/`/mcp`/`/new` (`/compact` hidden below 50% estimated context utilization, mirroring `chat-input.tsx`'s own `visibleSlashCommands` filter). Completed-turn markdown rendering (tables, code blocks) is a small `MD_COMPONENTS` object **duplicated** from `message-bubble.tsx`'s `PLAN_MD_COMPONENTS` — same pattern `skills-search-chat-modal.tsx` already uses for its own standalone chat surface, since importing the real `MessageBubble` would drag in its full `useChatStore`/`useMessageActions`/parts/plan/todo-card coupling for a surface that has none of that.

**Visual parity with project chat (post-launch pass):** the "Thinking…" indicator is now a bespoke `AssistantTypingRow` that visually mirrors `message-list.tsx`'s shared `TypingRow` (same rainbow-animated bordered bubble, lightbulb icon, typewriter reveal) but with `<AgentAvatar name="general-chat-assistant">` instead of `TypingRow`'s hardcoded `"project-manager"` badge — reusing the generic, name-hashed `AgentAvatar` component directly rather than building a separate avatar system. A fixed-bottom "Responding…"/"Compacting conversation…" pill (mirrors `message-list.tsx`'s own floating indicator) appears during a turn or a compaction. The input bar was restyled to match `ChatInput`'s pill-shaped bordered container (icons inline with the textarea, not a separate button outside it): file attach (`Paperclip`), attach-a-note (`Library` → the shared `AttachNoteModal`), the shared `PromptsDropdown`, an MCP status row + dialog (reconnect/disconnect per server — same `getMcpConfig`/`getMcpStatus`/`reconnectMcpServer`/`disconnectMcpServer` RPCs `chat-input.tsx` already calls) shown above it when servers are configured, and a small local `GeneralChatContextIndicator` (~tokens / bar / %) next to the model selector row. That indicator is a **deliberately separate** component from the shared `ContextIndicator` — it estimates purely from General Chat's own local message list rather than reading `useChatStore`'s global `liveContextTokens`, since that store is shared with project chat inside the same webview and could otherwise show a stale figure left over from whatever project conversation was open last.

**File/note attachments:** `general-chat.tsx`'s `handleSend` reuses `ChatInput`'s own `AttachmentFile`/`categorizeFile`/`processFiles`/`ACCEPT_ALL` (now exported from `chat-input.tsx` for reuse) and mirrors `chat-layout.tsx`'s `handleSend` exactly: each attachment is base64-encoded and saved via the existing `saveAttachment` RPC (`conversationId` stands in for `projectId` — safe, since `saveAttachment` only reads that param in its fallback branch when the global workspace path setting isn't configured, which it normally is) into an "implicit context" text block (`<attached-file>` for text, `[Attached image: ...]`/`[Attached audio: ...]` telling the model to call `read_image`/`read_audio` — both tools are unsandboxed to any absolute path, so they reach the saved attachment regardless of the assistant's own `workspacePath`; binary docs get a plain text note, same no-dedicated-tool limitation project chat has) prepended to the message text before it's sent. Unlike project chat (which stores a separate `visibleContent` for the optimistic bubble vs. the DB-persisted wrapped text), General Chat stores and shows the **same** wrapped string in both places — `GeneralChatBubble` runs its own local `extractAttachmentChips` (duplicated from `message-bubble.tsx`'s pattern-matching, same reasoning as `MD_COMPONENTS`) on every render, so the optimistic bubble and a post-reload bubble render identically from one persisted string, with no image-thumbnail/lightbox richness (`AttachmentPreviews`) — a deliberate scope trim, plain chip labels only.

**Compaction — manual AND automatic:** `compactConversation` (`general-chat/orchestrator.ts`) is a lighter version of `agents/summarizer.ts`'s project-chat compaction — `general_chat_messages` is already flat (no parts table to prune), so it's a single `generateText` call over everything but the most recent 10 messages, which get deleted and replaced with one condensed `role: "assistant"` message stamped at the earliest compacted message's `createdAt` (so it stays in chronological order). Broadcasts `generalChatCompacted` so the page reloads messages from the DB. No separate summaries table (unlike project chat's `conversation_summaries`) — a compacted summary is just another message, and can itself be re-compacted in a later pass. Two triggers share this one function: the user-invoked `/compact` slash command (`rpc/general-chat.ts`'s `compactGeneralChatConversation` is now a thin wrapper over it), and an **automatic** pre-turn threshold check inside `sendMessage` — mirroring `AgentEngine._runPMProcessing`'s own auto-compaction (`engine.ts`'s `triggerSummarization`, checked against `this.lastPromptTokens`/`getContextLimit` at the start of every PM turn). Since `runInlineAgent` is stateless across calls, the orchestrator keeps its own `lastPromptTokens: Map<conversationId, number>`, updated from `runInlineAgent`'s real `result.tokensUsed.prompt` after each turn (recomputed as a char-estimate right after a compaction, same as `triggerSummarization` does) — compared against `getContextLimit(modelId, conversationId)` at the start of the next `sendMessage` call, before `priorMessages` is loaded. A compaction failure here is caught and logged, never blocking the turn from proceeding on its (oversized) existing context.

**Generated images survive reload:** `generate_image`/`take_screenshot` tool results (raw base64 in the AI SDK tool-result, per `extractImagePayload` in `agents/tools/screenshot.ts`) are captured in `sendMessage`'s `onPartCreated`/`onPartUpdated` callbacks (tracking `tool_call` partId → toolName so the later `toolOutput` update can be matched back to it) and embedded directly into the persisted assistant message as `<generated-image mime="...">base64</generated-image>` blocks once the turn completes — since `general_chat_messages` has no parts table, this is the only way a generated image outlives the live tool-call stream. `GeneralChatBubble`'s `extractGeneratedImages` (mirrors `extractAttachmentChips`'s pattern-matching) strips these back out into real `<img>` elements (with a click-to-zoom lightbox) at render time, so both the just-streamed and a post-reload bubble render identically. Deliberately scoped to `generate_image`/`take_screenshot` only — `read_image` (viewing an existing user attachment, not producing new output) is excluded, matching the same scope trim as the attachment thumbnails above.

**Per-message hover actions (visual + functional parity with `MessageBubble`):** `GeneralChatBubble`'s hover row now matches project chat's exactly — user: Delete/Copy/Fork/timestamp; assistant: Copy/Save to Collection/Retry (last message only)/Delete/timestamp/model id. Delete uses a new `deleteGeneralChatMessage` RPC (`rpc/general-chat.ts`, registered in `rpc-groups/general-chat.ts`). Fork reuses the existing `forkGeneralChatConversation(id, upToMessageId)` RPC — it already supported a per-message pivot, just wasn't wired to a per-bubble UI action before — and switches the page to the newly-created conversation. Retry deletes the last assistant row and resends the preceding user message's content as a new turn via a `sendToConversation` helper factored out of `handleSend`, deliberately leaving the old user bubble in place rather than deleting it first — mirrors `chat-store.ts`'s `retryLastMessage` behavior for project chat exactly (a second, duplicate-looking user bubble is expected, not a bug). Save to Collection reuses `SaveToCollectionModal` with a new `sourceType: "general_chat"` (`CollectionNoteSourceType`), no `sourceRef`. Model id reads the new `metadata` column (above); `sendMessage` now generates the user/assistant message ids explicitly (`crypto.randomUUID()`, rather than relying on the schema's `$defaultFn`) so the `generalChatComplete` broadcast can carry the real, persisted ids (`userMessageId`/`assistantMessageId`) plus `modelId` — the frontend patches its optimistic bubbles to those real ids in place, since Delete/Fork/Retry all need the actual DB row id.

**Header bar (visual + functional parity with `chat-layout.tsx`):** a header row now sits above the message list — sidebar toggle (`PanelLeft`; the sidebar's own width/collapse behavior was also brought in line with `chat-layout.tsx`'s — `w-[220px]` with an animated width transition, was a hard-toggled `w-64`), conversation title (click to copy id), a centered click-again-to-confirm "Clear Chat" button, "New conversation", font-size zoom (`useConvFontSize("conv-font-size-general-chat")`, its own independent storage key), "Search messages" (reuses `MessageSearch` unmodified — its `messages` prop type is already a generic `{id, content, role}` shape `DisplayMessage[]` satisfies structurally), and "Export as markdown" (client-side `Blob` download). Deliberately omits Focus mode and the activity-pane toggle — General Chat has no sub-agents and no activity pane to hide, unlike project chat. Search highlighting required converting `general-chat.tsx`'s static `MD_COMPONENTS` object into a `buildMdComponents(query)` function whose `p`/`li`/`h1-h4`/`blockquote`/`td`/`th` renderers wrap `children` in a locally-duplicated `highlightChildren`/`SearchHighlight` (same duplication reasoning as everything else in this file — avoids pulling in `message-bubble.tsx`'s store coupling). (A quick-start prompt grid was tried in the empty-conversation state and then explicitly reverted per feedback — not wanted here.)

**Auto-title from first message:** conversations now rename themselves from the first user message, matching every other chat surface — `orchestrator.ts`'s `sendMessage` mirrors `engine.ts`'s `autoTitleConversation` (identical 40-char truncation rule; no source-channel prefix, since General Chat has no Discord/WhatsApp/email surface). Fires *before* the turn starts, not after it completes, so the rename lands immediately rather than waiting for the whole reply. Broadcasts a new `generalChatConversationRenamed` (`{conversationId, title}`) — `sendGeneralChatMessage` is fire-and-forget, so the existing post-send `reloadConversations()` call in `general-chat.tsx` would otherwise race the backend's async rename and frequently miss it; the frontend instead patches `conversations`/`archivedConversations` state in place from this event.

**Fixed: shell approval requests never surfaced, hanging the turn.** The backend side was already correct — `run_shell`'s approval gate (`engine-manager.ts`'s `installShellApprovalHandler`) broadcasts `shellApprovalRequest` globally regardless of caller, and General Chat's `runInlineAgent` call passes `projectId: conversationId`, so the request lands in the shared `useChatStore.shellApprovalRequests` array correctly keyed, same as project chat. The gap was entirely on the frontend: `chat-layout.tsx` is the only component that ever read that array and rendered `ShellApprovalCard`, and `general-chat.tsx` doesn't mount `chat-layout.tsx` (it's a standalone page) — so a pending approval sat invisibly in the store, and the blocked `run_shell` call just hung until the backend's own timeout auto-denied it. Fixed by subscribing to the same store directly in `general-chat.tsx` (`allShellApprovalRequests` → `useMemo`-filtered by `activeConversationId`, mirroring `chat-layout.tsx`'s exact pattern) and rendering `ShellApprovalCard` in the same position between the message list and the input area.

**Fixed: "Thinking…" vanished as soon as a tool call started.** `general-chat.tsx`'s `AssistantTypingRow` condition was `isSending && !streamingText && toolCalls.size === 0` — mutually exclusive with the tool-call feed by construction, so the indicator disappeared the instant the first tool call began. Project chat's equivalent (`message-list.tsx`'s `showTypingDots`) has no tool-call-count term at all — `TypingRow` and the tool-call pane render together for as long as the agent hasn't produced real text yet. Dropped the `toolCalls.size === 0` clause so General Chat now matches.

**Live tokens/s + input auto-focus (parity fixes).** `GeneralChatContextIndicator` gained a `tokensPerSecond` prop rendering the same "N tokens/s" span as `ContextIndicator`'s inline variant. Backed by `InlineAgentCallbacks.onStreamPerformance` — already fired generically by `runInlineAgent` for every caller (previously wired up only by the PM engine's own `chat-event-handlers.ts`, into `useChatStore.liveTokensPerSecond`) — forwarded through a new `generalChatStreamPerformance` broadcast into a local `liveTokensPerSecond` state (reset on conversation switch and on each new send), not the shared store, for the same staleness reason `GeneralChatContextIndicator` already avoids `useChatStore` entirely. Separately: the textarea's auto-focus `useEffect` was keyed only on `isSending` (already `false` on first mount), but the textarea is still `disabled` at that point since `activeConversationId` is set asynchronously by `reloadConversations()` — so the first `focus()` call landed on a disabled element and nothing retried it once the conversation became ready. Fixed by adding `activeConversationId` to the effect's dependency array/condition, mirroring `chat-input.tsx`'s own `[disabled]`-keyed auto-focus effect.

**Fixed: cross-project shell-approval toast fired for General Chat's own open conversation.** `cross-project-approval-toast.tsx` (mounted once in `AppShell`, global) suppresses its "needs shell approval in another project" toast when `useChatStore.activeProjectId` already matches the request's project — correct for project chat/Quick Chat (both call `setActiveProject`), but General Chat never did, and its broadcasts use `conversationId` in place of `projectId` (see below), so the toast fired even for the conversation already open on screen, redundant with the inline `ShellApprovalCard`. Fixed by adding `activeGeneralChatConversationId` to `useChatStore` (mirrors `activeProjectId`'s role), kept in sync by `general-chat.tsx`'s `setActiveConversationId` (cleared on unmount), and checked as a second suppression condition in the toast handler.

**Fixed: leaving/refreshing the page mid-turn lost the "still working" state.** Unlike project chat (whose `AgentEngine` lives in the Bun backend process and survives a webview refresh, with `project.tsx`'s `syncRunningAgents` re-querying it on every mount via `getPmStatus`/`getRunningAgentsForConversation`), General Chat's `isSending`/streaming state was pure local React state that reset to `false`/empty on every mount — so navigating away and back, or a full page refresh, while the Assistant was still generating left the Stop button and busy indicator gone even though `orchestrator.ts`'s turn (and its `abortControllers` entry) was still genuinely running server-side; the final reply still arrived correctly (persistence happens unconditionally when the turn completes, and the live broadcast listeners re-subscribe on the new mount), but everything in between looked broken. Deliberately scoped narrower than project chat's fix: no `message_parts`-equivalent table was added, so a reconnect does **not** replay the tool calls made before the reload — matches General Chat's existing "no tool-call persistence, only final text" design (see "Generated images survive reload" above). Fixed with one new RPC, `getGeneralChatStatus(conversationId)` (thin wrapper over `orchestrator.ts`'s existing `isGeneralChatRunning`), called from `general-chat.tsx`'s per-conversation load effect; if the backend reports a turn in flight, `isSending` is set `true` (never set `false` from this check, so it can't race a send that starts locally while the lookup is in flight) — `AssistantTypingRow` and the Stop button already render correctly off `isSending` alone with no tool-call history, and the existing live listeners take over seamlessly once real events start arriving again.

**Fixed: false "could not verify a real tool call" failures.** `runInlineAgent`'s Claude Subscription CLI/SDK path (`claude-subscription-cli-runner.ts`'s `runClaudeCliTask`) defaults to requiring at least one real tool call per turn or failing the response as possibly-fabricated — correct for sub-agent/Playground tasks (always concrete/actionable) but wrong for a conversational surface, where a plain "hi" reply with zero tool calls is normal. PM chat (`engine.ts`) already passes `verifyToolCall: false` to sidestep this; General Chat called `runInlineAgent` directly and had no equivalent override, so ordinary conversational replies could misfire the guard. Fixed by adding `verifyToolCall?: boolean` to `InlineAgentOptions` (threaded through to the CLI runner call in `agent-loop.ts`) and setting it `false` in the orchestrator's `runInlineAgent` call — same pattern dashboard/collections/freelance/skills chat already use.

**Fixed: the global Streaming setting had no visible effect on General Chat.** Turned out General Chat's live text was never rendered at all, in any mode — `InlineAgentCallbacks.onTextDelta` (what `general-chat.tsx`'s `streamingText` state was wired to) is genuinely never called anywhere in `agent-loop.ts`; it's only invoked by PM chat's/the six widget-chat surfaces' own separate direct-`streamText` loops, not by `runInlineAgent`. The real live-text mechanism `runInlineAgent` provides is part-based: in `streamingMode === "full"`, `pushLiveDelta` creates/updates a `type: "text"` message part as tokens arrive; General Chat's `onPart` handler only ever handled `type: "tool_call"`, and `generalChatPartUpdated` had no listener at all. Fixed on two levels: (1) `general-chat.tsx` now handles `"text"` parts too — tracks the live part's id (`streamingTextPartIdRef`) and a `streamingCommittedTextRef` prefix so a later step's fresh part (e.g. "let me check that…" → tool call → final answer, each step gets a new part id) appends onto what's already shown instead of blanking it; a real `agentdesk:general-chat-part-updated` listener was added (`onPartUpdated`) to consume the DB-parity content updates `pushLiveDelta` actually sends. (2) General Chat has no sub-agent-card concept, so Hybrid's entire reason to differ from Full doesn't apply to it — `orchestrator.ts` now resolves the global mode itself and passes `streamingModeOverride: "full"` when it's `"hybrid"` (an explicit `"none"` is left alone, still a real opt-out). See `streaming-mode.ts`'s updated doc comment and the Settings → AI → Streaming page's Hybrid description for the same clarification. The pre-existing `onTextDelta`/`generalChatTextDelta` plumbing was left in place (harmless dead code) rather than removed — it's a wider gap affecting every `runInlineAgent`-based caller (Playground, sub-agent cards, issue-fixer, etc.), out of scope for a General-Chat-specific fix.

**Top nav parity — title.** `app-shell.tsx`'s global `TopNav` defaulted to the bare app name ("AgentDesk") for `/general-chat` since it wasn't in the `PAGE_TITLES` map. Added `"/general-chat": "General Chat"`. (A per-conversation "Open Workspace in Explorer" folder icon was also briefly added here, mirroring Playground's, but was reverted the same session once General Chat became workspace-less — see below; General Chat now always falls into `TopNav`'s generic no-workspace `else` branch, same as any other non-project page.)

**Fixed: `write_file`/`edit_file`/etc. worked despite being removed from Assistant's tool grant.** `agent-loop.ts` merged `trackedFileTools` (the real, workspace-bound implementation of `read_file`/`write_file`/`edit_file`/`multi_edit_file`/`patch_file`/`append_file`/`delete_file`/`move_file`) into the final tool set **unconditionally**, regardless of `baseTools` (the agent's actual `agent_tools`-filtered set) — so removing these from `defaultAgentTools["assistant"]` had no real effect; Assistant could (and did — confirmed live, a file was written to its hidden temp folder despite zero `write_file` rows in `agent_tools`) still call them. Pre-existing bug, not introduced by the tool-list cut above — it only went unnoticed because the 3 `READ_ONLY_AGENTS` (code-explorer/research-expert/task-planner) mask it via a separate, blunt post-hoc strip (`filterReadOnlyTools`), and no other agent previously needed a *partial* file-tool grant while staying a non-read-only agent. Fixed by making the `trackedFileTools` merge an overlay — only replaces a tool name already present in `baseTools` with its tracked implementation, never adds one baseTools didn't already grant (same pattern as the existing memory-tools/deep_research overlays in this file). Also protects any custom agent with `write_file` unchecked in Settings → Agents → Tools, which had the identical silent gap.

**Redesigned: Assistant is workspace-less and has no `run_shell`.** Two deliberate architectural decisions, not bugs: General Chat should read/answer directly like a ChatGPT-style assistant, never create or manage files, and never run shell commands. Implemented as:
- **Tool set cut** (`seed.ts`'s `defaultAgentTools["assistant"]`) from a 32-tool file/process/shell-capable list down to the 14 listed in "Tools" above — no write/edit/delete/directory-browsing tools, no `run_shell`. A new migration, `v63_assistant-workspace-less.ts` (mirrors the `v54_research-expert-tool-cleanup.ts` precedent), deletes all existing `agent_tools` rows for `assistant` so existing installs' now-removed tool grants (sitting there forever otherwise — `seedAgentTools()`'s per-boot backfill only ever *adds* missing rows, never removes stale ones) actually disappear, not just new installs'. `assistant` is never exposed in the Agents UI, so there's no user-customization this could clobber.
- **No workspace *knowledge*, but still a hidden, real one under the hood.** `agent-loop.ts` unconditionally prepends `"Workspace: <path>\nAll file operations must stay within this directory.\n\n"` to *every* `runInlineAgent` caller's system prompt whenever a `workspacePath` exists — a mechanism entirely separate from `seed.ts`/`prompts.ts`. Simply editing the base prompt text wouldn't have removed this. Fixed by gating it on `agentName !== "assistant"` (mirrors the existing `agentName !== "assistant"` exclusion right below it for the memory-tools overlay). `orchestrator.ts` still passes a real, per-conversation temp path (`getGeneralChatWorkspacePath`, unchanged) into `runInlineAgent` — it's just never mentioned to the model. This keeps `read_file`'s `validatePath` boundary (throws if a path resolves outside `workspacePath`) and gives `generate_image`/`take_screenshot` somewhere to write before their output is embedded as base64 (see "Generated images survive reload" above) — removing the path entirely would have made `read_file` accept *any* absolute path on the user's filesystem with no boundary at all, a worse outcome than a silent, scoped one.
- **`seed.ts`'s base prompt:** dropped the `## Your workspace` section entirely; folded a new instruction into `## Style` — give every answer directly in the chat reply, in full, never say it'll "save" or "create a file" (no file-writing tools, nowhere for it to go), and note that `read_file`/`read_image`/`read_audio` still work for something the user attaches.
- **UI:** `ModelSelector` (shared with project chat) gained a `hideShellApproval` prop, passed by General Chat — its "Shell: Ask"/"Shell: Auto" toggle is meaningless with no `run_shell` tool to gate. Removed `general-chat.tsx`'s `ShellApprovalCard` rendering block and its `shellApprovalRequests` store subscription (added a few fixes ago for exactly this — now permanently unreachable, since Assistant can never trigger a shell-approval request). Empty-state copy ("...in its own workspace") reworded to drop the workspace mention.
- **`log_decision` excluded too.** Same unconditional-grant pattern as the "Workspace: ..." prompt injection above, just for a different tool: `agent-loop.ts`'s decisions-tool block (`workspacePath ? createDecisionsTool(workspacePath) : {}`) hands `log_decision` to *any* agent with a workspace, regardless of `agent_tools` — it's never a row in any agent's `agent_tools` at all, granted purely by having a workspace, by design, for every other caller (including read-only agents like `task-planner`). Assistant's workspace is the same hidden, per-conversation temp folder — a `DECISIONS.md` logged there would be pure noise nobody ever reads. Gated with the same `agentName !== "assistant"` condition.
- **Plugin tools excluded too — a real leak, not hallucination.** Initially misdiagnosed: checking `agent_tools` for plain names like `lsp_diagnostics` found nothing, so a model reply claiming LSP capability was assumed to be hallucination. Wrong — plugin-registered tools (e.g. LSP Manager's `lsp_diagnostics`/`lsp_hover`/`lsp_definition`/`lsp_references`/`lsp_document_symbols`) are namespaced under a *prefixed* name (`plugin__<plugin-name>__<tool-name>`, `plugins/api.ts`'s `registerTool`) — a different name than the plain `agent_tools`-facing one, and `getPluginTools()`'s result was merged into every agent's tool set unconditionally, same bug shape as the other two. Confirmed live: LSP Manager was genuinely enabled (`plugins` table), so Assistant really did have working diagnostics/hover/definition/references/symbols tools — that reply wasn't hallucinated. There's no per-agent grant/deny for plugin tools at all (same tier as MCP tools, app-wide only) — since Assistant's whole tool set is meant to be a fixed, curated list, `pluginTools` is now skipped entirely for `agentName === "general-chat-assistant"`, not just for the currently-installed LSP plugin, so a future plugin can't reopen the same gap.
- **New: `execute_code` — scoped Python/JavaScript execution.** A narrow substitute for the `write_file`/`run_shell` grant Assistant deliberately lacks: `agents/tools/general-chat-code-exec.ts`'s `createGeneralChatCodeExecTool(workspacePath)` returns a single tool that writes the given snippet to a temp script file and runs it, cwd fixed to the conversation's own ephemeral temp workspace, with a short default timeout, output truncation, and a best-effort dangerous-pattern blocklist (same honest limitation as `shell.ts`'s own `BLOCKED_PATTERNS` — not adversarial-proof). Injected via `extraTools` at the orchestrator call site only, like the memory/todo tools above — never added to the shared `toolRegistry`, so no other agent can be granted it, and there's deliberately no interactive approval step (General Chat has no project/workspace concept to gate against; the safety net is scope, not a prompt). JavaScript always runs via `process.execPath` — the app's own already-running Bun binary, proven elsewhere in this codebase (`lsp/installer.ts`'s `Bun.spawn([process.execPath, "add"/"remove", ...])`) to work as a genuine CLI invocation regardless of packaging; deliberately **not** `Bun.which("bun")`, which only finds a separately-installed, PATH-registered bun and would fail for nearly every end user who never installed Bun themselves. Python resolves via `Bun.which("python3") ?? Bun.which("python")` (some machines have one but not the other) and may simply not be installed — since every install has its own set of interpreters on PATH, availability is detected fresh per app session (cached, not re-probed per call) and injected directly into the tool's own `description` (`describeAvailability()`, preferred over a system-prompt note — it can't drift from what's actually on THIS machine and costs the model nothing to read), so the model knows upfront not to waste a call on a language that isn't there.
- **Fixed: context meter used a hardcoded 1M-token estimate.** `GeneralChatContextIndicator` divided its char/4 token estimate by a flat `CONTEXT_LIMIT_ESTIMATE = 1_000_000` regardless of the actual selected model, while the backend's own auto-compaction trigger (`orchestrator.ts`'s `sendMessage`) already checked the real `getContextLimit(modelId, conversationId)` — for a smaller-context model the bar could read nearly empty right up to the turn the backend silently compacted. Fixed with a new `getGeneralChatContextLimit(conversationId)` RPC (calls the same `resolveProviderConfig`/`getContextLimit` pair the backend uses), fetched on mount and on `agentdesk:settings-changed` (mirrors `context-indicator.tsx`'s own load pattern), plus a new `generalChatContextUsage` broadcast wired to `InlineAgentCallbacks.onStepUsage` (real per-step token usage, not a guess) and `generalChatComplete`'s payload gaining `promptTokens`/`contextLimit`. `GeneralChatContextIndicator` now takes both as props instead of recomputing a flat estimate, while staying deliberately independent of the shared `useChatStore`-based `ContextIndicator` (same staleness reasoning as before).
- **Fixed: cross-conversation search was dead code.** `ConversationSidebar` (shared by General Chat, Quick Chat, and project chat) had working filter logic (`filtered = conversations.filter(...)`) wired to `const searchQuery = ""` — a hardcoded empty string, no input box. Added a real search box in the sidebar header (title-only match, same as the pre-existing filter) — fixes all three surfaces at once since they share the one component.
- **Removed: `/mcp` slash command app-wide.** Dropped from the shared `SLASH_COMMANDS` array (`chat-input-popover.tsx`) and General Chat's `GENERAL_CHAT_SLASH_IDS` filter, plus the now-unreachable `case "mcp"` handlers in `chat-input.tsx` and `general-chat.tsx` (`handleMcpStatus`, orphaned once unreachable, removed too). The persistent "N MCP servers" toolbar button/dialog both surfaces already have is untouched — this only removed the redundant slash-triggered ephemeral-bubble path into the same information.
- **Removed: the "never fabricate a markdown image link" `## Style` instruction.** Added in an earlier pass after a free/weak model hallucinated an external stock-photo URL; removed per explicit request.
- **Fixed: `execute_code`-generated images (e.g. a matplotlib chart) never rendered — two independent sanitizers, not one.** The model correctly base64-encoded the image and wrote a markdown `![...](data:image/png;base64,...)` link, but it still rendered as literal text with an empty `<img src="">`. Two separate layers both strip `data:` URIs and both had to be fixed: (1) `rehype-sanitize`'s default schema only allows `http`/`https` for `<img src>` — fixed via `src/mainview/lib/markdown-sanitize-schema.ts`'s `markdownSanitizeSchema` (`defaultSchema` + `data` added to `protocols.src`). (2) `react-markdown` itself independently re-sanitizes every `src`/`href` through its own `urlTransform` prop (default: `defaultUrlTransform`), whose protocol allowlist (`http(s)`/`irc(s)`/`mailto`/`xmpp`) has no `data` entry either — this runs regardless of the rehype-sanitize schema and was the one actually emptying the `src`, discovered only by rendering the exact stored message through `react-dom/server` and seeing React's own "empty string passed to src" warning. Fixed with the same file's new `markdownUrlTransform(url, key)` — allows `data:image/...;base64,` only for `key === "src"` (images), falling back to `defaultUrlTransform` for everything else so a clickable `data:text/html,...` link can't slip through. Root cause was app-wide, not General-Chat-specific: all 16 files calling `rehypeSanitize`/`previewOptions` with no schema/urlTransform had the same two-layer gap (`@uiw/react-md-editor`'s `previewOptions` forwards both straight through to its own bundled react-markdown). Both `markdownSanitizeSchema` and `markdownUrlTransform` are imported together at every one of those 20 call sites — one source of truth, rather than a per-surface patch. General Chat's `buildMdComponents` also gained an `img` override (`max-w-full rounded-lg`, matching `message-bubble.tsx`'s existing one) so a rendered image doesn't blow up the layout. Superseded for `execute_code` specifically by the next fix below — its own output no longer takes this markdown path at all — but this remains the real, still-relevant fix for any other markdown-rendered `data:` image (a model manually writing one, a pasted one, etc.).
- **Fixed: `execute_code` streamed the entire base64 image as retyped output text — slow and expensive, and the actual cause of the above bug's root problem.** The original recipe told the model to print the markdown image line, then copy it verbatim into its own reply — meaning the model had to regenerate thousands of output tokens of base64 data character-by-character as part of its own streamed text (slow to stream, wasteful of output tokens, and the reason the frontend visibly lagged while re-parsing a growing multi-KB "word" on every incoming token). This mirrors a problem already solved once in this codebase for `generate_image`/`take_screenshot` (see `screenshot.ts`'s `extractImagePayload`/`imageToolModelOutput` — a raw base64 payload embedded as tool-result text gets tokenized character-by-character and can blow a small-context model's request budget) — same fix pattern applied here: `general-chat-code-exec.ts` now scans the script's raw stdout (before `truncateShellOutput`, which would otherwise corrupt a large base64 blob mid-string) for a bare `data:image/<mime>;base64,<data>` line (`DATA_IMAGE_URI` — deliberately not a markdown link anymore, simpler to extract unambiguously; only the first match per run is captured, same single-image assumption `generate_image` makes), moves it into an `image: { type, mimeType, base64 }` field on the tool's raw JSON result (same shape `extractImagePayload` already expects), and replaces it in-place with a short "already shown to the user" placeholder. A new `toModelOutput: ({ output }) => imageToolModelOutput(output)` (reusing the existing helper) strips that `image` field back out before the model's own context ever sees it — so nothing is ever retyped. `execute_code` was added to `orchestrator.ts`'s `IMAGE_OUTPUT_TOOLS` set, so the same `<generated-image>`-embedding path `generate_image` already uses picks it up automatically (zero frontend changes — `GeneralChatBubble`'s existing `extractGeneratedImages`/`GeneratedImages` renders it). Also added `execute_code` to `agent-loop.ts`'s `isImageTool` truncation-limit check (500,000 chars instead of the default 10,000) so a real base64 payload isn't chopped before it reaches `extractImagePayload`. Matches how ChatGPT's Code Interpreter and Claude.ai's own code-execution tool both work: binary output leaves the sandbox as structured tool-result data, never as text tokens the model has to reproduce.
- **Fixed: the image capture above still silently failed on Claude Subscription (Sonnet/Opus) — the exact "two-path provider" gotcha this file's Critical Rules section warns about.** `agent-loop.ts` has two independent tool-result-recording code paths: the normal AI SDK step-processing loop (~line 1839, where the `isImageTool`/500,000-char fix above was first applied), and a **separate** one used only by `isClaudeSubscriptionViaCli` (Sonnet/Opus over the Agent SDK/CLI runner, not the direct-HTTP Haiku path — see the Critical Rules entry) — its own `onToolCallEnd` callback (~line 1404) had a hardcoded `toolOutputLimit = 10_000` with no image exception at all, inherited unmodified from before any image tool needed a higher limit. Confirmed live: a real chart's base64 (~11,364 chars) got silently truncated to 10,000 + `"... (truncated)"`, corrupting the JSON so `extractImagePayload`'s parse failed and no `<generated-image>` tag was ever embedded — diagnosed with a temporary raw-stdout debug trace (removed once confirmed) proving `execute_code`'s own extraction regex matched correctly, isolating the bug to this second, easy-to-miss path. Fixed by mirroring the same `isImageTool` check (same tool-name list, same 500,000-char limit) in this callback too. While investigating, confirmed `claude-subscription-cli-runner.ts:361` needs no changes — it already generically checks `extractImagePayload(result)` for *any* tool result (not a hardcoded name allowlist), so on this path the model genuinely receives the chart as a real MCP image content block (true vision input), for free, once the truncation stopped corrupting the payload.
- **Moved: "New conversation" from the sidebar to the main app navbar.** `ConversationSidebar` gained a `hideCreateButton` prop (default `false`, only General Chat passes it) so its own built-in button can be hidden without affecting project chat/Quick Chat, which still render it. General Chat now registers an equivalent button via `useHeaderActions` (`header-context.tsx` — the same mechanism Playground/Council/Inbox/Agents/Dashboard/Skills/Prompts already use to inject page-specific buttons into `TopNav`'s right slot), so it sits opposite the "General Chat" title in the main navbar instead. The sidebar itself also widened from `w-[220px]` to `w-[260px]` (General Chat has no per-project chrome competing for that space, unlike `chat-layout.tsx`'s sidebar, which stays at the original width).
- **Internal agent name renamed `assistant` → `general-chat-assistant`.** The bare name `assistant` was too easy for a user to also give a custom agent (Settings → Agents accepts any string) — a collision would wrongly hand that custom agent every `agentName === "assistant"` special-case above (workspace-less, no plugin tools, no `log_decision`, hidden from the Agents page/PM dispatch list). Renamed everywhere it's checked (`agent-loop.ts`, `prompts.ts`, `rpc/agents.ts`, `general-chat/orchestrator.ts`, `seed.ts`'s `defaultAgentDefs`/`defaultAgentTools`/`NO_MEMORY_AGENTS`). A new migration, `v64_general-chat-assistant-rename.ts`, renames the existing DB row (`UPDATE agents SET name = ...`, not delete+reinsert, so its id — and existing `agent_tools` rows — stay attached), scoped to `is_builtin = 1` and skipped if a row already holds the target name, so it can never clobber an actual user-created custom agent. Also dropped `take_screenshot`/`environment_info` from the tool grant in the same pass (no screenshot/env-info use case for a workspace-less chat agent) — `v64` wipes `agent_tools` for a fresh reseed, same pattern as `v63`. `orchestrator.ts`'s `IMAGE_OUTPUT_TOOLS` set (which embeds a tool's base64 output into the persisted message) dropped `take_screenshot` accordingly — `generate_image` is the only one left.

---

## Ambient Mode (screensaver-style voice/status overlay)

Full design/rationale in `docs/ambient-screen-plan.md`. A Dashboard button (and an app-focus-scoped idle timer) opens a full-screen "Beacon" radar overlay showing live cross-project agent/task activity, with a tap-to-toggle voice Q&A pane.

**Overlay pattern (reusable):** unlike Quick Chat, this is **not** a second window for the default case — it's a fixed, full-viewport component mounted once at the app-shell level (`ambient-screen.tsx`, same tier as `UserQuestionDialog`/`Toaster`), shown via a small zustand store (`useAmbientStore`'s `open` boolean) rather than a route change. This means it inherits every `broadcastToProject` event the Dashboard already gets for free, and closing it returns to whatever page/conversation was underneath with no navigation round-trip. Worth reusing for any future full-screen-overlay-over-the-whole-app feature that doesn't need OS-level multi-window behavior.

**Voice — the Ambient Assistant (reusable pattern):** full design in `docs/ambient-pm-voice-plan.md`. STT reuses the existing `useVoiceInput` hook, wrapped by `use-ambient-voice-turn.ts` to add pause-based auto-stop (a debounce timer on transcript changes — no button tap needed to end a turn). The transcript is NOT routed through `chat-store`'s per-project `sendMessage` — it goes to `runAmbientAssistantTurn` (`src/bun/ambient/assistant.ts`), a lightweight **one-shot cross-project tool-calling turn**, distinct from the per-project `AgentEngine`: no persisted conversation of its own, mirrors `rpc/dashboard-agent.ts`'s dual-path model invocation (Claude Subscription CLI runner for non-Haiku, plain `streamText` otherwise). Its tools are mostly thin wrappers around data the app already computes (project/agent/task/inbox/scheduler/freelance/git status); the one write tool, `dispatch_to_project`, creates a new persisted conversation in the named project and calls that project's own `sendMessage` — a real handoff, not a bypass of the normal plan-approval pipeline. On turn-end, an instant spoken acknowledgment (`generateQuickAck`, wording generated per-question) plays first; the real turn's tool calls stream live into a side pane (`ambient-tool-call-pane.tsx`) via the `ambientAssistantPart` push event, and its answer speaks once ready — sequenced through `useTextToSpeech`'s `speak()`, which returns a promise resolving on utterance-end so the two spoken parts never cut each other off. Replies speak via `speechSynthesis` by default, or a configured speech-model's generated audio (`useAmbientVoicePlayback`, Settings-driven) — this pattern (a one-shot, non-persisted, cross-cutting tool-calling turn reusing an existing chat surface's dual-path model invocation) is worth reusing for any future "ask across everything" assistant surface that isn't scoped to one project/conversation.

**"Project to display":** the one case that genuinely needs a second `BrowserWindow` — a physical second monitor/TV, positioned via `Screen.getAllDisplays()`'s bounds, with its own `createRpc()` instance (same reasoning as Quick Chat's window). That window belongs to no project, so `broadcastToProject` never reaches it; it polls `getAmbientActivitySnapshot()` every few seconds instead. Single window at a time (v1) — opening a new projection replaces whatever was already projected. Whether a projection is currently open is polled via `getAmbientProjectionState()` too — the projected window's own Exit button can close it independently of the main overlay's "Stop projecting" control, so the main overlay can't just trust its own local state.
