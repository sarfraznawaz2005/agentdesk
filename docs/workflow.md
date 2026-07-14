# AgentDesk — Workflow Architecture

This document describes the end-to-end workflow that governs how AgentDesk
processes human requests, plans work, obtains approval, dispatches agents, and
delivers results. It is the single source of truth for both human contributors
and AI agents working on this codebase.

---

## Table of Contents

1. [Overview](#overview)
2. [Core Principles](#core-principles)
3. [Message Flow](#message-flow)
4. [Scenarios](#scenarios)
5. [Planning Phase](#planning-phase)
6. [Approval Gate](#approval-gate)
7. [Kanban Creation (Post-Approval)](#kanban-creation-post-approval)
8. [Execution Phase](#execution-phase)
9. [Completion](#completion)
10. [Agent Failure Handling](#agent-failure-handling)
11. [Two-Way Channel Sync](#two-way-channel-sync)
12. [State Machine Reference](#state-machine-reference)
13. [Tool Reference](#tool-reference)
14. [Key Files](#key-files)

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

5. **One active workflow per conversation.** If a new feature request arrives
   while a workflow is active, the PM asks the human to finish or cancel first.

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
| `get_agent_status` | Returns running agent names and counts from the engine-manager. Used by PM for status checks. |
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

---

## Key Files

| File | Role |
|---|---|
| `src/bun/agents/engine.ts` | AgentEngine — PM streaming, inline sub-agent execution, soft approval gate |
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
| `src/bun/agents/tools/shell.ts` | `run_shell` with safety guards + shell approval gate |
| `src/bun/agents/tools/process.ts` | Background process tools: `run_background`, `check_process`, `kill_process` |
| `src/bun/agents/tools/web.ts` | Web tools: `web_search` (Exa→Tavily→DuckDuckGo auto-fallback), `web_fetch`, `http_request` |
| `src/bun/agents/tools/index.ts` | Tool registry — assembles and filters tools per agent role |
| `src/bun/agents/kanban-integration.ts` | Bridges kanban UI events to the agent engine |
| `src/bun/engine-manager.ts` | Creates/caches AgentEngine per project; global abort controller registry; `broadcastTaskDoneNotification`; project→window registry (`registerProjectWindow`/`broadcastToProject`) for Quick Chat windows |
| `src/bun/quick-chat/window.ts` | Opens/reuses a Quick Chat project's own `BrowserWindow`, sharing the main `rpc` object (Electrobun's documented multi-window pattern) |
| `src/bun/quick-chat/os-integration.ts` | Registers/unregisters the OS Explorer/Finder "Open in AgentDesk" entry |
| `src/bun/single-instance.ts` | Windows named-pipe single-instance handoff for Quick Chat launches |
| `src/mainview/pages/quick-chat.tsx` | Quick Chat's reduced-chrome page (Chat/Docs/Settings only) |
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

**Window/broadcast model:** a Quick Chat window is a second `BrowserWindow` (`quick-chat/window.ts`) reusing the same `rpc` object as the main window — each window's `webview.rpc.send` is an independent channel even though they share one handler-definition object (Electrobun's documented multi-window pattern). `engine-manager.ts` maintains a `projectId → window` registry; `broadcastToProject` routes every per-project engine event (streaming, tool parts, shell-approval/user-question) to the owning window only, falling back to the main window for ordinary projects; `broadcastToWebview` (global events like `showToast`) fans out to the main window **and** every open Quick Chat window.

**Launch path:** Windows registers `Directory\shell` + `Directory\Background\shell` entries (`--quick-chat "%V"`) via `quick-chat/os-integration.ts`; a `node:net` named pipe (`single-instance.ts`) lets a second launch hand its request to an already-running instance and exit immediately instead of booting fully — a Quick-Chat-only cold start skips the main window entirely and defers cron/automation/issue-fixer/plugin/channel init behind the Quick Chat window's own `dom-ready`. macOS instead registers a Finder Quick Action (Automator `.workflow` in `~/Library/Services`) that shells out to `open agentdesk://quick-chat?path=...`, handled by an `Electrobun.events.on("open-url", ...)` receiver — macOS's own Launch Services gives single-instance activation for free, no pipe needed. Both platforms are gated by the **"Allow Quick Chat"** setting (Settings → General, default **on** — existing installs auto-register on first launch after upgrading).
