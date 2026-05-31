# Sequential Agent Execution Model

> Design doc for the architectural change from parallel multi-agent dispatch to
> sequential single-write-agent execution with read-only parallel support.

---

## Problem

When the PM dispatches multiple write-agents (e.g. 3 `frontend_engineer` agents
for HTML, CSS, and JS files), each agent runs with a **fresh context** — no
knowledge of what prior agents created. This causes:

- Mismatched CSS class names between HTML and CSS files
- Mismatched DOM IDs between HTML and JS files
- Broken output despite each individual file being well-written

Tools like Claude Code and OpenCode avoid this by running a single agent that
writes all files sequentially with full conversation context between steps.

---

## Solution

### Core Rules

1. **PM can only spawn read-only agents in parallel** (`run_agents_parallel`).
2. **Only one write-agent runs at a time**, sequentially via `run_agent`.
3. **In workflow mode** (kanban tasks), agents are dispatched one at a time.
   When one finishes, a brief AI-generated handoff summary is passed to the next.
4. **In non-workflow mode**, a single agent handles the entire task start to
   finish (e.g. creating all 3 files for a todo app).
5. **All existing token-saving mechanisms are preserved** (between-iteration
   compaction, AI compaction at 75%, budget restarts, between-task pruning).
6. **Page refresh does not stop running agents** — backend continues, frontend
   reconnects and restores state via RPC.

### Read-Only vs Write Agents

| Category | Agents | Can Run in Parallel |
|----------|--------|---------------------|
| Read-only | `code-explorer`, `research-expert`, `task-planner` | Yes — via `run_agents_parallel` |
| Write | All others (`frontend_engineer`, `backend-engineer`, `software-architect`, `code-reviewer`, `qa-engineer`, `devops-engineer`, `debugging-specialist`, `performance-expert`, `security-expert`, `ui-ux-designer`, `data-engineer`, `refactoring-specialist`, `api-designer`, `database-expert`, `mobile-engineer`, `ml-engineer`) | No — one at a time via `run_agent` |

**Exception**: `code-reviewer` is auto-spawned by `review-cycle.ts` when a task enters the "review" column — it runs independently of the write-agent guard. This is fine because review happens after the write agent finishes.

**Enforcement**: The `READ_ONLY_AGENTS` set is defined in `src/bun/agents/agent-loop.ts` and validated in `pm-tools.ts`. Write agents are guarded by a `writeAgentRunning` boolean closure variable in `createPMTools`.

### Enforcement Mechanism

**PM `run_agent` tool** — closure-scoped boolean `writeAgentRunning`:
- Set `true` before `runInlineAgent()`, cleared in `finally`
- If PM emits two parallel `run_agent` tool calls in one LLM step, the second
  returns an error: "A write agent is already running."
- Read-only agents bypass the flag entirely.

**PM `run_agents_parallel` tool** — explicit agent name validation:
- Only agents in the `READ_ONLY_AGENTS` set are accepted.
- Write agents return an error: "Use run_agent for write-capable agents."

**PM kanban dispatch** — sequential by design:
- PM dispatches agents one write-agent at a time via `run_agent`.
- When one write agent finishes, PM evaluates remaining kanban tasks and dispatches the next.
- `maxConcurrentAgents` project setting has been removed — concurrency is now hard-coded to 1 for write agents.

### Workflow Handoff Summaries

When a workflow agent completes a kanban task, a handoff summary is generated
before dispatching the next agent:

1. Read the modified files (from `InlineAgentResult.filesModified`).
2. For small changes (<=3 files, <200 lines each): deterministic summary
   listing file names, key exports, class names, IDs found via regex.
3. For larger changes: lightweight AI call to summarize what was built.
4. Summary is prepended to the next agent's task description:
   ```
   ## Prior Work (from previous agent)
   {handoff summary}

   ## Your Task
   {kanban task description + acceptance criteria}
   ```
5. Summaries are stored in `WorkflowContext.handoffSummaries` for crash recovery.

### Frontend Resilience on Page Refresh

- Backend agents run in Bun process — unaffected by webview reload.
- `broadcastToWebview` calls fail silently during refresh (existing try/catch).
- New RPC `getRunningAgents(projectId)` returns names from `runningAgentControllers`.
- Frontend calls this on page load to restore `isBusy` state and agent cards.

### Removed

- `maxConcurrentAgents` project setting (UI + backend reads).
- `currentSubAgent` field on `AgentEngine` (was never populated — dead code).

---

## How This Fixes the Todo App

**Non-workflow mode**: PM dispatches a single `frontend_engineer` with the full
task "build a todo app with index.html, styles.css, and app.js". One agent
creates all files sequentially with full context — CSS matches HTML class names.

**Workflow mode** (kanban tasks):
1. Task 0: `frontend_engineer` creates `index.html` with `class="input-group"`, `id="todo-input"`, etc.
2. Handoff summary generated: "Created index.html with classes: container, input-group. IDs: todo-input, add-btn, todo-list."
3. Task 1: `frontend_engineer` gets handoff + task → creates `styles.css` targeting `.input-group`, `#todo-input`, etc.
4. Task 2: `frontend_engineer` gets handoff + task → creates `app.js` using correct selectors.

---

## Files Changed

| File | Change |
|------|--------|
| `src/bun/agents/agent-loop.ts` | Export `READ_ONLY_AGENTS` constant; inline executor replaces `sub-agent.ts` |
| `src/bun/agents/tools/pm-tools.ts` | `writeAgentRunning` guard in `run_agent`; validate read-only in `run_agents_parallel`; removed `isCodeAgentRunning` dep |
| `src/bun/agents/handoff.ts` | `generateHandoffSummary()` — deterministic (small changes) + AI (large changes) |
| `src/bun/agents/engine.ts` | Removed `currentSubAgent`; removed `isCodeAgentRunning` from PMToolsDeps; `handoffSummaries` on context object |
| `src/bun/agents/engine-types.ts` | Removed `isCodeAgentRunning` from callback types; added handoff summary types |
| `src/bun/agents/prompts.ts` | Strengthened PM prompt re: sequential dispatch + handoff context |
| `src/bun/engine-manager.ts` | `runningAgentControllers` Map; `registerAgentController` / `unregisterAgentController` / `abortAllAgents` / `getRunningAgentCount` / `getRunningAgentNames` |
| `src/bun/rpc-registration.ts` | Registered `getRunningAgents` RPC |
| `src/shared/rpc/agents.ts` | Added `getRunningAgents` contract |
| `src/mainview/stores/chat-store.ts` | `syncRunningAgents()` on page load; `runningAgentCount` incremented on `agentInlineStart`, decremented on `agentInlineComplete` |
| `docs/workflow.md` | Updated execution phase docs |
| `CLAUDE.md` | Updated agent roster notes |
