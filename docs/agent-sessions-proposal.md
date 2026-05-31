# Agent Sessions — Design Document

> **STATUS: SUPERSEDED** — This proposal was initially implemented in v3 but **reversed in v4** when the inline agent model replaced persistent agent sessions.
>
> **Current state (v4+):**
> - Agent session tables (`agent_sessions`, `agent_session_messages`) were **dropped** in migration v4 (`src/bun/db/migrations/v4_inline-agents.ts`)
> - Sub-agents now run **inline** with fresh context per invocation — no persistent session memory
> - The inline model proved simpler and more reliable than session-based continuity
> - `agent_task_results` table was also dropped as obsolete
>
> **Historical note:**
> The v3 implementation included:
> - Database: `agent_sessions` and `agent_session_messages` tables created via raw SQL in `src/bun/db/migrations/v3_agent-sessions.ts`
> - Sub-agent executor: `agent-loop.ts` (replaced `sub-agent.ts`) accepts `sessionMessages` option and returns `newMessages` in `AgentResult`
> - Session lifecycle (load/save/summarize): implemented in `src/bun/agents/engine.ts`
> - `FileTracker.trackWrite()` / `getModifiedFiles()`: implemented in `src/bun/agents/tools/file-tracker.ts`
> - Summarization threshold: 40k tokens (as proposed); per-session lock prevents concurrent summarization
>
> The v4 migration dropped all session tables in favor of the simpler inline execution model where each agent invocation is stateless.

---

## Purpose

This document defines the **Agent Sessions** feature for AgentDesk. It describes the problem, the proposed solution, database changes, code changes, edge cases, and token economics.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Feature Summary](#2-feature-summary)
3. [Key Features](#3-key-features)
4. [Current Flow (Before)](#4-current-flow-before)
5. [Proposed Flow (After)](#5-proposed-flow-after)
6. [Database Changes](#6-database-changes)
7. [Code Changes](#7-code-changes)
8. [Session Lifecycle](#8-session-lifecycle)
9. [Session Keying Strategy](#9-session-keying-strategy)
10. [Token Economics](#10-token-economics)
11. [Edge Cases](#11-edge-cases)
12. [What Does NOT Change](#12-what-does-not-change)
13. [Comparison to Other AI Coding Tools](#13-comparison-to-other-ai-coding-tools)
14. [Implementation Order](#14-implementation-order)

---

## 1. Problem Statement

Every sub-agent invocation in AgentDesk is **stateless**. When the PM dispatches a sub-agent (e.g., Frontend Engineer), it receives exactly **one user message** containing the task description:

```typescript
// sub-agent.ts, line 530
messages: [{ role: "user", content: userMessage }]
```

Within that single invocation, the AI SDK's `maxSteps: 100` gives the agent multi-turn tool use — it sees its own tool calls and results. But **across invocations**, there is complete amnesia. The agent has no memory of:

- What files it previously wrote and why
- Design decisions it made
- Its prior reasoning and thinking
- Tool calls it executed

### When This Breaks Down

| Scenario | What Happens Now | What Should Happen |
|---|---|---|
| **Review fix cycle** | Code reviewer finds bugs → same agent type re-spawned with a fresh instance. New instance has NO memory of what it built or why. Must re-read all files from scratch. | Agent remembers writing the code, understands the reviewer's feedback in context of its own decisions. |
| **Multi-task same agent** | PM: "build todo app" → FE does it. PM: "add dark mode" → NEW FE instance starts blank. Gets a 150-char summary from `agent_task_results`. | Agent picks up where it left off, knows the CSS architecture it chose, references its own prior work. |
| **Test failure fix** | QA finds bugs → fix agent dispatched with test output. Agent has no idea what the original agent's intent was. | Fix agent sees the original implementation context + test results, makes targeted fixes. |
| **Context waste** | Every re-dispatch burns tokens re-reading files, re-discovering project structure. For a 10-file project, that's ~5,000–7,500 tokens wasted per re-dispatch. | Agent already knows what files exist and what's in them from prior invocations. |

### Why This Isn't a Correctness Bug (But Still Matters)

For a **single-task, single-invocation** scenario (e.g., "build a todo app"), the current flow works fine — the agent reads, writes, and finishes within one invocation. The filesystem is the source of truth, so re-reading files on re-dispatch produces correct results.

The problem is **efficiency and coherence**:
- Tokens wasted on re-discovery
- Loss of design rationale across invocations
- Reviewer feedback disconnected from original intent
- No continuity for iterative improvement cycles

---

## 2. Feature Summary

**Agent Sessions** give each agent type a persistent conversation history within the scope of a main conversation. When the same agent type is re-dispatched in the same conversation, it continues its session instead of starting fresh.

```
Main Conversation #5 (PM <-> User)
  |
  +-- frontend_engineer session: [task A] [tool calls...] [response] [task B] [tool calls...] [response]
  +-- backend-engineer session:  [task C] [tool calls...] [response]
  +-- code-reviewer session:     [review task] [tool calls...] [response]
```

---

## 3. Key Features

1. **Persistent agent context** — Each agent type maintains its own conversation history within a main conversation. Re-dispatched agents see their prior work, tool calls, and reasoning.

2. **Session summarization** — When a session exceeds ~40k tokens, older messages are summarized (same mechanism as PM conversation summarization). This bounds token growth regardless of how many times an agent is re-dispatched.

3. **Session keying by agent name** — Sessions are keyed by `(conversation_id, agent_name)`. All invocations of the same agent type in a conversation share one session. This ensures review fix cycles and sequential tasks maintain continuity.

4. **Concurrent same-type agent isolation** — When multiple agents of the same type run concurrently (e.g., "spawn 3 frontend engineers"), each concurrent invocation gets its own session via a suffix mechanism.

5. **Provider-agnostic** — Sessions are purely an application-layer concept. We persist and load messages ourselves, then pass them as a `messages` array to the AI SDK's `streamText`. Works with Anthropic, OpenAI, OpenRouter, Ollama, and any future provider.

6. **Crash-safe** — Sessions are persisted to SQLite. Engine restarts, app crashes, or page navigation don't lose session state.

7. **Zero overhead for single-use agents** — If an agent is dispatched once and never re-dispatched, the session messages are persisted to DB but never loaded again. No token overhead — just minimal storage.

8. **Enhanced cross-agent awareness** — `agent_task_results` enhanced with `files_modified` column populated from FileTracker data, making `get_completed_work` and `_buildSiblingContext()` more informative.

---

## 4. Current Flow (Before)

### First Dispatch

```
PM dispatches frontend_engineer:
  1. engine.ts: runInlineAgent() creates agent loop run
  2. System prompt from seed.ts injected
  3. agent-loop.ts: runAgentLoop() called with:
     - system: agent's system prompt
     - messages: [{ role: "user", content: "## Task\n..." }]  ← SINGLE MESSAGE
  4. AI SDK iterates (generateText loop with compaction between iterations)
  5. Agent completes → result injected into PM conversation
  6. Result saved to agent_task_results table
```

### Re-Dispatch (review fix cycle)

```
Reviewer finds bugs → review-cycle.ts re-dispatches frontend_engineer (NEW invocation):
  1. engine.ts: runInlineAgent() — FRESH context, no memory of prior run
  2. agent-loop.ts: runAgentLoop() called with:
     - system: same system prompt
     - messages: [{ role: "user", content: "## Task\nFix CSS bugs: ..." }]  ← SINGLE MESSAGE
  3. Agent must re-read ALL files to understand what exists
  4. Agent has no idea WHY it made prior decisions
  5. Wastes ~5,000+ tokens on re-discovery
```

### Data Flow Diagram (Current)

```
User → PM Conversation → run_agent → agent-loop.ts (one-shot)
                                              |
                                              ↓
                                         filesystem (read/write)
                                              |
                                              ↓
                                      result summary → PM conversation
                                                    → agent_task_results table
```

---

## 5. Proposed Flow (After)

### First Dispatch

```
PM dispatches frontend_engineer:
  1. engine.ts: runInlineAgent()
  2. NEW: _resolveSessionName() → look up agent_sessions for (conversationId, "frontend_engineer")
  3. No session found → create new session row
  4. agent-loop.ts: runAgentLoop() called with:
     - system: agent's system prompt
     - messages: [{ role: "user", content: "## Task\n..." }]  ← same as before
  5. Agent works (tool calls, reasoning, text output)
  6. NEW: _saveSessionMessages() → save new messages to agent_session_messages after completion
  7. Result injected into PM conversation (unchanged)
  8. Result saved to agent_task_results (unchanged, + files_modified)
```

### Re-Dispatch (review fix cycle)

```
Reviewer finds bugs → review-cycle.ts re-dispatches frontend_engineer:
  1. engine.ts: runInlineAgent()
  2. NEW: _resolveSessionName() → look up agent_sessions for (conversationId, "frontend_engineer")
  3. Session found → _loadAgentSession() loads prior messages from agent_session_messages
  4. NEW: If session > threshold → _summarizeAgentSession() before loading
  5. agent-loop.ts: runAgentLoop() called with:
     - system: same system prompt
     - messages: [
         ...priorSessionMessages,  ← agent's own prior work
         { role: "user", content: "## New Task\nFix CSS bugs: ..." }
       ]
  6. Agent sees full prior context → knows what it built, why, design decisions
  7. Skips redundant file reads → makes targeted fix
  8. NEW: _saveSessionMessages() → append new messages to session
```

### Data Flow Diagram (After)

```
User → PM Conversation → run_agent → agent-loop.ts
                                              |
                                              ↓
                                    agent_session (load prior msgs)
                                              |
                                              ↓
                                         filesystem (read/write)
                                              |
                                              ↓
                                    agent_session (save new msgs)
                                              |
                                              ↓
                                      result summary → PM conversation
                                                    → agent_task_results table
```

---

## 6. Database Changes

### New Table: `agent_sessions`

Tracks one session per agent type per conversation.

```sql
CREATE TABLE agent_sessions (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent_name      TEXT NOT NULL,    -- base name: "frontend_engineer", "code-reviewer", etc.
  total_tokens    INTEGER NOT NULL DEFAULT 0,  -- estimated total tokens for summarization trigger
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(conversation_id, agent_name)
);
```

### New Table: `agent_session_messages`

Stores the conversation history for each agent session.

```sql
CREATE TABLE agent_session_messages (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id      TEXT NOT NULL REFERENCES agent_sessions(id),
  role            TEXT NOT NULL,    -- "user" | "assistant" | "tool"
  content         TEXT NOT NULL,
  -- JSON: for assistant messages with tool calls, stores AI SDK CoreMessage
  -- tool_invocations format so messages can be reconstructed for streamText
  metadata        TEXT,
  token_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Modified Table: `agent_task_results`

Add `files_modified` column to track which files each agent touched.

```sql
ALTER TABLE agent_task_results ADD COLUMN files_modified TEXT;
-- JSON array of file paths, e.g. ["src/index.html", "src/styles.css"]
-- Populated from FileTracker data after agent completion
```

### Drizzle Schema Additions (src/bun/db/schema.ts)

```typescript
// agent_sessions — persistent per-agent conversation within a main conversation
export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  agentName: text("agent_name").notNull(),
  totalTokens: integer("total_tokens").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// agent_session_messages — message history for an agent session
export const agentSessionMessages = sqliteTable("agent_session_messages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id").notNull().references(() => agentSessions.id),
  role: text("role").notNull(),     // "user" | "assistant" | "tool"
  content: text("content").notNull(),
  metadata: text("metadata"),        // JSON: tool invocations, thinking, etc.
  tokenCount: integer("token_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

### Migration File

A new migration file `v{N}_agent-sessions.ts` in `src/bun/db/migrations/`.

---

## 7. Code Changes

### 7.1. `src/bun/agents/agent-loop.ts` _(formerly `sub-agent.ts`)_

**Change**: Accept optional prior session messages and return new messages produced during the run.

```typescript
// Updated RunSubAgentOptions (now RunAgentLoopOptions)
export interface RunAgentLoopOptions {
  // ... existing fields ...

  /** Prior session messages to prepend (agent's own conversation history). */
  sessionMessages?: CoreMessage[];
}

// Updated return type — AgentResult extended
export interface AgentResult {
  /** New messages produced during this invocation (for session persistence). */
  newMessages: CoreMessage[];
  /** Files written during this invocation. */
  filesModified: string[];
}
```

**In `runAgentLoop()`**:

```typescript
// BEFORE:
messages: [{ role: "user", content: userMessage }],

// AFTER:
messages: [
  ...(options.sessionMessages ?? []),
  { role: "user", content: userMessage },
],
```

**After streaming completes**: New messages from the AI SDK result (task user message + all assistant/tool messages) are collected and returned in `AgentResult.newMessages` for the caller to persist.

### 7.2. `src/bun/agents/engine.ts` — `startSubAgent()`

**Change**: Look up or create session before spawning, load prior messages, save new messages after completion.

```
Before spawning (in startSubAgent):
  1. Query agent_sessions for (conversationId, agentName)
  2. If found: load messages from agent_session_messages, ordered by createdAt
  3. If not found: create new session row
  4. Check if session needs summarization (totalTokens > threshold)
  5. If yes: summarize, replace old messages with summary
  6. Convert loaded messages to CoreMessage[] format
  7. Pass sessionMessages to runSubAgent()

After completion (in .then() handler):
  1. Persist new messages from result.newMessages to agent_session_messages
  2. Update session's totalTokens and updatedAt
  3. Populate files_modified on agent_task_results from FileTracker data
```

### 7.3. `src/bun/agents/engine.ts` — `_runSubAgentInline()`

Same session lookup/save logic applies to inline (synchronous/wait) sub-agent runs, not just fire-and-forget dispatches.

### 7.4. `src/bun/engine-manager.ts` — Workflow `spawnAgent` callback

The workflow's `spawnAgent` callback (line 357) creates `instanceId` with a random suffix. The **agent name** (`agent.name`) stays the same and is what we use for session keying. No change needed here — the session lookup in `startSubAgent` uses `config.name` (base agent name), not `config.id` (instance ID).

### 7.5. Session Summarization

New function: `summarizeAgentSession()` — reuses the same pattern as `summarizer.ts`.

```typescript
// Pseudocode
async function summarizeAgentSession(sessionId: string, providerConfig, modelId): Promise<void> {
  // 1. Load all session messages
  // 2. Build transcript
  // 3. Call generateText with summarizer prompt
  // 4. Delete old messages from agent_session_messages
  // 5. Insert summary as a single "system" message
  // 6. Update session's totalTokens
}
```

**Trigger**: Before loading session messages in `startSubAgent()`, check `session.totalTokens`. If above threshold (~40k tokens), summarize before proceeding.

### 7.6. Conversation Deletion Cascade

When a conversation is deleted (`deleteConversation` RPC), the cascade should also delete associated `agent_sessions` and `agent_session_messages`. Since SQLite FK cascades handle this if configured, or we add explicit cleanup in the delete handler.

### 7.7. FileTracker Integration

In the `.then()` handler of `startSubAgent()`, after the agent completes:

```typescript
// Collect files_modified from the FileTracker data
const filesModified = fileTracker.getModifiedFiles(); // new method
// Persist to agent_task_results
db.insert(agentTaskResults).values({
  // ...existing fields...
  filesModified: JSON.stringify(filesModified),
}).catch(() => {});
```

This requires passing the `FileTracker` reference from `runSubAgent` back to the engine. Since `FileTracker` is created inside `runSubAgent`, we either:
- Return the modified file list alongside the result (preferred — add `filesModified: string[]` to `AgentResult`)
- Or expose it via the `onActivity` callback

---

## 8. Session Lifecycle

### Creation

A session is created the **first time** an agent type is dispatched within a conversation.

```
PM dispatches "frontend_engineer" in conversation #5:
  → agent_sessions: INSERT (conversation_id=#5, agent_name="frontend_engineer")
  → agent_session_messages: (empty — this is the first invocation)
```

### Growth

Each invocation appends messages to the session:

```
Invocation 1: [user msg] [assistant + tool calls] [assistant final text]  → ~15k tokens
Invocation 2: [user msg] [assistant + tool calls] [assistant final text]  → ~12k tokens
Invocation 3: [user msg] [assistant + tool calls] [assistant final text]  → ~10k tokens
                                                             Total:       ~37k tokens
```

### Summarization

When `session.totalTokens` exceeds the threshold (e.g., 40,000):

```
Before invocation 4:
  1. Load all messages (~37k tokens)
  2. Summarize via AI call → ~2k token summary
  3. Delete all old messages
  4. Insert summary as system message
  5. totalTokens reset to ~2k

Invocation 4 runs with:
  messages: [
    { role: "system", content: "[Session Summary] Built todo app with..." },  // 2k tokens
    { role: "user", content: "## New Task\nAdd dark mode..." }                // new task
  ]
```

### Cleanup

Sessions are deleted when:
- The parent conversation is deleted
- The conversation is cleared (`clearConversationMessages`)
- Explicitly via a future "reset agent" feature

---

## 9. Session Keying Strategy

### Default: Key by `(conversation_id, agent_name)`

Sessions are keyed by the base agent name (e.g., `frontend_engineer`), **not** the random instance ID (e.g., `frontend_engineer-abc123`).

**Why**: The instance ID is regenerated fresh on every dispatch (both PM's `delegate_task` and workflow's `spawnAgent`). If we keyed by instance ID, every dispatch would create a new session — defeating the purpose.

**Consequence**: All invocations of the same agent type in a conversation share one session. This is the desired behavior for:
- Review fix cycles (reviewer → FE fix → reviewer → FE fix)
- Sequential tasks (FE builds app → FE adds dark mode)
- Workflow pipeline (same agent type dispatched multiple times)

### Concurrent Same-Type Agents

When the PM dispatches 3 concurrent `frontend_engineer` instances:

**Problem**: If all 3 share one session keyed by `(conv, "frontend_engineer")`, their messages would interleave, creating garbled context.

**Solution**: When a session is **currently in use** by another running agent, create a numbered branch session:

```
frontend_engineer       ← primary session (first concurrent instance uses this)
frontend_engineer#2     ← second concurrent instance
frontend_engineer#3     ← third concurrent instance
```

**Detection**: In `startSubAgent()`, before loading the session:
1. Check if any running agent is already using the session for this `(conversationId, agentName)` pair
2. If yes: create/use a numbered variant (`agentName#N`)
3. If no: use the primary session

**After concurrent agents complete**: All branch sessions are merged back (messages appended chronologically) into the primary session, or kept separate. Since concurrent agents work on independent tasks, keeping them separate is simpler and avoids interleaving.

**Merging strategy**: Do NOT merge. Each numbered session remains independent. When the agent type is dispatched again (non-concurrently), it uses the primary session. The branch sessions serve as isolated workspaces for their specific concurrent tasks.

### Workflow Re-Dispatch (Fix Cycles)

The workflow dispatches fix agents sequentially (one at a time per task). The fix agent reuses the primary session:

```
Invocation 1: FE builds todo app → messages saved to session "frontend_engineer"
Invocation 2: FE fixes CSS bugs  → session loaded, new task appended → "frontend_engineer"
Invocation 3: FE fixes more bugs → session loaded, new task appended → "frontend_engineer"
```

This works because workflow fix cycles are sequential — the reviewer waits for the fix agent to complete before reviewing again.

---

## 10. Token Economics

### Scenario: Review Fix Cycle (3 files, 2 rounds)

#### Current (No Sessions)

| Step | Tokens | Notes |
|---|---|---|
| Invocation 1: Build | 50,000 | System prompt + task + 40 tool calls |
| Invocation 2: Fix round 1 | 35,000 | System + task + re-read 3 files (~6k) + fix |
| Invocation 3: Fix round 2 | 35,000 | System + task + re-read 3 files (~6k) + fix |
| **Total** | **120,000** | ~12k tokens wasted on redundant file reads |

#### With Sessions

| Step | Tokens | Notes |
|---|---|---|
| Invocation 1: Build | 50,000 | Same as before |
| Invocation 2: Fix round 1 | 28,000 | Session summary (~4k) + new task + targeted fix (skips re-reads) |
| Invocation 3: Fix round 2 | 25,000 | Session summary (~4k) + new task + targeted fix |
| **Total** | **103,000** | ~17k saved vs current approach |

#### vs Claude Code (Single Agent)

| Step | Tokens | Notes |
|---|---|---|
| Build + fix 1 + fix 2 | 130,000 | Entire conversation history carried forward every turn. Includes unrelated context from other tasks. |

AgentDesk with sessions: **103k** vs Claude Code: **130k**. Sessions + specialized agents = less cross-domain context bloat.

### Where Sessions Add Tokens

The **only** scenario where sessions cost more than current:
- First dispatch that is **never** re-dispatched
- Session messages are persisted to DB but never loaded
- Token overhead: **zero** (just storage bytes)

Sessions only add input tokens when the agent is re-dispatched — which is exactly when you'd otherwise waste even more tokens on re-reading.

---

## 11. Edge Cases

### 11.1. Conversation Branch

When a user branches a conversation:
- New conversation created → new conversation ID
- Sessions from the original conversation are **not** copied
- Agents in the branched conversation start fresh
- This is correct — the branch is a divergent context

### 11.2. Engine/App Restart

- Sessions persist in SQLite → survive restarts
- On next dispatch, `startSubAgent()` loads from DB
- No in-memory state dependency

### 11.3. Agent Type Never Re-Dispatched

- Session has exactly 1 set of invocation messages
- Zero token overhead (never loaded)
- Minimal storage (~10-50KB per session)

### 11.4. Very Long Sessions

- Summarization threshold: ~40k tokens
- Summarizes older messages, keeps summary + recent window
- Same proven mechanism as PM conversation summarization
- Bounded growth: after summarization, session is ~4-6k tokens

### 11.5. Conversation Deletion

- `agent_sessions` and `agent_session_messages` cascaded or explicitly deleted
- No orphaned data

### 11.6. Concurrent Same-Type + Subsequent Sequential

```
Time 1: PM spawns FE#1 (HTML), FE#2 (CSS), FE#3 (JS) concurrently
  → Sessions: frontend_engineer, frontend_engineer#2, frontend_engineer#3

Time 2: All complete. PM spawns FE for "add dark mode" (sequential)
  → Uses primary session: frontend_engineer
  → Sees context from FE#1 (HTML work)
  → Does NOT see FE#2 or FE#3 context (separate sessions)
  → Uses get_completed_work tool to see summaries of all three
```

This is acceptable because:
- The primary session captures the most common re-dispatch case
- Cross-agent awareness tools provide summaries of all work
- Files on disk are always the source of truth

### 11.7. Different Agent Types for Same Role

The PM might dispatch `backend-engineer` for task A, then `debugging-specialist` for a bug in the same code. These are different agent names → different sessions. The debugging specialist won't see the backend engineer's session, but can:
- Use `get_completed_work` to see the backend engineer's summary
- Read the actual files from disk

### 11.8. Session Message Format

AI SDK messages include tool calls and results in a specific format. Session messages must be stored in a format that can be reconstructed into valid `CoreMessage[]` for `streamText`. The `metadata` column in `agent_session_messages` stores the AI SDK's message parts (tool invocations, etc.) as JSON.

### 11.9. Provider Switch Mid-Session

If the user changes AI provider between invocations (e.g., Anthropic → OpenAI), the session messages are provider-agnostic `CoreMessage[]`. The AI SDK handles format translation. Session continues seamlessly.

---

## 12. What Does NOT Change

| Component | Status |
|---|---|
| PM conversation flow | Unchanged — PM still gets result summaries injected after each agent completes |
| PM tools (`run_agent`, `run_agents_parallel`) | Unchanged in interface — session load/save is transparent inside agent-loop.ts |
| Kanban integration | Unchanged — task columns, review rounds, acceptance criteria |
| `review-cycle.ts` | Unchanged — auto-spawns code-reviewer when task enters "review" column |
| Channel adapters (Discord, WhatsApp, Email) | Unchanged — channels talk to PM, PM dispatches agents |
| Plan approval flow | Unchanged — PM calls `create_tasks_from_plan` after user approves |
| File tracker / stale content detection | Unchanged (enhanced: `filesModified` populated via `trackWrite()`) |
| Agent system prompts | Unchanged — still loaded from `seed.ts` |
| Frontend (React UI) | Unchanged — no new UI components or state changes |
| RPC contracts | Unchanged — no new RPCs needed |
| `agent_task_results` | Enhanced — new `files_modified` column (JSON array of paths) |

### Critical: `run_agent` Hallucination Safeguard (must be preserved)

Some models (notably Qwen/DashScope) produce text claiming they dispatched a sub-agent without actually calling the `run_agent` tool. A safeguard in `engine.ts` detects this and does an invisible `generateText` follow-up to force the tool call. This safeguard is **independent of agent sessions** — it sits in the PM response loop *before* any sub-agent spawns.

**How it works:**
1. A `runAgentCalled` boolean is tracked in `onStepFinish` — set to `true` when any tool call has `toolName === "run_agent"`
2. After the PM's streaming response ends with text, if `!runAgentCalled`, a non-streaming `generateText` call nudges the model: *"You did not call run_agent. No agents were dispatched. Call run_agent now or respond NONE."*
3. Only the `run_agent` tool is provided in the follow-up (`maxSteps: 1`)
4. Uses `generateText` (not `streamText`) to avoid DashScope/Qwen limitation where `tools + stream=true` fails
5. The follow-up is invisible to the user — nothing is streamed

**Why this matters:** Without this safeguard, the PM tells the user "I've dispatched Backend Engineer" but no agent actually runs. The user waits indefinitely for a result that never comes.

**Location:** `engine.ts` → `sendMessage()` → PM streaming loop, after `fullText.trim()` check, before usage stats collection.

> ⚠️ This safeguard was accidentally dropped during the agent sessions refactor and had to be re-added. When refactoring the PM response loop, always preserve the `runAgentCalled` tracking + `generateText` follow-up pattern.

---

## 13. Comparison to Other AI Coding Tools

| Feature | Claude Code / Cursor | AgentDesk (Current) | AgentDesk (With Sessions) |
|---|---|---|---|
| Continuous conversation | Yes (single agent) | PM only; sub-agents one-shot | PM + agent sessions |
| Context across re-dispatches | N/A (one agent) | No | Yes (session continuity) |
| Multi-agent concurrency | No | Yes (w/ coordination) | Yes (w/ coordination + sessions) |
| Specialized agent roles | No (one generalist) | Yes (16 agents) | Yes (16 agents + context) |
| Automated review/test cycles | No (manual) | Yes (workflow) | Yes (workflow + context) |
| Cross-agent coordination | N/A | Yes (pull-based tools) | Yes (enhanced with files_modified) |
| File conflict detection | N/A | Yes (FileTracker) | Yes (FileTracker) |
| Plan approval gate | No | Yes | Yes |
| Multi-channel support | No | Yes | Yes |
| Context summarization | Yes | PM only | PM + agent sessions |
| Token efficiency (re-dispatch) | N/A | Poor (re-reads files) | Good (session avoids re-reads) |

AgentDesk with sessions would be **ahead** of single-agent tools in orchestration capability while matching them in context continuity.

---

## 14. Implementation Order

### Phase 1: Database

1. Add `agentSessions` and `agentSessionMessages` tables to `src/bun/db/schema.ts`
2. Add `filesModified` column to `agentTaskResults`
3. Create migration file `src/bun/db/migrations/v{N}_agent-sessions.ts`

### Phase 2: Sub-Agent Changes

4. Update `RunSubAgentOptions` in `sub-agent.ts` to accept `sessionMessages?: CoreMessage[]`
5. Update `AgentResult` to include `newMessages: CoreMessage[]` and `filesModified: string[]`
6. Update `runSubAgent()` to prepend session messages and collect new messages
7. Add `getModifiedFiles()` method to `FileTracker`

### Phase 3: Engine Integration

8. Add session lookup/create logic in `engine.ts` → `startSubAgent()`
9. Add session save logic in `.then()` handler after agent completion
10. Add concurrent-session detection for same-type agents
11. Populate `files_modified` on `agent_task_results` from agent result

### Phase 4: Session Summarization

12. Create `summarizeAgentSession()` function (reuse `summarizer.ts` pattern)
13. Add summarization trigger in `startSubAgent()` before loading session messages
14. Add per-session summarization lock (same as PM conversation lock pattern)

### Phase 5: Cleanup

15. Add cascade delete for sessions on conversation deletion
16. Add session cleanup on `clearConversationMessages`
17. Update `workflow.md` and `CLAUDE.md` to reflect the new flow

---

## Open Questions

1. **Summarization threshold**: 40k tokens is proposed. Should this be configurable per-project?
2. **Branch session merging**: Currently proposed as "never merge". Should branch sessions (`frontend_engineer#2`) ever consolidate into the primary session after completion?
3. **Session visibility in UI**: Should users be able to see/browse agent session histories? (Not proposed for initial implementation — can be added later.)
4. **Max session age**: Should sessions auto-expire if not used for X days? Or live as long as the conversation?
